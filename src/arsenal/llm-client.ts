// ═══════════════════════════════════════════════════════════
// ArmyClaw — LLM Client
// Retry + Circuit Breaker + Failover + Response Cache
// ═══════════════════════════════════════════════════════════

import { createHash } from 'crypto';

import { CircuitBreaker } from './circuit-breaker.js';
import { resolveAuth, buildAuthHeaders, recordAuthSuccess, recordAuthFailure } from './auth-profiles.js';
import {
  CIRCUIT_BREAKER_FAILURE_THRESHOLD,
  CIRCUIT_BREAKER_RESET_TIMEOUT_MS,
  CIRCUIT_BREAKER_HALF_OPEN_MAX,
  DEFAULT_PROVIDER,
} from '../config.js';
import { logger } from '../logger.js';
import type { LLMRequest, LLMResponse, ToolUseBlock } from '../types.js';

// ─── Constants ───────────────────────────────────────────────

const MAX_RETRIES = 3;
const BASE_BACKOFF_MS = 1_000;
const CACHE_TTL_MS = 60 * 60 * 1_000; // 1 hour

// ─── Cache Entry ─────────────────────────────────────────────

interface CacheEntry {
  response: LLMResponse;
  expiresAt: number;
}

// ─── LLM Client ──────────────────────────────────────────────

export class LLMClient {
  private breakers = new Map<string, CircuitBreaker>();
  private cache = new Map<string, CacheEntry>();
  private mockResponse: LLMResponse | null = null;
  private failoverProvider: string = 'openai';

  constructor(private defaultProvider: string = DEFAULT_PROVIDER) {
    if (defaultProvider === 'anthropic') {
      this.failoverProvider = 'openai';
    } else {
      this.failoverProvider = 'anthropic';
    }
  }

  /**
   * Set a mock response for testing. When set, all calls return this response
   * instead of hitting a real provider.
   */
  setMockResponse(response: LLMResponse): void {
    this.mockResponse = response;
  }

  /**
   * Clear the mock response, restoring normal operation.
   */
  clearMockResponse(): void {
    this.mockResponse = null;
  }

  /**
   * Main entry point: call LLM with retry, circuit breaker, and failover.
   */
  async call(request: LLMRequest): Promise<LLMResponse> {
    // Mock path — bypass everything
    if (this.mockResponse) {
      return { ...this.mockResponse };
    }

    // Cache check — skip if tools are present (side effects), but allow response-only tools
    const hasExecutableTools = request.tools && request.tools.length > 0 && !request.tool_choice;
    const cacheKey = hasExecutableTools
      ? null
      : this.computeCacheKey(request);

    if (cacheKey) {
      const cached = this.getFromCache(cacheKey);
      if (cached) return cached;
    }

    // Try primary provider
    const provider = this.getProviderFromModel(request.model);
    try {
      const response = await this.callWithRetry(request, provider);

      if (cacheKey) {
        this.putInCache(cacheKey, response);
      }
      return response;
    } catch (primaryError) {
      // Primary failed — try failover if circuit is open
      const breaker = this.getBreaker(provider);
      if (breaker.getState() === 'open') {
        logger.warn(
          { provider, failover: this.failoverProvider },
          'Primary provider circuit open, attempting failover',
        );
        try {
          const response = await this.callWithRetry(request, this.failoverProvider);
          if (cacheKey) {
            this.putInCache(cacheKey, response);
          }
          return response;
        } catch (failoverError) {
          logger.error({ failoverProvider: this.failoverProvider }, 'Failover also failed');
          throw failoverError;
        }
      }
      throw primaryError;
    }
  }

  /**
   * Retry loop with exponential backoff.
   */
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
        return response;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        breaker.recordFailure();

        logger.warn(
          { provider, attempt: attempt + 1, maxRetries: MAX_RETRIES, error: lastError.message },
          'LLM call failed, retrying',
        );

