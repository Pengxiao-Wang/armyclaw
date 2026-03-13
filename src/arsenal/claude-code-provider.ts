// ═══════════════════════════════════════════════════════════
// ArmyClaw — Claude Code Tool Provider
// Delegates coding tasks to Claude Code CLI.
// cwd is fixed to workDir so Claude Code sees the project.
// Uses async spawn to avoid blocking the event loop.
// ═══════════════════════════════════════════════════════════

import { spawn } from 'child_process';

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

// ─── Async Claude Code execution ──────────────────────────

function runClaude(prompt: string, cwd: string): Promise<{ stdout: string; stderr: string; code: number | null }> {
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

    // Write prompt to stdin and close
    child.stdin.write(prompt);
    child.stdin.end();

    // Timeout guard
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

// ─── Provider ──────────────────────────────────────────────

export class ClaudeCodeProvider implements ToolProvider {
  readonly name = 'claude_code';

  listTools(): LLMTool[] {
    return [CLAUDE_CODE_TOOL];
  }

  async execute(block: ToolUseBlock, context: ToolContext): Promise<ToolResultBlock> {
    const input = block.input as { prompt: string };

    try {
      const result = await runClaude(input.prompt, context.workDir);

      if (result.code !== 0 && result.code !== null) {
        const combined = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join('\n');
        return {
          type: 'tool_result',
          tool_use_id: block.id,
          content: combined || `Claude Code exited with code ${result.code}`,
          is_error: true,
        };
      }

      const output = result.stdout.trim();
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
      const message = err instanceof Error ? err.message : String(err);
      return {
        type: 'tool_result',
        tool_use_id: block.id,
        content: message,
        is_error: true,
      };
    }
  }

  isAvailable(): boolean {
    return true;
  }
}
