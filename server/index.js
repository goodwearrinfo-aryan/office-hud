// office-hud server — read-only window into an openalice-fleet hive.
// Serves REST + SSE (live fs.watch) and the built web app. Never writes to the hive.

const express = require('express');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PORT = Number(process.env.PORT || 4747);
const HOST = process.env.HOST || '127.0.0.1';
const HIVE = process.env.OFFICE_HUD_HIVE || path.join(os.homedir(), 'openalice-fleet', 'hive');
const HIVE_LABEL = process.env.OFFICE_HUD_LABEL || 'Fleet hive';
const FLEET_ROOT = path.dirname(HIVE);
const TRADING_BOT = process.env.TRADING_BOT_PATH || path.join(os.homedir(), 'trading-bot');
const FREE_HARNESS_URL = process.env.FREE_HARNESS_URL || 'http://127.0.0.1:8080';
const SESSION_STALE_MS = 5 * 60 * 1000;
const EVENT_TAIL_BYTES = 512 * 1024;
const JSON_CACHE_MS = 1000;

const app = express();
app.use(express.json());
app.use('/api', (req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD') return next();
  return res.status(405).json({ error: 'Office HUD API is read-only' });
});

// ---------- hive readers (defensive: hive may be missing or mid-write) ----------

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

const jsonCache = new Map();

function readJsonCached(file, fallback) {
  const now = Date.now();
  const cached = jsonCache.get(file);
  if (cached && now - cached.at < JSON_CACHE_MS) return cached.value;
  const value = readJson(file, fallback);
  jsonCache.set(file, { at: now, value });
  return value;
}

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function readJsonl(file, limit) {
  try {
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    const out = [];
    for (const line of lines) {
      try { out.push(JSON.parse(line)); } catch { /* skip partial line */ }
    }
    return limit ? out.slice(-limit) : out;
  } catch {
    return [];
  }
}

function readTail(file, maxBytes) {
  try {
    const size = fs.statSync(file).size;
    const start = Math.max(0, size - maxBytes);
    const length = size - start;
    const buffer = Buffer.alloc(length);
    const fd = fs.openSync(file, 'r');
    try {
      fs.readSync(fd, buffer, 0, length, start);
    } finally {
      fs.closeSync(fd);
    }
    let text = buffer.toString('utf8');
    if (start > 0) {
      const firstBreak = text.indexOf('\n');
      if (firstBreak >= 0) text = text.slice(firstBreak + 1);
    }
    return text;
  } catch {
    return '';
  }
}

function parseJsonLines(text) {
  const out = [];
  for (const line of text.split('\n').filter(Boolean)) {
    try { out.push(JSON.parse(line)); } catch {}
  }
  return out;
}

