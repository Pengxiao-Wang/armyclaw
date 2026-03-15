// ═══════════════════════════════════════════════════════════
// ArmyClaw — Depot (Cost Tracking)
// Wraps LLM calls, records token costs, enforces daily budget
// ═══════════════════════════════════════════════════════════

import { DAILY_BUDGET_USD } from '../config.js';
import { recordCost, getDailyCost } from '../kernel/db.js';
import { logger } from '../logger.js';
import type { AgentRole, LLMResponse } from '../types.js';

export class CostTracker {
  private static readonly COSTS: Record<string, { input: number; output: number }> = {
    'claude-opus-4-20250514': { input: 15, output: 75 },
    'claude-sonnet-4-20250514': { input: 3, output: 15 },
    'claude-haiku-4-5-20251001': { input: 0.8, output: 4 },
  };

  calculateCost(model: string, inputTokens: number, outputTokens: number): number {
    const pricing = CostTracker.COSTS[model];
    if (!pricing) return 0;
    return (inputTokens / 1_000_000) * pricing.input + (outputTokens / 1_000_000) * pricing.output;
  }

  async trackCall(
    taskId: string,
    agentRole: AgentRole,
    llmCall: () => Promise<LLMResponse>,
  ): Promise<LLMResponse> {
    if (this.isBudgetExceeded()) {
      throw new Error(`Daily budget exceeded ($${this.getDailySpend().toFixed(2)} / $${DAILY_BUDGET_USD})`);
    }

    const response = await llmCall();
    const cost = this.calculateCost(response.model, response.input_tokens, response.output_tokens);

    recordCost({
      task_id: taskId,
      agent_role: agentRole,
      model: response.model,
      input_tokens: response.input_tokens,
      output_tokens: response.output_tokens,
      cost_usd: cost,
      at: new Date().toISOString(),
    });

    if (this.isBudgetExceeded()) {
      logger.warn({ dailySpend: this.getDailySpend(), budget: DAILY_BUDGET_USD }, 'Daily budget exceeded!');
    }

    return response;
  }

  getDailySpend(): number { return getDailyCost(); }
  isBudgetExceeded(): boolean { return this.getDailySpend() >= DAILY_BUDGET_USD; }
  getBudgetRemaining(): number { return Math.max(0, DAILY_BUDGET_USD - this.getDailySpend()); }
  static getPricing(model: string): { input: number; output: number } | undefined { return CostTracker.COSTS[model]; }
}
