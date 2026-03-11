// ═══════════════════════════════════════════════════════════
// ArmyClaw — War Room HTTP Server (Process 2)
// Standalone process serving the Sand Table dashboard
// Uses Node.js built-in http module (no express dependency)
// ═══════════════════════════════════════════════════════════

import http from 'http';

import { WAR_ROOM_PORT } from '../config.js';
import { logger } from '../logger.js';
import { createApi } from './api.js';
import { DbWatcher } from './watcher.js';

export function startWarRoom(): void {
  const watcher = new DbWatcher();
  watcher.start();

  const api = createApi(watcher);
  const server = http.createServer(api);

  // Graceful shutdown
  const shutdown = () => {
    logger.info('War Room shutting down...');
    watcher.stop();
    server.close(() => {
      logger.info('War Room server closed');
      process.exit(0);
    });
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  server.listen(WAR_ROOM_PORT, () => {
    logger.info(
      { port: WAR_ROOM_PORT, url: `http://localhost:${WAR_ROOM_PORT}` },
      'War Room (Sand Table 沙盘) listening',
    );
  });
}

// Run directly
startWarRoom();
