#!/usr/bin/env python3
"""Apply the office-hud live architecture edits to server/index.js.

Kept as a script so the transformation is reviewable and re-runnable against a
fresh checkout; each replacement asserts it matched exactly once.
"""
import sys

PATH = '/Users/a/trading/oh-live/office-hud/server/index.js'

EDITS = []


def edit(old, new, label):
    EDITS.append((old, new, label))


# 1. requires + engine handles
edit(
    """const crypto = require('crypto');
const { execFileSync } = require('child_process');""",
    """const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { LiveHub } = require('./lib/live_hub');
const { AlertEngine } = require('./lib/alerts');
const replay = require('./lib/replay');

let liveHub = null;
let alertEngine = null;""",
    'requires',
)

# 2. extract inline route bodies into named producers
edit(
    """app.get('/api/projects', (_req, res) => {
  const projects = readJson(path.join(HIVE, 'projects.json'), { projects: [] });
  res.json(projects);
});""",
    """function getProjects() {
  return readJson(path.join(HIVE, 'projects.json'), { projects: [] });
}

app.get('/api/projects', (_req, res) => {
  res.json(getProjects());
});""",
    'getProjects',
)

edit(
    """app.get('/api/processes', (_req, res) => {
  const processes = readJson(path.join(HIVE, 'processes.json'), { processes: [] });
  res.json(processes);
});""",
    """function getProcesses() {
  return readJson(path.join(HIVE, 'processes.json'), { processes: [] });
}

app.get('/api/processes', (_req, res) => {
  res.json(getProcesses());
});""",
    'getProcesses',
)

edit(
    """app.get('/api/verify', (_req, res) => {
  const st = readJsonCached(path.join(HIVE, 'verify_state.json'), null);
  if (!st) return res.json({ present: false });
  const tally = st.verdict_tally || {};
  const scanned = (tally.OK || 0) + (tally.DODGE || 0) + (tally.SHORT || 0) + (tally.FAIL || 0) + (tally.EMPTY || 0);
  const realWorkRatePct = scanned > 0 ? Math.round(((tally.OK || 0) / scanned) * 1000) / 10 : null;
  res.json({
    present: true,
    at: st.at,
    verdict_tally: tally,
    requeued: st.requeued || [],
    quarantined: st.quarantined || [],
    realWorkRatePct,
  });
});""",
    """function getVerifyState() {
  const st = readJsonCached(path.join(HIVE, 'verify_state.json'), null);
  if (!st) return { present: false };
  const tally = st.verdict_tally || {};
  const scanned = (tally.OK || 0) + (tally.DODGE || 0) + (tally.SHORT || 0) + (tally.FAIL || 0) + (tally.EMPTY || 0);
  const realWorkRatePct = scanned > 0 ? Math.round(((tally.OK || 0) / scanned) * 1000) / 10 : null;
  return {
    present: true,
    at: st.at,
    verdict_tally: tally,
    requeued: st.requeued || [],
    quarantined: st.quarantined || [],
    realWorkRatePct,
  };
}

app.get('/api/verify', (_req, res) => {
  res.json(getVerifyState());
});""",
    'getVerifyState',
)

