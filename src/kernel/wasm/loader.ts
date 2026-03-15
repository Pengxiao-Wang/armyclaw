// ArmyClaw — WASM Tool Loader + Hot Reload
// Watches tools/ directory for new .wasm files and auto-loads them

import { readdirSync, readFileSync, watch, existsSync, mkdirSync } from 'fs';
import path from 'path';
import { logger } from '../../logger.js';
import { loadWasmModule, unloadModule, type WasmToolManifest } from './runtime.js';

const TOOLS_DIR = path.join(process.cwd(), 'tools');

/**
 * Scan tools/ directory and load all .wasm files with manifests.
 * Each tool needs:
 *   tools/my-tool.wasm     — the WASM binary
 *   tools/my-tool.json     — manifest: { name, description, version? }
 */
export function loadAllTools(): number {
  if (!existsSync(TOOLS_DIR)) {
    mkdirSync(TOOLS_DIR, { recursive: true });
    logger.info({ dir: TOOLS_DIR }, 'Created tools/ directory');
    return 0;
  }

  const files = readdirSync(TOOLS_DIR).filter(f => f.endsWith('.wasm'));
  let loaded = 0;

  for (const wasmFile of files) {
    const baseName = wasmFile.replace('.wasm', '');
    const manifestPath = path.join(TOOLS_DIR, `${baseName}.json`);
    const wasmPath = path.join(TOOLS_DIR, wasmFile);

    try {
      let manifest: WasmToolManifest;

      if (existsSync(manifestPath)) {
        manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
      } else {
        // Auto-generate manifest from filename
        manifest = {
          name: baseName,
          description: `WASM tool: ${baseName}`,
        };
      }

      loadWasmModule(wasmPath, manifest);
      loaded++;
    } catch (err) {
      logger.warn({ file: wasmFile, error: String(err) }, 'Failed to load WASM tool');
    }
  }

  if (loaded > 0) {
    logger.info({ count: loaded, dir: TOOLS_DIR }, 'WASM tools loaded');
  }

  return loaded;
}

/**
 * Watch tools/ directory for changes and hot-reload WASM modules.
 * New .wasm files are compiled and registered immediately.
 * Deleted .wasm files are unloaded from cache.
 */
export function startHotReload(): void {
  if (!existsSync(TOOLS_DIR)) {
    mkdirSync(TOOLS_DIR, { recursive: true });
  }

  // Debounce: avoid double-firing on write (many editors do write+rename)
  const pending = new Map<string, NodeJS.Timeout>();

  watch(TOOLS_DIR, (eventType, filename) => {
    if (!filename) return;

    // Clear previous debounce timer for this file
    const existing = pending.get(filename);
    if (existing) clearTimeout(existing);

    pending.set(filename, setTimeout(() => {
      pending.delete(filename);

      if (filename.endsWith('.wasm')) {
        const baseName = filename.replace('.wasm', '');
        const wasmPath = path.join(TOOLS_DIR, filename);
        const manifestPath = path.join(TOOLS_DIR, `${baseName}.json`);

        if (existsSync(wasmPath)) {
          // Load or reload
          try {
            let manifest: WasmToolManifest;
            if (existsSync(manifestPath)) {
              manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
            } else {
              manifest = { name: baseName, description: `WASM tool: ${baseName}` };
            }
            loadWasmModule(wasmPath, manifest);
            logger.info({ name: baseName }, 'WASM tool hot-loaded');
          } catch (err) {
            logger.warn({ file: filename, error: String(err) }, 'WASM hot-load failed');
          }
        } else {
          // File deleted — unload
          if (unloadModule(baseName)) {
            logger.info({ name: baseName }, 'WASM tool unloaded (file removed)');
          }
        }
      }

      if (filename.endsWith('.json')) {
        // Manifest changed — reload the corresponding WASM if it exists
        const baseName = filename.replace('.json', '');
        const wasmPath = path.join(TOOLS_DIR, `${baseName}.wasm`);
        if (existsSync(wasmPath)) {
          try {
            const manifest = JSON.parse(readFileSync(path.join(TOOLS_DIR, filename), 'utf-8'));
            loadWasmModule(wasmPath, manifest);
            logger.info({ name: baseName }, 'WASM tool reloaded (manifest changed)');
          } catch (err) {
            logger.warn({ file: filename, error: String(err) }, 'WASM manifest reload failed');
          }
        }
      }
    }, 300)); // 300ms debounce
  });

  logger.info({ dir: TOOLS_DIR }, 'WASM hot-reload watcher started');
}
