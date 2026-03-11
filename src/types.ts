// ═══════════════════════════════════════════════════════════
// ArmyClaw — Core Type Definitions
// ═══════════════════════════════════════════════════════════

// --- Enums ---

export const TaskState = {
  RECEIVED: 'RECEIVED',
  SPLITTING: 'SPLITTING',
  PLANNING: 'PLANNING',
  GATE1_REVIEW: 'GATE1_REVIEW',
  DISPATCHING: 'DISPATCHING',
  EXECUTING: 'EXECUTING',
  GATE2_REVIEW: 'GATE2_REVIEW',
  DELIVERING: 'DELIVERING',
  DONE: 'DONE',
  FAILED: 'FAILED',
  CANCELLED: 'CANCELLED',
  PAUSED: 'PAUSED',
} as const;
export type TaskState = (typeof TaskState)[keyof typeof TaskState];

export const RejectLevel = {
  TACTICAL: 'tactical',
  STRATEGIC: 'strategic',
  CRITICAL: 'critical',
} as const;
export type RejectLevel = (typeof RejectLevel)[keyof typeof RejectLevel];

export const AgentRole = {
  ADJUTANT: 'adjutant',
  CHIEF_OF_STAFF: 'chief_of_staff',
  OPERATIONS: 'operations',
  INSPECTOR: 'inspector',
  ENGINEER: 'engineer',
} as const;
export type AgentRole = (typeof AgentRole)[keyof typeof AgentRole];

export const IntentType = {
  ANSWER: 'answer',
  RESEARCH: 'research',
  EXECUTION: 'execution',
  CAMPAIGN: 'campaign',
} as const;
export type IntentType = (typeof IntentType)[keyof typeof IntentType];

export const TaskPriority = {
  LOW: 'low',
  MEDIUM: 'medium',
  HIGH: 'high',
  URGENT: 'urgent',
} as const;
export type TaskPriority = (typeof TaskPriority)[keyof typeof TaskPriority];

export const CircuitState = {
  CLOSED: 'closed',
  OPEN: 'open',
  HALF_OPEN: 'half_open',
} as const;
export type CircuitState = (typeof CircuitState)[keyof typeof CircuitState];

export const RecoveryAction = {
  RETRY: 'retry',
  REASSIGN: 'reassign',
  ESCALATE: 'escalate',
  MANUAL_REQUIRED: 'manual_required',
} as const;
export type RecoveryAction = (typeof RecoveryAction)[keyof typeof RecoveryAction];

// --- Database Row Types ---

export interface Task {
  id: string;
  parent_id: string | null;
  campaign_id: string | null;
  state: TaskState;
  description: string;
  priority: TaskPriority;
  assigned_agent: AgentRole | null;
  assigned_engineer_id: string | null;
  intent_type: IntentType | null;
  reject_count_tactical: number;
  reject_count_strategic: number;
  rubric: string | null; // JSON string[]
  artifacts_path: string | null;
  override_skip_gate: number; // 0 or 1 (SQLite boolean)
  source_channel: string | null;
  source_chat_id: string | null;
  context_chain: string | null;
  created_at: string;
  updated_at: string;
}

export interface FlowLog {
  id?: number;
  task_id: string;
  at: string;
  from_state: TaskState | null;
  to_state: TaskState;
  agent_role: AgentRole | null;
  reason: string | null;
  duration_ms: number | null;
}

export interface ProgressLog {
  id?: number;
  task_id: string;
  at: string;
  agent: AgentRole;
  text: string;
  todos: string | null; // JSON
}

export interface AgentRun {
  id?: number;
  task_id: string;
  agent_role: AgentRole;
  engineer_id: string | null;
  model: string;
  started_at: string;
  updated_at: string;
  finished_at: string | null;
  status: 'running' | 'success' | 'error';
  input_tokens: number;
  output_tokens: number;
  error: string | null;
}

export interface CostRecord {
  id?: number;
  task_id: string;
  agent_role: AgentRole;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  at: string;
}

export interface AgentConfig {
  role: AgentRole;
  model: string;
  provider: string;
  temperature: number;
  max_tokens: number;
  updated_at: string;
}

export interface Campaign {
  id: string;
  name: string;
  phases: string; // JSON CampaignPhase[]
  current_phase: number;
  status: 'active' | 'paused' | 'done';
  created_at: string;
  updated_at: string;
}

// --- Structured I/O Types ---

export interface CampaignPhase {
  name: string;
  goal: string;
  depends_on?: string;
}

export interface AdjutantOutput {
  tasks: { id: string; description: string; priority: TaskPriority }[];
  reply: string;
}

export interface ChiefOfStaffOutput {
  type: IntentType;
  answer?: string;
  plan?: {
    goal: string;
    steps: { id: string; description: string; depends_on?: string[] }[];
    estimated_tokens: number;
    complexity: 'simple' | 'moderate' | 'complex';
  };
  campaign?: {
    name: string;
    phases: CampaignPhase[];
  };
}

export interface InspectorOutput {
  verdict: 'approve' | 'reject';
  level?: RejectLevel;
  rubric: string[];
  findings: string[];
}

export interface OperationsOutput {
  assignments: {
    engineer_id: string;
    subtask_id: string;
    context: string;
    complexity: 'simple' | 'moderate' | 'complex';
  }[];
}

export interface EngineerOutput {
  subtask_id: string;
  status: 'completed' | 'failed' | 'blocked';
  result: string;
  files_changed?: string[];
}

// --- Channel Types ---

export interface Channel {
  name: string;
  connect(): Promise<void>;
  sendMessage(chatId: string, text: string): Promise<void>;
  isConnected(): boolean;
  disconnect(): Promise<void>;
}

export interface InboundMessage {
  id: string;
  channel: string;
  chat_id: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
}

export type OnInboundMessage = (message: InboundMessage) => void;

// --- LLM Types ---

// Content blocks follow the Anthropic Messages API format

export interface TextBlock {
  type: 'text';
  text: string;
}

export interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

export type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock;

export interface LLMRequest {
  model: string;
  system: string;
  messages: LLMMessage[];
  tools?: LLMTool[];
  max_tokens?: number;
  temperature?: number;
}

export interface LLMMessage {
  role: 'user' | 'assistant';
  content: string | ContentBlock[];
}

export interface LLMTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface LLMResponse {
  content: string;
  tool_use?: ToolUseBlock[];
  input_tokens: number;
  output_tokens: number;
  model: string;
  stop_reason: string; // 'end_turn' | 'tool_use' | 'max_tokens'
}

// --- Tool Permission ---

export interface ToolPermission {
  role: AgentRole;
  allowed: string[];
  denied: string[];
}

// --- Task Template ---

export interface TaskTemplate {
  id: string;
  name: string;
  pattern: string; // RegExp source
  skip_planning: boolean;
  estimated_cost: string;
  default_assignments: { role: AgentRole; tools: string[] }[];
}

// --- State Machine Transition ---

export interface StateTransition {
  from: TaskState;
  to: TaskState;
  agent?: AgentRole;
  condition?: string;
}
