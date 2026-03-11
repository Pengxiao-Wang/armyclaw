# ArmyClaw 架构优化计划（终版）

## Context

armyclaw 是一个军事风格的多 Agent 编排系统。基于 NanoClaw(内核)、IronClaw(安全/LLM模式参考)、OpenClaw(渠道参考)、Edict(UX/流程参考) 四个项目的深度研究，本计划定义完整的架构优化方案。所有项都要实现。

## 设计哲学

**奥卡姆剃刀**: 能用一个概念解决的，不引入两个。
**高内聚**: 相关功能放在一起，不按"军事称号"拆，按"职责边界"拆。
**低耦合**: 进程间唯一耦合点是 SQLite 数据库。无事件总线、无 IPC、无消息队列。

---

## 内核选择：NanoClaw

fork NanoClaw（TypeScript, ~7.3k LOC）作为代码基座。

**直接复用的模块**:
- `container-runner.ts` → 多 Agent 容器调度器
- `group-queue.ts` → 工兵并发池
- `channels/registry.ts` → 多渠道 IM
- `db.ts` (SQLite) → 扩展 schema
- `ipc.ts` → Agent 间通信
- `task-scheduler.ts` → 定时任务

**IronClaw** — 设计模式参考（TypeScript 重写）: 熔断器、自修复、上下文压缩、凭证注入、LLM 多 Provider 抽象
**OpenClaw** — 渠道参考: 飞书/Lark webhook 实现、多 Agent 路由矩阵（规避其 session 坍缩 bug）
**Edict** — UX 参考: 状态机转换表、Dashboard 看板、Flow Log 审计、SOUL.md 角色定义

---

## 架构核心简化：两个进程 + 一个数据库

经奥卡姆剃刀审视，5 个基础设施服务可合并为 **2 个进程**，通过 **SQLite（WAL 模式）** 解耦：

```
┌─────────────────────────────────────────────────────┐
│              Process 1: 指挥所 (HQ)                  │
│              Orchestrator 主进程                      │
│                                                     │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐          │
│  │  传令兵   │  │  军火库   │  │  军需库   │          │
│  │ Herald   │  │ Arsenal  │  │  Depot   │          │
│  │          │  │          │  │          │          │
│  │ 状态机   │  │ LLM客户端│  │ 成本中间件│          │
│  │ 任务队列 │  │ 熔断/重试│  │ 预算管控 │          │
│  │ Agent调用│  │ 工具注册 │  │ token计数│          │
│  │ Schema校验│  │ 凭证代理 │  │          │          │
│  │ 渠道管理 │  │ 模型配置 │  │          │          │
│  └──────────┘  └──────────┘  └──────────┘          │
│                                                     │
│  ┌──────────┐                                       │
│  │  医疗兵   │ ← 内嵌于指挥所，检测+恢复一体化       │
│  │  Medic   │                                       │
│  │ 卡死检测 │                                       │
│  │ 自动恢复 │                                       │
│  │ 工具故障 │                                       │
│  └──────────┘                                       │
│                                                     │
│  写入 → SQLite (tasks, agent_runs, flow_log,        │
│          progress_log, costs, agent_config)          │
└────────────────────────┬────────────────────────────┘
                         │ SQLite WAL (共享读)
┌────────────────────────▼────────────────────────────┐
│           Process 2: 战情室 (War Room)               │
│           独立沙盘 Watcher 进程                       │
│                                                     │
│  ┌──────────────────────────────────────┐           │
│  │           沙盘 Sand Table             │           │
│  │                                      │           │
│  │ · 作战地图（任务流转可视化）           │           │
│  │ · 兵力部署（Agent 节点状态）           │           │
│  │ · 弹药统计（成本面板）                │           │
│  │ · 军令台（模型配置 + 人工控制）        │           │
│  │ · 战报（战损/打回/熔断记录）           │           │
│  │ · WebSocket 实时推送                  │           │
│  └──────────────────────────────────────┘           │
│                                                     │
│  读取 ← SQLite (只读，监视变更)                       │
│  写入 → SQLite (仅 agent_config 表，模型热切换)       │
└─────────────────────────────────────────────────────┘
```

