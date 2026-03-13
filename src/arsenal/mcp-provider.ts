// ═══════════════════════════════════════════════════════════
// ArmyClaw — MCP Tool Provider
// Generic connector for any MCP server via stdio transport.
// Handles connection lifecycle, tool caching, path prefixing,
// and circuit breaker integration.
// ═══════════════════════════════════════════════════════════

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

import { logger } from '../logger.js';
import type { LLMTool, ToolUseBlock, ToolResultBlock } from '../types.js';
import type { ToolProvider, ToolContext } from './armory.js';
import { CircuitBreaker } from './circuit-breaker.js';

// ─── Config ──────────────────────────────────────────────

export interface MCPServerConfig {
  name: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
  path_prefix?: boolean;
}

// Path parameter names that should be prefixed with workDir
const PATH_PARAMS = new Set(['path', 'source', 'destination']);

// ─── Provider ────────────────────────────────────────────

export class MCPToolProvider implements ToolProvider {
  readonly name: string;
  private client: Client;
  private transport: StdioClientTransport | null = null;
  private breaker: CircuitBreaker;
  private cachedTools: LLMTool[] = [];
  private connected = false;
  private pathPrefix: boolean;
  private config: MCPServerConfig;

  constructor(config: MCPServerConfig, breaker: CircuitBreaker) {
    this.name = config.name;
    this.config = config;
    this.pathPrefix = config.path_prefix ?? false;
    this.breaker = breaker;
    this.client = new Client(
      { name: `armyclaw-${config.name}`, version: '1.0.0' },
    );
  }

  async connect(): Promise<void> {
    const { command, args, env } = this.config;

    this.transport = new StdioClientTransport({
      command,
      args,
      env: env ?? undefined,
      stderr: 'pipe',
    });

    try {
      await this.client.connect(this.transport);

      // Cache tool list
      const result = await this.client.listTools();
      this.cachedTools = result.tools.map((t) => ({
        name: t.name,
        description: t.description ?? '',
        input_schema: t.inputSchema as Record<string, unknown>,
      }));

      this.connected = true;
      logger.info(
        { provider: this.name, tools: this.cachedTools.map((t) => t.name) },
        'MCP server connected',
      );
    } catch (err) {
      this.connected = false;
      logger.error(
        { provider: this.name, error: err instanceof Error ? err.message : String(err) },
        'MCP server connection failed',
      );
      throw err;
    }
  }

  listTools(): LLMTool[] {
    return this.cachedTools;
  }

  async execute(block: ToolUseBlock, context: ToolContext): Promise<ToolResultBlock> {
    if (!this.breaker.canExecute()) {
      return {
        type: 'tool_result',
        tool_use_id: block.id,
        content: `MCP server "${this.name}" circuit breaker is open`,
        is_error: true,
      };
    }

    try {
      // Prefix paths if enabled
      const args = this.pathPrefix
        ? this.prefixPaths(block.input as Record<string, unknown>, context.workDir)
        : (block.input as Record<string, unknown>);

      const result = await this.client.callTool({ name: block.name, arguments: args });

      // Convert MCP result to ToolResultBlock
      const content = Array.isArray(result.content)
        ? result.content
            .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
            .map((c) => c.text)
            .join('\n')
        : String(result.content ?? '');

      this.breaker.recordSuccess();

      return {
        type: 'tool_result',
        tool_use_id: block.id,
        content: content || '(no output)',
        is_error: (result as { isError?: boolean }).isError ?? false,
      };
    } catch (err) {
      this.breaker.recordFailure();

      return {
        type: 'tool_result',
        tool_use_id: block.id,
        content: `MCP tool error: ${err instanceof Error ? err.message : String(err)}`,
        is_error: true,
      };
    }
  }

  isAvailable(): boolean {
    return this.connected && this.breaker.canExecute();
  }

  async shutdown(): Promise<void> {
    if (this.transport) {
      try {
        await this.transport.close();
      } catch {
        // Best effort
      }
      this.transport = null;
    }
    this.connected = false;
    logger.info({ provider: this.name }, 'MCP server shut down');
  }

  // ─── Private ──────────────────────────────────────────────

  /**
   * Prefix relative path arguments with workDir to produce absolute paths.
   * MCP filesystem server requires absolute paths.
   */
  private prefixPaths(
    input: Record<string, unknown>,
    workDir: string,
  ): Record<string, unknown> {
    const result = { ...input };

    for (const [key, value] of Object.entries(result)) {
      if (PATH_PARAMS.has(key) && typeof value === 'string' && !value.startsWith('/')) {
        result[key] = `${workDir}/${value}`;
      }
    }

    return result;
  }
}
