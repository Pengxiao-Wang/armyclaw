import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { ExecProvider } from '../src/arsenal/exec-provider.js';
import type { ToolContext } from '../src/arsenal/armory.js';
import type { ToolUseBlock } from '../src/types.js';

describe('ExecProvider', () => {
  let provider: ExecProvider;
  let workDir: string;
  let context: ToolContext;

  beforeEach(() => {
    provider = new ExecProvider();
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'armyclaw-exec-'));
    context = {
      taskId: 'task-test',
      workDir,
      role: 'engineer',
    };
  });

  afterEach(() => {
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  function makeBlock(name: string, input: Record<string, unknown>): ToolUseBlock {
    return { type: 'tool_use', id: `tu-${Date.now()}`, name, input };
  }

  describe('listTools', () => {
    it('should return code_execute and test_run', () => {
      const tools = provider.listTools();
      expect(tools).toHaveLength(2);
      expect(tools.map(t => t.name).sort()).toEqual(['code_execute', 'test_run']);
    });
  });

  describe('isAvailable', () => {
    it('should always return true', () => {
      expect(provider.isAvailable()).toBe(true);
    });
  });

  describe('code_execute', () => {
    it('should execute command and return output', async () => {
      const result = await provider.execute(makeBlock('code_execute', { command: 'echo "hello"' }), context);
      expect(result.is_error).toBe(false);
      expect(result.content).toContain('hello');
    });

    it('should run in workDir', async () => {
      const result = await provider.execute(makeBlock('code_execute', { command: 'pwd' }), context);
      expect(result.is_error).toBe(false);
      const realWorkDir = fs.realpathSync(workDir);
      expect(result.content).toContain(realWorkDir);
    });

    it('should return error for failing command', async () => {
      const result = await provider.execute(makeBlock('code_execute', { command: 'false' }), context);
      expect(result.is_error).toBe(true);
    });

    it('should truncate long output', async () => {
      const result = await provider.execute(
        makeBlock('code_execute', { command: 'python3 -c "print(\'x\' * 20000)"' }),
        context,
      );
      expect(result.is_error).toBe(false);
      expect(result.content).toContain('truncated');
    });
  });

  describe('test_run', () => {
    it('should default to npm test', async () => {
      // npm test will fail in temp dir (no package.json), but verifies cwd is set
      const result = await provider.execute(makeBlock('test_run', {}), context);
      expect(result.is_error).toBe(true); // expected: no package.json
    });

    it('should accept custom command', async () => {
      const result = await provider.execute(makeBlock('test_run', { command: 'echo "tests passed"' }), context);
      expect(result.is_error).toBe(false);
      expect(result.content).toContain('tests passed');
    });
  });
});
