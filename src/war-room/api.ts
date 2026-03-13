// ═══════════════════════════════════════════════════════════
// ArmyClaw — War Room REST API
// Serves Sand Table dashboard and data endpoints
// ═══════════════════════════════════════════════════════════

import http from 'http';

import { logger } from '../logger.js';
import type { DbWatcher } from './watcher.js';

// ─── API Factory ────────────────────────────────────────────

export function createApi(watcher: DbWatcher): http.RequestListener {
  return async (req, res) => {
    // CORS + no-cache headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Cache-Control', 'no-store');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url ?? '/', `http://localhost`);

    try {
      switch (url.pathname) {
        case '/api/tasks': {
          res.setHeader('Content-Type', 'application/json');
          const tasks = watcher.getTasksSnapshot();
          res.writeHead(200);
          res.end(JSON.stringify(tasks));
          return;
        }

        case '/api/tasks/active': {
          res.setHeader('Content-Type', 'application/json');
          const tasks = watcher.getActiveTasksSnapshot();
          res.writeHead(200);
          res.end(JSON.stringify(tasks));
          return;
        }

        case '/api/flow-log': {
          res.setHeader('Content-Type', 'application/json');
          const taskId = url.searchParams.get('task_id');
          if (!taskId) {
            res.writeHead(400);
            res.end(JSON.stringify({ error: 'task_id required' }));
            return;
          }
          const log = watcher.getFlowLogSnapshot(taskId);
          res.writeHead(200);
          res.end(JSON.stringify(log));
          return;
        }

        case '/api/progress': {
          res.setHeader('Content-Type', 'application/json');
          const taskId = url.searchParams.get('task_id');
          if (!taskId) {
            res.writeHead(400);
            res.end(JSON.stringify({ error: 'task_id required' }));
            return;
          }
          const log = watcher.getProgressLogSnapshot(taskId);
          res.writeHead(200);
          res.end(JSON.stringify(log));
          return;
        }

        case '/api/agents': {
          res.setHeader('Content-Type', 'application/json');
          const agents = watcher.getAgentStatus();
          res.writeHead(200);
          res.end(JSON.stringify(agents));
          return;
        }

        case '/api/agents/config': {
          res.setHeader('Content-Type', 'application/json');
          if (req.method === 'GET') {
            const configs = watcher.getAgentConfigs();
            res.writeHead(200);
            res.end(JSON.stringify(configs));
            return;
          }
          if (req.method === 'POST') {
            // Hot-switch agent model config
            // Body: { role, model, provider, temperature, max_tokens }
            const body = await readBody(req);
            try {
              const config = JSON.parse(body);
              const { role, model, provider, temperature, max_tokens } = config;
              if (!role || !model || !provider || temperature == null || max_tokens == null) {
                res.writeHead(400);
                res.end(JSON.stringify({ error: 'Missing required fields: role, model, provider, temperature, max_tokens' }));
                return;
              }
              watcher.setAgentConfigWrite({ role, model, provider, temperature, max_tokens, updated_at: '' });
              const saved = { role, model, provider, temperature, max_tokens };
              res.writeHead(200);
              res.end(JSON.stringify({ status: 'saved', config: saved }));
            } catch (err) {
              if (err instanceof SyntaxError) {
                res.writeHead(400);
                res.end(JSON.stringify({ error: 'Invalid JSON body' }));
              } else {
                res.writeHead(500);
                res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'Internal error' }));
              }
            }
            return;
          }
          res.writeHead(405);
          res.end(JSON.stringify({ error: 'Method not allowed' }));
          return;
        }

        case '/api/costs': {
          res.setHeader('Content-Type', 'application/json');
          const summary = watcher.getCostSummary();
          res.writeHead(200);
          res.end(JSON.stringify(summary));
          return;
        }

        case '/api/costs/daily': {
          res.setHeader('Content-Type', 'application/json');
          const summary = watcher.getCostSummary();
          res.writeHead(200);
          res.end(JSON.stringify({ daily_total: summary.daily_total }));
          return;
        }

        case '/api/arsenal': {
          res.setHeader('Content-Type', 'application/json');
          res.writeHead(200);
          res.end(JSON.stringify(watcher.getArsenalStats()));
          return;
        }

        case '/api/herald': {
          res.setHeader('Content-Type', 'application/json');
          res.writeHead(200);
          res.end(JSON.stringify(watcher.getHeraldStats()));
          return;
        }

        case '/api/medic': {
          res.setHeader('Content-Type', 'application/json');
          res.writeHead(200);
          res.end(JSON.stringify(watcher.getMedicStats()));
          return;
        }

        case '/api/debug/flow': {
          res.setHeader('Content-Type', 'application/json');
          res.writeHead(200);
          res.end(JSON.stringify(watcher.getRecentFlowLog(100)));
          return;
        }

        case '/api/debug/runs': {
          res.setHeader('Content-Type', 'application/json');
          res.writeHead(200);
          res.end(JSON.stringify(watcher.getRecentAgentRuns(50)));
          return;
        }

        case '/api/health': {
          res.setHeader('Content-Type', 'application/json');
          const health = watcher.getHealthStatus();
          res.writeHead(200);
          res.end(JSON.stringify(health));
          return;
        }

        case '/api/tasks/control': {
          res.setHeader('Content-Type', 'application/json');
          if (req.method !== 'POST') {
            res.writeHead(405);
            res.end(JSON.stringify({ error: 'Method not allowed' }));
            return;
          }
          const body = await readBody(req);
          try {
            const { task_id, action } = JSON.parse(body);
            if (!task_id || !action) {
              res.writeHead(400);
              res.end(JSON.stringify({ error: 'task_id and action required' }));
              return;
            }
            if (!['pause', 'cancel', 'resume'].includes(action)) {
              res.writeHead(400);
              res.end(JSON.stringify({ error: 'action must be pause, cancel, or resume' }));
              return;
            }
            try {
              const result = watcher.controlTask(task_id, action);
              res.writeHead(200);
              res.end(JSON.stringify({ status: 'applied', ...result }));
            } catch (controlErr) {
              res.writeHead(500);
              res.end(JSON.stringify({ error: controlErr instanceof Error ? controlErr.message : 'Control action failed' }));
            }
          } catch {
            res.writeHead(400);
            res.end(JSON.stringify({ error: 'Invalid JSON body' }));
          }
          return;
        }

        default: {
          // Serve static HTML for the Sand Table dashboard
          if (url.pathname === '/' || url.pathname === '/index.html') {
            res.setHeader('Content-Type', 'text/html');
            res.setHeader('Cache-Control', 'no-store');
            res.writeHead(200);
            res.end(getSandTableHTML());
            return;
          }
          res.setHeader('Content-Type', 'application/json');
          res.writeHead(404);
          res.end(JSON.stringify({ error: 'not found' }));
        }
      }
    } catch (err) {
      logger.error(
        { path: url.pathname, error: err instanceof Error ? err.message : String(err) },
        'API error',
      );
      res.setHeader('Content-Type', 'application/json');
      res.writeHead(500);
      res.end(JSON.stringify({ error: 'internal server error' }));
    }
  };
}

// ─── Helpers ────────────────────────────────────────────────

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
    req.on('error', reject);
  });
}

// ─── Sand Table Dashboard HTML ──────────────────────────────

