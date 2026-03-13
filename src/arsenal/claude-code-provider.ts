// ═══════════════════════════════════════════════════════════
// ArmyClaw — Claude Code Tool Provider
// Delegates coding tasks to Claude Code CLI.
// cwd is fixed to workDir so Claude Code sees the project.
// ═══════════════════════════════════════════════════════════

import { execFileSync } from 'child_process';

import { CLAUDE_CODE_TIMEOUT_MS } from '../config.js';
import type { LLMTool, ToolUseBlock, ToolResultBlock } from '../types.js';
import type { ToolProvider, ToolContext } from './armory.js';
import { getSafeEnv } from './exec-provider.js';

// ─── Tool Definition ───────────────────────────────────────

const CLAUDE_CODE_TOOL: LLMTool = {
  name: 'claude_code',
  description: 'Delegate a coding task to Claude Code (an AI coding agent). Use this as your PRIMARY tool for all code work: implementing features, fixing bugs, refactoring, writing tests, debugging. Claude Code has its own tools (Read, Write, Edit, Bash, Grep, Glob) and works autonomously in the project directory. Give it clear, specific instructions.',
  input_schema: {
    type: 'object',
    properties: {
      prompt: {
        type: 'string',
        description: 'Detailed instructions for Claude Code. Include: what to do, which files to touch, expected behavior, and any constraints.',
      },
    },
    required: ['prompt'],
  },
};

// ─── Provider ──────────────────────────────────────────────

export class ClaudeCodeProvider implements ToolProvider {
  readonly name = 'claude_code';

  listTools(): LLMTool[] {
    return [CLAUDE_CODE_TOOL];
  }

  async execute(block: ToolUseBlock, context: ToolContext): Promise<ToolResultBlock> {
    const input = block.input as { prompt: string };

    try {
      const output = execFileSync('claude', ['-p', '--verbose'], {
        input: input.prompt,
        encoding: 'utf-8',
        timeout: CLAUDE_CODE_TIMEOUT_MS,
        cwd: context.workDir,
        maxBuffer: 5 * 1024 * 1024, // 5MB
        env: getSafeEnv(true),
      }).trim();

      const maxLen = 50_000;
      if (output.length > maxLen) {
        return {
          type: 'tool_result',
          tool_use_id: block.id,
          content: output.slice(0, maxLen) + `\n... (truncated, ${output.length} chars total)`,
          is_error: false,
        };
      }

      return {
        type: 'tool_result',
        tool_use_id: block.id,
        content: output || '(no output)',
        is_error: false,
      };
    } catch (err: unknown) {
      const execErr = err as { status?: number; stdout?: string; stderr?: string; message?: string };
      const stderr = execErr.stderr?.trim() ?? '';
      const stdout = execErr.stdout?.trim() ?? '';
      const combined = [stdout, stderr].filter(Boolean).join('\n');

      return {
        type: 'tool_result',
        tool_use_id: block.id,
        content: combined || execErr.message || 'Claude Code execution failed',
        is_error: true,
      };
    }
  }

  isAvailable(): boolean {
    return true;
  }
}
