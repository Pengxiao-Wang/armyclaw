<h1 align="center">⚔️ ArmyClaw</h1>

<p align="center">
  <strong>别的框架让 Agent 聊天。我们给它们一条指挥链。</strong>
</p>

<p align="center">
  <sub>5 个专业化 AI Agent 组成军事指挥链：副官拆解任务、参谋长规划方案、<br>指挥官调度派发、工兵执行实现、督察长审查封驳。<br>完整的 PDCA 流水线 + 对抗式审核——不是聊天室。</sub>
</p>

<p align="center">
  <a href="README.md">English</a> ·
  <a href="#-为什么选-armyclaw">为什么选 ArmyClaw</a> ·
  <a href="#-快速开始">快速开始</a> ·
  <a href="#-架构">架构</a> ·
  <a href="#-战情室">战情室</a> ·
  <a href="#-agent-角色">Agent 角色</a> ·
  <a href="#-配置">配置</a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/TypeScript-5.x-3178C6?style=flat-square&logo=typescript&logoColor=white" alt="TypeScript">
  <img src="https://img.shields.io/badge/Claude-Opus_|_Sonnet-8B5CF6?style=flat-square" alt="Claude">
  <img src="https://img.shields.io/badge/Agents-5_个专业角色-F59E0B?style=flat-square" alt="Agents">
  <img src="https://img.shields.io/badge/Tests-280+-22C55E?style=flat-square" alt="Tests">
  <img src="https://img.shields.io/badge/IPC-零依赖-EC4899?style=flat-square" alt="Zero IPC">
  <img src="https://img.shields.io/badge/License-MIT-blue?style=flat-square" alt="License">
</p>

---

## 🤔 为什么选 ArmyClaw？

大多数多 Agent 框架不是**太蠢**（Agent 只是转发消息，没有真正的协作），就是**太重**（跑个 Hello World 都要企业级基础设施）。ArmyClaw 走了一条不同的路——**军事指挥链 + 对抗式审核**：

```
你 (指挥官) → 副官 (拆解) → 参谋长 (规划) → 督察长 (审查)
                                                    ↓ 批准 / ✗ 驳回并升级
                                             指挥官 (调度) → 工兵 (执行)
                                                                   ↓
                                                        督察长 (审查) → 完成
```

这不是比喻——这是**结构性的分权制衡**。规划者永远不审查自己的方案，执行者永远不批准自己的产出。

### 横向对比

| | OpenClaw | NanoClaw | IronClaw | **ArmyClaw** |
|---|:---:|:---:|:---:|:---:|
| **多 Agent 编排** | 路由分发，无协作协议 | 容器隔离，各干各的 | 策略门控，偏单 Agent | **✅ 5 角色指挥链，完整 PDCA 流水线** |
| **对抗式审核** | ❌ 社区可选插件 | ❌ 无 | ⚠️ 基于规则的策略检查 | **✅ 独立 Opus Agent，强制门控，可驳回升级** |
| **Agent 间制衡** | ❌ 扁平路由 | ❌ 隔离 = 无交互 | ⚠️ 静态规则，非智能 | **✅ 参谋 vs 督察，断路器自动升级** |
| **实时看板** | 需安装社区插件 | ❌ 设计上拒绝 | 内建，但部署重 | **✅ 战情室沙盘，开箱即用** |
| **任务流水线可视化** | ❌ | ❌ | ⚠️ 粗粒度 | **✅ 全状态流转 + Agent 活跃度 + 弹药统计** |
| **架构** | ~430K 行，52+ 模块，1GB+ 内存 | ~3.9K 行，需 Docker | Rust + TEE 基础设施 | **✅ 单 SQLite，零 IPC，两个进程** |
| **成本控制** | 需插件 | ❌ | 策略配置 | **✅ 内建日预算 + Agent 级 token 追踪** |
| **从安装到跑起来** | `pnpm install` → 配插件 → 1GB+ | 需 Docker 环境 | 需 TEE 基础设施 | **`./setup.sh` → 2 分钟** |

<details>
<summary><b>🔍 为什么对抗式审核是杀手锏</b></summary>

<br>

OpenClaw 的审核是人类手动点"approve"。IronClaw 的审核是规则引擎勾 checkbox。ArmyClaw 的**督察长是一个独立的 Opus 级 Agent**——它会真的读你的方案，用自己的判断力驳回不合格的产出。

