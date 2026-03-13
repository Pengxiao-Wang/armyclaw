// ═══════════════════════════════════════════════════════════
// ArmyClaw — Exec Tool Provider
// Minimal shell execution: code_execute + test_run.
// No file operations, no path safety model.
// ═══════════════════════════════════════════════════════════

import { exec } from 'child_process';
import { promisify } from 'util';

import { TOOL_EXEC_TIMEOUT_MS } from '../config.js';
import type { LLMTool, ToolUseBlock, ToolResultBlock } from '../types.js';
import type { ToolProvider, ToolContext } from './armory.js';

// ─── Safe Environment ────────────────────────────────────

const SAFE_KEYS = ['PATH', 'HOME', 'USER', 'SHELL', 'LANG', 'TERM', 'NODE_ENV', 'TMPDIR'];

export function getSafeEnv(includeApiKeys = false): Record<string, string> {
  const env: Record<string, string> = { NODE_ENV: 'production' };
  for (const key of SAFE_KEYS) {
    if (process.env[key]) env[key] = process.env[key]!;
  }
  if (includeApiKeys && process.env.ANTHROPIC_API_KEY) {
    env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  }
  return env;
}

// ─── Tool Definitions ────────────────────────────────────

const EXEC_TOOLS: LLMTool[] = [
  {
    name: 'code_execute',
    description: 'Execute a shell command in the working directory.',
    input_schema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Shell command to execute' },
        timeout_ms: { type: 'number', description: 'Timeout in ms (max 30000). Optional.' },
      },
      required: ['command'],
    },
  },
  {
    name: 'test_run',
    description: 'Run tests. Defaults to "npm test" if no command specified.',
    input_schema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Test command. Defaults to "npm test".' },
      },
      required: [],
    },
  },
];

// ─── Provider ────────────────────────────────────────────

export class ExecProvider implements ToolProvider {
  readonly name = 'exec';

  listTools(): LLMTool[] {
    return EXEC_TOOLS;
  }

  async execute(block: ToolUseBlock, context: ToolContext): Promise<ToolResultBlock> {
    const cmd =
      block.name === 'test_run'
        ? ((block.input as { command?: string }).command ?? 'npm test')
        : (block.input as { command: string }).command;

    const timeout =
      block.name === 'code_execute'
        ? Math.min((block.input as { timeout_ms?: number }).timeout_ms ?? TOOL_EXEC_TIMEOUT_MS, TOOL_EXEC_TIMEOUT_MS)
        : TOOL_EXEC_TIMEOUT_MS;

    const execAsync = promisify(exec);

    try {
      const { stdout, stderr } = await execAsync(cmd, {
        encoding: 'utf-8',
        timeout,
        cwd: context.workDir,
        maxBuffer: 1024 * 1024,
        env: getSafeEnv(false),
      });

      const output = (stdout ?? '').trim();
      const maxLen = 10_000;
      const content =
        output.length > maxLen
          ? output.slice(0, maxLen) + `\n... (truncated, ${output.length} chars total)`
          : output || '(no output)';

      return { type: 'tool_result', tool_use_id: block.id, content, is_error: false };
    } catch (err: unknown) {
      const execErr = err as { stdout?: string; stderr?: string; message?: string };
      const combined = [execErr.stdout?.trim(), execErr.stderr?.trim()].filter(Boolean).join('\n');
      return {
        type: 'tool_result',
        tool_use_id: block.id,
        content: combined || execErr.message || 'Command failed',
        is_error: true,
      };
    }
  }

  isAvailable(): boolean {
    return true;
  }
}
