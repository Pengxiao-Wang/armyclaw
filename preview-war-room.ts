// Minimal preview server: serves the Sand Table HTML + mock API data
import http from 'http';

// Import just the HTML generator by evaluating the module
import { createApi } from './src/war-room/api.js';

// Mock watcher that returns sample data
const mockWatcher = {
  getTasksSnapshot: () => [
    { id: 'task-a1b2c3d4', parent_id: null, campaign_id: 'camp-001', state: 'DONE', description: 'Implement user authentication with OAuth2 and JWT tokens', priority: 'high', assigned_agent: 'engineer', assigned_engineer_id: 'eng-1', intent_type: 'execution', reject_count_tactical: 0, reject_count_strategic: 0, rubric: null, artifacts_path: null, error_count: 0, override_skip_gate: 0, source_channel: 'lark', source_chat_id: 'chat-1', context_chain: JSON.stringify([{role:'adjutant',output:'User requested OAuth2 authentication with JWT. Intent: execution. Priority: high. Splitting to chief_of_staff for planning.'},{role:'chief_of_staff',output:'## Plan: OAuth2 + JWT Auth\n\n**Goal:** Implement secure user auth with OAuth2 PKCE flow and JWT tokens\n\n### Steps:\n1. Set up OAuth2 provider config (Google, GitHub)\n2. Implement PKCE authorization code flow\n3. JWT token generation with RS256\n4. Refresh token rotation\n5. Auth middleware for protected routes\n\n**Estimated tokens:** 45,000\n**Complexity:** moderate'},{role:'inspector',output:'**Verdict: APPROVE**\n\nRubric: [security best practices, token handling, OWASP compliance]\n\nFindings:\n- Plan covers PKCE (good, prevents auth code interception)\n- JWT with RS256 is appropriate\n- Refresh token rotation prevents token theft\n- Recommend adding rate limiting on token endpoint'},{role:'engineer',output:'Implementation complete.\n\nFiles changed:\n- src/auth/oauth2.ts (new) - OAuth2 PKCE flow\n- src/auth/jwt.ts (new) - JWT generation/verification with RS256\n- src/auth/middleware.ts (new) - Auth middleware\n- src/auth/refresh.ts (new) - Refresh token rotation\n- tests/auth.test.ts (new) - 23 tests, all passing\n\nAll tests pass. Auth flow working end-to-end.'},{role:'adjutant',output:'Task delivered to user via Lark. Summary: OAuth2 + JWT authentication implemented with PKCE flow, RS256 signing, and refresh token rotation. 5 files created, 23 tests passing.'}]), created_at: new Date(Date.now() - 3600000).toISOString(), updated_at: new Date(Date.now() - 600000).toISOString() },
    { id: 'task-e5f6g7h8', parent_id: null, campaign_id: null, state: 'EXECUTING', description: 'Refactor database schema for multi-tenant support', priority: 'urgent', assigned_agent: 'engineer', assigned_engineer_id: 'eng-2', intent_type: 'execution', reject_count_tactical: 1, reject_count_strategic: 0, rubric: null, artifacts_path: null, error_count: 1, override_skip_gate: 0, source_channel: 'lark', source_chat_id: 'chat-2', context_chain: JSON.stringify([{role:'adjutant',output:'Multi-tenant schema refactor requested. Intent: execution. Priority: urgent.'},{role:'chief_of_staff',output:'## Plan: Multi-tenant Schema\n\n1. Add tenant_id to core tables (users, projects, tasks)\n2. Create tenant table with config\n3. Add RLS policies\n4. Migration script with zero-downtime rollback\n\nComplexity: complex'},{role:'inspector',output:'**Verdict: REJECT** (tactical)\n\nMissing rollback strategy for step 3 (RLS policies). Please detail how to revert RLS if issues arise.'},{role:'chief_of_staff',output:'## Revised Plan\n\nAdded rollback strategy:\n- RLS policies wrapped in reversible migration\n- Feature flag to bypass RLS during rollback\n- Canary deployment to 5% traffic first'}]), created_at: new Date(Date.now() - 7200000).toISOString(), updated_at: new Date(Date.now() - 30000).toISOString() },
    { id: 'task-i9j0k1l2', parent_id: 'task-e5f6g7h8', campaign_id: null, state: 'PLANNING', description: 'Design migration strategy for existing data', priority: 'high', assigned_agent: 'chief_of_staff', assigned_engineer_id: null, intent_type: 'research', reject_count_tactical: 0, reject_count_strategic: 0, rubric: null, artifacts_path: null, error_count: 0, override_skip_gate: 0, source_channel: null, source_chat_id: null, context_chain: null, created_at: new Date(Date.now() - 1800000).toISOString(), updated_at: new Date(Date.now() - 120000).toISOString() },
    { id: 'task-m3n4o5p6', parent_id: null, campaign_id: null, state: 'RECEIVED', description: 'Add Slack channel integration', priority: 'medium', assigned_agent: 'adjutant', assigned_engineer_id: null, intent_type: null, reject_count_tactical: 0, reject_count_strategic: 0, rubric: null, artifacts_path: null, error_count: 0, override_skip_gate: 0, source_channel: 'lark', source_chat_id: 'chat-3', context_chain: null, created_at: new Date(Date.now() - 300000).toISOString(), updated_at: new Date(Date.now() - 300000).toISOString() },
    { id: 'task-q7r8s9t0', parent_id: null, campaign_id: 'camp-001', state: 'GATE1_REVIEW', description: 'Write comprehensive test suite for auth module', priority: 'high', assigned_agent: 'inspector', assigned_engineer_id: null, intent_type: 'execution', reject_count_tactical: 1, reject_count_strategic: 0, rubric: '["unit tests","integration tests","edge cases"]', artifacts_path: null, error_count: 0, override_skip_gate: 0, source_channel: null, source_chat_id: null, context_chain: null, created_at: new Date(Date.now() - 5400000).toISOString(), updated_at: new Date(Date.now() - 60000).toISOString() },
    { id: 'task-u1v2w3x4', parent_id: null, campaign_id: null, state: 'FAILED', description: 'Deploy to staging environment with blue-green strategy', priority: 'medium', assigned_agent: 'operations', assigned_engineer_id: null, intent_type: 'execution', reject_count_tactical: 0, reject_count_strategic: 1, rubric: null, artifacts_path: null, error_count: 3, override_skip_gate: 0, source_channel: 'lark', source_chat_id: 'chat-1', context_chain: JSON.stringify([{role:'adjutant',output:'Deploy staging request. Blue-green strategy specified.'},{role:'chief_of_staff',output:'Simple deployment task, skip split. Direct to operations.'},{role:'engineer',output:'ERROR: kubectl connection refused. Staging cluster at k8s.staging.internal:6443 unreachable. Retried 3 times.\n\nLast error: dial tcp 10.0.1.50:6443: connect: connection refused'}]), created_at: new Date(Date.now() - 9000000).toISOString(), updated_at: new Date(Date.now() - 1800000).toISOString() },
    { id: 'task-y5z6a7b8', parent_id: null, campaign_id: null, state: 'PAUSED', description: 'Optimize API response time for /api/search endpoint', priority: 'low', assigned_agent: 'engineer', assigned_engineer_id: 'eng-1', intent_type: 'execution', reject_count_tactical: 0, reject_count_strategic: 0, rubric: null, artifacts_path: null, error_count: 0, override_skip_gate: 0, source_channel: null, source_chat_id: null, context_chain: null, created_at: new Date(Date.now() - 10800000).toISOString(), updated_at: new Date(Date.now() - 3600000).toISOString() },
  ],
  getActiveTasksSnapshot() { return this.getTasksSnapshot().filter((t: any) => !['DONE','FAILED','CANCELLED'].includes(t.state)); },
  getFlowLogSnapshot: (taskId: string) => {
    const logs: Record<string, any[]> = {
      'task-a1b2c3d4': [
        { task_id: 'task-a1b2c3d4', at: new Date(Date.now()-3600000).toISOString(), from_state: null, to_state: 'RECEIVED', agent_role: 'adjutant', reason: 'New task from Lark', duration_ms: null },
        { task_id: 'task-a1b2c3d4', at: new Date(Date.now()-3500000).toISOString(), from_state: 'RECEIVED', to_state: 'SPLITTING', agent_role: 'chief_of_staff', reason: 'starting', duration_ms: 12000 },
        { task_id: 'task-a1b2c3d4', at: new Date(Date.now()-3200000).toISOString(), from_state: 'SPLITTING', to_state: 'PLANNING', agent_role: 'chief_of_staff', reason: 'subtasks created', duration_ms: 45000 },
        { task_id: 'task-a1b2c3d4', at: new Date(Date.now()-2800000).toISOString(), from_state: 'PLANNING', to_state: 'GATE1_REVIEW', agent_role: 'inspector', reason: 'plan ready for review', duration_ms: 30000 },
        { task_id: 'task-a1b2c3d4', at: new Date(Date.now()-2400000).toISOString(), from_state: 'GATE1_REVIEW', to_state: 'DISPATCHING', agent_role: 'operations', reason: 'approved', duration_ms: 15000 },
        { task_id: 'task-a1b2c3d4', at: new Date(Date.now()-2200000).toISOString(), from_state: 'DISPATCHING', to_state: 'EXECUTING', agent_role: 'engineer', reason: 'assigned to eng-1', duration_ms: 8000 },
        { task_id: 'task-a1b2c3d4', at: new Date(Date.now()-1200000).toISOString(), from_state: 'EXECUTING', to_state: 'GATE2_REVIEW', agent_role: 'inspector', reason: 'implementation complete', duration_ms: 180000 },
        { task_id: 'task-a1b2c3d4', at: new Date(Date.now()-900000).toISOString(), from_state: 'GATE2_REVIEW', to_state: 'DELIVERING', agent_role: 'adjutant', reason: 'passed review', duration_ms: 20000 },
        { task_id: 'task-a1b2c3d4', at: new Date(Date.now()-600000).toISOString(), from_state: 'DELIVERING', to_state: 'DONE', agent_role: 'adjutant', reason: 'delivered to user', duration_ms: 10000 },
      ],
      'task-e5f6g7h8': [
        { task_id: 'task-e5f6g7h8', at: new Date(Date.now()-7200000).toISOString(), from_state: null, to_state: 'RECEIVED', agent_role: 'adjutant', reason: 'New task', duration_ms: null },
        { task_id: 'task-e5f6g7h8', at: new Date(Date.now()-7000000).toISOString(), from_state: 'RECEIVED', to_state: 'SPLITTING', agent_role: 'chief_of_staff', reason: 'starting', duration_ms: 5000 },
        { task_id: 'task-e5f6g7h8', at: new Date(Date.now()-6500000).toISOString(), from_state: 'SPLITTING', to_state: 'PLANNING', agent_role: 'chief_of_staff', reason: '2 subtasks', duration_ms: 60000 },
        { task_id: 'task-e5f6g7h8', at: new Date(Date.now()-5000000).toISOString(), from_state: 'PLANNING', to_state: 'GATE1_REVIEW', agent_role: 'inspector', reason: 'plan complete', duration_ms: 90000 },
        { task_id: 'task-e5f6g7h8', at: new Date(Date.now()-4500000).toISOString(), from_state: 'GATE1_REVIEW', to_state: 'PLANNING', agent_role: 'chief_of_staff', reason: 'rejected: needs more detail on rollback strategy', duration_ms: 30000 },
        { task_id: 'task-e5f6g7h8', at: new Date(Date.now()-3000000).toISOString(), from_state: 'PLANNING', to_state: 'GATE1_REVIEW', agent_role: 'inspector', reason: 'revised plan', duration_ms: 120000 },
        { task_id: 'task-e5f6g7h8', at: new Date(Date.now()-2500000).toISOString(), from_state: 'GATE1_REVIEW', to_state: 'DISPATCHING', agent_role: 'operations', reason: 'approved on 2nd review', duration_ms: 20000 },
        { task_id: 'task-e5f6g7h8', at: new Date(Date.now()-2300000).toISOString(), from_state: 'DISPATCHING', to_state: 'EXECUTING', agent_role: 'engineer', reason: 'assigned to eng-2', duration_ms: 5000 },
      ],
      'task-u1v2w3x4': [
        { task_id: 'task-u1v2w3x4', at: new Date(Date.now()-9000000).toISOString(), from_state: null, to_state: 'RECEIVED', agent_role: 'adjutant', reason: 'New task', duration_ms: null },
        { task_id: 'task-u1v2w3x4', at: new Date(Date.now()-8500000).toISOString(), from_state: 'RECEIVED', to_state: 'PLANNING', agent_role: 'chief_of_staff', reason: 'simple task, skip split', duration_ms: 8000 },
        { task_id: 'task-u1v2w3x4', at: new Date(Date.now()-7000000).toISOString(), from_state: 'PLANNING', to_state: 'DISPATCHING', agent_role: 'operations', reason: 'auto-approved', duration_ms: 5000 },
        { task_id: 'task-u1v2w3x4', at: new Date(Date.now()-6800000).toISOString(), from_state: 'DISPATCHING', to_state: 'EXECUTING', agent_role: 'engineer', reason: 'assigned', duration_ms: 3000 },
        { task_id: 'task-u1v2w3x4', at: new Date(Date.now()-3000000).toISOString(), from_state: 'EXECUTING', to_state: 'FAILED', agent_role: 'operations', reason: 'Max retries exceeded: staging cluster unreachable', duration_ms: 240000 },
      ],
    };
    return logs[taskId] || [
      { task_id: taskId, at: new Date(Date.now()-600000).toISOString(), from_state: null, to_state: 'RECEIVED', agent_role: 'adjutant', reason: 'New task', duration_ms: null },
    ];
  },
  getProgressLogSnapshot: (taskId: string) => {
    const logs: Record<string, any[]> = {
      'task-e5f6g7h8': [
        { task_id: 'task-e5f6g7h8', at: new Date(Date.now()-2200000).toISOString(), agent: 'engineer', text: 'Starting schema refactor. Analyzing current table structure...', todos: null },
        { task_id: 'task-e5f6g7h8', at: new Date(Date.now()-1800000).toISOString(), agent: 'engineer', text: 'Created migration file 001_add_tenant_id. Adding tenant_id column to users, projects, tasks tables.', todos: null },
        { task_id: 'task-e5f6g7h8', at: new Date(Date.now()-600000).toISOString(), agent: 'engineer', text: 'Migration applied successfully. Now updating query layer to filter by tenant_id. 3/5 repositories updated.', todos: null },
      ],
      'task-a1b2c3d4': [
        { task_id: 'task-a1b2c3d4', at: new Date(Date.now()-2000000).toISOString(), agent: 'engineer', text: 'Implemented OAuth2 flow with PKCE. Setting up JWT token generation.', todos: null },
        { task_id: 'task-a1b2c3d4', at: new Date(Date.now()-1500000).toISOString(), agent: 'engineer', text: 'JWT middleware integrated. Added refresh token rotation. Writing tests.', todos: null },
        { task_id: 'task-a1b2c3d4', at: new Date(Date.now()-1000000).toISOString(), agent: 'inspector', text: 'Code review passed. Auth flow is secure. Token rotation works correctly.', todos: null },
        { task_id: 'task-a1b2c3d4', at: new Date(Date.now()-700000).toISOString(), agent: 'adjutant', text: 'Authentication feature delivered to user via Lark.', todos: null },
      ],
    };
    return logs[taskId] || [];
  },
  getAgentStatus: () => [
    { role: 'adjutant', status: 'idle', current_task_id: null, model: 'claude-sonnet-4-20250514', last_activity: new Date(Date.now()-300000).toISOString() },
    { role: 'chief_of_staff', status: 'active', current_task_id: 'task-i9j0k1l2', model: 'claude-opus-4-20250514', last_activity: new Date(Date.now()-15000).toISOString() },
    { role: 'operations', status: 'idle', current_task_id: null, model: 'claude-sonnet-4-20250514', last_activity: new Date(Date.now()-120000).toISOString() },
    { role: 'inspector', status: 'thinking', current_task_id: 'task-q7r8s9t0', model: 'claude-opus-4-20250514', last_activity: new Date(Date.now()-45000).toISOString() },
    { role: 'engineer', status: 'active', current_task_id: 'task-e5f6g7h8', model: 'claude-opus-4-20250514', last_activity: new Date(Date.now()-5000).toISOString() },
  ],
  getHealthStatus: () => [
    { role: 'adjutant', status: 'red', last_updated: new Date(Date.now()-300000).toISOString() },
    { role: 'chief_of_staff', status: 'green', last_updated: new Date(Date.now()-15000).toISOString() },
    { role: 'operations', status: 'yellow', last_updated: new Date(Date.now()-120000).toISOString() },
    { role: 'inspector', status: 'yellow', last_updated: new Date(Date.now()-45000).toISOString() },
    { role: 'engineer', status: 'green', last_updated: new Date(Date.now()-5000).toISOString() },
  ],
  getCostSummary: () => ({
    daily_total: 23.47,
    weekly_total: 142.83,
    by_agent: { adjutant: 2.15, chief_of_staff: 5.32, operations: 1.88, inspector: 4.67, engineer: 9.45 },
    by_task: {},
  }),
  getAgentConfigs: () => [
    { role: 'adjutant', model: 'claude-sonnet-4-20250514', provider: 'anthropic', temperature: 0.3, max_tokens: 8192, updated_at: '' },
    { role: 'chief_of_staff', model: 'claude-opus-4-20250514', provider: 'anthropic', temperature: 0.3, max_tokens: 8192, updated_at: '' },
  ],
  setAgentConfigWrite: () => {},
  controlTask: (id: string, action: string) => ({ task_id: id, action, new_state: action === 'pause' ? 'PAUSED' : action === 'cancel' ? 'CANCELLED' : 'RECEIVED' }),
  getArsenalStats: () => ({
    total_runs: 47,
    running: 3,
    success: 38,
    error: 6,
    by_model: {
      'claude-opus-4-20250514': { runs: 28, input_tokens: 1250000, output_tokens: 380000 },
      'claude-sonnet-4-20250514': { runs: 19, input_tokens: 420000, output_tokens: 95000 },
    },
    recent_errors: [
      { task_id: 'task-u1v2w3x4', agent_role: 'engineer', model: 'claude-opus-4-20250514', error: 'Tool execution timeout: kubectl apply exceeded 30s limit', at: new Date(Date.now()-1800000).toISOString() },
      { task_id: 'task-u1v2w3x4', agent_role: 'operations', model: 'claude-sonnet-4-20250514', error: 'Max retries exceeded: staging cluster unreachable', at: new Date(Date.now()-2400000).toISOString() },
    ],
  }),
  getHeraldStats: () => ({
    queue_depth: 1,
    by_state: { RECEIVED: 1, PLANNING: 1, GATE1_REVIEW: 1, EXECUTING: 1, DONE: 1, FAILED: 1, PAUSED: 1 },
    by_priority: { urgent: 1, high: 2, medium: 3, low: 1 },
    avg_duration_by_state: { SPLITTING: 8500, PLANNING: 75000, GATE1_REVIEW: 22000, DISPATCHING: 5500, EXECUTING: 180000, GATE2_REVIEW: 20000, DELIVERING: 10000 },
    total_tasks: 7,
    completed: 1,
    failed: 1,
  }),
  getMedicStats: () => ({
    stalled_tasks: [
      { id: 'task-y5z6a7b8', state: 'PAUSED', assigned_agent: 'engineer', updated_at: new Date(Date.now()-3600000).toISOString() },
    ],
    high_error_tasks: [
      { id: 'task-u1v2w3x4', error_count: 3, state: 'FAILED' },
      { id: 'task-e5f6g7h8', error_count: 1, state: 'EXECUTING' },
    ],
    reject_summary: { tactical: 2, strategic: 1 },
    recovery_events: [],
  }),
  getRecentFlowLog: () => {
    const now = Date.now();
    return [
      { task_id: 'task-e5f6g7h8', at: new Date(now-30000).toISOString(), from_state: 'DISPATCHING', to_state: 'EXECUTING', agent_role: 'engineer', reason: 'assigned to eng-2', duration_ms: 5000 },
      { task_id: 'task-q7r8s9t0', at: new Date(now-60000).toISOString(), from_state: 'PLANNING', to_state: 'GATE1_REVIEW', agent_role: 'inspector', reason: 'plan ready for review', duration_ms: 35000 },
      { task_id: 'task-i9j0k1l2', at: new Date(now-120000).toISOString(), from_state: 'SPLITTING', to_state: 'PLANNING', agent_role: 'chief_of_staff', reason: 'subtasks created', duration_ms: 60000 },
      { task_id: 'task-m3n4o5p6', at: new Date(now-300000).toISOString(), from_state: null, to_state: 'RECEIVED', agent_role: 'adjutant', reason: 'New task from Lark', duration_ms: null },
      { task_id: 'task-a1b2c3d4', at: new Date(now-600000).toISOString(), from_state: 'DELIVERING', to_state: 'DONE', agent_role: 'adjutant', reason: 'delivered to user', duration_ms: 10000 },
      { task_id: 'task-a1b2c3d4', at: new Date(now-900000).toISOString(), from_state: 'GATE2_REVIEW', to_state: 'DELIVERING', agent_role: 'adjutant', reason: 'passed review', duration_ms: 20000 },
      { task_id: 'task-a1b2c3d4', at: new Date(now-1200000).toISOString(), from_state: 'EXECUTING', to_state: 'GATE2_REVIEW', agent_role: 'inspector', reason: 'implementation complete', duration_ms: 180000 },
      { task_id: 'task-u1v2w3x4', at: new Date(now-1800000).toISOString(), from_state: 'EXECUTING', to_state: 'FAILED', agent_role: 'operations', reason: 'Max retries exceeded: staging cluster unreachable', duration_ms: 240000 },
      { task_id: 'task-e5f6g7h8', at: new Date(now-2500000).toISOString(), from_state: 'GATE1_REVIEW', to_state: 'DISPATCHING', agent_role: 'operations', reason: 'approved on 2nd review', duration_ms: 20000 },
      { task_id: 'task-e5f6g7h8', at: new Date(now-4500000).toISOString(), from_state: 'GATE1_REVIEW', to_state: 'PLANNING', agent_role: 'chief_of_staff', reason: 'rejected: needs rollback detail', duration_ms: 30000 },
    ];
  },
  getRecentAgentRuns: () => {
    const now = Date.now();
    return [
      { task_id: 'task-e5f6g7h8', agent_role: 'engineer', engineer_id: 'eng-2', model: 'claude-opus-4-20250514', started_at: new Date(now-120000).toISOString(), updated_at: new Date(now-5000).toISOString(), finished_at: null, status: 'running', input_tokens: 85000, output_tokens: 12000, error: null },
      { task_id: 'task-q7r8s9t0', agent_role: 'inspector', engineer_id: null, model: 'claude-opus-4-20250514', started_at: new Date(now-90000).toISOString(), updated_at: new Date(now-45000).toISOString(), finished_at: null, status: 'running', input_tokens: 42000, output_tokens: 3500, error: null },
      { task_id: 'task-i9j0k1l2', agent_role: 'chief_of_staff', engineer_id: null, model: 'claude-opus-4-20250514', started_at: new Date(now-200000).toISOString(), updated_at: new Date(now-15000).toISOString(), finished_at: null, status: 'running', input_tokens: 63000, output_tokens: 18000, error: null },
      { task_id: 'task-a1b2c3d4', agent_role: 'adjutant', engineer_id: null, model: 'claude-sonnet-4-20250514', started_at: new Date(now-650000).toISOString(), updated_at: new Date(now-600000).toISOString(), finished_at: new Date(now-600000).toISOString(), status: 'success', input_tokens: 15000, output_tokens: 2800, error: null },
      { task_id: 'task-a1b2c3d4', agent_role: 'inspector', engineer_id: null, model: 'claude-opus-4-20250514', started_at: new Date(now-950000).toISOString(), updated_at: new Date(now-900000).toISOString(), finished_at: new Date(now-900000).toISOString(), status: 'success', input_tokens: 48000, output_tokens: 5200, error: null },
      { task_id: 'task-a1b2c3d4', agent_role: 'engineer', engineer_id: 'eng-1', model: 'claude-opus-4-20250514', started_at: new Date(now-2200000).toISOString(), updated_at: new Date(now-1200000).toISOString(), finished_at: new Date(now-1200000).toISOString(), status: 'success', input_tokens: 125000, output_tokens: 38000, error: null },
      { task_id: 'task-u1v2w3x4', agent_role: 'engineer', engineer_id: null, model: 'claude-opus-4-20250514', started_at: new Date(now-3200000).toISOString(), updated_at: new Date(now-1800000).toISOString(), finished_at: new Date(now-1800000).toISOString(), status: 'error', input_tokens: 95000, output_tokens: 8000, error: 'kubectl connection refused. Staging cluster unreachable after 3 retries.' },
      { task_id: 'task-e5f6g7h8', agent_role: 'chief_of_staff', engineer_id: null, model: 'claude-opus-4-20250514', started_at: new Date(now-7000000).toISOString(), updated_at: new Date(now-6500000).toISOString(), finished_at: new Date(now-6500000).toISOString(), status: 'success', input_tokens: 35000, output_tokens: 12000, error: null },
    ];
  },
} as any;

const api = createApi(mockWatcher);
const server = http.createServer(api);
server.listen(3940, () => {
  console.log('\n  Preview running at: http://localhost:3940\n');
});
