// ArmyClaw — WASM Sandbox
// Capability-based security wrapper around WASM execution

import { logger } from '../../logger.js';
import { LeakDetector } from '../safety/leak-detector.js';
import { executeWasm, type WasmModuleEntry, type WasmExecResult } from './runtime.js';

export interface WasmCapabilities {
  /** Max execution time in ms */
  maxExecutionMs: number;
  /** Max memory in bytes (enforced at WASM level) */
  maxMemoryBytes: number;
  /** Max output size in chars */
  maxOutputChars: number;
}

const DEFAULT_CAPABILITIES: WasmCapabilities = {
  maxExecutionMs: 30_000,
  maxMemoryBytes: 10 * 1024 * 1024, // 10MB
  maxOutputChars: 100_000,
};

const leakDetector = new LeakDetector();

/**
 * Execute a WASM tool in a sandboxed environment.
 * Enforces capabilities and scans output for leaks.
 */
export async function sandboxedExecute(
  entry: WasmModuleEntry,
  input: string,
  capabilities?: Partial<WasmCapabilities>,
): Promise<WasmExecResult> {
  const caps = { ...DEFAULT_CAPABILITIES, ...capabilities };

  // Execute with timeout
  const result = await Promise.race<WasmExecResult>([
    executeWasm(entry, input, caps.maxExecutionMs),
    new Promise<WasmExecResult>((_, reject) =>
      setTimeout(() => reject(new Error(`WASM tool "${entry.name}" timed out after ${caps.maxExecutionMs}ms`)), caps.maxExecutionMs)
    ),
  ]);

  // Enforce output size limit
  if (result.output.length > caps.maxOutputChars) {
    result.output = result.output.slice(0, caps.maxOutputChars) + `\n... (truncated at ${caps.maxOutputChars} chars)`;
  }

  // Leak detection on output
  try {
    result.output = leakDetector.sanitize(result.output, `wasm:${entry.name}`);
  } catch (err) {
    // Leak blocked — replace output with error
    logger.warn({ tool: entry.name, error: String(err) }, 'WASM output blocked by leak detector');
    result.output = `[Output blocked: leak detected in WASM tool "${entry.name}"]`;
    result.error = String(err);
  }

  return result;
}