# 3. replace the SSE block with the resource table + watcher + REST mirror
edit(
    """// ---------- SSE: push "changed" whenever the hive moves ----------""",
    """// ---------- live data: resource snapshots + change detection ----------

let watcher = null;
let watchTimer = null;
const resourceSignatures = new Map();

function build(name, produce, options = {}) {
  return { name, produce, signature: options.signature };
}

/**
 * Every panel reads a named resource rather than a bespoke URL. The socket and
 * the REST mirror both serve from this table, so a push and a poll can never
 * disagree about shape.
 */
const RESOURCES = {
  summary: build('summary', () => ({ ...hiveStatus(), fleet: getFleet(), godId: getRegistry().godId, agents: mergedAgents() })),
  agents: build('agents', () => ({ agents: mergedAgents() })),
  queue: build('queue', () => getQueueSummary()),
  projects: build('projects', () => getProjects()),
  taskCounts: build('taskCounts', () => ({ counts: getFloorTaskCounts() })),
  sessions: build('sessions', () => ({ sessions: sessionRows() })),
  processes: build('processes', () => getProcesses()),
  verify: build('verify', () => getVerifyState()),
  officeManager: build('officeManager', () => getOfficeManagerStatus()),
  jevStats: build('jevStats', () => {
    const raw = readJson(path.join(HIVE, 'tasks.json'), {});
    const list = Array.isArray(raw) ? raw : (Array.isArray(raw?.tasks) ? raw.tasks : []);
    const byStatus = {};
    for (const t of list) {
      const status = (t && t.status) || 'unknown';
      byStatus[status] = (byStatus[status] || 0) + 1;
    }
    return { tasks: list.length, byStatus, queues: {} };
  }),
  services: build('services', () => getServiceHealth(), { signature: () => 'probe' }),
  harness: build('harness', () => getHarnessHealth(), { signature: () => 'probe' }),
  providers: build('providers', () => {
    const client = getLLMClient();
    return { providers: client.getAllProviders(), health: client.getProviderHealth() };
  }),
  breakers: build('breakers', () => {
    const { getAllBreakers } = require(path.join(HIVE, 'lib', 'llm', 'circuitBreaker'));
    return { breakers: getAllBreakers() };
  }),
  costs: build('costs', () => {
    const { getTotalCosts, getAgentCosts } = require(path.join(HIVE, 'lib', 'llm', 'cost'));
    const agents = {};
    for (const a of mergedAgents()) agents[a.id] = getAgentCosts(a.id);
    return { agents, total: getTotalCosts() };
  }),
  events: build('events', () => ({ events: getRecentEvents(300) })),
  knowledge: build('knowledge', () => getGraphifyCommunities()),
  polymarket: build('polymarket', () => {
    try {
      const state = loadPolymarketState();
      return { present: !!state, state: state?.state ?? null };
    } catch (error) {
      return { present: false, state: null, error: error.message };
    }
  }),
  alerts: build('alerts', () => (
    alertEngine
      ? alertEngine.snapshot()
      : { alerts: [], counts: { critical: 0, warn: 0, info: 0 }, unacknowledged: 0, history: [] }
  )),
};

const resourceNames = () => Object.keys(RESOURCES);

function buildSnapshot(name) {
  const resource = RESOURCES[name];
  if (!resource) throw requestError(`Unknown resource ${name}`, 404);
  return resource.produce();
}

const buildSnapshotAsync = (name) => Promise.resolve(buildSnapshot(name));

/** Stable short hash, so a signature is one word instead of a whole payload. */
function hashOf(text) {
  return crypto.createHash('sha1').update(String(text)).digest('hex').slice(0, 16);
}

function signatureOf(name) {
  const resource = RESOURCES[name];
  if (!resource) return 'error';
  try {
    // Probing resources are async, so they carry an explicit cheap signature
    // instead of being stringified synchronously.
    if (resource.signature) return resource.signature();
    return hashOf(JSON.stringify(buildSnapshot(name)));
  } catch {
    return 'error';
  }
}

/** Names whose content signature differs from the cached one. */
function changedResources(names = resourceNames()) {
  const changed = [];
  for (const name of names) {
    const next = signatureOf(name);
    if (resourceSignatures.get(name) !== next) {
      resourceSignatures.set(name, next);
      changed.push(name);
    }
  }
  return changed;
}

function startWatch() {
  if (watcher) return;
  try {
    watcher = fs.watch(HIVE, { recursive: true }, () => {
      clearTimeout(watchTimer);
      watchTimer = setTimeout(onHiveChanged, 400);
    });
    watcher.on('error', (err) => {
      // An unhandled 'error' event on the watcher would be an uncaught exception.
      console.warn('[office-hud] hive watcher error:', err.message);
    });
  } catch (e) {
    console.warn('[office-hud] fs.watch unavailable:', e.message);
  }
}

function onHiveChanged() {
  watchTimer = null;
  const changed = changedResources();
  if (changed.length) liveHub?.publish(changed);
  broadcastSse();
  if (alertEngine) liveHub?.publishAlerts(alertEngine.evaluate());
}

// ---------- SSE (kept for older clients; the socket is preferred) ----------

const sseClients = new Set();
const SSE_MAX_CLIENTS = 16;
app.get('/api/stream', (req, res) => {
  if (sseClients.size >= SSE_MAX_CLIENTS) {
    return res.status(503).json({ error: 'too many stream clients' });
  }
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.write('event: hello\\ndata: {}\\n\\n');
  sseClients.add(res);
  const drop = () => {
    sseClients.delete(res);
    try { res.end(); } catch { /* already gone */ }
  };
  req.on('close', drop);
  res.on('error', drop);
  // Comment frames keep proxies and idle-timeout middleboxes from closing the stream.
  const heartbeat = setInterval(() => {
    if (res.writableEnded) return drop();
    try { res.write(': ping\\n\\n'); } catch { drop(); }
  }, 25000);
  res.on('close', () => clearInterval(heartbeat));
});

function broadcastSse() {
  for (const res of [...sseClients]) {
    if (res.writableEnded) {
      sseClients.delete(res);
      continue;
    }
    try {
      // A client too slow to drain its buffer is dropped rather than allowed to
      // grow the socket buffer without bound.
      if (res.write('event: change\\ndata: {}\\n\\n') === false) {
        sseClients.delete(res);
        try { res.end(); } catch { /* already gone */ }
      }
    } catch {
      sseClients.delete(res);
    }
  }
}

// ---------- alerts ----------

app.get('/api/alerts', (_req, res) => {
  if (!alertEngine) {
    return res.json({ alerts: [], counts: { critical: 0, warn: 0, info: 0 }, unacknowledged: 0, history: [] });
  }
  res.json(alertEngine.snapshot());
});

app.post('/api/alerts/ack-all', (_req, res) => {
  if (!alertEngine) return res.json({ ok: true, acked: 0 });
  res.json({ ok: true, acked: alertEngine.ackAll() });
});

app.post('/api/alerts/:fingerprint/ack', (req, res) => {
  if (!alertEngine) return sendError(res, 503, 'unavailable', 'alert engine not running');
  const ok = alertEngine.ack(String(req.params.fingerprint));
  if (!ok) return sendError(res, 404, 'unknown_alert', 'No active alert with that fingerprint');
  liveHub?.publishAlerts(alertEngine.snapshotList());
  res.json({ ok: true });
});

app.post('/api/alerts/:fingerprint/unack', (req, res) => {
  if (!alertEngine) return sendError(res, 503, 'unavailable', 'alert engine not running');
  const ok = alertEngine.unack(String(req.params.fingerprint));
  if (!ok) return sendError(res, 404, 'unknown_alert', 'No active alert with that fingerprint');
  liveHub?.publishAlerts(alertEngine.snapshotList());
  res.json({ ok: true });
});

// ---------- time machine ----------

app.get('/api/replay/window', (_req, res) => {
  res.json(replay.window(HIVE));
});

app.get('/api/replay', (req, res) => {
  const at = Number(req.query.at);
  if (!Number.isFinite(at) || at <= 0) {
    return sendError(res, 400, 'bad_request', 'at must be an epoch milliseconds timestamp');
  }
  const hours = Math.min(
    Math.max(Number(req.query.hours) || replay.DEFAULT_WINDOW_HOURS, 1),
    replay.MAX_WINDOW_HOURS
  );
  res.json(replay.reconstruct({ hive: HIVE, when: new Date(at), windowHours: hours, agents: mergedAgents() }));
});

// ---------- REST mirror of the resource table ----------

app.get('/api/live/resources', (_req, res) => {
  res.json({
    resources: resourceNames(),
    paths: Object.fromEntries(resourceNames().map((name) => [name, `/api/live/${name}`])),
    socket: '/api/live/socket',
  });
});

app.get('/api/live/status', (_req, res) => {
  res.json(liveHub ? liveHub.status() : { clients: 0, sequence: 0, viewers: [] });
});

app.get('/api/live/:name', async (req, res) => {
  const name = String(req.params.name);
  if (!RESOURCES[name]) return sendError(res, 404, 'unknown_resource', `Unknown resource ${name}`);
  try {
    res.json(await buildSnapshotAsync(name));
  } catch (error) {
    sendError(res, error.statusCode || 500, 'resource_failed', error.message);
  }
});

// ---------- SSE placeholder (replaced above) ----------""",
    'resource table',
)

