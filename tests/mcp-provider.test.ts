import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import type { ToolUseBlock } from '../src/types.js';
import type { ToolContext } from '../src/arsenal/armory.js';
import { CircuitBreaker } from '../src/arsenal/circuit-breaker.js';

// ─── Mock MCP SDK ────────────────────────────────────────

const mockCallTool = vi.fn();
const mockListTools = vi.fn();
const mockConnect = vi.fn();

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: vi.fn().mockImplementation(() => ({
    connect: mockConnect,
    listTools: mockListTools,
    callTool: mockCallTool,
  })),
}));

const mockTransportClose = vi.fn();
vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  StdioClientTransport: vi.fn().mockImplementation(() => ({
    close: mockTransportClose,
  })),
}));

vi.mock('../src/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// ─── Import after mocks ─────────────────────────────────

import { MCPToolProvider } from '../src/arsenal/mcp-provider.js';
import type { MCPServerConfig } from '../src/arsenal/mcp-provider.js';

// ─── Test Data ──────────────────────────────────────────

const testConfig: MCPServerConfig = {
  name: 'test-server',
  command: 'node',
  args: ['server.js'],
  path_prefix: true,
};

const testContext: ToolContext = {
  taskId: 'task-001',
  workDir: '/project/worktree',
  role: 'engineer',
};

function makeBlock(name: string, input: Record<string, unknown>): ToolUseBlock {
  return { type: 'tool_use', id: `tu-${Date.now()}`, name, input };
}

// ─── Tests ──────────────────────────────────────────────

describe('MCPToolProvider', () => {
  let provider: MCPToolProvider;
  let breaker: CircuitBreaker;

  beforeEach(() => {
    vi.clearAllMocks();
    breaker = new CircuitBreaker(3, 60000, 1);

    // Default mock: listTools returns two tools
    mockListTools.mockResolvedValue({
      tools: [
        {
          name: 'read_file',
          description: 'Read a file',
          inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
        },
        {
          name: 'write_file',
          description: 'Write a file',
          inputSchema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] },
        },
      ],
    });

    provider = new MCPToolProvider(testConfig, breaker);
  });

  afterEach(async () => {
    await provider.shutdown();
  });

  describe('connect', () => {
    it('should connect and cache tool list', async () => {
      await provider.connect();

      expect(mockConnect).toHaveBeenCalledTimes(1);
      expect(mockListTools).toHaveBeenCalledTimes(1);
      expect(provider.isAvailable()).toBe(true);
    });

    it('should convert MCP tools to LLMTool format', async () => {
      await provider.connect();

      const tools = provider.listTools();
      expect(tools).toHaveLength(2);
      expect(tools[0]!.name).toBe('read_file');
      expect(tools[0]!.description).toBe('Read a file');
      expect(tools[0]!.input_schema).toEqual({
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
      });
    });

    it('should handle connection failure', async () => {
      mockConnect.mockRejectedValueOnce(new Error('spawn failed'));

      await expect(provider.connect()).rejects.toThrow('spawn failed');
      expect(provider.isAvailable()).toBe(false);
    });
  });

  describe('listTools', () => {
    it('should return empty before connect', () => {
      expect(provider.listTools()).toEqual([]);
    });

    it('should return cached tools after connect', async () => {
      await provider.connect();
      expect(provider.listTools()).toHaveLength(2);
    });
  });

  describe('execute', () => {
    beforeEach(async () => {
      await provider.connect();
    });

    it('should call MCP tool and return result', async () => {
      mockCallTool.mockResolvedValueOnce({
        content: [{ type: 'text', text: 'file content here' }],
        isError: false,
      });

      const block = makeBlock('read_file', { path: 'src/main.ts' });
      const result = await provider.execute(block, testContext);

      expect(result.is_error).toBe(false);
      expect(result.content).toBe('file content here');
      expect(mockCallTool).toHaveBeenCalledWith({
        name: 'read_file',
        arguments: { path: '/project/worktree/src/main.ts' },
      });
    });

    it('should prefix relative paths when path_prefix is enabled', async () => {
      mockCallTool.mockResolvedValueOnce({
        content: [{ type: 'text', text: 'ok' }],
      });

      const block = makeBlock('write_file', { path: 'output.txt', content: 'hello' });
      await provider.execute(block, testContext);

      expect(mockCallTool).toHaveBeenCalledWith({
        name: 'write_file',
        arguments: { path: '/project/worktree/output.txt', content: 'hello' },
      });
    });

    it('should NOT prefix absolute paths', async () => {
      mockCallTool.mockResolvedValueOnce({
        content: [{ type: 'text', text: 'ok' }],
      });

      const block = makeBlock('read_file', { path: '/absolute/path/file.ts' });
      await provider.execute(block, testContext);

      expect(mockCallTool).toHaveBeenCalledWith({
        name: 'read_file',
        arguments: { path: '/absolute/path/file.ts' },
      });
    });

    it('should concatenate multiple text content blocks', async () => {
      mockCallTool.mockResolvedValueOnce({
        content: [
          { type: 'text', text: 'line 1' },
          { type: 'text', text: 'line 2' },
        ],
      });

      const result = await provider.execute(makeBlock('read_file', { path: 'x' }), testContext);
      expect(result.content).toBe('line 1\nline 2');
    });

    it('should handle MCP tool errors', async () => {
      mockCallTool.mockResolvedValueOnce({
        content: [{ type: 'text', text: 'Permission denied' }],
        isError: true,
      });

      const result = await provider.execute(makeBlock('read_file', { path: 'secret' }), testContext);
      expect(result.is_error).toBe(true);
      expect(result.content).toContain('Permission denied');
    });

    it('should handle callTool exceptions and record breaker failure', async () => {
      mockCallTool.mockRejectedValueOnce(new Error('server crashed'));

      const result = await provider.execute(makeBlock('read_file', { path: 'x' }), testContext);
      expect(result.is_error).toBe(true);
      expect(result.content).toContain('server crashed');
    });

    it('should return error when circuit breaker is open', async () => {
      // Trip the breaker
      for (let i = 0; i < 3; i++) {
        breaker.recordFailure();
      }
      expect(breaker.getState()).toBe('open');

      const result = await provider.execute(makeBlock('read_file', { path: 'x' }), testContext);
      expect(result.is_error).toBe(true);
      expect(result.content).toContain('circuit breaker');
    });

    it('should record success on breaker after successful call', async () => {
      mockCallTool.mockResolvedValueOnce({
        content: [{ type: 'text', text: 'ok' }],
      });

      await provider.execute(makeBlock('read_file', { path: 'x' }), testContext);
      expect(breaker.getState()).toBe('closed');
    });
  });

  describe('path_prefix disabled', () => {
    it('should NOT prefix paths when path_prefix is false', async () => {
      const noPrefixProvider = new MCPToolProvider(
        { ...testConfig, path_prefix: false },
        breaker,
      );
      await noPrefixProvider.connect();

      mockCallTool.mockResolvedValueOnce({
        content: [{ type: 'text', text: 'ok' }],
      });

      const block = makeBlock('read_file', { path: 'relative/path.ts' });
      await noPrefixProvider.execute(block, testContext);

      expect(mockCallTool).toHaveBeenCalledWith({
        name: 'read_file',
        arguments: { path: 'relative/path.ts' },
      });

      await noPrefixProvider.shutdown();
    });
  });

  describe('shutdown', () => {
    it('should close transport', async () => {
      await provider.connect();
      await provider.shutdown();

      expect(mockTransportClose).toHaveBeenCalledTimes(1);
      expect(provider.isAvailable()).toBe(false);
    });
  });

  describe('isAvailable', () => {
    it('should be false before connect', () => {
      expect(provider.isAvailable()).toBe(false);
    });

    it('should be true after connect', async () => {
      await provider.connect();
      expect(provider.isAvailable()).toBe(true);
    });

    it('should be false when breaker is open', async () => {
      await provider.connect();
      for (let i = 0; i < 3; i++) breaker.recordFailure();
      expect(provider.isAvailable()).toBe(false);
    });
  });
});
