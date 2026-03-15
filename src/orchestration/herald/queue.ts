import { MAX_CONCURRENT_ENGINEERS } from '../../config.js';
import { logger } from '../../logger.js';

// ─── Priority Levels ────────────────────────────────────────────

export const QueuePriority = {
  GATE_REVIEW: 0,   // Highest: gate reviews unblock work
  EXECUTING: 1,     // In-flight work
  NEW_TASK: 2,      // Lowest: new work
} as const;
export type QueuePriority = (typeof QueuePriority)[keyof typeof QueuePriority];

// ─── Queue Item ─────────────────────────────────────────────────

interface QueueItem {
  taskId: string;
  priority: QueuePriority;
  enqueuedAt: number;
}

// ─── Task Queue ─────────────────────────────────────────────────

export class TaskQueue {
  private queue: QueueItem[] = [];
  private active = new Set<string>();
  private maxConcurrent: number;
  private shuttingDown = false;

  constructor(maxConcurrent?: number) {
    this.maxConcurrent = maxConcurrent ?? MAX_CONCURRENT_ENGINEERS;
  }

  /**
   * Add a task to the priority queue.
   * Duplicates (same taskId) are silently ignored.
   */
  enqueue(taskId: string, priority: QueuePriority): void {
    if (this.shuttingDown) return;

    // Skip if already queued or active
    if (this.active.has(taskId)) return;
    if (this.queue.some((item) => item.taskId === taskId)) return;

    this.queue.push({ taskId, priority, enqueuedAt: Date.now() });

    // Sort by priority (lower = higher priority), then by enqueue time (FIFO within same priority)
    this.queue.sort((a, b) => {
      if (a.priority !== b.priority) return a.priority - b.priority;
      return a.enqueuedAt - b.enqueuedAt;
    });

    logger.debug(
      { taskId, priority, queueLength: this.queue.length },
      'Task enqueued',
    );
  }

  /**
   * Dequeue the highest-priority task, if concurrency allows.
   * Returns null if no tasks available or at concurrency limit.
   */
  dequeue(): string | null {
    if (this.shuttingDown) return null;
    if (this.active.size >= this.maxConcurrent) return null;
    if (this.queue.length === 0) return null;

    const item = this.queue.shift()!;
    this.active.add(item.taskId);

    logger.debug(
      { taskId: item.taskId, activeCount: this.active.size, remaining: this.queue.length },
      'Task dequeued',
    );

    return item.taskId;
  }

  /**
   * Mark a task as completed (no longer active).
   */
  complete(taskId: string): void {
    this.active.delete(taskId);
    logger.debug(
      { taskId, activeCount: this.active.size },
      'Task completed',
    );
  }

  /**
   * Get the number of currently active (dequeued, not yet completed) tasks.
   */
  getActiveCount(): number {
    return this.active.size;
  }

  /**
   * Get the number of tasks waiting in the queue.
   */
  getQueueLength(): number {
    return this.queue.length;
  }

  /**
   * Check if a task is currently active.
   */
  isActive(taskId: string): boolean {
    return this.active.has(taskId);
  }

  /**
   * Shut down the queue. No more enqueues or dequeues will be processed.
   */
  shutdown(): void {
    this.shuttingDown = true;
    logger.info(
      { activeCount: this.active.size, queued: this.queue.length },
      'TaskQueue shutting down',
    );
    this.queue = [];
  }
}