### 为什么砍掉事件总线

原计划有 Observer 模式事件总线连接 5 个服务。但审视后发现：
- 心跳检测 = 战情室查 `agent_runs.updated_at`，无需 Agent 主动上报
- 成本统计 = 军需库作为 LLM 中间件直接写 DB，无需事件
- 模型切换 = 战情室写 `agent_config` 表，指挥所下次调用时读取，无需事件
- Dashboard 更新 = 监视 SQLite WAL 变更，无需事件推送

**DB 即事件源**。两个进程之间零耦合——战情室（沙盘）挂了不影响指挥所，指挥所挂了沙盘还能看历史。医疗兵在指挥所内部，检测+恢复一步到位，无需跨进程传递恢复指令。

---

## Agent 体系

```
                         ┌─────────────────────┐
                         │     司令官 (你)       │
                         │     Commander        │
                         │                     │
                         │  最高决策权          │
                         │  只与副官交互        │
                         └──────────┬──────────┘
                                    │
                         ┌──────────▼──────────┐
                         │       副官           │
                         │     Adjutant         │
                         │     Sonnet           │
                         │                     │
                         │  · 24/7 秒级响应    │
                         │  · 高情商沟通       │
                         │  · 多任务拆分       │
                         │  · 进展汇报(有温度) │
                         │  · 中断识别         │
                         │  · 晨报/定时摘要    │
                         │                     │
                         │  硬规则:             │
                         │  永远转发，永不执行  │
                         └──────────┬──────────┘
                                    │ 每条任务独立转发
               ┌────────────────────┼────────────────────┐
               │                    │                    │
      ┌────────▼────────┐ ┌────────▼────────┐ ┌─────────▼───────┐
      │     参谋长       │ │     指挥官       │ │     督察长       │
      │  Chief of Staff │ │   Operations    │ │Inspector General│
      │     Opus        │ │    Sonnet       │ │     Opus        │
      │                 │ │                 │ │                 │
      │  PDCA: Plan     │ │  战术协调       │ │  PDCA: Check    │
      │                 │ │                 │ │                 │
      │  · 意图分级     │ │  · 任务分配     │ │  · Gate1 审计划 │
      │  · 情报调研     │ │  · 依赖管理     │ │  · Gate2 审产出 │
      │  · 分析研判     │ │  · 并行协调     │ │  · 打回分级标注 │
      │  · 方案制定     │ │  · 异常应变     │ │    tactical/    │
      │  · 战役规划     │ │  · 结果汇总     │ │    strategic/   │
      │  · 复杂度评估   │ │  · 阶段推进     │ │    critical     │
      │                 │ │                 │ │  · 审核标准冻结 │
      └─────────────────┘ └────────┬────────┘ │  · 对抗式审核   │
                                   │          │  · 一票否决权   │
                          ┌────────┼────────┐ └─────────────────┘
                          ▼        ▼        ▼
                       ┌─────┐ ┌─────┐ ┌─────┐
                       │工兵A│ │工兵B│ │工兵C│  ...×N
                       │Opus │ │Opus │ │Opus │
                       │     │ │     │ │     │
                       │写代码│ │改bug│ │搭建 │
                       │跑命令│ │测试 │ │部署 │
                       └─────┘ └─────┘ └─────┘


  ════════════════════ 任务流转 (PDCA) ════════════════════

  你 → 副官(拆分+路由)
        → 参谋长(Plan: 调研+分析+方案)
            → 督察长(Gate1: 审计划, 冻结 rubric)
                ├─ reject(tactical)  → 指挥官
                ├─ reject(strategic) → 参谋长重做
                ├─ reject(critical)  → 上报司令官
                └─ approve
                    → 指挥官(战术分解+分配工兵)
                        │
                   ┌────┼────┐
                   ▼    ▼    ▼
                 工兵A 工兵B 工兵C (Do: 并行执行)
                   │    │    │
                   └────┼────┘
                        ▼
                   指挥官(汇总结果)
                        → 督察长(Gate2: 审产出, 复用 rubric)
                            ├─ reject(tactical)  → 指挥官(工兵重做)
                            ├─ reject(strategic) → 参谋长(重新规划)
                            ├─ reject(critical)  → 上报司令官
                            └─ approve
                                → 副官(Act: 有温度地交付给你)

  熔断器: 3×tactical → 自动升strategic
          2×strategic → 自动升critical
```

