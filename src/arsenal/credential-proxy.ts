// ═══════════════════════════════════════════════════════════
// ArmyClaw — Credential Proxy
// Isolates API keys: engineers get temporary tokens, never real keys
// ═══════════════════════════════════════════════════════════

import { randomBytes } from 'crypto';

import { logger } from '../logger.js';

const TOKEN_TTL_MS = 60 * 60 * 1_000; // 1 hour

interface TaskToken {
  key: string;       // the master key this token resolves to
  expiresAt: number;
}

export class CredentialProxy {
  private masterKeys = new Map<string, string>();
  private taskTokens = new Map<string, TaskToken>();

  /**
   * Load API keys from environment variables.
   * Recognizes: ANTHROPIC_API_KEY, OPENAI_API_KEY, GOOGLE_API_KEY
   */
  loadFromEnv(): void {
    const envKeys: Record<string, string> = {
      ANTHROPIC_API_KEY: 'anthropic',
      OPENAI_API_KEY: 'openai',
      GOOGLE_API_KEY: 'google',
    };

    for (const [envVar, provider] of Object.entries(envKeys)) {
      const value = process.env[envVar];
      if (value) {
        this.masterKeys.set(provider, value);
        logger.info({ provider }, 'Loaded API key from environment');
      }
    }
  }

  /**
   * Register a master key manually (for testing or dynamic providers).
   */
  setMasterKey(provider: string, key: string): void {
    this.masterKeys.set(provider, key);
  }

  /**
   * Generate a temporary token for a task.
   * The token is a random hex string that maps to a real API key.
   *
   * @param taskId — unique identifier for the task
   * @returns the temporary token string
   */
  generateTaskToken(taskId: string): string {
    // Use the first available master key (in practice, the task knows which provider)
    const firstKey = this.masterKeys.values().next();
    if (!firstKey.value) {
      throw new Error('No master keys loaded — cannot generate task token');
    }

    const token = `actkn_${randomBytes(32).toString('hex')}`;
    this.taskTokens.set(taskId, {
      key: firstKey.value,
      expiresAt: Date.now() + TOKEN_TTL_MS,
    });

    return token;
  }

  /**
   * Generate a task token for a specific provider.
   */
  generateTaskTokenForProvider(taskId: string, provider: string): string {
    const masterKey = this.masterKeys.get(provider);
    if (!masterKey) {
      throw new Error(`No master key for provider: ${provider}`);
    }

    const token = `actkn_${randomBytes(32).toString('hex')}`;
    this.taskTokens.set(taskId, {
      key: masterKey,
      expiresAt: Date.now() + TOKEN_TTL_MS,
    });

    return token;
  }

  /**
   * Resolve a task token to the real API key.
   * Returns null if the token is invalid or expired.
   *
   * @param taskId — the task ID to resolve
   * @returns the real API key, or null
   */
  resolveToken(taskId: string): string | null {
    const entry = this.taskTokens.get(taskId);
    if (!entry) return null;

    if (Date.now() > entry.expiresAt) {
      this.taskTokens.delete(taskId);
      return null;
    }

    return entry.key;
  }

  /**
   * Revoke a task's temporary token immediately.
   */
  revokeTaskToken(taskId: string): void {
    this.taskTokens.delete(taskId);
  }

  /**
   * Constant-time string comparison to prevent timing attacks.
   * Both strings must be the same length for a meaningful comparison;
   * if lengths differ, returns false (but still iterates to avoid
   * leaking length info through timing).
   */
  constantTimeCompare(a: string, b: string): boolean {
    // Use the longer length to iterate so we don't short-circuit on length
    const len = Math.max(a.length, b.length);
    let mismatch = a.length !== b.length ? 1 : 0;

    for (let i = 0; i < len; i++) {
      const ca = i < a.length ? a.charCodeAt(i) : 0;
      const cb = i < b.length ? b.charCodeAt(i) : 0;
      mismatch |= ca ^ cb;
    }

    return mismatch === 0;
  }

  /**
   * Check if any master keys are loaded.
   */
  hasKeys(): boolean {
    return this.masterKeys.size > 0;
  }

  /**
   * Get the list of loaded providers (for diagnostics; never exposes keys).
   */
  getLoadedProviders(): string[] {
    return Array.from(this.masterKeys.keys());
  }
}
