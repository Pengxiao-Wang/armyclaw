// ═══════════════════════════════════════════════════════════
// ArmyClaw — Channel Registry
// Manages communication channels (Lark, Slack, etc.)
// ═══════════════════════════════════════════════════════════

import { logger } from '../logger.js';
import type { Channel, OnInboundMessage } from '../types.js';

export class ChannelRegistry {
  private channels = new Map<string, Channel>();
  private onMessage: OnInboundMessage | null = null;

  /**
   * Register a channel. Must be called before connectAll().
   */
  register(channel: Channel): void {
    if (this.channels.has(channel.name)) {
      logger.warn({ channel: channel.name }, 'Channel already registered, replacing');
    }
    this.channels.set(channel.name, channel);
    logger.info({ channel: channel.name }, 'Channel registered');
  }

  /**
   * Set the handler for inbound messages from any channel.
   */
  setMessageHandler(handler: OnInboundMessage): void {
    this.onMessage = handler;
  }

  /**
   * Connect all registered channels.
   */
  async connectAll(): Promise<void> {
    const names = [...this.channels.keys()];
    logger.info({ channels: names }, 'Connecting all channels');

    for (const [name, channel] of this.channels) {
      try {
        await channel.connect();
        logger.info({ channel: name }, 'Channel connected');
      } catch (err) {
        logger.error(
          { channel: name, error: err instanceof Error ? err.message : String(err) },
          'Failed to connect channel',
        );
      }
    }
  }

  /**
   * Disconnect all registered channels.
   */
  async disconnectAll(): Promise<void> {
    logger.info('Disconnecting all channels');

    for (const [name, channel] of this.channels) {
      try {
        await channel.disconnect();
        logger.info({ channel: name }, 'Channel disconnected');
      } catch (err) {
        logger.error(
          { channel: name, error: err instanceof Error ? err.message : String(err) },
          'Failed to disconnect channel',
        );
      }
    }
  }

  /**
   * Get a channel by name.
   */
  getChannel(name: string): Channel | undefined {
    return this.channels.get(name);
  }

  /**
   * Broadcast a message to all connected channels.
   * Uses the channel's default chat (empty string for chatId).
   */
  async broadcast(text: string): Promise<void> {
    for (const [name, channel] of this.channels) {
      if (!channel.isConnected()) continue;
      try {
        await channel.sendMessage('', text);
      } catch (err) {
        logger.error(
          { channel: name, error: err instanceof Error ? err.message : String(err) },
          'Failed to broadcast to channel',
        );
      }
    }
  }

  /**
   * Send a message to a specific channel and chat.
   */
  async sendTo(channelName: string, chatId: string, text: string): Promise<void> {
    const channel = this.channels.get(channelName);
    if (!channel) {
      logger.error({ channel: channelName }, 'Channel not found');
      return;
    }
    if (!channel.isConnected()) {
      logger.error({ channel: channelName }, 'Channel not connected');
      return;
    }
    await channel.sendMessage(chatId, text);
  }

  /**
   * Get names of all registered channels.
   */
  getRegisteredNames(): string[] {
    return [...this.channels.keys()];
  }

  /**
   * Get the inbound message handler (for channels to call).
   */
  getMessageHandler(): OnInboundMessage | null {
    return this.onMessage;
  }
}
