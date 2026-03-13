<h1 align="center">⚔️ ArmyClaw</h1>

<p align="center">
  <strong>Other frameworks let agents chat. We give them a chain of command.</strong>
</p>

<p align="center">
  <sub>5 specialized AI agents form a military command structure: Adjutant splits, Chief of Staff plans,<br>Operations dispatches, Engineers execute, Inspector General reviews and rejects.<br>A full PDCA pipeline with adversarial review — not a chatroom.</sub>
</p>

<p align="center">
  <a href="README_CN.md">中文版</a> ·
  <a href="#-why-armyclaw">Why ArmyClaw</a> ·
  <a href="#-quick-start">Quick Start</a> ·
  <a href="#-architecture">Architecture</a> ·
  <a href="#-war-room">War Room</a> ·
  <a href="#-agent-roles">Agent Roles</a> ·
  <a href="#-configuration">Configuration</a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/TypeScript-5.x-3178C6?style=flat-square&logo=typescript&logoColor=white" alt="TypeScript">
  <img src="https://img.shields.io/badge/Claude-Opus_|_Sonnet-8B5CF6?style=flat-square" alt="Claude">
  <img src="https://img.shields.io/badge/Agents-5_Specialized-F59E0B?style=flat-square" alt="Agents">
  <img src="https://img.shields.io/badge/Tests-280+-22C55E?style=flat-square" alt="Tests">
  <img src="https://img.shields.io/badge/IPC-Zero-EC4899?style=flat-square" alt="Zero IPC">
  <img src="https://img.shields.io/badge/License-MIT-blue?style=flat-square" alt="License">
</p>

---

## 🤔 Why ArmyClaw?

Most multi-agent frameworks fall into one of two traps: **too dumb** (agents just route messages, no real collaboration) or **too heavy** (enterprise infra to run "Hello World"). ArmyClaw takes a different path — a **military command chain with adversarial review**:

```
You (Commander) → Adjutant (Split) → Chief of Staff (Plan) → Inspector General (Review)
                                                                     ↓ approve / ✗ reject & escalate
                                                              Operations (Dispatch) → Engineers (Execute)
                                                                                            ↓
                                                                                 Inspector General (Review) → Done
```

This isn't metaphor — it's **structural separation of powers**. The planner never reviews its own plan. The executor never approves its own output.

### How it compares

| | OpenClaw | NanoClaw | IronClaw | **ArmyClaw** |
|---|:---:|:---:|:---:|:---:|
| **Multi-agent orchestration** | Router dispatch, no collaboration protocol | Container-isolated, agents work alone | Policy-gated, single-agent focused | **✅ 5-role command chain, full PDCA pipeline** |
| **Adversarial review** | ❌ Optional community plugin | ❌ None | ⚠️ Rule-based policy checks | **✅ Independent Opus agent, mandatory gate, can reject & escalate** |
| **Agent checks & balances** | ❌ Flat routing | ❌ Isolation = no interaction | ⚠️ Static rules, not intelligent | **✅ Planner vs Inspector, circuit breaker auto-escalation** |
| **Real-time dashboard** | Community plugins required | ❌ None by design | Built-in, but heavy to deploy | **✅ War Room sand table, zero setup** |
| **Task pipeline visibility** | ❌ | ❌ | ⚠️ Coarse-grained | **✅ Full state flow + agent activity + cost breakdown** |
| **Architecture** | ~430K LOC, 52+ modules, 1GB+ RAM | ~3.9K LOC, needs Docker | Rust + TEE infrastructure | **✅ Single SQLite, zero IPC, two processes** |
| **Cost control** | Plugin needed | ❌ | Policy config | **✅ Built-in daily budget + per-agent token tracking** |
| **Time to running** | `pnpm install` → configure plugins → 1GB+ | Needs Docker environment | Needs TEE infrastructure | **`./setup.sh` → 2 minutes** |

<details>
<summary><b>🔍 Why adversarial review is the killer feature</b></summary>

<br>

OpenClaw's review is a human clicking "approve". IronClaw's review is a rule engine checking boxes. ArmyClaw's **Inspector General is an independent Opus-class agent** — it actually reads your plan, exercises its own judgment, and rejects what doesn't pass muster.

The escalation ladder is automatic:
- **3× tactical rejections** → escalate to strategic level
- **2× strategic rejections** → escalate to critical (circuit breaker)

This is AI-vs-AI adversarial review, not a checkbox. It catches issues that rule-based checks miss, because the reviewer *thinks*.

</details>

<details>
<summary><b>⚡ Why zero IPC matters</b></summary>

<br>

No message queue. No Redis. No gRPC. No event bus.

HQ writes to SQLite (WAL mode). War Room reads from the same file. That's it.

- HQ crashes? → Sand Table still shows full history.
- War Room crashes? → HQ keeps working, nothing lost.
- Want to debug? → Open the SQLite file directly.

This is the simplest possible distributed architecture. Fewer moving parts = fewer things that break at 3am.

</details>

---

## 🚀 Quick Start

### Prerequisites

