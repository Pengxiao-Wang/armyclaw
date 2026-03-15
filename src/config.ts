import path from 'path';
import { AgentRole } from './types.js';

export const PROJECT_DIR = process.env.ARMYCLAW_PROJECT_DIR || process.cwd();
export const DATA_DIR = process.env.ARMYCLAW_DATA_DIR || path.join(process.cwd(), 'data');
export const DB_PATH = path.join(DATA_DIR, 'armyclaw.db');
export const TASKS_DIR = path.join(DATA_DIR, 'tasks');
export const SOULS_DIR = path.join(process.cwd(), 'souls');

// Concurrency
export const MAX_CONCURRENT_ENGINEERS = parseInt(process.env.MAX_ENGINEERS || '5', 10);

// Subtask limits
export const MAX_SUBTASKS_HARD_CAP = 8;
export const SUBTASK_SLOT_RESERVE = 1;

// LLM defaults
export const DEFAULT_MODELS: Record<AgentRole, string> = {
  adjutant: 'claude-sonnet-4-20250514',
  chief_of_staff: 'claude-opus-4-20250514',
  operations: 'claude-sonnet-4-20250514',
  inspector: 'claude-opus-4-20250514',
  engineer: 'claude-opus-4-20250514',
};

export const DEFAULT_PROVIDER = 'anthropic';
export const DEFAULT_TEMPERATURE = 0.3;
export const DEFAULT_MAX_TOKENS = 16384;

// Cost
export const DAILY_BUDGET_USD = parseFloat(process.env.DAILY_BUDGET_USD || '50');

// Medic (safety net for non-engineer agents; engineers are killed by process runner)
export const CONSECUTIVE_FAILURE_THRESHOLD = 5;
export const LLM_CALL_STALL_THRESHOLDS: Record<string, number> = {
  simple: 60_000,
  moderate: 180_000,
  complex: 600_000,
};
export const LLM_CALL_STALL_DEFAULT_MS = 120_000;

// Reject circuit breaker
export const TACTICAL_TO_STRATEGIC_THRESHOLD = 3;
export const STRATEGIC_TO_CRITICAL_THRESHOLD = 2;

// Retry / error budget
export const MAX_TASK_ERRORS = parseInt(process.env.MAX_TASK_ERRORS || '3', 10);

// Agent loop
export const MAX_AGENT_TURNS = parseInt(process.env.MAX_AGENT_TURNS || '50', 10);
export const CLAUDE_CODE_TIMEOUT_DEFAULT_MS = 600_000; // fallback: 10 min
export const CLAUDE_CODE_TIMEOUT_MIN_MS = 600_000;     // engineer minimum: 10 min

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

// Observability
export const HEALTH_CHECK_INTERVAL_MS = 10_000;

// Memory / Archivist
export const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
export const EMBEDDING_MODEL = 'text-embedding-3-small';
export const EMBEDDING_DIMENSIONS = 1536;
export const MEMORY_CHUNK_SIZE = 500; // tokens per chunk
export const MEMORY_SEARCH_TOP_K = 5;
export const MEMORY_RRF_K = 60; // RRF fusion constant
export const CONTEXT_ARCHIVE_THRESHOLD = 0.8; // 80% of context → start archiving
export const CONTEXT_MAX_TOKENS = 100_000; // max context window for adjutant
export const CONTEXT_KEEP_RECENT = 10; // keep last N turns after compression
export const PROCESS_LOOP_INTERVAL_MS = 500; // main loop poll interval
export const MAX_SUBTASK_DEPTH = 2; // max nesting: task → subtask → sub-subtask (no deeper)
