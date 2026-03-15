import { describe, it, expect } from 'vitest';
import {
  routeTask,
  matchTemplate,
  shouldSkipPlanning,
} from '../src/orchestration/herald/router.js';
import { routeRejectByLevel } from '../src/orchestration/herald/state-machine.js';
import { TaskState, AgentRole, RejectLevel, TaskPriority } from '../src/types.js';
import type { Task, TaskTemplate } from '../src/types.js';

function makeTask(state: TaskState, description = 'Test task'): Task {
  return {
    id: 'task-1',
    parent_id: null,
    campaign_id: null,
    state,
    description,
    priority: TaskPriority.MEDIUM,
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
    delivery_content: null,
    context_chain: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

const TEMPLATES: TaskTemplate[] = [
  {
    id: 'tmpl-deploy',
    name: 'Deploy',
    pattern: 'deploy\\s+to\\s+(staging|production)',
    skip_planning: true,
    estimated_cost: '$0.50',
    default_assignments: [{ role: AgentRole.ENGINEER, tools: ['code_execute'] }],
  },
  {
    id: 'tmpl-test',
    name: 'Run Tests',
    pattern: 'run\\s+(unit|integration)\\s+tests',
    skip_planning: true,
    estimated_cost: '$0.20',
    default_assignments: [{ role: AgentRole.ENGINEER, tools: ['test_run'] }],
  },
  {
    id: 'tmpl-refactor',
    name: 'Refactor',
    pattern: 'refactor\\s+',
    skip_planning: false,
    estimated_cost: '$5.00',
    default_assignments: [{ role: AgentRole.ENGINEER, tools: ['search', 'file_read', 'file_write'] }],
  },
];

describe('routeTask', () => {
  it('should route RECEIVED to adjutant', () => {
    expect(routeTask(makeTask(TaskState.RECEIVED))).toBe(AgentRole.ADJUTANT);
  });

  it('should route PLANNING to chief_of_staff', () => {
    expect(routeTask(makeTask(TaskState.PLANNING))).toBe(AgentRole.CHIEF_OF_STAFF);
  });

  it('should route GATE1_REVIEW to inspector', () => {
    expect(routeTask(makeTask(TaskState.GATE1_REVIEW))).toBe(AgentRole.INSPECTOR);
  });

  it('should route DISPATCHING to operations', () => {
    expect(routeTask(makeTask(TaskState.DISPATCHING))).toBe(AgentRole.OPERATIONS);
  });

  it('should route EXECUTING to engineer', () => {
    expect(routeTask(makeTask(TaskState.EXECUTING))).toBe(AgentRole.ENGINEER);
  });

  it('should route COLLECTING to operations', () => {
    expect(routeTask(makeTask(TaskState.COLLECTING))).toBe(AgentRole.OPERATIONS);
  });

  it('should route GATE2_REVIEW to inspector', () => {
    expect(routeTask(makeTask(TaskState.GATE2_REVIEW))).toBe(AgentRole.INSPECTOR);
  });

  it('should route DELIVERING to adjutant', () => {
    expect(routeTask(makeTask(TaskState.DELIVERING))).toBe(AgentRole.ADJUTANT);
  });

  it('should throw for terminal states', () => {
    expect(() => routeTask(makeTask(TaskState.DONE))).toThrow('No route for state');
    expect(() => routeTask(makeTask(TaskState.FAILED))).toThrow('No route for state');
    expect(() => routeTask(makeTask(TaskState.CANCELLED))).toThrow('No route for state');
  });

  it('should throw for PAUSED', () => {
    expect(() => routeTask(makeTask(TaskState.PAUSED))).toThrow('No route for state');
  });
});

describe('routeRejectByLevel', () => {
  it('should map tactical to DISPATCHING', () => {
    expect(routeRejectByLevel(RejectLevel.TACTICAL)).toBe(TaskState.DISPATCHING);
  });

  it('should map strategic to PLANNING', () => {
    expect(routeRejectByLevel(RejectLevel.STRATEGIC)).toBe(TaskState.PLANNING);
  });

  it('should map critical to FAILED', () => {
    expect(routeRejectByLevel(RejectLevel.CRITICAL)).toBe(TaskState.FAILED);
  });
});

describe('matchTemplate', () => {
  it('should match deploy pattern', () => {
    const result = matchTemplate('deploy to production', TEMPLATES);
    expect(result).toBeDefined();
    expect(result!.id).toBe('tmpl-deploy');
  });

  it('should match deploy to staging', () => {
    const result = matchTemplate('deploy to staging', TEMPLATES);
    expect(result!.id).toBe('tmpl-deploy');
  });

  it('should match test pattern', () => {
    const result = matchTemplate('run unit tests for the API', TEMPLATES);
    expect(result!.id).toBe('tmpl-test');
  });

  it('should match refactor pattern', () => {
    const result = matchTemplate('refactor the authentication module', TEMPLATES);
    expect(result!.id).toBe('tmpl-refactor');
  });

  it('should return null for no match', () => {
    const result = matchTemplate('write a blog post about cats', TEMPLATES);
    expect(result).toBeNull();
  });

  it('should return first matching template', () => {
    const result = matchTemplate('deploy to production now', TEMPLATES);
    expect(result!.id).toBe('tmpl-deploy');
  });

  it('should handle case insensitivity', () => {
    const result = matchTemplate('Deploy To Production', TEMPLATES);
    expect(result).toBeDefined();
    expect(result!.id).toBe('tmpl-deploy');
  });

  it('should handle empty templates list', () => {
    expect(matchTemplate('anything', [])).toBeNull();
  });

  it('should skip templates with invalid regex', () => {
    const badTemplates: TaskTemplate[] = [
      {
        id: 'bad',
        name: 'Bad',
        pattern: '[invalid regex',
        skip_planning: false,
        estimated_cost: '$0',
        default_assignments: [],
      },
      ...TEMPLATES,
    ];
    const result = matchTemplate('deploy to production', badTemplates);
    expect(result!.id).toBe('tmpl-deploy');
  });
});

describe('shouldSkipPlanning', () => {
  it('should return true for templates with skip_planning=true', () => {
    const task = makeTask(TaskState.RECEIVED, 'deploy to production');
    expect(shouldSkipPlanning(task, TEMPLATES)).toBe(true);
  });

  it('should return false for templates with skip_planning=false', () => {
    const task = makeTask(TaskState.RECEIVED, 'refactor the auth module');
    expect(shouldSkipPlanning(task, TEMPLATES)).toBe(false);
  });

  it('should return false when no template matches', () => {
    const task = makeTask(TaskState.RECEIVED, 'write a poem');
    expect(shouldSkipPlanning(task, TEMPLATES)).toBe(false);
  });
});
