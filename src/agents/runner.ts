// ═══════════════════════════════════════════════════════════
// ArmyClaw — Agent Execution Engine
//
// Three execution paths:
// 1. Non-tool agents (adjutant, operations): single LLM call
// 2. Tool agents (chief_of_staff, inspector, simple engineer):
//    agentic loop — LLM → tools → repeat
// 3. Claude Code engineers (moderate/complex):
//    direct spawn — Claude Code IS the engineer
// ═══════════════════════════════════════════════════════════

import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';

import { SOULS_DIR, PROJECT_DIR, MAX_AGENT_TURNS, MAX_CONCURRENT_ENGINEERS, MAX_SUBTASKS_HARD_CAP, SUBTASK_SLOT_RESERVE, CLAUDE_CODE_TIMEOUT_MS } from '../config.js';
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
import { Armory } from '../arsenal/armory.js';
import type { ToolContext } from '../arsenal/armory.js';
import { CostTracker } from '../depot/cost-tracker.js';
import { getResponseTool } from './schemas.js';
import { getSafeEnv } from '../arsenal/exec-provider.js';

// ─── Agent Runner ────────────────────────────────────────────

export class AgentRunner {
  constructor(
    private llm: LLMClient,
    private costTracker: CostTracker,
    private armory: Armory,
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
    const toolNames = this.armory.getToolNamesForRole(role);
    const llmTools = this.armory.getToolsForRole(role);
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

    // Engineer with moderate/complex → Claude Code direct (no agentic loop wrapper)
    if (role === 'engineer' && task.complexity && task.complexity !== 'simple') {
      return this.claudeCodeDirect(task, runId, input);
    }

    // Has tools → agentic loop (chief_of_staff, inspector, simple engineer)
    return this.agenticLoop(task, role, runId, systemPrompt, config, llmTools, input);
  }

  // ─── Single Call (structured output via tool_use) ──────────────

  private async singleCall(
    task: Task,
    role: AgentRole,
    runId: number,
    systemPrompt: string,
    config: { model: string; temperature: number; max_tokens: number },
    input: string,
  ): Promise<string> {
    const responseTool = getResponseTool(role);

    const request: LLMRequest = {
      model: config.model,
      system: systemPrompt,
      messages: [{ role: 'user', content: input }],
      temperature: config.temperature,
      max_tokens: config.max_tokens,
    };

    // Force structured output via tool_use when a response tool is defined
    if (responseTool) {
      request.tools = [responseTool];
      request.tool_choice = { type: 'tool', name: responseTool.name };
    }

    try {
      const response = await this.costTracker.trackCall(
        task.id, role, () => this.llm.call(request),
      );

      // Extract structured output from tool_use block
      if (responseTool && response.tool_use?.length) {
        this.recordSuccess(task, role, runId, response);
        return JSON.stringify(response.tool_use[0].input);
      }

      // Fallback: raw text (no response tool or tool_use not returned)
      if (response.stop_reason === 'max_tokens') {
        throw new Error(
          `Agent ${role} output truncated (hit max_tokens ${config.max_tokens}).`,
        );
      }

      this.recordSuccess(task, role, runId, response);
      return response.content;
    } catch (err) {
      this.recordError(task, role, runId, err);
      throw err;
    }
  }

  // ─── Claude Code Direct (engineer: moderate/complex) ──────

