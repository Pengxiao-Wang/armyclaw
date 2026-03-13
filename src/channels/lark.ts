// ═══════════════════════════════════════════════════════════
// ArmyClaw — Lark/Feishu Channel
// WebSocket via official SDK (default) or HTTP webhook inbound.
// REST API outbound (lightweight, no SDK needed).
// Uses international Lark (larksuite.com, NOT feishu.cn).
// ═══════════════════════════════════════════════════════════

import http from 'http';
import https from 'https';
import crypto from 'crypto';
import * as Lark from '@larksuiteoapi/node-sdk';
import { logger } from '../logger.js';
import {
  LARK_CONNECTION_MODE,
  LARK_APP_ID,
  LARK_APP_SECRET,
  LARK_VERIFICATION_TOKEN,
  LARK_ENCRYPT_KEY,
  LARK_WEBHOOK_PORT,
  LARK_WEBHOOK_PATH,
  LARK_DM_POLICY,
  LARK_REQUIRE_MENTION,
  LARK_ALLOW_FROM,
} from '../config.js';
import type { Channel, OnInboundMessage, InboundMessage } from '../types.js';

// ─── API Client (lightweight REST, used for outbound) ───────

const LARK_BASE = 'https://open.larksuite.com/open-apis';

export function larkRequest(
  method: string,
  path: string,
  body?: Record<string, unknown>,
  token?: string,
): Promise<{ status: number; data: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, LARK_BASE);
    const payload = body ? JSON.stringify(body) : undefined;

    const headers: Record<string, string> = {
      'Content-Type': 'application/json; charset=utf-8',
    };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    if (payload) headers['Content-Length'] = Buffer.byteLength(payload).toString();

    const req = https.request(
      url,
      { method, headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          try {
            const raw = Buffer.concat(chunks).toString('utf-8');
            const data = JSON.parse(raw) as Record<string, unknown>;
            resolve({ status: res.statusCode ?? 0, data });
          } catch (err) {
            reject(new Error(`Failed to parse Lark response: ${err}`));
          }
        });
      },
    );

    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

export async function fetchTenantAccessToken(
  appId: string,
  appSecret: string,
): Promise<{ token: string; expire: number }> {
  const { data } = await larkRequest('POST', `${LARK_BASE}/auth/v3/tenant_access_token/internal`, {
    app_id: appId,
    app_secret: appSecret,
  });

  if (data.code !== 0) {
    throw new Error(`Lark auth failed: code=${data.code} msg=${data.msg}`);
  }

  return {
    token: data.tenant_access_token as string,
    expire: data.expire as number,
  };
}

export async function sendLarkMessage(
  token: string,
  receiveIdType: string,
  receiveId: string,
  msgType: string,
  content: string,
): Promise<Record<string, unknown>> {
  const { data } = await larkRequest(
    'POST',
    `${LARK_BASE}/im/v1/messages?receive_id_type=${receiveIdType}`,
    { receive_id: receiveId, msg_type: msgType, content },
    token,
  );

  if (data.code !== 0) {
    throw new Error(`Lark send failed: code=${data.code} msg=${data.msg}`);
  }

  return data;
}

export async function addReaction(
  token: string,
  messageId: string,
  emojiType: string,
): Promise<string | null> {
  const { data } = await larkRequest(
    'POST',
    `${LARK_BASE}/im/v1/messages/${messageId}/reactions`,
    { reaction_type: { emoji_type: emojiType } },
    token,
  );

  if (data.code !== 0) {
    throw new Error(`Lark addReaction failed: code=${data.code} msg=${data.msg}`);
  }

  const reaction = data.data as Record<string, unknown> | undefined;
  return (reaction?.reaction_id as string) ?? null;
}

export async function removeReaction(
  token: string,
  messageId: string,
  reactionId: string,
): Promise<void> {
  const { data } = await larkRequest(
    'DELETE',
    `${LARK_BASE}/im/v1/messages/${messageId}/reactions/${reactionId}`,
    undefined,
    token,
  );

  if (data.code !== 0) {
    throw new Error(`Lark removeReaction failed: code=${data.code} msg=${data.msg}`);
  }
}

