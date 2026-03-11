// ═══════════════════════════════════════════════════════════
// ArmyClaw — Agent Execution Engine (Agentic Loop)
//
// Non-tool agents (adjutant, operations): single LLM call
// Tool agents (engineer, chief_of_staff, inspector):
//   call LLM → use tools → feed results back → repeat
//   until LLM says "done" or max turns reached.
//
// This is the same pattern as Claude Code's sub-agents.
// ═══════════════════════════════════════════════════════════

import fs from 'fs';
import path from 'path';

import { SOULS_DIR, TASKS_DIR, MAX_AGENT_TURNS } from '../config.js';
import {
  getAgentConfig,
  recordAgentRun,
  updateAgentRun,
  writeProgressLog,
  getFlowLog,
} from '../db.js';
import { logger } from '../logger.js';
import type {
  AgentRole,
  Task,
  FlowLog,
  LLMRequest,
  LLMResponse,
  LLMMessage,
  ContentBlock,
  TextBlock,
  ToolUseBlock,
} from '../types.js';
import { LLMClient } from '../arsenal/llm-client.js';
import { CostTracker } from '../depot/cost-tracker.js';
import { getToolsForRole, getLLMToolsForRole } from './tools.js';
import { ToolExecutor } from './tool-executor.js';

// ─── Agent Runner ────────────────────────────────────────────

export class AgentRunner {
  constructor(
    private llm: LLMClient,
    private costTracker: CostTracker,
  ) {}

  /**
   * Run an agent for a specific task.
   *
   * For roles WITH tools (engineer, chief_of_staff, inspector):
   *   Runs an agentic loop — LLM calls tools, gets results, repeats.
   *
   * For roles WITHOUT tools (adjutant, operations):
   *   Single LLM call, returns the text response.
   */
  async runAgent(task: Task, role: AgentRole, input: string): Promise<string> {
    const soul = this.loadSoul(role);
    const config = getAgentConfig(role);
    const toolNames = getToolsForRole(role);
    const llmTools = getLLMToolsForRole(role);
    const context = this.buildContext(task, role);
    const systemPrompt = [soul, context].join('\n\n---\n\n');

    // Record run start
    const now = new Date().toISOString();
    const runId = recordAgentRun({
      task_id: task.id,
      agent_role: role,
      engineer_id: task.assigned_engineer_id,
      model: config.model,
      started_at: now,
      updated_at: now,
      finished_at: null,
      status: 'running',
      input_tokens: 0,
      output_tokens: 0,
      error: null,
    });

    logger.info(
      { taskId: task.id, role, model: config.model, tools: toolNames, runId },
      'Agent run started',
    );

    writeProgressLog({
      task_id: task.id,
      at: now,
      agent: role,
      text: `Agent ${role} started${toolNames.length > 0 ? ` (tools: ${toolNames.join(', ')})` : ''}`,
      todos: null,
    });

    // No tools → single call (adjutant, operations)
    if (llmTools.length === 0) {
      return this.singleCall(task, role, runId, systemPrompt, config, input);
    }

    // Has tools → agentic loop (engineer, chief_of_staff, inspector)
    return this.agenticLoop(task, role, runId, systemPrompt, config, llmTools, input);
  }

  // ─── Single Call (no tools) ─────────────────────────────────

  private async singleCall(
    task: Task,
    role: AgentRole,
    runId: number,
    systemPrompt: string,
    config: { model: string; temperature: number; max_tokens: number },
    input: string,
  ): Promise<string> {
    const request: LLMRequest = {
      model: config.model,
      system: systemPrompt,
      messages: [{ role: 'user', content: input }],
      temperature: config.temperature,
      max_tokens: config.max_tokens,
    };

    try {
      const response = await this.costTracker.trackCall(
        task.id, role, () => this.llm.call(request),
      );

      this.recordSuccess(task, role, runId, response);
      return response.content;
    } catch (err) {
      this.recordError(task, role, runId, err);
      throw err;
    }
  }

  // ─── Agentic Loop (with tools) ─────────────────────────────

