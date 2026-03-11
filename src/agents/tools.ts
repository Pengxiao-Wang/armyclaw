import type { AgentRole, LLMTool } from '../types.js';

// ─── LLM Tool Definitions ────────────────────────────────────
// These are sent to the LLM so it knows HOW to call each tool.

const ALL_TOOLS: LLMTool[] = [
  {
    name: 'file_read',
    description: 'Read the contents of a file. Returns numbered lines. Use offset/limit for large files.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path relative to working directory' },
        offset: { type: 'number', description: 'Line offset (0-based). Optional.' },
        limit: { type: 'number', description: 'Max lines to return. Optional.' },
      },
      required: ['path'],
    },
  },
  {
    name: 'file_write',
    description: 'Write content to a file. Creates parent directories if needed. Overwrites existing files.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path relative to working directory' },
        content: { type: 'string', description: 'Full file content to write' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'file_list',
    description: 'List files and directories at a given path.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory path relative to working directory. Defaults to "."' },
      },
      required: [],
    },
  },
  {
    name: 'search',
    description: 'Search for a text pattern in files using grep. Returns matching lines with file paths and line numbers.',
    input_schema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Text or regex pattern to search for' },
        path: { type: 'string', description: 'Directory to search in. Defaults to "."' },
        glob: { type: 'string', description: 'File glob filter, e.g. "*.ts". Optional.' },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'code_execute',
    description: 'Execute a shell command in the working directory. Use for running scripts, installing packages, etc.',
    input_schema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Shell command to execute' },
        timeout_ms: { type: 'number', description: 'Timeout in ms (max 30000). Optional.' },
      },
      required: ['command'],
    },
  },
  {
    name: 'test_run',
    description: 'Run tests. Defaults to "npm test" if no command specified.',
    input_schema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Test command. Defaults to "npm test".' },
      },
      required: [],
    },
  },
  {
    name: 'claude_code',
    description: 'Delegate a coding task to Claude Code (an AI coding agent). Use this as your PRIMARY tool for all code work: implementing features, fixing bugs, refactoring, writing tests, debugging. Claude Code has its own tools (Read, Write, Edit, Bash, Grep, Glob) and works autonomously in the working directory. Give it clear, specific instructions.',
    input_schema: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description: 'Detailed instructions for Claude Code. Include: what to do, which files to touch, expected behavior, and any constraints.',
        },
      },
      required: ['prompt'],
    },
  },
];

// ─── Tool Permission Matrix ────────────────────────────────────

const TOOL_PERMISSIONS: Record<AgentRole, { allowed: string[]; denied: string[] }> = {
  adjutant: {
    allowed: [],
    denied: ['search', 'file_read', 'file_write', 'file_list', 'code_execute', 'test_run'],
  },
  chief_of_staff: {
    allowed: ['search', 'file_read', 'file_list'],
    denied: ['file_write', 'code_execute'],
  },
  operations: {
    allowed: [],
    denied: ['search', 'file_read', 'file_write', 'file_list', 'code_execute', 'test_run'],
  },
  inspector: {
    allowed: ['file_read', 'file_list', 'test_run'],
    denied: ['file_write'],
  },
  engineer: {
    allowed: ['claude_code', 'search', 'file_read', 'file_write', 'file_list', 'code_execute', 'test_run'],
    denied: [],
  },
};

/**
 * Get the list of allowed tool names for a given agent role.
 */
export function getToolsForRole(role: AgentRole): string[] {
  const perms = TOOL_PERMISSIONS[role];
  if (!perms) return [];
  return [...perms.allowed];
}

/**
 * Get actual LLMTool definitions for a role (sent to the LLM API).
 * Only returns tools the role is permitted to use.
 */
export function getLLMToolsForRole(role: AgentRole): LLMTool[] {
  const allowed = getToolsForRole(role);
  if (allowed.length === 0) return [];
  return ALL_TOOLS.filter((t) => allowed.includes(t.name));
}

/**
 * Check whether a specific tool is allowed for a given agent role.
 */
export function isToolAllowed(role: AgentRole, tool: string): boolean {
  const perms = TOOL_PERMISSIONS[role];
  if (!perms) return false;
  if (perms.denied.includes(tool)) return false;
  if (perms.allowed.includes(tool)) return true;
  if (perms.allowed.length > 0) return false;
  return true;
}

/**
 * Filter a list of LLM tools based on the agent role's permissions.
 */
export function filterTools(role: AgentRole, requestedTools: LLMTool[]): LLMTool[] {
  return requestedTools.filter((tool) => isToolAllowed(role, tool.name));
}
