# ArmyClaw Bug & Improvement Backlog

> Generated from third-party code review on 2026-03-11.
> Organized by priority layer. Check off items as they are resolved.

---

## Layer 1: Startup Gate (Fail Fast)

- [ ] **CRIT-CFG-1**: `config.ts` — `parseInt`/`parseFloat` can produce `NaN` silently. Add Zod validation at startup.
- [ ] **CRIT-CFG-2**: No `.env` loading — missing `dotenv` dependency. `npm run dev` will not load `.env` file, causing immediate failure on first LLM call.
- [ ] **CRIT-CFG-3**: No `unhandledRejection` / `uncaughtException` global handlers. Process crashes silently or continues in corrupt state.
- [ ] **HIGH-CFG-4**: API key validated at call time (`llm-client.ts:179`), not at startup. System initializes fully before discovering missing key.
- [ ] **HIGH-CFG-5**: Reject thresholds (`TACTICAL_TO_STRATEGIC_THRESHOLD` vs `STRATEGIC_TO_CRITICAL_THRESHOLD`) not validated to be in correct order.

## Layer 2: Trust Boundary (LLM is Untrusted)

- [ ] **CRIT-SEC-1**: Prompt injection — `task.description`, `task.context_chain`, `task.rubric` interpolated directly into system prompt without escaping. (`runner.ts:337, 386-399`)
- [ ] **CRIT-SEC-2**: `code_execute` uses `execSync(input.command)` — arbitrary shell command execution with no sandbox. (`tool-executor.ts:159`)
- [ ] **HIGH-SEC-3**: LLM tool-use response `input` field not validated against declared schema before execution. (`llm-client.ts:233-241`)
- [ ] **HIGH-SEC-4**: `parseAgentOutput()` defined in `schemas.ts` but never called in `runner.ts`. Malformed agent outputs written to DB unchecked.
- [ ] **HIGH-SEC-5**: Credential proxy (`credential-proxy.ts`) is dead code — `generateTaskToken()`/`resolveToken()` never called. LLM client and tool executor read `ANTHROPIC_API_KEY` directly from `process.env`.
- [ ] **MED-SEC-6**: Flow log `reason` field embedded in agent context without sanitization. (`runner.ts:364-377`)
- [ ] **MED-SEC-7**: `claudeCode` tool has no prompt size limit. (`tool-executor.ts:194`)
- [ ] **MED-SEC-8**: `file_read` tool doesn't detect binary files or follow-symlink attacks. (`tool-executor.ts:79-100`)

## Layer 3: Concurrency & Data Integrity

- [ ] **CRIT-RACE-1**: Budget check TOCTOU race — multiple agents pass pre-flight check simultaneously, all make expensive LLM calls, budget exceeded. (`cost-tracker.ts:45-70`)
- [ ] **CRIT-BUG-1**: Circuit breaker `halfOpenAttempts` never incremented in `canExecute()`. Unlimited probes in half-open state. (`circuit-breaker.ts:44-45`)
- [ ] **CRIT-DATA-1**: Token counts accumulated in-memory during agentic loop, only written to DB at loop end. Crash mid-loop loses all token records. (`runner.ts:154-200`)
- [ ] **HIGH-RACE-2**: Resume PAUSED task — query and write not atomic. (`watcher.ts:299-305`)
- [ ] **HIGH-BUG-2**: State machine escalation from TACTICAL to STRATEGIC doesn't increment `reject_count_strategic`. (`state-machine.ts:151-156`)
- [ ] **CRIT-DATA-2**: Unsafe `JSON.parse` without try-catch on `task.rubric` — crashes runner. (`runner.ts:346`)
- [ ] **MED-DATA-3**: All DB query results cast with `as Type` — no runtime validation. (`db.ts:203, 207, 219`)
- [ ] **MED-DATA-4**: Unknown model pricing returns `$0` silently. Budget tracking inaccurate for new models. (`cost-tracker.ts:23-30`)
- [ ] **MED-NUM-1**: Floating-point precision loss in cost calculation. Accumulated error over 1000+ calls. (`cost-tracker.ts:23-30`)

