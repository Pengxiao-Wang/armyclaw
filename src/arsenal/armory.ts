// ═══════════════════════════════════════════════════════════
// ArmyClaw — Armory (武器库) v2
// MCP router + minimal built-in providers.
// Loads MCP servers from armory.json, manages lifecycle,
// routes tool calls based on role capabilities.
// ═══════════════════════════════════════════════════════════

import fs from 'fs';
import path from 'path';

import {
  SOULS_DIR,
  CIRCUIT_BREAKER_FAILURE_THRESHOLD,
  CIRCUIT_BREAKER_RESET_TIMEOUT_MS,
  CIRCUIT_BREAKER_HALF_OPEN_MAX,
} from '../config.js';
import { logger } from '../logger.js';
import type { AgentRole, LLMTool, ToolUseBlock, ToolResultBlock } from '../types.js';
import { CircuitBreaker } from './circuit-breaker.js';
import { MCPToolProvider } from './mcp-provider.js';
import type { MCPServerConfig } from './mcp-provider.js';

// ─── Interfaces ────────────────────────────────────────────

export interface ToolProvider {
  name: string;
  listTools(): LLMTool[];
  execute(block: ToolUseBlock, context: ToolContext): Promise<ToolResultBlock>;
  isAvailable(): boolean;
}

export interface ToolContext {
  taskId: string;
  workDir: string;
  role: AgentRole;
}

export interface RoleCapability {
  providers: string[];
  tools_filter?: string[];
}

interface ArmoryConfig {
  mcp_servers: MCPServerConfig[];
}

// ─── Armory ────────────────────────────────────────────────

export class Armory {
  private providers = new Map<string, ToolProvider>();
  private mcpProviders: MCPToolProvider[] = [];
  private roleCapabilities = new Map<AgentRole, RoleCapability>();

  constructor(private projectDir: string) {}

  async initialize(): Promise<void> {
    this.loadCapabilities();
    await this.loadMCPServers();
    logger.info(
      { providers: [...this.providers.keys()], roles: [...this.roleCapabilities.keys()] },
      'Armory initialized',
    );
  }

  registerProvider(provider: ToolProvider): void {
    this.providers.set(provider.name, provider);
    logger.info({ provider: provider.name }, 'Tool provider registered');
  }

  getToolsForRole(role: AgentRole): LLMTool[] {
    const cap = this.roleCapabilities.get(role);
    if (!cap || cap.providers.length === 0) return [];

    const tools: LLMTool[] = [];
    for (const providerName of cap.providers) {
      const provider = this.providers.get(providerName);
      if (provider && provider.isAvailable()) {
        tools.push(...provider.listTools());
      }
    }

    if (cap.tools_filter && cap.tools_filter.length > 0) {
      const allowed = new Set(cap.tools_filter);
      return tools.filter((t) => allowed.has(t.name));
    }

    return tools;
  }

  getToolNamesForRole(role: AgentRole): string[] {
    return this.getToolsForRole(role).map((t) => t.name);
  }

  async execute(block: ToolUseBlock, context: ToolContext): Promise<ToolResultBlock> {
    const provider = this.findProviderForTool(block.name, context.role);

    if (!provider) {
      return {
        type: 'tool_result',
        tool_use_id: block.id,
        content: `Tool not available: ${block.name}`,
        is_error: true,
      };
    }

    if (!provider.isAvailable()) {
      return {
        type: 'tool_result',
        tool_use_id: block.id,
        content: `Tool provider "${provider.name}" is temporarily unavailable`,
        is_error: true,
      };
    }

    try {
      return await provider.execute(block, context);
    } catch (err) {
      return {
        type: 'tool_result',
        tool_use_id: block.id,
        content: `Tool execution error: ${err instanceof Error ? err.message : String(err)}`,
        is_error: true,
      };
    }
  }

  async shutdown(): Promise<void> {
    logger.info('Armory shutting down');
    for (const mcp of this.mcpProviders) {
      await mcp.shutdown();
    }
  }

  getProjectDir(): string {
    return this.projectDir;
  }

  // ─── Private ──────────────────────────────────────────────

  private findProviderForTool(toolName: string, role: AgentRole): ToolProvider | null {
    const cap = this.roleCapabilities.get(role);
    if (!cap) return null;

    if (cap.tools_filter && cap.tools_filter.length > 0 && !cap.tools_filter.includes(toolName)) {
      return null;
    }

    for (const providerName of cap.providers) {
      const provider = this.providers.get(providerName);
      if (!provider) continue;

      const providerTools = provider.listTools();
      if (providerTools.some((t) => t.name === toolName)) {
        return provider;
      }
    }

    return null;
  }

  private loadCapabilities(): void {
    const roles: AgentRole[] = ['adjutant', 'chief_of_staff', 'operations', 'inspector', 'engineer'];

    for (const role of roles) {
      const capPath = path.join(SOULS_DIR, `${role}.capabilities.json`);
      try {
        const raw = fs.readFileSync(capPath, 'utf-8');
        const cap = JSON.parse(raw) as RoleCapability;
        this.roleCapabilities.set(role, cap);
      } catch {
        this.roleCapabilities.set(role, { providers: [] });
        logger.debug({ role, path: capPath }, 'No capabilities file found, role has no tools');
      }
    }
  }

  private async loadMCPServers(): Promise<void> {
    const configPath = path.join(this.projectDir, 'armory.json');
    let config: ArmoryConfig;

    try {
      const raw = fs.readFileSync(configPath, 'utf-8');
      config = JSON.parse(raw) as ArmoryConfig;
    } catch {
      logger.debug({ path: configPath }, 'No armory.json found, skipping MCP servers');
      return;
    }

    if (!Array.isArray(config.mcp_servers)) {
      logger.debug('armory.json has no mcp_servers array, skipping');
      return;
    }

    for (const serverConfig of config.mcp_servers) {
      // Resolve "." in args to projectDir (absolute path)
      const resolvedConfig = {
        ...serverConfig,
        args: serverConfig.args.map((a) => (a === '.' ? this.projectDir : a)),
      };

      const breaker = new CircuitBreaker(
        CIRCUIT_BREAKER_FAILURE_THRESHOLD,
        CIRCUIT_BREAKER_RESET_TIMEOUT_MS,
        CIRCUIT_BREAKER_HALF_OPEN_MAX,
      );

      const provider = new MCPToolProvider(resolvedConfig, breaker);

      try {
        await provider.connect();
        this.mcpProviders.push(provider);
        this.registerProvider(provider);
      } catch (err) {
        logger.error(
          { server: serverConfig.name, error: err instanceof Error ? err.message : String(err) },
          'Failed to connect MCP server, skipping',
        );
      }
    }
  }
}
