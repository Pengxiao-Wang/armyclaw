import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AgentRunner } from '../src/orchestration/agents/runner.js';
import { LLMClient } from '../src/orchestration/arsenal.js';
import { CostTracker } from '../src/orchestration/depot.js';
import type { Task, LLMResponse, AgentRole } from '../src/types.js';

// ─── Mocks ──────────────────────────────────────────────────

vi.mock('../src/kernel/db.js', () => ({
  getAgentConfig: vi.fn((role: AgentRole) => ({
    role,
    model: 'claude-sonnet-4-20250514',
    provider: 'anthropic',
    temperature: 0.3,
    max_tokens: 8192,
    updated_at: '2026-01-01T00:00:00.000Z',
  })),
  recordAgentRun: vi.fn(() => 1),
  updateAgentRun: vi.fn(),
  writeProgressLog: vi.fn(),
  getFlowLog: vi.fn(() => []),
}));

vi.mock('../src/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
  },
}));

vi.mock('fs', () => ({
  default: {
    readFileSync: vi.fn((path: string) => {
      if (path.includes('adjutant')) return '# SOUL: Adjutant\nYou are the adjutant.';
      if (path.includes('chief_of_staff')) return '# SOUL: Chief of Staff\nYou are the chief of staff.';
      if (path.includes('inspector')) return '# SOUL: Inspector\nYou are the inspector.';
      if (path.includes('engineer')) return '# SOUL: Engineer\nYou are the engineer.';
      throw new Error(`ENOENT: no such file: ${path}`);
    }),
    mkdirSync: vi.fn(),
    existsSync: vi.fn(() => false),
  },
}));

vi.mock('../src/kernel/process-runner.js', () => ({
  runClaudeCode: vi.fn(async () => ({
    stdout: 'task completed successfully',
    stderr: '',
    code: 0,
    timedOut: false,
  })),
  runShellReadOnly: vi.fn(async (command: string) => ({
    stdout: `output of: ${command}`,
    stderr: '',
    code: 0,
    timedOut: false,
  })),
  buildSafeEnv: vi.fn(() => ({})),
}));

// ─── Test Data ──────────────────────────────────────────────

const mockTask: Task = {
  id: 'task-test001',
  parent_id: null,
  campaign_id: null,
  state: 'RECEIVED',
  description: 'Write a hello world function',
  priority: 'medium',
  assigned_agent: null,
  assigned_engineer_id: null,
  intent_type: null,
  reject_count_tactical: 0,
  reject_count_strategic: 0,
  rubric: null,
  artifacts_path: null,
  error_count: 0,
  override_skip_gate: 0,
  source_channel: null,
  source_chat_id: null,
  source_message_id: null,
  complexity: null,
  timeout_sec: null,
  delivery_content: null,
  context_chain: null,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
};

const mockLLMResponse: LLMResponse = {
  content: '{"tasks": [{"id": "task-001", "description": "hello world", "priority": "medium"}], "reply": "Got it!"}',
  input_tokens: 100,
  output_tokens: 50,
  model: 'claude-sonnet-4-20250514',
  stop_reason: 'end_turn',
};

// ─── Tests ──────────────────────────────────────────────────

