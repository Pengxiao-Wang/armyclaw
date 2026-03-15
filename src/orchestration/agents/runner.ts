// ═══════════════════════════════════════════════════════════
// ArmyClaw — Agent Execution Engine (V2)
//
// Unix CLI Philosophy:
//   Engineers → spawn Claude Code (it IS the engineer)
//   Staff/Inspector → single `run()` tool (read-only shell)
//   Adjutant/Operations → no tools (pure LLM structured output)
//
// Three execution paths, zero tool explosion.
// ═══════════════════════════════════════════════════════════

import fs from 'fs';
import path from 'path';

import { SOULS_DIR, PROJECT_DIR, MAX_AGENT_TURNS, MAX_CONCURRENT_ENGINEERS, MAX_SUBTASKS_HARD_CAP, SUBTASK_SLOT_RESERVE, CLAUDE_CODE_TIMEOUT_DEFAULT_MS, CLAUDE_CODE_TIMEOUT_MIN_MS } from '../../config.js';
import {
  getAgentConfig,
  recordAgentRun,
  updateAgentRun,
  writeProgressLog,
  getFlowLog,
} from '../../kernel/db.js';
import { logger } from '../../logger.js';
import { runClaudeCode, runShellReadOnly } from '../../kernel/process-runner.js';
import type {
  AgentRole,
  Task,
  FlowLog,
  LLMRequest,
  LLMResponse,
  LLMMessage,
  LLMTool,
  ContentBlock,
  TextBlock,
  ToolUseBlock,
  ToolResultBlock,
} from '../../types.js';
import { LLMClient } from '../arsenal.js';
import { CostTracker } from '../depot.js';
import { LeakDetector } from '../../kernel/safety/leak-detector.js';
import { Archivist } from '../archivist.js';
import { getResponseTool } from './schemas.js';
import { getLoadedModules, hasModule } from '../../kernel/wasm/runtime.js';
import { sandboxedExecute } from '../../kernel/wasm/sandbox.js';

// ─── The ONE Tool: Unix CLI Single Entry ──────────────────

const RUN_TOOL: LLMTool = {
  name: 'run',
  description: 'Execute a read-only shell command. Use Unix commands to explore the codebase: cat, grep, find, ls, git log, etc. Pipe commands together for powerful composition. You cannot modify files — this is read-only.',
  input_schema: {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        description: 'Shell command to execute. Supports pipes, redirects, and all Unix utilities. Examples: "cat src/index.ts", "grep -r TODO src/", "git log --oneline -20", "find . -name \'*.test.ts\' | head"',
      },
    },
    required: ['command'],
  },
};

const WASM_TOOL: LLMTool = {
  name: 'wasm',
  description: 'Execute a registered WASM tool plugin in a secure sandbox. Use this for specialized analysis tools (code complexity, security scanning, etc). List available tools with wasm("list", "").',
  input_schema: {
    type: 'object',
    properties: {
      tool_name: {
        type: 'string',
        description: 'Name of the WASM tool to execute, or "list" to see available tools',
      },
      input: {
        type: 'string',
        description: 'Input data for the tool (JSON string or plain text)',
      },
    },
    required: ['tool_name', 'input'],
  },
};

// ─── Agent Runner ────────────────────────────────────────────

export class AgentRunner {
  private leakDetector = new LeakDetector();
  private archivist = new Archivist();

  constructor(
    private llm: LLMClient,
    private costTracker: CostTracker,
  ) {}

  async runAgent(task: Task, role: AgentRole, input: string): Promise<string> {
    const soul = this.loadSoul(role);
    const config = getAgentConfig(role);
    const context = this.buildContext(task, role);
    let systemPrompt = [soul, context].join('\n\n---\n\n');

    // Archivist: recall relevant history for planning/review agents
    if (role === 'chief_of_staff' || role === 'inspector') {
      try {
        const history = await this.archivist.recall(task.description, role);
        if (history) {
          systemPrompt = [soul, context, history].join('\n\n---\n\n');
        }
      } catch { /* non-fatal */ }
    }

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

    const hasTools = role === 'chief_of_staff' || role === 'inspector';

    logger.info(
      { taskId: task.id, role, model: config.model, tools: hasTools ? ['run'] : [], runId },
      'Agent run started',
    );

    writeProgressLog({
      task_id: task.id, at: now, agent: role,
      text: `Agent ${role} started${hasTools ? ' (tool: run)' : ''}`,
      todos: null,
    });

    // Path 1: Engineer → Claude Code direct (the engineer IS Claude Code)
    if (role === 'engineer') {
      return this.claudeCodeDirect(task, runId, input);
    }

    // Path 2: Adjutant/Operations → single LLM call, structured output
    if (!hasTools) {
      return this.singleCall(task, role, runId, systemPrompt, config, input);
    }

    // Path 3: Chief of Staff / Inspector → agentic loop with `run` tool
    return this.agenticLoop(task, role, runId, systemPrompt, config, input);
  }