function timestampMs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value > 1e12 ? value : value * 1000;
  if (typeof value !== 'string' || !value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function listMessages(dir, limit = 50) {
  try {
    return fs.readdirSync(dir)
      .filter(f => f.endsWith('.json'))
      .sort()
      .slice(-limit)
      .map(f => {
        const msg = readJson(path.join(dir, f), null);
        if (!msg) return null;
        msg._file = f;
        return msg;
      })
      .filter(Boolean)
      .reverse(); // newest first
  } catch {
    return [];
  }
}

function hiveStatus() {
  const exists = fs.existsSync(HIVE);
  return { hive: HIVE, label: HIVE_LABEL, present: exists };
}

function getFleet() {
  return readJsonCached(path.join(HIVE, 'fleet.json'), { ts: null, agents: [] });
}

function getRegistry() {
  return readJsonCached(path.join(HIVE, 'registry.json'), { godId: null, agents: {} });
}

function getTasks() {
  return readJsonCached(path.join(HIVE, 'tasks.json'), { tasks: [] });
}

function getSessions() {
  return readJsonCached(path.join(HIVE, 'sessions.json'), { sessions: [] });
}

let eventCache = { at: 0, events: [] };

function getRecentEvents(limit = 1000, type = null) {
  const now = Date.now();
  if (now - eventCache.at >= JSON_CACHE_MS) {
    const eventsPath = path.join(HIVE, 'events.log');
    eventCache = { at: now, events: parseJsonLines(readTail(eventsPath, EVENT_TAIL_BYTES)).reverse() };
  }
  const filtered = type ? eventCache.events.filter(event => event.type === type) : eventCache.events;
  return filtered.slice(0, limit);
}

function sessionRows() {
  const now = Date.now();
  return (getSessions().sessions || []).map(session => {
    const heartbeat = timestampMs(session.last_heartbeat || session.updated_at || session.started_at);
    const heartbeatAgeSec = heartbeat == null ? null : Math.max(0, Math.floor((now - heartbeat) / 1000));
    const status = String(session.status || 'UNKNOWN').toUpperCase();
    const terminal = ['STOPPED', 'DEAD', 'ERROR', 'STALE'].includes(status);
    return {
      ...session,
      heartbeat_age_sec: heartbeatAgeSec,
      fresh: heartbeatAgeSec != null && heartbeatAgeSec <= SESSION_STALE_MS / 1000 && !terminal,
    };
  }).sort((a, b) => {
    if (a.fresh !== b.fresh) return a.fresh ? -1 : 1;
    return (b.heartbeat_age_sec ?? Infinity) - (a.heartbeat_age_sec ?? Infinity);
  });
}

function mergedAgents() {
  const fleet = getFleet();
  const reg = getRegistry();
  const fleetById = Object.fromEntries((fleet.agents || []).map(agent => [agent.id, agent]));
  const byId = new Map();

  for (const [id, agent] of Object.entries(reg.agents || {})) {
    byId.set(id, { ...agent, ...(fleetById[id] || {}), id });
  }
  for (const agent of fleet.agents || []) {
    if (!byId.has(agent.id)) byId.set(agent.id, agent);
  }

  const latestSession = new Map();
  for (const session of sessionRows().filter(session => session.fresh)) {
    if (!latestSession.has(session.agent_id)) latestSession.set(session.agent_id, session);
  }

  const currentTask = new Map();
  for (const task of getTasks().tasks || []) {
    if (String(task.status).toUpperCase() !== 'IN_PROGRESS' || !task.claimed_by) continue;
    if (!currentTask.has(task.claimed_by)) currentTask.set(task.claimed_by, task);
  }

  const displayOrder = { busy: 0, idle: 1, breaker: 2, offline: 3 };

  return [...byId.values()].map(agent => {
    const archived = !!agent.archived;
    const breaker = agent.breaker || (archived ? 'offline' : 'healthy');
    const session = latestSession.get(agent.id) || null;
    const task = currentTask.get(agent.id) || null;
    const currentTaskId = task?.task_id || session?.current_task_id || null;
    const fleetBusy = ['busy', 'working'].includes(String(agent.status || '').toLowerCase());
    let display = 'offline';
    if (archived) display = 'offline';
    else if (breaker !== 'healthy') display = 'breaker';
    else if (currentTaskId || fleetBusy) display = 'busy';
    else if (session) display = 'idle';
    return {
      id: agent.id,
      name: agent.name || agent.id,
      role: agent.role || 'worker',
      floor: agent.floor || null,
      isGod: !!agent.isGod,
      provider: agent.provider || null,
      model: agent.model || null,
      cwd: agent.cwd || null,
      cwdValid: agent.cwdValid !== false,
      status: currentTaskId ? 'working' : (session?.status?.toLowerCase() || agent.status || display),
      display,
      archived,
      breaker,
      tokens: agent.tokens ?? 0,
      usd: agent.usd ?? 0,
      sessionUsd: agent.sessionUsd ?? 0,
      lastTool: agent.lastTool || null,
      lastActiveSecAgo: agent.lastActiveSecAgo ?? null,
      inboxBacklog: agent.inboxBacklog ?? 0,
      onHold: !!agent.onHold,
      lastSeen: session?.heartbeat_age_sec != null ? Date.now() - session.heartbeat_age_sec * 1000 : (agent.lastSeen || null),
      sessionId: session?.session_id || null,
      sessionStatus: session?.status || null,
      processId: session?.process_id || null,
      heartbeatAgeSec: session?.heartbeat_age_sec ?? null,
      sessionFresh: !!session,
      currentTaskId,
      currentTaskTitle: task?.title || null,
    };
  }).sort((a, b) => {
    if (a.isGod !== b.isGod) return a.isGod ? -1 : 1;
    const displayDiff = (displayOrder[a.display] ?? 9) - (displayOrder[b.display] ?? 9);
    return displayDiff || a.id.localeCompare(b.id);
  });
}

// ---------- trading bot readers ----------

function getTradingBotConfig() {
  const configPath = path.join(TRADING_BOT, 'config.yaml');
  try {
    const yaml = require('js-yaml');
    const config = yaml.load(fs.readFileSync(configPath, 'utf8'));
    // Sanitize sensitive data
    const sanitized = JSON.parse(JSON.stringify(config));
    if (sanitized.exchange) {
      sanitized.exchange.apiKey = sanitized.exchange.apiKey ? '***' : '';
      sanitized.exchange.secret = sanitized.exchange.secret ? '***' : '';
    }
    if (sanitized.nvidia) {
      sanitized.nvidia.api_key = sanitized.nvidia.api_key ? '***' : '';
    }
    if (sanitized.helius) {
      sanitized.helius.api_key = sanitized.helius.api_key ? '***' : '';
    }
    return sanitized;
  } catch {
    return null;
  }
}

function getBacktestResults() {
  const resultsPath = path.join(TRADING_BOT, 'backtest_5year_results.json');
  return readJson(resultsPath, {});
}

function getWalkForwardResults() {
  const resultsPath = path.join(TRADING_BOT, 'walkforward_top3_results.json');
  return readJson(resultsPath, {});
}

function getStrategies() {
  const strategiesDir = path.join(TRADING_BOT, 'strategies');
  try {
    if (!fs.existsSync(strategiesDir)) return {};
    return fs.readdirSync(strategiesDir)
      .filter(f => f.endsWith('.py') || f.endsWith('.js'))
      .map(f => ({ file: f, path: path.join(strategiesDir, f) }));
  } catch {
    return [];
  }
}

function getLiveMetrics() {
  // Try to read from trading bot database/logs
  const dbPath = path.join(TRADING_BOT, 'database.db');
  const logPath = path.join(TRADING_BOT, 'trading_bot.log');

  let dbHasTables = false;
  let tableNames = [];
  if (fs.existsSync(dbPath)) {
    try {
      const sqlite3 = require('sqlite3').verbose();
      const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READONLY);
      return new Promise((resolve) => {
        db.all("SELECT name FROM sqlite_master WHERE type='table'", [], (err, rows) => {
          db.close();
          if (!err && rows && rows.length > 0) {
            tableNames = rows.map(r => r.name);
            resolve({
              dbExists: true,
              dbHasTables: true,
              tableNames,
              logExists: fs.existsSync(logPath),
              logSize: fs.existsSync(logPath) ? fs.statSync(logPath).size : 0,
            });
          } else {
            resolve({
              dbExists: true,
              dbHasTables: false,
              tableNames: [],
              logExists: fs.existsSync(logPath),
              logSize: fs.existsSync(logPath) ? fs.statSync(logPath).size : 0,
            });
          }
        });
      });
    } catch {
      return Promise.resolve({
        dbExists: true,
        dbHasTables: false,
        tableNames: [],
        logExists: fs.existsSync(logPath),
        logSize: fs.existsSync(logPath) ? fs.statSync(logPath).size : 0,
      });
    }
  }
  return Promise.resolve({
    dbExists: false,
    dbHasTables: false,
    tableNames: [],
    logExists: fs.existsSync(logPath),
    logSize: fs.existsSync(logPath) ? fs.statSync(logPath).size : 0,
  });
}

