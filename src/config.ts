import path from 'path';
import { AgentRole } from './types.js';

export const PROJECT_DIR = process.env.ARMYCLAW_PROJECT_DIR || process.cwd();
export const DATA_DIR = process.env.ARMYCLAW_DATA_DIR || path.join(process.cwd(), 'data');
export const DB_PATH = path.join(DATA_DIR, 'armyclaw.db');
export const TASKS_DIR = path.join(DATA_DIR, 'tasks');
export const SOULS_DIR = path.join(process.cwd(), 'souls');

// Concurrency
export const MAX_CONCURRENT_ENGINEERS = parseInt(process.env.MAX_ENGINEERS || '5', 10);

// Subtask limits — prevent over-splitting and slot starvation
export const MAX_SUBTASKS_HARD_CAP = 8;
export const SUBTASK_SLOT_RESERVE = 1; // reserve slot(s) for new task responsiveness

// LLM defaults
export const DEFAULT_MODELS: Record<AgentRole, string> = {
  adjutant: 'claude-haiku-4-5-20251001',
  chief_of_staff: 'claude-opus-4-6',
  operations: 'claude-sonnet-4-6',
  inspector: 'claude-opus-4-6',
  engineer: 'claude-opus-4-6',
};

export const DEFAULT_PROVIDER = 'anthropic';
export const DEFAULT_TEMPERATURE = 0.3;
export const DEFAULT_MAX_TOKENS = 16384;

// Circuit breaker
export const CIRCUIT_BREAKER_FAILURE_THRESHOLD = 5;
export const CIRCUIT_BREAKER_RESET_TIMEOUT_MS = 60_000;
export const CIRCUIT_BREAKER_HALF_OPEN_MAX = 3;

// Cost
export const DAILY_BUDGET_USD = parseFloat(process.env.DAILY_BUDGET_USD || '50');

// Medic
export const STALL_THRESHOLD_MS = 120_000; // 2 minutes
export const CONSECUTIVE_FAILURE_THRESHOLD = 5;

// Reject circuit breaker
export const TACTICAL_TO_STRATEGIC_THRESHOLD = 3;
export const STRATEGIC_TO_CRITICAL_THRESHOLD = 2;

// Retry / error budget
export const MAX_TASK_ERRORS = parseInt(process.env.MAX_TASK_ERRORS || '3', 10);

// Agent loop
export const MAX_AGENT_TURNS = parseInt(process.env.MAX_AGENT_TURNS || '50', 10);
export const TOOL_EXEC_TIMEOUT_MS = 30_000; // 30 seconds per tool call
export const CLAUDE_CODE_TIMEOUT_MS = 300_000; // 5 minutes for Claude Code sessions

// War Room
export const WAR_ROOM_PORT = parseInt(process.env.WAR_ROOM_PORT || '3939', 10);
export const WAR_ROOM_POLL_INTERVAL_MS = 1000;

// Lark Channel
export const LARK_CONNECTION_MODE = (process.env.LARK_CONNECTION_MODE || 'websocket') as 'webhook' | 'websocket';
export const LARK_APP_ID = process.env.LARK_APP_ID || '';
export const LARK_APP_SECRET = process.env.LARK_APP_SECRET || '';
export const LARK_VERIFICATION_TOKEN = process.env.LARK_VERIFICATION_TOKEN || '';
export const LARK_ENCRYPT_KEY = process.env.LARK_ENCRYPT_KEY || '';
export const LARK_WEBHOOK_PORT = parseInt(process.env.LARK_WEBHOOK_PORT || '3003', 10);
export const LARK_WEBHOOK_PATH = process.env.LARK_WEBHOOK_PATH || '/webhook/event';
export const LARK_DM_POLICY = process.env.LARK_DM_POLICY || 'allowlist';
export const LARK_REQUIRE_MENTION = process.env.LARK_REQUIRE_MENTION !== 'false';
export const LARK_ALLOW_FROM = (process.env.LARK_ALLOW_FROM || '').split(',').filter(Boolean);
