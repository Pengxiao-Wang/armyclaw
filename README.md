# ArmyClaw

> Deploy your AI army with one click. You will command their work just like a commander.
>
> 一键部署你的 AI 军团。像指挥官一样指挥它们工作。

ArmyClaw is a military-style multi-agent orchestration system built on Claude. It coordinates five specialized AI agents through a PDCA (Plan-Do-Check-Act) pipeline to break down, plan, execute, and review complex tasks — all tracked in a real-time Sand Table dashboard.

ArmyClaw 是一个军事风格的多 Agent 编排系统，基于 Claude 构建。它协调五个专业化 AI Agent，通过 PDCA 流水线完成复杂任务的分解、规划、执行和审查——并在实时沙盘仪表板中追踪全过程。

```
          You (Commander)
               │
          ┌────▼────┐
          │ Adjutant │ ── Splits tasks, communicates with you
          └────┬────┘
     ┌─────────┼─────────┐
┌────▼────┐ ┌──▼──┐ ┌────▼─────┐
│Chief of │ │ Ops │ │Inspector │
│  Staff  │ │     │ │ General  │
│ (Plan)  │ │(Do) │ │ (Check)  │
└─────────┘ └──┬──┘ └──────────┘
          ┌────┼────┐
          ▼    ▼    ▼
        Eng-A Eng-B Eng-C  ...×N
```

---

## Quick Start / 快速开始

### Prerequisites / 前置条件

- **Node.js ≥ 20** — `node -v`
- **Xcode Command Line Tools** (macOS) — `xcode-select --install`
  - Required for `better-sqlite3` native compilation
