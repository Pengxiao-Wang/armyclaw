# ArmyClaw 增量代码审查 (v2)

> 基于 2026-03-11 首次审查后的改动进行第二轮审查。
> 以独立第三方审查者视角，聚焦于 bug fix 质量、新增功能、以及残留问题。

---

## 一、改动概览

commit `2273cd8` 是一次**大规模实现**，包含约 6,400 LOC（含 souls/*.md），涵盖：

- **7 个 bug fix**：对应首次审查中的 BUG-1/2/3、SEC-1/2、DESIGN-1/2
- **1 个关键新功能**：agent 间信息传递链路（context_chain）
- **Agentic Loop**：为有工具的 agent（engineer, chief_of_staff, inspector）实现了多轮 LLM-工具交互循环
- **7 个工具实现**：file_read, file_write, file_list, search, code_execute, test_run, claude_code
- **角色权限矩阵**：每个 agent 只能用被允许的工具
- **Sand Table 仪表盘**：完整的 HTML/JS 前端（嵌入在 `api.ts` 中）
- **14 个测试文件，276 个测试**，全部通过

---

## 二、Bug Fix 验证

### SEC-1: search 命令注入 — 已修复 ✅

**修复方式**: `tool-executor.ts:131-152` 改用 `execFileSync('grep', args)` 替代字符串拼接。

```typescript
// Before (vulnerable):
const cmd = `grep -rn ${globArg} "${input.pattern}" "${searchDir}" 2>/dev/null | head -100`;

// After (safe):
const args = ['-rn'];
if (input.glob) args.push('--include', input.glob);
args.push('--', input.pattern, searchDir);
execFileSync('grep', args, { ... });
```

`--` 分隔符防止 pattern 被解释为 flag。truncation 改为内存中切 100 行。**验证测试到位**（`code-review-fixes.test.ts:63-101`），实际构造了恶意 pattern 并验证 marker 文件不存在。

**评价**: 教科书级修复。

### SEC-2: resolveSafe 路径检查 — 已修复 ✅

**修复方式**: `tool-executor.ts:235`

```typescript
// Before:
if (!resolved.startsWith(this.workDir)) {

// After:
if (resolved !== this.workDir && !resolved.startsWith(this.workDir + path.sep)) {
```

测试覆盖了 `task-1` vs `task-100` 的共享前缀场景。

### DESIGN-1: 数据库事务 — 已修复 ✅

**修复方式**: `db.ts:167-191`

```typescript
const insertTaskTxn = db.transaction(() => {
  db.prepare('INSERT INTO tasks ...').run(...);
  writeFlowLog({ ... });
});
insertTaskTxn();
```

`createTask` 和 `updateTaskState` 都用 `db.transaction()` 包裹。better-sqlite3 的事务是同步的，天然原子。

### DESIGN-2: updateAgentRun 双重 updated_at — 已修复 ✅

**修复方式**: `db.ts:325-328`

```typescript
const AGENT_RUN_UPDATE_FIELDS = new Set([
  'model', 'finished_at', 'status',
  'input_tokens', 'output_tokens', 'error',
  // updated_at intentionally excluded — always auto-set below
]);
```

`updated_at` 从白名单中移除，只在最后自动追加。调用方传入的 `updated_at` 会被 `if (!AGENT_RUN_UPDATE_FIELDS.has(key)) continue` 过滤掉。同样，`updateTask` 的 `TASK_UPDATE_FIELDS` 也不包含 `updated_at`。

### BUG-1: processLoop 串行执行 — 已修复 ✅

**修复方式**: `index.ts:142-182`

```typescript
const processBatch = async () => {
  const taskPromises: Promise<void>[] = [];
  while (true) {
    const taskId = this.queue.dequeue();
    if (!taskId) break;
    taskPromises.push((async () => { ... })());
  }
  await Promise.allSettled(taskPromises);
};
```

改为批量 dequeue + `Promise.allSettled`。`TaskQueue.dequeue()` 会检查 `active.size >= maxConcurrent`，所以 while 循环不会超过并发上限。

### BUG-2: Medic 连续失败检测死代码 — 已修复 ✅

**修复方式**: `self-repair.ts:60-64`

```typescript
const recentRuns = getRecentRunsForTask(run.task_id);
const finishedRuns = recentRuns.filter((r) => r.status !== 'running');
const failureCount = this.countConsecutiveErrors(finishedRuns);
```

新增 `db.ts:357-361` 的 `getRecentRunsForTask()` 查询所有状态的历史记录，然后在 Medic 中过滤掉 `running` 状态再计数。

### BUG-3: War Room resume 丢失状态 — 已修复 ✅

**修复方式**: `watcher.ts:299-304`

```typescript
if (action === 'resume') {
  const pauseEntry = this.wdb.prepare(
    "SELECT from_state FROM flow_log WHERE task_id = ? AND to_state = 'PAUSED' ORDER BY at DESC LIMIT 1",
  ).get(taskId);
  newState = (pauseEntry?.from_state ?? 'RECEIVED') as TaskState;
}
```

从 `flow_log` 中查找最后一次进入 PAUSED 的记录，取其 `from_state` 作为恢复目标。`flow_log` 不可变的设计在这里发挥了价值 —— 历史状态不会丢失。

### P0-2: Agent 间信息传递 — 已实现 ✅

这是最关键的新增功能。

**实现方式**:
1. `tasks` 表新增 `context_chain TEXT` 列
2. `db.ts:272-280` 的 `appendContextChain()` —— 每个 agent 完成后将输出追加到 JSON 数组
3. `runner.ts:379-393` 的 `buildContext()` —— 将 context_chain 注入为 `## Upstream Agent Outputs` section
4. `index.ts:264/317/349/378/409/459` —— 每个 handler 都调用 `appendContextChain()`

```typescript
export function appendContextChain(taskId: string, role: AgentRole, output: string): void {
  const chain = task.context_chain ? JSON.parse(task.context_chain) : [];
  chain.push({ role, output: output.slice(0, 5000) });
  updateTask(taskId, { context_chain: JSON.stringify(chain) });
}
```

5000 字符截断防止 context_chain 无限膨胀。

**评价**: 这修复了上次审查中指出的"最关键缺失"。现在 Inspector 做 Gate2 审核时能看到 Engineer 的输出，Adjutant 交付时能看到全链路的产出。

---

## 三、新功能审查

### 1. Agentic Loop（多轮工具循环）

`runner.ts:136-258` 实现了一个标准的 Agent Loop：

```
LLM call → 检查 stop_reason → 如果 tool_use → 执行工具 → 结果送回 LLM → 重复
```

**做得好的地方**:
- 每轮更新 `agent_runs.updated_at`，让 Medic 知道 agent 还活着
- 累计 token 计数（`totalInputTokens/totalOutputTokens`）
- 有 `MAX_AGENT_TURNS` 上限防止无限循环
- `writeProgressLog` 记录每次工具调用

**问题**: 见 NEW-BUG-1。

### 2. 工具实现与权限矩阵

`tools.ts:97-118` 定义了精确的权限矩阵：

| Role | 允许的工具 |
|------|-----------|
| adjutant | 无 |
| chief_of_staff | search, file_read, file_list |
| operations | 无 |
| inspector | file_read, file_list, test_run |
| engineer | 全部（含 claude_code） |

这个设计体现了最小权限原则 —— Inspector 只能读和跑测试，不能写文件；Chief of Staff 只能搜索和阅读，不能执行代码。

`claude_code` 工具让 Engineer 能调用 Claude Code CLI 作为子 agent，是一个聪明的"meta-agent"设计。

### 3. Sand Table 仪表盘

`api.ts:219-724` 中嵌入了一个完整的军事风格 HTML 仪表盘：
- 作战地图（pipeline kanban）
- 兵力部署（agent 状态卡片）
- 弹药统计（cost 面板）
- 军令台（任务控制 + 模型热切换）

视觉风格统一（绿色终端风），实用信息密度高。2 秒轮询刷新。

### 4. 测试覆盖

14 个测试文件，276 个测试。专门新增了 `code-review-fixes.test.ts` 来验证所有 bug fix。测试使用 `:memory:` 数据库 + mock LLM，快速且隔离。全部通过，耗时 573ms。

---

## 四、新发现的问题

### NEW-BUG-1: Agentic Loop 到达 MAX_TURNS 时返回空字符串 ⚠️

**文件**: `src/agents/runner.ts:156-252`

```typescript
let finalContent = '';

for (let turn = 0; turn < MAX_AGENT_TURNS; turn++) {
  // ...
  if (response.stop_reason !== 'tool_use') {
    finalContent = response.content;  // ← 只在 agent 主动结束时赋值
    break;
  }
  // 执行工具，继续循环...
}

return finalContent;  // ← 如果循环跑满 50 轮，返回 ''
```

如果 agent 连续调用工具 50 轮没有收敛，最后返回空字符串 `''`。`parseAgentOutput` 会在这个空字符串上调用 `JSON.parse('')` 并抛出异常。虽然有 catch 兜底，但错误信息不直观，而且 `recordSuccess` 已经被调用了 —— 一个返回空内容的 run 被标记为 success。

**修复建议**: 循环结束后检查 `finalContent === ''`，如果是，用最后一轮 response 的 content 或者抛出一个 "max turns exhausted" 错误。

### NEW-BUG-2: TypeScript 编译失败 🔴

**文件**: `src/index.ts:112, 271, 382`

```
error TS2345: Property 'context_chain' is missing in type ...
```

三处 `createTask()` 调用（`handleInbound`、`handleAdjutantOutput`、`handleOperationsOutput`）没有传入 `context_chain` 属性。由于 `Task` 接口要求 `context_chain: string | null`，`Omit<Task, 'created_at' | 'updated_at'>` 仍然包含它。

**测试为什么通过了**: 测试中的 `makeTestTask()` helper 包含了 `context_chain: null`，所以测试不会触发这个错误。而且 vitest 默认不做类型检查。

**修复**: 在三处 createTask 调用中加 `context_chain: null`。

### NEW-ISSUE-1: War Room controlTask 绕过状态机验证

**文件**: `src/war-room/watcher.ts:312-313`

```typescript
this.wdb.prepare('UPDATE tasks SET state = ?, updated_at = ? WHERE id = ?').run(newState, now, taskId);
```

War Room 的 `controlTask` 直接 SQL UPDATE 状态，没有经过 `state-machine.ts` 的 `canTransition()` 验证。虽然 resume 时通过 flow_log 查找 `from_state` 是正确的，但 cancel 操作不检查当前状态是否允许被取消（虽然目前所有非终态都可以被取消，但未来可能变）。

此外 resume 和 cancel 的两步操作（UPDATE tasks + INSERT flow_log）也没有用事务包裹，与 DESIGN-1 的修复精神不一致。

### NEW-ISSUE-2: CircuitBreaker half_open 状态下的 attempts 不递增

**文件**: `src/arsenal/circuit-breaker.ts:44-45`

```typescript
case 'half_open':
  return this.halfOpenAttempts < this.halfOpenMax;
```

`canExecute()` 检查 `halfOpenAttempts < halfOpenMax`，但永远不递增 `halfOpenAttempts`。只有从 `open` 转到 `half_open` 时把它重置为 0。这意味着在 `half_open` 状态下，`canExecute()` 将永远返回 true（因为 `0 < 3` 永远为真），直到 `recordFailure()` 把状态改回 `open`。

实际效果：`halfOpenMax` 配置无效，half_open 状态不限制并发探测次数。

**修复**: 在 `canExecute()` 的 half_open 分支中加 `this.halfOpenAttempts++`。

### NEW-ISSUE-3: CostTracker 只告警不拦截

**文件**: `src/depot/cost-tracker.ts:60-68`

```typescript
if (this.isBudgetExceeded()) {
  logger.warn({ ... }, 'Daily budget exceeded!');
}
return response;  // ← 依然返回，不阻止
```

超出每日预算后，新的 LLM 调用依然会执行并返回。如果一个失控的 Engineer 疯狂调工具，预算没有硬性限制。

**建议**: 要么在调用前检查并 throw，要么加一个 `strict` mode 选项。

### NEW-ISSUE-4: code_execute 仍使用 execSync（by design 但需注意）

`tool-executor.ts:159` 的 `codeExecute` 使用 `execSync`（shell 模式），这是有意的 —— Engineer 需要执行任意 shell 命令。但需注意：

1. 没有沙箱隔离（没有 Docker/nsjail）
2. `env` 只添加了 `NODE_ENV: 'production'`，但继承了 `process.env` 的所有环境变量（包括 API keys）
3. `claude_code` 工具也类似，继承完整环境

在生产环境中，被 prompt injection 操纵的 Engineer 可以读取 `process.env.ANTHROPIC_API_KEY`。CredentialProxy 的 token 机制没有被实际使用。

### NEW-ISSUE-5: Dashboard XSS 防护不完整

**文件**: `src/war-room/api.ts:603-606`

```javascript
card.innerHTML =
  '<div class="task-id">' + t.id.slice(0, 8) + '</div>' +
  '<div class="task-desc" title="' + escapeHtml(t.description) + '">' + ...
```

`task.id` 没有经过 `escapeHtml()`。虽然 task ID 是由系统生成的 `task-${uuid}`，但如果通过 API 或 DB 注入了恶意 ID，可以造成 XSS。概率极低，但作为审查仍然指出。

---

## 五、架构层面的进展

### 进步 1: 信息流已贯通
上次审查的核心批评 —— "所有 agent 只看到 `task.description`" —— 已经解决。`context_chain` 让每个 agent 能看到上游 agent 的完整输出。`buildContext()` 将其渲染为 `## Upstream Agent Outputs` 注入到 system prompt。这是从"骨架"到"有血管的有机体"的关键一步。

### 进步 2: 并发真正工作了
`processLoop` 改为批量 dequeue + `Promise.allSettled`，配合 `TaskQueue` 的 `maxConcurrent` 检查。5 个任务现在真的可以并行处理。

### 进步 3: Agentic Loop 是正确的抽象
将 agent 分为"无工具（单次调用）"和"有工具（多轮循环）"两类，是合理的分层。Engineer 可以 Read → Edit → Test → Fix，这让它具备了解决真实编程问题的能力。`claude_code` 作为 meta-tool 更是把能力上限推到了 Claude Code CLI 的水平。

### 仍然缺少的
1. **CLI 入口** —— 仍然只能通过 Lark 发任务
2. **Template 注册** —— `this.templates` 仍然是空数组，fast-path 仍然不工作
3. **OpenAI failover** —— 仍然是 stub
4. **CredentialProxy 未接入** —— token 生成/验证机制存在但从未被 tool executor 调用

---

## 六、代码质量评分（与 v1 对比）

| 维度 | v1 评分 | v2 评分 | 变化 | 说明 |
|------|---------|---------|------|------|
| **架构设计** | 8/10 | 8.5/10 | +0.5 | context_chain 补上了关键缺失 |
| **类型安全** | 9/10 | 7/10 | -2 | 3 个 TS 编译错误，测试不做类型检查 |
| **可测试性** | 8/10 | 9/10 | +1 | 276 个测试，包括针对性的 bug fix 验证 |
| **安全性** | 5/10 | 7/10 | +2 | SEC-1/2 已修复，但 env 泄露和 code_execute 仍是风险 |
| **完整性** | 6/10 | 7.5/10 | +1.5 | agentic loop + 工具 + context chain，核心管线可跑通 |
| **可运维性** | 7/10 | 8/10 | +1 | Sand Table 仪表盘完整可用 |

---

## 七、修复优先级

### P0（必须立即修复）

1. **TypeScript 编译错误** — 三处 `createTask()` 缺少 `context_chain: null`。代码无法 `tsc` 编译。
2. **Agentic Loop MAX_TURNS 空返回** — 循环跑满后返回空字符串，应该用最后一轮 content 或明确报错。

### P1（应该很快修复）

3. **CircuitBreaker halfOpenAttempts 不递增** — `halfOpenMax` 配置无效。
4. **War Room controlTask 加事务** — 与 DESIGN-1 修复保持一致。
5. **CostTracker 加硬性限制** — 超预算应阻止新调用。

### P2（计划修复）

6. **code_execute 环境变量隔离** — 至少过滤掉 `*_API_KEY` 相关的 env vars。
7. **注册默认 templates** — 让 fast-path 对简单任务生效。
8. **添加 CLI 入口** — 不依赖 Lark 也能发任务。

---

## 八、总体评价

这一轮改动的质量**整体优秀**。7 个 bug fix 全部到位，修复方式正确且配有验证测试。最关键的 context_chain 实现让整个 agent 管线从"各自独立"变成了"信息贯通"。Agentic Loop 的引入让 Engineer 具备了真正的自主编程能力。Sand Table 仪表盘虽然是嵌入式 HTML，但完成度很高。

唯一的硬伤是 **TypeScript 编译失败** —— 这说明在提交前没有跑 `tsc --noEmit`。测试全部通过是因为 vitest 默认不做类型检查。建议将 `npm run typecheck` 加入 CI 或 pre-commit hook。

从"骨架"到"可运行的系统"，这次改动完成了大约 80% 的距离。剩下的 20% 是：接入真正的 Channel（CLI 或 Lark webhook）、注册 templates、环境变量隔离。

**一句话总结**: Bug fix 质量过硬，核心功能补全到位，但 `tsc --noEmit` 没有通过 —— 提交前跑一次 typecheck 就好了。
