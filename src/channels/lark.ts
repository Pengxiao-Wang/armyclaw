// ═══════════════════════════════════════════════════════════
// ArmyClaw — Lark/Feishu Channel (Stub)
// Will be connected to Lark MCP (im_v1_message_create) later.
// ═══════════════════════════════════════════════════════════

import { logger } from '../logger.js';
import type { Channel, InboundMessage } from '../types.js';

export class LarkChannel implements Channel {
  name = 'lark';
  private connected = false;

  /**
   * Connect to Lark webhook.
   * TODO: Set up event subscription for inbound messages.
   */
  async connect(): Promise<void> {
    // TODO: Connect to Lark webhook / event subscription
    // Use international version (larksuite.com, NOT feishu.cn)
    this.connected = true;
    logger.info('Lark channel connected (stub mode)');
  }

  /**
   * Send a message to a Lark chat.
   * Rules:
   * - Use user_id (not email or phone number)
   * - Use international version (larksuite.com)
   * - Will use Lark MCP (im_v1_message_create) when connected
   */
  async sendMessage(chatId: string, text: string): Promise<void> {
    if (!this.connected) {
      throw new Error('Lark channel not connected');
    }

    // TODO: Send via Lark MCP (im_v1_message_create)
    // Must use user_id, not email/phone
    // Must use international version (larksuite.com)
    logger.info(
      { chatId, textLength: text.length },
      'Lark message sent (stub — not actually delivered)',
    );
  }

  isConnected(): boolean {
    return this.connected;
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    logger.info('Lark channel disconnected');
  }
}
