// ═══════════════════════════════════════════════════════════
// ArmyClaw — Cost Tracking Middleware
// Wraps LLM calls, records token costs, enforces daily budget
// ═══════════════════════════════════════════════════════════

import { DAILY_BUDGET_USD } from '../config.js';
import { recordCost, getDailyCost } from '../db.js';
import { logger } from '../logger.js';
import type { AgentRole, LLMResponse } from '../types.js';

export class CostTracker {
  // Token costs per model (USD per 1M tokens)
  private static readonly COSTS: Record<string, { input: number; output: number }> = {
    'claude-opus-4-20250514': { input: 15, output: 75 },
    'claude-sonnet-4-20250514': { input: 3, output: 15 },
    'claude-haiku-4-5-20251001': { input: 0.8, output: 4 },
  };

  /**
   * Calculate cost in USD for a given model and token counts.
   * Returns 0 for unknown models.
   */
  calculateCost(model: string, inputTokens: number, outputTokens: number): number {
    const pricing = CostTracker.COSTS[model];
    if (!pricing) return 0;

    const inputCost = (inputTokens / 1_000_000) * pricing.input;
    const outputCost = (outputTokens / 1_000_000) * pricing.output;
    return inputCost + outputCost;
  }

  /**
   * Middleware: wraps an LLM call, records cost to DB, checks budget.
   *
   * @param taskId  — the task this call is for
   * @param agentRole — which agent made the call
   * @param llmCall — the actual LLM invocation (lazy, called inside)
   * @returns the LLMResponse from the wrapped call
   */
  async trackCall(
    taskId: string,
    agentRole: AgentRole,
    llmCall: () => Promise<LLMResponse>,
  ): Promise<LLMResponse> {
    const response = await llmCall();

    const cost = this.calculateCost(response.model, response.input_tokens, response.output_tokens);

    // Record to DB
    recordCost({
      task_id: taskId,
      agent_role: agentRole,
      model: response.model,
      input_tokens: response.input_tokens,
      output_tokens: response.output_tokens,
      cost_usd: cost,
      at: new Date().toISOString(),
    });

    // Warn if budget exceeded
    if (this.isBudgetExceeded()) {
      logger.warn(
        { dailySpend: this.getDailySpend(), budget: DAILY_BUDGET_USD },
        'Daily budget exceeded!',
      );
    }

    return response;
  }

  /**
   * Get total spend for today (USD).
   */
  getDailySpend(): number {
    return getDailyCost();
  }

  /**
   * Check if the daily budget has been exceeded.
   */
  isBudgetExceeded(): boolean {
    return this.getDailySpend() >= DAILY_BUDGET_USD;
  }

  /**
   * Get remaining budget for today (USD). Returns 0 if exceeded.
   */
  getBudgetRemaining(): number {
    const remaining = DAILY_BUDGET_USD - this.getDailySpend();
    return Math.max(0, remaining);
  }

  /**
   * Get pricing info for a model (for observability).
   */
  static getPricing(model: string): { input: number; output: number } | undefined {
    return CostTracker.COSTS[model];
  }
}
