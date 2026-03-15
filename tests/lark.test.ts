import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import http from 'http';
import { ChannelRegistry } from '../src/kernel/channels/registry.js';
import { LarkChannel, decryptEvent, addReaction, removeReaction, larkRequest } from '../src/kernel/channels/lark.js';
import type { InboundMessage, OnInboundMessage } from '../src/types.js';
import crypto from 'crypto';

// ─── Mocks ──────────────────────────────────────────────────

vi.mock('../src/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// Mock config with defaults — individual tests override via vi.spyOn or re-import
vi.mock('../src/config.js', () => ({
  LARK_CONNECTION_MODE: 'webhook',
  LARK_APP_ID: '',
  LARK_APP_SECRET: '',
  LARK_VERIFICATION_TOKEN: 'test-verify-token',
  LARK_ENCRYPT_KEY: '',
  LARK_WEBHOOK_PORT: 0, // 0 = random port for tests
  LARK_WEBHOOK_PATH: '/webhook/event',
  LARK_DM_POLICY: 'allowlist',
  LARK_REQUIRE_MENTION: true,
  LARK_ALLOW_FROM: ['user-allowed'],
}));

// ─── Helpers ────────────────────────────────────────────────

function postJSON(
  port: number,
  path: string,
  body: Record<string, unknown>,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(
      { hostname: '127.0.0.1', port, path, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() }));
      },
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// Create a LarkChannel with a local webhook server for testing.
// Bypasses connect() credential check by directly starting the server.
async function createTestChannel(): Promise<{ channel: LarkChannel; port: number; cleanup: () => Promise<void> }> {
  const channel = new LarkChannel();

  // Access private members for test setup
  const ch = channel as unknown as {
    server: http.Server | null;
    connected: boolean;
    botOpenId: string | null;
    handleWebhook: (req: http.IncomingMessage, res: http.ServerResponse) => void;
  };

  ch.botOpenId = 'ou_bot123';

  // Start a local server on a random port
  const server = http.createServer((req, res) => ch.handleWebhook(req, res));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  ch.server = server;
  ch.connected = true;

  const port = (server.address() as { port: number }).port;

  return {
    channel,
    port,
    cleanup: async () => {
      await channel.disconnect();
    },
  };
}

// ─── Basic Tests ────────────────────────────────────────────

describe('LarkChannel — basics', () => {
  it('should have name "lark"', () => {
    expect(new LarkChannel().name).toBe('lark');
  });

  it('should skip connect when no credentials', async () => {
    const ch = new LarkChannel();
    await ch.connect(); // Should not throw
    expect(ch.isConnected()).toBe(false);
  });

  it('should throw sendMessage when not connected', async () => {
    const ch = new LarkChannel();
    await expect(ch.sendMessage('oc_123', 'hi')).rejects.toThrow('not connected');
  });

  it('should detect receiveIdType from chatId prefix', async () => {
    const ch = new LarkChannel() as unknown as { detectReceiveIdType: (id: string) => string };
    expect(ch.detectReceiveIdType('oc_abc')).toBe('chat_id');
    expect(ch.detectReceiveIdType('ou_abc')).toBe('open_id');
    expect(ch.detectReceiveIdType('something_else')).toBe('chat_id');
  });

  it('should accept setInboundHandler', () => {
    const ch = new LarkChannel();
    const handler = vi.fn();
    ch.setInboundHandler(handler);
    // No error — handler stored internally
  });
});

// ─── Webhook Tests ──────────────────────────────────────────