function getSandTableHTML(): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title id="page-title">ArmyClaw - Sand Table (沙盘)</title>
<style>
  :root {
    --bg-0: #000000;
    --bg-1: #1d1d1f;
    --bg-2: #2d2d2f;
    --bg-3: #3a3a3c;
    --text-1: #f5f5f7;
    --text-2: #a1a1a6;
    --text-3: #6e6e73;
    --blue: #2997ff;
    --green: #30d158;
    --red: #ff453a;
    --orange: #ff9f0a;
    --yellow: #ffd60a;
    --purple: #bf5af2;
    --teal: #64d2ff;
    --r: 12px;
    --r-sm: 8px;
  }

  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    background: var(--bg-0);
    color: var(--text-2);
    font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Display', 'SF Pro Text', 'Helvetica Neue', Arial, sans-serif;
    font-size: 14px;
    line-height: 1.47059;
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
  }

  /* ── Header ─────────────────────────────── */
  header {
    background: rgba(29,29,31,0.72);
    backdrop-filter: saturate(180%) blur(20px); -webkit-backdrop-filter: saturate(180%) blur(20px);
    border-bottom: 1px solid rgba(255,255,255,0.08);
    padding: 0 48px; height: 52px;
    display: flex; justify-content: space-between; align-items: center;
    position: sticky; top: 0; z-index: 50;
  }
  header h1 {
    font-size: 21px; font-weight: 600; color: var(--text-1);
    letter-spacing: -0.01em;
  }
  header h1 span { color: var(--text-3); font-weight: 400; font-size: 17px; }
  .header-status { display: flex; gap: 20px; align-items: center; font-size: 13px; color: var(--text-3); }
  .lang-btn {
    background: transparent; border: none; color: var(--blue);
    font-size: 14px; padding: 6px 12px; cursor: pointer;
    font-family: inherit; font-weight: 400; transition: opacity 0.15s;
  }
  .lang-btn:hover { opacity: 0.7; }
  .status-dot {
    width: 8px; height: 8px; border-radius: 50%;
    display: inline-block; margin-right: 6px;
  }
  .dot-green  { background: var(--green); }
  .dot-yellow { background: var(--orange); }
  .dot-red    { background: var(--red); }

  /* ── Grid Layout ────────────────────────── */
  .grid {
    display: grid; grid-template-columns: 1fr 1fr;
    gap: 20px; padding: 32px 48px;
    max-width: 1440px; margin: 0 auto;
  }
  .panel {
    background: var(--bg-1);
    border-radius: var(--r);
    overflow: hidden;
  }
  .panel-header {
    padding: 20px 24px 0;
    display: flex; justify-content: space-between; align-items: center;
  }
  .panel-header h2 {
    font-size: 20px; font-weight: 600; color: var(--text-1);
    letter-spacing: -0.01em;
  }
  .panel-body { padding: 16px 24px 24px; max-height: 480px; overflow-y: auto; }
  .panel-body::-webkit-scrollbar { width: 0; }
  .full-width { grid-column: 1 / -1; }

  /* ── Pipeline Columns ──────────────────── */
  .pipeline { display: flex; gap: 12px; overflow-x: auto; padding-bottom: 4px; }
  .pipeline::-webkit-scrollbar { height: 0; }
  .pipeline-col { min-width: 155px; flex-shrink: 0; }
  .pipeline-col-header {
    font-size: 12px; font-weight: 500; color: var(--text-3); text-align: center;
    padding: 8px 0; margin-bottom: 8px;
  }

  /* ── Task Cards ─────────────────────────── */
  .task-card {
    background: var(--bg-2); border-radius: var(--r-sm);
    padding: 12px 14px; margin-bottom: 8px; cursor: pointer;
    transition: transform 0.2s ease, box-shadow 0.2s ease;
  }
  .task-card:hover {
    transform: scale(1.02);
    box-shadow: 0 4px 24px rgba(0,0,0,0.4);
  }
  .task-card .tc-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px; }
  .task-card .tc-id { color: var(--blue); font-weight: 500; font-size: 12px; font-family: 'SF Mono', SFMono-Regular, Menlo, monospace; }
  .task-card .tc-state { font-size: 11px; padding: 2px 8px; border-radius: 5px; font-weight: 500; }
  .task-card .tc-desc {
    color: var(--text-1); font-size: 13px; white-space: nowrap; overflow: hidden;
    text-overflow: ellipsis; max-width: 140px; margin-bottom: 6px; line-height: 1.4;
  }
  .task-card .tc-meta { display: flex; justify-content: space-between; align-items: center; }
  .task-card .tc-priority { font-size: 11px; font-weight: 500; }
  .task-card .tc-agent { font-size: 12px; }
  .priority-urgent { color: var(--red); }
  .priority-high   { color: var(--orange); }
  .priority-medium { color: var(--text-2); }
  .priority-low    { color: var(--text-3); }

  .st-active  { background: rgba(41,151,255,0.16); color: var(--blue); }
  .st-review  { background: rgba(255,159,10,0.16); color: var(--orange); }
  .st-done    { background: rgba(48,209,88,0.16); color: var(--green); }
  .st-fail    { background: rgba(255,69,58,0.16); color: var(--red); }
  .st-paused  { background: rgba(255,255,255,0.06); color: var(--text-3); }

  /* ── Agent Cards ────────────────────────── */
  .agent-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 12px; }
  .agent-card {
    background: var(--bg-2); border-radius: var(--r-sm); padding: 16px;
  }
  .agent-card .agent-name { font-weight: 600; color: var(--text-1); margin-bottom: 8px; font-size: 15px; }
  .agent-card .agent-model { color: var(--text-3); font-size: 12px; margin-bottom: 6px; font-family: 'SF Mono', SFMono-Regular, Menlo, monospace; }
  .agent-card .agent-status { font-size: 13px; color: var(--text-2); }

  /* ── Cost Panel ─────────────────────────── */
  .cost-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  .cost-box {
    background: var(--bg-2); border-radius: var(--r-sm);
    padding: 16px; text-align: center;
  }
  .cost-label { color: var(--text-3); font-size: 12px; font-weight: 500; margin-bottom: 8px; }
  .cost-value { font-size: 28px; font-weight: 700; color: var(--text-1); letter-spacing: -0.02em; font-feature-settings: 'tnum'; }
  .cost-value.warning { color: var(--orange); }
  .cost-value.danger  { color: var(--red); }
  .cost-breakdown { margin-top: 16px; }
  .cost-row {
    display: flex; justify-content: space-between; align-items: center;
    padding: 8px 0; font-size: 13px;
  }
  .cost-row + .cost-row { border-top: 1px solid rgba(255,255,255,0.06); }
  .cost-row-label { color: var(--text-2); }

  /* ── Infrastructure Panels ──────────────── */
  .infra-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(105px, 1fr)); gap: 10px; margin-bottom: 16px; }
  .infra-stat {
    background: var(--bg-2); border-radius: var(--r-sm);
    padding: 12px 8px; text-align: center;
  }
  .infra-stat .is-label { font-size: 11px; font-weight: 500; color: var(--text-3); margin-bottom: 6px; }
  .infra-stat .is-value { font-size: 24px; font-weight: 700; color: var(--text-1); letter-spacing: -0.02em; font-feature-settings: 'tnum'; }
  .infra-stat .is-value.warning { color: var(--orange); }
  .infra-stat .is-value.danger { color: var(--red); }

  .infra-bar { display: flex; height: 4px; border-radius: 2px; overflow: hidden; margin-bottom: 12px; background: var(--bg-2); }
  .infra-bar span { display: block; height: 100%; }

  .infra-list { font-size: 13px; }
  .infra-list-item {
    padding: 8px 0; display: flex; justify-content: space-between; align-items: center;
  }
  .infra-list-item + .infra-list-item { border-top: 1px solid rgba(255,255,255,0.06); }
  .infra-list-item .il-label { color: var(--text-2); }
  .infra-list-item .il-value { color: var(--text-1); font-weight: 600; font-feature-settings: 'tnum'; }
  .infra-list-item .il-value.ok { color: var(--green); }
  .infra-list-item .il-value.warn { color: var(--orange); }
  .infra-list-item .il-value.crit { color: var(--red); }

  .stall-card {
    background: rgba(255,69,58,0.1); border-radius: var(--r-sm);
    padding: 10px 12px; margin-bottom: 8px; font-size: 13px;
  }
  .stall-card .sc-id { color: var(--orange); font-weight: 600; font-family: 'SF Mono', SFMono-Regular, Menlo, monospace; }
  .stall-card .sc-meta { color: var(--text-3); margin-top: 4px; }

  /* ── Command Post ───────────────────────── */
  .command-section { margin-bottom: 20px; }
  .command-section h3 { font-size: 13px; font-weight: 600; color: var(--text-3); margin-bottom: 12px; }
  .btn {
    background: var(--bg-2); color: var(--text-1); border: none;
    padding: 8px 18px; font-family: inherit; font-size: 13px; font-weight: 500;
    cursor: pointer; border-radius: 980px; margin-right: 8px; margin-bottom: 8px;
    transition: all 0.15s;
  }
  .btn:hover { background: var(--bg-3); }
  .btn-danger { background: rgba(255,69,58,0.12); color: var(--red); }
  .btn-danger:hover { background: rgba(255,69,58,0.24); }
  .btn-warn { background: rgba(255,159,10,0.12); color: var(--orange); }
  .btn-warn:hover { background: rgba(255,159,10,0.24); }
  select, input {
    background: var(--bg-2); color: var(--text-1); border: none;
    padding: 8px 12px; font-family: inherit; font-size: 13px;
    border-radius: var(--r-sm); outline: none;
    transition: box-shadow 0.15s;
  }
  select:focus, input:focus { box-shadow: 0 0 0 3px rgba(41,151,255,0.3); }
  .timestamp { color: var(--text-3); font-size: 12px; }

  /* ── Toast ──────────────────────────────── */
  #toast {
    display: none; position: fixed; bottom: 32px; right: 32px;
    background: var(--bg-2); color: var(--text-1);
    padding: 14px 24px; border-radius: var(--r); font-family: inherit;
    font-size: 14px; z-index: 200;
    box-shadow: 0 8px 40px rgba(0,0,0,0.5);
  }

  /* ══════ MODAL ══════ */
  .modal-overlay {
    display: none; position: fixed; inset: 0;
    background: rgba(0,0,0,0.56); backdrop-filter: blur(20px); -webkit-backdrop-filter: blur(20px);
    z-index: 100;
    justify-content: center; align-items: start;
    padding: 48px 24px; overflow-y: auto;
  }
  .modal-overlay.open { display: flex; }
  .modal {
    background: var(--bg-1); border-radius: 16px;
    width: 100%; max-width: 800px;
    max-height: calc(100vh - 96px); overflow-y: auto;
    box-shadow: 0 0 0 0.5px rgba(255,255,255,0.1), 0 32px 80px rgba(0,0,0,0.6);
  }
  .modal::-webkit-scrollbar { width: 0; }

  .modal-head {
    position: sticky; top: 0; z-index: 10;
    background: rgba(29,29,31,0.8); backdrop-filter: saturate(180%) blur(20px);
    border-bottom: 1px solid rgba(255,255,255,0.08);
    padding: 24px 28px; display: flex;
    justify-content: space-between; align-items: start;
  }
  .modal-head .mh-left { flex: 1; }
  .modal-head .mh-id { color: var(--blue); font-size: 13px; font-weight: 500; margin-bottom: 6px; font-family: 'SF Mono', SFMono-Regular, Menlo, monospace; }
  .modal-head .mh-desc { color: var(--text-1); font-size: 20px; font-weight: 600; line-height: 1.3; letter-spacing: -0.01em; }
  .modal-head .mh-tags { margin-top: 12px; display: flex; gap: 8px; flex-wrap: wrap; }
  .modal-head .mh-tags span { font-size: 11px; font-weight: 500; padding: 3px 10px; border-radius: 6px; }
  .modal-close {
    background: rgba(255,255,255,0.1); border: none; color: var(--text-3);
    width: 28px; height: 28px; border-radius: 50%;
    font-size: 16px; cursor: pointer; display: flex; align-items: center; justify-content: center;
    margin-left: 16px; transition: all 0.15s;
  }
  .modal-close:hover { background: rgba(255,255,255,0.2); color: var(--text-1); }

  .modal-pipeline {
    padding: 24px 28px; border-bottom: 1px solid rgba(255,255,255,0.06); overflow-x: auto;
  }
  .mp-track { display: flex; align-items: center; min-width: max-content; }
  .mp-node { display: flex; flex-direction: column; align-items: center; min-width: 76px; }
  .mp-dot {
    width: 28px; height: 28px; border-radius: 50%;
    display: flex; align-items: center; justify-content: center;
    font-size: 12px; font-weight: 600;
    background: var(--bg-2); color: var(--text-3);
    transition: all 0.3s;
  }
  .mp-dot.done   { background: rgba(48,209,88,0.2); color: var(--green); }
  .mp-dot.active { background: rgba(41,151,255,0.2); color: var(--blue);
    box-shadow: 0 0 0 4px rgba(41,151,255,0.12);
    animation: pulse 2s ease-in-out infinite;
  }
  .mp-dot.fail   { background: rgba(255,69,58,0.2); color: var(--red); }
  .mp-dot.paused { background: var(--bg-2); color: var(--text-3); }
  .mp-label { font-size: 10px; font-weight: 500; color: var(--text-3); margin-top: 6px; white-space: nowrap; text-align: center; }
  .mp-dot.done + .mp-label { color: var(--text-2); }
  .mp-dot.active + .mp-label { color: var(--blue); }
  .mp-agent { font-size: 13px; margin-top: 3px; }
  .mp-arrow { color: var(--bg-3); font-size: 14px; margin: 0 4px; align-self: center; margin-bottom: 24px; }
  .mp-arrow.done { color: var(--green); }

  @keyframes pulse {
    0%, 100% { box-shadow: 0 0 0 4px rgba(41,151,255,0.12); }
    50% { box-shadow: 0 0 0 8px rgba(41,151,255,0.08); }
  }

  .modal-section { padding: 24px 28px; border-bottom: 1px solid rgba(255,255,255,0.06); }
  .modal-section:last-child { border-bottom: none; }
  .ms-title { font-size: 12px; font-weight: 600; color: var(--text-3); margin-bottom: 16px; }

  .info-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
  .info-label { font-size: 12px; font-weight: 400; color: var(--text-3); margin-bottom: 4px; }
  .info-value { font-size: 14px; color: var(--text-1); font-weight: 500; }

  .timeline { position: relative; padding-left: 28px; }
  .timeline::before { content: ''; position: absolute; left: 8px; top: 6px; bottom: 6px; width: 1px; background: rgba(255,255,255,0.06); }
  .tl-entry { position: relative; margin-bottom: 14px; }
  .tl-dot { position: absolute; left: -23px; top: 5px; width: 10px; height: 10px; border-radius: 50%; background: var(--bg-2); }
  .tl-dot.tl-adjutant       { background: rgba(41,151,255,0.5); }
  .tl-dot.tl-chief_of_staff { background: rgba(191,90,242,0.5); }
  .tl-dot.tl-operations     { background: rgba(255,159,10,0.5); }
  .tl-dot.tl-inspector      { background: rgba(100,210,255,0.5); }
  .tl-dot.tl-engineer       { background: rgba(255,214,10,0.5); }
  .tl-time { font-size: 12px; color: var(--text-3); margin-bottom: 2px; font-family: 'SF Mono', SFMono-Regular, Menlo, monospace; font-size: 11px; }
  .tl-content { font-size: 13px; color: var(--text-2); }
  .tl-content .tl-states { color: var(--text-1); font-weight: 500; }
  .tl-content .tl-reason { color: var(--text-3); margin-left: 8px; }
  .tl-content .tl-dur { color: var(--text-3); margin-left: 8px; font-family: 'SF Mono', SFMono-Regular, Menlo, monospace; font-size: 11px; }

  .progress-entry { margin-bottom: 10px; padding: 14px 16px; background: var(--bg-2); border-radius: var(--r-sm); }
  .pe-head { display: flex; justify-content: space-between; margin-bottom: 8px; }
  .pe-agent { font-size: 13px; color: var(--text-2); font-weight: 500; }
  .pe-time  { font-size: 12px; color: var(--text-3); font-family: 'SF Mono', SFMono-Regular, Menlo, monospace; font-size: 11px; }
  .pe-text  { font-size: 14px; color: var(--text-1); line-height: 1.5; white-space: pre-wrap; word-break: break-word; }

  .ctx-entry { margin-bottom: 8px; border-radius: var(--r-sm); overflow: hidden; }
  .ctx-toggle {
    display: flex; align-items: center; gap: 8px; padding: 12px 14px;
    background: var(--bg-2); cursor: pointer; width: 100%; border: none;
    color: var(--text-2); font-size: 13px; font-family: inherit; text-align: left;
    transition: background 0.15s;
  }
  .ctx-toggle:hover { background: var(--bg-3); }
  .ctx-toggle .ctx-role { color: var(--blue); font-weight: 600; }
  .ctx-toggle .ctx-arrow { color: var(--text-3); font-size: 10px; transition: transform 0.2s; }
  .ctx-entry.open .ctx-arrow { transform: rotate(90deg); }
  .ctx-body {
    display: none; padding: 14px; background: rgba(0,0,0,0.3);
    font-size: 13px; color: var(--text-2); line-height: 1.6;
    white-space: pre-wrap; word-break: break-word; max-height: 320px; overflow-y: auto;
  }
  .ctx-entry.open .ctx-body { display: block; }
  .ctx-empty { color: var(--text-3); font-size: 14px; }

  .modal-actions {
    padding: 20px 28px; border-top: 1px solid rgba(255,255,255,0.06);
    display: flex; gap: 10px; flex-wrap: wrap;
    position: sticky; bottom: 0;
    background: rgba(29,29,31,0.8); backdrop-filter: saturate(180%) blur(20px);
  }

  /* ── Debug Panel ──────────────────────── */
  .debug-btn {
    background: transparent; border: 1px solid var(--text-3); color: var(--text-2);
    padding: 4px 12px; border-radius: 980px; font-size: 12px; cursor: pointer;
    font-family: 'SF Mono', SFMono-Regular, Menlo, monospace; letter-spacing: 0.5px;
    transition: all 0.2s;
  }
  .debug-btn:hover { border-color: var(--orange); color: var(--orange); }
  .debug-btn.active { border-color: var(--orange); color: var(--bg-0); background: var(--orange); }

  .debug-overlay {
    display: none; position: fixed; top: 52px; left: 0; right: 0; bottom: 0;
    background: rgba(0,0,0,0.88); backdrop-filter: blur(12px);
    z-index: 40; overflow-y: auto; padding: 16px 32px;
  }
  .debug-overlay.open { display: block; }

  .debug-log {
    font-family: 'SF Mono', SFMono-Regular, Menlo, monospace;
    font-size: 12px; line-height: 1.7;
  }
  .debug-log .log-entry {
    display: flex; gap: 12px; padding: 6px 0;
    border-bottom: 1px solid rgba(255,255,255,0.03);
    align-items: baseline;
  }
  .debug-log .log-entry:hover { background: rgba(255,255,255,0.02); }
  .log-time { color: var(--text-3); white-space: nowrap; min-width: 80px; }
  .log-task { color: var(--blue); min-width: 90px; cursor: pointer; }
  .log-task:hover { text-decoration: underline; }
  .log-agent { min-width: 120px; }
  .log-detail { color: var(--text-2); flex: 1; }
  .log-state { padding: 1px 6px; border-radius: 4px; font-size: 11px; font-weight: 600; }
  .log-arrow { color: var(--text-3); }
  .log-reason { color: var(--text-3); font-style: italic; }
  .log-model { color: var(--text-3); font-size: 11px; }
  .log-tokens { color: var(--purple); font-size: 11px; }
  .log-status-running { color: var(--green); }
  .log-status-success { color: var(--blue); }
  .log-status-error { color: var(--red); }
  .log-empty { color: var(--text-3); padding: 40px 0; text-align: center; }
  .log-type {
    font-size: 10px; font-weight: 600; padding: 1px 6px; border-radius: 4px;
    min-width: 36px; text-align: center; text-transform: uppercase;
  }
  .log-type-flow { background: rgba(41,151,255,0.15); color: var(--blue); }
  .log-type-run  { background: rgba(191,90,242,0.15); color: var(--purple); }
  .log-type-progress { background: rgba(48,209,88,0.15); color: var(--green); }
