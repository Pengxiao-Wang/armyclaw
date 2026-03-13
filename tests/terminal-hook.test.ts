import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  transition,
  setTerminalHook,
  clearTerminalHook,
} from '../src/herald/state-machine.js';
import {
  _initTestDatabase,
  createTask,
  getTaskById,
  updateTask,
} from '../src/db.js';
import { TaskState, TaskPriority } from '../src/types.js';
import type { AgentRole } from '../src/types.js';

function makeTask(
  id: string,
  state: TaskState = TaskState.RECEIVED,
  parentId: string | null = null,
) {
  return createTask({
    id,
    parent_id: parentId,
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
  clearTerminalHook();
});

afterEach(() => {
  clearTerminalHook();
});

describe('Terminal Hook', () => {
  it('should fire hook on transition to DONE', () => {
    const calls: { taskId: string; parentId: string }[] = [];
    setTerminalHook((taskId, parentId) => calls.push({ taskId, parentId }));

    makeTask('child-1', TaskState.DELIVERING, 'parent-1');

    transition('child-1', TaskState.DONE, 'operations' as AgentRole, 'completed');

    expect(calls).toHaveLength(1);
    expect(calls[0].taskId).toBe('child-1');
    expect(calls[0].parentId).toBe('parent-1');
  });

  it('should fire hook on transition to FAILED', () => {
    const calls: { taskId: string; parentId: string }[] = [];
    setTerminalHook((taskId, parentId) => calls.push({ taskId, parentId }));

    makeTask('child-1', TaskState.EXECUTING, 'parent-1');

    transition('child-1', TaskState.FAILED, 'engineer' as AgentRole, 'error');

    expect(calls).toHaveLength(1);
    expect(calls[0].taskId).toBe('child-1');
    expect(calls[0].parentId).toBe('parent-1');
  });

  it('should fire hook on transition to CANCELLED', () => {
    const calls: { taskId: string; parentId: string }[] = [];
    setTerminalHook((taskId, parentId) => calls.push({ taskId, parentId }));

    makeTask('child-1', TaskState.PLANNING, 'parent-1');

    transition('child-1', TaskState.CANCELLED, undefined, 'user cancelled');

    expect(calls).toHaveLength(1);
    expect(calls[0].taskId).toBe('child-1');
    expect(calls[0].parentId).toBe('parent-1');
  });

  it('should NOT fire hook when task has no parent_id', () => {
    const calls: { taskId: string; parentId: string }[] = [];
    setTerminalHook((taskId, parentId) => calls.push({ taskId, parentId }));

    makeTask('root-task', TaskState.DELIVERING, null); // no parent

    transition('root-task', TaskState.DONE, 'operations' as AgentRole, 'done');

    expect(calls).toHaveLength(0);
  });

  it('should NOT fire hook on non-terminal transitions', () => {
    const calls: { taskId: string; parentId: string }[] = [];
    setTerminalHook((taskId, parentId) => calls.push({ taskId, parentId }));

    makeTask('child-1', TaskState.RECEIVED, 'parent-1');

    transition('child-1', TaskState.SPLITTING, 'adjutant' as AgentRole, 'start');

    expect(calls).toHaveLength(0);
  });

  it('should NOT fire hook when no hook is registered', () => {
    // No hook set — should not throw
    makeTask('child-1', TaskState.DELIVERING, 'parent-1');

    expect(() => {
      transition('child-1', TaskState.DONE, 'operations' as AgentRole, 'done');
    }).not.toThrow();

    const task = getTaskById('child-1')!;
    expect(task.state).toBe('DONE');
  });

  it('should handle multiple subtasks completing', () => {
    const calls: { taskId: string; parentId: string }[] = [];
    setTerminalHook((taskId, parentId) => calls.push({ taskId, parentId }));

    makeTask('child-1', TaskState.DELIVERING, 'parent-1');
    makeTask('child-2', TaskState.EXECUTING, 'parent-1');
    makeTask('child-3', TaskState.PLANNING, 'parent-1');

    transition('child-1', TaskState.DONE, 'engineer' as AgentRole, 'done');
    transition('child-2', TaskState.FAILED, 'engineer' as AgentRole, 'error');
    transition('child-3', TaskState.CANCELLED, undefined, 'cancelled');

    expect(calls).toHaveLength(3);
    expect(calls.every((c) => c.parentId === 'parent-1')).toBe(true);
    expect(calls.map((c) => c.taskId)).toEqual(['child-1', 'child-2', 'child-3']);
  });

  it('should clear hook with clearTerminalHook', () => {
    const calls: { taskId: string; parentId: string }[] = [];
    setTerminalHook((taskId, parentId) => calls.push({ taskId, parentId }));

    makeTask('child-1', TaskState.DELIVERING, 'parent-1');
    transition('child-1', TaskState.DONE, 'operations' as AgentRole, 'done');
    expect(calls).toHaveLength(1);

    clearTerminalHook();

    makeTask('child-2', TaskState.DELIVERING, 'parent-1');
    transition('child-2', TaskState.DONE, 'operations' as AgentRole, 'done');
    expect(calls).toHaveLength(1); // still 1 — hook was cleared
  });

  it('should work with checkSubtaskCompletion pattern', () => {
    // Simulate the real HQ pattern: hook checks if all siblings are done
    const completedParents: string[] = [];

    setTerminalHook((_childId, parentId) => {
      // In real code, this would call checkSubtaskCompletion
      // Here we just simulate: if parent has no non-terminal children, it's complete
      completedParents.push(parentId);
    });

    // Parent with 2 subtasks
    makeTask('parent-1', TaskState.EXECUTING, null);
    makeTask('sub-1', TaskState.DELIVERING, 'parent-1');
    makeTask('sub-2', TaskState.DELIVERING, 'parent-1');

    // First subtask completes
    transition('sub-1', TaskState.DONE, 'engineer' as AgentRole, 'done');
    expect(completedParents).toEqual(['parent-1']);

    // Second subtask completes
    transition('sub-2', TaskState.DONE, 'engineer' as AgentRole, 'done');
    expect(completedParents).toEqual(['parent-1', 'parent-1']);
  });

  it('should detect mixed success/failure in subtasks', () => {
    const hookResults: { taskId: string; parentId: string; finalState: string }[] = [];

    setTerminalHook((taskId, parentId) => {
      const task = getTaskById(taskId)!;
      hookResults.push({ taskId, parentId, finalState: task.state });
    });

    makeTask('parent-1', TaskState.EXECUTING, null);
    makeTask('sub-1', TaskState.DELIVERING, 'parent-1');
    makeTask('sub-2', TaskState.EXECUTING, 'parent-1');

    transition('sub-1', TaskState.DONE, 'engineer' as AgentRole, 'ok');
    transition('sub-2', TaskState.FAILED, 'engineer' as AgentRole, 'error');

    expect(hookResults).toHaveLength(2);
    expect(hookResults[0].finalState).toBe('DONE');
    expect(hookResults[1].finalState).toBe('FAILED');
  });
});
