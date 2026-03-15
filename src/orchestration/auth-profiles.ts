// ═══════════════════════════════════════════════════════════
// ArmyClaw — Auth Profiles
// Multi-profile credential management (API key + OAuth token)
// Inspired by OpenClaw's auth-profiles.json
// ═══════════════════════════════════════════════════════════

import { readFileSync, writeFileSync, existsSync } from 'fs';
import path from 'path';

import { DATA_DIR } from '../config.js';
import { logger } from '../logger.js';

// ─── Types ──────────────────────────────────────────────

export type AuthType = 'api_key' | 'token';

export interface AuthProfile {
  type: AuthType;
  provider: string;
  /** API key (for type: api_key) */
  key?: string;
  /** OAuth token (for type: token) */
  token?: string;
}

interface UsageStats {
  errorCount: number;
  lastFailureAt: number | null;
  lastUsed: number;
}

interface AuthProfilesStore {
  version: number;
  profiles: Record<string, AuthProfile>;
  lastGood: Record<string, string>;
  usageStats: Record<string, UsageStats>;
}

export interface ResolvedAuth {
  credential: string;
  type: AuthType;
  profileId: string;
}

// ─── Auth Profile Manager ───────────────────────────────

const PROFILES_FILE = path.join(DATA_DIR, 'auth-profiles.json');

let store: AuthProfilesStore | null = null;

function defaultStore(): AuthProfilesStore {
  return { version: 1, profiles: {}, lastGood: {}, usageStats: {} };
}

/**
 * Load auth profiles from disk. Falls back to env vars if no file.
 */
