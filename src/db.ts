import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

import { DATA_DIR, DB_PATH, DEFAULT_MODELS, DEFAULT_PROVIDER, DEFAULT_TEMPERATURE, DEFAULT_MAX_TOKENS } from './config.js';
import { logger } from './logger.js';
import type {
  Task,
  FlowLog,
  ProgressLog,
  AgentRun,
  CostRecord,
  AgentConfig,
  Campaign,
  TaskState,
  AgentRole,
  TaskPriority,
  IntentType,
} from './types.js';

let db: Database.Database;

function createSchema(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      parent_id TEXT,
      campaign_id TEXT,
      state TEXT NOT NULL DEFAULT 'RECEIVED',
      description TEXT NOT NULL,
      priority TEXT NOT NULL DEFAULT 'medium',
      assigned_agent TEXT,
      assigned_engineer_id TEXT,
      intent_type TEXT,
      reject_count_tactical INTEGER NOT NULL DEFAULT 0,
      reject_count_strategic INTEGER NOT NULL DEFAULT 0,
      rubric TEXT,
      artifacts_path TEXT,
      error_count INTEGER NOT NULL DEFAULT 0,
      override_skip_gate INTEGER NOT NULL DEFAULT 0,
      source_channel TEXT,
      source_chat_id TEXT,
      source_message_id TEXT,
      context_chain TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_tasks_state ON tasks(state);
    CREATE INDEX IF NOT EXISTS idx_tasks_campaign ON tasks(campaign_id);
    CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(parent_id);

    CREATE TABLE IF NOT EXISTS flow_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      at TEXT NOT NULL,
      from_state TEXT,
      to_state TEXT NOT NULL,
      agent_role TEXT,
      reason TEXT,
      duration_ms INTEGER,
      FOREIGN KEY (task_id) REFERENCES tasks(id)
    );
    CREATE INDEX IF NOT EXISTS idx_flow_log_task ON flow_log(task_id);

    CREATE TABLE IF NOT EXISTS progress_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      at TEXT NOT NULL,
      agent TEXT NOT NULL,
      text TEXT NOT NULL,
      todos TEXT,
      FOREIGN KEY (task_id) REFERENCES tasks(id)
    );
    CREATE INDEX IF NOT EXISTS idx_progress_log_task ON progress_log(task_id);

    CREATE TABLE IF NOT EXISTS agent_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      agent_role TEXT NOT NULL,
      engineer_id TEXT,
      model TEXT NOT NULL,
      started_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      finished_at TEXT,
      status TEXT NOT NULL DEFAULT 'running',
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      FOREIGN KEY (task_id) REFERENCES tasks(id)
    );
    CREATE INDEX IF NOT EXISTS idx_agent_runs_task ON agent_runs(task_id);
    CREATE INDEX IF NOT EXISTS idx_agent_runs_status ON agent_runs(status);

    CREATE TABLE IF NOT EXISTS costs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      agent_role TEXT NOT NULL,
      model TEXT NOT NULL,
      input_tokens INTEGER NOT NULL,
      output_tokens INTEGER NOT NULL,
      cost_usd REAL NOT NULL,
      at TEXT NOT NULL,
      FOREIGN KEY (task_id) REFERENCES tasks(id)
    );
    CREATE INDEX IF NOT EXISTS idx_costs_task ON costs(task_id);
    CREATE INDEX IF NOT EXISTS idx_costs_at ON costs(at);

    CREATE TABLE IF NOT EXISTS agent_config (
      role TEXT PRIMARY KEY,
      model TEXT NOT NULL,
      provider TEXT NOT NULL,
      temperature REAL NOT NULL,
      max_tokens INTEGER NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS campaigns (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      phases TEXT NOT NULL,
      current_phase INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
}

export function initDatabase(): void {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  createSchema(db);

  // Migration: add error_count column for existing databases
  try {
    db.prepare('SELECT error_count FROM tasks LIMIT 0').raw().get();
  } catch {
    db.exec('ALTER TABLE tasks ADD COLUMN error_count INTEGER NOT NULL DEFAULT 0');
    logger.info('Migration: added error_count column to tasks');
  }

  // Migration: add source_message_id column for existing databases
  try {
    db.prepare('SELECT source_message_id FROM tasks LIMIT 0').raw().get();
  } catch {
    db.exec('ALTER TABLE tasks ADD COLUMN source_message_id TEXT');
    logger.info('Migration: added source_message_id column to tasks');
  }

  logger.info({ path: DB_PATH }, 'Database initialized (WAL mode)');
}

/** @internal — for tests only. Creates a fresh in-memory database. */
export function _initTestDatabase(): void {
  db = new Database(':memory:');
  createSchema(db);
}

// ─── Tasks ──────────────────────────────────────────────────────

export function createTask(
  task: Omit<Task, 'created_at' | 'updated_at' | 'context_chain' | 'error_count' | 'source_message_id'> & {
    created_at?: string;
    updated_at?: string;
    context_chain?: string | null;
    source_message_id?: string | null;
    error_count?: number;
  },
): Task {
  const now = new Date().toISOString();
  const row: Task = {
    id: task.id,
    parent_id: task.parent_id ?? null,
    campaign_id: task.campaign_id ?? null,
    state: task.state ?? ('RECEIVED' as TaskState),
    description: task.description,
    priority: task.priority ?? ('medium' as TaskPriority),
    assigned_agent: task.assigned_agent ?? null,
    assigned_engineer_id: task.assigned_engineer_id ?? null,
    intent_type: task.intent_type ?? null,
    reject_count_tactical: task.reject_count_tactical ?? 0,
    reject_count_strategic: task.reject_count_strategic ?? 0,
    rubric: task.rubric ?? null,
    artifacts_path: task.artifacts_path ?? null,
    error_count: task.error_count ?? 0,
    override_skip_gate: task.override_skip_gate ?? 0,
    source_channel: task.source_channel ?? null,
    source_chat_id: task.source_chat_id ?? null,
    source_message_id: task.source_message_id ?? null,
    context_chain: task.context_chain ?? null,
    created_at: task.created_at ?? now,
    updated_at: task.updated_at ?? now,
  };

  const insertTaskTxn = db.transaction(() => {
    db.prepare(`
      INSERT INTO tasks (id, parent_id, campaign_id, state, description, priority, assigned_agent, assigned_engineer_id, intent_type, reject_count_tactical, reject_count_strategic, rubric, artifacts_path, error_count, override_skip_gate, source_channel, source_chat_id, source_message_id, context_chain, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      row.id, row.parent_id, row.campaign_id, row.state, row.description, row.priority,
      row.assigned_agent, row.assigned_engineer_id, row.intent_type,
      row.reject_count_tactical, row.reject_count_strategic,
      row.rubric, row.artifacts_path, row.error_count, row.override_skip_gate,
      row.source_channel, row.source_chat_id, row.source_message_id, row.context_chain,
      row.created_at, row.updated_at,
    );

    // Write initial flow_log entry (atomic with task creation)
    writeFlowLog({
      task_id: row.id,
      at: row.created_at,
      from_state: null,
      to_state: row.state,
      agent_role: null,
      reason: 'task created',
      duration_ms: null,
    });
  });
  insertTaskTxn();

  return row;
}

export function getTaskById(id: string): Task | undefined {
  return db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Task | undefined;
}

export function getTasksByState(state: TaskState): Task[] {
  return db.prepare('SELECT * FROM tasks WHERE state = ? ORDER BY created_at').all(state) as Task[];
}

export function getTasksByCampaign(campaignId: string): Task[] {
  return db.prepare('SELECT * FROM tasks WHERE campaign_id = ? ORDER BY created_at').all(campaignId) as Task[];
}

export function getTasksByParent(parentId: string): Task[] {
  return db.prepare('SELECT * FROM tasks WHERE parent_id = ? ORDER BY created_at').all(parentId) as Task[];
}

export function getAllTasks(): Task[] {
  return db.prepare('SELECT * FROM tasks ORDER BY created_at DESC').all() as Task[];
}

export function updateTaskState(
  taskId: string,
  toState: TaskState,
  agentRole?: AgentRole,
  reason?: string,
): void {
  const task = getTaskById(taskId);
  if (!task) throw new Error(`Task not found: ${taskId}`);

  const now = new Date().toISOString();
  const fromState = task.state;

  const updateStateTxn = db.transaction(() => {
    db.prepare('UPDATE tasks SET state = ?, updated_at = ? WHERE id = ?').run(toState, now, taskId);

    writeFlowLog({
      task_id: taskId,
      at: now,
      from_state: fromState,
      to_state: toState,
      agent_role: agentRole ?? null,
      reason: reason ?? null,
      duration_ms: null,
    });
  });
  updateStateTxn();
}

const TASK_UPDATE_FIELDS = new Set([
  'parent_id', 'campaign_id', 'state', 'description', 'priority',
  'assigned_agent', 'assigned_engineer_id', 'intent_type',
  'reject_count_tactical', 'reject_count_strategic',
  'rubric', 'artifacts_path', 'error_count', 'override_skip_gate',
  'source_channel', 'source_chat_id', 'source_message_id', 'context_chain',
]);

export function updateTask(taskId: string, updates: Partial<Omit<Task, 'id' | 'created_at'>>): void {
  const fields: string[] = [];
  const values: unknown[] = [];

  for (const [key, value] of Object.entries(updates)) {
    if (key === 'id' || key === 'created_at') continue;
    if (!TASK_UPDATE_FIELDS.has(key)) continue;
    fields.push(`${key} = ?`);
    values.push(value);
  }

  if (fields.length === 0) return;

  fields.push('updated_at = ?');
  values.push(new Date().toISOString());
  values.push(taskId);

  db.prepare(`UPDATE tasks SET ${fields.join(', ')} WHERE id = ?`).run(...values);
}

export function appendContextChain(taskId: string, role: AgentRole, output: string): void {
  const task = getTaskById(taskId);
  if (!task) return;
  const chain: { role: string; output: string }[] = task.context_chain
    ? JSON.parse(task.context_chain)
    : [];
  chain.push({ role, output: output.slice(0, 5000) });
  updateTask(taskId, { context_chain: JSON.stringify(chain) });
}

// ─── Flow Log ───────────────────────────────────────────────────

export function writeFlowLog(entry: FlowLog): void {
  db.prepare(`
    INSERT INTO flow_log (task_id, at, from_state, to_state, agent_role, reason, duration_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    entry.task_id, entry.at, entry.from_state, entry.to_state,
    entry.agent_role, entry.reason, entry.duration_ms,
  );
}

export function getFlowLog(taskId: string): FlowLog[] {
  return db.prepare('SELECT * FROM flow_log WHERE task_id = ? ORDER BY at').all(taskId) as FlowLog[];
}

// ─── Progress Log ───────────────────────────────────────────────

export function writeProgressLog(entry: ProgressLog): void {
  db.prepare(`
    INSERT INTO progress_log (task_id, at, agent, text, todos)
    VALUES (?, ?, ?, ?, ?)
  `).run(entry.task_id, entry.at, entry.agent, entry.text, entry.todos);
}

export function getProgressLog(taskId: string): ProgressLog[] {
  return db.prepare('SELECT * FROM progress_log WHERE task_id = ? ORDER BY at').all(taskId) as ProgressLog[];
}

// ─── Agent Runs ─────────────────────────────────────────────────

export function recordAgentRun(run: Omit<AgentRun, 'id'>): number {
  const result = db.prepare(`
    INSERT INTO agent_runs (task_id, agent_role, engineer_id, model, started_at, updated_at, finished_at, status, input_tokens, output_tokens, error)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    run.task_id, run.agent_role, run.engineer_id, run.model,
    run.started_at, run.updated_at, run.finished_at,
    run.status, run.input_tokens, run.output_tokens, run.error,
  );
  return Number(result.lastInsertRowid);
}

const AGENT_RUN_UPDATE_FIELDS = new Set([
  'model', 'finished_at', 'status',
  'input_tokens', 'output_tokens', 'error',
]);

export function updateAgentRun(id: number, updates: Partial<Omit<AgentRun, 'id' | 'task_id' | 'agent_role' | 'started_at'>>): void {
  const fields: string[] = [];
  const values: unknown[] = [];

  for (const [key, value] of Object.entries(updates)) {
    if (!AGENT_RUN_UPDATE_FIELDS.has(key)) continue;
    fields.push(`${key} = ?`);
    values.push(value);
  }

  if (fields.length === 0) return;

  fields.push('updated_at = ?');
  values.push(new Date().toISOString());
  values.push(id);

  db.prepare(`UPDATE agent_runs SET ${fields.join(', ')} WHERE id = ?`).run(...values);
}

export function getActiveRuns(): AgentRun[] {
  return db.prepare("SELECT * FROM agent_runs WHERE status = 'running' ORDER BY started_at").all() as AgentRun[];
}

export function getRunsByTask(taskId: string): AgentRun[] {
  return db.prepare('SELECT * FROM agent_runs WHERE task_id = ? ORDER BY started_at').all(taskId) as AgentRun[];
}

export function getRecentRunsForTask(taskId: string, limit: number = 10): AgentRun[] {
  return db.prepare(
    'SELECT * FROM agent_runs WHERE task_id = ? ORDER BY started_at DESC LIMIT ?',
  ).all(taskId, limit) as AgentRun[];
}

// ─── Costs ──────────────────────────────────────────────────────

export function recordCost(cost: Omit<CostRecord, 'id'>): void {
  db.prepare(`
    INSERT INTO costs (task_id, agent_role, model, input_tokens, output_tokens, cost_usd, at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    cost.task_id, cost.agent_role, cost.model,
    cost.input_tokens, cost.output_tokens, cost.cost_usd, cost.at,
  );
}

export function getDailyCost(date?: string): number {
  const day = date ?? new Date().toISOString().slice(0, 10);
  const result = db.prepare(`
    SELECT COALESCE(SUM(cost_usd), 0) as total FROM costs WHERE at LIKE ?
  `).get(`${day}%`) as { total: number };
  return result.total;
}

export function getCostByTask(taskId: string): number {
  const result = db.prepare(`
    SELECT COALESCE(SUM(cost_usd), 0) as total FROM costs WHERE task_id = ?
  `).get(taskId) as { total: number };
  return result.total;
}

// ─── Agent Config ───────────────────────────────────────────────

export function getAgentConfig(role: AgentRole): AgentConfig {
  const row = db.prepare('SELECT * FROM agent_config WHERE role = ?').get(role) as AgentConfig | undefined;
  if (row) return row;

  // Return defaults if not configured
  return {
    role,
    model: DEFAULT_MODELS[role],
    provider: DEFAULT_PROVIDER,
    temperature: DEFAULT_TEMPERATURE,
    max_tokens: DEFAULT_MAX_TOKENS,
    updated_at: new Date().toISOString(),
  };
}

export function setAgentConfig(config: AgentConfig): void {
  db.prepare(`
    INSERT INTO agent_config (role, model, provider, temperature, max_tokens, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(role) DO UPDATE SET
      model = excluded.model,
      provider = excluded.provider,
      temperature = excluded.temperature,
      max_tokens = excluded.max_tokens,
      updated_at = excluded.updated_at
  `).run(
    config.role, config.model, config.provider,
    config.temperature, config.max_tokens, config.updated_at,
  );
}

export function getAllAgentConfigs(): AgentConfig[] {
  return db.prepare('SELECT * FROM agent_config ORDER BY role').all() as AgentConfig[];
}

// ─── Campaigns ──────────────────────────────────────────────────

export function createCampaign(campaign: Omit<Campaign, 'created_at' | 'updated_at'> & { created_at?: string; updated_at?: string }): Campaign {
  const now = new Date().toISOString();
  const row: Campaign = {
    id: campaign.id,
    name: campaign.name,
    phases: campaign.phases,
    current_phase: campaign.current_phase ?? 0,
    status: campaign.status ?? 'active',
    created_at: campaign.created_at ?? now,
    updated_at: campaign.updated_at ?? now,
  };

  db.prepare(`
    INSERT INTO campaigns (id, name, phases, current_phase, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(row.id, row.name, row.phases, row.current_phase, row.status, row.created_at, row.updated_at);

  return row;
}

export function getCampaign(id: string): Campaign | undefined {
  return db.prepare('SELECT * FROM campaigns WHERE id = ?').get(id) as Campaign | undefined;
}

export function updateCampaignPhase(id: string, phase: number, status?: Campaign['status']): void {
  const now = new Date().toISOString();
  if (status) {
    db.prepare('UPDATE campaigns SET current_phase = ?, status = ?, updated_at = ? WHERE id = ?').run(phase, status, now, id);
  } else {
    db.prepare('UPDATE campaigns SET current_phase = ?, updated_at = ? WHERE id = ?').run(phase, now, id);
  }
}

export function getAllCampaigns(): Campaign[] {
  return db.prepare('SELECT * FROM campaigns ORDER BY created_at DESC').all() as Campaign[];
}