升级阶梯是自动的：
- **3 次战术驳回** → 升级为战略级
- **2 次战略驳回** → 升级为紧急级（断路器触发）

这是 AI 对 AI 的对抗式审核，不是走过场。它能发现规则检查遗漏的问题，因为审核者会*思考*。

</details>

<details>
<summary><b>⚡ 为什么零 IPC 很重要</b></summary>

<br>

没有消息队列。没有 Redis。没有 gRPC。没有事件总线。

HQ 写入 SQLite（WAL 模式）。战情室读取同一个文件。就这样。

- HQ 崩了？→ 沙盘照常显示完整历史。
- 战情室崩了？→ HQ 继续工作，数据零丢失。
- 想调试？→ 直接打开 SQLite 文件。

这是你能想到的最简单的分布式架构。越少的活动部件 = 越少凌晨 3 点被叫醒。

</details>

---

## 🚀 快速开始

### 前置条件

- **Node.js ≥ 20** — `node -v`
- **Xcode Command Line Tools**（macOS）— `xcode-select --install`（`better-sqlite3` 编译需要）
- **Anthropic API Key** — [console.anthropic.com](https://console.anthropic.com)

### 安装与启动

```bash
git clone <your-repo-url> armyclaw && cd armyclaw
./setup.sh                    # 一键安装：依赖、.env、类型检查、测试

# 终端 1 — HQ（编排器）
npm run dev

# 终端 2 — 战情室（沙盘看板）
npm run dev:war-room
# → 打开 http://localhost:3939
```

<details>
<summary>手动安装</summary>

```bash
npm install
cp .env.example .env          # 编辑：填入 ANTHROPIC_API_KEY
npx tsc --noEmit              # 类型检查
npm test                      # 280+ 测试
npm run dev                   # 启动 HQ
```

</details>

---

## 🏛️ 架构

两个进程，一个数据库。无事件总线、无 IPC、无消息队列。

```
┌─────────────────────────────────────┐
│    进程 1：HQ（编排器）               │
│                                     │
│  Herald ─ 状态机 + 路由              │
│  Arsenal ─ LLM 客户端 + 断路器      │
│  Depot ─ 成本追踪 + 预算控制         │
│  Medic ─ 停滞检测 + 自动修复         │
│                                     │
│  写入 → SQLite（WAL 模式）           │
└──────────────┬──────────────────────┘
               │ 共享 SQLite（WAL）
┌──────────────▼──────────────────────┐
│    进程 2：战情室（看板）              │
│                                     │
│  沙盘 ─ 实时任务视图                 │
│  DB Watcher ─ 轮询变更              │
│  WebSocket ─ 推送到浏览器            │
│                                     │
│  读取 ← SQLite（只读）              │
│  写入 → 仅 agent_config             │
└─────────────────────────────────────┘
```

**数据库即事件源** — 战情室崩溃不影响 HQ；HQ 崩溃，沙盘仍显示完整历史。

---

## 🎖️ Agent 角色

```
          你（指挥官）
               │
          ┌────▼────┐
          │  副  官  │ ── 拆解任务，与你沟通
          └────┬────┘
     ┌─────────┼─────────┐
┌────▼────┐ ┌──▼──┐ ┌────▼─────┐
│ 参谋长  │ │指挥 │ │ 督察长   │
│         │ │ 官  │ │          │
│（规划） │ │(调度)│ │（审查）  │
└─────────┘ └──┬──┘ └──────────┘
          ┌────┼────┐
          ▼    ▼    ▼
        工兵A 工兵B 工兵C  ...×N
```

| 角色 | 模型 | 工具 | 职责 |
|------|------|------|------|
| **副官** Adjutant | Sonnet | — | 任务拆解、高情商沟通、进度汇报 |
| **参谋长** Chief of Staff | Opus | search, file_read, file_list | 意图分类、调研、规划、战役设计 |
| **指挥官** Operations | Sonnet | — | 任务分配、依赖管理、并行协调 |
| **督察长** Inspector General | Opus | file_read, file_list, test_run | 门控审查（方案 + 产出）、评分标准冻结、驳回升级 |
| **工兵** Engineer | Opus | 全部（7 个工具） | 代码实现、Bug 修复、测试——委托 Claude Code 执行 |

### 任务流水线（PDCA）

```
接收 → 拆解 → 规划 → 门控审查1
                          │
                  驳回 ────┤──── 批准
                          │
                    调度 → 执行 → 门控审查2
                                      │
                              驳回 ────┤──── 批准
                                      │
                                 交付 → 完成
```

驳回升级机制：3 次战术驳回 → 升级为战略级，2 次战略驳回 → 升级为紧急级（断路器自动触发）。

---

## 📡 战情室

沙盘（`http://localhost:3939`）提供实时可视化：

- **战场地图** — 任务流水线可视化，状态高亮
- **兵力部署** — Agent 状态（活跃 / 思考中 / 停滞 / 空闲）
- **弹药统计** — 按 Agent 和任务的成本明细
- **指挥所** — 热切换模型、暂停 / 恢复 / 取消任务
- **战报** — 驳回历史、断路器事件

<!-- TODO: 添加截图 -->
<!-- ![战情室](docs/screenshots/war-room.png) -->

---

## ⚙️ 配置

所有配置通过环境变量。详见 `.env.example`。

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `ANTHROPIC_API_KEY` | *（必填）* | Anthropic API 密钥 |
| `ARMYCLAW_DATA_DIR` | `./data` | SQLite 数据库与任务产物目录 |
| `MAX_ENGINEERS` | `5` | 最大并发工兵数 |
| `DAILY_BUDGET_USD` | `50` | 每日 LLM 花费上限（美元） |
| `MAX_AGENT_TURNS` | `50` | 每次 Agent 运行的最大循环次数 |
| `WAR_ROOM_PORT` | `3939` | 沙盘 HTTP 服务端口 |

<details>
<summary><b>飞书 / Lark 接入</b></summary>

在飞书中直接与 ArmyClaw 对话。推荐交互式安装：

```bash
npm run setup:lark
```

或手动添加到 `.env`：

```bash
LARK_APP_ID=cli_xxxxxxxxxx
LARK_APP_SECRET=your_app_secret
LARK_VERIFICATION_TOKEN=your_token
```

**事件订阅**：在飞书开发者后台 → 事件与回调：

| 模式 | 配置 | 适用场景 |
|------|------|----------|
| **WebSocket**（默认） | 选择"长连接"——无需公网 URL | 开发环境 |
| **Webhook** | 设置 URL 为 `https://<域名>/webhook/event` | 生产环境 |

订阅事件：`im.message.receive_v1`

**所需权限**：`im:message` · `im:message.group_at_msg` · `im:resource`

若 `LARK_APP_ID` 为空，飞书通道会静默跳过——HQ 正常运行。

</details>

<details>
<summary><b>模型定价（内建）</b></summary>

| 模型 | 输入（$/百万 token） | 输出（$/百万 token） |
|------|---------------------|---------------------|
| claude-opus-4 | $15 | $75 |
| claude-sonnet-4 | $3 | $15 |
| claude-haiku-4.5 | $0.80 | $4 |

</details>

---

## 🧪 测试

```bash
npm test              # 280+ 测试，14 个测试套件
npm run test:watch    # 监听模式
npx tsc --noEmit      # 仅类型检查
```

---

<details>
<summary><b>📁 项目结构</b></summary>

```
armyclaw/
├── src/
│   ├── agents/           # 执行引擎、工具执行器、权限矩阵
│   ├── arsenal/          # LLM 客户端、断路器、凭证代理
│   ├── channels/         # 飞书 / Lark 接入
│   ├── depot/            # 成本追踪 + 预算控制
│   ├── herald/           # 状态机、队列、路由
│   ├── medic/            # 停滞检测 + 自动修复
│   ├── war-room/         # 看板 API、WebSocket、DB 监听
│   ├── config.ts         # 配置常量
│   ├── db.ts             # SQLite 模式 + 数据访问
│   ├── index.ts          # HQ 入口
│   └── types.ts          # 核心类型定义
├── souls/                # Agent 人格文件（每角色一个 SOUL.md）
├── tests/                # Vitest 测试套件
├── setup.sh              # 一键安装脚本
└── .env.example          # 环境变量模板
```

</details>

## ⭐ Star History

[![Star History Chart](https://api.star-history.com/svg?repos=Pengxiao-Wang/armyclaw&type=Date)](https://star-history.com/#Pengxiao-Wang/armyclaw&Date)

---

## 许可证

MIT — 详见 [LICENSE](./LICENSE)。
