# ArmyClaw 第三方代码审查

> 以独立审查者视角，对 ~/Downloads/armyclaw/ 项目的架构、代码质量、安全性进行全面评估。

---

## 一、项目概览

ArmyClaw 是一个军事风格的多 Agent 编排系统，基于 TypeScript + SQLite 构建，~4,700 LOC。灵感来自 NanoClaw，但做了大幅度的架构重设计。

**核心架构**: 2 进程 + 1 数据库
- **HQ (指挥所)**: 主编排进程，包含状态机、Agent Runner、LLM Client、Cost Tracker、Medic
- **War Room (战情室)**: 只读 Dashboard 进程，轮询 SQLite 提供实时状态
- **SQLite WAL**: 唯一的进程间通信机制

**Agent 体系**: 5 个角色按 PDCA 流转
```
User → Adjutant(拆分) → Chief of Staff(规划) → Inspector(Gate1审核)
     → Operations(派工) → Engineer(执行) → Inspector(Gate2审核) → Adjutant(交付)
```

---

## 二、做得好的地方

### 1. 架构哲学清晰且一致
整个项目贯彻 "奥卡姆剃刀" 原则。SQLite WAL 作为唯一进程间耦合点，没有引入 Redis/RabbitMQ/EventEmitter 等多余组件。War Room 崩溃不影响 HQ，反之亦然。这是真正的高内聚低耦合。

### 2. 状态机是代码驱动的，不依赖 LLM
`herald/router.ts` 中的 `routeTask()` 是一个纯 switch-case —— 完全确定性。这避免了 "让 LLM 决定流程" 的常见陷阱。LLM 只负责思考内容，代码负责流转控制。这是系统可靠性的基石。

### 3. 不可变审计日志 (flow_log)
每次状态迁移都会写入 `flow_log`，只 INSERT 不 UPDATE。这为调试和回溯提供了完整的事件源。

### 4. 类型系统设计精良
`const ... as const` + `type X = (typeof X)[keyof typeof X]` 模式在 TypeScript 中是个聪明的选择 —— 既有 enum 的约束力，又避免了 TypeScript enum 的已知问题（reverse mapping、tree shaking 等）。

### 5. Inspector 的 Frozen Rubric 机制
Gate1 审核时创建 rubric，之后冻结不变。这防止了 "标准漂移" —— 审核标准在多次 reject-retry 循环中不断变化的问题。配合 reject 升级机制（tactical×3 → strategic×2 → critical），形成了有效的质量闸门。

### 6. Soul 文件分离
Agent 人格定义放在 `souls/*.md`，作为数据而非代码。这让 prompt 工程与程序逻辑解耦，方便迭代调优。

### 7. LLM Client 的中间件栈
`Cache → Retry → CircuitBreaker → Failover` 四层堆叠，每层职责清晰。缓存跳过有 tools 的请求（有副作用），circuit breaker 实现三态（closed/open/half_open），都是正确的工程决策。

### 8. 测试覆盖
13 个测试文件覆盖了所有核心模块。`_initTestDatabase()` 使用 `:memory:` 数据库让测试快速且隔离。

---

## 三、重要问题

### BUG-1: processLoop 实际是串行的，并发形同虚设 ⚠️
**文件**: `src/index.ts:138-168`

```typescript
private processLoop(): void {
  const processNext = async () => {
    const taskId = this.queue.dequeue();
    if (taskId) {
      await this.processTask(task);  // ← 阻塞！
      this.queue.complete(taskId);
    }
    this.loopTimer = setTimeout(() => this.processLoop(), ...);
  };
  processNext();
}
```

虽然 `TaskQueue` 有 `maxConcurrent=5`，但主循环每次只 dequeue 一个任务，`await` 等它完成后才调度下一个。如果一个 Engineer 执行 50 轮 agentic loop 需要 10 分钟，其他所有任务都在等。

**MAX_CONCURRENT_ENGINEERS = 5 在当前实现中是无效的。**

**修复方向**: 改为 `Promise.all` 或者 worker pool 模式，同时启动多个 `processTask`。

### BUG-2: Medic 的连续失败检测是死代码 ⚠️
**文件**: `src/medic/self-repair.ts:51-98`

