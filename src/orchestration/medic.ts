// ═══════════════════════════════════════════════════════════
// ArmyClaw — Medic: Stuck Detection + Auto Recovery
//
// Responsibility split:
//   Engineers → process runner owns the timeout (hard kill).
//   Non-engineers (adjutant, chief_of_staff, operations, inspector)
//     → medic is the primary stall detector (LLM API calls).
//   Medic also catches consecutive failures for all roles.
// ═══════════════════════════════════════════════════════════

import { CONSECUTIVE_FAILURE_THRESHOLD, LLM_CALL_STALL_THRESHOLDS, LLM_CALL_STALL_DEFAULT_MS } from '../config.js';
import { getActiveRuns, getRecentRunsForTask, getTaskById, updateTask, writeFlowLog } from '../kernel/db.js';
import { QueuePriority } from './herald/queue.js';
import { transition } from './herald/state-machine.js';
import { logger } from '../logger.js';
import { TaskState } from '../types.js';
import type { Task, AgentRun, RecoveryAction } from '../types.js';

/**
 * Get the stall threshold for a NON-engineer task (LLM API call timeout).
 * Engineers are excluded — process runner handles their timeout.
 */
function getLLMStallThresholdMs(task: Task): number {
  if (task.complexity && LLM_CALL_STALL_THRESHOLDS[task.complexity]) {
    return LLM_CALL_STALL_THRESHOLDS[task.complexity];
  }
  return LLM_CALL_STALL_DEFAULT_MS;
}

export class Medic {
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private enqueue: ((taskId: string, priority: QueuePriority) => void) | null = null;

  start(intervalMs: number = 10_000, enqueue?: (taskId: string, priority: QueuePriority) => void): void {
    if (this.intervalId) { logger.warn('Medic already running'); return; }
    this.enqueue = enqueue ?? null;
    logger.info({ intervalMs }, 'Medic started');
    this.intervalId = setInterval(() => {
      this.scan().catch((err) => logger.error({ error: String(err) }, 'Medic scan error'));
    }, intervalMs);
  }

  stop(): void {
    if (this.intervalId) { clearInterval(this.intervalId); this.intervalId = null; logger.info('Medic stopped'); }
  }

  async scan(): Promise<void> {
    const activeRuns = getActiveRuns();
    if (activeRuns.length === 0) return;
    const now = Date.now();

    for (const run of activeRuns) {
      const task = getTaskById(run.task_id);
      if (!task) continue;

      // Engineers: process runner owns the timeout. Medic only checks consecutive failures.
      if (run.agent_role === 'engineer') {
        const finishedRuns = getRecentRunsForTask(run.task_id).filter((r) => r.status !== 'running');
        const failureCount = this.countConsecutiveErrors(finishedRuns);
        if (failureCount >= CONSECUTIVE_FAILURE_THRESHOLD) {
          logger.warn({ taskId: run.task_id, failureCount }, 'Engineer consecutive failure threshold reached');
          await this.executeRecovery(run.task_id, this.determineRecovery(run, failureCount));
        }
        continue;
      }

      // Non-engineers: medic is the primary stall detector (LLM API calls)
      const stalledMs = now - new Date(run.updated_at).getTime();
      const thresholdMs = getLLMStallThresholdMs(task);
      const finishedRuns = getRecentRunsForTask(run.task_id).filter((r) => r.status !== 'running');
      const failureCount = this.countConsecutiveErrors(finishedRuns);

      if (stalledMs > thresholdMs) {
        logger.warn(
          { taskId: run.task_id, agentRole: run.agent_role, stalledMs, thresholdMs, complexity: task.complexity },
          'Stalled LLM call detected',
        );
        const action = this.determineRecovery(run, failureCount);
        logger.info({ taskId: run.task_id, action, failureCount }, 'Executing recovery');
        await this.executeRecovery(run.task_id, action);
        continue;
      }

      if (failureCount >= CONSECUTIVE_FAILURE_THRESHOLD) {
        logger.warn({ taskId: run.task_id, failureCount }, 'Consecutive failure threshold reached');
        await this.executeRecovery(run.task_id, this.determineRecovery(run, failureCount));
      }
    }
  }

  determineRecovery(_run: AgentRun, failureCount: number): RecoveryAction {
    if (failureCount >= 5) return 'manual_required';
    if (failureCount >= 3) return 'escalate';
    if (failureCount >= 1) return 'reassign';
    return 'retry';
  }

  async executeRecovery(taskId: string, action: RecoveryAction): Promise<void> {
    const task = getTaskById(taskId);
    if (!task) { logger.error({ taskId }, 'Cannot recover: task not found'); return; }
    const now = new Date().toISOString();

    switch (action) {
      case 'retry':
        logger.info({ taskId }, 'Recovery: retry');
        updateTask(taskId, { error_count: 0 });
        writeFlowLog({ task_id: taskId, at: now, from_state: task.state, to_state: task.state, agent_role: task.assigned_agent, reason: 'medic: retry', duration_ms: null });
        this.enqueue?.(taskId, QueuePriority.NEW_TASK);
        break;
      case 'reassign':
        logger.info({ taskId }, 'Recovery: reassign');
        updateTask(taskId, { error_count: 0, assigned_engineer_id: null });
        writeFlowLog({ task_id: taskId, at: now, from_state: task.state, to_state: task.state, agent_role: task.assigned_agent, reason: 'medic: reassign', duration_ms: null });
        this.enqueue?.(taskId, QueuePriority.NEW_TASK);
        break;
      case 'escalate':
        logger.warn({ taskId }, 'Recovery: escalate → FAILED');
        transition(taskId, TaskState.FAILED, task.assigned_agent ?? undefined, 'medic: escalated after 3+ failures');
        break;
      case 'manual_required':
        logger.error({ taskId }, 'Recovery: manual required → PAUSED');
        transition(taskId, TaskState.PAUSED, task.assigned_agent ?? undefined, 'medic: manual_required — 5+ failures');
        break;
    }
  }

  private countConsecutiveErrors(runs: AgentRun[]): number {
    const sorted = [...runs].sort((a, b) => new Date(b.started_at).getTime() - new Date(a.started_at).getTime());
    let count = 0;
    for (const run of sorted) {
      if (run.status === 'error') count++;
      else break;
    }
    return count;
  }
}
