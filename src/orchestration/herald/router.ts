import {
  TaskState,
  AgentRole,
} from '../../types.js';
import type { Task, TaskTemplate } from '../../types.js';

/**
 * Route a task to the responsible agent based on its current state.
 * All routing is code-driven — no LLM decisions.
 */
export function routeTask(task: Task): AgentRole {
  switch (task.state) {
    case TaskState.RECEIVED:
      return AgentRole.ADJUTANT;
    case TaskState.PLANNING:
      return AgentRole.CHIEF_OF_STAFF;
    case TaskState.GATE1_REVIEW:
      return AgentRole.INSPECTOR;
    case TaskState.DISPATCHING:
      return AgentRole.OPERATIONS;
    case TaskState.EXECUTING:
      return AgentRole.ENGINEER;
    case TaskState.COLLECTING:
      return AgentRole.OPERATIONS;
    case TaskState.GATE2_REVIEW:
      return AgentRole.INSPECTOR;
    case TaskState.DELIVERING:
      return AgentRole.ADJUTANT;
    default:
      throw new Error(`No route for state: ${task.state}`);
  }
}

/**
 * Match a task description against a list of templates.
 * Returns the first matching template, or null if none match.
 */
export function matchTemplate(
  description: string,
  templates: TaskTemplate[],
): TaskTemplate | null {
  for (const template of templates) {
    try {
      const regex = new RegExp(template.pattern, 'i');
      if (regex.test(description)) {
        return template;
      }
    } catch {
      // Invalid regex pattern in template — skip
      continue;
    }
  }
  return null;
}

/**
 * Determine if a task should skip the planning phase (fast path).
 * Returns true if the task matches a template with skip_planning=true.
 */
export function shouldSkipPlanning(
  task: Task,
  templates: TaskTemplate[],
): boolean {
  const template = matchTemplate(task.description, templates);
  if (!template) return false;
  return template.skip_planning;
}