```typescript
const activeRuns = getActiveRuns();  // ← 只返回 status='running' 的记录
// ...
for (const run of activeRuns) {
  const failureCount = this.countConsecutiveErrors(taskRuns);  // ← 永远返回 0
}
```

`getActiveRuns()` 只返回 `status = 'running'` 的记录，但 `countConsecutiveErrors()` 检查的是 `status === 'error'`。这两个条件互斥。Check 2（连续失败检测，第86-98行）永远不会触发。

**修复方向**: `countConsecutiveErrors` 应该查询该 task 的所有历史 runs（不仅是 active 的），或者 `getActiveRuns()` 改为返回包含 error 状态的近期记录。

### BUG-3: War Room resume 丢失上下文
**文件**: `src/war-room/watcher.ts:296-301`

```typescript
const stateMap = {
  resume: 'RECEIVED' as TaskState,  // ← 一律回到 RECEIVED
};
```

暂停在 GATE2_REVIEW 的任务，resume 后会回到 RECEIVED，重新走一遍完整流程（拆分 → 规划 → 审核 → 执行 → 审核）。应该恢复到暂停前的状态。

### SEC-1: search 工具存在命令注入 🔴
**文件**: `src/agents/tool-executor.ts:122-141`

```typescript
const cmd = `grep -rn ${globArg} "${input.pattern}" "${searchDir}" 2>/dev/null | head -100`;
```

`input.pattern` 和 `input.glob` 直接拼接进 shell 命令字符串。如果 LLM 被 prompt injection 操纵，可以构造恶意 pattern：

```
pattern: '"; rm -rf / #'
→ grep -rn  ""; rm -rf / #" "/safe/dir" 2>/dev/null | head -100
```

**codeExecute 也允许任意命令执行**（这是 by design），但 search 工具不应该有命令注入风险。

**修复方向**: 使用 `execFileSync('grep', ['-rn', pattern, searchDir])` 替代字符串拼接，或对 pattern 做 shell escape。

### SEC-2: resolveSafe 路径检查不够严格
**文件**: `src/agents/tool-executor.ts:189-195`

```typescript
if (!resolved.startsWith(this.workDir)) {
```

如果 `workDir = /data/tasks/task-1` 且攻击路径解析为 `/data/tasks/task-100`，`startsWith` 会误判为安全。应该检查 `resolved.startsWith(this.workDir + path.sep)` 或 `resolved === this.workDir`。

### DESIGN-1: 数据库操作缺少事务
**文件**: `src/db.ts:142-188`

`createTask()` 执行两步操作（INSERT task + INSERT flow_log），没有用事务包裹。进程在两步之间崩溃会导致 task 存在但没有初始 flow_log。同样，`updateTaskState()` 也是两步操作。

**修复方向**: 用 `db.transaction()` 包裹多步写操作。better-sqlite3 原生支持。

### DESIGN-2: updateAgentRun 双重设置 updated_at
**文件**: `src/db.ts:316-329`

```typescript
for (const [key, value] of Object.entries(updates)) {
  if (!AGENT_RUN_UPDATE_FIELDS.has(key)) continue;  // updated_at 在白名单中
  fields.push(`${key} = ?`);
  values.push(value);
}
fields.push('updated_at = ?');  // ← 总是再加一次
values.push(new Date().toISOString());
```

如果调用方传入 `{ updated_at: '...' }`，SQL 中会出现两个 `updated_at = ?`，第一个值被第二个覆盖。虽然不会出错，但是个隐性 bug —— 调用方传入的 `updated_at` 被静默忽略。

在 `runner.ts:178` 中确实会传入 `updated_at`：
```typescript
updateAgentRun(runId, { updated_at: new Date().toISOString() });
```
这个值会被丢弃，虽然实际上差别只有毫秒级。

---

## 四、设计层面的观察

### 1. 单任务流水线 vs 真实场景的矛盾
当前的 PDCA 流水线是：拆分 → 规划 → Gate1 → 派工 → 执行 → Gate2 → 交付。