  // ─── Path 1: Claude Code Direct ────────────────────────────

  private async claudeCodeDirect(
    task: Task,
    runId: number,
    input: string,
  ): Promise<string> {
    const workDir = task.artifacts_path || PROJECT_DIR;

    writeProgressLog({
      task_id: task.id, at: new Date().toISOString(), agent: 'engineer',
      text: `Claude Code direct: spawning for ${task.complexity ?? 'standard'} task`,
      todos: null,
    });

    try {
      // Use task-level timeout from chief of staff, with engineer minimum guarantee
      const taskTimeoutMs = task.timeout_sec ? task.timeout_sec * 1000 : CLAUDE_CODE_TIMEOUT_DEFAULT_MS;
      const timeoutMs = Math.max(taskTimeoutMs, CLAUDE_CODE_TIMEOUT_MIN_MS);
      const result = await runClaudeCode(input, workDir, timeoutMs);

      const output = result.stdout.trim();
      const maxLen = 50_000;
      const truncated = output.length > maxLen
        ? output.slice(0, maxLen) + `\n... (truncated, ${output.length} chars total)`
        : output;

      // Leak detection on engineer output
      const sanitized = this.leakDetector.sanitize(truncated, `engineer output for ${task.id}`);

      const engineerResult = JSON.stringify({
        subtask_id: task.id,
        status: result.code === 0 ? 'completed' : 'failed',
        result: sanitized || '(no output)',
        files_changed: [],
      });

      const finishedAt = new Date().toISOString();
      updateAgentRun(runId, {
        status: result.code === 0 ? 'success' : 'error',
        finished_at: finishedAt,
        input_tokens: 0,
        output_tokens: 0,
        error: result.code !== 0 ? `exit code ${result.code}` : null,
      });

      writeProgressLog({
        task_id: task.id, at: finishedAt, agent: 'engineer',
        text: `Claude Code: ${result.code === 0 ? 'completed' : 'failed (exit ' + result.code + ')'}`,
        todos: null,
      });

      logger.info({ taskId: task.id, runId, exitCode: result.code }, 'Claude Code completed');
      return engineerResult;
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      const finishedAt = new Date().toISOString();
      updateAgentRun(runId, { status: 'error', finished_at: finishedAt, error: errorMsg });
      writeProgressLog({
        task_id: task.id, at: finishedAt, agent: 'engineer',
        text: `Claude Code failed: ${errorMsg}`, todos: null,
      });
      return JSON.stringify({ subtask_id: task.id, status: 'failed', result: errorMsg });
    }
  }

  // ─── Path 2: Single Call (structured output via tool_use) ──

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

    if (responseTool) {
      request.tools = [responseTool];
      request.tool_choice = { type: 'tool', name: responseTool.name };
    }

