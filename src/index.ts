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
import { LLMClient } from './arsenal/llm-client.js';
import { Medic } from './medic/self-repair.js';
import { CostTracker } from './depot/cost-tracker.js';
import { MAX_TASK_ERRORS } from './config.js';
import { TaskQueue, QueuePriority } from './herald/queue.js';
import { routeTask, shouldSkipPlanning } from './herald/router.js';
import { transition, routeReject } from './herald/state-machine.js';
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
  private medic = new Medic();
  private costTracker = new CostTracker();
  private runner: AgentRunner;
  private queue = new TaskQueue();
  private templates: TaskTemplate[] = [];
  private running = false;
  private loopTimer: NodeJS.Timeout | null = null;
  private pendingRetries: { taskId: string; readyAt: number; priority: QueuePriority }[] = [];

  constructor() {
    this.runner = new AgentRunner(this.llm, this.costTracker);
  }

  async start(): Promise<void> {
    logger.info('HQ (指挥所) starting...');
    initDatabase();

    // Load API credentials
    this.credentials.loadFromEnv();
    logger.info({ providers: this.credentials.getLoadedProviders() }, 'Credential proxy loaded');

    // Start medic (stuck-task recovery) — pass enqueue callback so medic can re-queue recovered tasks
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
    });

    this.queue.enqueue(task.id, QueuePriority.NEW_TASK);

    logger.info({ taskId: task.id }, 'Task created from inbound message');
  }

  /**
   * Main processing loop. Dequeues tasks and processes them.
   */
  private processLoop(): void {
    if (!this.running) return;

    const processBatch = async () => {
      if (!this.running) return;

      // Flush pending retries whose backoff has expired
      this.flushPendingRetries();

      // Dequeue up to maxConcurrent tasks (queue.dequeue respects the limit)
      const taskPromises: Promise<void>[] = [];

      while (true) {
        const taskId = this.queue.dequeue();
        if (!taskId) break;

        taskPromises.push(
          (async () => {
            let hadError = false;
            try {
              const task = getTaskById(taskId);
              if (task) {
                await this.processTask(task);
              }
            } catch (err) {
              hadError = true;
              // Error handling is done inside processTask's catch block.
              // This outer catch is a safety net for unexpected errors.
              logger.error(
                { taskId, error: err instanceof Error ? err.message : String(err) },
                'Task processing failed (outer)',
              );
            } finally {
              // Must complete before re-enqueue — enqueue() skips active tasks
              this.queue.complete(taskId);

              // Only re-enqueue on success. On error, processTask handles retry scheduling.
              if (!hadError) {
                const updated = getTaskById(taskId);
                const terminal: string[] = [TS.DONE, TS.FAILED, TS.CANCELLED, TS.PAUSED, TS.EXECUTING];
                if (updated && !terminal.includes(updated.state)) {
                  this.queue.enqueue(taskId, QueuePriority.NEW_TASK);
                }
              }
            }
          })(),
        );
      }

      if (taskPromises.length > 0) {
        await Promise.allSettled(taskPromises);
      }

      // Schedule next iteration
      this.loopTimer = setTimeout(() => {
        this.processLoop();
      }, this.queue.getQueueLength() > 0 ? 100 : 1000);
    };

    processBatch();
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
    // Terminal states — check if parent needs updating, then return
    if (task.state === TS.DONE || task.state === TS.FAILED || task.state === TS.CANCELLED) {
      if (task.parent_id) {
        this.checkSubtaskCompletion(task.parent_id);
      }
      return;
    }

    // Paused — skip
    if (task.state === TS.PAUSED) {
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

        case TS.DELIVERING:
          await this.handleDelivery(task, rawOutput);
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

  // ─── Output Handlers ───────────────────────────────────────

  private async handleAdjutantOutput(task: Task, raw: string): Promise<void> {
    const output = parseAgentOutput(AdjutantOutputSchema, raw) as AdjutantOutput;
    appendContextChain(task.id, AR.ADJUTANT, raw);

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
      // Single task — check for template fast-path
      transition(task.id, TS.SPLITTING, AR.ADJUTANT, 'Adjutant processed');

      if (shouldSkipPlanning(task, this.templates)) {
        // Fast-path: template says skip planning, go directly to dispatching
        transition(task.id, TS.DISPATCHING, AR.ADJUTANT, 'Template fast-path — skip planning');
        logger.info({ taskId: task.id }, 'Template fast-path: SPLITTING → DISPATCHING (skip PLANNING)');
      } else {
        transition(task.id, TS.PLANNING, AR.ADJUTANT, 'Ready for planning');
      }
      // Re-enqueue for next agent
      this.queue.enqueue(task.id, QueuePriority.NEW_TASK);
    }

    // Send reply back to channel if there is one
    if (output.reply) {
      await this.replyToSource(task, output.reply);
    }
  }

  private async handleChiefOfStaffOutput(task: Task, raw: string): Promise<void> {
    const output = parseAgentOutput(ChiefOfStaffOutputSchema, raw) as ChiefOfStaffOutput;
    appendContextChain(task.id, AR.CHIEF_OF_STAFF, raw);

    // Update task intent type
    updateTask(task.id, { intent_type: output.type });

    switch (output.type) {
      case IntentType.ANSWER:
        // Direct answer — skip planning, go to delivery
        if (output.answer) {
          await this.replyToSource(task, output.answer);
        }
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
      routeReject(task.id, level);
      // Re-enqueue for reprocessing
      const updatedTask = getTaskById(task.id);
      if (updatedTask && updatedTask.state !== TS.FAILED) {
        this.queue.enqueue(task.id, QueuePriority.NEW_TASK);
      }
    }
  }

  private async handleOperationsOutput(task: Task, raw: string): Promise<void> {
    const output = parseAgentOutput(OperationsOutputSchema, raw) as OperationsOutput;
    appendContextChain(task.id, AR.OPERATIONS, raw);

    // Create subtasks for each assignment
    for (const assignment of output.assignments) {
      const subtask = createTask({
        id: assignment.subtask_id || `task-${randomUUID().slice(0, 8)}`,
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
    } else if (output.status === 'blocked') {
      const newErrorCount = (task.error_count ?? 0) + 1;
      updateTask(task.id, { error_count: newErrorCount });

      if (newErrorCount >= MAX_TASK_ERRORS) {
        logger.error({ taskId: task.id, blockedCount: newErrorCount }, 'Engineer blocked too many times — failing');
        transition(task.id, TS.FAILED, AR.ENGINEER, `Blocked ${newErrorCount} times: ${output.result}`);
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

    if (anyFailed) {
      transition(parentId, TS.FAILED, AR.ADJUTANT, 'Subtask(s) failed');
      logger.info({ parentId }, 'Parent task failed — subtask(s) failed');
    } else {
      transition(parentId, TS.DELIVERING, AR.ADJUTANT, 'All subtasks completed');
      this.queue.enqueue(parentId, QueuePriority.NEW_TASK);
      logger.info({ parentId }, 'Parent task ready for delivery — all subtasks completed');
    }
  }

  private async handleDelivery(task: Task, raw: string): Promise<void> {
    // Adjutant delivers the result back to the user
    const output = parseAgentOutput(AdjutantOutputSchema, raw) as AdjutantOutput;
    appendContextChain(task.id, AR.ADJUTANT, raw);

    if (output.reply) {
      await this.replyToSource(task, output.reply);
    }

    transition(task.id, TS.DONE, AR.ADJUTANT, 'Delivered');
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
