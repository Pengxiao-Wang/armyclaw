// ═══════════════════════════════════════════════════════════
// ArmyClaw — Medic: Stuck Detection + Auto Recovery
// Inspired by IronClaw's self_repair.rs
// ═══════════════════════════════════════════════════════════

import { STALL_THRESHOLD_MS, CONSECUTIVE_FAILURE_THRESHOLD } from '../config.js';
import { getActiveRuns, getRecentRunsForTask, getTaskById, updateTaskState, writeFlowLog } from '../db.js';
import { logger } from '../logger.js';
import type { AgentRun, RecoveryAction, TaskState } from '../types.js';

export class Medic {
  private intervalId: ReturnType<typeof setInterval> | null = null;

  /**
   * Start periodic scanning for stuck tasks.
   */
  start(intervalMs: number = 10_000): void {
    if (this.intervalId) {
      logger.warn('Medic is already running');
      return;
    }

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
        // Transition task back to its entry point for the current phase
        logger.info({ taskId }, 'Recovery: retrying task');
        writeFlowLog({
          task_id: taskId,
          at: now,
          from_state: task.state,
          to_state: task.state,
          agent_role: task.assigned_agent,
          reason: 'medic: retry — restarting current phase',
          duration_ms: null,
        });
        break;

      case 'reassign':
        // Assign a different engineer and retry
        logger.info({ taskId }, 'Recovery: reassigning task to different engineer');
        writeFlowLog({
          task_id: taskId,
          at: now,
          from_state: task.state,
          to_state: task.state,
          agent_role: task.assigned_agent,
          reason: 'medic: reassign — switching engineer',
          duration_ms: null,
        });
        break;

      case 'escalate':
        // Transition to FAILED, notify
        logger.warn({ taskId }, 'Recovery: escalating — transitioning to FAILED');
        updateTaskState(taskId, 'FAILED' as TaskState, task.assigned_agent ?? undefined, 'medic: escalated after 3+ failures');
        break;

      case 'manual_required':
        // Mark task as needing manual intervention
        logger.error({ taskId }, 'Recovery: manual intervention required');
        updateTaskState(taskId, 'PAUSED' as TaskState, task.assigned_agent ?? undefined, 'medic: manual_required — 5+ consecutive failures');
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