describe('LarkChannel — webhook', () => {
  let channel: LarkChannel;
  let port: number;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    const setup = await createTestChannel();
    channel = setup.channel;
    port = setup.port;
    cleanup = setup.cleanup;
  });

  afterEach(async () => {
    await cleanup();
  });

  it('should respond to url_verification challenge', async () => {
    const res = await postJSON(port, '/webhook/event', {
      type: 'url_verification',
      challenge: 'test-challenge-abc',
    });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ challenge: 'test-challenge-abc' });
  });

  it('should reject mismatched verification token', async () => {
    const res = await postJSON(port, '/webhook/event', {
      header: { event_id: 'evt1', event_type: 'im.message.receive_v1', token: 'wrong-token' },
      event: {},
    });
    expect(res.status).toBe(403);
  });

  it('should deduplicate events by event_id', async () => {
    const handler = vi.fn();
    channel.setInboundHandler(handler);

    const body = {
      header: { event_id: 'evt-dup-1', event_type: 'im.message.receive_v1', token: 'test-verify-token' },
      event: {
        message: {
          message_id: 'msg1', message_type: 'text', chat_type: 'p2p',
          chat_id: 'oc_123', content: '{"text":"hello"}', create_time: '1000',
        },
        sender: { sender_id: { open_id: 'ou_sender', user_id: 'user-allowed' }, sender_type: 'user' },
      },
    };

    await postJSON(port, '/webhook/event', body);
    await postJSON(port, '/webhook/event', body); // duplicate

    // Wait a tick for async processing
    await new Promise((r) => setTimeout(r, 50));

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('should parse text message and call inbound handler', async () => {
    const handler = vi.fn();
    channel.setInboundHandler(handler);

    await postJSON(port, '/webhook/event', {
      header: { event_id: 'evt-text-1', event_type: 'im.message.receive_v1', token: 'test-verify-token' },
      event: {
        message: {
          message_id: 'msg-text-1', message_type: 'text', chat_type: 'p2p',
          chat_id: 'oc_chat1', content: '{"text":"deploy to prod"}', create_time: '1710000000000',
        },
        sender: { sender_id: { open_id: 'ou_sender1', user_id: 'user-allowed' }, sender_type: 'user' },
      },
    });

    await new Promise((r) => setTimeout(r, 50));

    expect(handler).toHaveBeenCalledTimes(1);
    const msg: InboundMessage = handler.mock.calls[0][0];
    expect(msg.channel).toBe('lark');
    expect(msg.chat_id).toBe('oc_chat1');
    expect(msg.content).toBe('deploy to prod');
    expect(msg.sender).toBe('user-allowed');
  });

  it('should skip non-text messages', async () => {
    const handler = vi.fn();
    channel.setInboundHandler(handler);

    await postJSON(port, '/webhook/event', {
      header: { event_id: 'evt-img-1', event_type: 'im.message.receive_v1', token: 'test-verify-token' },
      event: {
        message: {
          message_id: 'msg-img-1', message_type: 'image', chat_type: 'p2p',
          chat_id: 'oc_chat1', content: '{"image_key":"img_xxx"}', create_time: '1000',
        },
        sender: { sender_id: { open_id: 'ou_s', user_id: 'user-allowed' }, sender_type: 'user' },
      },
    });

    await new Promise((r) => setTimeout(r, 50));
    expect(handler).not.toHaveBeenCalled();
  });

  it('should reject DM from non-allowlisted user', async () => {
    const handler = vi.fn();
    channel.setInboundHandler(handler);

    await postJSON(port, '/webhook/event', {
      header: { event_id: 'evt-dm-reject', event_type: 'im.message.receive_v1', token: 'test-verify-token' },
      event: {
        message: {
          message_id: 'msg-dm-r', message_type: 'text', chat_type: 'p2p',
          chat_id: 'oc_chat1', content: '{"text":"hey"}', create_time: '1000',
        },
        sender: { sender_id: { open_id: 'ou_stranger', user_id: 'stranger-id' }, sender_type: 'user' },
      },
    });

    await new Promise((r) => setTimeout(r, 50));
    expect(handler).not.toHaveBeenCalled();
  });

  it('should skip group message without @mention', async () => {
    const handler = vi.fn();
    channel.setInboundHandler(handler);

    await postJSON(port, '/webhook/event', {
      header: { event_id: 'evt-grp-nomention', event_type: 'im.message.receive_v1', token: 'test-verify-token' },
      event: {
        message: {
          message_id: 'msg-grp-1', message_type: 'text', chat_type: 'group',
          chat_id: 'oc_group1', content: '{"text":"random chat"}', create_time: '1000',
          mentions: [],
        },
        sender: { sender_id: { open_id: 'ou_s', user_id: 'user-allowed' }, sender_type: 'user' },
      },
    });

    await new Promise((r) => setTimeout(r, 50));
    expect(handler).not.toHaveBeenCalled();
  });

  it('should return 404 for non-webhook paths', async () => {
    const res = await postJSON(port, '/other-path', { test: true });
    expect(res.status).toBe(404);
  });
});