export async function getBotInfo(token: string): Promise<Record<string, unknown>> {
  const { data } = await larkRequest('GET', `${LARK_BASE}/bot/v3/info`, undefined, token);
  if (data.code !== 0) {
    throw new Error(`Lark getBotInfo failed: code=${data.code} msg=${data.msg}`);
  }
  return data;
}

// ─── Token Manager (for outbound REST calls) ────────────────

class TokenManager {
  private token: string | null = null;
  private expiresAt = 0;
  private appId: string;
  private appSecret: string;

  constructor(appId: string, appSecret: string) {
    this.appId = appId;
    this.appSecret = appSecret;
  }

  async getToken(): Promise<string> {
    const now = Date.now();
    if (this.token && now < this.expiresAt - 300_000) {
      return this.token;
    }

    const result = await fetchTenantAccessToken(this.appId, this.appSecret);
    this.token = result.token;
    this.expiresAt = now + result.expire * 1000;

    logger.debug('Lark tenant access token refreshed');
    return this.token;
  }
}

// ─── Event Decryption (webhook mode only) ───────────────────

export function decryptEvent(encrypt: string, encryptKey: string): string {
  const keyBuffer = crypto.createHash('sha256').update(encryptKey).digest();
  const encBuf = Buffer.from(encrypt, 'base64');
  const iv = encBuf.subarray(0, 16);
  const ciphertext = encBuf.subarray(16);
  const decipher = crypto.createDecipheriv('aes-256-cbc', keyBuffer, iv);
  let decrypted = decipher.update(ciphertext, undefined, 'utf-8');
  decrypted += decipher.final('utf-8');
  return decrypted;
}

// ─── LarkChannel ────────────────────────────────────────────

export class LarkChannel implements Channel {
  name = 'lark';
  private connected = false;
  private inboundHandler: OnInboundMessage | null = null;
  private tokenManager: TokenManager | null = null;
  private botOpenId: string | null = null;

  // Reaction tracking: messageId → reactionId (for removing Typing on completion)
  private pendingReactions = new Map<string, string>();

  // Webhook state
  private server: http.Server | null = null;
  private seenEvents = new Map<string, number>();

  // WebSocket state (official SDK)
  private wsClient: Lark.WSClient | null = null;

  setInboundHandler(handler: OnInboundMessage): void {
    this.inboundHandler = handler;
  }

  async connect(): Promise<void> {
    if (!LARK_APP_ID || !LARK_APP_SECRET) {
      logger.info('Lark channel skipped (no credentials)');
      return;
    }

    this.tokenManager = new TokenManager(LARK_APP_ID, LARK_APP_SECRET);

    // Validate credentials + get bot identity
    try {
      const token = await this.tokenManager.getToken();
      const botInfo = await getBotInfo(token);
      const bot = botInfo.bot as Record<string, unknown> | undefined;
      this.botOpenId = (bot?.open_id as string) ?? null;
      logger.info(
        { botName: bot?.app_name, botOpenId: this.botOpenId },
        'Lark bot identity verified',
      );
    } catch (err) {
      logger.error(
        { error: err instanceof Error ? err.message : String(err) },
        'Lark credential validation failed',
      );
      return;
    }

    // Connect based on mode
    if (LARK_CONNECTION_MODE === 'websocket') {
      this.connectWebSocket();
    } else {
      await this.startWebhookServer();
    }

    this.connected = true;
    logger.info(
      { mode: LARK_CONNECTION_MODE, ...(LARK_CONNECTION_MODE === 'webhook' ? { port: LARK_WEBHOOK_PORT } : {}) },
      'Lark channel connected',
    );
  }

  async sendMessage(chatId: string, text: string): Promise<void> {
    if (!this.connected || !this.tokenManager) {
      throw new Error('Lark channel not connected');
    }

    const receiveIdType = this.detectReceiveIdType(chatId);
    const content = JSON.stringify({ text });
    const token = await this.tokenManager.getToken();

    await sendLarkMessage(token, receiveIdType, chatId, 'text', content);
    logger.info({ chatId, receiveIdType, textLength: text.length }, 'Lark message sent');
  }

