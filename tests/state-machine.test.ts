import { describe, it, expect, beforeEach } from 'vitest';
import {
  canTransition,
  getValidNextStates,
  transition,
  routeReject,
  routeRejectByLevel,
} from '../src/herald/state-machine.js';
import {
  _initTestDatabase,
  createTask,
  getTaskById,
  getFlowLog,
} from '../src/db.js';
import { TaskState, RejectLevel, AgentRole, TaskPriority } from '../src/types.js';

function makeTask(id: string, state: TaskState = TaskState.RECEIVED) {
  return createTask({
    id,
    parent_id: null,
    campaign_id: null,
    state,
    description: 'Test task',
    priority: TaskPriority.MEDIUM,
    assigned_agent: null,
    assigned_engineer_id: null,
    intent_type: null,
    reject_count_tactical: 0,
    reject_count_strategic: 0,
    rubric: null,
    artifacts_path: null,
    override_skip_gate: 0,
  });
}

beforeEach(() => {
  _initTestDatabase();
});

describe('canTransition', () => {
  it('should allow valid forward transitions', () => {
    expect(canTransition(TaskState.RECEIVED, TaskState.SPLITTING)).toBe(true);
    expect(canTransition(TaskState.SPLITTING, TaskState.PLANNING)).toBe(true);
    expect(canTransition(TaskState.SPLITTING, TaskState.DISPATCHING)).toBe(true);
    expect(canTransition(TaskState.PLANNING, TaskState.GATE1_REVIEW)).toBe(true);
    expect(canTransition(TaskState.GATE1_REVIEW, TaskState.DISPATCHING)).toBe(true);
    expect(canTransition(TaskState.DISPATCHING, TaskState.EXECUTING)).toBe(true);
    expect(canTransition(TaskState.EXECUTING, TaskState.GATE2_REVIEW)).toBe(true);
    expect(canTransition(TaskState.GATE2_REVIEW, TaskState.DELIVERING)).toBe(true);
    expect(canTransition(TaskState.DELIVERING, TaskState.DONE)).toBe(true);
  });

  it('should allow FAILED transitions', () => {
    expect(canTransition(TaskState.SPLITTING, TaskState.FAILED)).toBe(true);
    expect(canTransition(TaskState.PLANNING, TaskState.FAILED)).toBe(true);
    expect(canTransition(TaskState.GATE1_REVIEW, TaskState.FAILED)).toBe(true);
    expect(canTransition(TaskState.DISPATCHING, TaskState.FAILED)).toBe(true);
    expect(canTransition(TaskState.EXECUTING, TaskState.FAILED)).toBe(true);
    expect(canTransition(TaskState.GATE2_REVIEW, TaskState.FAILED)).toBe(true);
    expect(canTransition(TaskState.DELIVERING, TaskState.FAILED)).toBe(true);
  });

  it('should allow retry from FAILED', () => {
    expect(canTransition(TaskState.FAILED, TaskState.RECEIVED)).toBe(true);
  });

  it('should reject invalid transitions', () => {
    expect(canTransition(TaskState.RECEIVED, TaskState.DONE)).toBe(false);
    expect(canTransition(TaskState.RECEIVED, TaskState.EXECUTING)).toBe(false);
    expect(canTransition(TaskState.DONE, TaskState.RECEIVED)).toBe(false);
    expect(canTransition(TaskState.CANCELLED, TaskState.RECEIVED)).toBe(false);
  });

  it('should allow reject routing in GATE1_REVIEW', () => {
    expect(canTransition(TaskState.GATE1_REVIEW, TaskState.PLANNING)).toBe(true);
  });

  it('should allow reject routing in GATE2_REVIEW', () => {
    expect(canTransition(TaskState.GATE2_REVIEW, TaskState.DISPATCHING)).toBe(true);
    expect(canTransition(TaskState.GATE2_REVIEW, TaskState.PLANNING)).toBe(true);
  });

  it('should allow PAUSED from any non-terminal state', () => {
    expect(canTransition(TaskState.RECEIVED, TaskState.PAUSED)).toBe(true);
    expect(canTransition(TaskState.SPLITTING, TaskState.PAUSED)).toBe(true);
    expect(canTransition(TaskState.PLANNING, TaskState.PAUSED)).toBe(true);
    expect(canTransition(TaskState.EXECUTING, TaskState.PAUSED)).toBe(true);
    expect(canTransition(TaskState.DELIVERING, TaskState.PAUSED)).toBe(true);
  });

  it('should not allow PAUSED from terminal states', () => {
    expect(canTransition(TaskState.DONE, TaskState.PAUSED)).toBe(false);
    expect(canTransition(TaskState.CANCELLED, TaskState.PAUSED)).toBe(false);
    expect(canTransition(TaskState.FAILED, TaskState.PAUSED)).toBe(false);
  });

  it('should not allow PAUSED from PAUSED', () => {
    expect(canTransition(TaskState.PAUSED, TaskState.PAUSED)).toBe(false);
  });

  it('should allow CANCELLED from any non-terminal state', () => {
    expect(canTransition(TaskState.RECEIVED, TaskState.CANCELLED)).toBe(true);
    expect(canTransition(TaskState.EXECUTING, TaskState.CANCELLED)).toBe(true);
    expect(canTransition(TaskState.PAUSED, TaskState.CANCELLED)).toBe(true);
  });

  it('should not allow CANCELLED from terminal states', () => {
    expect(canTransition(TaskState.DONE, TaskState.CANCELLED)).toBe(false);
    expect(canTransition(TaskState.CANCELLED, TaskState.CANCELLED)).toBe(false);
  });

  it('should allow resume from PAUSED', () => {
    expect(canTransition(TaskState.PAUSED, TaskState.RECEIVED)).toBe(true);
    expect(canTransition(TaskState.PAUSED, TaskState.SPLITTING)).toBe(true);
    expect(canTransition(TaskState.PAUSED, TaskState.PLANNING)).toBe(true);
    expect(canTransition(TaskState.PAUSED, TaskState.DISPATCHING)).toBe(true);
    expect(canTransition(TaskState.PAUSED, TaskState.EXECUTING)).toBe(true);
  });
});

