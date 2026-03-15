// ArmyClaw — WASM Runtime
// Compile-once, instantiate-fresh execution model
// Uses Node.js built-in WebAssembly API (zero native deps)

import { readFileSync } from 'fs';
import { logger } from '../../logger.js';

export interface WasmToolManifest {
  name: string;
  description: string;
  version?: string;
}

export interface WasmModuleEntry {
  name: string;
  description: string;
  module: WebAssembly.Module;  // Pre-compiled, cheap to instantiate
  path: string;
  loadedAt: string;
}

export interface WasmExecResult {
  output: string;
  error: string | null;
  durationMs: number;
}

/** Pre-compiled module cache */
const moduleCache = new Map<string, WasmModuleEntry>();

/**
 * Load and compile a WASM module from disk.
 * Compilation happens once; subsequent instantiations are cheap.
 */
export function loadWasmModule(wasmPath: string, manifest: WasmToolManifest): WasmModuleEntry {
  const existing = moduleCache.get(manifest.name);
  if (existing && existing.path === wasmPath) return existing;

  const binary = readFileSync(wasmPath);
  const module = new WebAssembly.Module(binary);

  const entry: WasmModuleEntry = {
    name: manifest.name,
    description: manifest.description,
    module,
    path: wasmPath,
    loadedAt: new Date().toISOString(),
  };

  moduleCache.set(manifest.name, entry);
  logger.info({ name: manifest.name, path: wasmPath }, 'WASM module compiled and cached');
  return entry;
}

/**
 * Execute a WASM module with the given input.
 * Creates a fresh instance per execution (deterministic, no state leaks).
 */
export async function executeWasm(
  entry: WasmModuleEntry,
  input: string,
  timeoutMs: number = 30_000,
): Promise<WasmExecResult> {
  const start = Date.now();

  try {
    // Build minimal import object with memory and basic I/O
    const memory = new WebAssembly.Memory({ initial: 16, maximum: 160 }); // 1MB initial, 10MB max
    const outputChunks: string[] = [];
    const errorChunks: string[] = [];

    const importObject: WebAssembly.Imports = {
      env: {
        memory,
        // Host function: write output
        host_output: (ptr: number, len: number) => {
          const bytes = new Uint8Array(memory.buffer, ptr, len);
          outputChunks.push(new TextDecoder().decode(bytes));
        },
        // Host function: write error
        host_error: (ptr: number, len: number) => {
          const bytes = new Uint8Array(memory.buffer, ptr, len);
          errorChunks.push(new TextDecoder().decode(bytes));
        },
        // Host function: log
        host_log: (ptr: number, len: number) => {
          const bytes = new Uint8Array(memory.buffer, ptr, len);
          logger.debug({ wasmTool: entry.name }, new TextDecoder().decode(bytes));
        },
      },
    };

    // Fresh instance per execution
    const instance = new WebAssembly.Instance(entry.module, importObject);
    const exports = instance.exports as Record<string, WebAssembly.Global | Function>;

    // Write input to WASM memory
    const inputBytes = new TextEncoder().encode(input);
    const allocFn = exports['alloc'] as ((size: number) => number) | undefined;
    const execFn = exports['execute'] as ((ptr: number, len: number) => number) | undefined;
    const getOutputFn = exports['get_output'] as (() => number) | undefined;

    if (!execFn) {
      // Fallback: try calling a simpler 'run' export
      const runFn = exports['run'] as ((ptr: number, len: number) => void) | undefined;
      if (runFn) {
        if (allocFn) {
          const ptr = allocFn(inputBytes.length);
          new Uint8Array(memory.buffer).set(inputBytes, ptr);
          runFn(ptr, inputBytes.length);
        } else {
          // Write to start of memory
          new Uint8Array(memory.buffer).set(inputBytes, 0);
          runFn(0, inputBytes.length);
        }
      } else {
        throw new Error(`WASM module "${entry.name}" has no execute() or run() export`);
      }
    } else {
      // Standard path: alloc -> write -> execute
      let ptr = 0;
      if (allocFn) {
        ptr = allocFn(inputBytes.length);
      }
      new Uint8Array(memory.buffer).set(inputBytes, ptr);
      execFn(ptr, inputBytes.length);
    }

    const durationMs = Date.now() - start;
    const output = outputChunks.join('');
    const error = errorChunks.length > 0 ? errorChunks.join('') : null;

    return { output: output || '(no output)', error, durationMs };
  } catch (err) {
    const durationMs = Date.now() - start;
    const errorMsg = err instanceof Error ? err.message : String(err);
    return { output: '', error: errorMsg, durationMs };
  }
}

/**
 * Get all loaded WASM modules.
 */
export function getLoadedModules(): WasmModuleEntry[] {
  return [...moduleCache.values()];
}

/**
 * Unload a WASM module from cache.
 */
export function unloadModule(name: string): boolean {
  return moduleCache.delete(name);
}

/**
 * Check if a WASM module is loaded.
 */
export function hasModule(name: string): boolean {
  return moduleCache.has(name);
}
