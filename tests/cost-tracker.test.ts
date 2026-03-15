import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock the db module before importing CostTracker
vi.mock('../src/kernel/db.js', () => ({
  recordCost: vi.fn(),
  getDailyCost: vi.fn(() => 0),
}));

// Mock the logger to avoid actual log output in tests
vi.mock('../src/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { CostTracker } from '../src/orchestration/depot.js';
import { recordCost, getDailyCost } from '../src/kernel/db.js';
import type { LLMResponse, AgentRole } from '../src/types.js';

describe('CostTracker', () => {
  let tracker: CostTracker;

  beforeEach(() => {
    tracker = new CostTracker();
    vi.clearAllMocks();
  });

  describe('calculateCost()', () => {
    it('calculates cost for claude-opus-4', () => {
      // 1000 input tokens at $15/1M = $0.015
      // 500 output tokens at $75/1M = $0.0375
      const cost = tracker.calculateCost('claude-opus-4-20250514', 1000, 500);
      expect(cost).toBeCloseTo(0.0525, 6);
    });

    it('calculates cost for claude-sonnet-4', () => {
      // 1000 input at $3/1M = $0.003
      // 500 output at $15/1M = $0.0075
      const cost = tracker.calculateCost('claude-sonnet-4-20250514', 1000, 500);
      expect(cost).toBeCloseTo(0.0105, 6);
    });

    it('calculates cost for claude-haiku-4.5', () => {
      // 1000 input at $0.8/1M = $0.0008
      // 500 output at $4/1M = $0.002
      const cost = tracker.calculateCost('claude-haiku-4-5-20251001', 1000, 500);
      expect(cost).toBeCloseTo(0.0028, 6);
    });

    it('returns 0 for unknown models', () => {
      const cost = tracker.calculateCost('gpt-4o', 10000, 5000);
      expect(cost).toBe(0);
    });

    it('handles zero tokens', () => {
      const cost = tracker.calculateCost('claude-opus-4-20250514', 0, 0);
      expect(cost).toBe(0);
    });

    it('handles large token counts', () => {
      // 1M input at $15/1M = $15
      // 1M output at $75/1M = $75
      const cost = tracker.calculateCost('claude-opus-4-20250514', 1_000_000, 1_000_000);
      expect(cost).toBeCloseTo(90, 2);
    });
  });

  describe('trackCall()', () => {
    it('calls the LLM function and records cost', async () => {
      const mockResponse: LLMResponse = {
        content: 'Hello',
        input_tokens: 100,
        output_tokens: 50,
        model: 'claude-sonnet-4-20250514',
        stop_reason: 'end_turn',
      };

      const llmCall = vi.fn().mockResolvedValue(mockResponse);

      const result = await tracker.trackCall('task-1', 'engineer' as AgentRole, llmCall);

      expect(result).toEqual(mockResponse);
      expect(llmCall).toHaveBeenCalledOnce();
      expect(recordCost).toHaveBeenCalledOnce();

      const costArg = vi.mocked(recordCost).mock.calls[0]![0];
      expect(costArg.task_id).toBe('task-1');
      expect(costArg.agent_role).toBe('engineer');
      expect(costArg.model).toBe('claude-sonnet-4-20250514');
      expect(costArg.input_tokens).toBe(100);
      expect(costArg.output_tokens).toBe(50);
      expect(costArg.cost_usd).toBeGreaterThan(0);
    });

    it('propagates LLM call errors', async () => {
      const llmCall = vi.fn().mockRejectedValue(new Error('API timeout'));

      await expect(
        tracker.trackCall('task-1', 'engineer' as AgentRole, llmCall),
      ).rejects.toThrow('API timeout');

      expect(recordCost).not.toHaveBeenCalled();
    });
  });

  describe('pre-flight budget check', () => {
    it('blocks LLM call when budget is already exceeded', async () => {
      vi.mocked(getDailyCost).mockReturnValue(50); // at limit
      const llmCall = vi.fn();

      await expect(
        tracker.trackCall('task-1', 'engineer' as AgentRole, llmCall),
      ).rejects.toThrow('Daily budget exceeded');

      // LLM call should NOT have been invoked
      expect(llmCall).not.toHaveBeenCalled();
      expect(recordCost).not.toHaveBeenCalled();
    });

    it('allows LLM call when under budget', async () => {
      vi.mocked(getDailyCost).mockReturnValue(10); // under budget
      const mockResponse: LLMResponse = {
        content: 'ok',
        input_tokens: 100,
        output_tokens: 50,
        model: 'claude-sonnet-4-20250514',
        stop_reason: 'end_turn',
      };
      const llmCall = vi.fn().mockResolvedValue(mockResponse);

      const result = await tracker.trackCall('task-1', 'engineer' as AgentRole, llmCall);

      expect(result).toEqual(mockResponse);
      expect(llmCall).toHaveBeenCalledOnce();
    });
  });

  describe('budget checking', () => {
    it('returns false when under budget', () => {
      vi.mocked(getDailyCost).mockReturnValue(10);
      expect(tracker.isBudgetExceeded()).toBe(false);
    });

    it('returns true when at budget limit', () => {
      vi.mocked(getDailyCost).mockReturnValue(50); // DAILY_BUDGET_USD default = 50
      expect(tracker.isBudgetExceeded()).toBe(true);
    });

    it('returns true when over budget', () => {
      vi.mocked(getDailyCost).mockReturnValue(75);
      expect(tracker.isBudgetExceeded()).toBe(true);
    });

    it('getDailySpend delegates to DB', () => {
      vi.mocked(getDailyCost).mockReturnValue(25.5);
      expect(tracker.getDailySpend()).toBe(25.5);
    });

    it('getBudgetRemaining calculates correctly', () => {
      vi.mocked(getDailyCost).mockReturnValue(30);
      expect(tracker.getBudgetRemaining()).toBeCloseTo(20, 2); // 50 - 30
    });

    it('getBudgetRemaining returns 0 when exceeded', () => {
      vi.mocked(getDailyCost).mockReturnValue(100);
      expect(tracker.getBudgetRemaining()).toBe(0);
    });
  });

  describe('getPricing()', () => {
    it('returns pricing for known models', () => {
      const pricing = CostTracker.getPricing('claude-opus-4-20250514');
      expect(pricing).toEqual({ input: 15, output: 75 });
    });

    it('returns undefined for unknown models', () => {
      const pricing = CostTracker.getPricing('unknown-model');
      expect(pricing).toBeUndefined();
    });
  });
});
