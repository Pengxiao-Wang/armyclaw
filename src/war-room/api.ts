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
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

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
<title>ArmyClaw - Sand Table (沙盘)</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    background: #0a0e14;
    color: #33ff33;
    font-family: 'Courier New', 'Consolas', monospace;
    font-size: 13px;
    min-height: 100vh;
  }
  header {
    background: #0d1117;
    border-bottom: 1px solid #1a3a1a;
    padding: 12px 20px;
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  header h1 {
    font-size: 18px;
    color: #33ff33;
    letter-spacing: 2px;
  }
  header h1 span { color: #ff9933; }
  .header-status {
    display: flex;
    gap: 16px;
    align-items: center;
    font-size: 12px;
  }
  .status-dot {
    width: 8px; height: 8px;
    border-radius: 50%;
    display: inline-block;
    margin-right: 4px;
  }
  .dot-green { background: #33ff33; box-shadow: 0 0 6px #33ff33; }
  .dot-yellow { background: #ffaa33; box-shadow: 0 0 6px #ffaa33; }
  .dot-red { background: #ff3333; box-shadow: 0 0 6px #ff3333; }

  .grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    grid-template-rows: auto auto;
    gap: 12px;
    padding: 12px;
    max-width: 1600px;
    margin: 0 auto;
  }

  .panel {
    background: #0d1117;
    border: 1px solid #1a3a1a;
    border-radius: 4px;
    overflow: hidden;
  }
  .panel-header {
    background: #111a11;
    padding: 8px 12px;
    border-bottom: 1px solid #1a3a1a;
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  .panel-header h2 {
    font-size: 14px;
    color: #ff9933;
    letter-spacing: 1px;
  }
  .panel-body {
    padding: 12px;
    max-height: 400px;
    overflow-y: auto;
  }
  .panel-body::-webkit-scrollbar { width: 4px; }
  .panel-body::-webkit-scrollbar-track { background: #0a0e14; }
  .panel-body::-webkit-scrollbar-thumb { background: #1a3a1a; }

  /* Battle Map — Pipeline Columns */
  .pipeline {
    display: flex;
    gap: 8px;
    overflow-x: auto;
    padding-bottom: 8px;
  }
  .pipeline-col {
    min-width: 130px;
    flex-shrink: 0;
  }
  .pipeline-col-header {
    font-size: 11px;
    color: #888;
    text-align: center;
    padding: 4px;
    border-bottom: 1px solid #1a3a1a;
    margin-bottom: 6px;
  }
  .task-card {
    background: #111a11;
    border: 1px solid #1a3a1a;
    border-radius: 3px;
    padding: 6px 8px;
    margin-bottom: 4px;
    font-size: 11px;
    cursor: pointer;
    transition: border-color 0.2s;
  }
  .task-card:hover { border-color: #33ff33; }
  .task-card .task-id { color: #33ff33; font-weight: bold; }
  .task-card .task-desc {
    color: #aaa;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 120px;
  }
  .task-card .task-priority {
    font-size: 10px;
    margin-top: 2px;
  }
  .priority-urgent { color: #ff3333; }
  .priority-high { color: #ff9933; }
  .priority-medium { color: #ffff33; }
  .priority-low { color: #888; }

  /* Agent Cards */
  .agent-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
    gap: 8px;
  }
  .agent-card {
    background: #111a11;
    border: 1px solid #1a3a1a;
    border-radius: 3px;
    padding: 10px;
  }
  .agent-card .agent-name {
    font-weight: bold;
    margin-bottom: 4px;
  }
  .agent-card .agent-model {
    color: #888;
    font-size: 11px;
    margin-bottom: 4px;
  }
  .agent-card .agent-status {
    font-size: 11px;
  }

  /* Cost Panel */
  .cost-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px;
  }
  .cost-box {
    background: #111a11;
    border: 1px solid #1a3a1a;
    border-radius: 3px;
    padding: 10px;
    text-align: center;
  }
  .cost-label { color: #888; font-size: 11px; margin-bottom: 4px; }
  .cost-value { font-size: 20px; font-weight: bold; }
  .cost-value.warning { color: #ff9933; }
  .cost-value.danger { color: #ff3333; }

  .cost-breakdown { margin-top: 8px; }
  .cost-row {
    display: flex;
    justify-content: space-between;
    padding: 2px 0;
    font-size: 11px;
    border-bottom: 1px solid #0a0e14;
  }
  .cost-row-label { color: #888; }

  /* Command Post */
  .command-section { margin-bottom: 12px; }
  .command-section h3 {
    font-size: 12px;
    color: #888;
    margin-bottom: 6px;
  }
  .btn {
    background: #1a3a1a;
    color: #33ff33;
    border: 1px solid #33ff33;
    padding: 4px 10px;
    font-family: inherit;
    font-size: 11px;
    cursor: pointer;
    border-radius: 2px;
    margin-right: 4px;
    margin-bottom: 4px;
  }
  .btn:hover { background: #2a5a2a; }
  .btn-danger { border-color: #ff3333; color: #ff3333; }
  .btn-danger:hover { background: #3a1a1a; }
  .btn-warn { border-color: #ff9933; color: #ff9933; }
  .btn-warn:hover { background: #3a2a1a; }

  select, input {
    background: #0a0e14;
    color: #33ff33;
    border: 1px solid #1a3a1a;
    padding: 4px 8px;
    font-family: inherit;
    font-size: 11px;
    border-radius: 2px;
  }

  .timestamp {
    color: #555;
    font-size: 10px;
  }

  #toast {
    display: none;
    position: fixed;
    bottom: 20px;
    right: 20px;
    background: #1a3a1a;
    border: 1px solid #33ff33;
    color: #33ff33;
    padding: 10px 16px;
    border-radius: 4px;
    font-family: inherit;
    font-size: 12px;
    z-index: 100;
  }

  .full-width { grid-column: 1 / -1; }
</style>
</head>
<body>

<header>
  <h1>ARMYCLAW <span>// Sand Table (沙盘)</span></h1>
  <div class="header-status">
    <span id="hq-status"><span class="status-dot dot-green"></span> HQ ONLINE</span>
    <span class="timestamp" id="last-refresh">--</span>
  </div>
</header>

<div class="grid">
  <!-- Panel 1: Battle Map (作战地图) -->
  <div class="panel full-width">
    <div class="panel-header">
      <h2>作战地图 BATTLE MAP</h2>
      <span class="timestamp" id="task-count">0 tasks</span>
    </div>
    <div class="panel-body">
      <div class="pipeline" id="pipeline"></div>
    </div>
  </div>

  <!-- Panel 2: Force Deployment (兵力部署) -->
  <div class="panel">
    <div class="panel-header">
      <h2>兵力部署 FORCE DEPLOYMENT</h2>
    </div>
    <div class="panel-body">
      <div class="agent-grid" id="agents"></div>
    </div>
  </div>

  <!-- Panel 3: Ammo Stats (弹药统计) -->
  <div class="panel">
    <div class="panel-header">
      <h2>弹药统计 AMMO STATS</h2>
    </div>
    <div class="panel-body">
      <div class="cost-grid" id="costs"></div>
      <div class="cost-breakdown" id="cost-breakdown"></div>
    </div>
  </div>

  <!-- Panel 4: Command Post (军令台) -->
  <div class="panel full-width">
    <div class="panel-header">
      <h2>军令台 COMMAND POST</h2>
    </div>
    <div class="panel-body">
      <div class="command-section">
        <h3>Task Control</h3>
        <div id="task-controls">
          <select id="ctrl-task-select"><option value="">Select task...</option></select>
          <button class="btn btn-warn" onclick="controlTask('pause')">PAUSE</button>
          <button class="btn" onclick="controlTask('resume')">RESUME</button>
          <button class="btn btn-danger" onclick="controlTask('cancel')">CANCEL</button>
        </div>
      </div>
      <div class="command-section">
        <h3>Agent Model Config (Hot Switch)</h3>
        <div id="model-config">
          <select id="cfg-role-select">
            <option value="adjutant">adjutant</option>
            <option value="chief_of_staff">chief_of_staff</option>
            <option value="operations">operations</option>
            <option value="inspector">inspector</option>
            <option value="engineer">engineer</option>
          </select>
          <select id="cfg-model-select">
            <option value="claude-opus-4-20250514">claude-opus-4</option>
            <option value="claude-sonnet-4-20250514">claude-sonnet-4</option>
            <option value="claude-haiku-4-5-20251001">claude-haiku-4.5</option>
          </select>
          <button class="btn" onclick="updateAgentConfig()">DEPLOY</button>
        </div>
      </div>
    </div>
  </div>
</div>

<div id="toast"></div>

<script>
const STATES = [
  'RECEIVED', 'SPLITTING', 'PLANNING', 'GATE1_REVIEW',
  'DISPATCHING', 'EXECUTING', 'GATE2_REVIEW', 'DELIVERING',
  'DONE', 'FAILED', 'CANCELLED', 'PAUSED'
];

const ROLE_NAMES = {
  adjutant: '副官 Adjutant',
  chief_of_staff: '参谋长 Chief of Staff',
  operations: '指挥官 Operations',
  inspector: '督察长 Inspector',
  engineer: '工兵 Engineer',
};

function showToast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.style.display = 'block';
  setTimeout(() => { el.style.display = 'none'; }, 2000);
}

async function fetchJSON(url) {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return res.json();
  } catch { return null; }
}

// Battle Map
async function refreshTasks() {
  const tasks = await fetchJSON('/api/tasks');
  if (!tasks) return;

  document.getElementById('task-count').textContent = tasks.length + ' tasks';

  const pipeline = document.getElementById('pipeline');
  pipeline.innerHTML = '';

  // Group tasks by state
  const grouped = {};
  for (const s of STATES) grouped[s] = [];
  for (const t of tasks) {
    if (grouped[t.state]) grouped[t.state].push(t);
  }

  // Only show columns that have tasks or are pipeline states
  const activeStates = STATES.filter(s =>
    grouped[s].length > 0 || ['RECEIVED','PLANNING','EXECUTING','DONE','FAILED'].includes(s)
  );

  for (const state of activeStates) {
    const col = document.createElement('div');
    col.className = 'pipeline-col';
    col.innerHTML = '<div class="pipeline-col-header">' + state + ' (' + grouped[state].length + ')</div>';

    for (const t of grouped[state]) {
      const card = document.createElement('div');
      card.className = 'task-card';
      card.innerHTML =
        '<div class="task-id">' + t.id.slice(0, 8) + '</div>' +
        '<div class="task-desc" title="' + escapeHtml(t.description) + '">' + escapeHtml(t.description.slice(0, 40)) + '</div>' +
        '<div class="task-priority priority-' + t.priority + '">' + t.priority.toUpperCase() + '</div>';
      col.appendChild(card);
    }

    pipeline.appendChild(col);
  }

  // Update task control dropdown
  const select = document.getElementById('ctrl-task-select');
  const prevVal = select.value;
  select.innerHTML = '<option value="">Select task...</option>';
  const activeTasks = tasks.filter(t => !['DONE','FAILED','CANCELLED'].includes(t.state));
  for (const t of activeTasks) {
    const opt = document.createElement('option');
    opt.value = t.id;
    opt.textContent = t.id.slice(0, 8) + ' — ' + t.state;
    select.appendChild(opt);
  }
  if (prevVal) select.value = prevVal;
}

// Force Deployment
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
    const dotClass = 'dot-' + h.status;
    const card = document.createElement('div');
    card.className = 'agent-card';
    card.innerHTML =
      '<div class="agent-name"><span class="status-dot ' + dotClass + '"></span> ' +
        (ROLE_NAMES[a.role] || a.role) + '</div>' +
      '<div class="agent-model">' + a.model + '</div>' +
      '<div class="agent-status">' + a.status +
        (a.current_task_id ? ' — ' + a.current_task_id.slice(0, 8) : '') + '</div>' +
      '<div class="timestamp">' + (a.last_activity || 'no activity') + '</div>';
    container.appendChild(card);
  }
}

// Ammo Stats
async function refreshCosts() {
  const costs = await fetchJSON('/api/costs');
  if (!costs) return;

  const costsEl = document.getElementById('costs');
  const dailyClass = costs.daily_total > 40 ? 'danger' : costs.daily_total > 20 ? 'warning' : '';
  costsEl.innerHTML =
    '<div class="cost-box">' +
      '<div class="cost-label">TODAY</div>' +
      '<div class="cost-value ' + dailyClass + '">$' + costs.daily_total.toFixed(2) + '</div>' +
    '</div>' +
    '<div class="cost-box">' +
      '<div class="cost-label">THIS WEEK</div>' +
      '<div class="cost-value">$' + costs.weekly_total.toFixed(2) + '</div>' +
    '</div>';

  const breakdown = document.getElementById('cost-breakdown');
  let html = '';
  for (const [agent, cost] of Object.entries(costs.by_agent || {})) {
    html += '<div class="cost-row"><span class="cost-row-label">' +
      agent + '</span><span>$' + Number(cost).toFixed(4) + '</span></div>';
  }
  breakdown.innerHTML = html;
}

// Task Control
async function controlTask(action) {
  const taskId = document.getElementById('ctrl-task-select').value;
  if (!taskId) { showToast('Select a task first'); return; }

  const res = await fetch('/api/tasks/control', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ task_id: taskId, action }),
  });
  const data = await res.json();
  showToast(action.toUpperCase() + ' — ' + (data.status || data.error));
}

// Agent Config
async function updateAgentConfig() {
  const role = document.getElementById('cfg-role-select').value;
  const model = document.getElementById('cfg-model-select').value;

  const res = await fetch('/api/agents/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ role, model, provider: 'anthropic', temperature: 0.3, max_tokens: 8192 }),
  });
  const data = await res.json();
  showToast('Config updated: ' + role + ' → ' + model);
}

function escapeHtml(str) {
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// Main refresh loop
async function refresh() {
  await Promise.all([refreshTasks(), refreshAgents(), refreshCosts()]);
  document.getElementById('last-refresh').textContent = new Date().toLocaleTimeString();
}

refresh();
setInterval(refresh, 2000);
</script>
</body>
</html>`;
}
