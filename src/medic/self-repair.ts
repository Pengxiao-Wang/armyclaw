// ═══════════════════════════════════════════════════════════
// ArmyClaw — Medic: Stuck Detection + Auto Recovery
// Inspired by IronClaw's self_repair.rs
// ═══════════════════════════════════════════════════════════

import { STALL_THRESHOLD_MS, CONSECUTIVE_FAILURE_THRESHOLD } from '../config.js';
import { getActiveRuns, getRecentRunsForTask, getTaskById, updateTask, writeFlowLog } from '../db.js';
import { QueuePriority } from '../herald/queue.js';
import { transition } from '../herald/state-machine.js';
import { logger } from '../logger.js';
import { TaskState } from '../types.js';
import type { AgentRun, RecoveryAction } from '../types.js';

export class Medic {
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private enqueue: ((taskId: string, priority: QueuePriority) => void) | null = null;

  /**
   * Start periodic scanning for stuck tasks.
   * @param enqueue — callback to re-enqueue recovered tasks into the processing queue
   */
  start(intervalMs: number = 10_000, enqueue?: (taskId: string, priority: QueuePriority) => void): void {
    if (this.intervalId) {
      logger.warn('Medic is already running');
      return;
    }

    this.enqueue = enqueue ?? null;
    logger.info({ intervalMs }, 'Medic started — scanning for stuck tasks');

    this.intervalId = setInterval(() => {
      this.scan().catch((err) => {
        logger.error({ error: String(err) }, 'Medic scan error');
      });
    }, intervalMs);
  }

  /**
   * Stop periodic scanning.
   */
  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      logger.info('Medic stopped');
    }
  }

  /**
   * Run a single scan pass:
   * 1. Get all active agent_runs from DB
   * 2. Check for stalled tasks (updated_at too old)
   * 3. Check for consecutive failures
   * 4. Determine and execute recovery action
   */
  async scan(): Promise<void> {
    const activeRuns = getActiveRuns();
    if (activeRuns.length === 0) return;

    const now = Date.now();

    for (const run of activeRuns) {
      const updatedAt = new Date(run.updated_at).getTime();
      const stalledMs = now - updatedAt;

      // Get recent runs for this task (all statuses, not just 'running')
      const recentRuns = getRecentRunsForTask(run.task_id);
      // Filter out 'running' entries so countConsecutiveErrors works correctly
      const finishedRuns = recentRuns.filter((r) => r.status !== 'running');
      const failureCount = this.countConsecutiveErrors(finishedRuns);

      // Check 1: stalled task (no update for STALL_THRESHOLD_MS)
      if (stalledMs > STALL_THRESHOLD_MS) {
        logger.warn(
          { taskId: run.task_id, agentRole: run.agent_role, stalledMs },
          'Stalled task detected',
        );

        const action = this.determineRecovery(run, failureCount);

        logger.info(
          { taskId: run.task_id, action, failureCount },
          'Executing recovery action',
        );

        await this.executeRecovery(run.task_id, action);
        continue; // Don't double-trigger on same run
      }

      // Check 2: consecutive failures without stalling
      if (failureCount >= CONSECUTIVE_FAILURE_THRESHOLD) {
        logger.warn(
          { taskId: run.task_id, failureCount },
          'Consecutive failure threshold reached',
        );

        const action = this.determineRecovery(run, failureCount);
        await this.executeRecovery(run.task_id, action);
      }
    }
  }

  /**
   * Determine the appropriate recovery action based on failure count.
   */
  determineRecovery(run: AgentRun, failureCount: number): RecoveryAction {
    if (failureCount >= 5) return 'manual_required';
    if (failureCount >= 3) return 'escalate';
    if (failureCount >= 1) return 'reassign';
    return 'retry';
  }

  /**
   * Execute a recovery action for a task.
   */
  async executeRecovery(taskId: string, action: RecoveryAction): Promise<void> {
    const task = getTaskById(taskId);
    if (!task) {
      logger.error({ taskId }, 'Cannot recover: task not found');
      return;
    }

    const now = new Date().toISOString();

    switch (action) {
      case 'retry':
        // Reset error count and re-enqueue for another attempt
        logger.info({ taskId }, 'Recovery: retrying task');
        updateTask(taskId, { error_count: 0 });
        writeFlowLog({
          task_id: taskId,
          at: now,
          from_state: task.state,
          to_state: task.state,
          agent_role: task.assigned_agent,
          reason: 'medic: retry — resetting error count and re-enqueueing',
          duration_ms: null,
        });
        this.enqueue?.(taskId, QueuePriority.NEW_TASK);
        break;

      case 'reassign':
        // Reset error count, clear engineer assignment, and re-enqueue
        logger.info({ taskId }, 'Recovery: reassigning task to different engineer');
        updateTask(taskId, { error_count: 0, assigned_engineer_id: null });
        writeFlowLog({
          task_id: taskId,
          at: now,
          from_state: task.state,
          to_state: task.state,
          agent_role: task.assigned_agent,
          reason: 'medic: reassign — switching engineer, resetting errors',
          duration_ms: null,
        });
        this.enqueue?.(taskId, QueuePriority.NEW_TASK);
        break;

      case 'escalate':
        // Transition to FAILED via state machine (triggers terminal hook for parent notification)
        logger.warn({ taskId }, 'Recovery: escalating — transitioning to FAILED');
        transition(taskId, TaskState.FAILED, task.assigned_agent ?? undefined, 'medic: escalated after 3+ failures');
        break;

      case 'manual_required':
        // Mark task as needing manual intervention via state machine
        logger.error({ taskId }, 'Recovery: manual intervention required');
        transition(taskId, TaskState.PAUSED, task.assigned_agent ?? undefined, 'medic: manual_required — 5+ consecutive failures');
        break;
    }
  }

  /**
   * Count consecutive error runs for a task (from most recent backwards).
   */
  private countConsecutiveErrors(runs: AgentRun[]): number {
    // Sort by started_at descending to check most recent first
    const sorted = [...runs].sort(
      (a, b) => new Date(b.started_at).getTime() - new Date(a.started_at).getTime(),
    );

    let count = 0;
    for (const run of sorted) {
      if (run.status === 'error') {
        count++;
      } else {
        break;
      }
    }
    return count;
  }
}