  private async agenticLoop(
    task: Task,
    role: AgentRole,
    runId: number,
    systemPrompt: string,
    config: { model: string; temperature: number; max_tokens: number },
    llmTools: import('../types.js').LLMTool[],
    input: string,
  ): Promise<string> {
    // Set up working directory for tool execution
    const workDir = task.artifacts_path || path.join(TASKS_DIR, task.id);
    const executor = new ToolExecutor(workDir);

    // Conversation history for the loop
    const messages: LLMMessage[] = [
      { role: 'user', content: input },
    ];

    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let finalContent = '';

    try {
      for (let turn = 0; turn < MAX_AGENT_TURNS; turn++) {
        const request: LLMRequest = {
          model: config.model,
          system: systemPrompt,
          messages,
          tools: llmTools,
          temperature: config.temperature,
          max_tokens: config.max_tokens,
        };

        // Call LLM
        const response = await this.costTracker.trackCall(
          task.id, role, () => this.llm.call(request),
        );

        totalInputTokens += response.input_tokens;
        totalOutputTokens += response.output_tokens;

        // Always capture content (LLM may return text alongside tool_use)
        finalContent = response.content || finalContent;

        // Keep medic happy — update agent_run timestamp
        updateAgentRun(runId, { updated_at: new Date().toISOString() });

        // No tool calls → agent is done
        if (response.stop_reason !== 'tool_use' || !response.tool_use || response.tool_use.length === 0) {
          writeProgressLog({
            task_id: task.id,
            at: new Date().toISOString(),
            agent: role,
            text: `Agent ${role} finished after ${turn + 1} turn(s)`,
            todos: null,
          });

          // Record success and return directly from the loop
          const finishedAt = new Date().toISOString();
          updateAgentRun(runId, {
            status: 'success',
            finished_at: finishedAt,
            input_tokens: totalInputTokens,
            output_tokens: totalOutputTokens,
            error: null,
          });

          logger.info(
            { taskId: task.id, role, runId, inputTokens: totalInputTokens, outputTokens: totalOutputTokens },
            'Agent run completed (agentic)',
          );

          writeProgressLog({
            task_id: task.id,
            at: finishedAt,
            agent: role,
            text: `Agent ${role} completed (${totalInputTokens}+${totalOutputTokens} tokens total)`,
            todos: null,
          });

          return finalContent;
        }

        // Tool calls requested — execute them
        const toolResults: ContentBlock[] = [];

        for (const toolUse of response.tool_use) {
          logger.info(
            { taskId: task.id, role, tool: toolUse.name, turn },
            'Executing tool',
          );

          const result = executor.execute(toolUse);
          toolResults.push(result);

          writeProgressLog({
            task_id: task.id,
            at: new Date().toISOString(),
            agent: role,
            text: `Tool ${toolUse.name}${result.is_error ? ' (error)' : ''}: ${result.content.slice(0, 100)}`,
            todos: null,
          });
        }

        // Build assistant message with the tool_use blocks
        const assistantContent: ContentBlock[] = [];
        if (response.content) {
          assistantContent.push({ type: 'text', text: response.content } as TextBlock);
        }
        for (const tu of response.tool_use) {
          assistantContent.push(tu);
        }
        messages.push({ role: 'assistant', content: assistantContent });

        // Build user message with tool results
        messages.push({ role: 'user', content: toolResults });
      }

      // Only reached when MAX_AGENT_TURNS exhausted → error
      this.recordError(task, role, runId, new Error('max_turns_exhausted'));
      throw new Error(`Agent ${role} exhausted ${MAX_AGENT_TURNS} turns`);

    } catch (err) {
      // Avoid double-recording if we already recorded the max_turns error above
      if (!(err instanceof Error && err.message.includes('exhausted'))) {
        this.recordError(task, role, runId, err);
      }
      throw err;
    }
  }

  // ─── Recording Helpers ──────────────────────────────────────

  private recordSuccess(task: Task, role: AgentRole, runId: number, response: LLMResponse): void {
    const finishedAt = new Date().toISOString();
    updateAgentRun(runId, {
      status: 'success',
      finished_at: finishedAt,
      input_tokens: response.input_tokens,
      output_tokens: response.output_tokens,
      error: null,
    });

    logger.info(
      { taskId: task.id, role, runId, inputTokens: response.input_tokens, outputTokens: response.output_tokens },
      'Agent run completed',
    );

    writeProgressLog({
      task_id: task.id,
      at: finishedAt,
      agent: role,
      text: `Agent ${role} completed (${response.input_tokens}+${response.output_tokens} tokens)`,
      todos: null,
    });
  }