### 状态机（代码驱动，传令兵管理）

```
RECEIVED → SPLITTING → PLANNING → GATE1_REVIEW
                                      │
                              reject ──┤── approve
                              (按级别路由)     │
                                        DISPATCHING → EXECUTING
                                                        │
                                                   GATE2_REVIEW
                                                        │
                                                reject ──┤── approve
                                                (按级别路由)     │
                                                          DELIVERING → DONE
```

reject 路由（代码 switch）:
- tactical → 回指挥官
- strategic → 回参谋长
- critical → 上报司令官
- 熔断器: 3 次 tactical → 自动升级 strategic，2 次 strategic → 升级 critical

### 结构化 I/O Schema（代码校验）

```typescript
// 副官
{ tasks: { id, description, priority }[], reply: string }
// 参谋长
{ type: "answer"|"research"|"execution"|"campaign", answer?, plan? }
// 督察长
{ verdict: "approve"|"reject", level?: "tactical"|"strategic"|"critical", rubric: string[], findings: string[] }
// 指挥官
{ assignments: { engineer_id, subtask_id, context }[] }
```

路由由代码 switch(output.type) / switch(output.level) 决定，不依赖 LLM。

### 工具权限矩阵（代码管控）

| Agent | 允许 | 禁止 |
|-------|------|------|
| 副官 | 对话 | 搜索、文件、代码执行 |
| 参谋长 | 搜索、文件读取 | 文件写入、代码执行 |
| 指挥官 | 无外部工具 | 全部 |
| 督察长 | 文件读取、测试运行 | 文件写入 |
| 工兵 | 全部 | 无限制 |

---

## IM 渠道

基于 NanoClaw Channel 自注册模式：

| 渠道 | 实现 | 参考 |
|------|------|------|
| **飞书/Lark** | `src/channels/lark.ts`，webhook + Lark MCP | OpenClaw feishu 配置 |
| **Telegram** | 复用 NanoClaw | — |
| **Slack** | 复用 NanoClaw | — |
| **WhatsApp** | 复用 NanoClaw | — |
| **Discord** | 复用 NanoClaw | — |
| **Web UI** | 战情室内嵌 | — |

**飞书关键规则**: Lark 国际版(larksuite.com)、user_id 发消息、useUAT=true(日历)、ID 前缀检测(ou_/oc_/@)

---

## 功能清单

### 一、指挥所 (HQ) 功能

#### 1. LLM 调用链
**参考**: IronClaw `circuit_breaker.rs` + `response_cache.rs`
```
Retry(3次指数退避) → CircuitBreaker(Closed/Open/HalfOpen)
→ Failover(主备切换，冷却300s) → Cache(SHA256 key, 1hr TTL, 不缓存 tool calls)
```

#### 2. 不可变审计日志
**参考**: Edict flow_log
```sql
CREATE TABLE flow_log (
  task_id TEXT, at TEXT, from_state TEXT, to_state TEXT,
  agent_role TEXT, reason TEXT, duration_ms INTEGER
);
CREATE TABLE progress_log (
  task_id TEXT, at TEXT, agent TEXT, text TEXT, todos TEXT -- JSON
);
```
Herald 每次状态变更写 flow_log，Agent 工作中写 progress_log。只追加不修改。

#### 3. 任务附件工作区
```
tasks/{task_id}/
  ├── plan.md           ← 参谋长
  ├── plan_review.md    ← 督察长 Gate1
  ├── assignments.json  ← 指挥官
  ├── output/           ← 工兵产出（per engineer 子目录）
  └── output_review.md  ← 督察长 Gate2
```
Agent I/O 只传路径引用，不传全文。Herald 按状态授权读写。

#### 4. 审核标准冻结
督察长 Gate1 首次输出 `rubric: string[]` → 冻结存入任务附件 → 后续 re-review 复用同一 rubric。防止标准漂移。