function getLaunchdStatus() {
  const launchdDir = path.join(FLEET_ROOT, 'launchd');
  try {
    if (!fs.existsSync(launchdDir)) return { services: [] };
    return {
      services: fs.readdirSync(launchdDir)
        .filter(f => f.endsWith('.plist'))
        .map(f => ({ file: f, path: path.join(launchdDir, f) }))
    };
  } catch {
    return { services: [] };
  }
}

function getAdherenceLogs() {
  const logPath = path.join(TRADING_BOT, 'adherence_cron.log');
  const errPath = path.join(TRADING_BOT, 'adherence_cron.err');
  return {
    log: readText(logPath),
    err: readText(errPath),
  };
}

function getRoster() {
  const rosterPath = path.join(FLEET_ROOT, 'roster.json');
  return readJson(rosterPath, { agents: [] });
}

function getGraphifyStats() {
  const gfDir = path.join(FLEET_ROOT, 'graphify-out');
  try {
    if (!fs.existsSync(gfDir)) return { exists: false };
    const files = fs.readdirSync(gfDir);
    return {
      exists: true,
      files: files.slice(0, 20),
      count: files.length,
    };
  } catch {
    return { exists: false };
  }
}

function getGraphifyGraph() {
  const graphPath = path.join(FLEET_ROOT, 'graphify-out', 'graph.json');
  try {
    return readJson(graphPath, { nodes: [], links: [] });
  } catch {
    return { nodes: [], links: [] };
  }
}