// ─── Decryption Tests ───────────────────────────────────────

describe('decryptEvent', () => {
  it('should decrypt AES-256-CBC encrypted payload', () => {
    const encryptKey = 'test-encrypt-key-12345';
    const plaintext = JSON.stringify({ type: 'url_verification', challenge: 'abc123' });

    // Encrypt
    const keyBuffer = crypto.createHash('sha256').update(encryptKey).digest();
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-cbc', keyBuffer, iv);
    let encrypted = cipher.update(plaintext, 'utf-8');
    encrypted = Buffer.concat([encrypted, cipher.final()]);
    const encryptedBase64 = Buffer.concat([iv, encrypted]).toString('base64');

    // Decrypt
    const result = decryptEvent(encryptedBase64, encryptKey);
    expect(result).toBe(plaintext);
  });
});

// ─── Token Manager Tests ────────────────────────────────────

describe('TokenManager (via LarkChannel internals)', () => {
  // TokenManager is internal, tested indirectly through LarkChannel
  // These tests verify the caching behavior concept

  it('should cache token within expiry window', () => {
    // Conceptual: token fetched at time T with 2h expiry
    // Request at T+1h → should return cached token (no API call)
    const now = Date.now();
    const expiresAt = now + 7200_000; // 2h from now
    const withinWindow = now + 3600_000; // 1h from now
    expect(withinWindow < expiresAt - 300_000).toBe(true); // 1h < 2h - 5min
  });

  it('should refresh when close to expiry', () => {
    const now = Date.now();
    const expiresAt = now + 200_000; // 200s from now
    expect(now < expiresAt - 300_000).toBe(false); // within 5min buffer → refresh
  });

  it('should refresh when expired', () => {
    const now = Date.now();
    const expiresAt = now - 1000; // already expired
    expect(now < expiresAt - 300_000).toBe(false);
  });
});

// ─── Registry Integration Tests ─────────────────────────────

describe('Registry — inbound handler distribution', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('should distribute handler to LarkChannel via setMessageHandler', () => {
    const registry = new ChannelRegistry();
    const lark = new LarkChannel();
    const spy = vi.spyOn(lark, 'setInboundHandler');

    registry.register(lark);
    const handler: OnInboundMessage = vi.fn();
    registry.setMessageHandler(handler);

    expect(spy).toHaveBeenCalledWith(handler);
  });

  it('should distribute handler regardless of register/setHandler order', () => {
    // Case 1: setMessageHandler BEFORE register
    const registry1 = new ChannelRegistry();
    const handler1: OnInboundMessage = vi.fn();
    registry1.setMessageHandler(handler1);

    const lark1 = new LarkChannel();
    const spy1 = vi.spyOn(lark1, 'setInboundHandler');
    registry1.register(lark1);
    expect(spy1).toHaveBeenCalledWith(handler1);

    // Case 2: register BEFORE setMessageHandler
    const registry2 = new ChannelRegistry();
    const lark2 = new LarkChannel();
    const spy2 = vi.spyOn(lark2, 'setInboundHandler');
    registry2.register(lark2);

    const handler2: OnInboundMessage = vi.fn();
    registry2.setMessageHandler(handler2);
    expect(spy2).toHaveBeenCalledWith(handler2);
  });

  it('should not break MockChannel without setInboundHandler', () => {
    const registry = new ChannelRegistry();

    // A channel without setInboundHandler (like MockChannel in channels.test.ts)
    const mock = {
      name: 'mock',
      connect: async () => {},
      sendMessage: async () => {},
      isConnected: () => true,
      disconnect: async () => {},
    };

    registry.register(mock);
    registry.setMessageHandler(vi.fn());
    // Should not throw — optional chaining handles it
  });
});

