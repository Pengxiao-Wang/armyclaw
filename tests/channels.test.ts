import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ChannelRegistry } from '../src/kernel/channels/registry.js';
import { LarkChannel } from '../src/kernel/channels/lark.js';
import type { Channel, InboundMessage } from '../src/types.js';

// ─── Mocks ──────────────────────────────────────────────────

vi.mock('../src/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// ─── Mock Channel ───────────────────────────────────────────

class MockChannel implements Channel {
  name: string;
  private connected = false;
  public sentMessages: { chatId: string; text: string }[] = [];

  constructor(name: string) {
    this.name = name;
  }

  async connect(): Promise<void> {
    this.connected = true;
  }

  async sendMessage(chatId: string, text: string): Promise<void> {
    if (!this.connected) throw new Error('Not connected');
    this.sentMessages.push({ chatId, text });
  }

  isConnected(): boolean {
    return this.connected;
  }

  async disconnect(): Promise<void> {
    this.connected = false;
  }
}

// ─── Tests ──────────────────────────────────────────────────

describe('ChannelRegistry', () => {
  let registry: ChannelRegistry;

  beforeEach(() => {
    registry = new ChannelRegistry();
  });

  describe('register', () => {
    it('should register a channel', () => {
      const channel = new MockChannel('test');
      registry.register(channel);
      expect(registry.getChannel('test')).toBe(channel);
    });

    it('should replace existing channel with same name', () => {
      const channel1 = new MockChannel('test');
      const channel2 = new MockChannel('test');
      registry.register(channel1);
      registry.register(channel2);
      expect(registry.getChannel('test')).toBe(channel2);
    });

    it('should register multiple channels', () => {
      registry.register(new MockChannel('lark'));
      registry.register(new MockChannel('slack'));
      expect(registry.getRegisteredNames()).toEqual(['lark', 'slack']);
    });
  });

  describe('connectAll', () => {
    it('should connect all registered channels', async () => {
      const ch1 = new MockChannel('lark');
      const ch2 = new MockChannel('slack');
      registry.register(ch1);
      registry.register(ch2);

      await registry.connectAll();

      expect(ch1.isConnected()).toBe(true);
      expect(ch2.isConnected()).toBe(true);
    });

    it('should handle connection errors gracefully', async () => {
      const badChannel: Channel = {
        name: 'bad',
        connect: async () => { throw new Error('connection failed'); },
        sendMessage: async () => {},
        isConnected: () => false,
        disconnect: async () => {},
      };
      registry.register(badChannel);

      // Should not throw
      await registry.connectAll();
    });
  });

  describe('disconnectAll', () => {
    it('should disconnect all registered channels', async () => {
      const ch1 = new MockChannel('lark');
      const ch2 = new MockChannel('slack');
      registry.register(ch1);
      registry.register(ch2);

      await registry.connectAll();
      await registry.disconnectAll();

      expect(ch1.isConnected()).toBe(false);
      expect(ch2.isConnected()).toBe(false);
    });
  });

  describe('setMessageHandler', () => {
    it('should store the message handler', () => {
      const handler = vi.fn();
      registry.setMessageHandler(handler);
      expect(registry.getMessageHandler()).toBe(handler);
    });
  });

  describe('broadcast', () => {
    it('should send to all connected channels', async () => {
      const ch1 = new MockChannel('lark');
      const ch2 = new MockChannel('slack');
      registry.register(ch1);
      registry.register(ch2);
      await registry.connectAll();

      await registry.broadcast('Hello all');

      expect(ch1.sentMessages).toEqual([{ chatId: '', text: 'Hello all' }]);
      expect(ch2.sentMessages).toEqual([{ chatId: '', text: 'Hello all' }]);
    });

    it('should skip disconnected channels', async () => {
      const ch1 = new MockChannel('lark');
      const ch2 = new MockChannel('slack');
      registry.register(ch1);
      registry.register(ch2);
      await ch1.connect();
      // ch2 is not connected

      await registry.broadcast('Hello');

      expect(ch1.sentMessages.length).toBe(1);
      expect(ch2.sentMessages.length).toBe(0);
    });
  });

  describe('sendTo', () => {
    it('should send to a specific channel and chat', async () => {
      const ch = new MockChannel('lark');
      registry.register(ch);
      await registry.connectAll();

      await registry.sendTo('lark', 'chat-123', 'Hello Lark');

      expect(ch.sentMessages).toEqual([{ chatId: 'chat-123', text: 'Hello Lark' }]);
    });

    it('should not throw for unknown channel', async () => {
      await registry.sendTo('nonexistent', 'chat-1', 'Hello');
      // Should not throw, just log error
    });

    it('should not throw for disconnected channel', async () => {
      const ch = new MockChannel('lark');
      registry.register(ch);
      // Not connected

      await registry.sendTo('lark', 'chat-1', 'Hello');
      // Should not throw
    });
  });

  describe('getChannel', () => {
    it('should return undefined for unregistered channel', () => {
      expect(registry.getChannel('nonexistent')).toBeUndefined();
    });
  });
});

describe('LarkChannel', () => {
  let lark: LarkChannel;

  beforeEach(() => {
    lark = new LarkChannel();
  });

  it('should have name "lark"', () => {
    expect(lark.name).toBe('lark');
  });

  it('should start disconnected', () => {
    expect(lark.isConnected()).toBe(false);
  });

  it('should skip connect when no credentials', async () => {
    await lark.connect();
    // Without LARK_APP_ID/SECRET, connect gracefully skips
    expect(lark.isConnected()).toBe(false);
  });

  it('should disconnect successfully', async () => {
    // Even without connect, disconnect should not throw
    await lark.disconnect();
    expect(lark.isConnected()).toBe(false);
  });

  it('should throw when sending while disconnected', async () => {
    await expect(lark.sendMessage('chat-1', 'Hello')).rejects.toThrow('not connected');
  });
});
