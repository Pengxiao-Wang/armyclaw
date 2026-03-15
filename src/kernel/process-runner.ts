// ═══════════════════════════════════════════════════════════
// ArmyClaw Kernel — Process Runner
// Generic process spawning with timeout, stdio management,
// and environment sanitization.
// Adapted from NanoClaw's container-runner.ts
// ═══════════════════════════════════════════════════════════

import { spawn, type ChildProcess } from 'child_process';
import { logger } from '../logger.js';

export interface ProcessOptions {
  command: string;
  args: string[];
  cwd: string;
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
  stdin?: string;
  /** Maximum output size in bytes before truncation */
  maxOutputSize?: number;
}

export interface ProcessResult {
  stdout: string;
  stderr: string;
  code: number | null;
  timedOut: boolean;
}

const DEFAULT_TIMEOUT_MS = 300_000; // 5 minutes
const DEFAULT_MAX_OUTPUT = 10 * 1024 * 1024; // 10 MB
const GRACEFUL_KILL_DELAY = 5_000;

/**
 * Build a sanitized environment for spawning child processes.
 * Removes CLAUDECODE to prevent "cannot launch inside another session" errors.
 * Optionally strips dangerous env vars for sandboxed execution.
 */
export function buildSafeEnv(
  extra?: Record<string, string | undefined>,
  readOnly = false,
): Record<string, string | undefined> {
  const env = { ...process.env, ...extra };

  // Remove Claude Code nesting guard
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_ENTRYPOINT;

  // For read-only agents, remove write-capable credentials
  if (readOnly) {
    delete env.GITHUB_TOKEN;
    delete env.GH_TOKEN;
  }

  return env;
}

/**
 * Spawn a process and collect its output.
 * Handles timeout with graceful SIGTERM → SIGKILL escalation.
 */
export function runProcess(options: ProcessOptions): Promise<ProcessResult> {
  const {
    command,
    args,
    cwd,
    env,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    stdin,
    maxOutputSize = DEFAULT_MAX_OUTPUT,
  } = options;

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: env ?? buildSafeEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutSize = 0;
    let stderrSize = 0;
    let settled = false;
    let timedOut = false;

    child.stdout.on('data', (data: Buffer) => {
      if (stdoutSize < maxOutputSize) {
        stdout.push(data);
        stdoutSize += data.length;
      }
    });

    child.stderr.on('data', (data: Buffer) => {
      if (stderrSize < maxOutputSize) {
        stderr.push(data);
        stderrSize += data.length;
      }
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);

      const result: ProcessResult = {
        stdout: Buffer.concat(stdout).toString('utf-8'),
        stderr: Buffer.concat(stderr).toString('utf-8'),
        code,
        timedOut,
      };

      // Truncation notice
      if (stdoutSize >= maxOutputSize) {
        result.stdout += `\n... (truncated at ${maxOutputSize} bytes)`;
      }

      resolve(result);
    });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });

    // Write stdin and close
    if (stdin !== undefined) {
      child.stdin.write(stdin);
    }
    child.stdin.end();

    // Timeout with graceful escalation
    const timer = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      logger.warn({ command, args, timeoutMs }, 'Process timed out, sending SIGTERM');
      child.kill('SIGTERM');
      setTimeout(() => {
        if (!settled) {
          logger.warn({ command, args }, 'Process did not exit after SIGTERM, sending SIGKILL');
          child.kill('SIGKILL');
        }
      }, GRACEFUL_KILL_DELAY);
    }, timeoutMs);
  });
}

/**
 * Spawn Claude Code as a subprocess.
 * This is the primary execution path for engineer agents.
 * Uses `-p` (print mode) for non-interactive execution.
 */
export async function runClaudeCode(
  prompt: string,
  cwd: string,
  timeoutMs?: number,
): Promise<ProcessResult> {
  return runProcess({
    command: 'claude',
    args: ['-p', '--verbose'],
    cwd,
    env: buildSafeEnv(),
    timeoutMs: timeoutMs ?? DEFAULT_TIMEOUT_MS,
    stdin: prompt,
  });
}

/**
 * Run a read-only shell command.
 * Used by chief_of_staff and inspector agents — the Unix CLI single entry.
 * Commands run in a subshell with restricted environment.
 */
export async function runShellReadOnly(
  command: string,
  cwd: string,
  timeoutMs = 30_000,
): Promise<ProcessResult> {
  return runProcess({
    command: '/bin/sh',
    args: ['-c', command],
    cwd,
    env: buildSafeEnv(undefined, true),
    timeoutMs,
    maxOutputSize: 1024 * 1024, // 1 MB for shell output
  });
}