</style>
</head>
<body>

<header>
  <h1>ARMYCLAW <span id="h-subtitle" data-i18n="subtitle">// Sand Table (沙盘)</span></h1>
  <div class="header-status">
    <span id="hq-status"><span class="status-dot dot-green"></span> HQ ONLINE</span>
    <span class="timestamp" id="last-refresh">--</span>
    <button class="debug-btn" id="debug-toggle" onclick="toggleDebug()">DEBUG</button>
    <button class="lang-btn" id="lang-toggle" onclick="toggleLang()">EN</button>
  </div>
</header>

<div class="grid">
  <!-- Battle Map -->
  <div class="panel full-width">
    <div class="panel-header">
      <h2 data-i18n="panel_battlemap">作战地图 BATTLE MAP</h2>
      <span class="timestamp" id="task-count">0 tasks</span>
    </div>
    <div class="panel-body" style="max-height:480px">
      <div class="pipeline" id="pipeline"></div>
    </div>
  </div>

  <!-- Force Deployment -->
  <div class="panel">
    <div class="panel-header"><h2 data-i18n="panel_force">兵力部署 FORCE DEPLOYMENT</h2></div>
    <div class="panel-body">
      <div class="agent-grid" id="agents"></div>
    </div>
  </div>

  <!-- Ammo Stats -->
  <div class="panel">
    <div class="panel-header"><h2 data-i18n="panel_ammo">弹药统计 AMMO STATS</h2></div>
    <div class="panel-body">
      <div class="cost-grid" id="costs"></div>
      <div class="cost-breakdown" id="cost-breakdown"></div>
    </div>
  </div>

  <!-- Arsenal -->
  <div class="panel">
    <div class="panel-header"><h2 data-i18n="panel_arsenal">军火库 ARSENAL</h2></div>
    <div class="panel-body">
      <div class="infra-grid" id="arsenal-stats"></div>
      <div class="infra-list" id="arsenal-models"></div>
      <div id="arsenal-errors"></div>
    </div>
  </div>

  <!-- Herald -->
  <div class="panel">
    <div class="panel-header"><h2 data-i18n="panel_herald">传令官 HERALD</h2></div>
    <div class="panel-body">
      <div class="infra-grid" id="herald-stats"></div>
      <div class="infra-bar" id="herald-bar"></div>
      <div class="infra-list" id="herald-durations"></div>
    </div>
  </div>

  <!-- Medic -->
  <div class="panel">
    <div class="panel-header"><h2 data-i18n="panel_medic">军医 MEDIC</h2></div>
    <div class="panel-body">
      <div class="infra-grid" id="medic-stats"></div>
      <div id="medic-stalled"></div>
      <div id="medic-errors"></div>
    </div>
  </div>

  <!-- Comms -->
  <div class="panel">
    <div class="panel-header"><h2 data-i18n="panel_comms">通信 COMMS</h2></div>
    <div class="panel-body">
      <div class="infra-grid" id="comms-stats"></div>
      <div class="infra-list" id="comms-channels"></div>
    </div>
  </div>

  <!-- Command Post -->
  <div class="panel full-width">
    <div class="panel-header"><h2 data-i18n="panel_command">军令台 COMMAND POST</h2></div>
    <div class="panel-body">
      <div class="command-section">
        <h3 data-i18n="cmd_task_ctrl">Task Control</h3>
        <div id="task-controls">
          <select id="ctrl-task-select"><option value="">...</option></select>
          <button class="btn btn-warn" onclick="controlTask('pause')" data-i18n="btn_pause">PAUSE</button>
          <button class="btn" onclick="controlTask('resume')" data-i18n="btn_resume">RESUME</button>
          <button class="btn btn-danger" onclick="controlTask('cancel')" data-i18n="btn_cancel">CANCEL</button>
        </div>
      </div>
      <div class="command-section">
        <h3 data-i18n="cmd_model_cfg">Agent Model Config (Hot Switch)</h3>
        <div id="model-config">
          <select id="cfg-role-select"></select>
          <select id="cfg-model-select">
            <option value="claude-opus-4-6">Claude Opus 4.6</option>
            <option value="claude-opus-4-20250514">Claude Opus 4</option>
            <option value="claude-sonnet-4-6">Claude Sonnet 4.6</option>
            <option value="claude-sonnet-4-20250514">Claude Sonnet 4</option>
            <option value="claude-haiku-4-5-20251001">Claude Haiku 4.5</option>
          </select>
          <button class="btn" onclick="updateAgentConfig()" data-i18n="btn_deploy">DEPLOY</button>
        </div>
      </div>
    </div>
  </div>
