import { describe, it, expect, beforeEach } from 'vitest';
import { TaskQueue, QueuePriority } from '../src/orchestration/herald/queue.js';

let queue: TaskQueue;

beforeEach(() => {
  queue = new TaskQueue(3); // max 3 concurrent
});

describe('enqueue and dequeue', () => {
  it('should enqueue and dequeue a task', () => {
    queue.enqueue('task-1', QueuePriority.NEW_TASK);
    const taskId = queue.dequeue();
    expect(taskId).toBe('task-1');
  });

  it('should return null when queue is empty', () => {
    expect(queue.dequeue()).toBeNull();
  });

  it('should ignore duplicate enqueues', () => {
    queue.enqueue('task-1', QueuePriority.NEW_TASK);
    queue.enqueue('task-1', QueuePriority.NEW_TASK);
    expect(queue.getQueueLength()).toBe(1);
  });

  it('should ignore enqueue of active task', () => {
    queue.enqueue('task-1', QueuePriority.NEW_TASK);
    queue.dequeue(); // task-1 now active
    queue.enqueue('task-1', QueuePriority.NEW_TASK); // should be ignored
    expect(queue.getQueueLength()).toBe(0);
    expect(queue.isActive('task-1')).toBe(true);
  });
});

describe('priority ordering', () => {
  it('should dequeue gate reviews before executing tasks', () => {
    queue.enqueue('new-1', QueuePriority.NEW_TASK);
    queue.enqueue('exec-1', QueuePriority.EXECUTING);
    queue.enqueue('gate-1', QueuePriority.GATE_REVIEW);

    expect(queue.dequeue()).toBe('gate-1');
    expect(queue.dequeue()).toBe('exec-1');
    expect(queue.dequeue()).toBe('new-1');
  });

  it('should maintain FIFO within same priority', () => {
    queue.enqueue('a', QueuePriority.NEW_TASK);
    queue.enqueue('b', QueuePriority.NEW_TASK);
    queue.enqueue('c', QueuePriority.NEW_TASK);

    expect(queue.dequeue()).toBe('a');
    expect(queue.dequeue()).toBe('b');
    expect(queue.dequeue()).toBe('c');
  });

  it('should interleave priorities correctly', () => {
    queue.enqueue('new-1', QueuePriority.NEW_TASK);
    queue.enqueue('gate-1', QueuePriority.GATE_REVIEW);
    queue.enqueue('new-2', QueuePriority.NEW_TASK);
    queue.enqueue('exec-1', QueuePriority.EXECUTING);
    queue.enqueue('gate-2', QueuePriority.GATE_REVIEW);

    // Gate reviews first, then executing, then new tasks
    expect(queue.dequeue()).toBe('gate-1');
    expect(queue.dequeue()).toBe('gate-2');
    expect(queue.dequeue()).toBe('exec-1');
    // Now at concurrency limit (3), can't dequeue more
    expect(queue.dequeue()).toBeNull();
  });
});

describe('concurrency limits', () => {
  it('should respect max concurrent limit', () => {
    queue.enqueue('task-1', QueuePriority.NEW_TASK);
    queue.enqueue('task-2', QueuePriority.NEW_TASK);
    queue.enqueue('task-3', QueuePriority.NEW_TASK);
    queue.enqueue('task-4', QueuePriority.NEW_TASK);

    expect(queue.dequeue()).toBe('task-1');
    expect(queue.dequeue()).toBe('task-2');
    expect(queue.dequeue()).toBe('task-3');
    expect(queue.dequeue()).toBeNull(); // at limit
    expect(queue.getActiveCount()).toBe(3);
  });

  it('should allow dequeue after completing a task', () => {
    queue.enqueue('task-1', QueuePriority.NEW_TASK);
    queue.enqueue('task-2', QueuePriority.NEW_TASK);
    queue.enqueue('task-3', QueuePriority.NEW_TASK);
    queue.enqueue('task-4', QueuePriority.NEW_TASK);

    queue.dequeue(); // task-1
    queue.dequeue(); // task-2
    queue.dequeue(); // task-3
    expect(queue.dequeue()).toBeNull(); // at limit

    queue.complete('task-1');
    expect(queue.getActiveCount()).toBe(2);

    expect(queue.dequeue()).toBe('task-4');
    expect(queue.getActiveCount()).toBe(3);
  });
});

describe('complete', () => {
  it('should remove task from active set', () => {
    queue.enqueue('task-1', QueuePriority.NEW_TASK);
    queue.dequeue();
    expect(queue.isActive('task-1')).toBe(true);

    queue.complete('task-1');
    expect(queue.isActive('task-1')).toBe(false);
    expect(queue.getActiveCount()).toBe(0);
  });

  it('should be idempotent', () => {
    queue.enqueue('task-1', QueuePriority.NEW_TASK);
    queue.dequeue();

    queue.complete('task-1');
    queue.complete('task-1');
    expect(queue.getActiveCount()).toBe(0);
  });
});

describe('shutdown', () => {
  it('should prevent new enqueues after shutdown', () => {
    queue.shutdown();
    queue.enqueue('task-1', QueuePriority.NEW_TASK);
    expect(queue.getQueueLength()).toBe(0);
  });

  it('should prevent dequeues after shutdown', () => {
    queue.enqueue('task-1', QueuePriority.NEW_TASK);
    queue.shutdown();
    expect(queue.dequeue()).toBeNull();
  });

  it('should clear the queue on shutdown', () => {
    queue.enqueue('task-1', QueuePriority.NEW_TASK);
    queue.enqueue('task-2', QueuePriority.NEW_TASK);
    queue.shutdown();
    expect(queue.getQueueLength()).toBe(0);
  });
});

describe('getters', () => {
  it('should track queue length', () => {
    expect(queue.getQueueLength()).toBe(0);
    queue.enqueue('a', QueuePriority.NEW_TASK);
    expect(queue.getQueueLength()).toBe(1);
    queue.enqueue('b', QueuePriority.NEW_TASK);
    expect(queue.getQueueLength()).toBe(2);
    queue.dequeue();
    expect(queue.getQueueLength()).toBe(1);
  });

  it('should track active count', () => {
    expect(queue.getActiveCount()).toBe(0);
    queue.enqueue('a', QueuePriority.NEW_TASK);
    queue.dequeue();
    expect(queue.getActiveCount()).toBe(1);
    queue.complete('a');
    expect(queue.getActiveCount()).toBe(0);
  });

  it('should check if task is active', () => {
    queue.enqueue('a', QueuePriority.NEW_TASK);
    expect(queue.isActive('a')).toBe(false);
    queue.dequeue();
    expect(queue.isActive('a')).toBe(true);
  });
});
