import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

// Mock DB functions
vi.mock('../src/db.js', () => ({
  getActiveRuns: vi.fn(() => []),
  getRecentRunsForTask: vi.fn(() => []),
  getTaskById: vi.fn(),
  updateTask: vi.fn(),
  updateTaskState: vi.fn(),
  writeFlowLog: vi.fn(),
}));

// Mock logger
vi.mock('../src/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { Medic } from '../src/medic/self-repair.js';
import { getActiveRuns, getRecentRunsForTask, getTaskById, updateTask, updateTaskState, writeFlowLog } from '../src/db.js';
import type { AgentRun, Task } from '../src/types.js';

function makeRun(overrides: Partial<AgentRun> = {}): AgentRun {
  return {
    id: 1,
    task_id: 'task-1',
    agent_role: 'engineer',
    engineer_id: 'eng-1',
    model: 'claude-sonnet-4-20250514',
    started_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    finished_at: null,
    status: 'running',
    input_tokens: 0,
    output_tokens: 0,
    error: null,
    ...overrides,
  };
}

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    parent_id: null,
    campaign_id: null,
    state: 'EXECUTING',
    description: 'Test task',
    priority: 'medium',
    assigned_agent: 'engineer',
    assigned_engineer_id: 'eng-1',
    intent_type: null,
    reject_count_tactical: 0,
    reject_count_strategic: 0,
    rubric: null,
    artifacts_path: null,
    error_count: 0,
    override_skip_gate: 0,
    source_channel: null,
    source_chat_id: null,
    context_chain: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

describe('Medic', () => {
  let medic: Medic;

  beforeEach(() => {
    medic = new Medic();
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    medic.stop();
    vi.useRealTimers();
  });

  describe('stall detection', () => {
    it('detects stalled tasks (updated_at > STALL_THRESHOLD_MS ago)', async () => {
      const stalledTime = new Date(Date.now() - 300_000).toISOString(); // 5 min ago
      const stalledRun = makeRun({ updated_at: stalledTime });
      vi.mocked(getActiveRuns).mockReturnValue([stalledRun]);
      vi.mocked(getRecentRunsForTask).mockReturnValue([stalledRun]);
      vi.mocked(getTaskById).mockReturnValue(makeTask());

      await medic.scan();

      // Should have attempted recovery (writeFlowLog or updateTaskState called)
      expect(writeFlowLog).toHaveBeenCalled();
    });

    it('does not flag fresh tasks as stalled', async () => {
      vi.mocked(getActiveRuns).mockReturnValue([
        makeRun({ updated_at: new Date().toISOString() }),
      ]);

      await medic.scan();

      expect(writeFlowLog).not.toHaveBeenCalled();
      expect(updateTaskState).not.toHaveBeenCalled();
    });

    it('handles empty active runs', async () => {
      vi.mocked(getActiveRuns).mockReturnValue([]);
      await medic.scan();
      expect(getTaskById).not.toHaveBeenCalled();
    });
  });

  describe('determineRecovery()', () => {
    const run = makeRun();

    it('returns retry for 0 failures', () => {
      expect(medic.determineRecovery(run, 0)).toBe('retry');
    });

    it('returns reassign for 1-2 failures', () => {
      expect(medic.determineRecovery(run, 1)).toBe('reassign');
      expect(medic.determineRecovery(run, 2)).toBe('reassign');
    });

    it('returns escalate for 3-4 failures', () => {
      expect(medic.determineRecovery(run, 3)).toBe('escalate');
      expect(medic.determineRecovery(run, 4)).toBe('escalate');
    });

    it('returns manual_required for 5+ failures', () => {
      expect(medic.determineRecovery(run, 5)).toBe('manual_required');
      expect(medic.determineRecovery(run, 10)).toBe('manual_required');
    });
  });

  describe('executeRecovery()', () => {
    it('handles retry action by resetting error_count and logging flow', async () => {
      vi.mocked(getTaskById).mockReturnValue(makeTask());

      await medic.executeRecovery('task-1', 'retry');

      expect(updateTask).toHaveBeenCalledWith('task-1', { error_count: 0 });
      expect(writeFlowLog).toHaveBeenCalledOnce();
      const logArg = vi.mocked(writeFlowLog).mock.calls[0]![0];
      expect(logArg.reason).toContain('retry');
    });

    it('handles reassign action by resetting error_count, clearing engineer, and logging flow', async () => {
      vi.mocked(getTaskById).mockReturnValue(makeTask());

      await medic.executeRecovery('task-1', 'reassign');

      expect(updateTask).toHaveBeenCalledWith('task-1', { error_count: 0, assigned_engineer_id: null });
      expect(writeFlowLog).toHaveBeenCalledOnce();
      const logArg = vi.mocked(writeFlowLog).mock.calls[0]![0];
      expect(logArg.reason).toContain('reassign');
    });

    it('handles escalate action by transitioning to FAILED', async () => {
      vi.mocked(getTaskById).mockReturnValue(makeTask());

      await medic.executeRecovery('task-1', 'escalate');

      expect(updateTaskState).toHaveBeenCalledWith(
        'task-1',
        'FAILED',
        'engineer',
        expect.stringContaining('escalated'),
      );
    });

    it('handles manual_required action by transitioning to PAUSED', async () => {
      vi.mocked(getTaskById).mockReturnValue(makeTask());

      await medic.executeRecovery('task-1', 'manual_required');

      expect(updateTaskState).toHaveBeenCalledWith(
        'task-1',
        'PAUSED',
        'engineer',
        expect.stringContaining('manual_required'),
      );
    });

    it('handles missing task gracefully', async () => {
      vi.mocked(getTaskById).mockReturnValue(undefined);

      // Should not throw
      await medic.executeRecovery('nonexistent', 'retry');

      expect(writeFlowLog).not.toHaveBeenCalled();
      expect(updateTaskState).not.toHaveBeenCalled();
    });
  });

  describe('scan with consecutive failures', () => {
    it('triggers recovery when 5+ consecutive errors detected', async () => {
      // Active run: currently running (this is what getActiveRuns returns)
      const activeRun = makeRun({
        id: 6,
        status: 'running',
        updated_at: new Date().toISOString(), // not stalled
      });

      // Historical runs: 5 consecutive errors (returned by getRecentRunsForTask)
      const errorRuns: AgentRun[] = Array.from({ length: 5 }, (_, i) =>
        makeRun({
          id: i + 1,
          status: 'error',
          error: 'test error',
          started_at: new Date(Date.now() - (5 - i) * 1000).toISOString(),
          updated_at: new Date(Date.now() - (5 - i) * 1000).toISOString(),
        }),
      );

      vi.mocked(getActiveRuns).mockReturnValue([activeRun]);
      vi.mocked(getRecentRunsForTask).mockReturnValue([activeRun, ...errorRuns]);
      vi.mocked(getTaskById).mockReturnValue(makeTask());

      await medic.scan();

      // manual_required should be triggered (5 failures → PAUSED)
      expect(updateTaskState).toHaveBeenCalled();
    });
  });

  describe('start/stop', () => {
    it('starts and stops periodic scanning', () => {
      medic.start(5000);
      // Should be running (no throw on double stop)
      medic.stop();
      medic.stop(); // idempotent
    });

    it('does not start twice', () => {
      medic.start(5000);
      medic.start(5000); // should warn, not crash
      medic.stop();
    });
  });
});