</div>

<!-- Debug Overlay -->
<div class="debug-overlay" id="debug-overlay">
  <div class="debug-log" id="debug-log"></div>
</div>

<!-- Task Detail Modal -->
<div class="modal-overlay" id="modal-overlay">
  <div class="modal" id="modal">
    <div class="modal-head">
      <div class="mh-left">
        <div class="mh-id" id="modal-id"></div>
        <div class="mh-desc" id="modal-desc"></div>
        <div class="mh-tags" id="modal-tags"></div>
      </div>
      <button class="modal-close" onclick="closeModal()">&times;</button>
    </div>
    <div class="modal-pipeline" id="modal-pipeline"></div>
    <div class="modal-section">
      <div class="ms-title" data-i18n="modal_info">基本信息 INFO</div>
      <div class="info-grid" id="modal-info"></div>
    </div>
    <div class="modal-section">
      <div class="ms-title"><span data-i18n="modal_flow">流转记录 FLOW LOG</span> <span id="flow-count" class="timestamp"></span></div>
      <div class="timeline" id="modal-flow"></div>
    </div>
    <div class="modal-section">
      <div class="ms-title"><span data-i18n="modal_progress">进展日志 PROGRESS</span> <span id="progress-count" class="timestamp"></span></div>
      <div id="modal-progress"></div>
    </div>
    <div class="modal-section">
      <div class="ms-title"><span data-i18n="modal_ctx">上下文链 CONTEXT CHAIN</span> <span id="ctx-count" class="timestamp"></span></div>
      <div id="modal-ctx"></div>
    </div>
    <div class="modal-actions" id="modal-actions"></div>
  </div>
</div>

<div id="toast"></div>

<script>
// ─── i18n System ──────────────────────────────────────────

let lang = 'zh'; // 'zh' | 'en'