describe('getValidNextStates', () => {
  it('should return correct next states for RECEIVED', () => {
    const states = getValidNextStates(TaskState.RECEIVED);
    expect(states).toContain(TaskState.SPLITTING);
    expect(states).toContain(TaskState.PAUSED);
    expect(states).toContain(TaskState.CANCELLED);
  });

  it('should return empty array for DONE', () => {
    const states = getValidNextStates(TaskState.DONE);
    expect(states).toEqual([]);
  });

  it('should return empty array for CANCELLED', () => {
    const states = getValidNextStates(TaskState.CANCELLED);
    expect(states).toEqual([]);
  });

  it('should include resume states for PAUSED', () => {
    const states = getValidNextStates(TaskState.PAUSED);
    expect(states).toContain(TaskState.RECEIVED);
    expect(states).toContain(TaskState.EXECUTING);
    expect(states).toContain(TaskState.CANCELLED);
  });
});

describe('transition', () => {
  it('should transition and write flow_log', () => {
    makeTask('task-1', TaskState.RECEIVED);

    transition('task-1', TaskState.SPLITTING, AgentRole.ADJUTANT, 'starting');

    const task = getTaskById('task-1')!;
    expect(task.state).toBe('SPLITTING');

    const logs = getFlowLog('task-1');
    const lastLog = logs[logs.length - 1];
    expect(lastLog.from_state).toBe('RECEIVED');
    expect(lastLog.to_state).toBe('SPLITTING');
    expect(lastLog.agent_role).toBe('adjutant');
    expect(lastLog.reason).toBe('starting');
  });

  it('should throw on invalid transition', () => {
    makeTask('task-1', TaskState.RECEIVED);

    expect(() => transition('task-1', TaskState.DONE)).toThrow('Invalid transition');
  });

  it('should throw on missing task', () => {
    expect(() => transition('nope', TaskState.SPLITTING)).toThrow('Task not found');
  });

  it('should allow pausing a running task', () => {
    makeTask('task-1', TaskState.EXECUTING);

    transition('task-1', TaskState.PAUSED, undefined, 'user paused');

    const task = getTaskById('task-1')!;
    expect(task.state).toBe('PAUSED');
  });

  it('should allow resuming a paused task', () => {
    makeTask('task-1', TaskState.PAUSED);

    transition('task-1', TaskState.EXECUTING, undefined, 'resumed');

    const task = getTaskById('task-1')!;
    expect(task.state).toBe('EXECUTING');
  });

  it('should allow cancelling a task', () => {
    makeTask('task-1', TaskState.PLANNING);

    transition('task-1', TaskState.CANCELLED, undefined, 'user cancelled');

    const task = getTaskById('task-1')!;
    expect(task.state).toBe('CANCELLED');
  });
});