function getQueueSummary() {
  const now = Date.now();
  const tasks = getTasks().tasks || [];
  const byStatus = {};
  for (const task of tasks) {
    const status = String(task.status || 'UNKNOWN').toUpperCase();
    byStatus[status] = (byStatus[status] || 0) + 1;
  }
  const inProgress = tasks.filter(task => String(task.status).toUpperCase() === 'IN_PROGRESS');
  const staleInProgress = inProgress.filter(task => {
    const heartbeat = timestampMs(task.heartbeat || task.claimed_at);
    return heartbeat == null || now - heartbeat > SESSION_STALE_MS;
  });
  const completions = getRecentEvents(5000, 'task_completed');
  const completionHour = new Map();
  const currentHour = Math.floor(now / 3600000) * 3600000;
  for (let i = 11; i >= 0; i--) completionHour.set(currentHour - i * 3600000, 0);
  let completionsLastHour = 0;
  let failedLastHour = 0;
  for (const event of completions) {
    const eventTime = timestampMs(event.timestamp);
    if (eventTime == null) continue;
    const hour = Math.floor(eventTime / 3600000) * 3600000;
    if (completionHour.has(hour)) completionHour.set(hour, completionHour.get(hour) + 1);
    if (now - eventTime <= 3600000) {
      completionsLastHour++;
      if (String(event.result || '').startsWith('[LLM call failed')) failedLastHour++;
    }
  }
  return {
    total: tasks.length,
    queued: byStatus.QUEUED || 0,
    inProgress: inProgress.length,
    complete: byStatus.COMPLETE || 0,
    failed: byStatus.FAILED || 0,
    staleInProgress: staleInProgress.length,
    byStatus,
    inProgressTasks: inProgress.slice(0, 50).map(task => ({
      task_id: task.task_id,
      title: task.title,
      assigned_agent: task.assigned_agent || null,
      claimed_by: task.claimed_by || null,
      heartbeat: task.heartbeat || null,
      heartbeat_age_sec: timestampMs(task.heartbeat || task.claimed_at) == null
        ? null
        : Math.max(0, Math.floor((now - timestampMs(task.heartbeat || task.claimed_at)) / 1000)),
    })),
    completionsLastHour,
    failedLastHour,
    completionsByHour: [...completionHour.entries()].map(([hour, count]) => ({ hour: new Date(hour).toISOString(), count })),
    recentCompletions: completions.slice(0, 20),
  };
}

