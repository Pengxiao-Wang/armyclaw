import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ─── Mocks ──────────────────────────────────────────────────

vi.mock('../src/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// Mock the db module (used by HealthChecker)
const mockGetDailyCost = vi.fn().mockReturnValue(0);
const mockGetActiveRuns = vi.fn().mockReturnValue([]);
vi.mock('../src/kernel/db.js', () => ({
  getDailyCost: (...args: unknown[]) => mockGetDailyCost(...args),
  getActiveRuns: (...args: unknown[]) => mockGetActiveRuns(...args),
}));

// Mock config values
vi.mock('../src/config.js', () => ({
  LLM_CALL_STALL_DEFAULT_MS: 120_000,
  DAILY_BUDGET_USD: 50,
  HEALTH_CHECK_INTERVAL_MS: 10_000,
}));

import { LogObserver } from '../src/kernel/observability/log-observer.js';
import { HealthChecker } from '../src/kernel/observability/health.js';
import { logger } from '../src/logger.js';
import type { Observer, ObserverEvent, ObserverMetric, HealthStatus } from '../src/types.js';

// ═══════════════════════════════════════════════════════════
// LogObserver Tests
// ═══════════════════════════════════════════════════════════

describe('LogObserver', () => {
  let observer: LogObserver;

  beforeEach(() => {
    observer = new LogObserver();
    vi.clearAllMocks();
  });

  it('should have name "log"', () => {
    expect(observer.name).toBe('log');
  });

  // ─── Event recording ─────────────────────────────────────

  it('should record agent_start event', () => {
    observer.recordEvent({ type: 'agent_start', role: 'adjutant', model: 'claude-sonnet-4-20250514' });
    expect(logger.info).toHaveBeenCalledWith(
      { role: 'adjutant', model: 'claude-sonnet-4-20250514' },
      'agent.start',
    );
  });

  it('should record llm_request event', () => {
    observer.recordEvent({ type: 'llm_request', model: 'claude-opus-4-20250514', messageCount: 5 });
    expect(logger.debug).toHaveBeenCalledWith(
      { model: 'claude-opus-4-20250514', messages: 5 },
      'llm.request',
    );
  });

  it('should record successful llm_response event', () => {
    observer.recordEvent({ type: 'llm_response', model: 'claude-sonnet-4-20250514', durationMs: 1200, success: true });
    expect(logger.info).toHaveBeenCalledWith(
      { model: 'claude-sonnet-4-20250514', durationMs: 1200 },
      'llm.response',
    );
  });

  it('should record failed llm_response event', () => {
    observer.recordEvent({ type: 'llm_response', model: 'claude-sonnet-4-20250514', durationMs: 500, success: false, error: 'timeout' });
    expect(logger.error).toHaveBeenCalledWith(
      { model: 'claude-sonnet-4-20250514', durationMs: 500, error: 'timeout' },
      'llm.response.error',
    );
  });

  it('should record tool_call event', () => {
    observer.recordEvent({ type: 'tool_call', tool: 'run', durationMs: 300, success: true });
    expect(logger.info).toHaveBeenCalledWith(
      { tool: 'run', durationMs: 300, success: true },
      'tool.call',
    );
  });

  it('should record task_transition event', () => {
    observer.recordEvent({ type: 'task_transition', taskId: 'task-abc', from: 'RECEIVED', to: 'PLANNING' });
    expect(logger.info).toHaveBeenCalledWith(
      { taskId: 'task-abc', from: 'RECEIVED', to: 'PLANNING' },
      'task.transition',
    );
  });

  it('should record heartbeat_tick event', () => {
    observer.recordEvent({ type: 'heartbeat_tick' });
    expect(logger.debug).toHaveBeenCalledWith('heartbeat.tick');
  });

  it('should record error event', () => {
    observer.recordEvent({ type: 'error', component: 'health', message: 'DB down' });
    expect(logger.error).toHaveBeenCalledWith(
      { component: 'health', message: 'DB down' },
      'system.error',
    );
  });

  // ─── Metric recording ────────────────────────────────────

  it('should record request_latency metric', () => {
    observer.recordMetric({ type: 'request_latency', ms: 450 });
    expect(logger.debug).toHaveBeenCalledWith(
      { metric: 'request_latency', value: 450 },
      'metric',
    );
  });

  it('should record tokens_used metric', () => {
    observer.recordMetric({ type: 'tokens_used', count: 5000 });
    expect(logger.debug).toHaveBeenCalledWith(
      { metric: 'tokens_used', value: 5000 },
      'metric',
    );
  });

  it('should record active_tasks metric', () => {
    observer.recordMetric({ type: 'active_tasks', count: 3 });
    expect(logger.debug).toHaveBeenCalledWith(
      { metric: 'active_tasks', value: 3 },
      'metric',
    );
  });

  it('should record queue_depth metric', () => {
    observer.recordMetric({ type: 'queue_depth', count: 12 });
    expect(logger.debug).toHaveBeenCalledWith(
      { metric: 'queue_depth', value: 12 },
      'metric',
    );
  });

  // ─── Flush ────────────────────────────────────────────────

  it('flush() should not throw', () => {
    expect(() => observer.flush()).not.toThrow();
  });

  // ─── All event types without error ────────────────────────

  it('should handle all event types without throwing', () => {
    const events: ObserverEvent[] = [
      { type: 'agent_start', role: 'adjutant', model: 'test' },
      { type: 'llm_request', model: 'test', messageCount: 1 },
      { type: 'llm_response', model: 'test', durationMs: 100, success: true },
      { type: 'llm_response', model: 'test', durationMs: 100, success: false, error: 'err' },
      { type: 'tool_call', tool: 'run', durationMs: 50, success: true },
      { type: 'task_transition', taskId: 't1', from: 'A', to: 'B' },
      { type: 'heartbeat_tick' },
      { type: 'error', component: 'test', message: 'boom' },
    ];
    for (const event of events) {
      expect(() => observer.recordEvent(event)).not.toThrow();
    }
  });

  it('should handle all metric types without throwing', () => {
    const metrics: ObserverMetric[] = [
      { type: 'request_latency', ms: 100 },
      { type: 'tokens_used', count: 1000 },
      { type: 'active_tasks', count: 2 },
      { type: 'queue_depth', count: 5 },
    ];
    for (const metric of metrics) {
      expect(() => observer.recordMetric(metric)).not.toThrow();
    }
  });
});

// ═══════════════════════════════════════════════════════════
// HealthChecker Tests
// ═══════════════════════════════════════════════════════════

describe('HealthChecker', () => {
  let healthChecker: HealthChecker;
  let mockObserver: Observer;
  let getCircuitState: () => string;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();

    mockObserver = {
      name: 'test',
      recordEvent: vi.fn(),
      recordMetric: vi.fn(),
      flush: vi.fn(),
    };

    getCircuitState = vi.fn().mockReturnValue('closed');
    mockGetDailyCost.mockReturnValue(0);
    mockGetActiveRuns.mockReturnValue([]);

    healthChecker = new HealthChecker(mockObserver, getCircuitState);
  });

  afterEach(() => {
    healthChecker.stop();
    vi.useRealTimers();
  });

  // ─── Valid HealthStatus ───────────────────────────────────

  it('should produce a valid HealthStatus on start', () => {
    healthChecker.start();
    const status = healthChecker.getLatestStatus();
    expect(status).not.toBeNull();
    expect(status!.hq).toBe('ok');
    expect(status!.db).toBe('ok');
    expect(status!.llm).toBe('ok');
    expect(status!.activeAgents).toBe(0);
    expect(status!.stalledTasks).toBe(0);
    expect(status!.dailyCostUsd).toBe(0);
    expect(status!.uptimeMs).toBeGreaterThanOrEqual(0);
    expect(status!.checkedAt).toBeTruthy();
  });

  it('should return null status before start', () => {
    expect(healthChecker.getLatestStatus()).toBeNull();
  });

  // ─── Listener notification ────────────────────────────────

  it('should call listeners on each check', () => {
    const listener = vi.fn();
    healthChecker.onStatus(listener);
    healthChecker.start();

    // start() calls check() immediately
    expect(listener).toHaveBeenCalledTimes(1);
    const status = listener.mock.calls[0][0] as HealthStatus;
    expect(status.hq).toBe('ok');

    // Advance timer to trigger another check
    vi.advanceTimersByTime(10_000);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('should support multiple listeners', () => {
    const l1 = vi.fn();
    const l2 = vi.fn();
    healthChecker.onStatus(l1);
    healthChecker.onStatus(l2);
    healthChecker.start();
    expect(l1).toHaveBeenCalledTimes(1);
    expect(l2).toHaveBeenCalledTimes(1);
  });

  // ─── Stalled task detection ───────────────────────────────

  it('should detect stalled tasks (updated_at > STALL_THRESHOLD_MS ago)', () => {
    const staleTime = new Date(Date.now() - 200_000).toISOString(); // 200s ago > 120s threshold
    mockGetActiveRuns.mockReturnValue([
      { task_id: 'task-1', agent_role: 'engineer', updated_at: staleTime },
    ]);

    healthChecker.start();
    const status = healthChecker.getLatestStatus()!;
    expect(status.stalledTasks).toBe(1);
    expect(status.activeAgents).toBe(1);
  });

  it('should not flag fresh tasks as stalled', () => {
    const freshTime = new Date(Date.now() - 5_000).toISOString(); // 5s ago
    mockGetActiveRuns.mockReturnValue([
      { task_id: 'task-1', agent_role: 'engineer', updated_at: freshTime },
    ]);

    healthChecker.start();
    const status = healthChecker.getLatestStatus()!;
    expect(status.stalledTasks).toBe(0);
    expect(status.activeAgents).toBe(1);
  });

  // ─── Budget warning ───────────────────────────────────────

  it('should detect budget warnings (>= 90% of daily budget)', () => {
    mockGetDailyCost.mockReturnValue(46); // 92% of $50

    healthChecker.start();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ dailyCostUsd: 46 }),
      'Approaching daily budget',
    );
  });

  it('should not warn when budget is comfortably below threshold', () => {
    mockGetDailyCost.mockReturnValue(10); // 20% of $50

    healthChecker.start();
    expect(logger.warn).not.toHaveBeenCalledWith(
      expect.objectContaining({ budget: expect.any(Number) }),
      'Approaching daily budget',
    );
  });

  // ─── Circuit open detection ───────────────────────────────

  it('should detect LLM circuit breaker open state', () => {
    (getCircuitState as ReturnType<typeof vi.fn>).mockReturnValue('open');

    healthChecker.start();
    const status = healthChecker.getLatestStatus()!;
    expect(status.llm).toBe('circuit_open');
    expect(status.hq).toBe('degraded');
  });

  // ─── DB error handling ────────────────────────────────────

  it('should handle DB errors gracefully (mark db as unreachable)', () => {
    mockGetDailyCost.mockImplementation(() => { throw new Error('DB connection failed'); });

    healthChecker.start();
    const status = healthChecker.getLatestStatus()!;
    expect(status.db).toBe('unreachable');
    expect(status.hq).toBe('degraded');
  });

  it('should mark hq as "down" when both db and llm are failing', () => {
    mockGetDailyCost.mockImplementation(() => { throw new Error('DB down'); });
    (getCircuitState as ReturnType<typeof vi.fn>).mockReturnValue('open');

    healthChecker.start();
    const status = healthChecker.getLatestStatus()!;
    expect(status.db).toBe('unreachable');
    expect(status.llm).toBe('circuit_open');
    expect(status.hq).toBe('down');
  });

  // ─── Start/stop lifecycle ─────────────────────────────────

  it('should not run checks when stopped', () => {
    healthChecker.start();
    expect(healthChecker.getLatestStatus()).not.toBeNull();

    healthChecker.stop();

    // Clear mock to verify no more calls
    (mockObserver.recordEvent as ReturnType<typeof vi.fn>).mockClear();

    // Advance timer — should not trigger any more checks
    vi.advanceTimersByTime(30_000);
    expect(mockObserver.recordEvent).not.toHaveBeenCalled();
  });

  it('should be safe to call stop() multiple times', () => {
    healthChecker.start();
    expect(() => {
      healthChecker.stop();
      healthChecker.stop();
    }).not.toThrow();
  });

  it('should be safe to call start() when already started (no-op)', () => {
    healthChecker.start();
    const firstStatus = healthChecker.getLatestStatus();
    healthChecker.start(); // should be a no-op
    const secondStatus = healthChecker.getLatestStatus();
    // Should still be the same checker
    expect(secondStatus).toEqual(firstStatus);
  });

  // ─── Observer integration ─────────────────────────────────

  it('should record heartbeat_tick events via observer', () => {
    healthChecker.start();
    expect(mockObserver.recordEvent).toHaveBeenCalledWith({ type: 'heartbeat_tick' });
  });

  it('should record active_tasks metric via observer', () => {
    mockGetActiveRuns.mockReturnValue([
      { task_id: 't1', updated_at: new Date().toISOString() },
      { task_id: 't2', updated_at: new Date().toISOString() },
    ]);

    healthChecker.start();
    expect(mockObserver.recordMetric).toHaveBeenCalledWith({ type: 'active_tasks', count: 2 });
  });

  // ─── Listener error isolation ─────────────────────────────

  it('should not break health loop if a listener throws', () => {
    const badListener = vi.fn().mockImplementation(() => { throw new Error('listener crash'); });
    const goodListener = vi.fn();

    healthChecker.onStatus(badListener);
    healthChecker.onStatus(goodListener);
    healthChecker.start();

    // Both should be called, and health checker should continue
    expect(badListener).toHaveBeenCalledTimes(1);
    expect(goodListener).toHaveBeenCalledTimes(1);
    expect(healthChecker.getLatestStatus()).not.toBeNull();
  });

  // ─── Overall check failure handling ───────────────────────

  it('should record error event if entire check throws unexpectedly', () => {
    // Make getCircuitState throw to simulate an unexpected error in check()
    (getCircuitState as ReturnType<typeof vi.fn>).mockImplementation(() => { throw new Error('circuit state crash'); });
    // But first getDailyCost must succeed (it's called before getCircuitState)
    mockGetDailyCost.mockReturnValue(0);

    healthChecker.start();

    // The error should be caught and logged
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.stringContaining('circuit state crash') }),
      'Health check failed',
    );
    expect(mockObserver.recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error', component: 'health' }),
    );
  });
});
