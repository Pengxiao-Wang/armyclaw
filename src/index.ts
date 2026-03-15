// ═══════════════════════════════════════════════════════════
// ArmyClaw V2 — HQ Main Entry Point (指挥所)
//
// Architecture:
//   kernel/     — Infrastructure (NanoClaw-inspired)
//   orchestration/ — Agent hierarchy & PDCA pipeline
//   war-room/   — Dashboard (separate process)
//
// Three-layer communication:
//   Layer 0: User ←→ Adjutant (this process, with Context Bus)
//   Layer 1: Adjutant ←→ Staff / Inspector / Operations
//   Layer 2: Operations ←→ Engineers ×N
// ═══════════════════════════════════════════════════════════

import { randomUUID } from 'crypto';

import { initDatabase } from './kernel/db.js';
import {
  createTask,
  getTaskById,
  getTasksByParent,
  updateTask,
  updateTaskState,
  appendContextChain,
} from './kernel/db.js';
import { ChannelRegistry } from './kernel/channels/registry.js';
import { LarkChannel } from './kernel/channels/lark.js';
import { AgentRunner } from './orchestration/agents/runner.js';
import { parseAgentOutput } from './orchestration/agents/schemas.js';
import {
  AdjutantOutputSchema,
  ChiefOfStaffOutputSchema,
  InspectorOutputSchema,
  OperationsOutputSchema,
  EngineerOutputSchema,
} from './orchestration/agents/schemas.js';
import { LLMClient } from './orchestration/arsenal.js';
import { loadAuthProfiles } from './orchestration/auth-profiles.js';
import { Medic } from './orchestration/medic.js';
import { CostTracker } from './orchestration/depot.js';
import { LogObserver } from './kernel/observability/log-observer.js';
import { HealthChecker } from './kernel/observability/health.js';
import { LeakDetector } from './kernel/safety/leak-detector.js';
import { initMemoryTables } from './kernel/memory/store.js';
import { Archivist } from './orchestration/archivist.js';
import { estimateTokens } from './kernel/memory/chunker.js';
import {
  MAX_TASK_ERRORS, MAX_CONCURRENT_ENGINEERS, MAX_SUBTASKS_HARD_CAP, SUBTASK_SLOT_RESERVE, MAX_SUBTASK_DEPTH,
  CONTEXT_MAX_TOKENS, CONTEXT_ARCHIVE_THRESHOLD, CONTEXT_KEEP_RECENT, PROCESS_LOOP_INTERVAL_MS,
} from './config.js';
import { TaskQueue, QueuePriority } from './orchestration/herald/queue.js';
import { routeTask, shouldSkipPlanning } from './orchestration/herald/router.js';
import { transition, routeReject, setTerminalHook } from './orchestration/herald/state-machine.js';
import { loadAllTools, startHotReload } from './kernel/wasm/loader.js';
import { logger } from './logger.js';
import type {
  Task,
  TaskState,
  TaskTemplate,
  AgentRole,
  InboundMessage,
  AdjutantOutput,
  ChiefOfStaffOutput,
  InspectorOutput,
  OperationsOutput,
  EngineerOutput,
} from './types.js';
import { TaskState as TS, AgentRole as AR, IntentType } from './types.js';

// ─── Context Bus: per-chat conversation history ─────────

interface ContextTurn {
  role: 'user' | 'adjutant';
  content: string;
  at: string;
}

// ─── HQ ──────────────────────────────────────────────────────

export class HQ {
  private channels = new ChannelRegistry();
  private llm = new LLMClient();
  private medic = new Medic();
  private costTracker = new CostTracker();
  private observer = new LogObserver();
  private healthChecker: HealthChecker;
  private leakDetector = new LeakDetector();
  private archivist = new Archivist();
  private runner: AgentRunner;
  private queue = new TaskQueue();
  private templates: TaskTemplate[] = [];
  private running = false;
  private loopTimer: NodeJS.Timeout | null = null;
  private pendingRetries: { taskId: string; readyAt: number; priority: QueuePriority }[] = [];

  /** Context Bus: conversation history per chat_id */
  private contextBus = new Map<string, ContextTurn[]>();