describe('AgentRunner', () => {
  let llm: LLMClient;
  let costTracker: CostTracker;
  let runner: AgentRunner;

  beforeEach(() => {
    vi.clearAllMocks();

    llm = new LLMClient();
    llm.setMockResponse(mockLLMResponse);

    costTracker = new CostTracker();
    vi.spyOn(costTracker, 'trackCall').mockImplementation(async (_taskId, _role, fn) => {
      return fn();
    });

    runner = new AgentRunner(llm, costTracker);
  });

  describe('runAgent — single call (no tools)', () => {
    it('should call LLM and return response content for adjutant', async () => {
      const result = await runner.runAgent(mockTask, 'adjutant', 'test input');
      expect(result).toBe(mockLLMResponse.content);
    });

    it('should call LLM and return response content for operations', async () => {
      const result = await runner.runAgent(mockTask, 'operations', 'test input');
      expect(result).toBe(mockLLMResponse.content);
    });

    it('should record agent run in DB', async () => {
      const { recordAgentRun } = await import('../src/kernel/db.js');
      await runner.runAgent(mockTask, 'adjutant', 'test input');
      expect(recordAgentRun).toHaveBeenCalledTimes(1);
      expect(recordAgentRun).toHaveBeenCalledWith(
        expect.objectContaining({
          task_id: 'task-test001',
          agent_role: 'adjutant',
          status: 'running',
        }),
      );
    });

    it('should update agent run on success', async () => {
      const { updateAgentRun } = await import('../src/kernel/db.js');
      await runner.runAgent(mockTask, 'adjutant', 'test input');
      expect(updateAgentRun).toHaveBeenCalledWith(
        1,
        expect.objectContaining({
          status: 'success',
          input_tokens: 100,
          output_tokens: 50,
        }),
      );
    });

    it('should update agent run on error', async () => {
      const { updateAgentRun } = await import('../src/kernel/db.js');
      vi.spyOn(costTracker, 'trackCall').mockRejectedValueOnce(new Error('LLM call failed'));

      await expect(runner.runAgent(mockTask, 'adjutant', 'test input')).rejects.toThrow('LLM call failed');
      expect(updateAgentRun).toHaveBeenCalledWith(
        1,
        expect.objectContaining({
          status: 'error',
          error: 'LLM call failed',
        }),
      );
    });

    it('should write progress logs', async () => {
      const { writeProgressLog } = await import('../src/kernel/db.js');
      await runner.runAgent(mockTask, 'adjutant', 'test input');
      // Should write start and completion logs
      expect(writeProgressLog).toHaveBeenCalledTimes(2);
    });

    it('should use cost tracker for LLM calls', async () => {
      await runner.runAgent(mockTask, 'adjutant', 'test input');
      expect(costTracker.trackCall).toHaveBeenCalledWith(
        'task-test001',
        'adjutant',
        expect.any(Function),
      );
    });
  });

  describe('runAgent — Claude Code direct (engineer)', () => {
    it('should spawn Claude Code for engineer role', async () => {
      const result = await runner.runAgent(mockTask, 'engineer', 'build feature X');
      const parsed = JSON.parse(result);
      expect(parsed.status).toBe('completed');
      expect(parsed.result).toContain('task completed');
    });
  });

  describe('runAgent — agentic loop (chief_of_staff with run tool)', () => {
    it('should accumulate tokens across turns', async () => {
      const { updateAgentRun } = await import('../src/kernel/db.js');
      let callCount = 0;

      vi.spyOn(costTracker, 'trackCall').mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          return {
            content: '',
            tool_use: [{ type: 'tool_use' as const, id: 'tu-1', name: 'run', input: { command: 'ls' } }],
            input_tokens: 50,
            output_tokens: 30,
            model: 'claude-sonnet-4-20250514',
            stop_reason: 'tool_use',
          };
        }
        return {
          content: 'done',
          input_tokens: 80,
          output_tokens: 40,
          model: 'claude-sonnet-4-20250514',
          stop_reason: 'end_turn',
        };
      });

      await runner.runAgent(mockTask, 'chief_of_staff', 'analyze this');

      expect(updateAgentRun).toHaveBeenCalledWith(
        1,
        expect.objectContaining({
          status: 'success',
          input_tokens: 130,
          output_tokens: 70,
        }),
      );
    });

    it('should throw and record error when max turns exhausted', async () => {
      const { updateAgentRun } = await import('../src/kernel/db.js');

      vi.spyOn(costTracker, 'trackCall').mockImplementation(async () => ({
        content: 'still working...',
        tool_use: [{ type: 'tool_use' as const, id: 'tu-loop', name: 'run', input: { command: 'ls' } }],
        input_tokens: 10,
        output_tokens: 5,
        model: 'claude-sonnet-4-20250514',
        stop_reason: 'tool_use',
      }));

      await expect(runner.runAgent(mockTask, 'chief_of_staff', 'analyze')).rejects.toThrow('exhausted');

      expect(updateAgentRun).toHaveBeenCalledWith(
        1,
        expect.objectContaining({
          status: 'error',
          error: 'max_turns_exhausted',
        }),
      );
    });
  });

  describe('loadSoul', () => {
    it('should load SOUL file for known role', () => {
      const soul = runner.loadSoul('adjutant');
      expect(soul).toContain('Adjutant');
    });

    it('should return fallback for missing SOUL file', () => {
      const soul = runner.loadSoul('operations');
      expect(soul).toContain('operations');
    });
  });

  describe('buildContext', () => {
    it('should include task information', () => {
      const context = runner.buildContext(mockTask, 'adjutant');
      expect(context).toContain('task-test001');
      expect(context).toContain('RECEIVED');
      expect(context).toContain('medium');
      expect(context).toContain('hello world');
    });

    it('should include reject history when present', () => {
      const taskWithRejects = { ...mockTask, reject_count_tactical: 2, reject_count_strategic: 1 };
      const context = runner.buildContext(taskWithRejects, 'inspector');
      expect(context).toContain('Tactical rejects: 2');
      expect(context).toContain('Strategic rejects: 1');
    });

    it('should include rubric when present', () => {
      const taskWithRubric = { ...mockTask, rubric: JSON.stringify(['Test A', 'Test B']) };
      const context = runner.buildContext(taskWithRubric, 'inspector');
      expect(context).toContain('Test A');
      expect(context).toContain('Test B');
    });

  });
});
