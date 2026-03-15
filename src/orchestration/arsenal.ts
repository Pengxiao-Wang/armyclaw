// ═══════════════════════════════════════════════════════════
// ArmyClaw — Arsenal (LLM Client + Circuit Breaker)
// Retry + Circuit Breaker + Failover + Response Cache
// ═══════════════════════════════════════════════════════════

import { createHash } from 'crypto';
import { DEFAULT_PROVIDER } from '../config.js';
import { logger } from '../logger.js';
import { resolveAuth, recordAuthSuccess, recordAuthFailure } from './auth-profiles.js';
import type { LLMRequest, LLMResponse, ToolUseBlock, CircuitState, Observer } from '../types.js';

// ─── Circuit Breaker ────────────────────────────────────────

export class CircuitBreaker {
  private state: CircuitState = 'closed';
  private failureCount = 0;
  private lastFailureTime = 0;
  private halfOpenAttempts = 0;

  constructor(
    private readonly failureThreshold: number,
    private readonly resetTimeoutMs: number,
    private readonly halfOpenMax: number,
  ) {}

  canExecute(): boolean {
    switch (this.state) {
      case 'closed':
        return true;
      case 'open': {
        const elapsed = Date.now() - this.lastFailureTime;
        if (elapsed >= this.resetTimeoutMs) {
          this.state = 'half_open';
          this.halfOpenAttempts = 0;
          return true;
        }
        return false;
      }
      case 'half_open':
        if (this.halfOpenAttempts < this.halfOpenMax) {
          this.halfOpenAttempts++;
          return true;
        }
        return false;
      default:
        return false;
    }
  }

  recordSuccess(): void {
    switch (this.state) {
      case 'closed':
        this.failureCount = 0;
        break;
      case 'half_open':
        this.state = 'closed';
        this.failureCount = 0;
        this.halfOpenAttempts = 0;
        break;
      case 'open':
        this.state = 'closed';
        this.failureCount = 0;
        break;
    }
  }

  recordFailure(): void {
    this.lastFailureTime = Date.now();
    switch (this.state) {
      case 'closed':
        this.failureCount++;
        if (this.failureCount >= this.failureThreshold) {
          this.state = 'open';
        }
        break;
      case 'half_open':
        this.state = 'open';
        this.halfOpenAttempts = 0;
        break;
      case 'open':
        break;
    }
  }

  getState(): CircuitState {
    return this.state;
  }

  reset(): void {
    this.state = 'closed';
    this.failureCount = 0;
    this.lastFailureTime = 0;
    this.halfOpenAttempts = 0;
  }
}

// ─── LLM Client ─────────────────────────────────────────────

const MAX_RETRIES = 3;
const BASE_BACKOFF_MS = 1_000;
const CACHE_TTL_MS = 60 * 60 * 1_000;
const CB_FAILURE_THRESHOLD = 5;
const CB_RESET_TIMEOUT_MS = 60_000;
const CB_HALF_OPEN_MAX = 3;

interface CacheEntry {
  response: LLMResponse;
  expiresAt: number;
}

export class LLMClient {
  private static observer: Observer | null = null;

  static setObserver(obs: Observer): void {
    LLMClient.observer = obs;
  }

  private breakers = new Map<string, CircuitBreaker>();
  private cache = new Map<string, CacheEntry>();
  private mockResponse: LLMResponse | null = null;
  private failoverProvider: string;

  constructor(private defaultProvider: string = DEFAULT_PROVIDER) {
    this.failoverProvider = defaultProvider === 'anthropic' ? 'openai' : 'anthropic';
  }

  setMockResponse(response: LLMResponse): void {
    this.mockResponse = response;
  }

  clearMockResponse(): void {
    this.mockResponse = null;
  }

  async call(request: LLMRequest): Promise<LLMResponse> {
    if (this.mockResponse) return { ...this.mockResponse };

    const hasExecutableTools = request.tools && request.tools.length > 0 && !request.tool_choice;
    const cacheKey = hasExecutableTools ? null : this.computeCacheKey(request);

    if (cacheKey) {
      const cached = this.getFromCache(cacheKey);
      if (cached) return cached;
    }

    const provider = this.getProviderFromModel(request.model);
    try {
      const response = await this.callWithRetry(request, provider);
      if (cacheKey) this.putInCache(cacheKey, response);
      return response;
    } catch (primaryError) {
      const breaker = this.getBreaker(provider);
      if (breaker.getState() === 'open') {
        logger.warn({ provider, failover: this.failoverProvider }, 'Primary circuit open, trying failover');
        try {
          const response = await this.callWithRetry(request, this.failoverProvider);
          if (cacheKey) this.putInCache(cacheKey, response);
          return response;
        } catch (failoverError) {
          logger.error({ failoverProvider: this.failoverProvider }, 'Failover also failed');
          throw failoverError;
        }
      }
      throw primaryError;
    }
  }

  private async callWithRetry(request: LLMRequest, provider: string): Promise<LLMResponse> {
    const breaker = this.getBreaker(provider);
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      if (!breaker.canExecute()) {
        throw new Error(`Circuit breaker OPEN for provider: ${provider}`);
      }

      try {
        const response = await this.executeCall(request, provider);
        breaker.recordSuccess();
        LLMClient.observer?.recordEvent({ type: 'llm_response', model: request.model, durationMs: 0, success: true });
        return response;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        breaker.recordFailure();
        LLMClient.observer?.recordEvent({ type: 'llm_response', model: request.model, durationMs: 0, success: false, error: lastError.message });
        logger.warn({ provider, attempt: attempt + 1, error: lastError.message }, 'LLM call failed, retrying');
        if (attempt < MAX_RETRIES - 1) {
          await new Promise((r) => setTimeout(r, BASE_BACKOFF_MS * Math.pow(2, attempt)));
        }
      }
    }

