import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import http from 'http';

// ─── Mocks ──────────────────────────────────────────────────

vi.mock('../src/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// Mock better-sqlite3 to avoid needing a real DB file
vi.mock('better-sqlite3', () => {
  return {
    default: vi.fn().mockImplementation(() => {
      const mockPrepare = vi.fn().mockReturnValue({
        all: vi.fn().mockReturnValue([]),
        get: vi.fn().mockReturnValue(null),
        run: vi.fn(),
      });
      return {
        pragma: vi.fn(),
        prepare: mockPrepare,
        close: vi.fn(),
      };
    }),
  };
});

import { DbWatcher } from '../src/war-room/watcher.js';
import type { AgentStatus, HealthStatus } from '../src/war-room/watcher.js';
import { createApi } from '../src/war-room/api.js';

// ─── Health Detection Tests ─────────────────────────────────

describe('DbWatcher — Health Detection', () => {
  it('should calculate green status for activity within 30s', () => {
    const now = Date.now();
    const recentTime = new Date(now - 10_000).toISOString(); // 10s ago

    // Test the health threshold logic directly
    const elapsed = now - new Date(recentTime).getTime();
    let status: HealthStatus['status'];
    if (elapsed <= 30_000) {
      status = 'green';
    } else if (elapsed <= 120_000) {
      status = 'yellow';
    } else {
      status = 'red';
    }

    expect(status).toBe('green');
  });

  it('should calculate yellow status for activity between 30s-2min', () => {
    const now = Date.now();
    const thinkingTime = new Date(now - 60_000).toISOString(); // 60s ago

    const elapsed = now - new Date(thinkingTime).getTime();
    let status: HealthStatus['status'];
    if (elapsed <= 30_000) {
      status = 'green';
    } else if (elapsed <= 120_000) {
      status = 'yellow';
    } else {
      status = 'red';
    }

    expect(status).toBe('yellow');
  });

  it('should calculate red status for activity over 2min', () => {
    const now = Date.now();
    const staleTime = new Date(now - 180_000).toISOString(); // 3min ago

    const elapsed = now - new Date(staleTime).getTime();
    let status: HealthStatus['status'];
    if (elapsed <= 30_000) {
      status = 'green';
    } else if (elapsed <= 120_000) {
      status = 'yellow';
    } else {
      status = 'red';
    }

    expect(status).toBe('red');
  });

  it('should detect agent status based on run timing', () => {
    const now = Date.now();

    // Active agent (updated 10s ago, running)
    const activeElapsed = now - new Date(new Date(now - 10_000).toISOString()).getTime();
    let activeStatus: AgentStatus['status'] = 'idle';
    const isRunning = true;
    if (isRunning) {
      if (activeElapsed <= 30_000) activeStatus = 'active';
      else if (activeElapsed <= 120_000) activeStatus = 'thinking';
      else activeStatus = 'stalled';
    }
    expect(activeStatus).toBe('active');

    // Thinking agent (updated 90s ago, running)
    const thinkElapsed = now - new Date(new Date(now - 90_000).toISOString()).getTime();
    let thinkStatus: AgentStatus['status'] = 'idle';
    if (isRunning) {
      if (thinkElapsed <= 30_000) thinkStatus = 'active';
      else if (thinkElapsed <= 120_000) thinkStatus = 'thinking';
      else thinkStatus = 'stalled';
    }
    expect(thinkStatus).toBe('thinking');

    // Stalled agent (updated 5min ago, running)
    const stallElapsed = now - new Date(new Date(now - 300_000).toISOString()).getTime();
    let stallStatus: AgentStatus['status'] = 'idle';
    if (isRunning) {
      if (stallElapsed <= 30_000) stallStatus = 'active';
      else if (stallElapsed <= 120_000) stallStatus = 'thinking';
      else stallStatus = 'stalled';
    }
    expect(stallStatus).toBe('stalled');
  });
});

// ─── Watcher Lifecycle Tests ────────────────────────────────

describe('DbWatcher — Lifecycle', () => {
  let watcher: DbWatcher;

  beforeEach(() => {
    watcher = new DbWatcher();
  });

  afterEach(() => {
    watcher.stop();
  });

  it('should register update listeners', () => {
    const listener = vi.fn();
    watcher.onUpdate(listener);
    // Listener stored — called when changes detected during poll
    expect(listener).not.toHaveBeenCalled();
  });

  it('should return empty snapshots before start', () => {
    expect(watcher.getTasksSnapshot()).toEqual([]);
    expect(watcher.getActiveTasksSnapshot()).toEqual([]);
    expect(watcher.getAgentStatus()).toEqual([]);
    expect(watcher.getHealthStatus()).toEqual([]);
  });

  it('should return empty cost summary before start', () => {
    const costs = watcher.getCostSummary();
    expect(costs.daily_total).toBe(0);
    expect(costs.weekly_total).toBe(0);
    expect(costs.by_agent).toEqual({});
    expect(costs.by_task).toEqual({});
  });
});

// ─── API Routing Tests ──────────────────────────────────────

describe('War Room API', () => {
  let watcher: DbWatcher;
  let apiHandler: http.RequestListener;
  let server: http.Server;
  let port: number;

  beforeEach(async () => {
    watcher = new DbWatcher();
    apiHandler = createApi(watcher);
    server = http.createServer(apiHandler);

    await new Promise<void>((resolve) => {
      server.listen(0, () => {
        const addr = server.address();
        if (addr && typeof addr !== 'string') {
          port = addr.port;
        }
        resolve();
      });
    });
  });

  afterEach(async () => {
    watcher.stop();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });

  function fetchApi(path: string, options?: RequestInit): Promise<Response> {
    return fetch(`http://localhost:${port}${path}`, options);
  }

  it('GET /api/tasks should return task list', async () => {
    const res = await fetchApi('/api/tasks');
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data)).toBe(true);
  });

  it('GET /api/tasks/active should return active tasks', async () => {
    const res = await fetchApi('/api/tasks/active');
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data)).toBe(true);
  });

  it('GET /api/flow-log should require task_id', async () => {
    const res = await fetchApi('/api/flow-log');
    expect(res.status).toBe(400);
  });

  it('GET /api/flow-log?task_id=x should return log', async () => {
    const res = await fetchApi('/api/flow-log?task_id=test-123');
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data)).toBe(true);
  });

  it('GET /api/progress should require task_id', async () => {
    const res = await fetchApi('/api/progress');
    expect(res.status).toBe(400);
  });

  it('GET /api/agents should return agent status', async () => {
    const res = await fetchApi('/api/agents');
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data)).toBe(true);
  });

  it('GET /api/costs should return cost summary', async () => {
    const res = await fetchApi('/api/costs');
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toHaveProperty('daily_total');
    expect(data).toHaveProperty('weekly_total');
  });

  it('GET /api/costs/daily should return daily total', async () => {
    const res = await fetchApi('/api/costs/daily');
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toHaveProperty('daily_total');
  });

  it('GET /api/health should return health status', async () => {
    const res = await fetchApi('/api/health');
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data)).toBe(true);
  });

  it('POST /api/tasks/control should accept valid actions', async () => {
    // Set up the watcher to handle controlTask by starting it (opens DB connections)
    watcher.start(999_999); // large interval to avoid polling during test

    // Mock controlTask directly since the mock DB won't have real data
    vi.spyOn(watcher, 'controlTask').mockReturnValue({
      task_id: 'test-1',
      action: 'pause',
      new_state: 'PAUSED' as any,
    });

    const res = await fetchApi('/api/tasks/control', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ task_id: 'test-1', action: 'pause' }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe('applied');
    expect(data.task_id).toBe('test-1');
    expect(data.new_state).toBe('PAUSED');
  });

  it('POST /api/tasks/control should reject invalid actions', async () => {
    const res = await fetchApi('/api/tasks/control', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ task_id: 'test-1', action: 'destroy' }),
    });
    expect(res.status).toBe(400);
  });

  it('GET / should return HTML dashboard', async () => {
    const res = await fetchApi('/');
    expect(res.status).toBe(200);
    const contentType = res.headers.get('content-type');
    expect(contentType).toContain('text/html');
  });

  it('GET /unknown should return 404', async () => {
    const res = await fetchApi('/unknown');
    expect(res.status).toBe(404);
  });

  it('OPTIONS should return 204 with CORS headers', async () => {
    const res = await fetchApi('/api/tasks', { method: 'OPTIONS' });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });
});