- **Node.js ≥ 20** — `node -v`
- **Xcode Command Line Tools** (macOS) — `xcode-select --install` (for `better-sqlite3`)
- **Anthropic API Key** — [console.anthropic.com](https://console.anthropic.com)

### Setup & Launch

```bash
git clone <your-repo-url> armyclaw && cd armyclaw
./setup.sh                    # One-click: deps, .env, type check, tests

# Terminal 1 — HQ (Orchestrator)
npm run dev

# Terminal 2 — War Room (Sand Table)
npm run dev:war-room
# → open http://localhost:3939
```

<details>
<summary>Manual setup</summary>

```bash
npm install
cp .env.example .env          # Edit: add ANTHROPIC_API_KEY
npx tsc --noEmit              # Type check
npm test                      # 280+ tests
npm run dev                   # Start HQ
```

</details>

---

## 🏛️ Architecture

Two processes, one database. No event bus, no IPC, no message queue.

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

## 🎖️ Agent Roles

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

| Role | Model | Tools | Responsibility |
|------|-------|-------|----------------|
| **Adjutant** | Sonnet | — | Task splitting, high-EQ communication, progress reports |
| **Chief of Staff** | Opus | search, file_read, file_list | Intent classification, research, planning, campaign design |
| **Operations** | Sonnet | — | Task assignment, dependency management, parallel coordination |
| **Inspector General** | Opus | file_read, file_list, test_run | Gate reviews (plan + output), rubric freezing, reject escalation |
| **Engineer** | Opus | All (7 tools) | Code implementation, bug fixes, testing — delegates to Claude Code |

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

## 📡 War Room

The Sand Table (`http://localhost:3939`) provides real-time visibility:

- **Battle Map** — Task pipeline visualization with state highlighting
- **Force Deployment** — Agent status (active / thinking / stalled / idle)
- **Ammo Stats** — Cost breakdown by agent and task
- **Command Post** — Hot-swap models, pause / resume / cancel tasks
- **Battle Reports** — Reject history, circuit breaker events

<!-- TODO: Add screenshot here -->
<!-- ![War Room](docs/screenshots/war-room.png) -->

---

## ⚙️ Configuration

All via environment variables. See `.env.example` for defaults.

| Variable | Default | Description |
|----------|---------|-------------|
| `ANTHROPIC_API_KEY` | *(required)* | Anthropic API key |
| `ARMYCLAW_DATA_DIR` | `./data` | SQLite database & task artifacts |
| `MAX_ENGINEERS` | `5` | Max concurrent engineer agents |
| `DAILY_BUDGET_USD` | `50` | Daily LLM spending limit (USD) |
| `MAX_AGENT_TURNS` | `50` | Max agentic loop iterations per agent run |
| `WAR_ROOM_PORT` | `3939` | Sand Table HTTP server port |

<details>
<summary><b>Lark / Feishu integration</b></summary>

Chat with ArmyClaw directly in Lark. Interactive setup recommended:

```bash
npm run setup:lark
```

Or manually add to `.env`:

```bash
LARK_APP_ID=cli_xxxxxxxxxx
LARK_APP_SECRET=your_app_secret
LARK_VERIFICATION_TOKEN=your_token
```

**Event subscription**: In Lark Developer Console → Events & Callbacks:

| Mode | Setup | Best for |
|------|-------|----------|
| **WebSocket** (default) | Select "Long Connection" — no public URL needed | Development |
| **Webhook** | Set URL to `https://<domain>/webhook/event` | Production |

Subscribe to: `im.message.receive_v1`

**Required permissions**: `im:message` · `im:message.group_at_msg` · `im:resource`

If `LARK_APP_ID` is empty, the Lark channel is silently skipped — HQ runs normally without it.

</details>

<details>
<summary><b>Model pricing (built-in)</b></summary>

| Model | Input ($/1M tokens) | Output ($/1M tokens) |
|-------|--------------------|--------------------|
| claude-opus-4 | $15 | $75 |
| claude-sonnet-4 | $3 | $15 |
| claude-haiku-4.5 | $0.80 | $4 |

</details>

---

## 🧪 Testing

```bash
npm test              # 280+ tests across 14 suites
npm run test:watch    # Watch mode
npx tsc --noEmit      # Type check only
```

---

<details>
<summary><b>📁 Project Structure</b></summary>

```
armyclaw/
├── src/
│   ├── agents/           # Runner, tool executor, permission matrix
│   ├── arsenal/          # LLM client, circuit breaker, credential proxy
│   ├── channels/         # Lark/Feishu integration
│   ├── depot/            # Cost tracking + budget enforcement
│   ├── herald/           # State machine, queue, routing
│   ├── medic/            # Stall detection + auto-recovery
│   ├── war-room/         # Dashboard API, WebSocket, DB watcher
│   ├── config.ts         # Configuration constants
│   ├── db.ts             # SQLite schema + data access
│   ├── index.ts          # HQ entry point
│   └── types.ts          # Core type definitions
├── souls/                # Agent personality files (SOUL.md per role)
├── tests/                # Vitest test suites
├── setup.sh              # One-click setup
└── .env.example          # Environment variable template
```

</details>

## ⭐ Star History

[![Star History Chart](https://api.star-history.com/svg?repos=Pengxiao-Wang/armyclaw&type=Date)](https://star-history.com/#Pengxiao-Wang/armyclaw&Date)

---

## License

MIT — see [LICENSE](./LICENSE).