  private async claudeCodeDirect(
    task: Task,
    runId: number,
    input: string,
  ): Promise<string> {
    const workDir = task.artifacts_path || PROJECT_DIR;

    writeProgressLog({
      task_id: task.id,
      at: new Date().toISOString(),
      agent: 'engineer',
      text: `Claude Code direct: spawning for ${task.complexity} task`,
      todos: null,
    });

    try {
      const result = await this.spawnClaude(input, workDir);

      const output = result.stdout.trim();
      const maxLen = 50_000;
      const truncated = output.length > maxLen
        ? output.slice(0, maxLen) + `\n... (truncated, ${output.length} chars total)`
        : output;

      const engineerResult = JSON.stringify({
        subtask_id: task.id,
        status: result.code === 0 ? 'completed' : 'failed',
        result: truncated || '(no output)',
        files_changed: [],
      });

      // Record success
      const finishedAt = new Date().toISOString();
      updateAgentRun(runId, {
        status: result.code === 0 ? 'success' : 'error',
        finished_at: finishedAt,
        input_tokens: 0, // Claude Code manages its own token usage
        output_tokens: 0,
        error: result.code !== 0 ? `exit code ${result.code}` : null,
      });

      writeProgressLog({
        task_id: task.id,
        at: finishedAt,
        agent: 'engineer',
        text: `Claude Code direct: ${result.code === 0 ? 'completed' : 'failed (exit ' + result.code + ')'}`,
        todos: null,
      });

      logger.info(
        { taskId: task.id, runId, exitCode: result.code },
        'Claude Code direct completed',
      );

      return engineerResult;
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      const finishedAt = new Date().toISOString();

      updateAgentRun(runId, {
        status: 'error',
        finished_at: finishedAt,
        error: errorMsg,
      });

      writeProgressLog({
        task_id: task.id,
        at: finishedAt,
        agent: 'engineer',
        text: `Claude Code direct failed: ${errorMsg}`,
        todos: null,
      });

      return JSON.stringify({
        subtask_id: task.id,
        status: 'failed',
        result: errorMsg,
      });
    }
  }

  private spawnClaude(prompt: string, cwd: string): Promise<{ stdout: string; stderr: string; code: number | null }> {
    return new Promise((resolve, reject) => {
      const child = spawn('claude', ['-p', '--verbose'], {
        cwd,
        env: getSafeEnv(true),
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      const chunks: Buffer[] = [];
      const errChunks: Buffer[] = [];
      let settled = false;

      child.stdout.on('data', (data: Buffer) => chunks.push(data));
      child.stderr.on('data', (data: Buffer) => errChunks.push(data));

      child.on('close', (code) => {
        if (settled) return;
        settled = true;
        resolve({
          stdout: Buffer.concat(chunks).toString('utf-8'),
          stderr: Buffer.concat(errChunks).toString('utf-8'),
          code,
        });
      });

      child.on('error', (err) => {
        if (settled) return;
        settled = true;
        reject(err);
      });

      child.stdin.write(prompt);
      child.stdin.end();

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill('SIGTERM');
        setTimeout(() => child.kill('SIGKILL'), 5_000);
        reject(new Error(`Claude Code timed out after ${CLAUDE_CODE_TIMEOUT_MS}ms`));
      }, CLAUDE_CODE_TIMEOUT_MS);

      child.on('close', () => clearTimeout(timer));
    });
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
    // Build tool execution context — use project root when no artifacts_path
    const workDir = task.artifacts_path || PROJECT_DIR;
    const toolContext: ToolContext = {
      taskId: task.id,
      workDir,
      role,
    };

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

          const result = await this.armory.execute(toolUse, toolContext);
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

    const ctxWorkDir = task.artifacts_path || PROJECT_DIR;
    sections.push(`## Working Directory\nPath: ${ctxWorkDir}`);

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

    // Tell Operations the exact subtask limit so it plans accordingly
    if (role === 'operations') {
      const maxSubs = Math.min(MAX_CONCURRENT_ENGINEERS, MAX_SUBTASKS_HARD_CAP) - SUBTASK_SLOT_RESERVE;
      sections.push([
        '## Resource Constraint',
        `You have **${maxSubs} engineer slots** available. You MUST create at most ${maxSubs} assignments.`,
        'If the work requires more subtasks than slots, merge related work into fewer, broader assignments.',
        'Do NOT create more assignments than the limit — excess ones will be dropped.',
      ].join('\n'));
    }

    const ctxToolNames = this.armory.getToolNamesForRole(role);
    if (ctxToolNames.length > 0) {
      sections.push([
        '## Available Tools',
        'You can use these tools iteratively. Read files, make changes, run tests, fix issues — repeat until done.',
        ...ctxToolNames.map((t) => `- ${t}`),
      ].join('\n'));
    }

    return sections.join('\n\n');
  }
}