describe('routeRejectByLevel', () => {
  it('should route tactical to DISPATCHING', () => {
    expect(routeRejectByLevel(RejectLevel.TACTICAL)).toBe(TaskState.DISPATCHING);
  });

  it('should route strategic to PLANNING', () => {
    expect(routeRejectByLevel(RejectLevel.STRATEGIC)).toBe(TaskState.PLANNING);
  });

  it('should route critical to FAILED', () => {
    expect(routeRejectByLevel(RejectLevel.CRITICAL)).toBe(TaskState.FAILED);
  });
});

describe('routeReject — circuit breaker', () => {
  it('should route tactical reject normally', () => {
    makeTask('task-1', TaskState.GATE2_REVIEW);

    const target = routeReject('task-1', RejectLevel.TACTICAL);
    expect(target).toBe(TaskState.DISPATCHING);

    const task = getTaskById('task-1')!;
    expect(task.reject_count_tactical).toBe(1);
  });

  it('should escalate tactical to strategic after threshold', () => {
    // Create task with 2 tactical rejects already (threshold is 3)
    createTask({
      id: 'task-1', parent_id: null, campaign_id: null,
      state: TaskState.GATE2_REVIEW, description: 'Test', priority: TaskPriority.MEDIUM,
      assigned_agent: null, assigned_engineer_id: null, intent_type: null,
      reject_count_tactical: 2,  // one more will trigger escalation
      reject_count_strategic: 0,
      rubric: null, artifacts_path: null, override_skip_gate: 0,
    });

    const target = routeReject('task-1', RejectLevel.TACTICAL);
    expect(target).toBe(TaskState.PLANNING); // escalated to strategic → PLANNING
  });

  it('should escalate strategic to critical after threshold', () => {
    createTask({
      id: 'task-1', parent_id: null, campaign_id: null,
      state: TaskState.GATE2_REVIEW, description: 'Test', priority: TaskPriority.MEDIUM,
      assigned_agent: null, assigned_engineer_id: null, intent_type: null,
      reject_count_tactical: 0,
      reject_count_strategic: 1,  // one more will trigger escalation (threshold is 2)
      rubric: null, artifacts_path: null, override_skip_gate: 0,
    });

    const target = routeReject('task-1', RejectLevel.STRATEGIC);
    expect(target).toBe(TaskState.FAILED); // escalated to critical → FAILED
  });

  it('should double-escalate tactical → strategic → critical', () => {
    createTask({
      id: 'task-1', parent_id: null, campaign_id: null,
      state: TaskState.GATE2_REVIEW, description: 'Test', priority: TaskPriority.MEDIUM,
      assigned_agent: null, assigned_engineer_id: null, intent_type: null,
      reject_count_tactical: 2,
      reject_count_strategic: 1,  // tactical→strategic escalation also increments strategic count
      rubric: null, artifacts_path: null, override_skip_gate: 0,
    });

    const target = routeReject('task-1', RejectLevel.TACTICAL);
    // tactical count 2→3 >= threshold(3) → escalates to strategic
    // strategic count 1→2 >= threshold(2) → escalates to critical → FAILED
    expect(target).toBe(TaskState.FAILED);
  });

  it('should throw on missing task', () => {
    expect(() => routeReject('nope', RejectLevel.TACTICAL)).toThrow('Task not found');
  });
});