        // Don't sleep after the last attempt
        if (attempt < MAX_RETRIES - 1) {
          const backoffMs = BASE_BACKOFF_MS * Math.pow(2, attempt);
          await this.sleep(backoffMs);
        }
      }
    }

    throw lastError ?? new Error(`All ${MAX_RETRIES} retries exhausted for provider: ${provider}`);
  }

  /**
   * Execute a single LLM call against a provider.
   * Currently returns mock data. The callAnthropic method below shows
   * the real implementation structure.
   */
  private async executeCall(request: LLMRequest, provider: string): Promise<LLMResponse> {
    if (this.mockResponse) {
      return { ...this.mockResponse };
    }

    switch (provider) {
      case 'anthropic':
        return this.callAnthropic(request);
      default:
        // Stub for other providers
        return {
          content: `[stub response from ${provider}]`,
          input_tokens: 0,
          output_tokens: 0,
          model: request.model,
          stop_reason: 'end_turn',
        };
    }
  }

  /**
   * Real Anthropic API call structure. Not connected to mock path —
   * this is the production implementation.
   */
  private async callAnthropic(request: LLMRequest): Promise<LLMResponse> {
    const auth = resolveAuth('anthropic');
    if (!auth) {
      throw new Error('No Anthropic credentials — set ANTHROPIC_API_KEY, ANTHROPIC_OAUTH_TOKEN, or configure auth-profiles.json');
    }

    const body: Record<string, unknown> = {
      model: request.model,
      max_tokens: request.max_tokens ?? 8192,
      system: request.system,
      messages: request.messages.map((m) => ({
        role: m.role,
        content: m.content,
      })),
    };

    if (request.temperature !== undefined) {
      body.temperature = request.temperature;
    }

    if (request.tools && request.tools.length > 0) {
      body.tools = request.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.input_schema,
      }));

      if (request.tool_choice) {
        body.tool_choice = request.tool_choice;
      }
    }

    const authHeaders = buildAuthHeaders(auth);

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...authHeaders,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errorBody = await res.text();
      recordAuthFailure(auth.profileId);
      throw new Error(`Anthropic API error ${res.status}: ${errorBody}`);
    }

    recordAuthSuccess(auth.profileId, 'anthropic');

    const data = (await res.json()) as {
      content: { type: string; text?: string; id?: string; name?: string; input?: Record<string, unknown> }[];
      usage: { input_tokens: number; output_tokens: number };
      model: string;
      stop_reason: string;
    };

    const textContent = data.content
      .filter((c) => c.type === 'text')
      .map((c) => c.text ?? '')
      .join('');

    // Extract tool_use blocks
    const toolUseBlocks: ToolUseBlock[] = data.content
      .filter((c) => c.type === 'tool_use')
      .map((c) => ({
        type: 'tool_use' as const,
        id: c.id!,
        name: c.name!,
        input: c.input ?? {},
      }));

    return {
      content: textContent,
      tool_use: toolUseBlocks.length > 0 ? toolUseBlocks : undefined,
      input_tokens: data.usage.input_tokens,
      output_tokens: data.usage.output_tokens,
      model: data.model,
      stop_reason: data.stop_reason,
    };
  }

  // ─── Circuit Breaker Management ────────────────────────────

  private getBreaker(provider: string): CircuitBreaker {
    let breaker = this.breakers.get(provider);
    if (!breaker) {
      breaker = new CircuitBreaker(
        CIRCUIT_BREAKER_FAILURE_THRESHOLD,
        CIRCUIT_BREAKER_RESET_TIMEOUT_MS,
        CIRCUIT_BREAKER_HALF_OPEN_MAX,
      );
      this.breakers.set(provider, breaker);
    }
    return breaker;
  }

  /**
   * Get the circuit breaker for a specific provider (for testing/observability).
   */
  getCircuitBreaker(provider: string): CircuitBreaker | undefined {
    return this.breakers.get(provider);
  }

  // ─── Cache ─────────────────────────────────────────────────

  private computeCacheKey(request: LLMRequest): string {
    const payload = JSON.stringify({
      model: request.model,
      system: request.system,
      messages: request.messages,
      temperature: request.temperature,
      max_tokens: request.max_tokens,
    });
    return createHash('sha256').update(payload).digest('hex');
  }

  private getFromCache(key: string): LLMResponse | null {
    const entry = this.cache.get(key);
    if (!entry) return null;

    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      return null;
    }

    return { ...entry.response };
  }

  private putInCache(key: string, response: LLMResponse): void {
    this.cache.set(key, {
      response: { ...response },
      expiresAt: Date.now() + CACHE_TTL_MS,
    });
  }

  /**
   * Clear the entire response cache.
   */
  clearCache(): void {
    this.cache.clear();
  }

  // ─── Helpers ───────────────────────────────────────────────

  private getProviderFromModel(model: string): string {
    if (model.startsWith('claude-')) return 'anthropic';
    if (model.startsWith('gpt-')) return 'openai';
    return this.defaultProvider;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
