import { describe, it, expect, beforeEach } from 'vitest';
import {
  _initTestDatabase,
  createTask,
  getTaskById,
  getTasksByState,
  getAllTasks,
  updateTaskState,
  updateTask,
  writeFlowLog,
  getFlowLog,
  writeProgressLog,
  getProgressLog,
  recordAgentRun,
  updateAgentRun,
  getActiveRuns,
  getRunsByTask,
  recordCost,
  getDailyCost,
  getCostByTask,
  getAgentConfig,
  setAgentConfig,
  getAllAgentConfigs,
  createCampaign,
  getCampaign,
  updateCampaignPhase,
  getAllCampaigns,
  getTasksByCampaign,
} from '../src/kernel/db.js';
import { TaskState, AgentRole, TaskPriority } from '../src/types.js';
import type { AgentConfig } from '../src/types.js';

beforeEach(() => {
  _initTestDatabase();
});

describe('Tasks CRUD', () => {
  it('should create and retrieve a task', () => {
    const task = createTask({
      id: 'task-1',
      parent_id: null,
      campaign_id: null,
      state: TaskState.RECEIVED,
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

    expect(task.id).toBe('task-1');
    expect(task.state).toBe('RECEIVED');
    expect(task.description).toBe('Test task');
    expect(task.created_at).toBeTruthy();

    const retrieved = getTaskById('task-1');
    expect(retrieved).toBeDefined();
    expect(retrieved!.id).toBe('task-1');
    expect(retrieved!.state).toBe('RECEIVED');
  });

  it('should return undefined for non-existent task', () => {
    expect(getTaskById('nope')).toBeUndefined();
  });

  it('should get tasks by state', () => {
    createTask({
      id: 'task-a', parent_id: null, campaign_id: null,
      state: TaskState.RECEIVED, description: 'A', priority: TaskPriority.LOW,
      assigned_agent: null, assigned_engineer_id: null, intent_type: null,
      reject_count_tactical: 0, reject_count_strategic: 0,
      rubric: null, artifacts_path: null, override_skip_gate: 0,
    });
    createTask({
      id: 'task-b', parent_id: null, campaign_id: null,
      state: TaskState.PLANNING, description: 'B', priority: TaskPriority.HIGH,
      assigned_agent: null, assigned_engineer_id: null, intent_type: null,
      reject_count_tactical: 0, reject_count_strategic: 0,
      rubric: null, artifacts_path: null, override_skip_gate: 0,
    });
    createTask({
      id: 'task-c', parent_id: null, campaign_id: null,
      state: TaskState.RECEIVED, description: 'C', priority: TaskPriority.URGENT,
      assigned_agent: null, assigned_engineer_id: null, intent_type: null,
      reject_count_tactical: 0, reject_count_strategic: 0,
      rubric: null, artifacts_path: null, override_skip_gate: 0,
    });

    const received = getTasksByState(TaskState.RECEIVED);
    expect(received).toHaveLength(2);
    expect(received[0].id).toBe('task-a');
    expect(received[1].id).toBe('task-c');

    const planning = getTasksByState(TaskState.PLANNING);
    expect(planning).toHaveLength(1);
    expect(planning[0].id).toBe('task-b');
  });

  it('should update task state and write flow_log', () => {
    createTask({
      id: 'task-1', parent_id: null, campaign_id: null,
      state: TaskState.RECEIVED, description: 'Test', priority: TaskPriority.MEDIUM,
      assigned_agent: null, assigned_engineer_id: null, intent_type: null,
      reject_count_tactical: 0, reject_count_strategic: 0,
      rubric: null, artifacts_path: null, override_skip_gate: 0,
    });

    updateTaskState('task-1', TaskState.PLANNING, AgentRole.ADJUTANT, 'planning');

    const task = getTaskById('task-1')!;
    expect(task.state).toBe('PLANNING');

    const logs = getFlowLog('task-1');
    // 2 entries: creation + state update
    expect(logs).toHaveLength(2);
    expect(logs[1].from_state).toBe('RECEIVED');
    expect(logs[1].to_state).toBe('PLANNING');
    expect(logs[1].agent_role).toBe('adjutant');
  });

  it('should throw when updating non-existent task', () => {
    expect(() => updateTaskState('nope', TaskState.PLANNING)).toThrow('Task not found');
  });

  it('should update task fields', () => {
    createTask({
      id: 'task-1', parent_id: null, campaign_id: null,
      state: TaskState.RECEIVED, description: 'Test', priority: TaskPriority.MEDIUM,
      assigned_agent: null, assigned_engineer_id: null, intent_type: null,
      reject_count_tactical: 0, reject_count_strategic: 0,
      rubric: null, artifacts_path: null, override_skip_gate: 0,
    });

    updateTask('task-1', {
      reject_count_tactical: 2,
      assigned_agent: AgentRole.ENGINEER,
    });

    const task = getTaskById('task-1')!;
    expect(task.reject_count_tactical).toBe(2);
    expect(task.assigned_agent).toBe('engineer');
  });

  it('should get all tasks', () => {
    createTask({
      id: 'task-1', parent_id: null, campaign_id: null,
      state: TaskState.RECEIVED, description: 'A', priority: TaskPriority.MEDIUM,
      assigned_agent: null, assigned_engineer_id: null, intent_type: null,
      reject_count_tactical: 0, reject_count_strategic: 0,
      rubric: null, artifacts_path: null, override_skip_gate: 0,
    });
    createTask({
      id: 'task-2', parent_id: null, campaign_id: null,
      state: TaskState.DONE, description: 'B', priority: TaskPriority.LOW,
      assigned_agent: null, assigned_engineer_id: null, intent_type: null,
      reject_count_tactical: 0, reject_count_strategic: 0,
      rubric: null, artifacts_path: null, override_skip_gate: 0,
    });

    const all = getAllTasks();
    expect(all).toHaveLength(2);
  });
});

describe('Flow Log', () => {
  it('should write and retrieve flow log entries', () => {
    createTask({
      id: 'task-1', parent_id: null, campaign_id: null,
      state: TaskState.RECEIVED, description: 'Test', priority: TaskPriority.MEDIUM,
      assigned_agent: null, assigned_engineer_id: null, intent_type: null,
      reject_count_tactical: 0, reject_count_strategic: 0,
      rubric: null, artifacts_path: null, override_skip_gate: 0,
    });

    writeFlowLog({
      task_id: 'task-1',
      at: new Date().toISOString(),
      from_state: TaskState.RECEIVED,
      to_state: TaskState.PLANNING,
      agent_role: AgentRole.ADJUTANT,
      reason: 'manual test',
      duration_ms: 100,
    });

    const logs = getFlowLog('task-1');
    // 1 from creation + 1 manual
    expect(logs).toHaveLength(2);
    expect(logs[1].from_state).toBe('RECEIVED');
    expect(logs[1].to_state).toBe('PLANNING');
    expect(logs[1].duration_ms).toBe(100);
  });
});

describe('Progress Log', () => {
  it('should write and retrieve progress log entries', () => {
    createTask({
      id: 'task-1', parent_id: null, campaign_id: null,
      state: TaskState.RECEIVED, description: 'Test', priority: TaskPriority.MEDIUM,
      assigned_agent: null, assigned_engineer_id: null, intent_type: null,
      reject_count_tactical: 0, reject_count_strategic: 0,
      rubric: null, artifacts_path: null, override_skip_gate: 0,
    });

    writeProgressLog({
      task_id: 'task-1',
      at: new Date().toISOString(),
      agent: AgentRole.ENGINEER,
      text: 'Working on implementation',
      todos: JSON.stringify(['step 1', 'step 2']),
    });

    const logs = getProgressLog('task-1');
    expect(logs).toHaveLength(1);
    expect(logs[0].agent).toBe('engineer');
    expect(logs[0].text).toBe('Working on implementation');
    expect(JSON.parse(logs[0].todos!)).toEqual(['step 1', 'step 2']);
  });
});

describe('Agent Runs', () => {
  it('should record and retrieve agent runs', () => {
    createTask({
      id: 'task-1', parent_id: null, campaign_id: null,
      state: TaskState.EXECUTING, description: 'Test', priority: TaskPriority.MEDIUM,
      assigned_agent: null, assigned_engineer_id: null, intent_type: null,
      reject_count_tactical: 0, reject_count_strategic: 0,
      rubric: null, artifacts_path: null, override_skip_gate: 0,
    });

    const now = new Date().toISOString();
    const runId = recordAgentRun({
      task_id: 'task-1',
      agent_role: AgentRole.ENGINEER,
      engineer_id: 'eng-1',
      model: 'claude-opus-4-20250514',
      started_at: now,
      updated_at: now,
      finished_at: null,
      status: 'running',
      input_tokens: 0,
      output_tokens: 0,
      error: null,
    });

    expect(runId).toBeGreaterThan(0);

    const active = getActiveRuns();
    expect(active).toHaveLength(1);
    expect(active[0].task_id).toBe('task-1');
    expect(active[0].status).toBe('running');
  });

  it('should update agent run status', () => {
    createTask({
      id: 'task-1', parent_id: null, campaign_id: null,
      state: TaskState.EXECUTING, description: 'Test', priority: TaskPriority.MEDIUM,
      assigned_agent: null, assigned_engineer_id: null, intent_type: null,
      reject_count_tactical: 0, reject_count_strategic: 0,
      rubric: null, artifacts_path: null, override_skip_gate: 0,
    });

    const now = new Date().toISOString();
    const runId = recordAgentRun({
      task_id: 'task-1',
      agent_role: AgentRole.ENGINEER,
      engineer_id: null,
      model: 'claude-opus-4-20250514',
      started_at: now,
      updated_at: now,
      finished_at: null,
      status: 'running',
      input_tokens: 0,
      output_tokens: 0,
      error: null,
    });

    updateAgentRun(runId, {
      status: 'success',
      finished_at: new Date().toISOString(),
      input_tokens: 1000,
      output_tokens: 500,
    });

    const active = getActiveRuns();
    expect(active).toHaveLength(0);

    const runs = getRunsByTask('task-1');
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe('success');
    expect(runs[0].input_tokens).toBe(1000);
  });
});

describe('Costs', () => {
  it('should record and aggregate costs', () => {
    createTask({
      id: 'task-1', parent_id: null, campaign_id: null,
      state: TaskState.EXECUTING, description: 'Test', priority: TaskPriority.MEDIUM,
      assigned_agent: null, assigned_engineer_id: null, intent_type: null,
      reject_count_tactical: 0, reject_count_strategic: 0,
      rubric: null, artifacts_path: null, override_skip_gate: 0,
    });

    const today = new Date().toISOString().slice(0, 10);
    recordCost({
      task_id: 'task-1',
      agent_role: AgentRole.ENGINEER,
      model: 'claude-opus-4-20250514',
      input_tokens: 1000,
      output_tokens: 500,
      cost_usd: 0.05,
      at: `${today}T10:00:00.000Z`,
    });
    recordCost({
      task_id: 'task-1',
      agent_role: AgentRole.INSPECTOR,
      model: 'claude-opus-4-20250514',
      input_tokens: 500,
      output_tokens: 200,
      cost_usd: 0.02,
      at: `${today}T11:00:00.000Z`,
    });

    const dailyCost = getDailyCost(today);
    expect(dailyCost).toBeCloseTo(0.07);

    const taskCost = getCostByTask('task-1');
    expect(taskCost).toBeCloseTo(0.07);
  });

  it('should return 0 for no costs', () => {
    expect(getDailyCost('2099-01-01')).toBe(0);
    expect(getCostByTask('nonexistent')).toBe(0);
  });
});

describe('Agent Config', () => {
  it('should return defaults when not configured', () => {
    const config = getAgentConfig(AgentRole.ENGINEER);
    expect(config.role).toBe('engineer');
    expect(config.model).toBe('claude-opus-4-20250514');
    expect(config.provider).toBe('anthropic');
  });

  it('should set and get custom config', () => {
    const now = new Date().toISOString();
    setAgentConfig({
      role: AgentRole.ENGINEER,
      model: 'gpt-4o',
      provider: 'openai',
      temperature: 0.7,
      max_tokens: 4096,
      updated_at: now,
    });

    const config = getAgentConfig(AgentRole.ENGINEER);
    expect(config.model).toBe('gpt-4o');
    expect(config.provider).toBe('openai');
    expect(config.temperature).toBe(0.7);
    expect(config.max_tokens).toBe(4096);
  });

  it('should upsert config on conflict', () => {
    const now = new Date().toISOString();
    setAgentConfig({
      role: AgentRole.ADJUTANT,
      model: 'model-a',
      provider: 'anthropic',
      temperature: 0.3,
      max_tokens: 8192,
      updated_at: now,
    });
    setAgentConfig({
      role: AgentRole.ADJUTANT,
      model: 'model-b',
      provider: 'openai',
      temperature: 0.5,
      max_tokens: 4096,
      updated_at: now,
    });

    const config = getAgentConfig(AgentRole.ADJUTANT);
    expect(config.model).toBe('model-b');
    expect(config.provider).toBe('openai');

    const all = getAllAgentConfigs();
    expect(all).toHaveLength(1);
  });
});

describe('Campaigns', () => {
  it('should create and retrieve a campaign', () => {
    const campaign = createCampaign({
      id: 'camp-1',
      name: 'Refactor UI',
      phases: JSON.stringify([
        { name: 'Design', goal: 'Design new components' },
        { name: 'Implement', goal: 'Build components', depends_on: 'Design' },
      ]),
      current_phase: 0,
      status: 'active',
    });

    expect(campaign.id).toBe('camp-1');
    expect(campaign.status).toBe('active');

    const retrieved = getCampaign('camp-1');
    expect(retrieved).toBeDefined();
    expect(retrieved!.name).toBe('Refactor UI');
    expect(JSON.parse(retrieved!.phases)).toHaveLength(2);
  });

  it('should update campaign phase', () => {
    createCampaign({
      id: 'camp-1',
      name: 'Test',
      phases: JSON.stringify([{ name: 'Phase1', goal: 'Goal1' }]),
      current_phase: 0,
      status: 'active',
    });

    updateCampaignPhase('camp-1', 1, 'done');

    const campaign = getCampaign('camp-1')!;
    expect(campaign.current_phase).toBe(1);
    expect(campaign.status).toBe('done');
  });

  it('should link tasks to campaigns', () => {
    createCampaign({
      id: 'camp-1',
      name: 'Test Campaign',
      phases: JSON.stringify([]),
      current_phase: 0,
      status: 'active',
    });

    createTask({
      id: 'task-1', parent_id: null, campaign_id: 'camp-1',
      state: TaskState.RECEIVED, description: 'Part 1', priority: TaskPriority.MEDIUM,
      assigned_agent: null, assigned_engineer_id: null, intent_type: null,
      reject_count_tactical: 0, reject_count_strategic: 0,
      rubric: null, artifacts_path: null, override_skip_gate: 0,
    });
    createTask({
      id: 'task-2', parent_id: null, campaign_id: 'camp-1',
      state: TaskState.RECEIVED, description: 'Part 2', priority: TaskPriority.MEDIUM,
      assigned_agent: null, assigned_engineer_id: null, intent_type: null,
      reject_count_tactical: 0, reject_count_strategic: 0,
      rubric: null, artifacts_path: null, override_skip_gate: 0,
    });

    const tasks = getTasksByCampaign('camp-1');
    expect(tasks).toHaveLength(2);
  });

  it('should get all campaigns', () => {
    createCampaign({ id: 'c1', name: 'A', phases: '[]', current_phase: 0, status: 'active' });
    createCampaign({ id: 'c2', name: 'B', phases: '[]', current_phase: 0, status: 'done' });

    const all = getAllCampaigns();
    expect(all).toHaveLength(2);
  });
});