#### 5. 凭证隔离代理
**参考**: NanoClaw credential-proxy + IronClaw per-job bearer token
工兵容器通过 HTTP 代理调 LLM，代理注入真实凭证。工兵永远不见 key。per-task 临时 token，常量时间比较。

#### 6. 双队列并发池
**参考**: NanoClaw `group-queue.ts`
- Per-campaign 队列（阶段内有序）
- Global 工兵池（max N 并发）
- 优先级: Gate 审核 > 执行中 > 新任务

#### 7. 上下文压缩
**参考**: IronClaw `compaction.rs`
Herald 调用 Agent 前压缩 context:
- 80% → 早期阶段摘要化
- 90% → LLM 生成摘要
- 95% → 截断

#### 8. 成本预估 + 预算管控
参谋长出计划附 token 预估 → 军需库校验(任务预算 ≤ 日预算) → 超预算暂停新任务。

#### 9. 冷启动快速通道
副官匹配 template（确定性关键词/正则）→ 跳过参谋长+Gate1 → 直接 Dispatching。

#### 10. 战役管理
```typescript
interface Campaign {
  id: string
  phases: { name: string, goal: string, depends_on?: string }[]
  current_phase: number
  status: "active" | "paused" | "done"
}
```
参谋长输出 campaign 计划，Herald 逐 phase 推进 PDCA 循环。跨 phase 状态持久化 DB。

#### 11. 复杂度评分 → 模型选择
**参考**: IronClaw SmartRoutingProvider
指挥官评估任务复杂度 → 简单任务用 Sonnet 工兵 → 节省 15x 成本。

#### 12. Lifecycle Hooks
**参考**: IronClaw hooks
6 拦截点: BeforeInbound / BeforeToolCall / BeforeOutbound / OnSessionStart / OnSessionEnd / TransformResponse。Hooks 可修改/放行/拒绝。

#### 13. 输入清洗 + 注入防护
**参考**: Edict sanitization + IronClaw safety/
作为 BeforeInbound hook: 去除文件路径/URL/元数据，检测注入模式，扫描凭证泄漏。

#### 14. 优雅降级
Opus 不可用 → 参谋长降级 Sonnet 简化规划，工兵排队等待而非失败。LLM 调用链的 Failover 层处理。

#### 15. 定时摘要 / 晨报
**参考**: Edict zaochao
副官每日定时汇报: 系统健康、完成任务、成本消耗、待处理事项。

#### 16. 任务模板系统
**参考**: Edict templates
```typescript
interface Template {
  id: string, name: string, pattern: RegExp,
  skip_planning: boolean,  // 快速通道
  estimated_cost: string, estimated_time: string,
  default_assignments: { role: string, tools: string[] }[]
}
```
副官 + 战情室 UI 都可触发。

---

### 二、战情室 (War Room) 功能

**核心原则: 纯 Watcher，不依赖 Agent 上报，独立扫描 DB。**

#### 1. 作战地图（任务流转可视化）
**参考**: Edict EdictBoard.tsx
- Pipeline 视图: 完整状态机每个节点，当前所在节点高亮
- 卡片式布局: 任务 ID / 标题 / 当前状态 / 负责 Agent / 持续时间
- 点击展开: 完整 flow_log 时间线 + progress_log 实时 feed
- 数据源: 直接读 SQLite `tasks` + `flow_log` + `progress_log` 表

#### 2. Agent 节点状态（兵力部署图）
- 每个 Agent 角色显示: 当前状态 / 正在处理的任务 / 使用的模型
- **健康检测（医疗兵逻辑）**: 扫描 `agent_runs` 表
  - `updated_at` ≤ 30s ago → 🟢 active
  - `updated_at` ≤ 2min ago → 🟡 thinking
  - `updated_at` > 2min ago → 🔴 stalled
  - 无需 Agent 主动上报，战情室独立判断
- 卡死任务自动检测 → 触发恢复: 写入 `recovery_actions` 表 → 指挥所下次轮询时执行

#### 3. 弹药统计（成本面板）
- 实时 token 消耗、每 Agent 成本分布、日/周/月趋势
- 数据源: 直接聚合 `costs` 表

