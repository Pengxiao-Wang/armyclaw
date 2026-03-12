// ═══════════════════════════════════════════════════════════
// ArmyClaw — .env Manager
// Read/write .env with block-level upsert, preserving
// comments and non-managed lines.
// ═══════════════════════════════════════════════════════════

import fs from 'fs';

export type EnvBlock = Record<string, string>;

/** Marker prefix used to identify managed blocks */
const BLOCK_START = (name: string) => `# ─── ${name} (managed by setup) ────────`;
const BLOCK_END_PATTERN = /^# ─── .+ \(managed by setup\) ────────$/;

export class EnvManager {
  private lines: string[];
  private managed: Map<string, EnvBlock>;

  private constructor(lines: string[], managed: Map<string, EnvBlock>) {
    this.lines = lines;
    this.managed = managed;
  }

  /** Load from existing .env (and optionally merge missing keys from template) */
  static load(envPath: string, templatePath?: string): EnvManager {
    let content = '';
    if (fs.existsSync(envPath)) {
      content = fs.readFileSync(envPath, 'utf-8');
    } else if (templatePath && fs.existsSync(templatePath)) {
      content = fs.readFileSync(templatePath, 'utf-8');
    }

    const lines = content.split('\n');
    const managed = new Map<string, EnvBlock>();

    // Parse managed blocks
    let currentBlock: string | null = null;
    let currentVars: EnvBlock = {};

    for (const line of lines) {
      if (BLOCK_END_PATTERN.test(line)) {
        const match = line.match(/^# ─── (.+?) \(managed by setup\)/);
        if (match) {
          if (currentBlock) {
            managed.set(currentBlock, currentVars);
          }
          currentBlock = match[1];
          currentVars = {};
          continue;
        }
      }
      if (currentBlock) {
        const kvMatch = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
        if (kvMatch) {
          currentVars[kvMatch[1]] = kvMatch[2];
        } else if (line.trim() === '' || line.startsWith('#')) {
          // comment or blank inside block — skip for data purposes
        } else {
          // Non-env line ends the block
          managed.set(currentBlock, currentVars);
          currentBlock = null;
          currentVars = {};
        }
      }
    }
    if (currentBlock) {
      managed.set(currentBlock, currentVars);
    }

    return new EnvManager(lines, managed);
  }

  /** Get a single env var value (scans lines top-to-bottom) */
  get(key: string): string | undefined {
    for (let i = this.lines.length - 1; i >= 0; i--) {
      const line = this.lines[i];
      if (line.startsWith(`${key}=`)) {
        return line.slice(key.length + 1);
      }
    }
    return undefined;
  }

  /** Set a single env var (updates last occurrence or appends) */
  set(key: string, value: string): void {
    for (let i = this.lines.length - 1; i >= 0; i--) {
      if (this.lines[i].startsWith(`${key}=`)) {
        this.lines[i] = `${key}=${value}`;
        return;
      }
      // Also handle commented-out vars: "# KEY=value"
      if (this.lines[i].match(new RegExp(`^#\\s*${key}=`))) {
        this.lines[i] = `${key}=${value}`;
        return;
      }
    }
    // Not found — append
    this.lines.push(`${key}=${value}`);
  }

  /** Upsert an entire named block of env vars */
  upsertBlock(blockName: string, vars: EnvBlock): void {
    this.managed.set(blockName, vars);

    // Build block lines
    const blockLines = [
      BLOCK_START(blockName),
      ...Object.entries(vars).map(([k, v]) => `${k}=${v}`),
      '',
    ];

    // Find and replace existing block
    const headerPattern = new RegExp(
      `^# ─── ${blockName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\(managed by setup\\)`,
    );
    let startIdx = -1;
    let endIdx = -1;

    for (let i = 0; i < this.lines.length; i++) {
      if (headerPattern.test(this.lines[i])) {
        startIdx = i;
        // Find end of block: next block header, or next non-env/non-comment/non-blank line
        for (let j = i + 1; j < this.lines.length; j++) {
          if (BLOCK_END_PATTERN.test(this.lines[j])) {
            endIdx = j;
            break;
          }
          const isEnvLine = /^[A-Z_][A-Z0-9_]*=/.test(this.lines[j]);
          const isBlankOrComment = this.lines[j].trim() === '' || this.lines[j].startsWith('#');
          if (!isEnvLine && !isBlankOrComment) {
            endIdx = j;
            break;
          }
        }
        if (endIdx === -1) endIdx = this.lines.length;
        break;
      }
    }

    if (startIdx >= 0) {
      this.lines.splice(startIdx, endIdx - startIdx, ...blockLines);
    } else {
      // Append block at end
      // Ensure trailing newline separation
      if (this.lines.length > 0 && this.lines[this.lines.length - 1].trim() !== '') {
        this.lines.push('');
      }
      this.lines.push(...blockLines);
    }
  }

  /** Save to .env file */
  save(envPath: string): void {
    const content = this.lines.join('\n').replace(/\n{3,}/g, '\n\n');
    fs.writeFileSync(envPath, content, 'utf-8');
  }

  /** Check if a key has a non-empty value */
  has(key: string): boolean {
    const v = this.get(key);
    return v !== undefined && v !== '';
  }
}
