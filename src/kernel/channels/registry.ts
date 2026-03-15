// ═══════════════════════════════════════════════════════════
// ArmyClaw — Channel Registry
// Manages communication channels (Lark, Slack, etc.)
// ═══════════════════════════════════════════════════════════

import { logger } from '../../logger.js';
import type { Channel, OnInboundMessage } from '../../types.js';

export class ChannelRegistry {
  private channels = new Map<string, Channel>();
  private onMessage: OnInboundMessage | null = null;

  register(channel: Channel): void {
    if (this.channels.has(channel.name)) {
      logger.warn({ channel: channel.name }, 'Channel already registered, replacing');
    }
    this.channels.set(channel.name, channel);
    if (this.onMessage) {
      channel.setInboundHandler?.(this.onMessage);
    }
    logger.info({ channel: channel.name }, 'Channel registered');
  }

  setMessageHandler(handler: OnInboundMessage): void {
    this.onMessage = handler;
    for (const channel of this.channels.values()) {
      channel.setInboundHandler?.(handler);
    }
  }

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

  getChannel(name: string): Channel | undefined {
    return this.channels.get(name);
  }

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

  async completeReaction(channelName: string, messageId: string): Promise<void> {
    const channel = this.channels.get(channelName);
    await channel?.completeReaction?.(messageId);
  }

  getRegisteredNames(): string[] {
    return [...this.channels.keys()];
  }

  getMessageHandler(): OnInboundMessage | null {
    return this.onMessage;
  }
}
