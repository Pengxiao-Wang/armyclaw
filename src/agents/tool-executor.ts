// ═══════════════════════════════════════════════════════════
// ArmyClaw — Tool Executor
// Real tool implementations for agentic agents.
// All file operations are sandboxed to a working directory.
// ═══════════════════════════════════════════════════════════

import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import { TOOL_EXEC_TIMEOUT_MS } from '../config.js';
import { logger } from '../logger.js';
import type { ToolUseBlock, ToolResultBlock } from '../types.js';

// ─── Tool Result ────────────────────────────────────────────

export interface ToolExecResult {
  output: string;
  is_error: boolean;
}

// ─── Executor ───────────────────────────────────────────────

export class ToolExecutor {
  constructor(private workDir: string) {
    // Ensure working directory exists
    fs.mkdirSync(this.workDir, { recursive: true });
  }

  /**
   * Execute a tool_use block and return a tool_result block.
   */
  execute(block: ToolUseBlock): ToolResultBlock {
    let result: ToolExecResult;

    try {
      switch (block.name) {
        case 'file_read':
          result = this.fileRead(block.input as { path: string; offset?: number; limit?: number });
          break;
        case 'file_write':
          result = this.fileWrite(block.input as { path: string; content: string });
          break;
        case 'file_list':
          result = this.fileList(block.input as { path?: string });
          break;
        case 'search':
          result = this.search(block.input as { pattern: string; path?: string; glob?: string });
          break;
        case 'code_execute':
          result = this.codeExecute(block.input as { command: string; timeout_ms?: number });
          break;
        case 'test_run':
          result = this.testRun(block.input as { command?: string });
          break;
        default:
          result = { output: `Unknown tool: ${block.name}`, is_error: true };
      }
    } catch (err) {
      result = {
        output: `Tool execution error: ${err instanceof Error ? err.message : String(err)}`,
        is_error: true,
      };
    }

    return {
      type: 'tool_result',
      tool_use_id: block.id,
      content: result.output,
      is_error: result.is_error,
    };
  }

  // ─── Tool Implementations ──────────────────────────────────

  private fileRead(input: { path: string; offset?: number; limit?: number }): ToolExecResult {
    const fullPath = this.resolveSafe(input.path);
    if (!fs.existsSync(fullPath)) {
      return { output: `File not found: ${input.path}`, is_error: true };
    }

    const stat = fs.statSync(fullPath);
    if (stat.isDirectory()) {
      return { output: `Path is a directory, not a file: ${input.path}`, is_error: true };
    }

    const content = fs.readFileSync(fullPath, 'utf-8');
    const lines = content.split('\n');

    const offset = input.offset ?? 0;
    const limit = input.limit ?? lines.length;
    const slice = lines.slice(offset, offset + limit);

    // Number lines like cat -n
    const numbered = slice.map((line, i) => `${String(offset + i + 1).padStart(6)}  ${line}`);
    return { output: numbered.join('\n'), is_error: false };
  }

  private fileWrite(input: { path: string; content: string }): ToolExecResult {
    const fullPath = this.resolveSafe(input.path);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, input.content, 'utf-8');

    const lines = input.content.split('\n').length;
    return { output: `Written ${lines} lines to ${input.path}`, is_error: false };
  }

  private fileList(input: { path?: string }): ToolExecResult {
    const dir = this.resolveSafe(input.path ?? '.');
    if (!fs.existsSync(dir)) {
      return { output: `Directory not found: ${input.path ?? '.'}`, is_error: true };
    }

    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const lines = entries.map((e) => {
      const suffix = e.isDirectory() ? '/' : '';
      return `${e.name}${suffix}`;
    });
    return { output: lines.join('\n') || '(empty directory)', is_error: false };
  }

  private search(input: { pattern: string; path?: string; glob?: string }): ToolExecResult {
    const searchDir = this.resolveSafe(input.path ?? '.');
    if (!fs.existsSync(searchDir)) {
      return { output: `Search path not found: ${input.path ?? '.'}`, is_error: true };
    }

    // Use grep recursively
    const globArg = input.glob ? `--include="${input.glob}"` : '';
    const cmd = `grep -rn ${globArg} "${input.pattern}" "${searchDir}" 2>/dev/null | head -100`;

    try {
      const output = execSync(cmd, {
        encoding: 'utf-8',
        timeout: TOOL_EXEC_TIMEOUT_MS,
        cwd: this.workDir,
      }).trim();
      return { output: output || 'No matches found.', is_error: false };
    } catch {
      return { output: 'No matches found.', is_error: false };
    }
  }

  private codeExecute(input: { command: string; timeout_ms?: number }): ToolExecResult {
    const timeout = Math.min(input.timeout_ms ?? TOOL_EXEC_TIMEOUT_MS, TOOL_EXEC_TIMEOUT_MS);

    try {
      const output = execSync(input.command, {
        encoding: 'utf-8',
        timeout,
        cwd: this.workDir,
        maxBuffer: 1024 * 1024, // 1MB
        env: { ...process.env, NODE_ENV: 'production' },
      }).trim();

      // Truncate very long output
      const maxLen = 10_000;
      if (output.length > maxLen) {
        return {
          output: output.slice(0, maxLen) + `\n... (truncated, ${output.length} chars total)`,
          is_error: false,
        };
      }

      return { output: output || '(no output)', is_error: false };
    } catch (err: unknown) {
      const execErr = err as { status?: number; stdout?: string; stderr?: string; message?: string };
      const stderr = execErr.stderr?.trim() ?? '';
      const stdout = execErr.stdout?.trim() ?? '';
      const combined = [stdout, stderr].filter(Boolean).join('\n');
      return {
        output: combined || execErr.message || 'Command failed',
        is_error: true,
      };
    }
  }

  private testRun(input: { command?: string }): ToolExecResult {
    const cmd = input.command ?? 'npm test';
    return this.codeExecute({ command: cmd });
  }

  // ─── Path Safety ───────────────────────────────────────────

  /**
   * Resolve a path relative to the working directory.
   * Prevents directory traversal attacks (../../etc/passwd).
   */
  private resolveSafe(relativePath: string): string {
    const resolved = path.resolve(this.workDir, relativePath);
    if (!resolved.startsWith(this.workDir)) {
      throw new Error(`Path traversal blocked: ${relativePath} resolves outside work directory`);
    }
    return resolved;
  }
}