- **Anthropic API Key** — [console.anthropic.com](https://console.anthropic.com)

### One-click Setup / 一键安装

```bash
git clone <your-repo-url> armyclaw
cd armyclaw
./setup.sh
```

The setup script checks dependencies, installs packages, creates `.env`, runs type checks and tests.

### Manual Setup / 手动安装

```bash
npm install
cp .env.example .env
# Edit .env — add your ANTHROPIC_API_KEY
npx tsc --noEmit       # Type check
npm test               # Run tests
```

### Start / 启动

```bash
# Terminal 1: HQ (Orchestrator)
npm run dev

# Terminal 2: War Room (Sand Table Dashboard)
npm run dev:war-room

# Open Sand Table
open http://localhost:3939
```

---

## Architecture / 架构概览

Two processes, one database. No event bus, no IPC, no message queue.

两个进程，一个数据库。无事件总线、无 IPC、无消息队列。

```
┌─────────────────────────────────────┐
│     Process 1: HQ (Orchestrator)    │
│                                     │
│  Herald ─ State machine + routing   │
│  Arsenal ─ LLM client + breaker    │
│  Depot ─ Cost tracking + budget    │
│  Medic ─ Stall detection + repair  │
│                                     │
│  Writes → SQLite (WAL mode)         │
└──────────────┬──────────────────────┘
               │ Shared SQLite (WAL)
┌──────────────▼──────────────────────┐
│   Process 2: War Room (Dashboard)   │
│                                     │
│  Sand Table ─ Real-time task view   │
│  DB Watcher ─ Polls for changes    │
│  WebSocket ─ Push to browser       │
│                                     │
│  Reads ← SQLite (read-only)        │
│  Writes → agent_config only        │
└─────────────────────────────────────┘
```

**DB is the event source** — War Room crash doesn't affect HQ; HQ crash, Sand Table still shows history.

---

## Agent Roles / Agent 角色

| Role | 角色 | Default Model | Tools | Responsibility |
|------|------|---------------|-------|----------------|
| **Adjutant** (副官) | Sonnet | None | Splits user input into tasks, high-EQ communication, progress reports |
| **Chief of Staff** (参谋长) | Opus | search, file_read, file_list | Intent classification, research, planning, campaign design |
| **Operations** (指挥官) | Sonnet | None | Task assignment, dependency management, parallel coordination |
| **Inspector General** (督察长) | Opus | file_read, file_list, test_run | Gate reviews (plan + output), rubric freezing, reject escalation |
| **Engineer** (工兵) | Opus | All (7 tools) | Code implementation, bug fixes, testing — delegates to Claude Code |

### Task Pipeline (PDCA)

```
RECEIVED → SPLITTING → PLANNING → GATE1_REVIEW
                                       │
                               reject ──┤── approve
                                        │
                                  DISPATCHING → EXECUTING → GATE2_REVIEW
                                                                 │
                                                         reject ──┤── approve
                                                                  │
                                                            DELIVERING → DONE
```

Reject escalation: 3× tactical → strategic, 2× strategic → critical (auto-escalation via circuit breaker).

---

## Configuration / 配置项

All configuration is via environment variables. See `.env.example` for defaults.

| Variable | Default | Description |
|----------|---------|-------------|
| `ANTHROPIC_API_KEY` | *(required)* | Anthropic API key |
| `ARMYCLAW_DATA_DIR` | `./data` | SQLite database & task artifacts directory |
| `MAX_ENGINEERS` | `5` | Max concurrent engineer agents |
| `DAILY_BUDGET_USD` | `50` | Daily LLM spending limit (USD) |
| `MAX_AGENT_TURNS` | `50` | Max agentic loop iterations per agent run |
| `WAR_ROOM_PORT` | `3939` | Sand Table HTTP server port |

### Model Pricing (built-in)

| Model | Input ($/1M tokens) | Output ($/1M tokens) |
|-------|--------------------|--------------------|
| claude-opus-4 | $15 | $75 |
| claude-sonnet-4 | $3 | $15 |
| claude-haiku-4.5 | $0.80 | $4 |

---

## War Room / 战情室 (Sand Table)

The Sand Table (`http://localhost:3939`) provides real-time visibility:

- **Battle Map** — Task pipeline visualization with state highlighting
- **Force Deployment** — Agent status (active/thinking/stalled/idle)
- **Ammo Stats** — Cost breakdown by agent and task
- **Command Post** — Hot-swap models, pause/resume/cancel tasks
- **Battle Reports** — Reject history, circuit breaker events

---

## Testing / 测试

```bash
npm test              # Run all tests
npm run test:watch    # Watch mode
npx tsc --noEmit      # Type check only
```

Test coverage: 280+ tests across 14 test suites.

---

## Project Structure / 项目结构

```
armyclaw/
├── src/
│   ├── agents/
│   │   ├── runner.ts          # Agent execution engine (single-call + agentic loop)
│   │   ├── tool-executor.ts   # Sandboxed tool implementations
│   │   ├── tools.ts           # Tool definitions + permission matrix
│   │   └── schemas.ts         # Zod schemas for structured I/O
│   ├── arsenal/
│   │   ├── circuit-breaker.ts # Closed/Open/HalfOpen circuit breaker
│   │   ├── credential-proxy.ts # API key isolation
│   │   └── llm-client.ts     # Multi-provider LLM client
│   ├── channels/
│   │   ├── lark.ts           # Lark/Feishu webhook channel
│   │   └── registry.ts       # Channel auto-registration
│   ├── depot/
│   │   └── cost-tracker.ts   # Token cost middleware + budget enforcement
│   ├── herald/
│   │   ├── queue.ts          # Task queue with priority
│   │   ├── router.ts         # Agent routing logic
│   │   └── state-machine.ts  # Task state transitions
│   ├── medic/
│   │   └── self-repair.ts    # Stall detection + auto-recovery
│   ├── war-room/
│   │   ├── api.ts            # REST API endpoints
│   │   ├── server.ts         # HTTP + WebSocket server
│   │   └── watcher.ts        # DB polling + change detection
│   ├── config.ts             # All configuration constants
│   ├── db.ts                 # SQLite schema + data access
│   ├── index.ts              # HQ entry point
│   ├── logger.ts             # Pino logger
│   └── types.ts              # Core type definitions
├── souls/                    # Agent personality files (SOUL.md per role)
├── tests/                    # Vitest test suites
├── data/                     # Runtime data (SQLite DB, task artifacts)
├── setup.sh                  # One-click setup script
├── .env.example              # Environment variable template
├── tsconfig.json
├── vitest.config.ts
└── package.json
```

---

## License

MIT — see [LICENSE](./LICENSE).