    try {
      const response = await this.costTracker.trackCall(
        task.id, role, () => this.llm.call(request),
      );

      if (responseTool && response.tool_use?.length) {
        this.recordSuccess(task, role, runId, response);
        return JSON.stringify(response.tool_use[0].input);
      }

      if (response.stop_reason === 'max_tokens') {
        throw new Error(`Agent ${role} output truncated (hit max_tokens ${config.max_tokens})`);
      }

      this.recordSuccess(task, role, runId, response);
      return response.content;
    } catch (err) {
      this.recordError(task, role, runId, err);
      throw err;
    }
  }

  // ─── Path 3: Agentic Loop (single `run` tool) ─────────────

  private async agenticLoop(
    task: Task,
    role: AgentRole,
    runId: number,
    systemPrompt: string,
    config: { model: string; temperature: number; max_tokens: number },
    input: string,
  ): Promise<string> {
    const workDir = task.artifacts_path || PROJECT_DIR;
    const messages: LLMMessage[] = [{ role: 'user', content: input }];

    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let finalContent = '';

    try {
      for (let turn = 0; turn < MAX_AGENT_TURNS; turn++) {
        const request: LLMRequest = {
          model: config.model,
          system: systemPrompt,
          messages,
          tools: [RUN_TOOL, ...(getLoadedModules().length > 0 ? [WASM_TOOL] : [])],
          temperature: config.temperature,
          max_tokens: config.max_tokens,
        };

        const response = await this.costTracker.trackCall(
          task.id, role, () => this.llm.call(request),
        );

        totalInputTokens += response.input_tokens;
        totalOutputTokens += response.output_tokens;
        finalContent = response.content || finalContent;

        updateAgentRun(runId, { updated_at: new Date().toISOString() });

        // No tool calls → done
        if (response.stop_reason !== 'tool_use' || !response.tool_use?.length) {
          writeProgressLog({
            task_id: task.id, at: new Date().toISOString(), agent: role,
            text: `Agent ${role} finished after ${turn + 1} turn(s)`, todos: null,
          });

          const finishedAt = new Date().toISOString();
          updateAgentRun(runId, {
            status: 'success', finished_at: finishedAt,
            input_tokens: totalInputTokens, output_tokens: totalOutputTokens, error: null,
          });

          logger.info({ taskId: task.id, role, runId, inputTokens: totalInputTokens, outputTokens: totalOutputTokens }, 'Agent completed (agentic)');
          return finalContent;
        }

        // Execute tool calls — run() or wasm()
        const toolResults: ContentBlock[] = [];

        for (const toolUse of response.tool_use) {
          let toolOutput: string;
          let toolError = false;

          if (toolUse.name === 'wasm') {
            const toolName = (toolUse.input as { tool_name?: string }).tool_name ?? '';
            const toolInput = (toolUse.input as { input?: string }).input ?? '';

            if (toolName === 'list') {
              const modules = getLoadedModules();
              toolOutput = modules.length > 0
                ? modules.map(m => `- ${m.name}: ${m.description}`).join('\n')
                : '(no WASM tools registered)';
            } else if (hasModule(toolName)) {
              const wasmResult = await sandboxedExecute(
                getLoadedModules().find(m => m.name === toolName)!,
                toolInput,
              );
              toolOutput = wasmResult.error ? `Error: ${wasmResult.error}\n${wasmResult.output}` : wasmResult.output;
              toolError = !!wasmResult.error;
            } else {
              toolOutput = `WASM tool "${toolName}" not found. Use wasm("list", "") to see available tools.`;
              toolError = true;
            }

            logger.info({ taskId: task.id, role, wasmTool: toolName, turn }, 'Executing wasm()');

            writeProgressLog({
              task_id: task.id, at: new Date().toISOString(), agent: role,
              text: `wasm: ${toolName}${toolError ? ' (error)' : ''}`,
              todos: null,
            });
          } else {
            // Default: run() shell command
            const command = (toolUse.input as { command?: string }).command ?? '';
            logger.info({ taskId: task.id, role, command: command.slice(0, 100), turn }, 'Executing run()');

            const result = await runShellReadOnly(command, workDir);
            toolOutput = result.timedOut
              ? `Command timed out after 30s\n${result.stdout}`
              : result.code !== 0
                ? `Exit code ${result.code}\n${result.stderr}\n${result.stdout}`
                : result.stdout;
            toolError = result.code !== 0;

            // Sanitize tool output
            toolOutput = this.leakDetector.sanitize(toolOutput, `run() output for ${task.id}`);

            writeProgressLog({
              task_id: task.id, at: new Date().toISOString(), agent: role,
              text: `run: ${command.slice(0, 80)}${toolError ? ' (error)' : ''}`,
              todos: null,
            });
          }

          const toolResult: ToolResultBlock = {
            type: 'tool_result',
            tool_use_id: toolUse.id,
            content: toolOutput.slice(0, 50_000),
            is_error: toolError,
          };
          toolResults.push(toolResult);
        }

        // Build conversation history
        const assistantContent: ContentBlock[] = [];
        if (response.content) {
          assistantContent.push({ type: 'text', text: response.content } as TextBlock);
        }
        for (const tu of response.tool_use) {
          assistantContent.push(tu);
        }
        messages.push({ role: 'assistant', content: assistantContent });
        messages.push({ role: 'user', content: toolResults });
      }

      this.recordError(task, role, runId, new Error('max_turns_exhausted'));
      throw new Error(`Agent ${role} exhausted ${MAX_AGENT_TURNS} turns`);
    } catch (err) {
      if (!(err instanceof Error && err.message.includes('exhausted'))) {
        this.recordError(task, role, runId, err);
      }
      throw err;
    }
  }

  // ─── Helpers ────────────────────────────────────────────────

  private recordSuccess(task: Task, role: AgentRole, runId: number, response: LLMResponse): void {
    const finishedAt = new Date().toISOString();
    updateAgentRun(runId, {
      status: 'success', finished_at: finishedAt,
      input_tokens: response.input_tokens, output_tokens: response.output_tokens, error: null,
    });
    logger.info({ taskId: task.id, role, runId }, 'Agent run completed');
    writeProgressLog({
      task_id: task.id, at: finishedAt, agent: role,
      text: `Agent ${role} completed (${response.input_tokens}+${response.output_tokens} tokens)`,
      todos: null,
    });
  }

  private recordError(task: Task, role: AgentRole, runId: number, err: unknown): void {
    const errorMsg = err instanceof Error ? err.message : String(err);
    const finishedAt = new Date().toISOString();
    updateAgentRun(runId, { status: 'error', finished_at: finishedAt, error: errorMsg });
    logger.error({ taskId: task.id, role, runId, error: errorMsg }, 'Agent run failed');
    writeProgressLog({
      task_id: task.id, at: finishedAt, agent: role,
      text: `Agent ${role} failed: ${errorMsg}`, todos: null,
    });
  }

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
        sections.push(['## Frozen Rubric', ...rubricItems.map((r, i) => `${i + 1}. ${r}`)].join('\n'));
      } catch { /* skip */ }
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
          ...recent.map((f: FlowLog) => `- ${f.at}: ${f.from_state ?? 'null'} → ${f.to_state}${f.reason ? ` (${f.reason})` : ''}`),
        ].join('\n'));
      }
    } catch { /* DB not available */ }

    const ctxWorkDir = task.artifacts_path || PROJECT_DIR;
    sections.push(`## Working Directory\nPath: ${ctxWorkDir}`);

    if (task.context_chain) {
      try {
        const chain = JSON.parse(task.context_chain) as { role: string; output: string }[];
        if (chain.length > 0) {
          sections.push([
            '## Upstream Agent Outputs',
            ...chain.map((entry) => `### ${entry.role}\n${entry.output.slice(0, 2000)}`),
          ].join('\n\n'));
        }
      } catch { /* skip */ }
    }

    if (role === 'operations') {
      const maxSubs = Math.min(MAX_CONCURRENT_ENGINEERS, MAX_SUBTASKS_HARD_CAP) - SUBTASK_SLOT_RESERVE;
      sections.push([
        '## Resource Constraint',
        `You have **${maxSubs} engineer slots** available. Create at most ${maxSubs} assignments.`,
      ].join('\n'));
    }

    // Unix CLI philosophy: staff/inspector get a `run` tool description + optional wasm
    if (role === 'chief_of_staff' || role === 'inspector') {
      const wasmModules = getLoadedModules();
      sections.push([
        '## Available Tools',
        '### `run(command)` — Read-only shell',
        'Execute Unix commands: `cat`, `grep`, `find`, `ls`, `git log`, etc.',
        'Compose with pipes: `grep -r "TODO" src/ | wc -l`',
        'Read-only — you cannot modify files.',
        ...(wasmModules.length > 0 ? [
          '',
          '### `wasm(tool_name, input)` — Sandboxed plugins',
          'Available WASM tools:',
          ...wasmModules.map(m => `- **${m.name}**: ${m.description}`),
        ] : []),
      ].join('\n'));
    }

    return sections.join('\n\n');
  }
}
