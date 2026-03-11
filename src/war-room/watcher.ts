// ═══════════════════════════════════════════════════════════
// ArmyClaw — War Room DB Watcher
// Polls SQLite DB for changes without events (pure polling)
// Uses a separate read-only connection to avoid blocking writes
// ═══════════════════════════════════════════════════════════

import Database from 'better-sqlite3';

import { DB_PATH, WAR_ROOM_POLL_INTERVAL_MS } from '../config.js';
import { logger } from '../logger.js';
import type { Task, AgentRole, AgentRun, AgentConfig, TaskState } from '../types.js';

// ─── Watcher Types ──────────────────────────────────────────

export interface WatcherUpdate {
  tasks_changed: boolean;
  agents_changed: boolean;
  costs_changed: boolean;
}

export interface AgentStatus {
  role: AgentRole;
  status: 'active' | 'thinking' | 'stalled' | 'idle';
  current_task_id: string | null;
  model: string;
  last_activity: string;
}

export interface HealthStatus {
  role: AgentRole;
  status: 'green' | 'yellow' | 'red';
  last_updated: string;
}

export interface CostSummary {
  daily_total: number;
  weekly_total: number;
  by_agent: Record<string, number>;
  by_task: Record<string, number>;
}

// ─── DB Watcher ─────────────────────────────────────────────

export class DbWatcher {
  private intervalId: NodeJS.Timeout | null = null;
  private lastTasksHash = '';
  private lastRunsHash = '';
  private lastCostsHash = '';
  private listeners: ((data: WatcherUpdate) => void)[] = [];
  private rdb: Database.Database | null = null;
  private wdb: Database.Database | null = null;

  /**
   * Open a read-only DB connection and start polling.
   */
  start(intervalMs?: number): void {
    const pollMs = intervalMs ?? WAR_ROOM_POLL_INTERVAL_MS;

    try {
      this.rdb = new Database(DB_PATH, { readonly: true, fileMustExist: true });
      this.rdb.pragma('journal_mode = WAL');

      this.wdb = new Database(DB_PATH, { fileMustExist: true });
      this.wdb.pragma('journal_mode = WAL');

      logger.info({ path: DB_PATH, intervalMs: pollMs }, 'War Room watcher started');
    } catch (err) {
      logger.error(
        { error: err instanceof Error ? err.message : String(err) },
        'Failed to open DB for War Room watcher',
      );
      return;
    }

    this.intervalId = setInterval(() => {
      try {
        this.poll();
      } catch (err) {
        logger.error(
          { error: err instanceof Error ? err.message : String(err) },
          'Watcher poll error',
        );
      }
    }, pollMs);
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    if (this.rdb) {
      this.rdb.close();
      this.rdb = null;
    }
    if (this.wdb) {
      this.wdb.close();
      this.wdb = null;
    }
    logger.info('War Room watcher stopped');
  }

  onUpdate(listener: (data: WatcherUpdate) => void): void {
    this.listeners.push(listener);
  }

  // ─── Snapshot Methods ───────────────────────────────────────

  getTasksSnapshot(): Task[] {
    if (!this.rdb) return [];
    try {
      return this.rdb.prepare('SELECT * FROM tasks ORDER BY created_at DESC').all() as Task[];
    } catch {
      return [];
    }
  }

  getActiveTasksSnapshot(): Task[] {
    if (!this.rdb) return [];
    try {
      return this.rdb.prepare(
        "SELECT * FROM tasks WHERE state NOT IN ('DONE', 'FAILED', 'CANCELLED') ORDER BY created_at DESC",
      ).all() as Task[];
    } catch {
      return [];
    }
  }

  getFlowLogSnapshot(taskId: string): unknown[] {
    if (!this.rdb) return [];
    try {
      return this.rdb.prepare('SELECT * FROM flow_log WHERE task_id = ? ORDER BY at').all(taskId);
    } catch {
      return [];
    }
  }