  constructor() {
    this.runner = new AgentRunner(this.llm, this.costTracker);
    this.healthChecker = new HealthChecker(this.observer, () => {
      const breaker = this.llm.getCircuitBreaker('anthropic');
      return breaker?.getState() ?? 'closed';
    });
  }

  async start(): Promise<void> {
    logger.info('HQ (指挥所) starting...');
    initDatabase();
    initMemoryTables();
    loadAuthProfiles();

    // Load WASM tools and start hot-reload watcher
    loadAllTools();
    startHotReload();

    LLMClient.setObserver(this.observer);

    // Register terminal hook — subtask completion propagates to parent
    setTerminalHook((_childId, parentId) => {
      this.checkSubtaskCompletion(parentId);
    });

    // Start health checker
    this.healthChecker.start();

    // Start medic (stuck-task recovery)
    this.medic.start(10_000, (taskId, priority) => this.queue.enqueue(taskId, priority));

    // Register channels
    this.channels.register(new LarkChannel());
    this.channels.setMessageHandler(this.handleInbound.bind(this));
    await this.channels.connectAll();

    // Start main loop
    this.running = true;
    this.processLoop();

    logger.info('HQ (指挥所) ready');
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.loopTimer) {
      clearTimeout(this.loopTimer);
      this.loopTimer = null;
    }
    this.queue.shutdown();
    this.medic.stop();
    this.healthChecker.stop();
    await this.channels.disconnectAll();
    logger.info('HQ (指挥所) shutdown');
  }

  // ─── Context Bus Operations ──────────────────────────────

  /** Record a user message into the context bus */
  private recordUserMessage(chatId: string, content: string): void {
    if (!this.contextBus.has(chatId)) {
      this.contextBus.set(chatId, []);
    }
    this.contextBus.get(chatId)!.push({
      role: 'user',
      content,
      at: new Date().toISOString(),
    });
  }

  /** Record an adjutant reply into the context bus */
  private recordAdjutantReply(chatId: string, content: string): void {
    if (!this.contextBus.has(chatId)) {
      this.contextBus.set(chatId, []);
    }
    this.contextBus.get(chatId)!.push({
      role: 'adjutant',
      content,
      at: new Date().toISOString(),
    });
  }

  /**
   * Build adjutant input with conversation history from context bus.
   * This is what makes the adjutant "remember" previous exchanges.
   */
  private buildAdjutantInput(chatId: string, currentMessage: string): string {
    const turns = this.contextBus.get(chatId) ?? [];
    if (turns.length === 0) return currentMessage;

    // Format conversation history (excluding the current message which is already the last turn)
    const history = turns.slice(0, -1); // exclude last (which is the current user message we just recorded)
    if (history.length === 0) return currentMessage;

    const formatted = history.map(t =>
      t.role === 'user' ? `User: ${t.content}` : `Adjutant: ${t.content}`
    ).join('\n');

    return `## Recent Conversation History\n${formatted}\n\n## Current Message\n${currentMessage}`;
  }

  /**
   * Check if context bus for a chat needs compression.
   * If so, ask the archivist to archive old turns.
   */
  private async maybeCompressContext(chatId: string): Promise<void> {
    const turns = this.contextBus.get(chatId);
    if (!turns || turns.length <= CONTEXT_KEEP_RECENT) return;

    // Estimate total tokens
    const totalText = turns.map(t => t.content).join(' ');
    const tokens = estimateTokens(totalText);

    if (tokens < CONTEXT_MAX_TOKENS * CONTEXT_ARCHIVE_THRESHOLD) return;

    // Archive old turns, keep recent ones
    const oldTurns = turns.slice(0, -CONTEXT_KEEP_RECENT);
    const recentTurns = turns.slice(-CONTEXT_KEEP_RECENT);

    const archiveContent = oldTurns.map(t =>
      `[${t.at}] ${t.role}: ${t.content}`
    );

    const summary = await this.archivist.archiveContext(archiveContent, `chat-${chatId}`);

    // Replace old turns with summary pointer
    this.contextBus.set(chatId, [
      { role: 'adjutant', content: summary, at: new Date().toISOString() },
      ...recentTurns,
    ]);

    logger.info(
      { chatId, archivedTurns: oldTurns.length, remainingTurns: recentTurns.length + 1 },
      'Context bus compressed',
    );
  }

  // ─── Inbound ─────────────────────────────────────────────

  private handleInbound(message: InboundMessage): void {
    logger.info(
      { channel: message.channel, sender: message.sender_name, content: message.content.slice(0, 80) },
      'Inbound message received',
    );

    // Record in context bus BEFORE creating task
    if (message.chat_id) {
      this.recordUserMessage(message.chat_id, message.content);
    }

    const task = createTask({
      id: `task-${randomUUID().slice(0, 8)}`,
      parent_id: null,
      campaign_id: null,
      state: TS.RECEIVED,
      description: message.content,
      priority: 'medium',
      assigned_agent: null,
      assigned_engineer_id: null,
      intent_type: null,
      reject_count_tactical: 0,
      reject_count_strategic: 0,
      rubric: null,
      artifacts_path: null,
      override_skip_gate: 0,
      source_channel: message.channel,
      source_chat_id: message.chat_id,
      source_message_id: message.id,
    });

    this.queue.enqueue(task.id, QueuePriority.NEW_TASK);
    logger.info({ taskId: task.id }, 'Task created from inbound message');
  }

  // ─── Main Loop (non-blocking, parallel) ─────────────────

  private processLoop(): void {
    if (!this.running) return;

    this.flushPendingRetries();

    // Dequeue all available tasks and fire them off — don't wait
    while (true) {
      const taskId = this.queue.dequeue();
      if (!taskId) break;

      // Fire and forget — each task runs independently
      this.processTaskWrapper(taskId).catch(() => {});
    }

    // Schedule next poll — fixed interval, never blocked by task execution
    this.loopTimer = setTimeout(() => this.processLoop(), PROCESS_LOOP_INTERVAL_MS);
  }

  /** Wrapper that handles the full lifecycle of a single task step */
  private async processTaskWrapper(taskId: string): Promise<void> {
    let hadError = false;
    try {
      const task = getTaskById(taskId);
      if (task) await this.processTask(task);
    } catch (err) {
      hadError = true;
      logger.error(
        { taskId, error: err instanceof Error ? err.message : String(err) },
        'Task processing failed (outer)',
      );
    } finally {
      this.queue.complete(taskId);
      if (!hadError) {
        const updated = getTaskById(taskId);
        const terminal: string[] = [TS.DONE, TS.FAILED, TS.CANCELLED, TS.PAUSED, TS.EXECUTING];
        if (updated && !terminal.includes(updated.state)) {
          this.queue.enqueue(taskId, QueuePriority.NEW_TASK);
        }
      }
    }
  }

  private flushPendingRetries(): void {
    if (this.pendingRetries.length === 0) return;
    const now = Date.now();
    const terminal = new Set<string>([TS.DONE, TS.FAILED, TS.CANCELLED]);
    this.pendingRetries = this.pendingRetries.filter((r) => {
      if (now >= r.readyAt) {
        const task = getTaskById(r.taskId);
        if (task && !terminal.has(task.state)) {
          this.queue.enqueue(r.taskId, r.priority);
        }
        return false;
      }
      return true;
    });
  }

  private scheduleRetry(taskId: string, delayMs: number, priority: QueuePriority): void {
    this.pendingRetries.push({ taskId, readyAt: Date.now() + delayMs, priority });
  }

  // ─── Task Processing ────────────────────────────────────

  private async processTask(task: Task): Promise<void> {
    if (task.state === TS.DONE || task.state === TS.FAILED || task.state === TS.CANCELLED) return;
    if (task.state === TS.PAUSED) return;

    const role = routeTask(task);
    logger.info({ taskId: task.id, state: task.state, role }, 'Processing task');

    try {
      // For adjutant: use context bus to build input with conversation history
      let input = task.description;
      if ((role === 'adjutant') && task.source_chat_id) {
        await this.maybeCompressContext(task.source_chat_id);
        input = this.buildAdjutantInput(task.source_chat_id, task.description);
      }

      // COLLECTING: build input from subtask results for operations
      if (task.state === TS.COLLECTING) {
        input = this.buildCollectingInput(task);
      }

      // GATE2_REVIEW: inspector needs to see the delivery_content, not just the original description
      if (task.state === TS.GATE2_REVIEW) {
        const freshTask = getTaskById(task.id);
        const dc = freshTask?.delivery_content ?? task.delivery_content;
        if (dc) {
          input = `## Original Request\n${task.description}\n\n## Integrated Report to Review\n${dc}`;
        }
      }

      // DELIVERING: build input from delivery_content for adjutant
      if (task.state === TS.DELIVERING) {
        input = this.buildDeliveringInput(task);
      }

      const rawOutput = await this.runner.runAgent(task, role, input);

      switch (task.state) {
        case TS.RECEIVED:
          await this.handleAdjutantOutput(task, rawOutput);
          break;
        case TS.PLANNING:
          await this.handleChiefOfStaffOutput(task, rawOutput);
          break;
        case TS.GATE1_REVIEW:
        case TS.GATE2_REVIEW:
          await this.handleInspectorOutput(task, rawOutput);
          break;
        case TS.DISPATCHING:
          await this.handleOperationsOutput(task, rawOutput);
          break;
        case TS.EXECUTING:
          await this.handleEngineerOutput(task, rawOutput);
          break;
        case TS.COLLECTING:
          await this.handleCollectingOutput(task, rawOutput);
          break;
        case TS.DELIVERING:
          await this.handleDeliveringOutput(task, rawOutput);
          break;
      }

      if (task.error_count > 0) {
        updateTask(task.id, { error_count: 0 });
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      const newErrorCount = (task.error_count ?? 0) + 1;
      updateTask(task.id, { error_count: newErrorCount });

      if (newErrorCount >= MAX_TASK_ERRORS) {
        logger.error({ taskId: task.id, errorCount: newErrorCount, error: errorMsg }, 'Task failed — max errors exceeded');
        updateTaskState(task.id, TS.FAILED as TaskState, role, `Failed after ${newErrorCount} errors: ${errorMsg}`);
        this.replyToSource(task, `[Task Failed] ${task.id}: ${errorMsg}`).catch(() => {});
        this.markReactionTerminal(task, TS.FAILED);
        this.archivist.archiveTaskResult(task).catch(() => {});
        if (task.parent_id) this.checkSubtaskCompletion(task.parent_id);
      } else {
        const backoffMs = Math.min(2000 * Math.pow(2, newErrorCount - 1), 60_000);
        logger.warn({ taskId: task.id, role, errorCount: newErrorCount, nextRetryMs: backoffMs, error: errorMsg }, 'Agent error — retry with backoff');
        this.scheduleRetry(task.id, backoffMs, QueuePriority.NEW_TASK);
      }
      throw err;
    }
  }

  // ─── Reply Routing ─────────────────────────────────────

  private async replyToSource(task: Task, text: string): Promise<void> {
    // Record adjutant reply in context bus
    if (task.source_chat_id) {
      this.recordAdjutantReply(task.source_chat_id, text);
    }

    if (task.source_channel && task.source_chat_id) {
      await this.channels.sendTo(task.source_channel, task.source_chat_id, text);
    } else {
      await this.channels.broadcast(text);
    }
  }

  private static readonly TERMINAL_EMOJI: Record<string, string> = {
    DONE: 'DONE',
    FAILED: 'PETRIFIED',
    CANCELLED: 'CrossMark',
  };

  private markReactionTerminal(task: Task, state: string): void {
    if (task.source_channel && task.source_message_id) {
      const emoji = HQ.TERMINAL_EMOJI[state] ?? 'DONE';
      const channel = this.channels.getChannel(task.source_channel);
      channel?.completeReaction?.(task.source_message_id, emoji).catch(() => {});
    }
  }

  // ─── Output Handlers ───────────────────────────────────

  private async handleAdjutantOutput(task: Task, raw: string): Promise<void> {
    const output = parseAgentOutput(AdjutantOutputSchema, raw) as AdjutantOutput;
    appendContextChain(task.id, AR.ADJUTANT, raw);

    if (output.direct_reply && output.reply) {
      await this.replyToSource(task, output.reply);
      transition(task.id, TS.DONE, AR.ADJUTANT, 'Adjutant handled directly');
      this.markReactionTerminal(task, TS.DONE);
      logger.info({ taskId: task.id }, 'Short-circuit: adjutant replied directly');
      return;
    }

    if (output.tasks.length > 1) {
      for (const sub of output.tasks) {
        const subtask = createTask({
          id: sub.id || `task-${randomUUID().slice(0, 8)}`,
          parent_id: task.id,
          campaign_id: task.campaign_id,
          state: TS.RECEIVED,
          description: sub.description,
          priority: sub.priority,
          assigned_agent: null,
          assigned_engineer_id: null,
          intent_type: null,
          reject_count_tactical: 0,
          reject_count_strategic: 0,
          rubric: null,
          artifacts_path: null,
          override_skip_gate: 0,
          source_channel: task.source_channel,
          source_chat_id: task.source_chat_id,
        });
        this.queue.enqueue(subtask.id, QueuePriority.NEW_TASK);
      }
      // Send acknowledgment if provided
      if (output.reply) await this.replyToSource(task, output.reply);
      // Parent waits in EXECUTING for subtasks to complete
      transition(task.id, TS.EXECUTING, AR.ADJUTANT, 'Waiting for subtasks');
    } else {
      if (output.reply) await this.replyToSource(task, output.reply);

      transition(task.id, TS.PLANNING, AR.ADJUTANT, 'Ready for planning');
      this.queue.enqueue(task.id, QueuePriority.NEW_TASK);
    }
  }

  private async handleChiefOfStaffOutput(task: Task, raw: string): Promise<void> {
    const output = parseAgentOutput(ChiefOfStaffOutputSchema, raw) as ChiefOfStaffOutput;
    appendContextChain(task.id, AR.CHIEF_OF_STAFF, raw);

    // Store chief of staff's estimates on the task (used by Medic for timeout)
    const updates: Record<string, unknown> = { intent_type: output.type };
    if (output.plan?.complexity) updates.complexity = output.plan.complexity;
    if (output.plan?.estimated_duration_sec) updates.timeout_sec = output.plan.estimated_duration_sec;
    updateTask(task.id, updates);

    switch (output.type) {
      case IntentType.ANSWER:
        transition(task.id, TS.GATE1_REVIEW, AR.CHIEF_OF_STAFF, 'Direct answer — to review');
        this.queue.enqueue(task.id, QueuePriority.GATE_REVIEW);
        break;
      case IntentType.RESEARCH:
      case IntentType.EXECUTION:
        transition(task.id, TS.GATE1_REVIEW, AR.CHIEF_OF_STAFF, `Plan created (${output.type})`);
        this.queue.enqueue(task.id, QueuePriority.GATE_REVIEW);
        break;
      case IntentType.CAMPAIGN:
        transition(task.id, TS.GATE1_REVIEW, AR.CHIEF_OF_STAFF, 'Campaign plan created');
        this.queue.enqueue(task.id, QueuePriority.GATE_REVIEW);
        break;
    }
  }

  private async handleInspectorOutput(task: Task, raw: string): Promise<void> {
    const output = parseAgentOutput(InspectorOutputSchema, raw) as InspectorOutput;
    appendContextChain(task.id, AR.INSPECTOR, raw);

    if (!task.rubric && output.rubric.length > 0) {
      updateTask(task.id, { rubric: JSON.stringify(output.rubric) });
    }

    if (output.verdict === 'approve') {
      if (task.state === TS.GATE1_REVIEW) {
        if (task.intent_type === IntentType.ANSWER) {
          transition(task.id, TS.DELIVERING, AR.INSPECTOR, 'Gate 1 approved (direct answer)');
        } else {
          transition(task.id, TS.DISPATCHING, AR.INSPECTOR, 'Gate 1 approved');
        }
        this.queue.enqueue(task.id, QueuePriority.NEW_TASK);
      } else if (task.state === TS.GATE2_REVIEW) {
        // Gate 2 reviews the integrated delivery_content from operations
        transition(task.id, TS.DELIVERING, AR.INSPECTOR, 'Gate 2 approved');
        this.queue.enqueue(task.id, QueuePriority.NEW_TASK);
      }
    } else {
      const level = output.level ?? 'tactical';
      const targetState = routeReject(task.id, level);
      this.archivist.archiveRejection(task, output.findings).catch(() => {});
      if (targetState === TS.FAILED) {
        const findings = output.findings.join('; ') || 'Task rejected';
        await this.replyToSource(task, findings);
        this.markReactionTerminal(task, TS.FAILED);
      } else {
        this.queue.enqueue(task.id, QueuePriority.NEW_TASK);
      }
    }
  }

  /** Parse the chief of staff's plan from context_chain */
  private getPlanFromChain(task: Task): { steps: { id: string; estimated_duration_sec?: number; complexity?: string }[] } | null {
    if (!task.context_chain) return null;
    try {
      const chain = JSON.parse(task.context_chain) as { role: string; output: string }[];
      const cosEntry = chain.find(e => e.role === 'chief_of_staff');
      if (!cosEntry) return null;
      let parsed: Record<string, unknown> | null = null;
      try { parsed = JSON.parse(cosEntry.output); } catch {
        const match = cosEntry.output.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
        if (match) try { parsed = JSON.parse(match[1].trim()); } catch { /* */ }
      }
      const plan = (parsed as { plan?: { steps?: { id: string; estimated_duration_sec?: number; complexity?: string }[] } })?.plan;
      if (plan?.steps && Array.isArray(plan.steps)) return { steps: plan.steps };
    } catch { /* non-fatal */ }
    return null;
  }

  /** Extract per-step durations from chief of staff's plan */
  private getStepDurations(task: Task): Record<string, number> {
    const durations: Record<string, number> = {};
    const plan = this.getPlanFromChain(task);
    if (!plan) return durations;
    for (const step of plan.steps) {
      if (step.id && step.estimated_duration_sec) {
        durations[step.id] = step.estimated_duration_sec;
      }
    }
    return durations;
  }

  /** Calculate how deep a task is in the parent chain */
  private getTaskDepth(task: Task): number {
    let depth = 0;
    let current: Task | undefined = task;
    while (current?.parent_id) {
      depth++;
      current = getTaskById(current.parent_id);
    }
    return depth;
  }

  private async handleOperationsOutput(task: Task, raw: string): Promise<void> {
    const output = parseAgentOutput(OperationsOutputSchema, raw) as OperationsOutput;
    appendContextChain(task.id, AR.OPERATIONS, raw);

    // Prevent infinite nesting: if already too deep, fail gracefully
    const depth = this.getTaskDepth(task);
    if (depth >= MAX_SUBTASK_DEPTH) {
      logger.warn({ taskId: task.id, depth, maxDepth: MAX_SUBTASK_DEPTH }, 'Subtask depth limit reached — executing directly instead of splitting');
      // Execute as a single task instead of splitting further
      transition(task.id, TS.EXECUTING, AR.OPERATIONS, `Depth limit (${depth}/${MAX_SUBTASK_DEPTH}) — no further splitting`);
      return;
    }

    // 1:1 mapping: operations must not create more assignments than plan steps
    const plan = this.getPlanFromChain(task);
    const planStepCount = plan?.steps?.length ?? 1;
    const maxBySlots = Math.min(MAX_CONCURRENT_ENGINEERS, MAX_SUBTASKS_HARD_CAP) - SUBTASK_SLOT_RESERVE;
    const maxSubtasks = Math.min(planStepCount, maxBySlots);
    const assignments = output.assignments.slice(0, maxSubtasks);
    if (output.assignments.length > maxSubtasks) {
      logger.warn({ taskId: task.id, requested: output.assignments.length, planSteps: planStepCount, capped: maxSubtasks }, 'Subtask count capped to plan steps (1:1 mapping)');
    }

    const stepDurations = this.getStepDurations(task);

    for (let i = 0; i < assignments.length; i++) {
      const assignment = assignments[i];
      // Match assignment to step duration (by index or subtask_id)
      const stepDuration = stepDurations[assignment.subtask_id] ?? stepDurations[`step-${i + 1}`] ?? task.timeout_sec;

      const subtask = createTask({
        id: `sub-${randomUUID().slice(0, 8)}`,
        parent_id: task.id,
        campaign_id: task.campaign_id,
        state: TS.EXECUTING,
        description: assignment.context,
        priority: task.priority,
        assigned_agent: AR.ENGINEER,
        assigned_engineer_id: assignment.engineer_id,
        intent_type: 'execution',
        reject_count_tactical: 0,
        reject_count_strategic: 0,
        rubric: task.rubric,
        artifacts_path: null,
        override_skip_gate: 0,
        source_channel: task.source_channel,
        source_chat_id: task.source_chat_id,
        complexity: (assignment.complexity as 'simple' | 'moderate' | 'complex') || 'complex',
        timeout_sec: stepDuration,
      });
      this.queue.enqueue(subtask.id, QueuePriority.EXECUTING);
    }

    transition(task.id, TS.EXECUTING, AR.OPERATIONS, 'Dispatched to engineers');
  }

  private async handleEngineerOutput(task: Task, raw: string): Promise<void> {
    const output = parseAgentOutput(EngineerOutputSchema, raw) as EngineerOutput;
    appendContextChain(task.id, AR.ENGINEER, raw);

    if (output.status === 'completed') {
      // Subtask completes directly to DONE (no per-subtask Gate2)
      // The parent task will go through COLLECTING -> GATE2_REVIEW after all subtasks are done
      transition(task.id, TS.DONE, AR.ENGINEER, 'Execution completed');
      this.markReactionTerminal(task, TS.DONE);
    } else if (output.status === 'failed') {
      transition(task.id, TS.FAILED, AR.ENGINEER, `Execution failed: ${output.result}`);
      this.markReactionTerminal(task, TS.FAILED);
    } else if (output.status === 'blocked') {
      const newErrorCount = (task.error_count ?? 0) + 1;
      updateTask(task.id, { error_count: newErrorCount });
      if (newErrorCount >= MAX_TASK_ERRORS) {
        transition(task.id, TS.FAILED, AR.ENGINEER, `Blocked ${newErrorCount} times: ${output.result}`);
        this.markReactionTerminal(task, TS.FAILED);
      } else {
        const backoffMs = Math.min(5000 * Math.pow(2, newErrorCount - 1), 120_000);
        logger.warn({ taskId: task.id, reason: output.result, attempt: newErrorCount }, 'Engineer blocked — backing off');
        this.scheduleRetry(task.id, backoffMs, QueuePriority.EXECUTING);
      }
    }
  }

  // ─── Subtask Completion ────────────────────────────────

  private checkSubtaskCompletion(parentId: string): void {
    const parent = getTaskById(parentId);
    if (!parent || parent.state !== TS.EXECUTING) return;

    const subtasks = getTasksByParent(parentId);
    if (subtasks.length === 0) return;

    const terminalStates = new Set<TaskState>([TS.DONE, TS.FAILED, TS.CANCELLED]);
    if (!subtasks.every((st) => terminalStates.has(st.state))) return;

    const anyFailed = subtasks.some((st) => st.state === TS.FAILED);

    // Aggregate subtask results into parent's context chain
    for (const st of subtasks) {
      if (st.state === TS.DONE && st.context_chain) {
        try {
          const chain = JSON.parse(st.context_chain) as { role: string; output: string }[];
          const engineerEntry = chain.find(e => e.role === AR.ENGINEER);
          if (engineerEntry) appendContextChain(parentId, AR.ENGINEER, engineerEntry.output);
        } catch { /* skip */ }
      }
    }

    if (anyFailed) {
      transition(parentId, TS.FAILED, AR.ADJUTANT, 'Subtask(s) failed');
      const failedDescs = subtasks.filter(st => st.state === TS.FAILED).map(st => st.description.slice(0, 80)).join('; ');
      this.replyToSource(parent, `部分子任务失败: ${failedDescs}`).catch(() => {});
      this.markReactionTerminal(parent, TS.FAILED);
    } else {
      // All subtasks done -> COLLECTING (operations integrates results)
      transition(parentId, TS.COLLECTING, AR.OPERATIONS, 'All subtasks completed — collecting');
      this.queue.enqueue(parentId, QueuePriority.NEW_TASK);
    }
  }

  // ─── Collecting (Operations integrates subtask results) ──

  private buildCollectingInput(task: Task): string {
    const subtasks = getTasksByParent(task.id);
    const sections: string[] = [
      `## Task: ${task.description}`,
      '',
      '## Subtask Results',
    ];

    for (const st of subtasks) {
      if (st.state === TS.DONE && st.context_chain) {
        try {
          const chain = JSON.parse(st.context_chain) as { role: string; output: string }[];
          const engineerEntry = chain.find(e => e.role === AR.ENGINEER);
          sections.push(`### Subtask: ${st.description}`);
          sections.push(engineerEntry?.output ?? '(no output)');
          sections.push('');
        } catch {
          sections.push(`### Subtask: ${st.description}\n(parse error)`);
        }
      }
    }

    // If no subtasks (single-task pipeline), use context chain directly
    if (subtasks.length === 0 && task.context_chain) {
      try {
        const chain = JSON.parse(task.context_chain) as { role: string; output: string }[];
        const engineerEntry = chain.find(e => e.role === AR.ENGINEER);
        if (engineerEntry) {
          sections.push('### Engineer Output');
          sections.push(engineerEntry.output);
        }
      } catch { /* skip */ }
    }

    sections.push('', 'Integrate all results above into a single coherent report.');
    return sections.join('\n');
  }

  private async handleCollectingOutput(task: Task, raw: string): Promise<void> {
    // Operations produces an integrated report as plain text
    // Store it in delivery_content for Gate2 review and eventual delivery
    const report = raw.trim();
    updateTask(task.id, { delivery_content: report });
    appendContextChain(task.id, AR.OPERATIONS, raw);

    transition(task.id, TS.GATE2_REVIEW, AR.OPERATIONS, 'Integrated report ready for review');
    this.queue.enqueue(task.id, QueuePriority.GATE_REVIEW);
  }

  // ─── Delivering (Adjutant translates report for user) ──

  private buildDeliveringInput(task: Task): string {
    const freshTask = getTaskById(task.id);
    const deliveryContent = freshTask?.delivery_content ?? task.delivery_content;

    if (deliveryContent) {
      return [
        '## Your Task',
        `Translate this technical report into a clear, friendly message for the user.`,
        `Use the same language as the original request.`,
        '',
        '## Original Request',
        task.description,
        '',
        '## Report to Translate',
        deliveryContent,
      ].join('\n');
    }

    // Fallback: use context chain if no delivery_content
    return [
      '## Your Task',
      `Summarize the task results for the user in a clear, friendly way.`,
      '',
      '## Original Request',
      task.description,
      '',
      '## Context',
      task.context_chain ?? '(no context available)',
    ].join('\n');
  }

  private async handleDeliveringOutput(task: Task, raw: string): Promise<void> {
    // Adjutant produces a user-friendly message as plain text
    const userMessage = raw.trim();

    if (userMessage) {
      // Final leak check before delivery
      const safeReply = this.leakDetector.sanitize(userMessage, `delivery for ${task.id}`);
      await this.replyToSource(task, safeReply);
      logger.info({ taskId: task.id, replyLength: safeReply.length }, 'Delivery sent');
    } else {
      logger.warn({ taskId: task.id }, 'Delivery: no content from adjutant');
    }

    transition(task.id, TS.DONE, AR.ADJUTANT, 'Delivered');
    this.archivist.archiveTaskResult(task).catch(() => {});
    this.markReactionTerminal(task, TS.DONE);
  }
}

// ─── CLI Entry ──────────────────────────────────────────────

const hq = new HQ();
hq.start().catch((err) => {
  logger.fatal({ err }, 'HQ failed to start');
  process.exit(1);
});

process.on('SIGINT', async () => { await hq.stop(); process.exit(0); });
process.on('SIGTERM', async () => { await hq.stop(); process.exit(0); });
