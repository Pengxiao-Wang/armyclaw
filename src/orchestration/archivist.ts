// ArmyClaw — Archivist (档案员)
// Manages long-term memory: archive results, recall experience, compress context

import { logger } from '../logger.js';
import { CONTEXT_ARCHIVE_THRESHOLD } from '../config.js';
import { storeDocument } from '../kernel/memory/store.js';
import { hybridSearch } from '../kernel/memory/search.js';
import type { Task, AgentRole, SearchResult } from '../types.js';

export class Archivist {
  /**
   * Archive a task result into long-term memory.
   * Called when a task reaches terminal state (DONE or FAILED).
   */
  async archiveTaskResult(task: Task): Promise<void> {
    if (!task.context_chain) return;

    let chain: { role: string; output: string }[];
    try { chain = JSON.parse(task.context_chain); } catch { return; }
    if (chain.length === 0) return;

    // Build a summary from the context chain
    const summary = chain
      .map(e => `[${e.role}] ${e.output.slice(0, 1000)}`)
      .join('\n\n');

    const source = task.state === 'DONE' ? 'task_result' as const : 'task_failure' as const;
    const path = `tasks/${task.id}`;

    try {
      await storeDocument(source, path, `# Task: ${task.description}\n\n${summary}`);
      logger.info({ taskId: task.id, source }, 'Archivist: task archived');
    } catch (err) {
      logger.warn({ taskId: task.id, error: String(err) }, 'Archivist: archive failed (non-fatal)');
    }
  }

  /**
   * Archive an inspector rejection for future reference.
   * Helps avoid repeating the same mistakes.
   */
  async archiveRejection(task: Task, findings: string[]): Promise<void> {
    if (findings.length === 0) return;

    const content = [
      `# Inspector Rejection: ${task.description}`,
      '',
      '## Findings',
      ...findings.map((f, i) => `${i + 1}. ${f}`),
      '',
      `## Task State: ${task.state}`,
      `## Reject Counts: tactical=${task.reject_count_tactical}, strategic=${task.reject_count_strategic}`,
    ].join('\n');

    try {
      await storeDocument('inspector_reject', `rejections/${task.id}`, content);
      logger.info({ taskId: task.id }, 'Archivist: rejection archived');
    } catch (err) {
      logger.warn({ error: String(err) }, 'Archivist: rejection archive failed');
    }
  }

  /**
   * Recall relevant historical context for an agent about to run.
   * Returns formatted context string to inject into agent's prompt.
   */
  async recall(query: string, role: AgentRole): Promise<string | null> {
    try {
      const results = await hybridSearch(query);
      if (results.length === 0) return null;

      const sections = results.map((r, i) =>
        `### Reference ${i + 1} (relevance: ${(r.score * 100).toFixed(0)}%)\n${r.content}`
      );

      return [
        '## Historical Context (from Archivist)',
        `The following ${results.length} references may be relevant:`,
        '',
        ...sections,
      ].join('\n');
    } catch (err) {
      logger.debug({ error: String(err) }, 'Archivist: recall failed (non-fatal)');
      return null;
    }
  }

  /**
   * Archive old conversation turns from adjutant's context.
   * Returns a short summary to replace the archived turns.
   */
  async archiveContext(
    turns: string[],
    taskId: string,
  ): Promise<string> {
    const content = turns.join('\n\n---\n\n');

    try {
      await storeDocument('context_archive', `context/${taskId}`, content);
    } catch (err) {
      logger.warn({ error: String(err) }, 'Archivist: context archive failed');
    }

    // Return a minimal summary pointer
    return `[Earlier conversation archived — ${turns.length} turns stored in memory. Use recall to retrieve if needed.]`;
  }
}