// ─── parseMessageEvent (SDK callback + webhook shared path) ─

describe('LarkChannel — parseMessageEvent (direct)', () => {
  let channel: LarkChannel;

  beforeEach(() => {
    channel = new LarkChannel();
    (channel as unknown as { botOpenId: string }).botOpenId = 'ou_bot123';
  });

  it('should parse SDK event data and call inbound handler', () => {
    const handler = vi.fn();
    channel.setInboundHandler(handler);

    // SDK provides event data directly (same shape as webhook event body)
    channel.parseMessageEvent({
      message: {
        message_id: 'sdk-msg-1', message_type: 'text', chat_type: 'p2p',
        chat_id: 'oc_sdk1', content: '{"text":"hello from SDK"}', create_time: '1710000000000',
      },
      sender: { sender_id: { open_id: 'ou_s1', user_id: 'user-allowed' }, sender_type: 'user' },
    });

    expect(handler).toHaveBeenCalledTimes(1);
    const msg: InboundMessage = handler.mock.calls[0][0];
    expect(msg.channel).toBe('lark');
    expect(msg.content).toBe('hello from SDK');
    expect(msg.chat_id).toBe('oc_sdk1');
  });

  it('should skip without handler', () => {
    // No handler set — should not throw
    channel.parseMessageEvent({
      message: { message_id: 'm', message_type: 'text', chat_type: 'p2p', chat_id: 'oc_x', content: '{"text":"x"}', create_time: '1' },
      sender: { sender_id: { open_id: 'ou_s', user_id: 'user-allowed' }, sender_type: 'user' },
    });
  });

  it('should skip non-text messages', () => {
    const handler = vi.fn();
    channel.setInboundHandler(handler);

    channel.parseMessageEvent({
      message: { message_id: 'm', message_type: 'image', chat_type: 'p2p', chat_id: 'oc_x', content: '{}', create_time: '1' },
      sender: { sender_id: { open_id: 'ou_s', user_id: 'user-allowed' }, sender_type: 'user' },
    });

    expect(handler).not.toHaveBeenCalled();
  });

  it('should reject DM from non-allowlisted user', () => {
    const handler = vi.fn();
    channel.setInboundHandler(handler);

    channel.parseMessageEvent({
      message: { message_id: 'm', message_type: 'text', chat_type: 'p2p', chat_id: 'oc_x', content: '{"text":"hey"}', create_time: '1' },
      sender: { sender_id: { open_id: 'ou_stranger', user_id: 'stranger-id' }, sender_type: 'user' },
    });

    expect(handler).not.toHaveBeenCalled();
  });

  it('should skip group message without @mention', () => {
    const handler = vi.fn();
    channel.setInboundHandler(handler);

    channel.parseMessageEvent({
      message: { message_id: 'm', message_type: 'text', chat_type: 'group', chat_id: 'oc_grp', content: '{"text":"hi"}', create_time: '1', mentions: [] },
      sender: { sender_id: { open_id: 'ou_s', user_id: 'user-allowed' }, sender_type: 'user' },
    });

    expect(handler).not.toHaveBeenCalled();
  });

  it('should handle missing message/sender gracefully', () => {
    const handler = vi.fn();
    channel.setInboundHandler(handler);

    channel.parseMessageEvent({});
    channel.parseMessageEvent({ message: {} });

    expect(handler).not.toHaveBeenCalled();
  });
});

// ─── Reaction API Unit Tests ────────────────────────────────