**但这个流水线对简单任务来说过重了。** 用户说 "今天天气怎样？" 也要经过 5 个 agent 和 2 个审核 gate。Chief of Staff 的 `IntentType.ANSWER` 分支虽然尝试了快速路径，但仍然要过 Gate1 审核。

Template fast-path（`shouldSkipPlanning`）是个好的缓解手段，但当前 templates 列表为空（`this.templates: TaskTemplate[] = []`），没有任何 template 被注册。

### 2. OpenAI failover 是空实现
`llm-client.ts:159-171` 中 OpenAI provider 返回 stub string。failover 功能在架构上准备好了，但实际不可用。如果 Anthropic 宕机，系统没有真正的 fallback。

### 3. Agent 上下文构建缺少子任务信息
`runner.ts:322-389` 的 `buildContext()` 注入了当前任务的 state、priority、rubric、flow log。但当 Adjutant 在 DELIVERING 阶段需要汇总子任务结果时，它收到的 input 只是 `task.description`（原始描述），看不到子任务的执行结果。它怎么知道该交付什么？

### 4. 缺少消息回传链路
当 Engineer 执行完成后，结果存在 `agent_runs` 表中。但 Inspector 在 Gate2 审核时，它的 input 也是 `task.description`（原始描述），而非 Engineer 的实际输出。Inspector 没有办法知道 Engineer 做了什么就无法审核。

这是当前架构中最关键的缺失 —— agent 之间的信息传递只通过 task.description，没有累积的 context chain。

### 5. Channel 层只实现了 Lark
`channels/lark.ts` 是唯一的 Channel 实现。虽然 `ChannelRegistry` 的抽象支持多 channel，但实际上只有 Lark webhook。

---

## 五、代码质量评分

| 维度 | 评分 | 说明 |
|------|------|------|
| **架构设计** | 8/10 | 清晰、简洁、正确的关注点分离。两进程+SQLite WAL 是优雅的选择 |
| **类型安全** | 9/10 | TypeScript 用得很好，const enum 模式、Zod 验证、类型窄化都到位 |
| **可测试性** | 8/10 | 好的测试基础设施，mock LLM 让测试不依赖外部 |
| **安全性** | 5/10 | search 命令注入、path traversal 边界条件、无沙箱隔离 |
| **完整性** | 6/10 | 核心管线完整，但 agent 间信息传递、并发执行、OpenAI failover 未真正实现 |
| **可运维性** | 7/10 | flow_log 审计链好，War Room 提供了可视化基础，但缺少告警和指标导出 |

---

## 六、核心建议 (按优先级)

1. **[P0] 修复 search 命令注入** — 改用 `execFileSync` 避免 shell 拼接
2. **[P0] 实现 agent 间信息传递** — 让每个 agent 的输出作为下一个 agent 的 input 的一部分。当前所有 agent 只看到 `task.description`，看不到上游 agent 的输出
3. **[P1] 实现真正的并发执行** — processLoop 改为 worker pool 模式
4. **[P1] 修复 Medic 死代码** — 让连续失败检测真正工作
5. **[P1] 数据库操作加事务** — `db.transaction()` 包裹多步写操作
6. **[P2] 注册一些默认 template** — 让 fast-path 对简单任务生效
7. **[P2] War Room resume 保留原状态** — 暂停前记录 `paused_from_state`

---

## 七、总体评价

ArmyClaw 是一个**架构思路非常清晰**的项目。设计者明显思考过多 Agent 编排中的核心难题：确定性路由、质量闸门、成本控制、故障自愈。代码风格统一、模块边界清晰、测试覆盖到位。

但当前处于**设计完成、骨架搭好、尚未跑通端到端**的阶段。最关键的缺失是 agent 间的信息传递链路 —— 所有 agent 都只看到原始 task description，看不到上游 agent 的分析和产出。这意味着即使所有组件单独测试通过，端到端的任务流也无法正确工作。

从 NanoClaw 的基因来看，ArmyClaw 做了正确的架构升级（多角色 agent、状态机、审核 gate），但保留了 NanoClaw 的简洁性（SQLite、无外部依赖、TypeScript 全栈）。这是一个好的平衡点。

**一句话总结**: 骨架优秀，需要把血管（agent 间信息流）和肌肉（并发执行）接上。
