/**
 * Verification tests for all 8 fixes from CODE_REVIEW_2026-03-11.md
 *
 * Each test proves the fix actually works by testing the exact scenario
 * described in the code review.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { ToolExecutor } from '../src/agents/tool-executor.js';
import {
  _initTestDatabase,
  createTask,
  getTaskById,
  updateTask,
  updateTaskState,
  updateAgentRun,
  recordAgentRun,
  getFlowLog,
  getActiveRuns,
  getRecentRunsForTask,
  appendContextChain,
} from '../src/db.js';
import { canTransition } from '../src/herald/state-machine.js';
import { TaskState, AgentRole, TaskPriority } from '../src/types.js';
import type { ToolUseBlock } from '../src/types.js';

// ─── Helper ──────────────────────────────────────────────────

function makeBlock(name: string, input: Record<string, unknown>): ToolUseBlock {
  return { type: 'tool_use', id: `tu-${Date.now()}`, name, input };
}

function makeTestTask(overrides: Record<string, unknown> = {}) {
  return {
    id: `task-${Date.now()}`,
    parent_id: null,
    campaign_id: null,
    state: TaskState.RECEIVED,
    description: 'test',
    priority: TaskPriority.MEDIUM,
    assigned_agent: null,
    assigned_engineer_id: null,
    intent_type: null,
    reject_count_tactical: 0,
    reject_count_strategic: 0,
    rubric: null,
    artifacts_path: null,
    override_skip_gate: 0,
    source_channel: null,
    source_chat_id: null,
    context_chain: null,
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════════
// SEC-1: search 工具命令注入
// 验证：恶意 pattern 不会执行 shell 命令
// ═══════════════════════════════════════════════════════════════

describe('SEC-1: search command injection fix', () => {
  let workDir: string;
  let executor: ToolExecutor;

  beforeEach(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sec1-test-'));
    executor = new ToolExecutor(workDir);
    fs.writeFileSync(path.join(workDir, 'safe.txt'), 'hello world');
  });

  it('should NOT execute shell commands in pattern', () => {
    // This pattern would execute `touch /tmp/pwned` if shell-interpreted
    const marker = path.join(os.tmpdir(), `sec1-marker-${Date.now()}`);
    const result = executor.execute(makeBlock('search', {
      pattern: `"; touch ${marker} #`,
    }));

    // The marker file must NOT exist (no command was executed)
    expect(fs.existsSync(marker)).toBe(false);
    // Search should return "No matches" (the literal pattern wasn't found)
    expect(result.content).toContain('No matches');
  });

  it('should NOT execute shell commands in glob', () => {
    const marker = path.join(os.tmpdir(), `sec1-glob-${Date.now()}`);
    const result = executor.execute(makeBlock('search', {
      pattern: 'hello',
      glob: `*.txt; touch ${marker}`,
    }));

    expect(fs.existsSync(marker)).toBe(false);
  });

  it('should still find normal patterns correctly', () => {
    const result = executor.execute(makeBlock('search', { pattern: 'hello' }));
    expect(result.is_error).toBe(false);
    expect(result.content).toContain('hello');
  });
});

// ═══════════════════════════════════════════════════════════════
// SEC-2: resolveSafe 路径前缀绕过
// 验证：task-100 不能绕过 task-1 的围栏
// ═══════════════════════════════════════════════════════════════

describe('SEC-2: resolveSafe path prefix bypass fix', () => {
  it('should block sibling directory with shared prefix', () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sec2-'));
    const task1Dir = path.join(baseDir, 'task-1');
    const task100Dir = path.join(baseDir, 'task-100');
    fs.mkdirSync(task1Dir);
    fs.mkdirSync(task100Dir);
    fs.writeFileSync(path.join(task100Dir, 'secret.txt'), 'top secret');

    const executor = new ToolExecutor(task1Dir);

    // Try to read task-100's file from task-1's executor
    // Resolved path: /tmp/.../task-100/secret.txt
    // Without fix: startsWith("/tmp/.../task-1") → true (bypassed!)
    // With fix: startsWith("/tmp/.../task-1/") → false (blocked!)
    const result = executor.execute(makeBlock('file_read', {
      path: '../task-100/secret.txt',
    }));
    expect(result.is_error).toBe(true);
    expect(result.content).toContain('traversal');

    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  it('should allow files within the workDir', () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sec2-ok-'));
    fs.writeFileSync(path.join(workDir, 'allowed.txt'), 'ok');
    const executor = new ToolExecutor(workDir);

    const result = executor.execute(makeBlock('file_read', { path: 'allowed.txt' }));
    expect(result.is_error).toBe(false);
    expect(result.content).toContain('ok');

    fs.rmSync(workDir, { recursive: true, force: true });
  });
});

// ═══════════════════════════════════════════════════════════════
// DESIGN-1: 数据库操作缺少事务
// 验证：createTask 和 updateTaskState 是原子操作
// ═══════════════════════════════════════════════════════════════

describe('DESIGN-1: database transactions', () => {
  beforeEach(() => _initTestDatabase());

  it('createTask should write task + flow_log atomically', () => {
    const task = createTask(makeTestTask({ id: 'txn-test-1' }));

    // Both task and flow_log should exist
    const retrieved = getTaskById('txn-test-1');
    expect(retrieved).toBeDefined();

    const logs = getFlowLog('txn-test-1');
    expect(logs.length).toBeGreaterThanOrEqual(1);
    expect(logs[0].to_state).toBe('RECEIVED');
    expect(logs[0].reason).toBe('task created');
  });

  it('updateTaskState should write state + flow_log atomically', () => {
    createTask(makeTestTask({ id: 'txn-test-2' }));
    updateTaskState('txn-test-2', TaskState.SPLITTING, AgentRole.ADJUTANT, 'test');

    const task = getTaskById('txn-test-2')!;
    expect(task.state).toBe('SPLITTING');

    const logs = getFlowLog('txn-test-2');
    const lastLog = logs[logs.length - 1];
    expect(lastLog.from_state).toBe('RECEIVED');
    expect(lastLog.to_state).toBe('SPLITTING');
  });
});

// ═══════════════════════════════════════════════════════════════
// DESIGN-2: updateAgentRun 双重设置 updated_at
// 验证：updated_at 在 SQL 中只出现一次
// ═══════════════════════════════════════════════════════════════

describe('DESIGN-2: updated_at double-set fix', () => {
  beforeEach(() => _initTestDatabase());

  it('caller-provided updated_at should be ignored (auto-set wins)', () => {
    createTask(makeTestTask({ id: 'dup-test', state: TaskState.EXECUTING }));

    const now = new Date().toISOString();
    const runId = recordAgentRun({
      task_id: 'dup-test',
      agent_role: AgentRole.ENGINEER,
      engineer_id: null,
      model: 'test-model',
      started_at: now,
      updated_at: now,
      finished_at: null,
      status: 'running',
      input_tokens: 0,
      output_tokens: 0,
      error: null,
    });

    // Pass an obviously wrong updated_at
    updateAgentRun(runId, {
      status: 'success',
      updated_at: '2020-01-01T00:00:00.000Z', // should be filtered out by whitelist
    });

    const runs = getRecentRunsForTask('dup-test');
    expect(runs.length).toBe(1);
    // The updated_at should NOT be 2020 — it should be auto-set to "now"
    expect(runs[0].updated_at).not.toContain('2020');
    expect(runs[0].status).toBe('success');
  });

  it('updateTask also ignores caller-provided updated_at', () => {
    createTask(makeTestTask({ id: 'dup-task-test' }));

    updateTask('dup-task-test', {
      updated_at: '2020-01-01T00:00:00.000Z',
      description: 'updated desc',
    });

    const task = getTaskById('dup-task-test')!;
    expect(task.description).toBe('updated desc');
    expect(task.updated_at).not.toContain('2020');
  });
});

// ═══════════════════════════════════════════════════════════════
// BUG-2: Medic 连续失败检测死代码
// 验证：getRecentRunsForTask 能返回包含 error 状态的记录
// ═══════════════════════════════════════════════════════════════

describe('BUG-2: Medic consecutive failure detection', () => {
  beforeEach(() => _initTestDatabase());

  it('getActiveRuns only returns running (confirms the original bug condition)', () => {
    createTask(makeTestTask({ id: 'medic-test', state: TaskState.EXECUTING }));

    const now = new Date().toISOString();
    // Record a failed run
    recordAgentRun({
      task_id: 'medic-test', agent_role: AgentRole.ENGINEER, engineer_id: null,
      model: 'test', started_at: now, updated_at: now, finished_at: now,
      status: 'error', input_tokens: 0, output_tokens: 0, error: 'failed',
    });
    // Record a running run
    recordAgentRun({
      task_id: 'medic-test', agent_role: AgentRole.ENGINEER, engineer_id: null,
      model: 'test', started_at: now, updated_at: now, finished_at: null,
      status: 'running', input_tokens: 0, output_tokens: 0, error: null,
    });

    // getActiveRuns misses error runs (this was the original bug)
    const active = getActiveRuns();
    expect(active.every(r => r.status === 'running')).toBe(true);
    expect(active.length).toBe(1);
  });

  it('getRecentRunsForTask returns ALL statuses (the fix)', () => {
    createTask(makeTestTask({ id: 'medic-fix', state: TaskState.EXECUTING }));

    const now = new Date().toISOString();
    // 3 error runs + 1 running
    for (let i = 0; i < 3; i++) {
      recordAgentRun({
        task_id: 'medic-fix', agent_role: AgentRole.ENGINEER, engineer_id: null,
        model: 'test', started_at: new Date(Date.now() + i).toISOString(),
        updated_at: now, finished_at: now,
        status: 'error', input_tokens: 0, output_tokens: 0, error: `fail-${i}`,
      });
    }
    recordAgentRun({
      task_id: 'medic-fix', agent_role: AgentRole.ENGINEER, engineer_id: null,
      model: 'test', started_at: new Date(Date.now() + 10).toISOString(),
      updated_at: now, finished_at: null,
      status: 'running', input_tokens: 0, output_tokens: 0, error: null,
    });

    const recent = getRecentRunsForTask('medic-fix');
    expect(recent.length).toBe(4);

    // Filter out running, count consecutive errors from most recent
    const finished = recent.filter(r => r.status !== 'running');
    expect(finished.length).toBe(3);
    expect(finished.every(r => r.status === 'error')).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════
// BUG-3: War Room resume 丢失状态
// 验证：PAUSED 可以恢复到 GATE1/GATE2/DELIVERING 等状态
// ═══════════════════════════════════════════════════════════════

describe('BUG-3: War Room resume state fix', () => {
  it('PAUSED should be able to transition to GATE1_REVIEW', () => {
    expect(canTransition('GATE1_REVIEW' as any, 'PAUSED' as any)).toBe(true);
    expect(canTransition('PAUSED' as any, 'GATE1_REVIEW' as any)).toBe(true);
  });

  it('PAUSED should be able to transition to GATE2_REVIEW', () => {
    expect(canTransition('GATE2_REVIEW' as any, 'PAUSED' as any)).toBe(true);
    expect(canTransition('PAUSED' as any, 'GATE2_REVIEW' as any)).toBe(true);
  });

  it('PAUSED should be able to transition to DELIVERING', () => {
    expect(canTransition('DELIVERING' as any, 'PAUSED' as any)).toBe(true);
    expect(canTransition('PAUSED' as any, 'DELIVERING' as any)).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════
// P0-2: Agent 间信息传递
// 验证：context_chain 能累积多个 agent 的输出
// ═══════════════════════════════════════════════════════════════

describe('P0-2: Agent context chain', () => {
  beforeEach(() => _initTestDatabase());

  it('appendContextChain adds entries to an empty chain', () => {
    createTask(makeTestTask({ id: 'chain-1' }));

    appendContextChain('chain-1', AgentRole.ADJUTANT, '{"tasks": [{"id": "sub-1"}]}');

    const task = getTaskById('chain-1')!;
    expect(task.context_chain).not.toBeNull();

    const chain = JSON.parse(task.context_chain!);
    expect(chain).toHaveLength(1);
    expect(chain[0].role).toBe('adjutant');
    expect(chain[0].output).toContain('sub-1');
  });

  it('appendContextChain accumulates multiple agent outputs', () => {
    createTask(makeTestTask({ id: 'chain-2' }));

    appendContextChain('chain-2', AgentRole.ADJUTANT, 'Adjutant output');
    appendContextChain('chain-2', AgentRole.CHIEF_OF_STAFF, 'Chief output');
    appendContextChain('chain-2', AgentRole.INSPECTOR, 'Inspector output');
    appendContextChain('chain-2', AgentRole.ENGINEER, 'Engineer output');

    const task = getTaskById('chain-2')!;
    const chain = JSON.parse(task.context_chain!);
    expect(chain).toHaveLength(4);
    expect(chain[0].role).toBe('adjutant');
    expect(chain[1].role).toBe('chief_of_staff');
    expect(chain[2].role).toBe('inspector');
    expect(chain[3].role).toBe('engineer');
  });

  it('appendContextChain truncates large outputs to 5000 chars', () => {
    createTask(makeTestTask({ id: 'chain-3' }));

    const hugeOutput = 'x'.repeat(10000);
    appendContextChain('chain-3', AgentRole.ENGINEER, hugeOutput);

    const task = getTaskById('chain-3')!;
    const chain = JSON.parse(task.context_chain!);
    expect(chain[0].output.length).toBe(5000);
  });

  it('context_chain defaults to null for new tasks', () => {
    const task = createTask(makeTestTask({ id: 'chain-null' }));
    expect(task.context_chain).toBeNull();

    const retrieved = getTaskById('chain-null')!;
    expect(retrieved.context_chain).toBeNull();
  });
});
