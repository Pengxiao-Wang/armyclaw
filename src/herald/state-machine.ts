import {
  getTaskById,
  updateTaskState,
  updateTask,
  writeFlowLog,
} from '../db.js';
import {
  TaskState,
  RejectLevel,
  AgentRole,
} from '../types.js';
import type { Task } from '../types.js';
import {
  TACTICAL_TO_STRATEGIC_THRESHOLD,
  STRATEGIC_TO_CRITICAL_THRESHOLD,
} from '../config.js';
import { logger } from '../logger.js';

// ─── Valid Transitions ──────────────────────────────────────────

const VALID_TRANSITIONS: Record<TaskState, TaskState[]> = {
  RECEIVED: ['SPLITTING'],
  SPLITTING: ['PLANNING', 'DISPATCHING', 'EXECUTING', 'DONE', 'FAILED'],
  PLANNING: ['GATE1_REVIEW', 'DISPATCHING', 'EXECUTING', 'DELIVERING', 'FAILED'],
  GATE1_REVIEW: ['DISPATCHING', 'DELIVERING', 'PLANNING', 'FAILED'],
  DISPATCHING: ['EXECUTING', 'FAILED'],
  EXECUTING: ['GATE2_REVIEW', 'DELIVERING', 'FAILED'],
  GATE2_REVIEW: ['DELIVERING', 'DISPATCHING', 'PLANNING', 'FAILED'],
  DELIVERING: ['DONE', 'FAILED'],
  DONE: [],
  FAILED: ['RECEIVED'],
  CANCELLED: [],
  PAUSED: ['RECEIVED', 'SPLITTING', 'PLANNING', 'GATE1_REVIEW', 'DISPATCHING', 'EXECUTING', 'GATE2_REVIEW', 'DELIVERING'],
};

// Non-terminal states that can be paused or cancelled
const NON_TERMINAL_STATES: Set<TaskState> = new Set([
  TaskState.RECEIVED,
  TaskState.SPLITTING,
  TaskState.PLANNING,
  TaskState.GATE1_REVIEW,
  TaskState.DISPATCHING,
  TaskState.EXECUTING,
  TaskState.GATE2_REVIEW,
  TaskState.DELIVERING,
  TaskState.PAUSED,
]);

// ─── Terminal States ────────────────────────────────────────────

const TERMINAL_STATES: Set<TaskState> = new Set([
  TaskState.DONE,
  TaskState.FAILED,
  TaskState.CANCELLED,
]);

// ─── Terminal Hook ──────────────────────────────────────────────
// Called when any task enters a terminal state.
// HQ registers a listener to propagate subtask completion to parents.

type OnTerminalFn = (taskId: string, parentId: string) => void;
let _onTerminal: OnTerminalFn | null = null;

export function setTerminalHook(fn: OnTerminalFn): void {
  _onTerminal = fn;
}

export function clearTerminalHook(): void {
  _onTerminal = null;
}

// ─── Public API ─────────────────────────────────────────────────

/**
 * Check if a transition from one state to another is valid.
 */
export function canTransition(from: TaskState, to: TaskState): boolean {
  // Special case: any non-terminal state can transition to PAUSED
  if (to === TaskState.PAUSED && NON_TERMINAL_STATES.has(from) && from !== TaskState.PAUSED) {
    return true;
  }

  // Special case: any non-terminal state can transition to CANCELLED
  if (to === TaskState.CANCELLED && NON_TERMINAL_STATES.has(from)) {
    return true;
  }

  const allowed = VALID_TRANSITIONS[from];
  if (!allowed) return false;
  return allowed.includes(to);
}

/**
 * Get valid next states from the current state.
 */
export function getValidNextStates(from: TaskState): TaskState[] {
  const states = [...(VALID_TRANSITIONS[from] ?? [])];

  // Add PAUSED and CANCELLED for non-terminal states
  if (NON_TERMINAL_STATES.has(from) && from !== TaskState.PAUSED) {
    if (!states.includes(TaskState.PAUSED)) states.push(TaskState.PAUSED);
    if (!states.includes(TaskState.CANCELLED)) states.push(TaskState.CANCELLED);
  }
  if (from === TaskState.PAUSED && !states.includes(TaskState.CANCELLED)) {
    states.push(TaskState.CANCELLED);
  }

  return states;
}

/**
 * Execute a state transition. Validates the transition, updates the task,
 * and writes an immutable flow_log entry.
 *
 * Throws on invalid transition or missing task.
 */
export function transition(
  taskId: string,
  to: TaskState,
  agentRole?: AgentRole,
  reason?: string,
): void {
  const task = getTaskById(taskId);
  if (!task) {
    throw new Error(`Task not found: ${taskId}`);
  }

  if (!canTransition(task.state, to)) {
    throw new Error(
      `Invalid transition: ${task.state} → ${to} for task ${taskId}`,
    );
  }

  logger.info(
    { taskId, from: task.state, to, agent: agentRole, reason },
    'State transition',
  );

  updateTaskState(taskId, to, agentRole, reason);

  // Fire terminal hook — propagate subtask completion to parent
  if (TERMINAL_STATES.has(to) && task.parent_id && _onTerminal) {
    _onTerminal(taskId, task.parent_id);
  }
}

/**
 * Route a reject verdict to the appropriate target state based on reject level.
 * Implements circuit breaker: auto-upgrades after too many rejects at the same level.
 *
 * Returns the target state the task was transitioned to.
 */
export function routeReject(
  taskId: string,
  level: RejectLevel,
): TaskState {
  const task = getTaskById(taskId);
  if (!task) {
    throw new Error(`Task not found: ${taskId}`);
  }

  // Apply circuit breaker escalation
  let effectiveLevel = level;

  if (level === RejectLevel.TACTICAL) {
    const newCount = task.reject_count_tactical + 1;
    updateTask(taskId, { reject_count_tactical: newCount });

    if (newCount >= TACTICAL_TO_STRATEGIC_THRESHOLD) {
      logger.warn(
        { taskId, tacticalRejects: newCount, threshold: TACTICAL_TO_STRATEGIC_THRESHOLD },
        'Circuit breaker: tactical → strategic escalation',
      );
      effectiveLevel = RejectLevel.STRATEGIC;
    }
  }

  if (effectiveLevel === RejectLevel.STRATEGIC) {
    // Always increment strategic count — whether from direct strategic reject
    // or escalated from tactical. Otherwise escalation never reaches critical.
    const currentStrategic = task.reject_count_strategic + 1;
    updateTask(taskId, { reject_count_strategic: currentStrategic });

    if (currentStrategic >= STRATEGIC_TO_CRITICAL_THRESHOLD) {
      logger.warn(
        { taskId, strategicRejects: currentStrategic, threshold: STRATEGIC_TO_CRITICAL_THRESHOLD },
        'Circuit breaker: strategic → critical escalation',
      );
      effectiveLevel = RejectLevel.CRITICAL;
    }
  }

  const targetState = routeRejectByLevel(effectiveLevel);

  transition(
    taskId,
    targetState,
    AgentRole.INSPECTOR,
    `reject (${level}${effectiveLevel !== level ? ` → escalated to ${effectiveLevel}` : ''})`,
  );

  return targetState;
}

/**
 * Map a reject level to a target state.
 */
export function routeRejectByLevel(level: RejectLevel): TaskState {
  switch (level) {
    case RejectLevel.TACTICAL:
      return TaskState.DISPATCHING;
    case RejectLevel.STRATEGIC:
      return TaskState.PLANNING;
    case RejectLevel.CRITICAL:
      return TaskState.FAILED;
  }
}
