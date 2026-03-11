import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { ToolExecutor } from '../src/agents/tool-executor.js';
import type { ToolUseBlock } from '../src/types.js';

describe('ToolExecutor', () => {
  let workDir: string;
  let executor: ToolExecutor;

  beforeEach(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'armyclaw-test-'));
    executor = new ToolExecutor(workDir);
  });

  afterEach(() => {
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  function makeBlock(name: string, input: Record<string, unknown>): ToolUseBlock {
    return { type: 'tool_use', id: `tu-${Date.now()}`, name, input };
  }

  // ─── file_write + file_read ────────────────────────────────

  describe('file_write', () => {
    it('should write a file', () => {
      const result = executor.execute(makeBlock('file_write', {
        path: 'hello.txt',
        content: 'Hello World\nLine 2',
      }));

      expect(result.is_error).toBe(false);
      expect(result.content).toContain('2 lines');

      const written = fs.readFileSync(path.join(workDir, 'hello.txt'), 'utf-8');
      expect(written).toBe('Hello World\nLine 2');
    });

    it('should create nested directories', () => {
      executor.execute(makeBlock('file_write', {
        path: 'src/deep/file.ts',
        content: 'export const x = 1;',
      }));

      expect(fs.existsSync(path.join(workDir, 'src/deep/file.ts'))).toBe(true);
    });
  });

  describe('file_read', () => {
    it('should read a file with line numbers', () => {
      fs.writeFileSync(path.join(workDir, 'test.txt'), 'line1\nline2\nline3');

      const result = executor.execute(makeBlock('file_read', { path: 'test.txt' }));
      expect(result.is_error).toBe(false);
      expect(result.content).toContain('1');
      expect(result.content).toContain('line1');
      expect(result.content).toContain('line3');
    });

    it('should support offset and limit', () => {
      fs.writeFileSync(path.join(workDir, 'big.txt'), 'a\nb\nc\nd\ne');

      const result = executor.execute(makeBlock('file_read', {
        path: 'big.txt', offset: 1, limit: 2,
      }));
      expect(result.is_error).toBe(false);
      expect(result.content).toContain('b');
      expect(result.content).toContain('c');
      expect(result.content).not.toContain('  1');
    });

    it('should error on missing file', () => {
      const result = executor.execute(makeBlock('file_read', { path: 'nope.txt' }));
      expect(result.is_error).toBe(true);
      expect(result.content).toContain('not found');
    });
  });

  // ─── file_list ─────────────────────────────────────────────

  describe('file_list', () => {
    it('should list files and directories', () => {
      fs.writeFileSync(path.join(workDir, 'a.txt'), '');
      fs.mkdirSync(path.join(workDir, 'subdir'));

      const result = executor.execute(makeBlock('file_list', {}));
      expect(result.is_error).toBe(false);
      expect(result.content).toContain('a.txt');
      expect(result.content).toContain('subdir/');
    });

    it('should error on missing directory', () => {
      const result = executor.execute(makeBlock('file_list', { path: 'nope' }));
      expect(result.is_error).toBe(true);
    });
  });

  // ─── search ────────────────────────────────────────────────

  describe('search', () => {
    it('should find pattern in files', () => {
      fs.writeFileSync(path.join(workDir, 'code.ts'), 'const hello = "world";\nconst foo = "bar";');

      const result = executor.execute(makeBlock('search', { pattern: 'hello' }));
      expect(result.is_error).toBe(false);
      expect(result.content).toContain('hello');
    });

    it('should return no matches gracefully', () => {
      fs.writeFileSync(path.join(workDir, 'code.ts'), 'nothing here');

      const result = executor.execute(makeBlock('search', { pattern: 'zzzznotfound' }));
      expect(result.is_error).toBe(false);
      expect(result.content).toContain('No matches');
    });
  });

  // ─── code_execute ──────────────────────────────────────────

  describe('code_execute', () => {
    it('should execute a command and return output', () => {
      const result = executor.execute(makeBlock('code_execute', { command: 'echo "hi"' }));
      expect(result.is_error).toBe(false);
      expect(result.content).toContain('hi');
    });

    it('should capture errors', () => {
      const result = executor.execute(makeBlock('code_execute', { command: 'false' }));
      expect(result.is_error).toBe(true);
    });

    it('should run in the work directory', () => {
      const result = executor.execute(makeBlock('code_execute', { command: 'pwd' }));
      expect(result.is_error).toBe(false);
      expect(result.content).toContain(workDir);
    });
  });

  // ─── test_run ──────────────────────────────────────────────

  describe('test_run', () => {
    it('should run a custom test command', () => {
      const result = executor.execute(makeBlock('test_run', { command: 'echo "tests passed"' }));
      expect(result.is_error).toBe(false);
      expect(result.content).toContain('tests passed');
    });
  });

  // ─── Path safety ──────────────────────────────────────────

  describe('path safety', () => {
    it('should block directory traversal', () => {
      const result = executor.execute(makeBlock('file_read', {
        path: '../../etc/passwd',
      }));
      expect(result.is_error).toBe(true);
      expect(result.content).toContain('traversal');
    });

    it('should block absolute paths outside workdir', () => {
      const result = executor.execute(makeBlock('file_read', {
        path: '/etc/passwd',
      }));
      expect(result.is_error).toBe(true);
      expect(result.content).toContain('traversal');
    });
  });

  // ─── Unknown tool ──────────────────────────────────────────

  describe('unknown tool', () => {
    it('should return error for unknown tool name', () => {
      const result = executor.execute(makeBlock('unknown_tool', {}));
      expect(result.is_error).toBe(true);
      expect(result.content).toContain('Unknown tool');
    });
  });
});
