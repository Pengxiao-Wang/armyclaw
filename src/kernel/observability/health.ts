// ArmyClaw — Health Checker

import { logger } from '../../logger.js';
import { getDailyCost, getActiveRuns } from '../db.js';
import { LLM_CALL_STALL_DEFAULT_MS, DAILY_BUDGET_USD, HEALTH_CHECK_INTERVAL_MS } from '../../config.js';
import type { HealthStatus, Observer } from '../../types.js';

export class HealthChecker {
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private startedAt = Date.now();
  private latestStatus: HealthStatus | null = null;
  private listeners: ((status: HealthStatus) => void)[] = [];

  constructor(
    private observer: Observer,
    private getCircuitState: () => string,
  ) {}

  start(): void {
    if (this.intervalId) return;
    this.startedAt = Date.now();
    logger.info({ intervalMs: HEALTH_CHECK_INTERVAL_MS }, 'Health checker started');

    this.intervalId = setInterval(() => {
      this.check();
    }, HEALTH_CHECK_INTERVAL_MS);

    // Run immediately
    this.check();
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      logger.info('Health checker stopped');
    }
  }

  getLatestStatus(): HealthStatus | null {
    return this.latestStatus;
  }

  onStatus(listener: (status: HealthStatus) => void): void {
    this.listeners.push(listener);
  }

  private check(): void {
    try {
      const now = Date.now();

      // Check DB
      let dbStatus: HealthStatus['db'] = 'ok';
      try {
        getDailyCost(); // simple probe
      } catch {
        dbStatus = 'unreachable';
      }

      // Check LLM circuit breaker
      const circuitState = this.getCircuitState();
      let llmStatus: HealthStatus['llm'] = 'ok';
      if (circuitState === 'open') llmStatus = 'circuit_open';

      // Check active runs + stalled
      let activeAgents = 0;
      let stalledTasks = 0;
      try {
        const runs = getActiveRuns();
        activeAgents = runs.length;
        for (const run of runs) {
          const stalledMs = now - new Date(run.updated_at).getTime();
          if (stalledMs > LLM_CALL_STALL_DEFAULT_MS) stalledTasks++;
        }
      } catch {
        // DB unreachable, already caught above
      }

      // Daily cost
      let dailyCostUsd = 0;
      try {
        dailyCostUsd = getDailyCost();
      } catch {
        // ignore
      }

      // Determine overall HQ status
      let hqStatus: HealthStatus['hq'] = 'ok';
      if (dbStatus === 'unreachable' || llmStatus === 'circuit_open') {
        hqStatus = 'degraded';
      }
      if (dbStatus === 'unreachable' && llmStatus !== 'ok') {
        hqStatus = 'down';
      }

      const status: HealthStatus = {
        hq: hqStatus,
        db: dbStatus,
        llm: llmStatus,
        activeAgents,
        stalledTasks,
        dailyCostUsd,
        uptimeMs: now - this.startedAt,
        checkedAt: new Date().toISOString(),
      };

      this.latestStatus = status;

      // Record heartbeat event
      this.observer.recordEvent({ type: 'heartbeat_tick' });
      this.observer.recordMetric({ type: 'active_tasks', count: activeAgents });

      // Notify listeners (War Room watcher, etc.)
      for (const listener of this.listeners) {
        try { listener(status); } catch { /* don't let listener errors break health loop */ }
      }

      // Log warnings
      if (stalledTasks > 0) {
        logger.warn({ stalledTasks }, 'Stalled tasks detected');
      }
      if (dailyCostUsd >= DAILY_BUDGET_USD * 0.9) {
        logger.warn({ dailyCostUsd, budget: DAILY_BUDGET_USD }, 'Approaching daily budget');
      }
    } catch (err) {
      logger.error({ error: err instanceof Error ? err.message : String(err) }, 'Health check failed');
      this.observer.recordEvent({ type: 'error', component: 'health', message: String(err) });
    }
  }
}
