import path from 'path';
import { AgentRole } from './types.js';

export const DATA_DIR = process.env.ARMYCLAW_DATA_DIR || path.join(process.cwd(), 'data');
export const DB_PATH = path.join(DATA_DIR, 'armyclaw.db');
export const TASKS_DIR = path.join(DATA_DIR, 'tasks');
export const SOULS_DIR = path.join(process.cwd(), 'souls');

// Concurrency
export const MAX_CONCURRENT_ENGINEERS = parseInt(process.env.MAX_ENGINEERS || '5', 10);

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
export const DEFAULT_MAX_TOKENS = 8192;

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

// Agent loop
export const MAX_AGENT_TURNS = parseInt(process.env.MAX_AGENT_TURNS || '50', 10);
export const TOOL_EXEC_TIMEOUT_MS = 30_000; // 30 seconds per tool call

// War Room
export const WAR_ROOM_PORT = parseInt(process.env.WAR_ROOM_PORT || '3939', 10);
export const WAR_ROOM_POLL_INTERVAL_MS = 1000;