# 4. remove the old watcher (now startWatch/onHiveChanged own it)
edit(
    """try {
  fs.watch(HIVE, { recursive: true }, () => {
    clearTimeout(broadcastTimer);
    broadcastTimer = setTimeout(broadcast, 400);
  }).on('error', (err) => {
    // An unhandled 'error' event on the watcher would be an uncaught exception.
    console.warn('[office-hud] hive watcher error:', err.message);
  });
} catch (e) {
  console.warn('[office-hud] fs.watch unavailable:', e.message);
}

""",
    '',
    'old watcher',
)

# 5. bootstrap / exports
edit(
    """// Create HTTP server with retry logic for EADDRINUSE
const http = require('http');
const server = http.createServer(app);

let announcedReady = false;""",
    """// ---------- process bootstrap ----------
// Everything above is pure wiring: requiring this module yields the express app
// without binding a port, so the test suite can drive it on an ephemeral port
// against a fixture hive.

const http = require('http');

let announcedReady = false;""",
    'bootstrap header',
)

edit(
    """function startServer(port, retries = 10, delay = 500) {
  return new Promise((resolve, reject) => {
    server.listen(port, HOST, () => {""",
    """const createServer = () => http.createServer(app);

function startServer(port = PORT, retries = 10, delay = 500) {
  const server = createServer();
  return new Promise((resolve, reject) => {
    server.listen(port, HOST, () => {""",
    'startServer factory',
)