    throw lastError ?? new Error(`All ${MAX_RETRIES} retries exhausted for: ${provider}`);
  }

  private async executeCall(request: LLMRequest, provider: string): Promise<LLMResponse> {
    if (this.mockResponse) return { ...this.mockResponse };
    if (provider === 'anthropic') return this.callAnthropic(request);
    return { content: `[stub from ${provider}]`, input_tokens: 0, output_tokens: 0, model: request.model, stop_reason: 'end_turn' };
  }

  /**
   * Call Anthropic LLM. Direct API for both API key and OAuth token.
   * OAuth uses Bearer + anthropic-beta header (learned from OpenClaw).
   */
  private async callAnthropic(request: LLMRequest): Promise<LLMResponse> {
    const auth = resolveAuth('anthropic');
    if (!auth) {
      throw new Error('No Anthropic credentials found');
    }
    return this.callAnthropicDirect(request, auth);
  }

  /** Direct Anthropic API call — supports both API key and OAuth token */
  private async callAnthropicDirect(
    request: LLMRequest,
    auth: { credential: string; type: 'api_key' | 'token'; profileId: string },
  ): Promise<LLMResponse> {
    const body: Record<string, unknown> = {
      model: request.model,
      max_tokens: request.max_tokens ?? 8192,
      system: request.system,
      messages: request.messages.map((m) => ({ role: m.role, content: m.content })),
    };

    if (request.temperature !== undefined) body.temperature = request.temperature;

    if (request.tools && request.tools.length > 0) {
      body.tools = request.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.input_schema,
      }));
      if (request.tool_choice) body.tool_choice = request.tool_choice;
    }

    // Build auth headers: OAuth Bearer or API key (from OpenClaw's approach)
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'anthropic-version': '2023-06-01',
    };

    if (auth.type === 'token') {
      // OAuth token: Bearer + beta flag (the magic header OpenClaw uses)
      headers['Authorization'] = `Bearer ${auth.credential}`;
      headers['anthropic-beta'] = 'oauth-2025-04-20';
    } else {
      // API key: standard x-api-key
      headers['x-api-key'] = auth.credential;
    }

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errorBody = await res.text();
      recordAuthFailure(auth.profileId);

      // OAuth token expired → try refresh
      if (res.status === 401 && auth.type === 'token') {
        logger.warn('OAuth token may be expired, attempting refresh');
        const refreshed = await this.refreshOAuthToken();
        if (refreshed) {
          // Retry once with refreshed token
          const newAuth = resolveAuth('anthropic');
          if (newAuth) return this.callAnthropicDirect(request, newAuth);
        }
      }

      throw new Error(`Anthropic API error ${res.status}: ${errorBody}`);
    }

    recordAuthSuccess(auth.profileId, 'anthropic');

    const data = (await res.json()) as {
      content: { type: string; text?: string; id?: string; name?: string; input?: Record<string, unknown> }[];
      usage: { input_tokens: number; output_tokens: number };
      model: string;
      stop_reason: string;
    };

    const textContent = data.content.filter((c) => c.type === 'text').map((c) => c.text ?? '').join('');
    const toolUseBlocks: ToolUseBlock[] = data.content
      .filter((c) => c.type === 'tool_use')
      .map((c) => ({ type: 'tool_use' as const, id: c.id!, name: c.name!, input: c.input ?? {} }));

    return {
      content: textContent,
      tool_use: toolUseBlocks.length > 0 ? toolUseBlocks : undefined,
      input_tokens: data.usage.input_tokens,
      output_tokens: data.usage.output_tokens,
      model: data.model,
      stop_reason: data.stop_reason,
    };
  }

  /**
   * Reload OAuth token from ~/.claude/.credentials.json.
   * Claude Code keeps this file fresh — we just re-read it.
   */
  private async refreshOAuthToken(): Promise<boolean> {
    try {
      // Simply reload auth profiles — Claude Code maintains the credentials file
      const { loadAuthProfiles } = require('./auth-profiles.js');
      loadAuthProfiles();
      logger.info('Auth profiles reloaded from credentials file');
      return true;
    } catch (err) {
      logger.error({ error: String(err) }, 'Auth reload error');
      return false;
    }
  }

  // CLI fallback removed — direct API with OAuth beta header works for all auth types

  private getBreaker(provider: string): CircuitBreaker {
    let breaker = this.breakers.get(provider);
    if (!breaker) {
      breaker = new CircuitBreaker(CB_FAILURE_THRESHOLD, CB_RESET_TIMEOUT_MS, CB_HALF_OPEN_MAX);
      this.breakers.set(provider, breaker);
    }
    return breaker;
  }

  getCircuitBreaker(provider: string): CircuitBreaker | undefined {
    return this.breakers.get(provider);
  }

  private computeCacheKey(request: LLMRequest): string {
    return createHash('sha256').update(JSON.stringify({
      model: request.model, system: request.system,
      messages: request.messages, temperature: request.temperature, max_tokens: request.max_tokens,
    })).digest('hex');
  }

  private getFromCache(key: string): LLMResponse | null {
    const entry = this.cache.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) { this.cache.delete(key); return null; }
    return { ...entry.response };
  }

  private putInCache(key: string, response: LLMResponse): void {
    this.cache.set(key, { response: { ...response }, expiresAt: Date.now() + CACHE_TTL_MS });
  }

  clearCache(): void { this.cache.clear(); }

  private getProviderFromModel(model: string): string {
    if (model.startsWith('claude-')) return 'anthropic';
    if (model.startsWith('gpt-')) return 'openai';
    return this.defaultProvider;
  }
}