function getOfficeManagerStatus() {
  const status = readJsonCached(path.join(HIVE, 'agents', 'office-manager', 'status.json'), {});
  const session = sessionRows().find(item => item.agent_id === 'office-manager') || null;
  const logTail = readTail(path.join(HIVE, 'agents', 'office-manager', 'agent.log'), 64 * 1024);
  const lastLogLine = logTail.split('\n').filter(Boolean).pop() || null;
  return {
    registered: !!getRegistry().agents?.['office-manager'],
    running: !!session?.fresh,
    status: session?.fresh ? (status.status || 'RUNNING') : 'OFFLINE',
    currentTask: status.current_task || session?.current_task_id || null,
    lastActivity: status.last_activity || session?.last_heartbeat || null,
    session,
    lastLogLine,
    queue: getQueueSummary(),
  };
}

async function getHarnessHealth() {
  const checkedAt = new Date().toISOString();
  try {
    const response = await fetch(`${FREE_HARNESS_URL}/health`, { signal: AbortSignal.timeout(2000) });
    const data = await response.json();
    return {
      ok: response.ok,
      url: `${FREE_HARNESS_URL}/health`,
      status: data.status || (response.ok ? 'ok' : 'degraded'),
      provider: data.provider || 'none',
      model: data.model || 'none',
      error: null,
      checkedAt,
    };
  } catch (error) {
    return {
      ok: false,
      url: `${FREE_HARNESS_URL}/health`,
      status: 'offline',
      provider: 'none',
      model: 'none',
      error: error.message,
      checkedAt,
    };
  }
}

// ---------- routes ----------

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, ...hiveStatus(), ts: Date.now() });
});

app.get('/api/summary', (_req, res) => {
  res.json({ ...hiveStatus(), fleet: getFleet(), godId: getRegistry().godId, agents: mergedAgents() });
});

app.get('/api/agents', (_req, res) => {
  res.json({ agents: mergedAgents() });
});

app.get('/api/agents/:id', (req, res) => {
  const id = String(req.params.id).replace(/[^a-zA-Z0-9_-]/g, '');
  const agent = mergedAgents().find(item => item.id === id);
  if (!agent) return res.status(404).json({ error: 'agent not found', id });
  const dir = path.join(HIVE, 'agents', id);
  res.json({
    agent,
    identity: readText(path.join(dir, 'identity.md')),
    memory: readText(path.join(dir, 'memory.md')),
    inbox: listMessages(path.join(dir, 'inbox')),
    outbox: listMessages(path.join(dir, 'outbox')),
    sessions: sessionRows().filter(session => session.agent_id === id),
    currentTasks: (getTasks().tasks || []).filter(task => task.claimed_by === id && String(task.status).toUpperCase() === 'IN_PROGRESS'),
    recentEvents: getRecentEvents(1000).filter(event => event.agent_id === id).slice(0, 10),
  });
});

app.get('/api/ledger', (req, res) => {
  const source = req.query.source === 'events' ? 'events' : 'log';
  const kind = req.query.kind ? String(req.query.kind) : null;
  const limit = Math.min(Number(req.query.limit) || 500, 2000);
  let events = source === 'events'
    ? getRecentEvents(2000)
    : readJsonl(path.join(HIVE, 'log.jsonl'), 2000).reverse();
  if (kind) events = events.filter(event => source === 'events' ? event.type === kind : event.kind === kind);
  res.json({ source, events: events.slice(0, limit).map(event => ({ ...event, type: event.type || event.kind || 'event' })) });
});

