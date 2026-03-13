import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Armory } from '../src/arsenal/armory.js';
import type { ToolProvider, ToolContext } from '../src/arsenal/armory.js';
import type { LLMTool, ToolUseBlock, ToolResultBlock } from '../src/types.js';

vi.mock('../src/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// ─── Mock Providers ────────────────────────────────────────

function makeMockProvider(name: string, tools: LLMTool[]): ToolProvider {
  return {
    name,
    listTools: () => tools,
    execute: vi.fn(async (block: ToolUseBlock, _ctx: ToolContext): Promise<ToolResultBlock> => ({
      type: 'tool_result',
      tool_use_id: block.id,
      content: `${name} executed ${block.name}`,
      is_error: false,
    })),
    isAvailable: () => true,
  };
}

function makeUnavailableProvider(name: string, tools: LLMTool[]): ToolProvider {
  return {
    name,
    listTools: () => tools,
    execute: vi.fn(async (block: ToolUseBlock): Promise<ToolResultBlock> => ({
      type: 'tool_result',
      tool_use_id: block.id,
      content: 'should not be called',
      is_error: true,
    })),
    isAvailable: () => false,
  };
}

const toolA: LLMTool = { name: 'tool_a', description: 'Tool A', input_schema: { type: 'object', properties: {}, required: [] } };
const toolB: LLMTool = { name: 'tool_b', description: 'Tool B', input_schema: { type: 'object', properties: {}, required: [] } };
const toolC: LLMTool = { name: 'tool_c', description: 'Tool C', input_schema: { type: 'object', properties: {}, required: [] } };

const mockContext: ToolContext = {
  taskId: 'task-001',
  workDir: '/project/worktree',
  role: 'engineer',
};

// ─── Tests ─────────────────────────────────────────────────

describe('Armory', () => {
  let armory: Armory;

  beforeEach(() => {
    vi.clearAllMocks();
    armory = new Armory('/project');
  });

  describe('registerProvider', () => {
    it('should register a provider', () => {
      const provider = makeMockProvider('test', [toolA]);
      armory.registerProvider(provider);

      // Provider is registered — we can verify by checking if tools become available
      // when we set up capabilities manually
    });
  });

  describe('getToolsForRole', () => {
    it('should return empty for role with no capabilities loaded', async () => {
      // Without loading capabilities files, defaults to empty
      await armory.initialize();
      const tools = armory.getToolsForRole('adjutant');
      expect(tools).toEqual([]);
    });

    it('should return tools from allowed providers', async () => {
      // We need to mock fs to provide capabilities files
      const fsMock = await import('fs');
      const originalReadFileSync = fsMock.default.readFileSync;

      vi.spyOn(fsMock.default, 'readFileSync').mockImplementation((p: any, ...args: any[]) => {
        const pathStr = String(p);
        if (pathStr.endsWith('engineer.capabilities.json')) {
          return JSON.stringify({ providers: ['provider_x'] });
        }
        if (pathStr.endsWith('.capabilities.json')) {
          return JSON.stringify({ providers: [] });
        }
        return originalReadFileSync.call(fsMock.default, p, ...args);
      });

      const provider = makeMockProvider('provider_x', [toolA, toolB]);
      armory.registerProvider(provider);
      await armory.initialize();

      const tools = armory.getToolsForRole('engineer');
      expect(tools).toHaveLength(2);
      expect(tools.map(t => t.name)).toEqual(['tool_a', 'tool_b']);
    });

    it('should apply tools_filter when specified', async () => {
      const fsMock = await import('fs');
      vi.spyOn(fsMock.default, 'readFileSync').mockImplementation((p: any) => {
        const pathStr = String(p);
        if (pathStr.endsWith('chief_of_staff.capabilities.json')) {
          return JSON.stringify({ providers: ['provider_x'], tools_filter: ['tool_a'] });
        }
        return JSON.stringify({ providers: [] });
      });

      const provider = makeMockProvider('provider_x', [toolA, toolB, toolC]);
      armory.registerProvider(provider);
      await armory.initialize();

      const tools = armory.getToolsForRole('chief_of_staff');
      expect(tools).toHaveLength(1);
      expect(tools[0]!.name).toBe('tool_a');
    });

    it('should skip unavailable providers', async () => {
      const fsMock = await import('fs');
      vi.spyOn(fsMock.default, 'readFileSync').mockImplementation((p: any) => {
        const pathStr = String(p);
        if (pathStr.endsWith('engineer.capabilities.json')) {
          return JSON.stringify({ providers: ['down_provider', 'up_provider'] });
        }
        return JSON.stringify({ providers: [] });
      });

      armory.registerProvider(makeUnavailableProvider('down_provider', [toolA]));
      armory.registerProvider(makeMockProvider('up_provider', [toolB]));
      await armory.initialize();

      const tools = armory.getToolsForRole('engineer');
      expect(tools).toHaveLength(1);
      expect(tools[0]!.name).toBe('tool_b');
    });

    it('should aggregate tools from multiple providers', async () => {
      const fsMock = await import('fs');
      vi.spyOn(fsMock.default, 'readFileSync').mockImplementation((p: any) => {
        const pathStr = String(p);
        if (pathStr.endsWith('engineer.capabilities.json')) {
          return JSON.stringify({ providers: ['prov_1', 'prov_2'] });
        }
        return JSON.stringify({ providers: [] });
      });

      armory.registerProvider(makeMockProvider('prov_1', [toolA]));
      armory.registerProvider(makeMockProvider('prov_2', [toolB, toolC]));
      await armory.initialize();

      const tools = armory.getToolsForRole('engineer');
      expect(tools).toHaveLength(3);
    });
  });

  describe('execute', () => {
    it('should route tool call to correct provider', async () => {
      const fsMock = await import('fs');
      vi.spyOn(fsMock.default, 'readFileSync').mockImplementation((p: any) => {
        const pathStr = String(p);
        if (pathStr.endsWith('engineer.capabilities.json')) {
          return JSON.stringify({ providers: ['prov_1', 'prov_2'] });
        }
        return JSON.stringify({ providers: [] });
      });

      const prov1 = makeMockProvider('prov_1', [toolA]);
      const prov2 = makeMockProvider('prov_2', [toolB]);
      armory.registerProvider(prov1);
      armory.registerProvider(prov2);
      await armory.initialize();

      const block: ToolUseBlock = { type: 'tool_use', id: 'tu-1', name: 'tool_b', input: {} };
      const result = await armory.execute(block, mockContext);

      expect(result.is_error).toBe(false);
      expect(result.content).toContain('prov_2 executed tool_b');
      expect(prov2.execute).toHaveBeenCalledTimes(1);
      expect(prov1.execute).not.toHaveBeenCalled();
    });

    it('should return error for unknown tool', async () => {
      const fsMock = await import('fs');
      vi.spyOn(fsMock.default, 'readFileSync').mockImplementation(() => JSON.stringify({ providers: [] }));
      await armory.initialize();

      const block: ToolUseBlock = { type: 'tool_use', id: 'tu-1', name: 'nonexistent', input: {} };
      const result = await armory.execute(block, mockContext);

      expect(result.is_error).toBe(true);
      expect(result.content).toContain('not available');
    });

    it('should return error when provider is unavailable', async () => {
      const fsMock = await import('fs');
      vi.spyOn(fsMock.default, 'readFileSync').mockImplementation((p: any) => {
        const pathStr = String(p);
        if (pathStr.endsWith('engineer.capabilities.json')) {
          return JSON.stringify({ providers: ['down'] });
        }
        return JSON.stringify({ providers: [] });
      });

      armory.registerProvider(makeUnavailableProvider('down', [toolA]));
      await armory.initialize();

      const block: ToolUseBlock = { type: 'tool_use', id: 'tu-1', name: 'tool_a', input: {} };
      const result = await armory.execute(block, mockContext);

      expect(result.is_error).toBe(true);
      expect(result.content).toContain('unavailable');
    });

    it('should catch and return provider execution errors', async () => {
      const fsMock = await import('fs');
      vi.spyOn(fsMock.default, 'readFileSync').mockImplementation((p: any) => {
        const pathStr = String(p);
        if (pathStr.endsWith('engineer.capabilities.json')) {
          return JSON.stringify({ providers: ['broken'] });
        }
        return JSON.stringify({ providers: [] });
      });

      const broken: ToolProvider = {
        name: 'broken',
        listTools: () => [toolA],
        execute: vi.fn(async () => { throw new Error('kaboom'); }),
        isAvailable: () => true,
      };
      armory.registerProvider(broken);
      await armory.initialize();

      const block: ToolUseBlock = { type: 'tool_use', id: 'tu-1', name: 'tool_a', input: {} };
      const result = await armory.execute(block, mockContext);

      expect(result.is_error).toBe(true);
      expect(result.content).toContain('kaboom');
    });

    it('should respect tools_filter when routing', async () => {
      const fsMock = await import('fs');
      vi.spyOn(fsMock.default, 'readFileSync').mockImplementation((p: any) => {
        const pathStr = String(p);
        if (pathStr.endsWith('chief_of_staff.capabilities.json')) {
          return JSON.stringify({ providers: ['prov'], tools_filter: ['tool_a'] });
        }
        return JSON.stringify({ providers: [] });
      });

      const prov = makeMockProvider('prov', [toolA, toolB]);
      armory.registerProvider(prov);
      await armory.initialize();

      // tool_b is in the provider but NOT in tools_filter → should be blocked
      const cosCtx: ToolContext = { ...mockContext, role: 'chief_of_staff' };
      const block: ToolUseBlock = { type: 'tool_use', id: 'tu-1', name: 'tool_b', input: {} };
      const result = await armory.execute(block, cosCtx);

      expect(result.is_error).toBe(true);
      expect(result.content).toContain('not available');
    });
  });

  describe('getToolNamesForRole', () => {
    it('should return tool name strings', async () => {
      const fsMock = await import('fs');
      vi.spyOn(fsMock.default, 'readFileSync').mockImplementation((p: any) => {
        const pathStr = String(p);
        if (pathStr.endsWith('engineer.capabilities.json')) {
          return JSON.stringify({ providers: ['prov'] });
        }
        return JSON.stringify({ providers: [] });
      });

      armory.registerProvider(makeMockProvider('prov', [toolA, toolB]));
      await armory.initialize();

      const names = armory.getToolNamesForRole('engineer');
      expect(names).toEqual(['tool_a', 'tool_b']);
    });
  });
});