  getProgressLogSnapshot(taskId: string): unknown[] {
    if (!this.rdb) return [];
    try {
      return this.rdb.prepare('SELECT * FROM progress_log WHERE task_id = ? ORDER BY at').all(taskId);
    } catch {
      return [];
    }
  }

  getAgentStatus(): AgentStatus[] {
    if (!this.rdb) return [];

    const roles: AgentRole[] = ['adjutant', 'chief_of_staff', 'operations', 'inspector', 'engineer'];
    const statuses: AgentStatus[] = [];

    for (const role of roles) {
      // Get the latest run for this role
      const latestRun = this.rdb.prepare(
        'SELECT * FROM agent_runs WHERE agent_role = ? ORDER BY updated_at DESC LIMIT 1',
      ).get(role) as AgentRun | undefined;

      // Get config
      const config = this.rdb.prepare(
        'SELECT * FROM agent_config WHERE role = ?',
      ).get(role) as AgentConfig | undefined;

      const model = config?.model ?? 'default';
      const lastActivity = latestRun?.updated_at ?? '';

      let status: AgentStatus['status'] = 'idle';
      let currentTaskId: string | null = null;

      if (latestRun) {
        if (latestRun.status === 'running') {
          const elapsed = Date.now() - new Date(latestRun.updated_at).getTime();
          if (elapsed <= 30_000) {
            status = 'active';
          } else if (elapsed <= 120_000) {
            status = 'thinking';
          } else {
            status = 'stalled';
          }
          currentTaskId = latestRun.task_id;
        }
      }

      statuses.push({ role, status, current_task_id: currentTaskId, model, last_activity: lastActivity });
    }

    return statuses;
  }

  getHealthStatus(): HealthStatus[] {
    if (!this.rdb) return [];

    const roles: AgentRole[] = ['adjutant', 'chief_of_staff', 'operations', 'inspector', 'engineer'];
    const statuses: HealthStatus[] = [];

    for (const role of roles) {
      const latestRun = this.rdb.prepare(
        'SELECT updated_at FROM agent_runs WHERE agent_role = ? ORDER BY updated_at DESC LIMIT 1',
      ).get(role) as { updated_at: string } | undefined;

      let healthStatus: HealthStatus['status'] = 'red';
      const lastUpdated = latestRun?.updated_at ?? '';

      if (latestRun) {
        const elapsed = Date.now() - new Date(latestRun.updated_at).getTime();
        if (elapsed <= 30_000) {
          healthStatus = 'green';   // active — updated within 30s
        } else if (elapsed <= 120_000) {
          healthStatus = 'yellow';  // thinking — updated within 2min
        } else {
          healthStatus = 'red';     // stalled — updated > 2min ago
        }
      }

      statuses.push({ role, status: healthStatus, last_updated: lastUpdated });
    }

    return statuses;
  }

  getCostSummary(): CostSummary {
    if (!this.rdb) return { daily_total: 0, weekly_total: 0, by_agent: {}, by_task: {} };

    const today = new Date().toISOString().slice(0, 10);
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

    const dailyResult = this.rdb.prepare(
      "SELECT COALESCE(SUM(cost_usd), 0) as total FROM costs WHERE at LIKE ?",
    ).get(`${today}%`) as { total: number };

    const weeklyResult = this.rdb.prepare(
      "SELECT COALESCE(SUM(cost_usd), 0) as total FROM costs WHERE at >= ?",
    ).get(weekAgo) as { total: number };

    const byAgentRows = this.rdb.prepare(
      "SELECT agent_role, COALESCE(SUM(cost_usd), 0) as total FROM costs WHERE at LIKE ? GROUP BY agent_role",
    ).all(`${today}%`) as { agent_role: string; total: number }[];

    const byTaskRows = this.rdb.prepare(
      "SELECT task_id, COALESCE(SUM(cost_usd), 0) as total FROM costs GROUP BY task_id ORDER BY total DESC LIMIT 20",
    ).all() as { task_id: string; total: number }[];

    const byAgent: Record<string, number> = {};
    for (const row of byAgentRows) {
      byAgent[row.agent_role] = row.total;
    }

    const byTask: Record<string, number> = {};
    for (const row of byTaskRows) {
      byTask[row.task_id] = row.total;
    }

    return {
      daily_total: dailyResult.total,
      weekly_total: weeklyResult.total,
      by_agent: byAgent,
      by_task: byTask,
    };
  }