#### 4. Agent 模型管理（热切换）
- 每个角色的模型下拉 + Provider 切换 + 参数微调
- 切换 → 写入 `agent_config` 表
- 指挥所下次调用该 Agent 时读取最新配置，自动生效
- 无需重启，无需事件通知
- 切换记录写 `flow_log` 审计

#### 5. 人工控制
**参考**: Edict stop/cancel/resume
- 暂停/取消/恢复任务（写入 `tasks` 表状态）
- 强制跳过 Gate（写入 override 标记）
- 手动分配工兵
- 指令入口（从战情室直接下达命令）

#### 6. 战损报告
- 失败/打回/熔断记录汇总
- 督察长 reject 原因分析
- 工兵失败率排行

#### 7. 实时更新
- **实现方式**: SQLite WAL 变更监视（轮询 `PRAGMA wal_checkpoint` 或 inotify/fsevents 监听 WAL 文件）
- 检测到变更 → 读取增量数据 → WebSocket 推送到浏览器
- 无需事件总线，DB 即事件源

#### 8. 技术栈
- 后端: Node.js (与指挥所同技术栈)
- 前端: React + Zustand（参考 Edict）
- 实时: WebSocket
- 数据源: SQLite WAL 只读连接

---

### 三、自修复（医疗兵，内嵌于指挥所进程）

**参考**: IronClaw `self_repair.rs`

**检测逻辑（指挥所内定时扫描）**:
1. 非终态任务 + `progress_log` 最后更新超过阈值 → 卡死
2. `agent_runs` 中连续 5 次失败 → 工具故障
3. LLM 调用超时 > 120s → 提供者异常

**恢复动作（直接执行，无中间表）**:
1. 重试当前 Agent 调用
2. 换工兵实例
3. 升级给指挥官重新分配
4. ManualRequired → 战情室沙盘标红 + 通知司令官

医疗兵在指挥所内部，检测到问题直接调用恢复逻辑，无需跨进程通信。

---

### 四、安全层

#### WASM 沙箱（长期替代 Docker）
**参考**: IronClaw WASM sandbox
- fuel metering（CPU 限制）
- memory limits
- network allowlist
- 凭证注入在 host 边界

#### 容器加固（短期 Docker）
**参考**: IronClaw container.rs + NanoClaw container-runner.ts
- Drop ALL capabilities
- no-new-privileges
- read-only rootfs
- non-root user (UID 1000)
- .env shadow to /dev/null

---

## 关键参考文件

| 模式 | 源文件 |
|------|--------|
| LLM 熔断器 | `ironclaw/src/llm/circuit_breaker.rs` |
| 自修复 | `ironclaw/src/agent/self_repair.rs` |
| 上下文压缩 | `ironclaw/src/agent/compaction.rs` |
| Lifecycle Hooks | `ironclaw/src/hooks/hook.rs` |
| 安全/清洗 | `ironclaw/src/safety/` |
| 双队列 | `nanoclaw/src/group-queue.ts` |
| 容器运行器 | `nanoclaw/src/container-runner.ts` |
| 凭证代理 | `nanoclaw/src/credential-proxy.ts` |
| Channel 注册 | `nanoclaw/src/channels/registry.ts` |
| 任务状态机 | `edict/edict/backend/app/models/task.py` |
| Dashboard UI | `edict/edict/frontend/src/components/EdictBoard.tsx` |
| 飞书配置 | `~/.openclaw/openclaw.json` (channels.feishu) |

所有源文件位于 `/Users/richard/Downloads/` 下对应项目目录。

## 验证方式

1. **状态机**: 单元测试覆盖所有合法/非法状态转换
2. **Agent 调用链**: mock LLM，验证 schema 校验 + 路由逻辑
3. **战情室**: 启动后独立于指挥所运行，读 DB 显示正确状态
4. **医疗兵**: 模拟卡死任务，验证检测 + 恢复动作写入
5. **热切换**: 战情室改模型 → 指挥所下次调用验证使用新模型
6. **飞书渠道**: 发消息到 Lark → 副官响应 → 工兵执行 → 结果回复到 Lark
7. **熔断器**: 模拟 LLM 连续失败 → 验证 Open → HalfOpen → Closed 转换