const I18N = {
  // Page
  subtitle:        { zh: '// 沙盘指挥台', en: '// Sand Table' },
  page_title:      { zh: 'ArmyClaw - 沙盘指挥台', en: 'ArmyClaw - Sand Table' },
  // Panels
  panel_battlemap: { zh: '作战地图', en: 'BATTLE MAP' },
  panel_force:     { zh: '兵力部署', en: 'FORCE DEPLOYMENT' },
  panel_ammo:      { zh: '弹药统计', en: 'AMMO STATS' },
  panel_arsenal:   { zh: '军火库', en: 'ARSENAL' },
  panel_herald:    { zh: '传令官', en: 'HERALD' },
  panel_medic:     { zh: '军医', en: 'MEDIC' },
  panel_comms:     { zh: '通信', en: 'COMMS' },
  panel_command:   { zh: '军令台', en: 'COMMAND POST' },
  // Command post
  cmd_task_ctrl:   { zh: '任务控制', en: 'Task Control' },
  cmd_model_cfg:   { zh: '模型热切换', en: 'Agent Model Config (Hot Switch)' },
  // Modal sections
  modal_info:      { zh: '基本信息', en: 'INFO' },
  modal_flow:      { zh: '流转记录', en: 'FLOW LOG' },
  modal_progress:  { zh: '进展日志', en: 'PROGRESS' },
  modal_ctx:       { zh: '上下文链', en: 'CONTEXT CHAIN' },
  // Info labels
  info_created:    { zh: '创建时间', en: 'Created' },
  info_updated:    { zh: '更新时间', en: 'Updated' },
  info_parent:     { zh: '父任务', en: 'Parent' },
  info_campaign:   { zh: '战役', en: 'Campaign' },
  info_intent:     { zh: '意图', en: 'Intent' },
  info_errors:     { zh: '错误数', en: 'Errors' },
  info_rejects:    { zh: '驳回', en: 'Rejects' },
  info_source:     { zh: '来源', en: 'Source' },
  // Misc
  select_task:     { zh: '选择任务...', en: 'Select task...' },
  no_activity:     { zh: '无活动', en: 'no activity' },
  no_model_data:   { zh: '暂无模型数据', en: 'No model data' },
  no_dur_data:     { zh: '暂无耗时数据', en: 'No duration data' },
  no_flow_log:     { zh: '暂无流转记录', en: 'No flow log entries' },
  no_progress:     { zh: '暂无进展日志', en: 'No progress entries' },
  no_ctx:          { zh: '暂无上下文链', en: 'No context chain entries yet' },
  no_channel_data: { zh: '暂无通道数据', en: 'No channel data' },
  all_nominal:     { zh: '系统运行正常', en: 'All systems nominal' },
  recent_errors:   { zh: '近期错误', en: 'RECENT ERRORS' },
  stalled_tasks:   { zh: '停滞任务', en: 'STALLED TASKS' },
  error_prone:     { zh: '高错误率任务', en: 'ERROR-PRONE TASKS' },
  stalled_ago:     { zh: '停滞 {n}s', en: 'stalled {n}s ago' },
  tasks_unit:      { zh: '个任务', en: ' tasks' },
  runs_tok:        { zh: ' 次 / ', en: ' runs / ' },
  errors_unit:     { zh: ' 个错误', en: ' errors' },
  // Role names
  role_adjutant:       { zh: '副官', en: 'Adjutant' },
  role_chief_of_staff: { zh: '参谋长', en: 'Chief of Staff' },
  role_operations:     { zh: '指挥官', en: 'Operations' },
  role_inspector:      { zh: '督察长', en: 'Inspector' },
  role_engineer:       { zh: '工兵', en: 'Engineer' },
  // Infra stats
  stat_total_runs: { zh: '总调用', en: 'Total Runs' },
  stat_running:    { zh: '运行中', en: 'Running' },
  stat_success:    { zh: '成功率', en: 'Success' },
  stat_errors:     { zh: '错误', en: 'Errors' },
  stat_total:      { zh: '总计', en: 'Total' },
  stat_queue:      { zh: '排队', en: 'Queue' },
  stat_done:       { zh: '完成', en: 'Done' },
  stat_failed:     { zh: '失败', en: 'Failed' },
  stat_stalled:    { zh: '停滞', en: 'Stalled' },
  stat_high_err:   { zh: '高错误', en: 'High Err' },
  stat_rej_tac:    { zh: '战术驳回', en: 'Rej Tac' },
  stat_rej_str:    { zh: '战略驳回', en: 'Rej Str' },
  stat_channels:   { zh: '通道', en: 'Channels' },
  stat_inbound:    { zh: '外部入站', en: 'Inbound' },
  stat_internal:   { zh: '内部', en: 'Internal' },
  stat_today:      { zh: '今日', en: 'TODAY' },
  stat_week:       { zh: '本周', en: 'THIS WEEK' },
  // Pipeline states
  state_RECEIVED:     { zh: '已接收', en: 'RECEIVED' },
  state_SPLITTING:    { zh: '拆分中', en: 'SPLITTING' },
  state_PLANNING:     { zh: '规划中', en: 'PLANNING' },
  state_GATE1_REVIEW: { zh: '计划审查', en: 'PLAN REVIEW' },
  state_DISPATCHING:  { zh: '调度中', en: 'DISPATCHING' },
  state_EXECUTING:    { zh: '执行中', en: 'EXECUTING' },
  state_GATE2_REVIEW: { zh: '结果审查', en: 'RESULT REVIEW' },
  state_DELIVERING:   { zh: '交付中', en: 'DELIVERING' },
  state_DONE:         { zh: '已完成', en: 'DONE' },
  state_FAILED:       { zh: '已失败', en: 'FAILED' },
  state_CANCELLED:    { zh: '已取消', en: 'CANCELLED' },
  state_PAUSED:       { zh: '已暂停', en: 'PAUSED' },
  // Priority
  pri_urgent: { zh: '紧急', en: 'URGENT' },
  pri_high:   { zh: '高优', en: 'HIGH' },
  pri_medium: { zh: '中优', en: 'MEDIUM' },
  pri_low:    { zh: '低优', en: 'LOW' },
  // Agent status
  status_active:   { zh: '活跃', en: 'active' },
  status_thinking: { zh: '思考中', en: 'thinking' },
  status_stalled:  { zh: '停滞', en: 'stalled' },
  status_idle:     { zh: '空闲', en: 'idle' },
  // Header
  hq_online: { zh: '系统运行中', en: 'System Online' },
  // Debug panel
  debug_no_flow:    { zh: '暂无日志', en: 'No log entries' },
  // Buttons
  btn_pause:   { zh: '暂停', en: 'PAUSE' },
  btn_resume:  { zh: '恢复', en: 'RESUME' },
  btn_cancel:  { zh: '取消', en: 'CANCEL' },
  btn_deploy:  { zh: '部署', en: 'DEPLOY' },
  // Toasts
  toast_select_task:    { zh: '请先选择任务', en: 'Select a task first' },
  toast_config_updated: { zh: '配置已更新', en: 'Config updated' },
};

function t(key) { return (I18N[key] || {})[lang] || key; }
function tState(s) { return t('state_' + s); }
function tPriority(p) { return t('pri_' + p); }
function tStatus(s) { return t('status_' + s); }

function getRoleName(role) {
  const icon = ROLE_ICONS[role] || '';
  const key = 'role_' + role;
  return icon + ' ' + t(key);
}

function populateRoleSelect() {
  const sel = document.getElementById('cfg-role-select');
  const prev = sel.value;
  sel.innerHTML = '';
  ['adjutant','chief_of_staff','operations','inspector','engineer'].forEach(function(role) {
    const opt = document.createElement('option');
    opt.value = role;
    opt.textContent = getRoleName(role);
    sel.appendChild(opt);
  });
  if (prev) sel.value = prev;
}

function applyLang() {
  // Update all data-i18n elements
  document.querySelectorAll('[data-i18n]').forEach(function(el) {
    el.textContent = t(el.getAttribute('data-i18n'));
  });
  // Title + HQ status
  document.getElementById('page-title').textContent = t('page_title');
  document.getElementById('hq-status').innerHTML =
    '<span class="status-dot dot-green"></span> ' + t('hq_online');
  // Toggle button label
  document.getElementById('lang-toggle').textContent = lang === 'zh' ? 'EN' : '中文';
  // Populate role dropdown with translated names
  populateRoleSelect();
  // Re-render dynamic content
  refresh();
}

function toggleLang() {
  lang = lang === 'zh' ? 'en' : 'zh';
  localStorage.setItem('armyclaw-lang', lang);
  applyLang();
}

// Restore saved preference
(function() {
  const saved = localStorage.getItem('armyclaw-lang');
  if (saved === 'en' || saved === 'zh') lang = saved;
})();

// ─── Constants ────────────────────────────────────────────

const PIPELINE_STATES = [
  'RECEIVED', 'SPLITTING', 'PLANNING', 'GATE1_REVIEW',
  'DISPATCHING', 'EXECUTING', 'GATE2_REVIEW', 'DELIVERING', 'DONE'
];
const ALL_STATES = [...PIPELINE_STATES, 'FAILED', 'CANCELLED', 'PAUSED'];

const TERMINAL = new Set(['DONE', 'FAILED', 'CANCELLED']);

const ROLE_ICONS = {
  adjutant:       '\u{1F4CB}',
  chief_of_staff: '\u{1F9E0}',
  operations:     '\u2694\uFE0F',
  inspector:      '\u{1F50D}',
  engineer:       '\u{1F6E0}\uFE0F',
};

// Which agent typically handles which pipeline stage
const STAGE_AGENT = {
  RECEIVED: 'adjutant', SPLITTING: 'chief_of_staff', PLANNING: 'chief_of_staff',
  GATE1_REVIEW: 'inspector', DISPATCHING: 'operations', EXECUTING: 'engineer',
  GATE2_REVIEW: 'inspector', DELIVERING: 'adjutant', DONE: null,
};

function stateTagClass(s) {
  if (s === 'DONE') return 'st-done';
  if (s === 'FAILED') return 'st-fail';
  if (s === 'PAUSED' || s === 'CANCELLED') return 'st-paused';
  if (s.includes('GATE') || s.includes('REVIEW')) return 'st-review';
  return 'st-active';
}

function fmtTime(iso) {
  if (!iso) return '--';
  const d = new Date(iso);
  return d.toLocaleTimeString('en-GB', { hour12: false });
}

function fmtDuration(ms) {
  if (!ms && ms !== 0) return '';
  if (ms < 1000) return ms + 'ms';
  if (ms < 60000) return (ms / 1000).toFixed(1) + 's';
  return (ms / 60000).toFixed(1) + 'm';
}

function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function showToast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.style.display = 'block';
  setTimeout(() => { el.style.display = 'none'; }, 2500);
}

async function fetchJSON(url) {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return res.json();
  } catch { return null; }
}

// ─── Global State ─────────────────────────────────────────

let allTasks = [];
let modalTaskId = null;
let modalPollTimer = null;

// ─── Battle Map ───────────────────────────────────────────