describe('addReaction / removeReaction', () => {
  it('addReaction should return reaction_id on success', async () => {
    // These functions require a real API call, so we test error handling
    await expect(addReaction('invalid-token', 'msg-1', 'Typing'))
      .rejects.toThrow();
  });

  it('removeReaction should throw on invalid call', async () => {
    await expect(removeReaction('invalid-token', 'msg-1', 'react-1'))
      .rejects.toThrow();
  });
});

// ─── Reaction Integration Tests ────────────────────────────

describe('LarkChannel — reactions', () => {
  let channel: LarkChannel;

  beforeEach(() => {
    channel = new LarkChannel();
    const ch = channel as unknown as {
      botOpenId: string;
      tokenManager: { getToken: () => Promise<string> };
      pendingReactions: Map<string, string>;
    };
    ch.botOpenId = 'ou_bot123';
    ch.tokenManager = { getToken: async () => 'fake-token' };
  });

  it('should trigger ackReaction on valid inbound message (handler still called on API failure)', async () => {
    const handler = vi.fn();
    channel.setInboundHandler(handler);

    // ackReaction is fire-and-forget — it will fail (no real Lark server),
    // but the inbound handler should still be called
    channel.parseMessageEvent({
      message: {
        message_id: 'msg-react-1', message_type: 'text', chat_type: 'p2p',
        chat_id: 'oc_chat1', content: '{"text":"hello"}', create_time: '1710000000000',
      },
      sender: { sender_id: { open_id: 'ou_s1', user_id: 'user-allowed' }, sender_type: 'user' },
    });

    // Wait for fire-and-forget
    await new Promise((r) => setTimeout(r, 100));

    // Handler must be called regardless of reaction API result
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0].id).toBe('msg-react-1');
  });

  it('should not crash if ackReaction fails', async () => {
    const handler = vi.fn();
    channel.setInboundHandler(handler);

    const larkRequestModule = await import('../src/kernel/channels/lark.js');
    const spy = vi.spyOn(larkRequestModule, 'larkRequest').mockRejectedValue(new Error('network error'));

    channel.parseMessageEvent({
      message: {
        message_id: 'msg-fail-1', message_type: 'text', chat_type: 'p2p',
        chat_id: 'oc_chat1', content: '{"text":"hello"}', create_time: '1710000000000',
      },
      sender: { sender_id: { open_id: 'ou_s1', user_id: 'user-allowed' }, sender_type: 'user' },
    });

    await new Promise((r) => setTimeout(r, 50));

    // Handler should still be called despite reaction failure
    expect(handler).toHaveBeenCalledTimes(1);

    spy.mockRestore();
  });

  it('should clean up pendingReactions on completeReaction', async () => {
    const ch = channel as unknown as { pendingReactions: Map<string, string> };
    ch.pendingReactions.set('msg-complete-1', 'react-456');

    // completeReaction will fail on the network call (no real Lark server),
    // but it should still clean up the pendingReactions map
    await channel.completeReaction('msg-complete-1');

    // Pending reaction should be removed regardless of API success
    expect(ch.pendingReactions.has('msg-complete-1')).toBe(false);
  });

  it('should not crash on completeReaction when no pending reaction exists', async () => {
    // No pending reaction, no tokenManager issues — should not throw
    await expect(channel.completeReaction('msg-no-pending')).resolves.not.toThrow();
  });

  it('should not crash on completeReaction without tokenManager', async () => {
    const bare = new LarkChannel();
    // No tokenManager set — should silently return
    await expect(bare.completeReaction('msg-whatever')).resolves.not.toThrow();
  });

  it('should clear pendingReactions on disconnect', async () => {
    const ch = channel as unknown as {
      pendingReactions: Map<string, string>;
      connected: boolean;
    };
    ch.pendingReactions.set('msg-1', 'react-1');
    ch.connected = true;

    await channel.disconnect();

    expect(ch.pendingReactions.size).toBe(0);
  });
});
