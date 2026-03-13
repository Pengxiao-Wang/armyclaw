// ═══════════════════════════════════════════════════════════
// ArmyClaw — HQ Main Entry Point (指挥所)
// The main orchestrator process that ties everything together
// ═══════════════════════════════════════════════════════════

import { randomUUID } from 'crypto';

import { initDatabase } from './db.js';
import {
  createTask,
  getTaskById,
  getTasksByParent,
  updateTask,
  updateTaskState,
  appendContextChain,
} from './db.js';
import { ChannelRegistry } from './channels/registry.js';
import { LarkChannel } from './channels/lark.js';
import { AgentRunner } from './agents/runner.js';
import { parseAgentOutput } from './agents/schemas.js';
import {
  AdjutantOutputSchema,
  ChiefOfStaffOutputSchema,
  InspectorOutputSchema,
  OperationsOutputSchema,
  EngineerOutputSchema,
} from './agents/schemas.js';
import { CredentialProxy } from './arsenal/credential-proxy.js';
import { loadAuthProfiles, getProfileSummary } from './arsenal/auth-profiles.js';
import { LLMClient } from './arsenal/llm-client.js';
import { Armory } from './arsenal/armory.js';
import { ExecProvider } from './arsenal/exec-provider.js';
import { ClaudeCodeProvider } from './arsenal/claude-code-provider.js';
import { Medic } from './medic/self-repair.js';
import { CostTracker } from './depot/cost-tracker.js';
import { MAX_TASK_ERRORS, PROJECT_DIR, MAX_CONCURRENT_ENGINEERS, MAX_SUBTASKS_HARD_CAP, SUBTASK_SLOT_RESERVE } from './config.js';
import { TaskQueue, QueuePriority } from './herald/queue.js';
import { routeTask, shouldSkipPlanning } from './herald/router.js';
import { transition, routeReject, setTerminalHook } from './herald/state-machine.js';
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

// ─── HQ ──────────────────────────────────────────────────────

export class HQ {
  private channels = new ChannelRegistry();
  private credentials = new CredentialProxy();
  private llm = new LLMClient();
  private armory = new Armory(PROJECT_DIR);
  private medic = new Medic();
  private costTracker = new CostTracker();
  private runner: AgentRunner;
  private queue = new TaskQueue();
  private templates: TaskTemplate[] = [];
  private running = false;
  private loopTimer: NodeJS.Timeout | null = null;
  private pendingRetries: { taskId: string; readyAt: number; priority: QueuePriority }[] = [];

  constructor() {
    this.runner = new AgentRunner(this.llm, this.costTracker, this.armory);
  }