app.get('/api/tasks', (req, res) => {
  if (req.query.summary === '1' || req.query.summary === 'true') {
    return res.json(getQueueSummary());
  }
  res.json(getTasks());
});

app.get('/api/queue', (_req, res) => {
  res.json(getQueueSummary());
});

app.get('/api/events', (req, res) => {
  const type = req.query.type ? String(req.query.type) : null;
  const limit = Math.min(Number(req.query.limit) || 500, 5000);
  res.json({ events: getRecentEvents(limit, type) });
});

app.get('/api/office-manager', (_req, res) => {
  res.json(getOfficeManagerStatus());
});

app.get('/api/harness/health', async (_req, res) => {
  res.json(await getHarnessHealth());
});

app.get('/api/sessions', (_req, res) => {
  res.json({ sessions: sessionRows() });
});

app.get('/api/processes', (_req, res) => {
  const processes = readJson(path.join(HIVE, 'processes.json'), { processes: [] });
  res.json(processes);
});

app.get('/api/projects', (_req, res) => {
  const projects = readJson(path.join(HIVE, 'projects.json'), { projects: [] });
  res.json(projects);
});

// ---------- trading bot routes ----------

app.get('/api/trading/backtests', (_req, res) => {
  res.json({ backtest: getBacktestResults(), walkforward: getWalkForwardResults() });
});

app.get('/api/trading/strategies', (_req, res) => {
  res.json({ config: getTradingBotConfig(), strategies: getStrategies() });
});

app.get('/api/trading/live', async (_req, res) => {
  res.json(await getLiveMetrics());
});

app.get('/api/trading/ops', (_req, res) => {
  res.json({ launchd: getLaunchdStatus(), adherence: getAdherenceLogs(), roster: getRoster() });
});

app.get('/api/knowledge/graphify', (_req, res) => {
  res.json(getGraphifyStats());
});

app.get('/api/knowledge/graphify/data', (_req, res) => {
  res.json(getGraphifyGraph());
});

app.get('/api/knowledge/docs', (_req, res) => {
  const docsDir = FLEET_ROOT;
  try {
    const mdFiles = fs.readdirSync(docsDir)
      .filter(f => f.endsWith('.md'))
      .map(f => ({ file: f, path: path.join(docsDir, f) }));
    res.json({ docs: mdFiles });
  } catch {
    res.json({ docs: [] });
  }
});

// ---------- Cloud API / LLM routes ----------
app.get('/api/llm/providers', (_req, res) => {
  const { LLMClient } = require(path.join(HIVE, 'lib', 'llm', 'client'));
  const client = new (require(path.join(HIVE, 'lib', 'llm', 'client')).LLMClient)();
  res.json({ providers: client.getAllProviders(), health: client.getProviderHealth() });
});

app.get('/api/llm/costs', (_req, res) => {
  const { getAllCosts, getTotalCosts, getAgentCosts } = require(path.join(HIVE, 'lib', 'llm', 'cost'));
  const agents = mergedAgents();
  const costs = {};
  for (const a of agents) {
    costs[a.id] = getAgentCosts(a.id);
  }
  res.json({ agents: costs, total: getTotalCosts() });
});

app.post('/api/llm/costs/reset/daily', (_req, res) => {
  const { resetDailyCosts } = require(path.join(HIVE, 'lib', 'llm', 'cost'));
  resetDailyCosts();
  res.json({ ok: true });
});

app.post('/api/llm/costs/reset/monthly', (_req, res) => {
  const { resetMonthlyCosts } = require(path.join(HIVE, 'lib', 'llm', 'cost'));
  resetMonthlyCosts();
  res.json({ ok: true });
});

app.get('/api/llm/rate-limits', (_req, res) => {
  const { getRateLimitStatus } = require(path.join(HIVE, 'lib', 'llm', 'rateLimit'));
  res.json({});
});