edit(
    """          resolve(startServer(port, retries - 1, delay * 1.5));""",
    """          resolve(startServer(port, retries - 1, delay * 2));""",
    'backoff',
)

edit(
    """let serverInstance;
startServer(PORT).then(s => {
  serverInstance = s;
  announceReady(PORT);
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
process.on('SIGINT', () => shutdown('SIGINT'));""",
    """let serverInstance = null;

function shutdown(signal) {
  console.log(`[office-hud] received ${signal}, shutting down gracefully...`);
  liveHub?.close();
  alertEngine?.stop();
  if (watcher) { try { watcher.close(); } catch { /* already closed */ } }
  if (!serverInstance) { process.exit(0); return; }
  const server = serverInstance;
  server.closeAllConnections();
  server.close((err) => {
    if (err) console.error('[office-hud] server close error:', err);
    else console.log('[office-hud] server closed');
    process.exit(0);
  });
  // Force exit after 2 seconds if graceful shutdown fails
  setTimeout(() => {
    console.error('[office-hud] forced shutdown after timeout');
    process.exit(1);
  }, 2000);
}

function bootstrap() {
  // Express 4 does not catch async handler rejections; without these a single
  // throw kills the process and launchd restarts it.
  process.on('unhandledRejection', (reason) => {
    console.error('[office-hud] unhandled rejection:', reason && reason.stack ? reason.stack : reason);
  });
  process.on('uncaughtException', (err) => {
    console.error('[office-hud] uncaught exception:', err && err.stack ? err.stack : err);
  });
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  startWatch();

  // Analyzers read a synchronous hive snapshot; socket resources may be async.
  const readSnapshot = () => ({
    summary: buildSnapshot('summary'),
    queue: buildSnapshot('queue'),
    breakers: buildSnapshot('breakers'),
    costs: buildSnapshot('costs'),
    services: buildSnapshot('services'),
    harness: buildSnapshot('harness'),
  });
  alertEngine = new AlertEngine({ read: readSnapshot, intervalMs: 30000 });
  alertEngine.start();

  return startServer(PORT).then((server) => {
    serverInstance = server;
    // The live socket rides the same HTTP server as the REST API.
    liveHub = new LiveHub({
      snapshot: buildSnapshotAsync,
      alerts: () => (alertEngine ? alertEngine.snapshotList() : []),
      heartbeatMs: 25000,
    });
    liveHub.attach(server);
    announceReady(PORT);
    return server;
  }).catch((err) => {
    console.error('[office-hud] failed to start server:', err);
    process.exit(1);
  });
}

if (require.main === module) {
  bootstrap();
}

module.exports = {
  app,
  bootstrap,
  createServer,
  startServer,
  // internals the test suite asserts against
  internals: {
    readJson, readJsonCached, readText, readTail, readJsonl, clampLimit,
    getFloorTaskCounts, getGraphifyCommunities, withHiveFileLock,
    isLocalRequest, isIdentifier, requestError, sendError, buildSnapshot,
    HIVE, FLEET_ROOT, SERVICE_PORTS, JSON_CACHE_MS, RESOURCES,
  },
};""",
    'bootstrap + exports',
)


def main():
    with open(PATH, encoding='utf-8') as handle:
        source = handle.read()

    failures = []
    for old, new, label in EDITS:
        count = source.count(old)
        if count != 1:
            failures.append(f'{label}: expected 1 match, found {count}')
    if failures:
        for line in failures:
            print('FAIL', line, file=sys.stderr)
        return 1

    for old, new, label in EDITS:
        source = source.replace(old, new)
        print('ok', label)

    with open(PATH, 'w', encoding='utf-8') as handle:
        handle.write(source)
    print('WROTE', PATH)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