## Layer 4: Process Lifecycle

- [ ] **CRIT-LIFE-1**: Graceful shutdown does not await in-flight tasks. `process.exit(0)` called while `processTask` promises still running. (`index.ts:477-485`)
- [ ] **MED-LIFE-2**: `processLoop` calls `processBatch()` without `await` — floating promise. (`index.ts:181`)
- [ ] **MED-LIFE-3**: War Room `server.close()` has no timeout — hangs forever on keep-alive connections. (`war-room/server.ts:22-29`)
- [ ] **LOW-LIFE-4**: Database connection not closed on HQ shutdown. (`index.ts:90-100`)
- [ ] **LOW-LIFE-5**: `ToolExecutor` created but never disposed — no subprocess tracking or cleanup. (`runner.ts`)

## Layer 5: War Room & API Security

- [ ] **HIGH-API-1**: No authentication/authorization on any War Room endpoint. Anyone on the network can control tasks and switch models. (`api.ts`)
- [ ] **HIGH-API-2**: CORS `Access-Control-Allow-Origin: *` — open to all origins. (`api.ts:16`)
- [ ] **CRIT-API-3**: `readBody()` has no size limit — memory exhaustion DoS. (`api.ts:208-214`)
- [ ] **HIGH-API-4**: `controlTask` in watcher bypasses state machine validation — can resume DONE tasks, cancel FAILED tasks. (`watcher.ts:290-325`)
- [ ] **HIGH-API-5**: Stored XSS — `t.priority` used in CSS class name without validation. (`api.ts:598`)
- [ ] **MED-API-6**: SQL table name interpolation in `getLatestTimestamp()` — safe today (hardcoded), dangerous pattern. (`watcher.ts:365`)
- [ ] **MED-API-7**: Missing `Content-Type: application/json` on some error responses. (`api.ts:50-51`)
- [ ] **MED-API-8**: No rate limiting on any endpoint.

## Layer 6: Medic (Self-Repair)

- [ ] **HIGH-MED-1**: `retry` and `reassign` recovery actions are no-ops — only write flow_log, don't re-enqueue task. Causes infinite detection loop. (`self-repair.ts:120-145`)
- [ ] **MED-MED-2**: Recovery doesn't reset agent_run `updated_at` — next scan re-detects same stall. (`self-repair.ts:50-94`)
- [ ] **MED-MED-3**: `getRecentRunsForTask` limit=10 hardcoded — may miss failures beyond window. (`db.ts:363`)

## Layer 7: Operational & Maintenance

- [ ] **MED-OPS-1**: No DB cleanup/VACUUM — `flow_log`, `costs`, `agent_runs` grow unbounded. (`db.ts`)
- [ ] **MED-OPS-2**: Logging only to stdout via `pino-pretty` — no file rotation, not machine-parseable. (`logger.ts`)
- [ ] **MED-OPS-3**: LLM response cache (`Map`) has no max size — unbounded memory growth. Only TTL eviction on cache hit. (`llm-client.ts:35`)
- [ ] **MED-OPS-4**: Queue re-sorts entire array on every enqueue — O(n log n). Fine for now, use heap if queue grows. (`queue.ts:47-50`)
- [ ] **LOW-OPS-5**: `setup.sh` passes API key as shell argument — visible in `ps` output briefly. (`setup.sh:87`)
- [ ] **LOW-OPS-6**: Anthropic API version header hardcoded to `2023-06-01`. (`llm-client.ts:211`)
- [ ] **LOW-OPS-7**: Failover to OpenAI returns stub `[stub response from openai]` — effectively non-functional. (`llm-client.ts:162-166`)
- [ ] **LOW-OPS-8**: Missing `ON DELETE CASCADE` on foreign keys — orphaned records if tasks deleted. (`db.ts:59,70,87,101`)
- [ ] **LOW-OPS-9**: Lark channel is stub — needs webhook signature verification when implemented. (`channels/lark.ts`)

---

## Stats

| Severity | Count |
|----------|-------|
| CRITICAL | 9 |
| HIGH     | 12 |
| MEDIUM   | 16 |
| LOW      | 7 |
| **Total** | **44** |
