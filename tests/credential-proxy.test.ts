import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

// Mock logger
vi.mock('../src/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { CredentialProxy } from '../src/arsenal/credential-proxy.js';

describe('CredentialProxy', () => {
  let proxy: CredentialProxy;

  beforeEach(() => {
    proxy = new CredentialProxy();
  });

  afterEach(() => {
    // Clean up any env vars we set
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.GOOGLE_API_KEY;
  });

  describe('loadFromEnv()', () => {
    it('loads API keys from environment variables', () => {
      process.env.ANTHROPIC_API_KEY = 'sk-ant-test123';
      process.env.OPENAI_API_KEY = 'sk-oai-test456';

      proxy.loadFromEnv();

      expect(proxy.hasKeys()).toBe(true);
      expect(proxy.getLoadedProviders()).toContain('anthropic');
      expect(proxy.getLoadedProviders()).toContain('openai');
    });

    it('handles missing env vars gracefully', () => {
      proxy.loadFromEnv();
      expect(proxy.hasKeys()).toBe(false);
      expect(proxy.getLoadedProviders()).toHaveLength(0);
    });
  });

  describe('setMasterKey()', () => {
    it('registers a master key', () => {
      proxy.setMasterKey('anthropic', 'sk-test-key');
      expect(proxy.hasKeys()).toBe(true);
      expect(proxy.getLoadedProviders()).toContain('anthropic');
    });
  });

  describe('token generation and resolution', () => {
    beforeEach(() => {
      proxy.setMasterKey('anthropic', 'sk-real-key-abc');
    });

    it('generates a token for a task', () => {
      const token = proxy.generateTaskToken('task-1');
      expect(token).toMatch(/^actkn_[a-f0-9]{64}$/);
    });

    it('resolves a valid token to the master key', () => {
      proxy.generateTaskToken('task-1');
      const resolved = proxy.resolveToken('task-1');
      expect(resolved).toBe('sk-real-key-abc');
    });

    it('returns null for unknown task', () => {
      expect(proxy.resolveToken('unknown-task')).toBeNull();
    });

    it('generates unique tokens per task', () => {
      const token1 = proxy.generateTaskToken('task-1');
      const token2 = proxy.generateTaskToken('task-2');
      expect(token1).not.toBe(token2);
    });
  });

  describe('provider-specific tokens', () => {
    beforeEach(() => {
      proxy.setMasterKey('anthropic', 'sk-ant-real');
      proxy.setMasterKey('openai', 'sk-oai-real');
    });

    it('generates token for specific provider', () => {
      proxy.generateTaskTokenForProvider('task-1', 'openai');
      const resolved = proxy.resolveToken('task-1');
      expect(resolved).toBe('sk-oai-real');
    });

    it('throws for unknown provider', () => {
      expect(() =>
        proxy.generateTaskTokenForProvider('task-1', 'nonexistent'),
      ).toThrow('No master key for provider: nonexistent');
    });
  });

  describe('token expiration', () => {
    beforeEach(() => {
      proxy.setMasterKey('anthropic', 'sk-real-key');
    });

    it('returns null for expired tokens', () => {
      vi.useFakeTimers();
      try {
        proxy.generateTaskToken('task-1');

        // Advance past TTL (1 hour)
        vi.advanceTimersByTime(60 * 60 * 1_000 + 1);

        expect(proxy.resolveToken('task-1')).toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });

    it('resolves tokens within TTL', () => {
      vi.useFakeTimers();
      try {
        proxy.generateTaskToken('task-1');

        // Advance to just before TTL
        vi.advanceTimersByTime(60 * 60 * 1_000 - 1000);

        expect(proxy.resolveToken('task-1')).toBe('sk-real-key');
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('revokeTaskToken()', () => {
    it('revokes a token so it can no longer be resolved', () => {
      proxy.setMasterKey('anthropic', 'sk-real-key');
      proxy.generateTaskToken('task-1');

      expect(proxy.resolveToken('task-1')).toBe('sk-real-key');

      proxy.revokeTaskToken('task-1');
      expect(proxy.resolveToken('task-1')).toBeNull();
    });

    it('does not throw when revoking nonexistent token', () => {
      expect(() => proxy.revokeTaskToken('nonexistent')).not.toThrow();
    });
  });

  describe('constantTimeCompare()', () => {
    it('returns true for identical strings', () => {
      expect(proxy.constantTimeCompare('abc', 'abc')).toBe(true);
    });

    it('returns false for different strings', () => {
      expect(proxy.constantTimeCompare('abc', 'abd')).toBe(false);
    });

    it('returns false for different lengths', () => {
      expect(proxy.constantTimeCompare('abc', 'abcd')).toBe(false);
    });

    it('returns true for empty strings', () => {
      expect(proxy.constantTimeCompare('', '')).toBe(true);
    });

    it('returns false for empty vs non-empty', () => {
      expect(proxy.constantTimeCompare('', 'a')).toBe(false);
    });

    it('handles long strings', () => {
      const long = 'a'.repeat(10_000);
      expect(proxy.constantTimeCompare(long, long)).toBe(true);
      expect(proxy.constantTimeCompare(long, long + 'b')).toBe(false);
    });
  });

  describe('security: keys never exposed', () => {
    it('getLoadedProviders only returns provider names, not keys', () => {
      proxy.setMasterKey('anthropic', 'sk-secret-key');
      const providers = proxy.getLoadedProviders();
      expect(providers).toEqual(['anthropic']);
      // Ensure the key is not in the output
      expect(JSON.stringify(providers)).not.toContain('sk-secret-key');
    });
  });

  describe('error cases', () => {
    it('throws when generating token without any master keys', () => {
      expect(() => proxy.generateTaskToken('task-1')).toThrow(
        'No master keys loaded',
      );
    });
  });
});