export function loadAuthProfiles(): void {
  if (existsSync(PROFILES_FILE)) {
    try {
      const raw = readFileSync(PROFILES_FILE, 'utf-8');
      store = JSON.parse(raw) as AuthProfilesStore;
      const profileCount = Object.keys(store.profiles).length;
      logger.info({ file: PROFILES_FILE, profiles: profileCount }, 'Auth profiles loaded');
      return;
    } catch (err) {
      logger.warn({ error: String(err) }, 'Failed to parse auth-profiles.json, falling back to env');
    }
  }

  // Fall back: build profiles from environment variables
  store = defaultStore();

  const oauthToken = process.env.ANTHROPIC_OAUTH_TOKEN;
  if (oauthToken) {
    store.profiles['anthropic:oauth'] = {
      type: 'token',
      provider: 'anthropic',
      token: oauthToken,
    };
    logger.info('Auth profile created from ANTHROPIC_OAUTH_TOKEN');
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (apiKey) {
    // Auto-detect: sk-ant-oat* → token type, otherwise api_key
    if (apiKey.startsWith('sk-ant-oat')) {
      store.profiles['anthropic:oauth'] = {
        type: 'token',
        provider: 'anthropic',
        token: apiKey,
      };
      logger.info('Auth profile created from ANTHROPIC_API_KEY (detected as OAuth token)');
    } else {
      store.profiles['anthropic:default'] = {
        type: 'api_key',
        provider: 'anthropic',
        key: apiKey,
      };
      logger.info('Auth profile created from ANTHROPIC_API_KEY');
    }
  }

  // Auto-detect Claude Max OAuth token from ~/.claude/.credentials.json
  if (Object.keys(store.profiles).length === 0) {
    try {
      const credPath = path.join(process.env.HOME || '', '.claude', '.credentials.json');
      const creds = JSON.parse(readFileSync(credPath, 'utf-8'));
      const token = creds?.claudeAiOauth?.accessToken;
      if (token) {
        store.profiles['anthropic:claude-max'] = {
          type: 'token',
          provider: 'anthropic',
          token,
        };
        logger.info('Auth profile created from ~/.claude/.credentials.json (Claude Max)');
      }
    } catch {
      // No credentials file
    }
  }
}

/**
 * Persist current profiles to disk.
 */
export function saveAuthProfiles(): void {
  if (!store) return;
  try {
    writeFileSync(PROFILES_FILE, JSON.stringify(store, null, 2));
  } catch (err) {
    logger.error({ error: String(err) }, 'Failed to save auth-profiles.json');
  }
}

/**
 * Resolve credentials for a provider. Returns the best available profile.
 * For OAuth tokens from ~/.claude/.credentials.json, always re-reads the file
 * because Claude Code may have refreshed the token since we last loaded.
 */
export function resolveAuth(provider: string): ResolvedAuth | null {
  if (!store) loadAuthProfiles();
  if (!store) return null;

  // For claude-max OAuth profile, always re-read the credentials file
  // Claude Code refreshes tokens in the background — our cached copy may be stale
  if (store.profiles['anthropic:claude-max']) {
    try {
      const credPath = path.join(process.env.HOME || '', '.claude', '.credentials.json');
      const creds = JSON.parse(readFileSync(credPath, 'utf-8'));
      const freshToken = creds?.claudeAiOauth?.accessToken;
      if (freshToken) {
        store.profiles['anthropic:claude-max'].token = freshToken;
      }
    } catch { /* keep existing token */ }
  }

  // Try lastGood first
  const lastGoodId = store.lastGood[provider];
  if (lastGoodId && store.profiles[lastGoodId]) {
    const resolved = profileToAuth(lastGoodId, store.profiles[lastGoodId]);
    if (resolved) return resolved;
  }

  // Fall back to first matching profile
  for (const [id, profile] of Object.entries(store.profiles)) {
    if (profile.provider === provider) {
      const resolved = profileToAuth(id, profile);
      if (resolved) return resolved;
    }
  }

  return null;
}

/**
 * Record a successful call — updates lastGood and usage stats.
 */
export function recordAuthSuccess(profileId: string, provider: string): void {
  if (!store) return;
  store.lastGood[provider] = profileId;

  if (!store.usageStats[profileId]) {
    store.usageStats[profileId] = { errorCount: 0, lastFailureAt: null, lastUsed: Date.now() };
  }
  store.usageStats[profileId].errorCount = 0;
  store.usageStats[profileId].lastUsed = Date.now();
}

/**
 * Record a failed call — updates usage stats.
 */
export function recordAuthFailure(profileId: string): void {
  if (!store) return;

  if (!store.usageStats[profileId]) {
    store.usageStats[profileId] = { errorCount: 0, lastFailureAt: null, lastUsed: Date.now() };
  }
  store.usageStats[profileId].errorCount++;
  store.usageStats[profileId].lastFailureAt = Date.now();
}

/**
 * Build Anthropic-compatible auth headers from a resolved credential.
 */
export function buildAuthHeaders(auth: ResolvedAuth): Record<string, string> {
  const headers: Record<string, string> = {
    'anthropic-version': '2023-06-01',
  };

  if (auth.type === 'token') {
    headers['Authorization'] = `Bearer ${auth.credential}`;
  } else {
    headers['x-api-key'] = auth.credential;
  }

  return headers;
}

/**
 * Get all profiles (for War Room observability). Never exposes full credentials.
 */
export function getProfileSummary(): { id: string; type: AuthType; provider: string; masked: string }[] {
  if (!store) loadAuthProfiles();
  if (!store) return [];

  return Object.entries(store.profiles).map(([id, p]) => {
    const raw = p.key || p.token || '';
    const masked = raw.length > 12 ? `${raw.slice(0, 8)}...${raw.slice(-4)}` : '***';
    return { id, type: p.type, provider: p.provider, masked };
  });
}

// ─── Helpers ────────────────────────────────────────────

function profileToAuth(id: string, profile: AuthProfile): ResolvedAuth | null {
  const credential = profile.type === 'token' ? profile.token : profile.key;
  if (!credential) return null;
  return { credential, type: profile.type, profileId: id };
}
