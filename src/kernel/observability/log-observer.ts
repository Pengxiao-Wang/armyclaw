// ArmyClaw — Log Observer (structured logging via pino)

import { logger } from '../../logger.js';
import type { Observer, ObserverEvent, ObserverMetric } from '../../types.js';

export class LogObserver implements Observer {
  name = 'log';

  recordEvent(event: ObserverEvent): void {
    switch (event.type) {
      case 'agent_start':
        logger.info({ role: event.role, model: event.model }, 'agent.start');
        break;
      case 'llm_request':
        logger.debug({ model: event.model, messages: event.messageCount }, 'llm.request');
        break;
      case 'llm_response':
        if (event.success) {
          logger.info({ model: event.model, durationMs: event.durationMs }, 'llm.response');
        } else {
          logger.error({ model: event.model, durationMs: event.durationMs, error: event.error }, 'llm.response.error');
        }
        break;
      case 'tool_call':
        logger.info({ tool: event.tool, durationMs: event.durationMs, success: event.success }, 'tool.call');
        break;
      case 'task_transition':
        logger.info({ taskId: event.taskId, from: event.from, to: event.to }, 'task.transition');
        break;
      case 'heartbeat_tick':
        logger.debug('heartbeat.tick');
        break;
      case 'error':
        logger.error({ component: event.component, message: event.message }, 'system.error');
        break;
    }
  }

  recordMetric(metric: ObserverMetric): void {
    logger.debug({ metric: metric.type, value: 'ms' in metric ? metric.ms : 'count' in metric ? metric.count : null }, 'metric');
  }

  flush(): void {
    // pino flushes synchronously, nothing to do
  }
}