  getAgentConfigs(): AgentConfig[] {
    if (!this.rdb) return [];
    try {
      return this.rdb.prepare('SELECT * FROM agent_config ORDER BY role').all() as AgentConfig[];
    } catch {
      return [];
    }
  }

  // ─── Write Methods ────────────────────────────────────────

  setAgentConfigWrite(config: AgentConfig): void {
    if (!this.wdb) throw new Error('Writable DB not initialized');

    const now = new Date().toISOString();
    this.wdb.prepare(`
      INSERT INTO agent_config (role, model, provider, temperature, max_tokens, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(role) DO UPDATE SET
        model = excluded.model,
        provider = excluded.provider,
        temperature = excluded.temperature,
        max_tokens = excluded.max_tokens,
        updated_at = excluded.updated_at
    `).run(config.role, config.model, config.provider, config.temperature, config.max_tokens, now);

    logger.info({ role: config.role, model: config.model }, 'Agent config updated via War Room');
  }

  controlTask(taskId: string, action: 'pause' | 'cancel' | 'resume'): { task_id: string; action: string; new_state: TaskState } {
    if (!this.wdb) throw new Error('Writable DB not initialized');

    const task = this.wdb.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as Task | undefined;
    if (!task) throw new Error(`Task not found: ${taskId}`);

    const stateMap: Record<string, TaskState> = {
      pause: 'PAUSED' as TaskState,
      cancel: 'CANCELLED' as TaskState,
      resume: 'RECEIVED' as TaskState,
    };
    const newState = stateMap[action];
    const now = new Date().toISOString();

    this.wdb.prepare('UPDATE tasks SET state = ?, updated_at = ? WHERE id = ?').run(newState, now, taskId);

    this.wdb.prepare(`
      INSERT INTO flow_log (task_id, at, from_state, to_state, agent_role, reason, duration_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(taskId, now, task.state, newState, null, `War Room: ${action}`, null);

    logger.info({ taskId, from: task.state, to: newState, action }, 'Task controlled via War Room');

    return { task_id: taskId, action, new_state: newState };
  }

  // ─── Internal ─────────────────────────────────────────────

  private poll(): void {
    if (!this.rdb) return;

    // Detect changes by hashing latest updated_at from each table
    const tasksHash = this.getLatestTimestamp('tasks');
    const runsHash = this.getLatestTimestamp('agent_runs');
    const costsHash = this.getLatestTimestamp('costs');

    const update: WatcherUpdate = {
      tasks_changed: tasksHash !== this.lastTasksHash,
      agents_changed: runsHash !== this.lastRunsHash,
      costs_changed: costsHash !== this.lastCostsHash,
    };

    this.lastTasksHash = tasksHash;
    this.lastRunsHash = runsHash;
    this.lastCostsHash = costsHash;

    if (update.tasks_changed || update.agents_changed || update.costs_changed) {
      for (const listener of this.listeners) {
        try {
          listener(update);
        } catch (err) {
          logger.error(
            { error: err instanceof Error ? err.message : String(err) },
            'Watcher listener error',
          );
        }
      }
    }
  }

  private getLatestTimestamp(table: string): string {
    if (!this.rdb) return '';
    try {
      const row = this.rdb.prepare(
        `SELECT MAX(updated_at) as latest FROM ${table}`,
      ).get() as { latest: string | null } | undefined;
      return row?.latest ?? '';
    } catch {
      return '';
    }
  }
}