  private recordError(task: Task, role: AgentRole, runId: number, err: unknown): void {
    const errorMsg = err instanceof Error ? err.message : String(err);
    const finishedAt = new Date().toISOString();

    updateAgentRun(runId, {
      status: 'error',
      finished_at: finishedAt,
      error: errorMsg,
    });

    logger.error(
      { taskId: task.id, role, runId, error: errorMsg },
      'Agent run failed',
    );

    writeProgressLog({
      task_id: task.id,
      at: finishedAt,
      agent: role,
      text: `Agent ${role} failed: ${errorMsg}`,
      todos: null,
    });
  }

  // ─── Soul + Context ────────────────────────────────────────

  loadSoul(role: AgentRole): string {
    const soulPath = path.join(SOULS_DIR, `${role}.md`);
    try {
      return fs.readFileSync(soulPath, 'utf-8');
    } catch {
      logger.warn({ role, path: soulPath }, 'SOUL file not found, using empty prompt');
      return `You are the ${role} agent. Respond with valid JSON.`;
    }
  }

  buildContext(task: Task, role: AgentRole): string {
    const sections: string[] = [];

    sections.push([
      '## Current Task',
      `- **ID**: ${task.id}`,
      `- **State**: ${task.state}`,
      `- **Priority**: ${task.priority}`,
      `- **Description**: ${task.description}`,
      task.parent_id ? `- **Parent Task**: ${task.parent_id}` : '',
      task.campaign_id ? `- **Campaign**: ${task.campaign_id}` : '',
      task.intent_type ? `- **Intent**: ${task.intent_type}` : '',
      task.assigned_engineer_id ? `- **Engineer**: ${task.assigned_engineer_id}` : '',
    ].filter(Boolean).join('\n'));

    if (task.rubric) {
      try {
        const rubricItems = JSON.parse(task.rubric) as string[];
        sections.push([
          '## Frozen Rubric',
          ...rubricItems.map((r, i) => `${i + 1}. ${r}`),
        ].join('\n'));
      } catch {
        // Invalid rubric JSON
      }
    }

    if (task.reject_count_tactical > 0 || task.reject_count_strategic > 0) {
      sections.push([
        '## Reject History',
        `- Tactical rejects: ${task.reject_count_tactical}`,
        `- Strategic rejects: ${task.reject_count_strategic}`,
      ].join('\n'));
    }

    try {
      const flowLog = getFlowLog(task.id);
      if (flowLog.length > 0) {
        const recent = flowLog.slice(-10);
        sections.push([
          '## Recent Flow Log',
          ...recent.map((f: FlowLog) =>
            `- ${f.at}: ${f.from_state ?? 'null'} → ${f.to_state}${f.reason ? ` (${f.reason})` : ''}`,
          ),
        ].join('\n'));
      }
    } catch {
      // DB not available
    }

    if (task.artifacts_path) {
      sections.push(`## Working Directory\nPath: ${task.artifacts_path}`);
    } else {
      const defaultPath = path.join(TASKS_DIR, task.id);
      sections.push(`## Working Directory\nPath: ${defaultPath}`);
    }

    if (task.context_chain) {
      try {
        const chain = JSON.parse(task.context_chain) as { role: string; output: string }[];
        if (chain.length > 0) {
          sections.push([
            '## Upstream Agent Outputs',
            ...chain.map((entry) =>
              `### ${entry.role}\n${entry.output.slice(0, 2000)}`,
            ),
          ].join('\n\n'));
        }
      } catch {
        // Invalid context_chain JSON
      }
    }

    const toolNames = getToolsForRole(role);
    if (toolNames.length > 0) {
      sections.push([
        '## Available Tools',
        'You can use these tools iteratively. Read files, make changes, run tests, fix issues — repeat until done.',
        ...toolNames.map((t) => `- ${t}`),
      ].join('\n'));
    }

    return sections.join('\n\n');
  }
}