  async start(): Promise<void> {
    logger.info('HQ (指挥所) starting...');
    initDatabase();

    // Initialize Armory — loads MCP servers from armory.json + registers built-in providers
    this.armory.registerProvider(new ExecProvider());
    this.armory.registerProvider(new ClaudeCodeProvider());
    await this.armory.initialize();

    // Load auth profiles (auth-profiles.json > env vars, supports OAuth tokens + API keys)
    loadAuthProfiles();
    logger.info({ profiles: getProfileSummary() }, 'Auth profiles loaded');

    // Load API credentials (legacy env-based proxy)
    this.credentials.loadFromEnv();
    logger.info({ providers: this.credentials.getLoadedProviders() }, 'Credential proxy loaded');

    // Register terminal hook — when a subtask reaches DONE/FAILED/CANCELLED,
    // automatically check if the parent task can proceed.
    setTerminalHook((_childId, parentId) => {
      this.checkSubtaskCompletion(parentId);
    });

    // Start medic (stuck-task recovery) — pass enqueue callback so medic can re-queue recovered tasks
    this.medic.start(10_000, (taskId, priority) => this.queue.enqueue(taskId, priority));

    // Register channels
    this.channels.register(new LarkChannel());
    this.channels.setMessageHandler(this.handleInbound.bind(this));
    await this.channels.connectAll();

    // Start continuous worker model
    this.running = true;
    this.drainQueue();
    this.loopTimer = setInterval(() => this.drainQueue(), 1000);

    logger.info('HQ (指挥所) ready');
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.loopTimer) {
      clearInterval(this.loopTimer);
      this.loopTimer = null;
    }
    this.queue.shutdown();
    this.medic.stop();
    await this.armory.shutdown();
    await this.channels.disconnectAll();
    logger.info('HQ (指挥所) shutdown');
  }

  /**
   * Handle an inbound message from any channel.
   * Creates a task in RECEIVED state and enqueues it.
   */
  private handleInbound(message: InboundMessage): void {
    logger.info(
      { channel: message.channel, sender: message.sender_name, content: message.content.slice(0, 80) },
      'Inbound message received',
    );

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
    this.drainQueue();

    logger.info({ taskId: task.id }, 'Task created from inbound message');
  }

  /**
   * Drain the queue: start a processOne() for each dequeueable task.
   * Non-blocking — each task runs independently, no batch barrier.
   */
  private drainQueue(): void {
    if (!this.running) return;

    this.flushPendingRetries();

    while (true) {
      const taskId = this.queue.dequeue();
      if (!taskId) break;
      this.processOne(taskId);
    }
  }

  /**
   * Process a single task through one pipeline step, then re-drain.
   * Each task is fully independent — completes and immediately frees its slot.
   */
  private async processOne(taskId: string): Promise<void> {
    let hadError = false;
    try {
      const task = getTaskById(taskId);
      if (task) {
        await this.processTask(task);
      }
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

      // Immediately try to fill freed slot — zero delay
      this.drainQueue();
    }
  }

  /**
   * Flush pending retries whose backoff timer has expired.
   * Tasks are re-enqueued for processing; stale entries (terminal tasks) are discarded.
   */
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

  /**
   * Schedule a task retry with exponential backoff.
   */
  private scheduleRetry(taskId: string, delayMs: number, priority: QueuePriority): void {
    this.pendingRetries.push({ taskId, readyAt: Date.now() + delayMs, priority });
  }

  /**
   * Process a single task through the pipeline.
   *
   * 1. Route task to the correct agent based on current state
   * 2. Run the agent
   * 3. Parse output
   * 4. Based on output + current state, transition to next state
   * 5. Re-enqueue if task needs further processing
   */
  private async processTask(task: Task): Promise<void> {
    // Terminal states — nothing to do (parent notification is handled by the terminal hook)
    if (task.state === TS.DONE || task.state === TS.FAILED || task.state === TS.CANCELLED) {
      return;
    }

    // Paused — skip
    if (task.state === TS.PAUSED) {
      return;
    }

    // DELIVERING is mechanical — extract from context_chain, no LLM needed
    if (task.state === TS.DELIVERING) {
      logger.info({ taskId: task.id, state: task.state }, 'Processing task (delivery)');
      await this.handleDelivery(task);
      return;
    }

    const role = routeTask(task);
    logger.info({ taskId: task.id, state: task.state, role }, 'Processing task');

    try {
      const rawOutput = await this.runner.runAgent(task, role, task.description);

      // Process based on current state and role
      switch (task.state) {
        case TS.RECEIVED:
        case TS.SPLITTING:
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
      }

      // Success — reset error count so transient failures don't accumulate across phases
      if (task.error_count > 0) {
        updateTask(task.id, { error_count: 0 });
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      const newErrorCount = (task.error_count ?? 0) + 1;
      updateTask(task.id, { error_count: newErrorCount });

      if (newErrorCount >= MAX_TASK_ERRORS) {
        // Max errors exceeded — force-fail (bypass state machine validation)
        logger.error(
          { taskId: task.id, errorCount: newErrorCount, error: errorMsg },
          'Task failed — max consecutive errors exceeded',
        );
        updateTaskState(task.id, TS.FAILED as TaskState, role,
          `Failed after ${newErrorCount} consecutive errors: ${errorMsg}`);
        this.replyToSource(task, `[Task Failed] ${task.id}: ${errorMsg}`).catch(() => {});
        this.markReactionTerminal(task, TS.FAILED);
        if (task.parent_id) {
          this.checkSubtaskCompletion(task.parent_id);
        }
      } else {
        // Exponential backoff: 2s, 4s, 8s, 16s, 32s (capped at 60s)
        const backoffMs = Math.min(2000 * Math.pow(2, newErrorCount - 1), 60_000);
        logger.warn(
          { taskId: task.id, role, errorCount: newErrorCount, nextRetryMs: backoffMs, error: errorMsg },
          'Agent error — scheduled retry with backoff',
        );
        this.scheduleRetry(task.id, backoffMs, QueuePriority.NEW_TASK);
      }
      // Re-throw so the outer finally knows this was an error (hadError flag)
      throw err;
    }
  }

  // ─── Reply Routing ─────────────────────────────────────────

  private async replyToSource(task: Task, text: string): Promise<void> {
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

  /**
   * Swap Typing → terminal emoji on the original message.
   * Only call this when a task truly reaches terminal state.
   */
  private markReactionTerminal(task: Task, state: string): void {
    if (task.source_channel && task.source_message_id) {
      const emoji = HQ.TERMINAL_EMOJI[state] ?? 'DONE';
      const channel = this.channels.getChannel(task.source_channel);
      channel?.completeReaction?.(task.source_message_id, emoji).catch(() => {});
    }
  }

  // ─── Output Handlers ───────────────────────────────────────

  private async handleAdjutantOutput(task: Task, raw: string): Promise<void> {
    const output = parseAgentOutput(AdjutantOutputSchema, raw) as AdjutantOutput;
    appendContextChain(task.id, AR.ADJUTANT, raw);

    // Short-circuit: adjutant can handle simple messages (greetings, chitchat, trivial Q&A) directly
    if (output.direct_reply && output.reply) {
      transition(task.id, TS.SPLITTING, AR.ADJUTANT, 'Direct reply — short-circuit');
      await this.replyToSource(task, output.reply);
      transition(task.id, TS.DONE, AR.ADJUTANT, 'Adjutant handled directly');
      this.markReactionTerminal(task, TS.DONE);
      logger.info({ taskId: task.id }, 'Short-circuit: adjutant replied directly, skipping pipeline');
      return;
    }

    // If multiple tasks detected, create subtasks and split
    if (output.tasks.length > 1) {
      transition(task.id, TS.SPLITTING, AR.ADJUTANT, 'Multiple tasks detected');

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

      // Transition parent to EXECUTING — it waits for subtasks to complete
      transition(task.id, TS.EXECUTING, AR.ADJUTANT, 'Waiting for subtasks');
    } else {
      // Single task — needs full pipeline
      transition(task.id, TS.SPLITTING, AR.ADJUTANT, 'Adjutant processed');

      // Send adjutant's acknowledgment if provided
      if (output.reply) {
        await this.replyToSource(task, output.reply);
      }

      if (shouldSkipPlanning(task, this.templates)) {
        transition(task.id, TS.DISPATCHING, AR.ADJUTANT, 'Template fast-path — skip planning');
        logger.info({ taskId: task.id }, 'Template fast-path: SPLITTING → DISPATCHING (skip PLANNING)');
      } else {
        transition(task.id, TS.PLANNING, AR.ADJUTANT, 'Ready for planning');
      }
      this.queue.enqueue(task.id, QueuePriority.NEW_TASK);
    }
  }

  private async handleChiefOfStaffOutput(task: Task, raw: string): Promise<void> {
    const output = parseAgentOutput(ChiefOfStaffOutputSchema, raw) as ChiefOfStaffOutput;
    appendContextChain(task.id, AR.CHIEF_OF_STAFF, raw);

    // Update task intent type
    updateTask(task.id, { intent_type: output.type });

    switch (output.type) {
      case IntentType.ANSWER:
        // Direct answer — answer is in context_chain, will be delivered by adjutant after review
        transition(task.id, TS.GATE1_REVIEW, AR.CHIEF_OF_STAFF, 'Direct answer — skipping to review');
        this.queue.enqueue(task.id, QueuePriority.GATE_REVIEW);
        break;

      case IntentType.RESEARCH:
      case IntentType.EXECUTION:
        // Needs execution — go to gate1 review
        transition(task.id, TS.GATE1_REVIEW, AR.CHIEF_OF_STAFF, `Plan created (${output.type})`);
        this.queue.enqueue(task.id, QueuePriority.GATE_REVIEW);
        break;

      case IntentType.CAMPAIGN:
        // Multi-phase campaign — handled separately
        transition(task.id, TS.GATE1_REVIEW, AR.CHIEF_OF_STAFF, 'Campaign plan created');
        this.queue.enqueue(task.id, QueuePriority.GATE_REVIEW);
        break;
    }
  }

  private async handleInspectorOutput(task: Task, raw: string): Promise<void> {
    const output = parseAgentOutput(InspectorOutputSchema, raw) as InspectorOutput;
    appendContextChain(task.id, AR.INSPECTOR, raw);

    // Freeze rubric on first review
    if (!task.rubric && output.rubric.length > 0) {
      updateTask(task.id, { rubric: JSON.stringify(output.rubric) });
    }

    if (output.verdict === 'approve') {
      if (task.state === TS.GATE1_REVIEW) {
        // ANSWER type already replied — skip dispatching, go straight to delivery
        if (task.intent_type === IntentType.ANSWER) {
          transition(task.id, TS.DELIVERING, AR.INSPECTOR, 'Gate 1 approved (direct answer)');
        } else {
          transition(task.id, TS.DISPATCHING, AR.INSPECTOR, 'Gate 1 approved');
        }
        this.queue.enqueue(task.id, QueuePriority.NEW_TASK);
      } else if (task.state === TS.GATE2_REVIEW) {
        transition(task.id, TS.DELIVERING, AR.INSPECTOR, 'Gate 2 approved');
        this.queue.enqueue(task.id, QueuePriority.NEW_TASK);
      }
    } else {
      // Reject — route based on level
      const level = output.level ?? 'tactical';
      const targetState = routeReject(task.id, level);
      if (targetState === TS.FAILED) {
        // Notify user that the task could not be completed
        const findings = output.findings.join('; ') || 'Task rejected';
        await this.replyToSource(task, findings);
        this.markReactionTerminal(task, TS.FAILED);
      } else {
        // Re-enqueue for reprocessing
        this.queue.enqueue(task.id, QueuePriority.NEW_TASK);
      }
    }
  }

  private async handleOperationsOutput(task: Task, raw: string): Promise<void> {
    const output = parseAgentOutput(OperationsOutputSchema, raw) as OperationsOutput;
    appendContextChain(task.id, AR.OPERATIONS, raw);

    // Cap subtask count: min(MAX_CONCURRENT_ENGINEERS, 8) - reserve
    const maxSubtasks = Math.min(MAX_CONCURRENT_ENGINEERS, MAX_SUBTASKS_HARD_CAP) - SUBTASK_SLOT_RESERVE;
    const assignments = output.assignments.slice(0, maxSubtasks);
    if (output.assignments.length > maxSubtasks) {
      logger.warn(
        { taskId: task.id, requested: output.assignments.length, capped: maxSubtasks },
        'Operations subtask count capped to preserve slot availability',
      );
    }

    // Create subtasks for each assignment
    for (const assignment of assignments) {
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
      });
      this.queue.enqueue(subtask.id, QueuePriority.EXECUTING);
    }

    transition(task.id, TS.EXECUTING, AR.OPERATIONS, 'Dispatched to engineers');
    // Parent task waits for subtasks to complete
  }

  private async handleEngineerOutput(task: Task, raw: string): Promise<void> {
    const output = parseAgentOutput(EngineerOutputSchema, raw) as EngineerOutput;
    appendContextChain(task.id, AR.ENGINEER, raw);

    if (output.status === 'completed') {
      transition(task.id, TS.GATE2_REVIEW, AR.ENGINEER, 'Execution completed');
      this.queue.enqueue(task.id, QueuePriority.GATE_REVIEW);
    } else if (output.status === 'failed') {
      transition(task.id, TS.FAILED, AR.ENGINEER, `Execution failed: ${output.result}`);
      this.markReactionTerminal(task, TS.FAILED);
    } else if (output.status === 'blocked') {
      const newErrorCount = (task.error_count ?? 0) + 1;
      updateTask(task.id, { error_count: newErrorCount });

      if (newErrorCount >= MAX_TASK_ERRORS) {
        logger.error({ taskId: task.id, blockedCount: newErrorCount }, 'Engineer blocked too many times — failing');
        transition(task.id, TS.FAILED, AR.ENGINEER, `Blocked ${newErrorCount} times: ${output.result}`);
        this.markReactionTerminal(task, TS.FAILED);
      } else {
        const backoffMs = Math.min(5000 * Math.pow(2, newErrorCount - 1), 120_000);
        logger.warn({ taskId: task.id, reason: output.result, attempt: newErrorCount, nextRetryMs: backoffMs }, 'Engineer blocked — backing off');
        this.scheduleRetry(task.id, backoffMs, QueuePriority.EXECUTING);
      }
    }
  }

  /**
   * Check if all subtasks of a parent task have completed.
   * If all are in terminal states, transition parent accordingly:
   * - Any FAILED subtask → parent FAILED
   * - All DONE/CANCELLED → parent DELIVERING (for adjutant to deliver results)
   */
  private checkSubtaskCompletion(parentId: string): void {
    const parent = getTaskById(parentId);
    if (!parent) return;

    // Only act on parents that are waiting in EXECUTING state
    if (parent.state !== TS.EXECUTING) return;

    const subtasks = getTasksByParent(parentId);
    if (subtasks.length === 0) return;

    const terminalStates = new Set<TaskState>([TS.DONE, TS.FAILED, TS.CANCELLED]);
    const allTerminal = subtasks.every((st) => terminalStates.has(st.state));

    if (!allTerminal) return;

    const anyFailed = subtasks.some((st) => st.state === TS.FAILED);

    // Aggregate subtask results into parent context_chain
    for (const st of subtasks) {
      if (st.state === TS.DONE && st.context_chain) {
        try {
          const chain = JSON.parse(st.context_chain) as { role: string; output: string }[];
          const engineerEntry = chain.find(e => e.role === AR.ENGINEER);
          if (engineerEntry) {
            appendContextChain(parentId, AR.ENGINEER, engineerEntry.output);
          }
        } catch { /* skip invalid chain */ }
      }
    }

    if (anyFailed) {
      transition(parentId, TS.FAILED, AR.ADJUTANT, 'Subtask(s) failed');
      const failedDescs = subtasks.filter(st => st.state === TS.FAILED).map(st => st.description.slice(0, 80)).join('; ');
      this.replyToSource(parent, `部分子任务失败: ${failedDescs}`).catch(() => {});
      this.markReactionTerminal(parent, TS.FAILED);
      logger.info({ parentId }, 'Parent task failed — subtask(s) failed');
    } else {
      transition(parentId, TS.DELIVERING, AR.ADJUTANT, 'All subtasks completed');
      this.queue.enqueue(parentId, QueuePriority.NEW_TASK);
      this.drainQueue();
      logger.info({ parentId }, 'Parent task ready for delivery — all subtasks completed');
    }
  }

  /**
   * Deliver results to user. Mechanical — no LLM call needed.
   * Extracts the answer from context_chain (chief_of_staff's answer or engineer's result).
   */
  private async handleDelivery(task: Task): Promise<void> {
    // Subtasks don't message user — only parent delivers
    if (task.parent_id) {
      transition(task.id, TS.DONE, AR.ENGINEER, 'Subtask delivered to parent');
      // Check if parent is ready for delivery
      this.checkSubtaskCompletion(task.parent_id);
      return;
    }

    const reply = this.extractDeliveryContent(task);

    if (reply) {
      await this.replyToSource(task, reply);
      logger.info({ taskId: task.id, replyLength: reply.length }, 'Delivery sent');
    } else {
      logger.warn({ taskId: task.id }, 'Delivery: no content to deliver');
    }

    transition(task.id, TS.DONE, AR.ADJUTANT, 'Delivered');
    this.markReactionTerminal(task, TS.DONE);
  }

  /**
   * Extract JSON from raw LLM output (may contain thinking text + ```json blocks).
   * Same logic as parseAgentOutput but returns parsed object or null.
   */
  private extractJSON(raw: string): Record<string, unknown> | null {
    try {
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      const match = raw.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
      if (match) {
        try {
          return JSON.parse(match[1]!.trim()) as Record<string, unknown>;
        } catch { /* fall through */ }
      }
      return null;
    }
  }

  /**
   * Extract the deliverable content from context_chain.
   * Walks the chain backwards to find the most relevant output.
   */
  private extractDeliveryContent(task: Task): string | null {
    // Re-read task to get aggregated context_chain (subtask results may have been added)
    const freshTask = getTaskById(task.id);
    const contextChain = freshTask?.context_chain ?? task.context_chain;
    if (!contextChain) return null;

    let chain: { role: string; output: string }[];
    try {
      chain = JSON.parse(contextChain);
    } catch {
      return null;
    }

    // For ANSWER type: chief_of_staff's answer field is the deliverable
    if (task.intent_type === IntentType.ANSWER) {
      const cosEntry = chain.find((e) => e.role === AR.CHIEF_OF_STAFF);
      if (cosEntry) {
        const parsed = this.extractJSON(cosEntry.output);
        if (parsed?.answer) return parsed.answer as string;
      }
    }

    // Collect all engineer results (from subtasks aggregated into parent)
    const engineerResults: string[] = [];
    for (const entry of chain) {
      if (entry.role === AR.ENGINEER) {
        const parsed = this.extractJSON(entry.output);
        if (parsed?.result) {
          engineerResults.push(parsed.result as string);
        }
      }
    }

    // Multiple engineer results → concatenate with separators
    if (engineerResults.length > 1) {
      return engineerResults.join('\n\n---\n\n');
    }
    if (engineerResults.length === 1) {
      return engineerResults[0]!;
    }

    // Single engineer or chief_of_staff result (non-subtask tasks)
    for (let i = chain.length - 1; i >= 0; i--) {
      const entry = chain[i]!;
      if (entry.role === AR.CHIEF_OF_STAFF) {
        const parsed = this.extractJSON(entry.output);
        if (parsed?.answer) return parsed.answer as string;
      }
    }

    // No fallback — never leak internal JSON
    return null;
  }
}

// ─── CLI Entry ──────────────────────────────────────────────

const hq = new HQ();
hq.start().catch((err) => {
  logger.fatal({ err }, 'HQ failed to start');
  process.exit(1);
});

process.on('SIGINT', async () => {
  await hq.stop();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  await hq.stop();
  process.exit(0);
});