  /**
   * Add a Typing reaction to acknowledge receipt, then track it for later removal.
   * Fire-and-forget — failures are logged but never block the pipeline.
   */
  private ackReaction(messageId: string): void {
    if (!this.tokenManager) return;

    this.tokenManager.getToken()
      .then((token) => addReaction(token, messageId, 'Typing'))
      .then((reactionId) => {
        if (reactionId) {
          this.pendingReactions.set(messageId, reactionId);
        }
        logger.debug({ messageId }, 'Lark: Typing reaction added');
      })
      .catch((err) => {
        logger.warn({ messageId, error: err instanceof Error ? err.message : String(err) }, 'Lark: failed to add Typing reaction');
      });
  }

  /**
   * Remove the Typing reaction and add a DONE reaction when the task completes.
   * Fire-and-forget — safe to call even if no pending reaction exists.
   */
  async completeReaction(messageId: string, emoji = 'DONE'): Promise<void> {
    if (!this.tokenManager) return;

    try {
      const token = await this.tokenManager.getToken();

      // Remove Typing
      const reactionId = this.pendingReactions.get(messageId);
      if (reactionId) {
        this.pendingReactions.delete(messageId);
        await removeReaction(token, messageId, reactionId).catch((err) => {
          logger.debug({ messageId, error: err instanceof Error ? err.message : String(err) }, 'Lark: failed to remove Typing reaction (may already be removed)');
        });
      }

      // Add terminal emoji
      await addReaction(token, messageId, emoji);
      logger.debug({ messageId, emoji }, 'Lark: terminal reaction added');
    } catch (err) {
      logger.warn({ messageId, error: err instanceof Error ? err.message : String(err) }, 'Lark: failed to complete reaction');
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  async disconnect(): Promise<void> {
    // SDK WSClient — no public stop(); nulling allows GC
    this.wsClient = null;

    // HTTP server cleanup (webhook mode)
    if (this.server) {
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          this.server?.closeAllConnections?.();
          resolve();
        }, 3000);

        this.server!.close(() => {
          clearTimeout(timeout);
          resolve();
        });
      });
      this.server = null;
    }

    this.connected = false;
    this.seenEvents.clear();
    this.pendingReactions.clear();
    logger.info('Lark channel disconnected');
  }

  // ─── Helpers ─────────────────────────────────────────────

  private detectReceiveIdType(chatId: string): string {
    if (chatId.startsWith('oc_')) return 'chat_id';
    if (chatId.startsWith('ou_')) return 'open_id';
    return 'chat_id';
  }

  // ─── WebSocket (official Lark SDK) ──────────────────────

  private connectWebSocket(): void {
    this.wsClient = new Lark.WSClient({
      appId: LARK_APP_ID,
      appSecret: LARK_APP_SECRET,
      domain: Lark.Domain.Lark,
      loggerLevel: Lark.LoggerLevel.info,
    });

    const dispatcher = new Lark.EventDispatcher({}).register({
      'im.message.receive_v1': async (data: unknown) => {
        this.parseMessageEvent(data as Record<string, unknown>);
      },
    });

    this.wsClient.start({ eventDispatcher: dispatcher });
    logger.info('Lark WebSocket client started (SDK long connection)');
  }

  // ─── Webhook ────────────────────────────────────────────

  private startWebhookServer(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        this.handleWebhook(req, res);
      });

      this.server.on('error', (err) => {
        logger.error({ error: err.message }, 'Lark webhook server error');
        reject(err);
      });

      this.server.listen(LARK_WEBHOOK_PORT, () => {
        resolve();
      });
    });
  }

  private handleWebhook(req: http.IncomingMessage, res: http.ServerResponse): void {
    if (req.method !== 'POST' || req.url !== LARK_WEBHOOK_PATH) {
      res.writeHead(404);
      res.end('Not Found');
      return;
    }

    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf-8');
        let body = JSON.parse(raw) as Record<string, unknown>;

        // Decrypt if encrypted
        if (body.encrypt && LARK_ENCRYPT_KEY) {
          const decrypted = decryptEvent(body.encrypt as string, LARK_ENCRYPT_KEY);
          body = JSON.parse(decrypted) as Record<string, unknown>;
        }

        // URL Verification Challenge
        if (body.type === 'url_verification') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ challenge: body.challenge }));
          return;
        }

        // Verify token
        const header = body.header as Record<string, unknown> | undefined;
        if (LARK_VERIFICATION_TOKEN && header?.token !== LARK_VERIFICATION_TOKEN) {
          logger.warn('Lark webhook token mismatch — rejecting');
          res.writeHead(403);
          res.end('Forbidden');
          return;
        }

        // Event dedup
        const eventId = header?.event_id as string | undefined;
        if (eventId) {
          if (this.seenEvents.has(eventId)) {
            res.writeHead(200);
            res.end('ok');
            return;
          }
          this.seenEvents.set(eventId, Date.now());
          this.cleanupSeenEvents();
        }

        // Respond immediately (Lark retries after 3s)
        res.writeHead(200);
        res.end('ok');

        // Process event
        const eventType = header?.event_type as string | undefined;
        if (eventType === 'im.message.receive_v1') {
          this.parseMessageEvent(body.event as Record<string, unknown>);
        }
      } catch (err) {
        logger.error(
          { error: err instanceof Error ? err.message : String(err) },
          'Lark webhook parse error',
        );
        res.writeHead(400);
        res.end('Bad Request');
      }
    });
  }

  // ─── Shared Event Parser ────────────────────────────────

  parseMessageEvent(event: Record<string, unknown>): void {
    if (!event || !this.inboundHandler) return;

    const message = event.message as Record<string, unknown>;
    const sender = event.sender as Record<string, unknown>;
    if (!message || !sender) return;

    // Only handle text messages
    const msgType = message.message_type as string;
    if (msgType !== 'text') {
      logger.debug({ msgType }, 'Lark: skipping non-text message');
      return;
    }

    // Parse sender info
    const senderId = sender.sender_id as Record<string, unknown>;
    const senderOpenId = (senderId?.open_id as string) || '';
    const senderUserId = (senderId?.user_id as string) || '';
    const senderName = (sender.sender_type as string) === 'user'
      ? (senderId?.user_id as string) || 'unknown'
      : 'bot';

    // DM vs group
    const chatType = message.chat_type as string;
    const chatId = message.chat_id as string;

    // DM allowlist check
    if (chatType === 'p2p' && LARK_DM_POLICY === 'allowlist') {
      if (LARK_ALLOW_FROM.length > 0 && !LARK_ALLOW_FROM.includes(senderUserId) && !LARK_ALLOW_FROM.includes(senderOpenId)) {
        logger.info({ sender: senderUserId }, 'Lark: DM rejected (not in allowlist)');
        return;
      }
    }

    // Parse text content
    let textContent: string;
    try {
      const parsed = JSON.parse(message.content as string) as Record<string, string>;
      textContent = parsed.text || '';
    } catch {
      textContent = (message.content as string) || '';
    }

    // Group @mention check
    if (chatType === 'group' && LARK_REQUIRE_MENTION) {
      const mentions = message.mentions as Array<Record<string, unknown>> | undefined;
      const botMentioned = mentions?.some(
        (m) => (m.id as Record<string, unknown>)?.open_id === this.botOpenId,
      );
      if (!botMentioned) {
        logger.debug('Lark: skipping group message without @mention');
        return;
      }
      // Strip @mention tag from text
      if (mentions) {
        for (const m of mentions) {
          const key = m.key as string;
          if (key) {
            textContent = textContent.replace(key, '').trim();
          }
        }
      }
    }

    if (!textContent) return;

    const inbound: InboundMessage = {
      id: message.message_id as string || crypto.randomUUID(),
      channel: 'lark',
      chat_id: chatId,
      sender: senderUserId || senderOpenId,
      sender_name: senderName,
      content: textContent,
      timestamp: new Date(parseInt(message.create_time as string || '0', 10)).toISOString(),
    };

    logger.info(
      { messageId: inbound.id, sender: inbound.sender, chatType },
      'Lark inbound message parsed',
    );

    // Acknowledge receipt with a Typing reaction (fire-and-forget)
    this.ackReaction(inbound.id);

    this.inboundHandler(inbound);
  }

  private cleanupSeenEvents(): void {
    if (this.seenEvents.size <= 1000) return;
    const cutoff = Date.now() - 300_000; // 5 minutes
    for (const [id, ts] of this.seenEvents) {
      if (ts < cutoff) this.seenEvents.delete(id);
    }
  }
}