app.get('/api/llm/circuit-breakers', (_req, res) => {
  const { getAllBreakers } = require(path.join(HIVE, 'lib', 'llm', 'circuitBreaker'));
  res.json({ breakers: getAllBreakers() });
});

app.post('/api/llm/circuit-breakers/reset', (req, res) => {
  const { resetAllBreakers } = require(path.join(HIVE, 'lib', 'llm', 'circuitBreaker'));
  resetAllBreakers();
  res.json({ ok: true });
});

app.post('/api/llm/test', async (req, res) => {
  const { LLMClient } = require(path.join(HIVE, 'lib', 'llm', 'client'));
  const { selectModelForTask } = require(path.join(HIVE, 'lib', 'llm', 'router'));
  const client = new (require(path.join(HIVE, 'lib', 'llm', 'client')).LLMClient)();
  const { prompt, agentId, taskType, provider, model } = req.body;
  try {
    const result = await client.call(prompt, { agentId: agentId || 'test', taskType: taskType || 'default', provider, preferredModel: model });
    res.json({ ok: true, result });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ---------- Polymarket Paper Trading ----------
app.get('/api/polymarket/status', async (_req, res) => {
  const configPath = path.join(HIVE, 'polymarket_config.json');
  let config = { paper_only: true, engine_path: '/Users/aryanagarwal/Documents/polymarket.research/profitability_engine_fixed.py' };
  if (fs.existsSync(configPath)) config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  res.json({ ...config, running: false }); // TODO: check if engine process exists
});

app.post('/api/polymarket/start', async (req, res) => {
  // Safety gate: verify paper_only=true
  const configPath = path.join(HIVE, 'polymarket_config.json');
  const config = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, 'utf8')) : { paper_only: true };
  if (!config.paper_only) return res.status(400).json({ ok: false, error: 'Paper-only mode required' });
  // TODO: spawn profitability_engine_fixed.py as managed process
  res.json({ ok: true, message: 'Paper engine start requested (not yet implemented)' });
});

app.post('/api/polymarket/stop', async (_req, res) => {
  // TODO: stop engine process
  res.json({ ok: true, message: 'Stop requested (not yet implemented)' });
});

// ---------- Office Python Classification ----------
app.get('/api/office/classification', (_req, res) => {
  const fs = require('fs');
  const path = require('path');
  const officeDir = path.join(FLEET_ROOT, 'office');
  try {
    if (!fs.existsSync(officeDir)) return res.json({ classified: [] });
    const files = fs.readdirSync(officeDir).filter(f => f.endsWith('.py'));
    const results = [];
    for (const file of files) {
      const content = fs.readFileSync(path.join(officeDir, file), 'utf8');
      const lines = content.split('\n');
      let category = 'unknown';
      if (content.includes('agent_manager') || content.includes('office_manager')) category = 'manager';
      else if (content.includes('def main()') && content.includes('spawn')) category = 'worker';
      else if (content.includes('launchd') || content.includes('systemd') || content.includes('service')) category = 'service';
      else if (content.includes('runtime') || content.includes('agent_manager')) category = 'runtime';
      else if (content.includes('util') || content.includes('helper') || content.includes('tool')) category = 'utility';
      else if (content.includes('test') || content.includes('Test')) category = 'test';
      else if (lines.length < 50) category = 'utility';
      results.push({ file, category, lines: lines.length });
    }
    res.json({ classified: results });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- Recovery System ----------
app.get('/api/recovery/stats', async (_req, res) => {
  const { getRecoveryStats } = require(path.join(HIVE, 'lib', 'recovery'));
  res.json(await getRecoveryStats());
});

app.post('/api/recovery/manual/:agentId', async (req, res) => {
  const { manualRecover } = require(path.join(HIVE, 'lib', 'recovery'));
  await manualRecover(req.params.agentId);
  res.json({ ok: true });
});

app.post('/api/recovery/start', async (_req, res) => {
  const { startRecoveryEngine } = require(path.join(HIVE, 'lib', 'recovery'));
  await startRecoveryEngine();
  res.json({ ok: true });
});

app.post('/api/recovery/stop', async (_req, res) => {
  const { stopRecoveryEngine } = require(path.join(HIVE, 'lib', 'recovery'));
  await stopRecoveryEngine();
  res.json({ ok: true });
});

// ---------- JEV / Task Queue ----------
app.get('/api/jev/stats', (_req, res) => {
  const tasks = readJson(path.join(HIVE, 'tasks.json'), { tasks: [] });
  const byStatus = {};
  for (const t of tasks.tasks) {
    byStatus[t.status] = (byStatus[t.status] || 0) + 1;
  }
  res.json({ tasks: tasks.tasks.length, byStatus, queues: {} }); // TODO: implement queues
});

// ---------- Sessions with reattach ----------
app.post('/api/sessions/:id/reattach', async (req, res) => {
  const { reattachSession } = require(path.join(HIVE, 'lib', 'session'));
  const { agentId, processId } = req.body;
  const ok = reattachSession(req.params.id, agentId, processId);
  res.json({ ok });
});

// ---------- SSE: push "changed" whenever the hive moves ----------

const sseClients = new Set();
app.get('/api/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.write('event: hello\ndata: {}\n\n');
  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
});

let broadcastTimer = null;
function broadcast() {
  for (const res of sseClients) {
    try { res.write('event: change\ndata: {}\n\n'); } catch { /* client gone */ }
  }
}
try {
  fs.watch(HIVE, { recursive: true }, () => {
    clearTimeout(broadcastTimer);
    broadcastTimer = setTimeout(broadcast, 400);
  });
} catch (e) {
  console.warn('[office-hud] fs.watch unavailable:', e.message);
}

// ---------- static web app ----------

const dist = path.join(__dirname, '..', 'web', 'dist');
if (fs.existsSync(dist)) {
  app.use(express.static(dist));
  app.get('*', (_req, res) => res.sendFile(path.join(dist, 'index.html')));
}

// Create HTTP server with retry logic for EADDRINUSE
const http = require('http');
const server = http.createServer(app);

function startServer(port, retries = 10, delay = 500) {
  return new Promise((resolve, reject) => {
    server.listen(port, HOST, () => {
      console.log(`[office-hud] hive: ${HIVE} (${fs.existsSync(HIVE) ? 'found' : 'MISSING'})`);
      console.log(`[office-hud] open → http://localhost:${port}`);
      resolve(server);
    });

    server.once('error', (err) => {
      if (err.code === 'EADDRINUSE' && retries > 0) {
        console.log(`[office-hud] port ${port} in use, retrying in ${delay}ms... (${retries} retries left)`);
        setTimeout(() => {
          resolve(startServer(port, retries - 1, delay * 1.5));
        }, delay);
      } else {
        reject(err);
      }
    });
  });
}

let serverInstance;
startServer(PORT).then(s => {
  serverInstance = s;
  console.log(`[office-hud] hive: ${HIVE} (${fs.existsSync(HIVE) ? 'found' : 'MISSING'})`);
  console.log(`[office-hud] open → http://localhost:${PORT}`);
}).catch(err => {
  console.error('[office-hud] failed to start server:', err);
  process.exit(1);
});

// Graceful shutdown
function shutdown(signal) {
  console.log(`[office-hud] received ${signal}, shutting down gracefully...`);
  if (serverInstance) {
    serverInstance.closeAllConnections();
    serverInstance.close((err) => {
      if (err) {
        console.error('[office-hud] server close error:', err);
      } else {
        console.log('[office-hud] server closed');
      }
      process.exit(0);
    });
    // Force exit after 2 seconds if graceful shutdown fails
    setTimeout(() => {
      console.error('[office-hud] forced shutdown after timeout');
      process.exit(1);
    }, 2000);
  } else {
    process.exit(0);
  }
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