async function refreshTasks() {
  const tasks = await fetchJSON('/api/tasks');
  if (!tasks) return;
  allTasks = tasks;

  document.getElementById('task-count').textContent = tasks.length + t('tasks_unit');

  const pipeline = document.getElementById('pipeline');
  pipeline.innerHTML = '';

  const grouped = {};
  for (const s of ALL_STATES) grouped[s] = [];
  for (const tk of tasks) {
    if (grouped[tk.state]) grouped[tk.state].push(tk);
  }

  // Always show all pipeline stages so users see the full flow;
  // only hide terminal states (FAILED/CANCELLED/PAUSED) when empty
  const visible = ALL_STATES.filter(s =>
    grouped[s].length > 0 || PIPELINE_STATES.includes(s)
  );

  for (const state of visible) {
    const col = document.createElement('div');
    col.className = 'pipeline-col';
    const agent = STAGE_AGENT[state];
    const icon = agent ? (ROLE_ICONS[agent] || '') + ' ' : '';
    col.innerHTML = '<div class="pipeline-col-header">' + icon + tState(state) + ' (' + grouped[state].length + ')</div>';

    for (const tk of grouped[state]) {
      const card = document.createElement('div');
      card.className = 'task-card';
      card.onclick = () => openModal(tk.id);
      const agentIcon = tk.assigned_agent ? (ROLE_ICONS[tk.assigned_agent] || '') : '';
      card.innerHTML =
        '<div class="tc-head">' +
          '<span class="tc-id">' + escapeHtml(tk.id.slice(0, 8)) + '</span>' +
          '<span class="tc-state ' + stateTagClass(tk.state) + '">' + tState(tk.state) + '</span>' +
        '</div>' +
        '<div class="tc-desc" title="' + escapeHtml(tk.description) + '">' + escapeHtml(tk.description.slice(0, 50)) + '</div>' +
        '<div class="tc-meta">' +
          '<span class="tc-priority priority-' + tk.priority + '">' + tPriority(tk.priority) + '</span>' +
          '<span class="tc-agent">' + agentIcon + '</span>' +
        '</div>';
      col.appendChild(card);
    }

    pipeline.appendChild(col);
  }

  // Task control dropdown
  const select = document.getElementById('ctrl-task-select');
  const prevVal = select.value;
  select.innerHTML = '<option value="">' + t('select_task') + '</option>';
  for (const tk of tasks.filter(tk => !TERMINAL.has(tk.state))) {
    const opt = document.createElement('option');
    opt.value = tk.id;
    const icon = ROLE_ICONS[tk.assigned_agent] || '';
    opt.textContent = icon + ' ' + tk.id.slice(0, 8) + ' \u2014 ' + tState(tk.state);
    select.appendChild(opt);
  }
  if (prevVal) select.value = prevVal;
}

// ─── Force Deployment ─────────────────────────────────────

async function refreshAgents() {
  const agents = await fetchJSON('/api/agents');
  const health = await fetchJSON('/api/health');
  if (!agents) return;

  const healthMap = {};
  if (health) for (const h of health) healthMap[h.role] = h;

  const container = document.getElementById('agents');
  container.innerHTML = '';

  for (const a of agents) {
    const h = healthMap[a.role] || { status: 'red' };
    const card = document.createElement('div');
    card.className = 'agent-card';
    card.innerHTML =
      '<div class="agent-name">' +
        '<span class="status-dot dot-' + h.status + '"></span>' +
        getRoleName(a.role) +
      '</div>' +
      '<div class="agent-model">' + escapeHtml(a.model) + '</div>' +
      '<div class="agent-status">' + tStatus(a.status) +
        (a.current_task_id ? ' \u2014 ' + a.current_task_id.slice(0, 8) : '') +
      '</div>' +
      '<div class="timestamp">' + (a.last_activity ? fmtTime(a.last_activity) : t('no_activity')) + '</div>';
    container.appendChild(card);
  }
}

// ─── Ammo Stats ───────────────────────────────────────────

async function refreshCosts() {
  const costs = await fetchJSON('/api/costs');
  if (!costs) return;

  const el = document.getElementById('costs');
  const dc = costs.daily_total > 40 ? 'danger' : costs.daily_total > 20 ? 'warning' : '';
  el.innerHTML =
    '<div class="cost-box"><div class="cost-label">' + t('stat_today') + '</div>' +
      '<div class="cost-value ' + dc + '">$' + costs.daily_total.toFixed(2) + '</div></div>' +
    '<div class="cost-box"><div class="cost-label">' + t('stat_week') + '</div>' +
      '<div class="cost-value">$' + costs.weekly_total.toFixed(2) + '</div></div>';

  const bd = document.getElementById('cost-breakdown');
  let html = '';
  for (const [agent, cost] of Object.entries(costs.by_agent || {})) {
    html += '<div class="cost-row"><span class="cost-row-label">' +
      getRoleName(agent) + '</span><span>$' + Number(cost).toFixed(4) + '</span></div>';
  }
  bd.innerHTML = html;
}

// ─── Infrastructure Panels ────────────────────────────────

async function refreshArsenal() {
  const d = await fetchJSON('/api/arsenal');
  if (!d) return;

  const total = d.total_runs || 0;
  const successRate = total ? Math.round(d.success / total * 100) : 0;
  const el = document.getElementById('arsenal-stats');
  el.innerHTML =
    infraStat(t('stat_total_runs'), String(total)) +
    infraStat(t('stat_running'), String(d.running), d.running > 0 ? '' : '') +
    infraStat(t('stat_success'), successRate + '%', successRate < 80 ? 'warning' : '') +
    infraStat(t('stat_errors'), String(d.error), d.error > 0 ? 'danger' : '');

  // Model breakdown
  const models = document.getElementById('arsenal-models');
  let mhtml = '';
  for (const [model, stats] of Object.entries(d.by_model || {})) {
    const s = stats;
    const shortModel = model.length > 25 ? model.slice(0, 22) + '...' : model;
    mhtml += '<div class="infra-list-item"><span class="il-label">' + escapeHtml(shortModel) +
      '</span><span class="il-value">' + s.runs + t('runs_tok') +
      Math.round((s.input_tokens + s.output_tokens) / 1000) + 'K tok</span></div>';
  }
  models.innerHTML = mhtml || '<div style="color:#555;font-size:11px">' + t('no_model_data') + '</div>';

  // Recent errors
  const errEl = document.getElementById('arsenal-errors');
  if (d.recent_errors && d.recent_errors.length > 0) {
    let ehtml = '<div style="margin-top:8px;font-size:10px;color:#ff9933;margin-bottom:4px">' + t('recent_errors') + '</div>';
    for (const e of d.recent_errors.slice(0, 3)) {
      const icon = ROLE_ICONS[e.agent_role] || '';
      ehtml += '<div class="stall-card"><span class="sc-id">' + icon + ' ' +
        escapeHtml(e.task_id.slice(0, 8)) + '</span> <span style="color:#666">' +
        escapeHtml(e.model.slice(0, 20)) + '</span>' +
        '<div class="sc-meta">' + escapeHtml((e.error || '').slice(0, 80)) + '</div></div>';
    }
    errEl.innerHTML = ehtml;
  } else {
    errEl.innerHTML = '';
  }
}

async function refreshHerald() {
  const d = await fetchJSON('/api/herald');
  if (!d) return;

  const el = document.getElementById('herald-stats');
  el.innerHTML =
    infraStat(t('stat_total'), String(d.total_tasks)) +
    infraStat(t('stat_queue'), String(d.queue_depth), d.queue_depth > 5 ? 'warning' : '') +
    infraStat(t('stat_done'), String(d.completed)) +
    infraStat(t('stat_failed'), String(d.failed), d.failed > 0 ? 'danger' : '');

  // Priority bar
  const bar = document.getElementById('herald-bar');
  const total = d.total_tasks || 1;
  const priColors = { urgent: '#ff3333', high: '#ff9933', medium: '#5599ff', low: '#555' };
  let barHtml = '';
  for (const [pri, cnt] of Object.entries(d.by_priority || {})) {
    const pct = (Number(cnt) / total * 100).toFixed(1);
    barHtml += '<span style="width:' + pct + '%;background:' + (priColors[pri] || '#333') +
      '" title="' + pri + ': ' + cnt + '"></span>';
  }
  bar.innerHTML = barHtml;

  // Avg durations
  const dur = document.getElementById('herald-durations');
  let dhtml = '';
  const stateOrder = ['SPLITTING','PLANNING','GATE1_REVIEW','DISPATCHING','EXECUTING','GATE2_REVIEW','DELIVERING'];
  for (const st of stateOrder) {
    const ms = (d.avg_duration_by_state || {})[st];
    if (ms != null) {
      dhtml += '<div class="infra-list-item"><span class="il-label">' + tState(st) +
        '</span><span class="il-value">' + fmtDuration(ms) + '</span></div>';
    }
  }
  dur.innerHTML = dhtml || '<div style="color:#555;font-size:11px">' + t('no_dur_data') + '</div>';
}

async function refreshMedic() {
  const d = await fetchJSON('/api/medic');
  if (!d) return;

  const el = document.getElementById('medic-stats');
  const stalledN = (d.stalled_tasks || []).length;
  el.innerHTML =
    infraStat(t('stat_stalled'), String(stalledN), stalledN > 0 ? 'danger' : '') +
    infraStat(t('stat_high_err'), String((d.high_error_tasks || []).length), (d.high_error_tasks || []).length > 0 ? 'warning' : '') +
    infraStat(t('stat_rej_tac'), String(d.reject_summary?.tactical || 0)) +
    infraStat(t('stat_rej_str'), String(d.reject_summary?.strategic || 0), (d.reject_summary?.strategic || 0) > 0 ? 'warning' : '');

  // Stalled tasks
  const stallEl = document.getElementById('medic-stalled');
  if (stalledN > 0) {
    let shtml = '<div style="margin-top:6px;font-size:10px;color:#ff3333;margin-bottom:4px">' + t('stalled_tasks') + '</div>';
    for (const st of d.stalled_tasks) {
      const icon = st.assigned_agent ? (ROLE_ICONS[st.assigned_agent] || '') : '';
      const ago = Math.round((Date.now() - new Date(st.updated_at).getTime()) / 1000);
      shtml += '<div class="stall-card"><span class="sc-id">' + escapeHtml(st.id.slice(0, 8)) +
        '</span> ' + icon + ' <span style="color:#ff9933">' + st.state + '</span>' +
        '<div class="sc-meta">' + t('stalled_ago').replace('{n}', ago) + '</div></div>';
    }
    stallEl.innerHTML = shtml;
  } else {
    stallEl.innerHTML = '<div style="color:#33ff33;font-size:11px;margin-top:6px">' + t('all_nominal') + '</div>';
  }

  // High error tasks
  const errEl = document.getElementById('medic-errors');
  const highErr = d.high_error_tasks || [];
  if (highErr.length > 0) {
    let ehtml = '<div style="margin-top:6px;font-size:10px;color:#ff9933;margin-bottom:4px">' + t('error_prone') + '</div>';
    for (const et of highErr.slice(0, 5)) {
      ehtml += '<div class="infra-list-item"><span class="il-label">' + escapeHtml(et.id.slice(0, 8)) +
        ' <span style="color:#666">' + et.state + '</span></span>' +
        '<span class="il-value crit">' + et.error_count + t('errors_unit') + '</span></div>';
    }
    errEl.innerHTML = ehtml;
  } else {
    errEl.innerHTML = '';
  }
}

async function refreshComms() {
  // Derive channel stats from task data
  const tasks = allTasks;
  const channels = {};
  let totalWithChannel = 0;
  for (const tk of tasks) {
    const ch = tk.source_channel || 'internal';
    channels[ch] = (channels[ch] || 0) + 1;
    if (tk.source_channel) totalWithChannel++;
  }

  const el = document.getElementById('comms-stats');
  const channelCount = Object.keys(channels).filter(c => c !== 'internal').length;
  el.innerHTML =
    infraStat(t('stat_channels'), String(channelCount)) +
    infraStat(t('stat_inbound'), String(totalWithChannel)) +
    infraStat(t('stat_internal'), String(tasks.length - totalWithChannel));

  const list = document.getElementById('comms-channels');
  let html = '';
  for (const [ch, cnt] of Object.entries(channels).sort((a, b) => Number(b[1]) - Number(a[1]))) {
    const isOnline = ch !== 'internal';
    html += '<div class="infra-list-item"><span class="il-label">' +
      (isOnline ? '<span class="status-dot dot-green"></span>' : '<span class="status-dot dot-red" style="opacity:0.3"></span>') +
      escapeHtml(ch) + '</span><span class="il-value">' + cnt + t('tasks_unit') + '</span></div>';
  }
  list.innerHTML = html || '<div style="color:#555;font-size:11px">' + t('no_channel_data') + '</div>';
}

function infraStat(label, value, cls) {
  return '<div class="infra-stat"><div class="is-label">' + label +
    '</div><div class="is-value ' + (cls || '') + '">' + value + '</div></div>';
}

// ─── Task Control ─────────────────────────────────────────

async function controlTask(action) {
  const taskId = document.getElementById('ctrl-task-select').value;
  if (!taskId) { showToast(t('toast_select_task')); return; }
  const res = await fetch('/api/tasks/control', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ task_id: taskId, action }),
  });
  const data = await res.json();
  showToast(action.toUpperCase() + ' \u2014 ' + (data.status || data.error));
  refresh();
}

async function controlTaskFromModal(action) {
  if (!modalTaskId) return;
  const res = await fetch('/api/tasks/control', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ task_id: modalTaskId, action }),
  });
  const data = await res.json();
  showToast(action.toUpperCase() + ' \u2014 ' + (data.status || data.error));
  refresh();
  refreshModal();
}

async function updateAgentConfig() {
  const role = document.getElementById('cfg-role-select').value;
  const model = document.getElementById('cfg-model-select').value;
  await fetch('/api/agents/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ role, model, provider: 'anthropic', temperature: 0.3, max_tokens: 8192 }),
  });
  showToast(t('toast_config_updated') + ': ' + getRoleName(role) + ' \u2192 ' + model);
}

// ─── Task Detail Modal ────────────────────────────────────

function openModal(taskId) {
  modalTaskId = taskId;
  document.getElementById('modal-overlay').classList.add('open');
  refreshModal();
  // Poll every 3s while open
  clearInterval(modalPollTimer);
  modalPollTimer = setInterval(() => {
    const task = allTasks.find(t => t.id === modalTaskId);
    if (task && TERMINAL.has(task.state)) {
      clearInterval(modalPollTimer);
      return;
    }
    refreshModal();
  }, 3000);
}

function closeModal() {
  modalTaskId = null;
  document.getElementById('modal-overlay').classList.remove('open');
  clearInterval(modalPollTimer);
}

// Close on overlay click or ESC
document.getElementById('modal-overlay').addEventListener('click', (e) => {
  if (e.target === document.getElementById('modal-overlay')) closeModal();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && modalTaskId) closeModal();
});

async function refreshModal() {
  if (!modalTaskId) return;

  const task = allTasks.find(t => t.id === modalTaskId);
  if (!task) return;

  // Header
  document.getElementById('modal-id').textContent = task.id;
  document.getElementById('modal-desc').textContent = task.description;

  const tags = document.getElementById('modal-tags');
  const agentIcon = task.assigned_agent ? (ROLE_ICONS[task.assigned_agent] || '') + ' ' : '';
  tags.innerHTML =
    '<span class="' + stateTagClass(task.state) + '">' + tState(task.state) + '</span>' +
    '<span class="priority-' + task.priority + '" style="font-size:10px">' + tPriority(task.priority) + '</span>' +
    (task.assigned_agent ? '<span style="font-size:10px;color:#aaa">' + agentIcon + task.assigned_agent + '</span>' : '');

  // Pipeline visualization
  const flowLog = await fetchJSON('/api/flow-log?task_id=' + encodeURIComponent(task.id)) || [];
  renderPipeline(task, flowLog);

  // Info grid
  const info = document.getElementById('modal-info');
  info.innerHTML =
    infoItem(t('info_created'), fmtTime(task.created_at)) +
    infoItem(t('info_updated'), fmtTime(task.updated_at)) +
    infoItem(t('info_parent'), task.parent_id ? task.parent_id.slice(0, 8) : '\u2014') +
    infoItem(t('info_campaign'), task.campaign_id ? task.campaign_id.slice(0, 8) : '\u2014') +
    infoItem(t('info_intent'), task.intent_type || '\u2014') +
    infoItem(t('info_errors'), String(task.error_count)) +
    infoItem(t('info_rejects'), 'T:' + task.reject_count_tactical + ' S:' + task.reject_count_strategic) +
    infoItem(t('info_source'), task.source_channel || '\u2014');

  // Flow log
  document.getElementById('flow-count').textContent = '(' + flowLog.length + ')';
  renderFlowLog(flowLog);

  // Progress log
  const progressLog = await fetchJSON('/api/progress?task_id=' + encodeURIComponent(task.id)) || [];
  document.getElementById('progress-count').textContent = '(' + progressLog.length + ')';
  renderProgressLog(progressLog);

  // Context chain (agent I/O)
  renderContextChain(task);

  // Action buttons
  const actions = document.getElementById('modal-actions');
  if (TERMINAL.has(task.state)) {
    actions.innerHTML = '';
  } else {
    actions.innerHTML =
      (task.state === 'PAUSED'
        ? '<button class="btn" onclick="controlTaskFromModal(&quot;resume&quot;)">' + t('btn_resume') + '</button>'
        : '<button class="btn btn-warn" onclick="controlTaskFromModal(&quot;pause&quot;)">' + t('btn_pause') + '</button>') +
      '<button class="btn btn-danger" onclick="controlTaskFromModal(&quot;cancel&quot;)">' + t('btn_cancel') + '</button>';
  }
}

function infoItem(label, value) {
  return '<div class="info-item"><div class="info-label">' + escapeHtml(label) +
    '</div><div class="info-value">' + escapeHtml(value) + '</div></div>';
}

// ─── Pipeline Visualization ───────────────────────────────

function renderPipeline(task, flowLog) {
  const container = document.getElementById('modal-pipeline');

  // Compute which stages have been visited
  const visited = new Set();
  for (const entry of flowLog) {
    if (entry.to_state) visited.add(entry.to_state);
  }
  visited.add(task.state); // current is always visited

  const currentIdx = PIPELINE_STATES.indexOf(task.state);
  const isFailed = task.state === 'FAILED';
  const isPaused = task.state === 'PAUSED';

  // For FAILED/PAUSED, find the last pipeline state from flow_log
  let effectiveIdx = currentIdx;
  if (currentIdx === -1) {
    // state not in pipeline (FAILED/PAUSED/CANCELLED) — find last known
    for (let i = flowLog.length - 1; i >= 0; i--) {
      const idx = PIPELINE_STATES.indexOf(flowLog[i].to_state);
      if (idx >= 0 && flowLog[i].to_state !== 'FAILED' && flowLog[i].to_state !== 'CANCELLED') {
        effectiveIdx = idx;
        break;
      }
      const fidx = PIPELINE_STATES.indexOf(flowLog[i].from_state);
      if (fidx >= 0) {
        effectiveIdx = fidx;
        break;
      }
    }
  }

  let html = '<div class="mp-track">';
  for (let i = 0; i < PIPELINE_STATES.length; i++) {
    const s = PIPELINE_STATES[i];
    const isDone = i < effectiveIdx || (task.state === 'DONE' && i <= effectiveIdx);
    const isActive = i === effectiveIdx && !isFailed && task.state !== 'DONE' && task.state !== 'CANCELLED';
    const isFail = i === effectiveIdx && isFailed;
    const isPause = i === effectiveIdx && isPaused;

    let dotClass = '';
    let dotContent = '';
    if (isDone)    { dotClass = 'done';   dotContent = '\u2713'; }
    else if (isActive) { dotClass = 'active'; dotContent = '\u25CF'; }
    else if (isFail)   { dotClass = 'fail';   dotContent = '\u2717'; }
    else if (isPause)  { dotClass = 'paused'; dotContent = '\u2759'; }
    else           { dotContent = (i + 1).toString(); }

    const agent = STAGE_AGENT[s];
    const agentIcon = agent ? ROLE_ICONS[agent] || '' : '';

    html += '<div class="mp-node">' +
      '<div class="mp-dot ' + dotClass + '">' + dotContent + '</div>' +
      '<div class="mp-label">' + tState(s) + '</div>' +
      '<div class="mp-agent">' + agentIcon + '</div>' +
    '</div>';

    if (i < PIPELINE_STATES.length - 1) {
      html += '<div class="mp-arrow ' + (isDone ? 'done' : '') + '">\u2192</div>';
    }
  }
  html += '</div>';
  container.innerHTML = html;
}

// ─── Flow Log Timeline ───────────────────────────────────

function renderFlowLog(entries) {
  const container = document.getElementById('modal-flow');
  if (!entries.length) {
    container.innerHTML = '<div style="color:#555;font-size:11px">' + t('no_flow_log') + '</div>';
    return;
  }

  let html = '';
  for (const e of entries) {
    const role = e.agent_role || '';
    const icon = ROLE_ICONS[role] || '';
    const dur = e.duration_ms ? fmtDuration(e.duration_ms) : '';

    html += '<div class="tl-entry">' +
      '<div class="tl-dot tl-' + role + '"></div>' +
      '<div class="tl-time">' + fmtTime(e.at) + '</div>' +
      '<div class="tl-content">' +
        '<span class="tl-role">' + icon + '</span>' +
        '<span class="tl-states">' + (e.from_state ? tState(e.from_state) : '?') + ' \u2192 ' + tState(e.to_state) + '</span>' +
        (e.reason ? '<span class="tl-reason">' + escapeHtml(e.reason) + '</span>' : '') +
        (dur ? '<span class="tl-dur">' + dur + '</span>' : '') +
      '</div>' +
    '</div>';
  }
  container.innerHTML = html;
}

// ─── Progress Log ─────────────────────────────────────────

function renderProgressLog(entries) {
  const container = document.getElementById('modal-progress');
  if (!entries.length) {
    container.innerHTML = '<div style="color:#555;font-size:11px">' + t('no_progress') + '</div>';
    return;
  }

  // Show newest first
  let html = '';
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    const icon = ROLE_ICONS[e.agent] || '';
    html += '<div class="progress-entry">' +
      '<div class="pe-head">' +
        '<span class="pe-agent">' + icon + ' ' + escapeHtml(e.agent) + '</span>' +
        '<span class="pe-time">' + fmtTime(e.at) + '</span>' +
      '</div>' +
      '<div class="pe-text">' + escapeHtml(e.text) + '</div>' +
    '</div>';
  }
  container.innerHTML = html;
}

// ─── Context Chain ────────────────────────────────────────

function renderContextChain(task) {
  const container = document.getElementById('modal-ctx');
  let chain = [];
  try {
    if (task.context_chain) chain = JSON.parse(task.context_chain);
  } catch {}

  document.getElementById('ctx-count').textContent = '(' + chain.length + ')';

  if (!chain.length) {
    container.innerHTML = '<div class="ctx-empty">' + t('no_ctx') + '</div>';
    return;
  }

  let html = '';
  for (let i = 0; i < chain.length; i++) {
    const c = chain[i];
    const icon = ROLE_ICONS[c.role] || '';
    const roleName = getRoleName(c.role);
    const preview = (c.output || '').slice(0, 80).replace(/\\n/g, ' ');
    html +=
      '<div class="ctx-entry" id="ctx-' + i + '">' +
        '<button class="ctx-toggle" onclick="toggleCtx(' + i + ')">' +
          '<span class="ctx-arrow">&#9654;</span>' +
          '<span class="ctx-role">' + escapeHtml(roleName) + '</span>' +
          '<span style="color:#555;font-size:11px">' + escapeHtml(preview) + (c.output && c.output.length > 80 ? '...' : '') + '</span>' +
        '</button>' +
        '<div class="ctx-body">' + escapeHtml(c.output || '(empty)') + '</div>' +
      '</div>';
  }
  container.innerHTML = html;
}

function toggleCtx(i) {
  const el = document.getElementById('ctx-' + i);
  if (el) el.classList.toggle('open');
}

// ─── Debug Panel ──────────────────────────────────────────

let debugOpen = false;
let debugTimer = null;

function toggleDebug() {
  debugOpen = !debugOpen;
  document.getElementById('debug-overlay').classList.toggle('open', debugOpen);
  document.getElementById('debug-toggle').classList.toggle('active', debugOpen);
  if (debugOpen) {
    refreshDebugLog();
    debugTimer = setInterval(refreshDebugLog, 2000);
  } else {
    clearInterval(debugTimer);
    debugTimer = null;
  }
}

async function refreshDebugLog() {
  if (!debugOpen) return;
  const [flow, runs, progress] = await Promise.all([
    fetchJSON('/api/debug/flow'),
    fetchJSON('/api/debug/runs'),
    fetchJSON('/api/tasks'),
  ]);
  // Merge all events into a unified timeline
  const events = [];
  if (flow) for (const f of flow) {
    const from = f.from_state
      ? '<span class="log-state ' + stateTagClass(f.from_state) + '">' + tState(f.from_state) + '</span> <span class="log-arrow">\u2192</span> '
      : '';
    const to = '<span class="log-state ' + stateTagClass(f.to_state) + '">' + tState(f.to_state) + '</span>';
    const dur = f.duration_ms ? ' <span class="log-tokens">' + fmtDuration(f.duration_ms) + '</span>' : '';
    const reason = f.reason ? ' <span class="log-reason">' + escapeHtml(f.reason) + '</span>' : '';
    events.push({
      ts: f.at,
      type: 'flow',
      taskId: f.task_id,
      agent: f.agent_role,
      detail: from + to + dur + reason,
    });
  }
  if (runs) for (const r of runs) {
    const statusCls = 'log-status-' + r.status;
    const model = (r.model || '').replace('claude-','').replace('-20250514','');
    const tokens = (r.input_tokens || r.output_tokens)
      ? ' <span class="log-tokens">' + (r.input_tokens || 0).toLocaleString() + '\u2192' + (r.output_tokens || 0).toLocaleString() + ' tok</span>'
      : '';
    const dur = r.started_at && r.finished_at
      ? ' ' + fmtDuration(new Date(r.finished_at) - new Date(r.started_at))
      : '';
    const err = r.error ? ' <span style="color:var(--red)">' + escapeHtml(r.error.slice(0,80)) + '</span>' : '';
    events.push({
      ts: r.updated_at || r.started_at,
      type: 'run',
      taskId: r.task_id,
      agent: r.agent_role,
      detail: '<span class="' + statusCls + '">' + r.status + '</span> ' + model + tokens + dur + err,
    });
  }
  // Sort by timestamp descending
  events.sort(function(a, b) { return a.ts > b.ts ? -1 : a.ts < b.ts ? 1 : 0; });

  const el = document.getElementById('debug-log');
  if (!events.length) {
    el.innerHTML = '<div class="log-empty">' + t('debug_no_flow') + '</div>';
    return;
  }
  let html = '';
  for (const ev of events) {
    const typeCls = ev.type === 'flow' ? 'log-type-flow' : 'log-type-run';
    const typeLabel = ev.type === 'flow' ? (lang === 'zh' ? '\u6D41\u8F6C' : 'FLOW') : (lang === 'zh' ? '\u8C03\u7528' : 'RUN');
    const agent = ev.agent ? getRoleName(ev.agent) : '';
    html +=
      '<div class="log-entry">' +
        '<span class="log-time">' + fmtTime(ev.ts) + '</span>' +
        '<span class="log-type ' + typeCls + '">' + typeLabel + '</span>' +
        '<span class="log-task" onclick="closeDebugAndOpenTask(&quot;' + ev.taskId + '&quot;)">' + ev.taskId.slice(0,8) + '</span>' +
        '<span class="log-agent">' + agent + '</span>' +
        '<span class="log-detail">' + ev.detail + '</span>' +
      '</div>';
  }
  el.innerHTML = html;
}

function closeDebugAndOpenTask(taskId) {
  if (debugOpen) toggleDebug();
  openModal(taskId);
}

// ─── Main Refresh Loop ────────────────────────────────────

async function refresh() {
  await Promise.all([
    refreshTasks(), refreshAgents(), refreshCosts(),
    refreshArsenal(), refreshHerald(), refreshMedic(),
  ]);
  // Comms derives from allTasks, so must run after refreshTasks
  refreshComms();
  document.getElementById('last-refresh').textContent = new Date().toLocaleTimeString();
}

// Apply saved language on load, then start refresh
applyLang();
setInterval(refresh, 2000);
</script>
</body>
</html>`;
}
