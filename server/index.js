// office-hud server — operations window into an openalice-fleet hive.
// Serves REST + SSE and routes confirmed local commands into JEV.

const express = require('express');
const fs = require('fs');
const path = require('path');
const os = require('os');
const net = require('net');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { LiveHub } = require('./lib/live_hub');
const { AlertEngine } = require('./lib/alerts');
const { AutonomyController } = require('./lib/autonomy');
const replay = require('./lib/replay');
const {
  isDangerousJarvisPrompt,
  isIdentifier,
  routeJarvisCommand,
  evaluateJarvisCommand,
  acceptance: jarvisAcceptance,
} = require('./jarvisPolicy');

let liveHub = null;
let alertEngine = null;
let autonomy = null;

const PORT = Number(process.env.PORT || 4747);
const HOST = process.env.HOST || '127.0.0.1';
const HIVE = process.env.OFFICE_HUD_HIVE || path.join(os.homedir(), 'openalice-fleet', 'hive');
process.env.OPENALICE_HIVE = HIVE;
let hiveFileLock = null;
try { hiveFileLock = require(path.join(HIVE, 'lib', 'file_lock.js')).withFileLock; } catch {}
const HIVE_LABEL = process.env.OFFICE_HUD_LABEL || 'Fleet hive';
const FLEET_ROOT = path.dirname(HIVE);

// The hardened local-only gate lives in its own module, not inline here. A
// socket-address check is not sufficient: Tailscale Serve terminates the tailnet
// connection on this host and then opens a NEW loopback connection to the app, so
// a remote device and a local browser both arrive as 127.0.0.1. An earlier
// version checked only the socket, and every gated route below was reachable
// from any device on the tailnet with no auth. Keeping the decision in a module
// no in-flight rewrite touches is deliberate: that inline check was reverted five
// times in one session, and once reached production wide open.
const { isLocalRequest } = require('./lib/local_only');
const { TerminalManager } = require('./lib/terminal/manager');
const { redactCommand, redactEntry, redactAll } = require('./lib/redact');
const alphaInsiderStats = require('./alphainsider_stats_route');
// Route modules kept in their own files so a rewrite of this one cannot silently
// drop them -- the failure mode that lost the AlphaInsider stats routes twice.
const strategySearchRoute = require('./strategy_search_route');
const liveDigestRoute = require('./live_digest_route');
const openaliceStatus = require('./openaliceStatus');
const frozenFeedsRoute = require('./frozen_feeds_route');
  const floorRoute = require('./floor_route');
const { spawnPolicyAudit } = require('./spawnPolicy');
  const { registerEvidenceRoutes } = require('./evidenceRoutes');
const { registerWedgedRoutes } = require('./lib/wedgedProcesses');
const { classifyTaskTruth, summarizeTasks } = require('./taskTruth.js');
const { processView, redactRecord } = require('./processTruth');

const terminalManager = new TerminalManager({
  hive: HIVE,
  ...(process.env.OFFICE_MAX_TERMINALS ? { maxConcurrent: Number(process.env.OFFICE_MAX_TERMINALS) } : {}),
});
const POLYMARKET_ROOT = '/Users/a/polymarket';
const POLYMARKET_RESEARCH = path.join(POLYMARKET_ROOT, 'research');
const POLYMARKET_STATE_PATH = path.join(POLYMARKET_RESEARCH, 'engine_state.json');
const POLYMARKET_EXCLUSIONS_PATH = path.join(POLYMARKET_RESEARCH, 'market_exclusions.json');
const POLYMARKET_BACKUP_DIR = path.join(POLYMARKET_ROOT, 'backups');
const POLYMARKET_LAUNCHD_LABEL = 'com.aryan.pm-engine';
const POLYMARKET_LAUNCHD_INSTALLED_PLIST = '/Users/a/Library/LaunchAgents/com.aryan.pm-engine.plist';
const POLYMARKET_LAUNCHD_TARGET = `gui/${typeof process.getuid === 'function' ? process.getuid() : 501}/${POLYMARKET_LAUNCHD_LABEL}`;
const TRADING_BOT = process.env.TRADING_BOT_PATH || path.join(os.homedir(), 'trading-bot');
const PAPER_BENCHMARK = process.env.PAPER_BENCHMARK_PATH || path.join(os.homedir(), 'trading', 'paper-benchmark');
const FREE_HARNESS_URL = process.env.FREE_HARNESS_URL || 'http://127.0.0.1:8080';
const SERVICE_PORTS = [
  { name: 'Free harness', port: 8080, role: 'OpenAI API' },
  { name: 'WebSocket', port: 8081, role: 'event stream' },
  { name: 'Bridge', port: 19593, role: 'Anthropic bridge' },
  { name: 'Dashboard', port: 3002, role: 'public dashboards' },
  { name: 'Office HUD', port: PORT, role: 'operations console' },
  { name: 'Ollama', port: 11434, role: 'local model runtime' },
  { name: 'Trading bot', port: 8765, role: 'paper/testnet' },
  { name: 'LLM gate', port: 8091, role: 'unsupervised' },
  { name: 'Cloudflared', port: 20241, role: 'tunnel metrics' },
];
// Browser-facing services, reachable through this one origin. The request path
// never contributes a host and verbs are restricted to GET/HEAD, so this cannot
// be turned into a general-purpose proxy onto arbitrary local ports.
const PORTAL_SERVICES = new Map([
  ['dash', { port: 3002, label: 'Trading Lab', role: 'dashboards + JSON feeds', browser: true }],
  ['bot', { port: 8765, label: 'Bot API', role: 'paper/testnet state', browser: true }],
  ['ollama', { port: 11434, label: 'Ollama', role: 'local model runtime', browser: true }],
  ['tunnel', { port: 20241, label: 'Cloudflared', role: 'tunnel metrics', browser: false }],
  ['harness', { port: 8080, label: 'Free harness', role: 'OpenAI-compatible API', browser: false }],
]);
const SESSION_STALE_MS = 5 * 60 * 1000;
const EVENT_TAIL_BYTES = 512 * 1024;
const JSON_CACHE_MS = 1000;
const jarvisCommandTimestamps = [];

// Explicitly allowlisted POST routes. Jarvis commands only enqueue work.
const SAFE_POST = new Set([
  '/api/llm/costs/reset/daily',
  '/api/llm/costs/reset/monthly',
  '/api/llm/circuit-breakers/reset',
  '/api/llm/test',
  '/api/polymarket/start',
  '/api/polymarket/stop',
  '/api/polymarket/markets/exclude',
  '/api/polymarket/markets/include',
  '/api/polymarket/trades/clear',
  '/api/recovery/manual',
  '/api/recovery/start',
  '/api/recovery/stop',
  '/api/recovery/manual/:agentId',
'/api/jarvis/command',
    // Judgement, not action. This route writes nothing: it runs a command through
    // the same pure validator the write path uses and returns the verdict, so the
    // console can show the risk tier and the owner without the browser holding its
    // own copy of the danger rule. It is here rather than behind the read-only
    // middleware because it is a POST only for its body, and the alternative —
    // smuggling a prompt through a GET — would put command text in access logs.
    '/api/jarvis/preview',
  ]);
// Alert acknowledgement and autonomy decisions are operator state on the HUD
// itself, not hive writes. Each handler still requires a local caller.
const SAFE_POST_PREFIXES = [
  '/api/alerts/',
  '/api/autonomy/',
  // Terminal control runs arbitrary commands, so it is the strongest thing on
  // this list, and it is listed as a prefix purely so the global read-only gate
  // lets the request reach its own handler. That handler applies the hardened
  // Tailscale-aware local check AND the command allowlist, so widening this
  // prefix grants nothing on its own -- but keep it under review: any new route
  // beginning /api/terminals/ inherits the reach of this entry.
  '/api/terminals/',
  // Autopilot operator actions: land, dismiss, policy, and a manual tick. These
  // reach only the autopilot's own state; they cannot merge, push, or write to a
  // checkout, and each one re-checks that the caller is local. Listed for the
  // same reason as /api/terminals/ — the global gate would otherwise 405 them
  // before their own handler ever runs.
  '/api/autopilot/',
];

const app = express();
app.disable('x-powered-by');

// A page on any origin can reach 127.0.0.1, and browsers will send whatever
// Host header the page's URL implies. Reject requests whose Host is not a
// loopback name, which is what stops DNS rebinding from reaching the API.
const ALLOWED_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1', '0.0.0.0']);
const serverName = os.hostname().split('.')[0];
if (serverName) ALLOWED_HOSTS.add(serverName);

/** Strip the port without mangling a bare IPv6 literal. */
function hostOnly(hostHeader) {
  const value = String(hostHeader).trim();
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(value);
  if (bracketed) return bracketed[1].toLowerCase();
  // More than one colon and no brackets means the whole thing is the address.
  if ((value.match(/:/g) || []).length > 1) return value.toLowerCase();
  return value.split(':')[0].toLowerCase();
}

// Extra exact hostnames this service is reached by, e.g. the Tailscale FQDN
// that the serve proxy rewrites to. Matched exactly on purpose: a suffix rule
// like "startsWith(serverName)" would reopen DNS rebinding, since an attacker
// can obtain a valid certificate for as-mac-mini.evil.com and point it at
// 127.0.0.1.
const EXTRA_ALLOWED_HOSTS = new Set(
  String(process.env.OFFICE_HUD_ALLOWED_HOSTS || "")
    .split(",")
    .map((value) => hostOnly(value))
    .filter(Boolean),
);

function hostIsAllowed(hostHeader) {
  if (!hostHeader) return false;
  const host = hostOnly(hostHeader);
  return ALLOWED_HOSTS.has(host) || EXTRA_ALLOWED_HOSTS.has(host);
}

app.use((req, res, next) => {
  if (hostIsAllowed(req.headers.host)) return next();
  return sendError(res, 421, 'bad_host', `Host ${req.headers.host} is not allowed`);
});

app.use(express.json());
app.use('/api', (req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD') return next();
  const p = req.originalUrl.split('?')[0];
  if (req.method === 'POST'
    && (SAFE_POST.has(p)
      || p.startsWith('/api/recovery/manual/')
      || SAFE_POST_PREFIXES.some((prefix) => p.startsWith(prefix)))) return next();
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

/**
 * Cache keyed on the file's mtime and size rather than a time-to-live. A stat
 * is microseconds; re-parsing a multi-megabyte tasks.json is milliseconds, so
 * this is both fresher than a TTL and far cheaper on a busy hive. A TTL cache
 * would also let a write land inside the window and be served stale.
 */
function readJsonCached(file, fallback) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    jsonCache.delete(file);
    return fallback;
  }
  const cached = jsonCache.get(file);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    cached.at = Date.now();
    return cached.value;
  }
  const value = readJson(file, fallback);
  jsonCache.set(file, { at: Date.now(), mtimeMs: stat.mtimeMs, size: stat.size, value });
  return value;
}

function clampLimit(value, fallback, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.floor(parsed), max);
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

// One read, two shapes.
//
// `text` is what the existing callers want and keeps readTail's original
// contract exactly: a read that fails yields ''. The other fields exist because
// '' is indistinguishable from "the file was there and held nothing", and a
// route handed only the string cannot say which of the two it got. That is the
// defect /api/jarvis/audit was found with: a missing file, an unreadable one,
// and a genuinely empty log all arrived as the same empty array.
//
// readTail() keeps its exact behaviour and is now a one-liner over this, so the
// routes that already treat '' as "nothing there" cannot regress.
function readTailResult(file, maxBytes) {
  let size;
  try {
    size = fs.statSync(file).size;
  } catch (error) {
    return {
      text: '',
      source_bytes: null,
      read_bytes: 0,
      error: `${error.code || error.name}: ${error.message}`,
    };
  }
  const start = Math.max(0, size - maxBytes);
  const length = size - start;
  try {
    const buffer = Buffer.alloc(length);
    const fd = fs.openSync(file, 'r');
    let read = 0;
    try {
      read = fs.readSync(fd, buffer, 0, length, start);
    } finally {
      fs.closeSync(fd);
    }
    // Decode only the bytes that were actually read. Buffer.alloc zero-fills, so
    // a short read used to leave NUL padding inside the string; those lines then
    // failed to parse and were dropped as though they had never been written.
    // The parsed result is the same either way, but now it is right for the real
    // reason instead of by accident.
    let text = buffer.subarray(0, read).toString('utf8');
    if (start > 0) {
      const firstBreak = text.indexOf('\n');
      if (firstBreak >= 0) text = text.slice(firstBreak + 1);
    }
    return { text, source_bytes: size, read_bytes: read, error: null };
  } catch (error) {
    return {
      text: '',
      source_bytes: size,
      read_bytes: 0,
      error: `${error.code || error.name}: ${error.message}`,
    };
  }
}

function readTail(file, maxBytes) {
  return readTailResult(file, maxBytes).text;
}

// Reports what it could not read. A line that fails to parse is dropped in both
// shapes; the difference is that only this one says how many were dropped, which
// is the difference between "there are no events" and "these bytes were not
// events". Both used to look identical from the outside.
function parseJsonLinesCounted(text) {
  const out = [];
  let unparsed = 0;
  for (const line of text.split('\n').filter(Boolean)) {
    try { out.push(JSON.parse(line)); } catch { unparsed += 1; }
  }
  return { items: out, unparsed };
}

function parseJsonLines(text) {
  return parseJsonLinesCounted(text).items;
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

// How old a roster reading may be before it stops being evidence about now.
// Fifteen minutes is comfortably longer than the collector cadence, so a
// slightly late write is still fresh and a genuinely frozen file is not.
const ROSTER_STALE_SECONDS = 900;

function rosterFreshness(fleet) {
  const recorded = fleet ? (fleet.ts ?? fleet.updated_at) : null;
  const observedAt = timestampMs(recorded);
  if (observedAt == null) {
    // Unmeasurable is not fresh. A roster whose age cannot be established is
    // reported stale and not live rather than given the benefit of the doubt,
    // which is the exact failure this contract exists to prevent.
    return { stale: true, live: false, age_seconds: null, observed_at: null,
             stale_after_seconds: ROSTER_STALE_SECONDS };
  }
const age = Math.max(0, Math.round((Date.now() - observedAt) / 1000));
    const stale = age > ROSTER_STALE_SECONDS;
    return { stale, live: !stale, age_seconds: age, observed_at: observedAt,
             stale_after_seconds: ROSTER_STALE_SECONDS };
  }

  function getRegistry() {
  return readJsonCached(path.join(HIVE, 'registry.json'), { godId: null, agents: {} });
}

function getTasks() {
  return readJsonCached(path.join(HIVE, 'tasks.json'), { tasks: [] });
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function requestError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function sendError(res, status, code, message, details) {
  const error = { code, message };
  if (details !== undefined) error.details = details;
  return res.status(status).json({ ok: false, error });
}


const HIVE_LOCK_STALE_MS = 30000;

function withHiveFileLock(lockPath, callback) {
  if (typeof hiveFileLock !== 'function') throw requestError('Hive file lock is unavailable', 503);
  // hive/lib/file_lock.js spins on a blocking Atomics.wait with no timeout, so a
  // lock left behind by a killed writer would freeze the whole event loop. Refuse
  // early instead of queueing behind a live holder.
  try {
    const stat = fs.statSync(lockPath);
    if (Date.now() - stat.mtimeMs < HIVE_LOCK_STALE_MS) {
      throw requestError('Hive is locked by another writer — retry shortly', 503);
    }
  } catch (error) {
    if (error && error.statusCode) throw error;
    // ENOENT (or any stat failure) means the lock is free.
  }
  return hiveFileLock(lockPath, callback);
}

function atomicWriteFile(file, contents) {
  const temporaryPath = `${file}.tmp.${process.pid}.${crypto.randomBytes(4).toString('hex')}`;
  try {
    fs.writeFileSync(temporaryPath, contents, { encoding: 'utf8', flag: 'wx' });
    fs.renameSync(temporaryPath, file);
  } finally {
    try { fs.unlinkSync(temporaryPath); } catch {}
  }
}

function atomicWriteJson(file, value) {
  atomicWriteFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

function jarvisTaskSummary(task) {
  return {
    task_id: task.task_id,
    title: task.title,
    objective: task.objective || '',
    source: task.source || null,
    requested_by: task.requested_by || null,
    actor: task.actor || 'office-hud-local',
    route: task.route || null,
    routing: task.routing || null,
    status: String(task.status || 'UNKNOWN').toUpperCase(),
    priority: task.priority || 'normal',
    assigned_agent: task.assigned_agent || null,
    claimed_by: task.claimed_by || null,
    created_at: task.created_at || null,
    updated_at: task.updated_at || task.created_at || null,
    completed_at: task.completed_at || null,
    result: task.result || null,
    risk: task.risk || 'normal',
  };
}

function getJarvisTasks(limit = 50) {
  const boundedLimit = Math.min(Math.max(Number(limit) || 50, 1), 100);
  return (getTasks().tasks || [])
    .filter(task => task.source === 'jarvis' || task.requested_by === 'jarvis')
    .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')))
    .slice(0, boundedLimit)
    .map(jarvisTaskSummary);
}

// What the assistant was asked, and what it was told. Read from the same
// events.log every other event route reads, bounded to the last EVENT_TAIL_BYTES.
//
// That bound is the entire reason this is an envelope rather than an array, and on
// the live hive it was not theoretical. Measured before this change: events.log was
// 11.6MB and held exactly one real jarvis_command, emitted 2026-10-03T00:19:14Z,
// starting at byte 87,695. The 512KB tail window opens at byte 11,090,145, so the
// only command ever issued sat far outside it and the route answered {"events":[]}
// for it. That is worse than an ambiguous shape -- it reported "the assistant was
// never asked anything" on the one occasion it had been asked something and the
// read simply had not reached that far.
//
// So every outcome is named, `events` is still an array on all of them, and
// reachable_window says out loud that this is a bounded read rather than the whole
// history. Four states, and no two of them share a response:
//
//   ok          read succeeded and the window held events
//   empty       read succeeded and the window held no events at all -> nothing to report
//   unparsed    bytes were read but no line parsed as an event -> cannot be trusted
//   unreadable  the source could not be opened or read        -> cannot be looked up
//
// `ok` is true only for the first two, so success-with-no-data and could-not-read
// are never the same response.
function getJarvisAudit(limit = 50) {
  const boundedLimit = Math.min(Math.max(Number(limit) || 50, 1), 100);
  // Read first: this is the call that refreshes eventCache and fills in the read
  // outcome the status below reports on.
  const events = getRecentEvents(5000, 'jarvis_command').slice(0, boundedLimit).map(event => ({
    task_id: event.task_id || null,
    actor: event.actor || 'office-hud-local',
    target: event.target || null,
    requested_target: event.requested_target || null,
    routing: event.routing || null,
    priority: event.priority || null,
    risk: event.risk || 'normal',
    prompt_length: event.prompt_length || 0,
    prompt_hash: event.prompt_hash || null,
    timestamp: event.timestamp || null,
  }));

  const scanned = eventCache.events.length;
  const sourceBytes = eventCache.source_bytes;

  let ok;
  let status;
  let error = eventCache.read_error;
  if (eventCache.read_error) {
    ok = false;
    status = 'unreadable';
  } else if (scanned === 0 && eventCache.unparsed > 0) {
    // Bytes were there and were not events. Reporting [] here would claim the
    // assistant was never asked anything on the strength of a corrupt file.
    ok = false;
    status = 'unparsed';
    error = `${eventCache.unparsed} line(s) read but none parsed as an event`;
  } else if (scanned === 0) {
    // The honest empty: the file was readable and genuinely held nothing.
    ok = true;
    status = 'empty';
  } else {
    ok = true;
    status = 'ok';
  }

  return {
    ok,
    status,
    error,
    events,
    // count and limit travel together so a count sitting at the limit cannot be
    // read as "that was all of them".
    count: events.length,
    limit: boundedLimit,
    // How many events the window yielded before filtering. With count:0 this is
    // what separates "looked at 4,317 events and none were jarvis_command" from
    // "had nothing to look at".
    scanned,
    source: 'events.log',
    reachable_window: true,
    window: {
      source_bytes: sourceBytes,
      read_bytes: eventCache.read_bytes,
      limit_bytes: EVENT_TAIL_BYTES,
      // True whenever history exists above the window, which on the live hive it
      // does: 11MB of events behind a 512KB read.
      truncated: sourceBytes == null ? null : sourceBytes > EVENT_TAIL_BYTES,
      // Lines in the window that did not parse. Normally 0; non-zero is the
      // silent-truncation case made visible instead of dropped.
      unparsed_lines: eventCache.unparsed,
    },
    checkedAt: new Date().toISOString(),
  };
}

function emitJarvisEvent(event) {
  try {
    const { emitEvent } = require(path.join(HIVE, 'lib', 'event_bus.js'));
    emitEvent(event);
  } catch {
    try {
      fs.appendFileSync(path.join(HIVE, 'events.log'), `${JSON.stringify(event)}\n`);
    } catch {
      throw requestError('Unable to emit Jarvis event', 503);
    }
  }
}

function enqueueJarvisCommand({ prompt, target, priority, confirmed, typeConfirmation }) {
    // Judged by the same pure function the preview route calls, so a preview can
    // never describe a write that behaves differently. The order is preserved:
    // fields first, then confirmation, then type-to-confirm.
    const verdict = evaluateJarvisCommand({ prompt, target, priority });
    const gate = jarvisAcceptance(verdict, { confirmed, typeConfirmation });
    if (!gate.accepted) throw requestError(gate.reason, gate.statusCode);
    // Renamed on the way out. The verdict names these prompt/priority/target
    // because it is a wire payload; the task row has used normalized* since before
    // the extraction, so the rename happens here rather than at 40 call sites.
    const { prompt: normalizedPrompt, priority: normalizedPriority, target: normalizedTarget } = verdict.normalized;
    const dangerous = verdict.requiresTypeConfirmation;
    const tasksPath = path.join(HIVE, 'tasks.json');
    if (!fs.existsSync(tasksPath)) throw requestError('JEV task queue is unavailable', 503);
    const now = new Date().toISOString();
    const taskId = `jarvis-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
    const routed = { assignedAgent: verdict.assignedAgent, routing: verdict.routing };
    const task = {
    task_id: taskId,
    title: `[Jarvis] ${normalizedPrompt.slice(0, 100)}`,
    objective: normalizedPrompt,
    priority: normalizedPriority,
    status: 'QUEUED',
    assigned_agent: routed.assignedAgent,
    source: 'jarvis',
    requested_by: 'jarvis',
    actor: 'office-hud-local',
    route: 'JEV',
    routing: routed.routing,
    risk: dangerous ? 'destructive' : 'normal',
    created_at: now,
    updated_at: now,
    attempts: 0,
  };
  withHiveFileLock(path.join(HIVE, '.task_lock'), () => {
    const data = readJson(tasksPath, null);
    if (!isPlainObject(data) || !Array.isArray(data.tasks)) throw requestError('JEV task queue is invalid', 503);
    data.tasks.push(task);
    atomicWriteJson(tasksPath, data);
  });
  emitJarvisEvent({
    type: 'jarvis_command',
    task_id: taskId,
    source: 'jarvis',
    route: 'JEV',
    actor: 'office-hud-local',
    target: routed.assignedAgent,
    requested_target: normalizedTarget,
    routing: routed.routing,
    priority: normalizedPriority,
    risk: task.risk,
    prompt_length: normalizedPrompt.length,
    prompt_hash: crypto.createHash('sha256').update(normalizedPrompt).digest('hex'),
    timestamp: now,
  });
  return jarvisTaskSummary(task);
}

function normalizeMarketId(value) {
  if (typeof value !== 'string') throw requestError('market_id must be a 0x-prefixed 64-character hexadecimal market id', 400);
  const marketId = value.trim().toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(marketId)) {
    throw requestError('market_id must be a 0x-prefixed 64-character hexadecimal market id', 400);
  }
  return marketId;
}

function normalizeExclusionReason(value) {
  if (value === undefined) return 'Excluded via Office HUD';
  if (typeof value !== 'string') throw requestError('reason must be a string between 1 and 500 characters', 400);
  const reason = value.trim();
  if (!reason || reason.length > 500 || /[\u0000-\u001f\u007f]/.test(reason)) {
    throw requestError('reason must be a string between 1 and 500 characters', 400);
  }
  return reason;
}

function validateExclusion(entry, index) {
  if (!isPlainObject(entry)) throw requestError(`market exclusion ${index + 1} must be an object`, 409);
  const allowedKeys = new Set(['market_id', 'reason', 'excluded_at']);
  if (Object.keys(entry).some(key => !allowedKeys.has(key))) {
    throw requestError(`market exclusion ${index + 1} contains unsupported fields`, 409);
  }
  const marketId = normalizeMarketId(entry.market_id);
  if (typeof entry.reason !== 'string') throw requestError(`market exclusion ${index + 1} has an invalid reason`, 409);
  const reason = normalizeExclusionReason(entry.reason);
  if (typeof entry.excluded_at !== 'string' || !Number.isFinite(Date.parse(entry.excluded_at))) {
    throw requestError(`market exclusion ${index + 1} has an invalid excluded_at`, 409);
  }
  return { market_id: marketId, reason, excluded_at: entry.excluded_at };
}

function readMarketExclusions() {
  if (!fs.existsSync(POLYMARKET_EXCLUSIONS_PATH)) {
    return { present: false, valid: true, path: POLYMARKET_EXCLUSIONS_PATH, exclusions: [], error: null };
  }
  try {
    const data = JSON.parse(fs.readFileSync(POLYMARKET_EXCLUSIONS_PATH, 'utf8'));
    if (!isPlainObject(data) || !Array.isArray(data.exclusions)) throw new Error('exclusions must be an array');
    const seen = new Set();
    const exclusions = data.exclusions.map(validateExclusion);
    for (const exclusion of exclusions) {
      if (seen.has(exclusion.market_id)) throw new Error(`duplicate market_id ${exclusion.market_id}`);
      seen.add(exclusion.market_id);
    }
    return { present: true, valid: true, path: POLYMARKET_EXCLUSIONS_PATH, exclusions, error: null };
  } catch (error) {
    return { present: true, valid: false, path: POLYMARKET_EXCLUSIONS_PATH, exclusions: [], error: error.message };
  }
}

function validateRecordArray(value, name) {
  if (!Array.isArray(value) || value.some(item => !isPlainObject(item))) {
    throw requestError(`${name} must be an array of objects`, 409);
  }
}

function validateRecordObject(value, name) {
  if (!isPlainObject(value) || Object.values(value).some(item => !isPlainObject(item))) {
    throw requestError(`${name} must be an object containing objects`, 409);
  }
}

function validateArrayRecordObject(value, name) {
  if (!isPlainObject(value) || Object.values(value).some(item => !Array.isArray(item))) {
    throw requestError(`${name} must be an object containing arrays`, 409);
  }
}

function validatePolymarketState(state) {
  if (!isPlainObject(state)) throw requestError('engine state must be a JSON object', 409);
  validateRecordArray(state.trade_history, 'trade_history');
  validateRecordArray(state.signal_history, 'signal_history');
  if (!isPlainObject(state.performance_metrics)) throw requestError('performance_metrics must be an object', 409);
  if (!isPlainObject(state.execution_engine)) throw requestError('execution_engine must be an object', 409);
  const execution = state.execution_engine;
  validateRecordObject(execution.orders, 'execution_engine.orders');
  validateRecordArray(execution.fills, 'execution_engine.fills');
  validateRecordObject(execution.positions, 'execution_engine.positions');
  validateRecordArray(execution.closed_positions, 'execution_engine.closed_positions');
  validateRecordObject(execution.order_books, 'execution_engine.order_books');
  validateArrayRecordObject(execution.price_history, 'execution_engine.price_history');
  validateRecordArray(execution.audit_log, 'execution_engine.audit_log');
  return state;
}

function loadPolymarketState() {
  if (!fs.existsSync(POLYMARKET_STATE_PATH)) return null;
  let raw;
  let state;
  try {
    raw = fs.readFileSync(POLYMARKET_STATE_PATH, 'utf8');
    state = JSON.parse(raw);
  } catch (error) {
    throw requestError(`engine state is unreadable: ${error.message}`, 500);
  }
  return { raw, state: validatePolymarketState(state) };
}

function summarizePolymarketMarkets(state, exclusions) {
  if (!state) {
    return {
      present: false,
      state_path: POLYMARKET_STATE_PATH,
      updated_at: null,
      summary: { trades: 0, signals: 0, orders: 0, fills: 0, open_positions: 0, closed_positions: 0, markets: 0 },
      markets: [],
    };
  }
  const rows = new Map();
  const exclusionsById = new Map(exclusions.map(item => [item.market_id, item]));
  const rowFor = value => {
    const marketId = String(value || '').trim();
    if (!marketId) return null;
    if (!rows.has(marketId)) {
      rows.set(marketId, {
        market_id: marketId,
        trades: 0,
        open_trades: 0,
        closed_trades: 0,
        signals: 0,
        orders: 0,
        fills: 0,
        open_positions: 0,
        closed_positions: 0,
        order_book: false,
        last_price: null,
        last_update: null,
        categories: new Set(),
      });
    }
    return rows.get(marketId);
  };
  const tradeSides = {};
  let openTrades = 0;
  for (const trade of state.trade_history) {
    const row = rowFor(trade.market_id);
    if (!row) continue;
    row.trades++;
    if (trade.exit_timestamp == null) row.open_trades++;
    else row.closed_trades++;
    if (trade.exit_timestamp == null) openTrades++;
    const side = String(trade.side || 'UNKNOWN').toUpperCase();
    tradeSides[side] = (tradeSides[side] || 0) + 1;
  }
  const signalDecisions = {};
  for (const signal of state.signal_history) {
    const row = rowFor(signal.market_id);
    if (!row) continue;
    row.signals++;
    const decision = String(signal.decision || 'UNKNOWN').toUpperCase();
    signalDecisions[decision] = (signalDecisions[decision] || 0) + 1;
    if (signal.market_category) row.categories.add(String(signal.market_category));
  }
  const execution = state.execution_engine;
  const orderStatuses = {};
  for (const order of Object.values(execution.orders)) {
    const row = rowFor(order.market_id);
    if (!row) continue;
    row.orders++;
    const status = String(order.status || 'UNKNOWN').toUpperCase();
    orderStatuses[status] = (orderStatuses[status] || 0) + 1;
  }
  for (const fill of execution.fills) {
    const row = rowFor(fill.market_id);
    if (row) row.fills++;
  }
  for (const position of Object.values(execution.positions)) {
    const row = rowFor(position.market_id);
    if (row) row.open_positions++;
  }
  for (const position of execution.closed_positions) {
    const row = rowFor(position.market_id);
    if (row) row.closed_positions++;
  }
  for (const [marketId, book] of Object.entries(execution.order_books)) {
    const row = rowFor(marketId);
    if (!row) continue;
    row.order_book = true;
    row.last_price = book.last_price ?? null;
    row.last_update = book.last_update ?? null;
  }
  const markets = [...rows.values()]
    .sort((a, b) => a.market_id.localeCompare(b.market_id))
    .map(row => {
      const exclusion = exclusionsById.get(row.market_id) || null;
      return {
        market_id: row.market_id,
        trades: row.trades,
        open_trades: row.open_trades,
        closed_trades: row.closed_trades,
        signals: row.signals,
        orders: row.orders,
        fills: row.fills,
        open_positions: row.open_positions,
        closed_positions: row.closed_positions,
        order_book: row.order_book,
        last_price: row.last_price,
        last_update: row.last_update,
        categories: [...row.categories].sort(),
        excluded: exclusions.valid ? !!exclusion : null,
        exclusion,
      };
    });
  return {
    present: true,
    state_path: POLYMARKET_STATE_PATH,
    updated_at: state.timestamp || null,
    summary: {
      trades: state.trade_history.length,
      open_trades: openTrades,
      closed_trades: state.trade_history.length - openTrades,
      trade_sides: tradeSides,
      signals: state.signal_history.length,
      signal_decisions: signalDecisions,
      orders: Object.keys(execution.orders).length,
      order_statuses: orderStatuses,
      fills: execution.fills.length,
      open_positions: Object.keys(execution.positions).length,
      closed_positions: execution.closed_positions.length,
      markets: markets.length,
      performance_metrics: state.performance_metrics,
      portfolio: {
        cash: execution.cash ?? null,
        starting_cash: execution.starting_cash ?? null,
        daily_pnl: execution.daily_pnl ?? null,
        current_drawdown: execution.current_drawdown ?? null,
      },
    },
    markets,
  };
}

function mutateMarketExclusion(action, body) {
  if (!isPlainObject(body) || body.confirmed !== true) throw requestError('explicit confirmation is required', 428);
  const marketId = normalizeMarketId(body.market_id);
  const reason = action === 'exclude' ? normalizeExclusionReason(body.reason) : null;
  return withHiveFileLock(path.join(POLYMARKET_RESEARCH, '.market_exclusions.lock'), () => {
    const current = readMarketExclusions();
    if (!current.valid) throw requestError(`market exclusions file is invalid: ${current.error}`, 409);
    const index = current.exclusions.findIndex(item => item.market_id === marketId);
    let changed = false;
    if (action === 'exclude' && index < 0) {
      current.exclusions.push({ market_id: marketId, reason, excluded_at: new Date().toISOString() });
      changed = true;
    } else if (action === 'include' && index >= 0) {
      current.exclusions.splice(index, 1);
      changed = true;
    }
    if (changed) atomicWriteJson(POLYMARKET_EXCLUSIONS_PATH, { exclusions: current.exclusions });
    return {
      action,
      changed,
      market_id: marketId,
      exclusion: current.exclusions.find(item => item.market_id === marketId) || null,
      exclusions: { path: current.path, count: current.exclusions.length, items: current.exclusions },
    };
  });
}

function clearLocalPolymarketTrades(body) {
  if (!isPlainObject(body) || body.confirmed !== true) throw requestError('explicit confirmation is required', 428);
  if (body.typeConfirmation !== 'EXECUTE') throw requestError('type-to-confirm value EXECUTE is required', 428);
  return withHiveFileLock(path.join(POLYMARKET_RESEARCH, '.engine_state.clear.lock'), () => {
    const loaded = loadPolymarketState();
    if (!loaded) throw requestError('engine state is unavailable', 404);
    const state = loaded.state;
    const execution = state.execution_engine;
    const cleared = {
      trade_history: { before: state.trade_history.length, after: 0 },
      'execution_engine.orders': { before: Object.keys(execution.orders).length, after: 0 },
      'execution_engine.fills': { before: execution.fills.length, after: 0 },
      'execution_engine.positions': { before: Object.keys(execution.positions).length, after: 0 },
      'execution_engine.closed_positions': { before: execution.closed_positions.length, after: 0 },
    };
    state.trade_history = [];
    execution.orders = {};
    execution.fills = [];
    execution.positions = {};
    execution.closed_positions = [];
    fs.mkdirSync(POLYMARKET_BACKUP_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = path.join(POLYMARKET_BACKUP_DIR, `engine_state.${stamp}.${crypto.randomBytes(3).toString('hex')}.json`);
    atomicWriteFile(backupPath, loaded.raw);
    atomicWriteJson(POLYMARKET_STATE_PATH, state);
    return {
      scope: 'local-paper-only',
      backup_path: backupPath,
      cleared,
      preserved: {
        root_keys: Object.keys(state).filter(key => key !== 'trade_history'),
        execution_engine_keys: Object.keys(execution).filter(key => !['orders', 'fills', 'positions', 'closed_positions'].includes(key)),
        signal_history_count: state.signal_history.length,
        performance_metrics_preserved: true,
        order_books_preserved: Object.keys(execution.order_books).length,
        price_history_preserved: Object.keys(execution.price_history).length,
        audit_log_preserved: execution.audit_log.length,
      },
    };
  });
}

function getSessions() {
  return readJsonCached(path.join(HIVE, 'sessions.json'), { sessions: [] });
}

// A host publishes hive/terminals.json; other machines publish the same file
// under hive/remote/<host>/. A host that has gone quiet must stay visible and
// be flagged, because a sleeping laptop looks identical to a host with no
// terminals unless the collection time is checked. A half-written file is
// skipped rather than allowed to take the endpoint down.
const TERMINAL_STALE_SEC = 300;

function localTerminalDoc() {
  const read = readJsonCached(path.join(HIVE, 'terminals.json'), null);
  if (read && typeof read === 'object') return read;
  return {
    host: os.hostname().split('.')[0],
    collected_at: null,
    agent_sessions: [],
    processes: [],
    shell_terminals: [],
  };
}

function terminalHosts() {
  const hosts = [];
  const local = localTerminalDoc();
  const localName = String(local.host || os.hostname().split('.')[0]);
  hosts.push({
    host: localName,
    local: true,
    collected_at: local.collected_at || null,
    age_sec: local.collected_at ? Math.max(0, Math.round((Date.now() - Date.parse(local.collected_at)) / 1000)) : null,
    // The local host has no collector of its own to be late, so a missing file
    // means "nothing published here", not "a host that went quiet". Only a
    // remote host can be stale, because only a remote host is expected to keep
    // writing on a schedule.
    stale: false,
    doc: local,
  });

  const remoteDir = path.join(HIVE, 'remote');
  let entries = [];
  try {
    entries = fs.readdirSync(remoteDir, { withFileTypes: true });
  } catch {
    return hosts; // no remote tree is a valid state, not an error
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const file = path.join(remoteDir, entry.name, 'terminals.json');
    let doc = null;
    try {
      doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      continue; // corrupt or half-written: skip this host, keep serving
    }
    if (!doc || typeof doc !== 'object') continue;
    const collectedAt = doc.collected_at || null;
    const ageSec = collectedAt ? Math.max(0, Math.round((Date.now() - Date.parse(collectedAt)) / 1000)) : null;
    hosts.push({
      host: String(doc.host || entry.name),
      local: false,
      collected_at: collectedAt,
      age_sec: ageSec,
      stale: ageSec == null || ageSec > TERMINAL_STALE_SEC,
      doc,
    });
  }
  return hosts;
}

function terminalSnapshot() {
  const hosts = terminalHosts();
  const terminals = [];
  const sessions = [];
  for (const host of hosts) {
    const doc = host.doc || {};
    for (const shell of Array.isArray(doc.shell_terminals) ? doc.shell_terminals : []) {
      // Redacted on the way out, not on the way in: the hive keeps the real
      // command line, and only the served copy is masked.
      terminals.push(redactEntry({ ...shell, host: host.host, host_stale: host.stale, age_sec: host.age_sec }));
    }
    for (const session of Array.isArray(doc.agent_sessions) ? doc.agent_sessions : []) {
      sessions.push({ ...session, host: host.host, host_stale: host.stale });
    }
  }
  return {
    // `processes` is carried per host, redacted, because a command line is the
    // thing most likely to hold a credential and callers should not have to ask
    // a second endpoint for it.
    hosts: hosts.map(({ doc, ...rest }) => ({
      ...rest,
      processes: redactAll(Array.isArray(doc?.processes) ? doc.processes : []),
    })),
    terminals,
    sessions,
    stale_hosts: hosts.filter(h => h.stale).map(h => h.host),
    // Whether the HUD can start anything on the machine serving it, and why not.
    //
    // This is here because the answer is otherwise invisible: the terminal policy
    // is a per-machine file, and a policy written on one machine and copied to
    // another keeps its prefixes. On the mini, hive/terminal_allowlist.json names
    // cwdPrefixes ["/Users/aryanagarwal"] -- a laptop path on a host whose home is
    // /Users/a -- so every cwd is refused and no terminal can be spawned. That is
    // fail-closed and correct, but from the HUD it looked identical to "spawning is
    // disabled", and the two are very different facts.
    //
    // Nothing here loosens the policy. It reports what the policy permits and
    // whether each permitted tree actually exists here, so a mismatch is visible
    // instead of being discovered when a spawn silently fails.
    spawn_policy: spawnPolicyAudit(),
  };
}

// The read outcome is kept alongside the events, not discarded with them. A
// caller handed only the array cannot tell a missing events.log, an unreadable
// one, and a log whose bytes were not events apart, because all three arrived as
// the same empty array. The fields exist so a route can name the state.
let eventCache = {
  at: 0, events: [], source_bytes: null, read_bytes: 0, read_error: null, unparsed: 0,
};

function getRecentEvents(limit = 1000, type = null) {
  const now = Date.now();
  if (now - eventCache.at >= JSON_CACHE_MS) {
    const eventsPath = path.join(HIVE, 'events.log');
    const read = readTailResult(eventsPath, EVENT_TAIL_BYTES);
    const parsed = parseJsonLinesCounted(read.text);
    eventCache = {
      at: now,
      events: parsed.items.reverse(),
      source_bytes: read.source_bytes,
      read_bytes: read.read_bytes,
      read_error: read.error,
      unparsed: parsed.unparsed,
    };
  }
  const filtered = type ? eventCache.events.filter(event => event.type === type) : eventCache.events;
  return filtered.slice(0, limit);
}

// Heartbeats are ~94% of this log (216k of 231k) and arrive about 1KB/s, so the
// 512KB general tail holds only the last ~8 minutes of anything and is entirely
// heartbeats by the time a person looks. Real work events were being flushed out
// within minutes: F7 had completed tasks and still reported zero recent events.
// This reads a far larger window and drops heartbeats so "what actually
// happened" stays reachable. Cost is a bigger read, paid at most once per
// JSON_CACHE_MS and only when a caller actually asks for work events.
const WORK_EVENT_TAIL_BYTES = 16 * 1024 * 1024;
let workEventCache = { at: 0, events: [] };

function getWorkEvents(limit = 200) {
  const now = Date.now();
  if (now - workEventCache.at >= JSON_CACHE_MS) {
    const eventsPath = path.join(HIVE, 'events.log');
    workEventCache = {
      at: now,
      events: parseJsonLines(readTail(eventsPath, WORK_EVENT_TAIL_BYTES))
        .filter(event => event && event.type && event.type !== 'heartbeat')
        .reverse(),
    };
  }
  return workEventCache.events.slice(0, limit);
}

function sessionRows() {
  const now = Date.now();
  const stamp = (session, extra = {}) => {
    const heartbeat = timestampMs(session.last_heartbeat || session.updated_at || session.started_at);
    const heartbeatAgeSec = heartbeat == null ? null : Math.max(0, Math.floor((now - heartbeat) / 1000));
    const status = String(session.status || 'UNKNOWN').toUpperCase();
    const terminal = ['STOPPED', 'DEAD', 'ERROR', 'STALE'].includes(status);
    return {
      ...session,
      ...extra,
      heartbeat_age_sec: heartbeatAgeSec,
      fresh: heartbeatAgeSec != null && heartbeatAgeSec <= SESSION_STALE_MS / 1000 && !terminal,
    };
  };
  // Local sessions plus whatever each remote host published into its own
  // terminals.json, so the sessions view is not blind to another machine.
  const remote = terminalSnapshot().sessions;
  return [
    ...(getSessions().sessions || []).map(s => stamp(s, { host: s.host || os.hostname().split('.')[0] })),
    ...remote.map(s => stamp(s)),
  ].sort((a, b) => {
    if (a.fresh !== b.fresh) return a.fresh ? -1 : 1;
    return (b.heartbeat_age_sec ?? Infinity) - (a.heartbeat_age_sec ?? Infinity);
  });
}

function mergedAgents() {
  const fleet = getFleet();
  const reg = getRegistry();
  const now = Date.now();
  const fleetById = new Map(
    (fleet.agents || []).map(agent => [String(agent.id || '').toLowerCase(), agent]),
  );
  const byId = new Map();
  // Merged case-insensitively, because the registry has accumulated both
  // casings for the same agent: PM-RISK and pm-risk are one agent, and listing
  // both inflated the floor count and the roster the HUD reports. The same
  // function already lowercases session and task keys below, so this key was
  // the odd one out. The registry itself is left untouched: it is written by
  // live agents and deduping it here keeps the fix on the read path.
  const canonical = new Map();

  for (const [id, agent] of Object.entries(reg.agents || {})) {
    const key = String(id || '').toLowerCase();
    if (!key) continue;
    const existing = canonical.get(key);
    // Prefer the fleet's spelling when it has one: the fleet is what is
    // actually running right now.
    const fromFleet = fleetById.get(key);
    const chosenId = fromFleet ? (fromFleet.id ?? id) : (existing ?? id);
    canonical.set(key, chosenId);
    byId.set(key, { ...agent, ...(fromFleet || {}), id: chosenId });
  }
  for (const agent of fleet.agents || []) {
    const key = String(agent.id || '').toLowerCase();
    if (!key) continue;
    if (!canonical.has(key)) canonical.set(key, agent.id);
    if (!byId.has(key)) byId.set(key, { ...agent, id: canonical.get(key) });
  }

  // Newest session per agent, tracked for BOTH fresh and stale sessions. An
  // earlier version kept only fresh ones, so a session that had gone stale was
  // indistinguishable from no session at all and the agent rendered as a bare
  // `offline` with no explanation. Keeping the record lets the display say
  // `stale` — the actual state — instead of implying the agent is gone.
  // sessionRows() sorts fresh-first, so the first record seen for an agent is
  // the freshest one and is kept.
  const latestSession = new Map();
  for (const session of sessionRows()) {
    const key = String(session.agent_id || '').toLowerCase();
    if (key && !latestSession.has(key)) latestSession.set(key, session);
  }

  const currentTask = new Map();
  for (const task of getTasks().tasks || []) {
    if (String(task.status).toUpperCase() !== 'IN_PROGRESS') continue;
    const owner = String(task.claimed_by || task.assigned_agent || '').toLowerCase();
    const heartbeat = timestampMs(task.heartbeat || task.claimed_at || task.updated_at);
    if (!owner || heartbeat == null || now - heartbeat > SESSION_STALE_MS) continue;
    if (!currentTask.has(owner)) currentTask.set(owner, task);
  }

  // busy is reserved for a claimed, in-flight task. A live session with no task
  // is `idle`: the process is real, but nothing proves work is happening, and
  // labelling it busy on a heartbeat alone overstates what the HUD knows.
  const displayOrder = { busy: 0, idle: 1, stale: 2, breaker: 3, offline: 4 };

  return [...byId.values()].map(agent => {
    const archived = !!agent.archived;
    const breaker = agent.breaker || (archived ? 'offline' : 'healthy');
    const agentKey = String(agent.id || '').toLowerCase();
    const session = latestSession.get(agentKey) || null;
    const task = currentTask.get(agentKey) || null;
    const currentTaskId = task?.task_id || session?.current_task_id || null;
    const sessionFresh = !!session?.fresh;
    const hasWork = !!currentTaskId;
    // `busy` requires a claimed in-flight task. A fresh session with no task is
    // a live process doing nothing known — that is `idle`, not `busy`. A session
    // that exists but has aged out is `stale`, which is different again from an
    // agent that was never seen.
    let display = 'offline';
    if (archived) display = 'offline';
    else if (breaker !== 'healthy') display = 'breaker';
    else if (hasWork) display = 'busy';
    else if (sessionFresh) display = 'idle';
    else if (session) display = 'stale';
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
      status: currentTaskId ? 'working' : (session?.status?.toLowerCase() || display),
      display,
      // What backs the label above, so the UI can show its reasoning rather
      // than asking the reader to trust a colour.
      evidence: {
        hasSession: !!session,
        sessionFresh,
        hasTask: hasWork,
        taskStatus: task ? String(task.status).toUpperCase() : null,
        heartbeatAgeSec: session?.heartbeat_age_sec ?? null,
        processId: session?.process_id ?? null,
        // A reported PID is verifiable, and this server already holds
        // processIsAlive. The blanket false withheld evidence that was sitting in
        // this very object: the HUD guard reads that as a false negative, since a
        // live PID can be checked, and every live agent was being displayed as
        // "not verified". The three states stay distinct, because a live process,
        // a dead one, and no process reported at all are different facts, and
        // reporting all three identically is what made this unreadable.
        processLiveness: !session?.process_id ? 'no-pid'
          : (processIsAlive(session.process_id) ? 'alive' : 'dead'),
        processVerified: processIsAlive(session?.process_id ?? null),
      },
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
      processId: session?.process_id ?? null,
      heartbeatAgeSec: session?.heartbeat_age_sec ?? null,
      sessionFresh,
      currentTaskId,
      currentTaskTitle: task?.title || null,
    };
  }).sort((a, b) => {
    if (a.isGod !== b.isGod) return a.isGod ? -1 : 1;
    const displayDiff = (displayOrder[a.display] ?? 9) - (displayOrder[b.display] ?? 9);
    return displayDiff || a.id.localeCompare(b.id);
  });
}

// Floor rollup derived strictly from the agents already computed above. A
// floor is a grouping of real agents, never an assumed hierarchy: the counts
// come from the same `display` labels, so a floor can only be as healthy as its
// members. `lead` is the agent whose role says it leads that floor; when no
// agent claims the floor there is no lead, and that is reported as null rather
// than filled in from the UI's own floor list.
function rollupFloors(agents) {
  const byFloor = new Map();
  for (const agent of agents) {
const floor = agent.floor || null;
      if (!floor) continue;
      // An agent's `floor` attribute is not reserved for floors. It is also used
      // for organisational groups (command, office, operations, polymarket,
      // specialists, workers), so grouping by it emitted those groups as if they
      // were floors: 18 rows for 12 floors, six of them with no manager, no state
      // and no liveness. A floor id is f<digits>; anything else is an agent group
      // and belongs in the agent view. The groups are not removed from the roster,
      // they simply stop being reported as floors.
      if (!/^f\d+$/i.test(String(floor))) continue;
      if (!byFloor.has(floor)) {
      byFloor.set(floor, {
        floor,
        lead: null,
        leadIsLive: false,
        agents: 0, running: 0, working: 0, idle: 0, stale: 0, failed: 0, offline: 0, breaker: 0,
      });
    }
    const row = byFloor.get(floor);
    row.agents += 1;
    if (agent.display === 'busy') row.working += 1;
    else if (agent.display === 'idle') row.idle += 1;
    else if (agent.display === 'stale') row.stale += 1;
    else if (agent.display === 'breaker') row.breaker += 1;
    else if (agent.display === 'offline') row.offline += 1;
    // A member counts as running when its session is fresh. A process id alone
    // is not proof — the process table is not polled here.
    if (agent.evidence?.sessionFresh) row.running += 1;
    if (!row.lead && /floor\s*lead|floor manager|manager/i.test(String(agent.role || ''))) {
      row.lead = agent.id;
      row.leadIsLive = !!agent.evidence?.sessionFresh;
    }
  }
  const floors = [...byFloor.values()].sort((a, b) => {
    // Only treat a floor as numbered when the label really ends in digits.
    // Number('') is 0 and Number.isFinite(0) is true, so a name-only floor like
    // `command` would otherwise be sorted as if it were floor 0.
    const numOf = (label) => {
      const digits = label.replace(/^.*?(\d+)$/, '$1');
      return /^\d+$/.test(digits) ? Number(digits) : null;
    };
    const na = numOf(a.floor);
    const nb = numOf(b.floor);
    if (na != null && nb != null) return na - nb;
    if (na != null) return -1;
    if (nb != null) return 1;
    return a.floor.localeCompare(b.floor);
  });
for (const row of floors) {
      // Named `state`, with an explicit UNKNOWN rather than null or blank: a panel
      // reading this has to be able to tell "cannot establish" from "no value".
      row.state = row.working > 0 ? 'working'
        : row.stale > 0 ? 'stale'
        : row.breaker > 0 ? 'breaker'
        : row.offline > 0 && row.offline === row.agents ? 'offline'
        : row.idle > 0 ? 'idle'
        : 'UNKNOWN';
      // `health` is kept alongside it so readers written against the old field do
      // not break in the same deploy that introduces `state`.
      row.health = row.state === 'UNKNOWN' ? 'unknown' : row.state;
    }
  return floors;
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

function logSizeOf(file) {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
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
        // Without this a wedged callback leaves the request hanging forever.
        const timer = setTimeout(() => {
          try { db.close(); } catch { /* already closed */ }
          resolve({
            dbExists: true,
            dbHasTables: false,
            tableNames: [],
            logExists: fs.existsSync(logPath),
            logSize: logSizeOf(logPath),
            error: 'sqlite read timed out',
          });
        }, 5000);
        db.all("SELECT name FROM sqlite_master WHERE type='table'", [], (err, rows) => {
          clearTimeout(timer);
          db.close();
          if (!err && rows && rows.length > 0) {
            tableNames = rows.map(r => r.name);
            resolve({
              dbExists: true,
              dbHasTables: true,
              tableNames,
              logExists: fs.existsSync(logPath),
              logSize: logSizeOf(logPath),
            });
          } else {
            resolve({
              dbExists: true,
              dbHasTables: false,
              tableNames: [],
              logExists: fs.existsSync(logPath),
              logSize: logSizeOf(logPath),
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
        logSize: logSizeOf(logPath),
      });
    }
  }
  return Promise.resolve({
    dbExists: false,
    dbHasTables: false,
    tableNames: [],
    logExists: fs.existsSync(logPath),
    logSize: logSizeOf(logPath),
  });
}

// `launchctl list` prints:  <pid|->  <last-exit-code>  <label>
// A dash in the pid column means the job is loaded but not currently running,
// which is the normal state for the many on-demand jobs in this fleet — so it
// must not be read as a failure.
//
// A non-zero exit is also NOT automatically a broken job. In this fleet several
// jobs exit non-zero *on purpose* to report a condition or to decline to run —
// `arb-detector` exits 2 on a monthly quota guard, and `pm-watch` exits 1
// because its own health script found a real problem. Both are working
// correctly. The distinction that actually predicts breakage is whether launchd
// is trying to restart the job: an on-demand job that exited and is waiting for
// its next StartInterval is behaving as configured, whereas a KeepAlive job
// that is not running is a genuine failure, because launchd would never stop
// trying. So the caller passes each job's plist intent and that decides
// 'stopped' vs 'failed'.
function parseLaunchctlList(output, intentFor = () => 'oneshot') {
  const services = [];
  for (const line of String(output).split('\n')) {
    const match = line.match(/^(\d+|-)\s+(\d+)\s+(\S+)\s*$/);
    if (!match) continue;
    const [, pidRaw, exitRaw, label] = match;
    const running = pidRaw !== '-';
    const lastExit = Number(exitRaw);
    const intent = intentFor(label);
    let status;
    if (running) {
      status = 'running';
    } else if (intent === 'keepalive') {
      // launchd keeps trying forever, so being down here is never normal.
      status = 'failed';
    } else if (lastExit === 0) {
      status = 'idle';
    } else {
      // Exited non-zero and is waiting for its next scheduled run. It reported
      // something (often deliberately) but nothing is restarting it, so this is
      // 'stopped' rather than 'failed' — the exit code still carries the reason.
      status = 'stopped';
    }
    services.push({ label, loaded: true, running, pid: running ? Number(pidRaw) : null, lastExit, status, intent });
  }

  const fleet = services.filter(s => s.label.startsWith('com.aryan.'));
  const byStatus = { running: 0, idle: 0, stopped: 0, failed: 0 };
  for (const service of fleet) byStatus[service.status] += 1;

  return { available: true, error: null, services: fleet, counts: { ...byStatus, total: fleet.length } };
}

// A job is 'keepalive' if launchd is configured to restart it when it dies.
// Read from the installed plist so the classification reflects the real
// deployment rather than a guess. Both ~/Library/LaunchAgents and the repo's
// launchd/ are checked; an unreadable plist degrades to 'oneshot', which is the
// more forgiving reading and so will not invent failures.
const PLIST_DIRS = [
  path.join(os.homedir(), 'Library', 'LaunchAgents'),
  path.join(FLEET_ROOT, 'launchd'),
];
const intentCache = new Map();
const INTENT_TTL_MS = 30000;

function readJobIntent(label) {
  const now = Date.now();
  const cached = intentCache.get(label);
  if (cached && now - cached.at < INTENT_TTL_MS) return cached.intent;

  let intent = 'oneshot';
  for (const dir of PLIST_DIRS) {
    const file = path.join(dir, `${label}.plist`);
    if (!fs.existsSync(file)) continue;
    try {
      const parsed = JSON.parse(execFileSync(
        '/usr/bin/plutil', ['-convert', 'json', '-o', '-', file], { encoding: 'utf8', timeout: 5000 },
      ));
      const keepAlive = parsed?.KeepAlive;
      // KeepAlive: true restarts always; a dict means "restart on these
      // conditions" but the job is still expected to come back on its own.
      // Either way launchd owns the lifecycle, so it is not an on-demand job.
      if (keepAlive === true || (keepAlive && typeof keepAlive === 'object')) {
        intent = 'keepalive';
        break;
      }
      if (parsed?.StartInterval) intent = 'interval';
    } catch {
      // An unreadable plist keeps the default rather than guessing 'failed'.
    }
    break;
  }

  intentCache.set(label, { at: now, intent });
  return intent;
}

function getFleetLaunchdState() {
  try {
    const output = execFileSync('/bin/launchctl', ['list'], { encoding: 'utf8', timeout: 8000 });
    return parseLaunchctlList(output, readJobIntent);
  } catch (error) {
    const detail = error.stderr ? String(error.stderr).trim() : error.message;
    return {
      available: false,
      error: detail || 'launchctl list failed',
      services: [],
      counts: { running: 0, idle: 0, stopped: 0, failed: 0, total: 0 },
    };
  }
}

function getFleetPlists() {
  const launchdDir = path.join(FLEET_ROOT, 'launchd');
  try {
    if (!fs.existsSync(launchdDir)) return { services: [] };
    return {
      services: fs.readdirSync(launchdDir)
        .filter(f => f.endsWith('.plist'))
        .map(f => ({ file: f, path: path.join(launchdDir, f) }))
    };
  } catch {    return { services: [] };
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

/**
 * Validation evidence for the strategy candidate.
 *
 * The forward test is pre-registered, so the interesting number is not the
 * return but how far the arms are from the inference floor. An arm below the
 * floor permits no claim at all, and the paper promotion controller holds new
 * entries until an arm clears it. This is deliberately read-only: the HUD
 * never writes to the artifacts and never makes the promotion call itself.
 */
function getValidationEvidence() {
  const forward = readJson(path.join(PAPER_BENCHMARK, 'forward-validation.json'), {});
  const promotion = readJson(path.join(PAPER_BENCHMARK, 'promotion.json'), {});
  const prereg = readJson(path.join(PAPER_BENCHMARK, 'forward-validation-prereg.json'), {});
  const status = readJson(path.join(os.homedir(), 'trading', 'openalice', 'ui', 'public', 'paper-benchmark.json'), {});
  const families = Array.isArray(status.families) ? status.families : [];
  const family = (name) => families.find((f) => f && f.name === name) || {};

  const floor = (forward.gates && forward.gates.inference_floor_trades) ?? 30;
  const arms = (Array.isArray(forward.arms) ? forward.arms : []).map((arm) => {
    const trades = arm.trades || 0;
    const armGates = arm.gates || {};
    return {
      id: arm.id,
      label: arm.label,
      error: arm.error,
      registration: arm.registration,
      timeframe: arm.timeframe,
      trades,
      return_pct: arm.return_pct,
      profit_factor: arm.profit_factor,
      max_dd_pct: arm.max_dd_pct,
      positive_oos_fraction: arm.positive_oos_fraction,
      ci95_low_pct: arm.bootstrap ? arm.bootstrap.ci95_low_pct : null,
      ci95_high_pct: arm.bootstrap ? arm.bootstrap.ci95_high_pct : null,
      floor_required: floor,
      floor_met: trades >= floor && armGates.inference_floor_reached !== false,
      trades_to_floor: Math.max(0, floor - trades),
      progress_pct: floor > 0 ? Math.min(100, Math.round((trades / floor) * 100)) : 0,
    };
  });

  const inSample = ['validation/regime_aware_rsi', 'validation/tournament_leaders'].map((name) => {
    const f = family(name);
    return {
      name,
      status: f.status,
      age_seconds: f.state ? f.state.age_seconds : null,
      stale_after_seconds: f.stale_after_seconds ?? null,
      updated: f.state ? f.state.updated : null,
    };
  });

  return {
    generated_at: forward.generated_at ?? null,
    window: forward.window ?? {},
    preregistration: {
      ...(forward.preregistration || {}),
      registered_at: prereg.registered_at ?? null,
      arm_count: Array.isArray(prereg.arms) ? prereg.arms.length : 0,
    },
    inference_floor: floor,
    arms,
    arms_below_floor: arms.filter((a) => !a.floor_met).length,
    registrations: (Array.isArray(forward.registrations) ? forward.registrations : []).map((r) => ({
      registration_id: r.registration_id,
      interval: r.interval,
      arms: r.arms,
      registered_at: r.registered_at,
      sha256: r.sha256,
    })),
    registration_count: forward.registration_count ?? 0,
    promotion: {
      state: promotion.state ?? 'unknown',
      previous_state: promotion.previous_state ?? null,
      changed: promotion.changed ?? false,
      entry_allowed: promotion.entry_allowed === true,
      scope: promotion.scope ?? 'paper_only',
      live_orders_allowed: promotion.live_orders_allowed === true,
      decided_at: promotion.generated_at ?? null,
      evidence_age_seconds: promotion.evidence ? promotion.evidence.forward_age_seconds : null,
      stale_after_seconds: promotion.evidence ? promotion.evidence.stale_after_seconds : null,
      reasons: Array.isArray(promotion.reasons) ? promotion.reasons : [],
    },
    in_sample_artifacts: inSample,
  };
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

const GRAPHIFY_GRAPH = path.join(FLEET_ROOT, 'graphify-out', 'graph.json');

function getGraphifyGraph() {
  return readJsonCached(GRAPHIFY_GRAPH, { nodes: [], links: [] });
}

// Community sizes without shipping the whole graph (~770KB) to floors that only
// need counts.
function getGraphifyCommunities(limit = 12) {
  const graph = getGraphifyGraph();
  const counts = new Map();
  for (const node of graph.nodes || []) {
    const label = node.community_name
      || (node.community != null ? `Community ${node.community}` : 'Unassigned');
    counts.set(label, (counts.get(label) || 0) + 1);
  }
  return {
    exists: fs.existsSync(GRAPHIFY_GRAPH),
    nodes: (graph.nodes || []).length,
    links: (graph.links || []).length,
    built_at_commit: graph.built_at_commit || null,
    communities: [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([label, count]) => ({ label, count })),
  };
}

/**
 * Why a BLOCKED task is waiting.
 *
 * Only reports what the record actually contains. A dependency list is turned
 * into a statement only when the list is there to be read; otherwise this says
 * so plainly rather than guessing at a cause, because a fabricated reason is
 * worse than an absent one — it reads like knowledge the system does not have.
 */
function blockedReason(task) {
  const evidence = isPlainObject(task.evidence) ? task.evidence : {};
  const explicit = task.blocked_reason || task.block_reason || evidence.blocked_reason || evidence.reason;
  if (explicit) return String(explicit);

  const deps = task.depends_on || task.dependencies || evidence.depends_on;
  if (Array.isArray(deps) && deps.length > 0) {
    const shown = deps.slice(0, 3).map(dep => (typeof dep === 'string' ? dep : (dep && dep.task_id) || '?')).join(', ');
    const extra = deps.length > 3 ? `, +${deps.length - 3} more` : '';
    return `waiting on ${deps.length} unmet dependency(ies): ${shown}${extra}`;
  }
  return 'blocked with no reason recorded';
}

function getQueueSummary() {
  const now = Date.now();
  const tasks = getTasks().tasks || [];
  const byStatus = {};
  for (const task of tasks) {
    const status = String(task.status || 'UNKNOWN').toUpperCase();
    byStatus[status] = (byStatus[status] || 0) + 1;
  }
  // A task can be recorded COMPLETE while its own record says the LLM call
  // failed. hive/lib/verify.py is the gate meant to catch that, but its markers
  // do not match the executor's wording: it looks for "[LLM call failed" while
  // the executor path writes a bare "LLM call failed: ..." and
  // "[executor ended: llm_error]". Those tasks therefore count as successes
  // everywhere downstream, which is the opposite of what the record contains.
  // Rather than rewrite the stored status, surface the discrepancy so the HUD
  // can report it: a completion rate that hides failures is a false number.
  const COMPLETE = 'COMPLETE';
  const completedTasks = tasks.filter(task => String(task.status || '').toUpperCase() === COMPLETE);
  const looksFailed = (task) => {
    const evidence = task.evidence;
    const evidenceStatus = isPlainObject(evidence) ? String(evidence.status || '').toLowerCase() : '';
    if (evidenceStatus === 'llm_error' || evidenceStatus === 'error') return true;
    const text = `${String(task.result || '')} ${evidenceStatus}`;
    return /llm call failed|llm_error|all llm providers failed|executor ended: llm_error|executor ended: error/i.test(text);
  };
  const completedButFailed = completedTasks.filter(looksFailed);
// "Verified" has to mean the work is backed by something durable. Deriving it
  // by subtraction — complete minus keyword-matched failures — produces a field
  // that carries the word "verified" while measuring only "not flagged as
  // failed", and a completion with nothing behind it passes straight through.
  // So this counts recorded output instead of inferring it from the absence of
  // a failure marker.
//
// The evidence model follows the work this fleet actually does, which is
// overwhelmingly TEXT: an agent claims a task, calls an LLM, and the deliverable
// is the response. Checking for a written file would therefore report 0 verified
// for a fleet that completed 522 real tasks, which is its own kind of lie — and
// `evidence.file` is empty on all of them precisely because these agents never
// write files, not because the work failed.
//
// So three shapes count, in descending order of strength:
//
//   evidence.artifacts[]   a non-empty list of produced artifacts (strongest)
//   evidence.file           a concrete file the work touched
//   result                  a non-empty recorded output — the actual deliverable
//                           for the text work this fleet does
//
// `result` is trimmed before testing so a whitespace-only completion does not
// pass as evidence. Evidence is not correctness: it means something durable was
// recorded. The unverified remainder stays visible for exactly that distinction.
const hasDurableEvidence = (task) => {
    const evidence = task.evidence;
    if (isPlainObject(evidence)) {
      if (Array.isArray(evidence.artifacts) && evidence.artifacts.length > 0) return true;
      if (typeof evidence.file === 'string' && evidence.file.trim().length > 0) return true;
    }
    return typeof task.result === 'string' && task.result.trim().length > 0;
  };
  const verifiedTasks = completedTasks.filter(task => hasDurableEvidence(task) && !looksFailed(task));
  // The remainder: stored COMPLETE, not flagged as failed, and backed by nothing.
  // Reported rather than folded away, because "completed but unverified" is the
  // number an operator actually needs in order to distrust a completion rate.
  const unverifiedComplete = completedTasks.length - completedButFailed.length - verifiedTasks.length;
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
const throughput = require('./throughput');
      const unbiased = throughput.completionsLastHour(HIVE);
      const hourly = throughput.completionsByHour(HIVE);
      return {
        total: tasks.length,
        queued: byStatus.QUEUED || 0,
        inProgress: inProgress.length,
        complete: byStatus.COMPLETE || 0,
        failed: byStatus.FAILED || 0,
    quarantined: byStatus.QUARANTINED || 0,
    staleInProgress: staleInProgress.length,
    // Recorded as COMPLETE but the record itself says the model call failed.
    // `complete` above is the raw count and includes these; subtracting them is
    // the only way to read a success rate that is not misleading.
    completedButFailed: completedButFailed.length,
    verifiedComplete: verifiedTasks.length,
    unverifiedComplete,
    // BLOCKED is a real resting state: the dependency engine parks a task until
    // its prerequisite produces a result, and without these the task vanishes
    // between QUEUED and claimable. The reason is reported only when the record
    // carries one — a cause is never invented to fill the column.
    blocked: (byStatus.BLOCKED || 0),
    blockedTasks: tasks
      .filter(task => String(task.status || '').toUpperCase() === 'BLOCKED')
      .slice(0, 50)
      .map(task => ({
        task_id: task.task_id,
        title: task.title,
        reason: blockedReason(task),
        assigned_agent: task.assigned_agent || null,
        blocked_since: task.blocked_since || task.updated_at || task.created_at || null,
      })),
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
// Read through throughput.js rather than off a 5000-event fetch: that fetch
      // silently truncated the log, so the rate was a floor presented as a rate,
      // and the payload never said which window the chart was read from.
      completionsLastHour: unbiased.completionsLastHour,
      completionsLastHourLowerBound: Boolean(unbiased.lower_bound),
      completionsWindowBytes: unbiased.window_bytes,
      completionsError: unbiased.error || null,
      failedLastHour,
      completionsByHour: hourly.hours,
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
      // Providers ahead of the winner that are currently unusable. The harness
      // picks the first available provider, so this is what distinguishes a
      // healthy big-model route from a silent fallback to a local one.
      degradedProviders: Array.isArray(data.degraded_providers) ? data.degraded_providers : [],
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
        // Present even offline. HarnessHealth declares this field as required, and
        // it means "providers ahead of the winner that are unusable" -- with no
        // winner reachable there are none, so an empty list is the truthful answer.
        // Omitting it here made api.ts describe a payload the server never sends
        // whenever the 2s probe timed out, which is how three contract tests came
        // to fail intermittently and pass on a rerun.
        degradedProviders: [],
        error: error.message,
        checkedAt,
      };
    }
}

const SERVICE_PROBE_ATTEMPTS = 2;
const SERVICE_PROBE_RETRY_MS = 150;

function checkServicePort(service, attempt = 0) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const socket = net.createConnection({ host: '127.0.0.1', port: service.port });
    let settled = false;
    const finish = (online, error = null) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (!online && attempt + 1 < SERVICE_PROBE_ATTEMPTS) {
        setTimeout(() => {
          checkServicePort(service, attempt + 1).then(resolve);
        }, SERVICE_PROBE_RETRY_MS);
        return;
      }
      resolve({
        ...service,
        status: online ? 'online' : 'offline',
        latencyMs: Date.now() - startedAt,
        error,
        attempts: attempt + 1,
      });
    };
    socket.setTimeout(1000);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false, 'timeout'));
    socket.once('error', error => finish(false, error.code || error.message));
  });
}

async function getServiceHealth() {
  return {
    host: os.hostname(),
    checkedAt: new Date().toISOString(),
    services: await Promise.all(SERVICE_PORTS.map(checkServicePort)),
  };
}

async function proxyFreeHarnessJson(pathname, res, query = {}) {
  try {
    const url = new URL(`${FREE_HARNESS_URL}${pathname}`);
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null && String(value).length > 0 && String(value).length <= 128) url.searchParams.set(key, String(value));
    }
    const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
    const data = await response.json();
    res.status(response.status).json(data);
  } catch (error) {
    res.status(502).json({ error: 'AlphaInsider provider unavailable', detail: error.message });
  }
}

function readPolymarketPlist() {
  try {
    const parsed = JSON.parse(execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', POLYMARKET_LAUNCHD_INSTALLED_PLIST], { encoding: 'utf8' }));
    if (!isPlainObject(parsed)) return { plist: null, error: 'installed plist must contain a dictionary' };
    return { plist: parsed, error: null };
  } catch (error) {
    return { plist: null, error: error.message };
  }
}

function readPolymarketConfig() {
  const configPath = path.join(HIVE, 'polymarket_config.json');
  if (!fs.existsSync(configPath)) return { present: false, path: configPath, config: {}, error: null };
  try {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    if (!isPlainObject(config)) throw new Error('configuration must be an object');
    if (Object.prototype.hasOwnProperty.call(config, 'paper_only') && typeof config.paper_only !== 'boolean') throw new Error('paper_only must be boolean');
    if (Object.prototype.hasOwnProperty.call(config, 'engine_path') && typeof config.engine_path !== 'string') throw new Error('engine_path must be a string');
    return { present: true, path: configPath, config, error: null };
  } catch (error) {
    return { present: true, path: configPath, config: {}, error: error.message };
  }
}

function getProcessCommand(pid) {
  if (!Number.isInteger(pid) || pid < 2) return null;
  try {
    return execFileSync('/bin/ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' }).trim() || null;
  } catch {
    return null;
  }
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid < 2) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function findEngineProcesses(enginePath) {
  if (!enginePath) return [];
  try {
    const output = execFileSync('/bin/ps', ['-axo', 'pid=,command='], { encoding: 'utf8' });
    const processes = [];
    for (const line of output.split('\n')) {
      if (!line.includes(enginePath) || line.includes('heartbeat.py')) continue;
      const match = line.trim().match(/^(\d+)\s+(.*)$/);
      if (!match || !processIsAlive(Number(match[1]))) continue;
      processes.push({ pid: Number(match[1]), command: match[2] });
    }
    return processes;
  } catch {
    return [];
  }
}

function getPolymarketLaunchdStatus() {
  try {
    const output = execFileSync('/bin/launchctl', ['print', POLYMARKET_LAUNCHD_TARGET], { encoding: 'utf8' });
    const state = output.match(/\n\s*state = ([^\s]+)/)?.[1] || 'unknown';
    const pid = output.match(/\n\s*pid = (\d+)/)?.[1] || null;
    const installedPath = output.match(/\n\s*path = ([^\n]+)/)?.[1]?.trim() || null;
    return { loaded: true, state, pid: pid ? Number(pid) : null, path: installedPath, error: null };
  } catch (error) {
    const detail = error.stderr ? String(error.stderr).trim() : error.message;
    return { loaded: false, state: 'unavailable', pid: null, path: null, error: detail };
  }
}

function getPolymarketRuntime() {
  const checkedAt = new Date().toISOString();
  const enginePath = path.join(POLYMARKET_RESEARCH, 'profitability_engine_fixed.py');
  const installedPlist = readPolymarketPlist();
  const plist = installedPlist.plist;
  const configResult = readPolymarketConfig();
  const argumentsList = Array.isArray(plist?.ProgramArguments) ? plist.ProgramArguments : [];
  const hasPaperArgument = argumentsList.includes('--paper');
  const hasUnsafeArgument = argumentsList.some(argument => /--(live|real|mainnet|testnet)(?:=|$)/i.test(String(argument)));
  const plistValid = !!plist
    && plist.Label === POLYMARKET_LAUNCHD_LABEL
    && argumentsList.length >= 2
    && argumentsList.every(argument => typeof argument === 'string')
    && argumentsList[1] === enginePath
    && argumentsList.includes('--paper')
    && plist.WorkingDirectory === POLYMARKET_ROOT
    && fs.existsSync(enginePath);
  const configPaperOnly = !configResult.error
    && (!Object.prototype.hasOwnProperty.call(configResult.config, 'paper_only') || configResult.config.paper_only === true);
  const paperOnly = plistValid && !configResult.error && configPaperOnly && hasPaperArgument && !hasUnsafeArgument;
  const launchd = getPolymarketLaunchdStatus();
  const processes = findEngineProcesses(enginePath);
  if (processes.length === 0 && launchd.pid && processIsAlive(launchd.pid)) {
    const command = getProcessCommand(launchd.pid);
    if (command && command.includes(enginePath)) processes.push({ pid: launchd.pid, command });
  }
  const expectedPlistLoaded = launchd.loaded && launchd.path === POLYMARKET_LAUNCHD_INSTALLED_PLIST;
  return {
    checked_at: checkedAt,
    engine_path: enginePath,
    expected_engine_path: enginePath,
    expected_plist_path: POLYMARKET_LAUNCHD_INSTALLED_PLIST,
    paper_only: paperOnly,
    managed: plistValid && !configResult.error,
    running: processes.length > 0,
    pid: processes[0]?.pid || null,
    process: { pids: processes.map(process => process.pid), commands: processes.map(process => process.command) },
    launchd: {
      ...launchd,
      expected_path: POLYMARKET_LAUNCHD_INSTALLED_PLIST,
      expected_loaded: expectedPlistLoaded,
    },
    config: {
      present: configResult.present,
      path: configResult.path,
      error: configResult.error,
    },
    plist: {
      valid: plistValid,
      error: installedPlist.error,
      path: POLYMARKET_LAUNCHD_INSTALLED_PLIST,
    },
    execution_allowed: plistValid && !configResult.error && paperOnly && expectedPlistLoaded,
  };
}

// ---------- routes ----------

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, ...hiveStatus(), ts: Date.now() });
});

app.get('/api/alphainsider/status', (_req, res) => proxyFreeHarnessJson('/alphainsider/status', res));
  app.get('/api/alphainsider/strategies', (_req, res) => proxyFreeHarnessJson('/alphainsider/strategies', res));
  app.get('/api/alphainsider/positions', (req, res) => proxyFreeHarnessJson('/alphainsider/positions', res, { strategy_id: req.query.strategy_id }));

  // The poller/trader stats feed lives in its own file precisely so a rewrite of
  // this one cannot silently drop it. AlphaInsiderPanel still reads it.
  alphaInsiderStats.register(app);

  // Route modules that live in their own files. Each register() is idempotent,
  // so a re-registration during a hot reload is safe.
  strategySearchRoute.register(app);
  liveDigestRoute.register(app);
  openaliceStatus.register(app);
frozenFeedsRoute.register(app);
    floorRoute.register(app);
    registerEvidenceRoutes(app);
  registerWedgedRoutes(app, HIVE);

app.get('/api/summary', (_req, res) => {
  res.json(buildSnapshot('summary'));
});

app.get('/api/agents', (_req, res) => {
  res.json(buildSnapshot('agents'));
});

// The drawer reads up to ~100 files per agent (inbox and outbox), so the
// payload is briefly cached: a push is still live, just not re-derived several
// times a second on a busy hive.
const agentDetailCache = new Map();
const AGENT_DETAIL_TTL_MS = 2000;

function getAgentDetail(id) {
  const now = Date.now();
  const cached = agentDetailCache.get(id);
  if (cached && now - cached.at < AGENT_DETAIL_TTL_MS) return cached.value;
  const agent = mergedAgents().find(item => item.id === id);
  if (!agent) {
    agentDetailCache.delete(id);
    return null;
  }
  const dir = path.join(HIVE, 'agents', id);
  const value = {
    agent,
    identity: readText(path.join(dir, 'identity.md')),
    memory: readText(path.join(dir, 'memory.md')),
    inbox: listMessages(path.join(dir, 'inbox')),
    outbox: listMessages(path.join(dir, 'outbox')),
    sessions: sessionRows().filter(session => session.agent_id === id),
    currentTasks: (getTasks().tasks || []).filter(task => task.claimed_by === id && String(task.status).toUpperCase() === 'IN_PROGRESS'),
    // Heartbeats dominate the tail window ~30:1, so filtering by agent_id
    // after taking the unfiltered window returned only heartbeats — F7 had
    // completed real work and still reported none. Read the work-event pool so
    // "recent events" means something happened.
    recentEvents: getWorkEvents(2000).filter(event => event.agent_id === id).slice(0, 10),
  };
  agentDetailCache.set(id, { at: now, value });
  return value;
}

app.get('/api/agents/:id', (req, res) => {
  const id = String(req.params.id).replace(/[^a-zA-Z0-9_-]/g, '');
  const detail = getAgentDetail(id);
  if (!detail) return res.status(404).json({ error: 'agent not found', id });
  res.json(detail);
});

function getLedger(source, kind, limit) {
  const bounded = clampLimit(limit, 500, 2000);
  let events = source === 'events'
    ? getRecentEvents(2000)
    : readJsonl(path.join(HIVE, 'log.jsonl'), 2000).reverse();
  if (kind) events = events.filter(event => source === 'events' ? event.type === kind : event.kind === kind);
  return {
    source,
    events: events.slice(0, bounded).map(event => ({ ...event, type: event.type || event.kind || 'event' })),
  };
}

app.get('/api/ledger', (req, res) => {
  res.json(getLedger(
    req.query.source === 'log' ? 'log' : 'events',
    req.query.kind ? String(req.query.kind) : null,
    req.query.limit
  ));
});

// Per-floor task counts, so the floor rail does not have to download the whole
// (multi-megabyte) tasks.json just to render its badges.
// The status groups the F4 board renders. Kept server-side so the payload can be
// shaped for the board instead of shipping the whole 3.8MB tasks.json.
const BOARD_COLUMNS = [
  { id: 'todo', statuses: ['QUEUED', 'PRESERVED', 'TODO', 'PENDING'] },
  { id: 'in_progress', statuses: ['IN_PROGRESS'] },
  { id: 'review', statuses: ['QUARANTINED', 'REVIEW', 'VERIFY', 'BLOCKED', 'FAILED'] },
  { id: 'done', statuses: ['COMPLETE', 'DONE'] },
];

const BOARD_TASK_FIELDS = [
  'task_id', 'title', 'status', 'project_id', 'assigned_agent', 'claimed_by',
  'created_at', 'started_at', 'completed_at', 'updated_at', 'heartbeat', 'priority',
];

function taskSortTime(task) {
  for (const key of ['updated_at', 'heartbeat', 'started_at', 'created_at']) {
    const parsed = Date.parse(String(task[key] ?? ''));
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

/**
 * F4 in the shape it draws: at most `perColumn` rows per column, plus the true
 * count for each so the header badge stays honest.
 */
function getTaskBoard(perColumn = 25) {
  const all = getTasks().tasks || [];
  const groups = {};
  const counts = {};
  const sorted = [...all].sort((a, b) => taskSortTime(b) - taskSortTime(a));
  const claimed = new Set();

  for (const column of BOARD_COLUMNS) {
    const wanted = new Set(column.statuses);
    const rows = [];
    let count = 0;
    for (const task of sorted) {
      if (!wanted.has(String(task.status || '').toUpperCase())) continue;
      count += 1;
      if (rows.length >= perColumn) continue;
      claimed.add(task.task_id);
      const row = Object.fromEntries(BOARD_TASK_FIELDS.filter((field) => task[field] !== undefined).map((field) => [field, task[field]]));
      // Only rows in the completion column carry a truth label. Labelling QUEUED
      // or IN_PROGRESS work would imply a completion claim that does not exist yet.
      if (column.id === 'done') {
        const verdict = classifyTaskTruth(task);
        row.completion_truth = verdict.truth;
        row.evidence_score = verdict.score === undefined ? null : verdict.score;
        row.evidence_reason = verdict.reason || null;
      }
      rows.push(row);
    }
    groups[column.id] = rows;
    counts[column.id] = count;
  }

// counts.done is the raw COMPLETE count and stays that way: it is what the
    // pipeline asserts. completion states how many of those are actually supported
    // by evidence, so a reader is never left to assume the two agree.
    const claimedComplete = all.filter((task) => {
      const status = String(task.status || '').toUpperCase();
      return status === 'COMPLETE' || status === 'DONE';
    });

    return {
      groups,
      counts,
      completion: summarizeTasks(claimedComplete),
      total: all.length,
      perColumn,
    // Tasks in a status the board does not draw, so the UI can say so.
    unclassified: all.length - [...claimed].length - Object.values(counts).reduce((a, b) => a + b, 0) + [...claimed].length,
  };
}

function getFloorTaskCounts() {
  const counts = {};
  for (const task of getTasks().tasks || []) {
    for (const raw of [task.assigned_agent, task.claimed_by]) {
      const match = String(raw || '').trim().toLowerCase().match(/^f([1-9]|1[0-4])$/);
      if (!match) continue;
      const floor = `f${match[1]}`;
      if (!counts[floor]) counts[floor] = new Set();
      counts[floor].add(task.task_id);
    }
  }
  const result = {};
  for (const [floor, ids] of Object.entries(counts)) result[floor] = ids.size;
  return result;
}

app.get('/api/task-board', (_req, res) => {
  res.json(buildSnapshot('taskBoard'));
});

app.get('/api/tasks', (req, res) => {
  if (req.query.summary === '1' || req.query.summary === 'true') {
    return res.json(getQueueSummary());
  }
  if (req.query.counts === '1' || req.query.counts === 'true') {
    return res.json({ counts: getFloorTaskCounts() });
  }
  res.json(getTasks());
});

app.get('/api/jarvis/tasks', (_req, res) => {
  res.json(buildSnapshot('jarvisTasks'));
});

// 200 on every state, including the failures. A 500 would be honest but would
// replace "cannot tell whether it looked" with "did not answer", and the payload
// still has to carry which of the two happened.
app.get('/api/jarvis/audit', (req, res) => {
  res.json(getJarvisAudit(req.query.limit));
});

/**
   * What a command WOULD do, without doing it.
   *
   * Two things justify this route existing.
   *
   * The first is that the office was asking operators to press a button whose
   * outcome they could not see. The console showed a transcript, the server
   * decided the risk tier, and the operator found out which agent would own the
   * work only from a task row appearing later. Preview answers the question
   * first: who owns it, what tier it is, what confirmation it still needs.
   *
   * The second is that the browser used to guess the risk tier itself, from its
   * own narrower copy of the rule, and was wrong often enough to send an operator
   * into a 428 wall. Asking the server removes the guess rather than correcting
   * it, so there is no second copy left to drift.
   *
   * It is deliberately NOT behind isLocalRequest, which is the opposite of every
   * other write route here. This one writes nothing, and the operator who most
   * needs to be told they cannot dispatch is the one looking at the mini over a
   * tunnel from a laptop -- exactly the request the gate would refuse. Gating it
   * would hide the explanation behind the thing being explained.
   *
   * It reads the queue to report availability, which is no new exposure:
   * /api/task-board already serves the same rows ungated to the same caller.
   */
  app.post('/api/jarvis/preview', (req, res) => {
    const body = isPlainObject(req.body) ? req.body : {};
    const verdict = evaluateJarvisCommand(body);
    const gate = jarvisAcceptance(verdict, { confirmed: body.confirmed, typeConfirmation: body.typeConfirmation });
    const tasksPath = path.join(HIVE, 'tasks.json');
    const queueAvailable = fs.existsSync(tasksPath);
    const local = isLocalRequest(req);
    res.json({
      ok: verdict.ok,
      reason: verdict.ok ? null : verdict.reason,
      field_status: verdict.statusCode,
      prompt: verdict.ok ? verdict.normalized.prompt : null,
      priority: verdict.ok ? verdict.normalized.priority : null,
      target: verdict.ok ? verdict.normalized.target : null,
      risk: verdict.ok ? verdict.risk : null,
      requires_type_confirmation: verdict.ok ? verdict.requiresTypeConfirmation : null,
      assigned_agent: verdict.ok ? verdict.assignedAgent : null,
      routing: verdict.ok ? verdict.routing : null,
      would_accept: gate.accepted && queueAvailable,
      blocked_by: !verdict.ok ? 'fields'
        : !queueAvailable ? 'queue_unavailable'
          : !local ? 'not_local'
            : gate.accepted ? null : 'confirmation',
      blocked_reason: !verdict.ok ? verdict.reason
        : !queueAvailable ? 'JEV task queue is unavailable'
          : !local ? `This HUD is served from ${os.hostname()}, and dispatch requires a request that reaches that host's own loopback interface. Viewing it from another machine is read-only by design.`
            : gate.accepted ? null : gate.reason,
      dispatch: {
        available: local,
        host: os.hostname(),
        requirement: 'Dispatch must be issued by a process on this host. A tunnel or reverse proxy in front of the HUD cannot carry it.',
      },
      queue_available: queueAvailable,
    });
  });

  app.post('/api/jarvis/command', (req, res) => {
  if (!isLocalRequest(req)) return sendError(res, 403, 'JARVIS_LOCAL_ONLY', 'JEV commands are available only from the local HUD');
  const now = Date.now();
  while (jarvisCommandTimestamps[0] && now - jarvisCommandTimestamps[0] > 60000) jarvisCommandTimestamps.shift();
  if (jarvisCommandTimestamps.length >= 10) {
    res.set('Retry-After', '60');
    return sendError(res, 429, 'JEV_RATE_LIMITED', 'JEV accepts at most 10 commands per minute');
  }
  try {
    const task = enqueueJarvisCommand({
      prompt: req.body?.prompt,
      target: req.body?.target,
      priority: req.body?.priority,
      confirmed: req.body?.confirmed,
      typeConfirmation: req.body?.typeConfirmation,
    });
    jarvisCommandTimestamps.push(now);
    jsonCache.delete(path.join(HIVE, 'tasks.json'));
    res.status(201).json({ ok: true, task, message: 'Command routed to JEV' });
  } catch (error) {
    sendError(res, error.statusCode || 500, 'JEV_COMMAND_REJECTED', error.message || 'Unable to route command');
  }
});

app.get('/api/queue', (_req, res) => {
  res.json(buildSnapshot('queue'));
});

app.get('/api/events', (req, res) => {
  const type = req.query.type ? String(req.query.type) : null;
  const limit = clampLimit(req.query.limit, 500, 5000);
  let events = getRecentEvents(limit, type);
  // Heartbeats outnumber work events ~30:1 in this hive, so an unfiltered tail
  // is almost entirely heartbeats and a "recent activity" view built on it shows
  // nothing that happened. `exclude=heartbeat` reads a much larger window and
  // drops heartbeats, so real activity stays reachable instead of being flushed
  // out of the tail by heartbeat volume.
  const exclude = req.query.exclude ? String(req.query.exclude) : null;
  if (exclude) {
    const drop = new Set(exclude.split(',').map(s => s.trim()).filter(Boolean));
    if (drop.has('heartbeat')) {
      const pool = getWorkEvents(clampLimit(req.query.work_limit, 200, 2000));
      events = pool.filter(event => !drop.has(event.type));
    } else {
      events = events.filter(event => !drop.has(event.type));
    }
  }
  // The tail buffer is a bounded read of a 29MB log, so this is what is
  // reachable, not the whole history. Say so rather than implying completeness.
  res.json({ events, reachable_window: true });
});

function getVerifyState() {
  const st = readJsonCached(path.join(HIVE, 'verify_state.json'), null);
  if (!st) return { present: false };
  const tally = st.verdict_tally || {};
  const scanned = (tally.OK || 0) + (tally.DODGE || 0) + (tally.SHORT || 0) + (tally.FAIL || 0) + (tally.EMPTY || 0);
  // This ratio measures what fraction of scanned verdicts were OK -- that is all.
  // It was previously published as realWorkRatePct, which claimed something it does
  // not measure: whether a task did real work needs an independent verifier and a
  // durable artifact, and this pipeline has neither. A pipeline that never emits
  // junk scored 100% "real work" while verifying nothing.
  //
  // Named for what it is, with the denominator published alongside it, because a
  // rate you cannot reason about is decoration. null when nothing was scanned:
  // zero would claim nothing was OK, and a number would claim a measurement that
  // never happened.
  const outputQualityRatePct = scanned > 0 ? Math.round(((tally.OK || 0) / scanned) * 1000) / 10 : null;
  return {
    present: true,
    at: st.at,
    verdict_tally: tally,
    verdict_tally_total: scanned,
    requeued: st.requeued || [],
    quarantined: st.quarantined || [],
    outputQualityRatePct,
    // Verified work is NOT MEASURED by this pipeline, and saying so is the point.
    // All four are null rather than 0 or a number: 0 claims nothing was verified,
    // and any figure would claim a measurement that never happened. The basis is
    // published so a reader can tell "not measured" from "value missing".
    verifiedWork: null,
    verifiedWorkDenominator: null,
    verificationCoverage: null,
    verificationBasis: 'no independent verifier and no artifact ledger: verdict '
      + 'tallies measure output quality, not whether work was real',
  };
}

app.get('/api/verify', (_req, res) => {
  res.json(buildSnapshot('verify'));
});

app.get('/api/office-manager', (_req, res) => {
  res.json(buildSnapshot('officeManager'));
});

app.get('/api/harness/health', async (_req, res) => {
  res.json(await buildSnapshotAsync('harness'));
});

app.get('/api/services/health', async (_req, res) => {
  res.json(await buildSnapshotAsync('services'));
});

app.get('/api/sessions', (_req, res) => {
  res.json(buildSnapshot('sessions'));
});

// Terminals across every host that publishes into this hive. A host that has
// gone quiet is listed and flagged rather than dropped, and a corrupt file is
// skipped so one bad machine cannot take the panel down.
app.get('/api/terminals', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(terminalSnapshot());
});

// ---------- spawned terminals ----------
//
// The GET above reports the shells a HUMAN is sitting in, collected by
// collect-terminals.py. The routes below are the other half: terminals the HUD
// started itself. They are kept in a separate hive file
// (spawned_terminals.json) because the collector rewrites terminals.json in
// full every 60 seconds and would erase them; see manager.js.
//
// Every route here runs arbitrary commands, so all of them use the hardened
// local gate: isLocalRequest rejects anything proxied through Tailscale
// Serve, which arrives on loopback and would otherwise pass a socket check.
const terminalGuard = (req, res) => {
  if (!isLocalRequest(req)) {
    return sendError(res, 403, 'local_only', 'terminal control is available only from this machine');
  }
  return null;
};

app.get('/api/terminals/spawned', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  const collected = readJsonCached(path.join(HIVE, 'terminals.json'), null);
  res.json(terminalManager.collectedTerminals(collected));
});

app.post('/api/terminals/spawn', async (req, res) => {
  if (!isLocalRequest(req)) return sendError(res, 403, 'local_only', 'spawning and signalling happen on this machine; available only from the local HUD');
  if (terminalGuard(req, res)) return;
  try {
    const terminal = await terminalManager.spawnOne(req.body || {});
    liveHub?.publish(['terminalsSpawned']);
    res.json({ ok: true, terminal });
  } catch (error) {
    sendError(res, error.statusCode || 500, 'TERMINAL_SPAWN_REJECTED', error.message);
  }
});

app.post('/api/terminals/bulk', async (req, res) => {
  if (!isLocalRequest(req)) return sendError(res, 403, 'local_only', 'spawning and signalling happen on this machine; available only from the local HUD');
  if (terminalGuard(req, res)) return;
  const body = req.body || {};
  try {
    // Orchestrate mode reaches `claude --permission-mode bypassPermissions` on a
    // fresh worktree, so it is a separate branch that insists on confirmation
    // rather than a shape the generic array path could be tricked into.
    if (body.mode === 'orchestrate') {
      const outcome = await terminalManager.spawnOrchestrate(body);
      liveHub?.publish(['terminalsSpawned']);
      return res.json({ ok: true, mode: 'orchestrate', ...outcome });
    }
    const results = await terminalManager.spawnBulk(body.terminals || [], { limit: body.limit });
    liveHub?.publish(['terminalsSpawned']);
    // Per-item outcomes, so one rejected command does not read as a failed batch.
    res.json({
      ok: results.every((r) => r.ok),
      requested: results.length,
      spawned: results.filter((r) => r.ok).length,
      results,
    });
  } catch (error) {
    sendError(res, error.statusCode || 500, 'TERMINAL_BULK_REJECTED', error.message);
  }
});

// Literal sub-paths are registered BEFORE the ':id' routes below. Express
// matches in registration order, so a ':id' route placed first would swallow
// /spawn, /bulk, /reap and /health -- answering a spawn attempt as "unknown
// terminal 404" and a POST as 405. Keep every literal name above this line.
app.post('/api/terminals/reap', (req, res) => {
  if (!isLocalRequest(req)) return sendError(res, 403, 'local_only', 'spawning and signalling happen on this machine; available only from the local HUD');
  if (terminalGuard(req, res)) return;
  const body = req.body || {};
  res.json({ ok: true, ...terminalManager.reap({
    maxAgeHours: body.maxAgeHours,
    statuses: Array.isArray(body.statuses) ? body.statuses : undefined,
  }) });
});

app.get('/api/terminals/health', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(terminalManager.health());
});

// Peers this HUD may dispatch work to. Read-only and ungated on purpose: it
// reveals host names and reachability, which the merged terminal view already
// exposes, and it performs no action. Acting on a peer requires a 'remote'
// spawn, which is gated and allowlisted like any other.
app.get('/api/terminals/peers', async (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ peers: await terminalManager.peers() });
});

// ---------------------------------------------------------------------------
// Autopilot — proposes, never lands.
//
// Generation one is verification-only: each tick runs the suite in a throwaway
// worktree and files the result. It writes no code. Landing a proposal is an
// operator action on a loopback request, and the autopilot has no code path that
// merges, pushes, or rewrites history.
// ---------------------------------------------------------------------------
const { createRunner } = require('./lib/autopilot_runner');
const { computeFleetPerformance } = require('./lib/fleet_performance');

const autopilotRunner = createRunner({
  // The repo root, not server/: __dirname is the directory this file lives in,
  // and the autopilot needs the checkout to read .git and spawn worktrees.
  repo: path.join(__dirname, '..'),
  hive: HIVE,
  ref: process.env.OFFICE_HUD_AUTOPILOT_REF || 'origin/main',
  withFileLock: hiveFileLock,
});
const autopilot = autopilotRunner.createAutopilot();
const AUTOPILOT_TICK_MS = Number(process.env.OFFICE_HUD_AUTOPILOT_TICK_MS) > 0
  ? Number(process.env.OFFICE_HUD_AUTOPILOT_TICK_MS)
  : 30 * 60 * 1000;

function autopilotGuard(req, res) {
  if (isLocalRequest(req)) return false;
  sendError(res, 403, 'AUTOPILOT_LOCAL_ONLY', 'Autopilot control is available only from the local HUD');
  return true;
}

app.get('/api/autopilot/snapshot', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const state = await autopilotRunner.readState(autopilot);
  const persisted = autopilotRunner.loadState();
  res.json({
    ...autopilot.snapshot({
      ref: autopilotRunner.ref,
      stateFile: path.basename(autopilotRunner.stateFile),
      sharedTreeDirty: state.sharedTreeDirty,
      staleWorktrees: state.dirtyFiles,
      baseline: persisted.baselineFailures ?? null,
      baselineEstablishedAt: persisted.baselineEstablishedAt ?? null,
      lastVerification: persisted.lastVerification ?? null,
      lastRegression: persisted.lastRegression ?? null,
    }),
  });
});

app.get('/api/autopilot/proposals', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ proposals: autopilot.proposals, sequence: autopilot.sequence });
});

// Land/dismiss are operator decisions. The autopilot can propose all it likes;
// this is the only way a proposal ever changes state, and it is loopback-only.
app.post('/api/autopilot/proposals/:id/land', (req, res) => {
  if (!isLocalRequest(req)) return sendError(res, 403, 'local_only', 'spawning and signalling happen on this machine; available only from the local HUD');
  if (autopilotGuard(req, res)) return;
  try {
    const note = typeof req.body?.note === 'string' ? req.body.note.slice(0, 200) : 'landed by operator';
    const proposal = autopilot.land(req.params.id, note);
    autopilotRunner.persist(autopilot);
    res.json({ ok: true, proposal });
  } catch (error) {
    sendError(res, 409, 'autopilot_land_failed', error.message);
  }
});

app.post('/api/autopilot/proposals/:id/dismiss', (req, res) => {
  if (!isLocalRequest(req)) return sendError(res, 403, 'local_only', 'spawning and signalling happen on this machine; available only from the local HUD');
  if (autopilotGuard(req, res)) return;
  try {
    const reason = typeof req.body?.reason === 'string' ? req.body.reason.slice(0, 200) : 'dismissed by operator';
    const proposal = autopilot.dismiss(req.params.id, reason);
    autopilotRunner.persist(autopilot);
    res.json({ ok: true, proposal });
  } catch (error) {
    sendError(res, 409, 'autopilot_dismiss_failed', error.message);
  }
});

app.post('/api/autopilot/policy', (req, res) => {
  if (!isLocalRequest(req)) return sendError(res, 403, 'local_only', 'spawning and signalling happen on this machine; available only from the local HUD');
  if (autopilotGuard(req, res)) return;
  try {
    const policy = autopilot.updatePolicy(req.body || {});
    autopilotRunner.persist(autopilot);
    res.json({ ok: true, policy });
  } catch (error) {
    sendError(res, 400, 'autopilot_policy_invalid', error.message);
  }
});

// One manual tick, for the operator who does not want to wait for the interval.
app.post('/api/autopilot/tick', async (req, res) => {
  if (!isLocalRequest(req)) return sendError(res, 403, 'local_only', 'spawning and signalling happen on this machine; available only from the local HUD');
  if (autopilotGuard(req, res)) return;
  const verdict = await autopilot.tick();
  autopilotRunner.persist(autopilot);
  res.json({ ok: true, ...verdict });
});

// Read-only performance roll-up over the hive. Deliberately unauthenticated
// read, like the other GETs, and deliberately free of side effects.
app.get('/api/fleet/performance', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    res.json(computeFleetPerformance({ hive: HIVE }));
  } catch (error) {
    sendError(res, 500, 'fleet_performance_failed', error.message);
  }
});

// The ticker. Off by default (policy.enabled is false), so a fresh install
// never runs a suite on a timer by surprise. unref() so it never holds the
// process open on shutdown.
const autopilotTimer = setInterval(() => {
  autopilot.tick()
    .then((verdict) => {
      autopilotRunner.persist(autopilot);
      if (verdict && verdict.ok === false) {
        console.log(`[office-hud] autopilot tick refused: ${verdict.reason}`);
      }
    })
    .catch((error) => console.error('[office-hud] autopilot tick failed:', error.message));
}, AUTOPILOT_TICK_MS);
autopilotTimer.unref?.();

app.get('/api/terminals/:id', (req, res) => {
  if (terminalGuard(req, res)) return;
  const terminal = terminalManager.get(req.params.id);
  if (!terminal) return sendError(res, 404, 'unknown_terminal', `No terminal ${req.params.id}`);
  const logs = terminalManager.logs(req.params.id, { lines: 50 });
  res.set('Cache-Control', 'no-store');
  res.json({ terminal, logs: logs.lines, log_bytes: logs.bytes });
});

app.get('/api/terminals/:id', (req, res) => {
  if (terminalGuard(req, res)) return;
  const terminal = terminalManager.get(req.params.id);
  if (!terminal) return sendError(res, 404, 'unknown_terminal', `No terminal ${req.params.id}`);
  const logs = terminalManager.logs(req.params.id, { lines: 50 });
  res.set('Cache-Control', 'no-store');
  res.json({ terminal, logs: logs.lines, log_bytes: logs.bytes });
});

app.get('/api/terminals/:id/logs', (req, res) => {
  if (terminalGuard(req, res)) return;
  try {
    res.set('Cache-Control', 'no-store');
    res.json(terminalManager.logs(req.params.id, { lines: req.query.lines }));
  } catch (error) {
    sendError(res, error.statusCode || 500, 'TERMINAL_LOGS_FAILED', error.message);
  }
});

// Follow a terminal's output. SSE rather than a websocket because this is a
// one-way stream and the socket path already reserves /api/live/socket.
app.get('/api/terminals/:id/follow', (req, res) => {
  if (terminalGuard(req, res)) return;
  let terminal;
  try { terminal = terminalManager.get(req.params.id); } catch { terminal = null; }
  if (!terminal) return sendError(res, 404, 'unknown_terminal', `No terminal ${req.params.id}`);
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.write(`event: hello\ndata: ${JSON.stringify({ id: terminal.id, status: terminal.status })}\n\n`);

  let cursor = terminalManager.logsSince(req.params.id, 0).at || 0;
  const drop = () => { clearInterval(timer); try { res.end(); } catch { /* closed */ } };
  req.on('close', drop);
  res.on('error', drop);
  const timer = setInterval(() => {
    let next;
    try { next = terminalManager.logsSince(req.params.id, cursor); } catch { drop(); return; }
    if (next.chunk) {
      cursor = next.at;
      res.write(`event: output\ndata: ${JSON.stringify({ chunk: next.chunk })}\n\n`);
    }
    const live = terminalManager.get(req.params.id);
    if (!live || live.status !== 'running') {
      res.write(`event: status\ndata: ${JSON.stringify({ status: live ? live.status : 'gone' })}\n\n`);
      drop();
    }
  }, 700);
});

app.post('/api/terminals/:id/kill', async (req, res) => {
  if (!isLocalRequest(req)) return sendError(res, 403, 'local_only', 'spawning and signalling happen on this machine; available only from the local HUD');
  if (terminalGuard(req, res)) return;
  try {
    const terminal = await terminalManager.kill(req.params.id, { signal: (req.body || {}).signal });
    liveHub?.publish(['terminalsSpawned']);
    res.json({ ok: true, terminal });
  } catch (error) {
    sendError(res, error.statusCode || 500, 'TERMINAL_KILL_FAILED', error.message);
  }
});

app.post('/api/terminals/:id/signal', async (req, res) => {
  if (!isLocalRequest(req)) return sendError(res, 403, 'local_only', 'spawning and signalling happen on this machine; available only from the local HUD');
  if (terminalGuard(req, res)) return;
  try {
    const terminal = await terminalManager.signal(req.params.id, (req.body || {}).signal);
    res.json({ ok: true, terminal });
  } catch (error) {
    sendError(res, error.statusCode || 500, 'TERMINAL_SIGNAL_FAILED', error.message);
  }
});

function getProcesses() {
  const doc = readJson(path.join(HIVE, 'processes.json'), { processes: [] });
  // Same reasoning as terminalSnapshot: the hive keeps the real command line,
  // the served copy does not. These are real process command lines, so a token
  // passed as an argument would otherwise be readable by any HUD viewer.
  //
  // processView adds the provenance this payload was missing: where the rows came
  // from and how old they are. Without them an on-disk file frozen since yesterday
  // renders identically to one written a minute ago, which is a cache pretending to
  // be live. stored_status keeps what was actually recorded so a view can show what
  // it claimed, and a stale observation is served as STALE rather than under its own
  // status.
  return processView({ ...doc, source: doc.source || 'hive/processes.json' });
}

app.get('/api/processes', (_req, res) => {
  res.json(buildSnapshot('processes'));
});

function getProjects() {
  return readJson(path.join(HIVE, 'projects.json'), { projects: [] });
}

app.get('/api/projects', (_req, res) => {
  res.json(buildSnapshot('projects'));
});

// ---------- trading bot routes ----------

app.get('/api/trading/backtests', (_req, res) => {
  res.json(buildSnapshot('tradingBacktests'));
});

app.get('/api/trading/strategies', (_req, res) => {
  res.json(buildSnapshot('tradingStrategies'));
});

app.get('/api/trading/live', async (_req, res) => {
  res.json(await getLiveMetrics());
});

app.get('/api/trading/ops', (_req, res) => {
  res.json(buildSnapshot('tradingOps'));
});

app.get('/api/validationEvidence', (_req, res) => {
  res.json(buildSnapshot('validationEvidence'));
});

app.get('/api/knowledge/graphify', (_req, res) => {
  res.json(getGraphifyStats());
});

app.get('/api/knowledge/graphify/data', (_req, res) => {
  res.json(getGraphifyGraph());
});

app.get('/api/knowledge/graphify/communities', (_req, res) => {
  res.json(buildSnapshot('knowledge'));
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
// The LLM client builds 4 provider objects and re-reads hive/registry.json in its
// constructor, so it is created once per process instead of once per request.
let llmClientSingleton = null;
function getLLMClient() {
  if (!llmClientSingleton) {
    const { LLMClient } = require(path.join(HIVE, 'lib', 'llm', 'client'));
    llmClientSingleton = new LLMClient();
  }
  return llmClientSingleton;
}

app.get('/api/llm/providers', (_req, res) => {
  res.json(buildSnapshot('providers'));
});

app.get('/api/llm/costs', (_req, res) => {
  res.json(buildSnapshot('costs'));
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
  res.json(buildSnapshot('breakers'));
});

app.post('/api/llm/circuit-breakers/reset', (req, res) => {
  const { resetAllBreakers } = require(path.join(HIVE, 'lib', 'llm', 'circuitBreaker'));
  resetAllBreakers();
  res.json({ ok: true });
});

app.post('/api/llm/test', async (req, res) => {
  if (!isLocalRequest(req)) return sendError(res, 403, 'forbidden', 'llm/test is local-only');
  const { prompt, agentId, taskType, provider, model } = req.body || {};
  if (typeof prompt !== 'string' || !prompt.trim()) return sendError(res, 400, 'bad_request', 'prompt is required');
  if (prompt.length > 8000) return sendError(res, 400, 'bad_request', 'prompt is too long');
  try {
    const client = getLLMClient();
    const result = await client.call(prompt, { agentId: agentId || 'test', taskType: taskType || 'default', provider, preferredModel: model });
    res.json({ ok: true, result });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ---------- Polymarket Paper Trading ----------
function getPolymarketState() {
  const loaded = loadPolymarketState();
  const state = loaded?.state || null;
  const gate = readJsonCached(path.join(POLYMARKET_RESEARCH, 'profitability_gate.json'), null);
  const audit = readJsonl(path.join(POLYMARKET_RESEARCH, 'signal_audit.jsonl'), 2000);
  const metrics = state?.performance_metrics || {};
  const auditAllowed = audit.filter(item => item.decision === 'allow').length;
  const rejectReasons = {};
  for (const item of audit) {
    if (item.decision !== 'reject') continue;
    const reason = String(item.reason || 'unknown').split('(')[0];
    rejectReasons[reason] = (rejectReasons[reason] || 0) + 1;
  }
  return {
    present: !!state,
    mode: state && state.dry_run ? 'dry-run' : 'paper',
    trades: state ? state.trade_history.length : 0,
    net_pnl: metrics.net_pnl ?? null,
    realized_edge: metrics.realized_edge ?? null,
    updated_at: state ? state.timestamp : null,
    gate: gate ? { status: gate.gate_status, priced_exits: gate.priced_exits, requirements_met: gate.requirements_met } : null,
    audit: { total: audit.length, allowed: auditAllowed, rejected: audit.length - auditAllowed, reject_reasons: rejectReasons },
  };
}

app.get('/api/polymarket', (_req, res) => {
  try {
    res.json(getPolymarketState());
  } catch (error) {
    sendError(res, error.statusCode || 500, 'POLYMARKET_STATE_INVALID', error.message);
  }
});

function getPolymarketMarkets() {
  const loaded = loadPolymarketState();
  const exclusions = readMarketExclusions();
  return {
    ...summarizePolymarketMarkets(loaded?.state || null, exclusions.exclusions),
    exclusions: {
      path: exclusions.path,
      present: exclusions.present,
      valid: exclusions.valid,
      count: exclusions.valid ? exclusions.exclusions.length : null,
      items: exclusions.exclusions,
      error: exclusions.error,
    },
  };
}

app.get('/api/polymarket/markets', (_req, res) => {
  try {
    res.json(getPolymarketMarkets());
  } catch (error) {
    sendError(res, error.statusCode || 500, 'POLYMARKET_STATE_INVALID', error.message);
  }
});

app.post('/api/polymarket/markets/exclude', (req, res) => {
  try {
    res.json({ ok: true, ...mutateMarketExclusion('exclude', req.body) });
  } catch (error) {
    sendError(res, error.statusCode || 500, 'POLYMARKET_EXCLUSION_REJECTED', error.message);
  }
});

app.post('/api/polymarket/markets/include', (req, res) => {
  try {
    res.json({ ok: true, ...mutateMarketExclusion('include', req.body) });
  } catch (error) {
    sendError(res, error.statusCode || 500, 'POLYMARKET_EXCLUSION_REJECTED', error.message);
  }
});

app.post('/api/polymarket/trades/clear', (req, res) => {
  try {
    const result = clearLocalPolymarketTrades(req.body);
    // loadPolymarketState() reads straight from disk, so there is nothing cached
    // to invalidate here — the next read already sees the cleared file.
    res.json({ ok: true, ...result });
  } catch (error) {
    sendError(res, error.statusCode || 500, 'POLYMARKET_CLEAR_REJECTED', error.message);
  }
});

app.get('/api/polymarket/status', (_req, res) => {
  res.json(getPolymarketRuntime());
});

app.post('/api/polymarket/start', async (_req, res) => {
  const runtime = getPolymarketRuntime();
  if (!runtime.managed) return sendError(res, 501, 'engine_not_managed', 'No managed paper-only Polymarket engine configuration is available');
  if (!runtime.paper_only) return sendError(res, 409, 'paper_only_required', 'Paper-only mode is required');
  if (!runtime.launchd.expected_loaded) return sendError(res, 409, 'engine_not_loaded', 'The managed Polymarket engine is not loaded from the expected launchd plist');
  if (runtime.running) return res.json({ ok: true, already_running: true, ...runtime });
  try {
    execFileSync('/bin/launchctl', ['kickstart', '-k', POLYMARKET_LAUNCHD_TARGET], { stdio: 'pipe' });
  } catch (error) {
    return sendError(res, 502, 'engine_start_error', 'Unable to start the managed Polymarket engine', { reason: error.message });
  }
  await new Promise(resolve => setTimeout(resolve, 300));
  const after = getPolymarketRuntime();
  if (!after.running || !after.launchd.expected_loaded) {
    return sendError(res, 503, 'engine_start_failed', 'The managed Polymarket engine did not become visible after launchctl kickstart', after);
  }
  res.json({ ok: true, started: true, ...after });
});

app.post('/api/polymarket/stop', async (_req, res) => {
  const runtime = getPolymarketRuntime();
  if (!runtime.managed) return sendError(res, 501, 'engine_not_managed', 'No managed paper-only Polymarket engine configuration is available');
  if (!runtime.paper_only) return sendError(res, 409, 'paper_only_required', 'Paper-only mode is required');
  if (!runtime.launchd.loaded) return res.json({ ok: true, already_stopped: true, ...runtime });
  if (!runtime.launchd.expected_loaded) return sendError(res, 409, 'engine_plist_mismatch', 'The launchd job does not use the expected Polymarket plist');
  try {
    execFileSync('/bin/launchctl', ['bootout', POLYMARKET_LAUNCHD_TARGET], { stdio: 'pipe' });
  } catch (error) {
    return sendError(res, 502, 'engine_stop_error', 'Unable to stop the managed Polymarket engine', { reason: error.message });
  }
  await new Promise(resolve => setTimeout(resolve, 300));
  const after = getPolymarketRuntime();
  if (after.running || after.launchd.loaded) {
    return sendError(res, 503, 'engine_stop_failed', 'The managed Polymarket engine is still loaded or running after launchctl bootout', after);
  }
  res.json({ ok: true, stopped: true, ...after });
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
  if (!isLocalRequest(req)) return sendError(res, 403, 'forbidden', 'recovery is local-only');
  if (!isIdentifier(req.params.agentId)) return sendError(res, 400, 'bad_request', 'invalid agentId');
  const { manualRecover } = require(path.join(HIVE, 'lib', 'recovery'));
  try {
    await manualRecover(req.params.agentId);
    res.json({ ok: true });
  } catch (error) {
    sendError(res, error.statusCode || 500, 'RECOVERY_FAILED', error.message);
  }
});

app.post('/api/recovery/start', async (req, res) => {
  if (!isLocalRequest(req)) return sendError(res, 403, 'forbidden', 'recovery is local-only');
  const { startRecoveryEngine } = require(path.join(HIVE, 'lib', 'recovery'));
  try {
    await startRecoveryEngine();
    res.json({ ok: true });
  } catch (error) {
    sendError(res, error.statusCode || 500, 'RECOVERY_FAILED', error.message);
  }
});

app.post('/api/recovery/stop', async (req, res) => {
  if (!isLocalRequest(req)) return sendError(res, 403, 'forbidden', 'recovery is local-only');
  const { stopRecoveryEngine } = require(path.join(HIVE, 'lib', 'recovery'));
  try {
    await stopRecoveryEngine();
    res.json({ ok: true });
  } catch (error) {
    sendError(res, error.statusCode || 500, 'RECOVERY_FAILED', error.message);
  }
});

// ---------- JEV / Task Queue ----------
app.get('/api/jev/stats', (_req, res) => {
  const raw = readJson(path.join(HIVE, 'tasks.json'), {});
  const list = Array.isArray(raw) ? raw : (Array.isArray(raw?.tasks) ? raw.tasks : []);
  const byStatus = {};
  for (const t of list) {
    const status = (t && t.status) || 'unknown';
    byStatus[status] = (byStatus[status] || 0) + 1;
  }
  res.json({ tasks: list.length, byStatus, queues: {} }); // TODO: implement queues
});

// ---------- Sessions with reattach ----------
app.post('/api/sessions/:id/reattach', async (req, res) => {
  const { reattachSession } = require(path.join(HIVE, 'lib', 'session'));
  const { agentId, processId } = req.body;
  const ok = reattachSession(req.params.id, agentId, processId);
  res.json({ ok });
});

// ---------- live data: resource snapshots + change detection ----------

let watcher = null;
let watchTimer = null;
const resourceSignatures = new Map();

function build(name, produce, options = {}) {
  return {
    name,
    produce,
    signature: options.signature,
    onError: options.onError,
    // Telemetry must never be cached, by the browser or the service worker.
    noStore: options.noStore ?? false,
    // Expensive producers (sqlite, launchctl, subprocesses, a 770KB graph) are
    // not re-checked on every hive write.
    minIntervalMs: options.minIntervalMs ?? 0,
    checkedAt: 0,
  };
}

/**
 * Every panel reads a named resource rather than a bespoke URL. The socket and
 * the REST mirror both serve from this table, so a push and a poll can never
 * disagree about shape.
 */
const RESOURCES = {
  summary: build('summary', () => {
    const agents = mergedAgents();
    const roster = getFleet();
    const rosterAge = rosterFreshness(roster);
    // Each agent inherits breaker and the counters from this roster, so each row
    // carries the age of the observation it inherited them from. Same measurement as
    // fleet.stale, surfaced where it is used -- not a second contract. It
    // deliberately does not touch status or display, which stay live-derived.
    for (const a of agents) {
      if (!a) continue;
      a.rosterStale = rosterAge.stale;
      a.rosterAgeSeconds = rosterAge.age_seconds;
      a.rosterObservedAt = rosterAge.observed_at;
    }
    return { ...hiveStatus(), fleet: { ...roster, ...rosterAge }, godId: getRegistry().godId, agents, floors: rollupFloors(agents) };
  }),
  agents: build('agents', () => ({ agents: mergedAgents() })),
  queue: build('queue', () => getQueueSummary()),
  projects: build('projects', () => getProjects()),
  taskCounts: build('taskCounts', () => ({ counts: getFloorTaskCounts() })),
  taskBoard: build('taskBoard', () => getTaskBoard(25)),
  sessions: build('sessions', () => ({ sessions: sessionRows() })),
  processes: build('processes', () => getProcesses()),
  // Terminals this host started. A cheap signature keeps the socket from
  // pushing an identical payload on every hive write, and the 5s floor keeps a
  // fast-moving terminal list from turning into a push storm.
  terminalsSpawned: build('terminalsSpawned', () => ({
    spawned: terminalManager.list(),
    health: terminalManager.health(),
  }), { signature: () => `${terminalManager.list().length}:${terminalManager.activeCount()}:${terminalManager.health().log_bytes}`, minIntervalMs: 5000 }),
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
  }, { onError: (error) => ({ providers: [], health: {}, error: error.message }) }),
  breakers: build('breakers', () => {
    const { getAllBreakers } = require(path.join(HIVE, 'lib', 'llm', 'circuitBreaker'));
    return { breakers: getAllBreakers() };
  }, { onError: (error) => ({ breakers: {}, error: error.message }) }),
  costs: build('costs', () => {
    const { getTotalCosts, getAgentCosts } = require(path.join(HIVE, 'lib', 'llm', 'cost'));
    const agents = {};
    for (const a of mergedAgents()) agents[a.id] = getAgentCosts(a.id);
    return { agents, total: getTotalCosts() };
  }, { onError: (error) => ({ agents: {}, total: null, error: error.message }) }),
  knowledge: build('knowledge', () => getGraphifyCommunities()),
  polymarket: build('polymarket', () => getPolymarketState(), {
    onError: (error) => ({ present: false, mode: 'unknown', trades: 0, net_pnl: null, realized_edge: null, updated_at: null, gate: null, audit: { total: 0, allowed: 0, rejected: 0, reject_reasons: {} }, error: error.message }),
    minIntervalMs: 15000,
  }),
  // The tail is a bounded read of a 29MB log, so this is the reachable window
  // and not the whole history. Both this and /api/events carry the flag so the
  // live twin and the route expose the same fields.
  events: build('events', () => ({ events: getRecentEvents(300), reachable_window: true })),
  jarvisTasks: build('jarvisTasks', () => ({ tasks: getJarvisTasks(50) })),
  knowledgeStats: build('knowledgeStats', () => getGraphifyStats()),
  knowledgeGraph: build('knowledgeGraph', () => getGraphifyGraph(), { minIntervalMs: 60000 }),
  tradingBacktests: build('tradingBacktests', () => ({ backtest: getBacktestResults(), walkforward: getWalkForwardResults() }), { minIntervalMs: 15000 }),
  tradingStrategies: build('tradingStrategies', () => ({ config: getTradingBotConfig(), strategies: getStrategies() }), { minIntervalMs: 15000 }),
  tradingOps: build('tradingOps', () => ({ launchd: getFleetPlists(), launchdState: getFleetLaunchdState(), adherence: getAdherenceLogs(), roster: getRoster() }), { minIntervalMs: 15000 }),
  validationEvidence: build('validationEvidence', () => getValidationEvidence(), { minIntervalMs: 30000 }),
  combined: build('combined', () => readJson(path.join(os.homedir(), 'trading', 'openalice', 'ui', 'public', 'combined_portfolio.json'), {}), { minIntervalMs: 15000 }),
  tradingLive: build('tradingLive', () => getLiveMetrics(), { minIntervalMs: 30000 }),
  polymarketStatus: build('polymarketStatus', () => getPolymarketRuntime(), { minIntervalMs: 30000 }),
  polymarketMarkets: build('polymarketMarkets', () => getPolymarketMarkets(), {
    onError: (error) => ({ error: error.message, markets: [], exclusions: { present: false, valid: false, count: null, items: [], error: error.message } }),
    minIntervalMs: 30000,
  }),
  // Hub telemetry, addressed as a resource so the client's store can poll it
  // through the same path. It is deliberately not pushed.
  streamStatus: build('streamStatus', () => (
    liveHub
      ? liveHub.status()
      : { state: 'offline', socketPath: '/api/live/socket', clients: 0, sequence: 0, stats: { publishes: 0, pushes: 0 }, viewers: [] }
  ), { signature: () => 'telemetry', noStore: true }),

  autonomy: build('autonomy', () => (
    autonomy
      ? autonomy.snapshot()
      : { policy: null, assessment: null, proposals: [], pending: 0, audit: [] }
  )),

  alerts: build('alerts', () => (
    alertEngine
      ? alertEngine.snapshot()
      : { alerts: [], counts: { critical: 0, warn: 0, info: 0 }, unacknowledged: 0, history: [] }
  )),
};

const resourceNames = () => Object.keys(RESOURCES);

/**
 * Resources addressed with a parameter, as `base/param`. The parameter is
 * checked against a strict pattern so a crafted key cannot reach outside the
 * hive.
 */
const PARAMETERIZED = {
  agents: {
    pattern: /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/,
    produce: (id) => {
      const detail = getAgentDetail(id);
      if (!detail) throw requestError(`Unknown agent ${id}`, 404);
      return detail;
    },
  },
  ledger: {
    pattern: /^(events|log)$/,
    produce: (source) => getLedger(source, null, 500),
  },
};

function resolveResource(name) {
  if (RESOURCES[name]) return RESOURCES[name];
  const slash = name.indexOf('/');
  if (slash <= 0) return null;
  const spec = PARAMETERIZED[name.slice(0, slash)];
  const parameter = name.slice(slash + 1);
  if (!spec || !spec.pattern.test(parameter)) return null;
  return {
    name,
    produce: () => spec.produce(parameter),
    parameterized: true,
  };
}

// Probed resources -- the ones declared with an explicit signature -- are
  // memoised briefly. They cost a network round trip each: /health is a 2s-timeout
  // fetch, so two reads of the same resource in quick succession can straddle that
  // timeout and return different payloads. Under the full suite the harness has
  // been observed answering in 2.578s, which is what makes resources.test.js's
  // "/api/harness/health and /api/live/harness agree" fail intermittently and never
  // when that file runs alone. That is a HUD lying about its own contract: the same
  // resource changing shape depending on latency.
  //
  // Only signature-bearing resources are memoised. Everything else is read from the
  // hive on every call, which is what the write-then-read tests depend on -- and
  // build() already declares minIntervalMs and signature for exactly this purpose.
  const probeCache = new Map();
  const PROBE_CACHE_MS = 5000;

  function buildSnapshot(name) {
    const resource = resolveResource(name);
    if (!resource) throw requestError(`Unknown resource ${name}`, 404);
    if (!resource.signature) {
      try {
        return resource.produce();
      } catch (error) {
        // A hive missing a library (llm/, recovery/) must degrade to a payload the
        // UI can render, not a 500 for the whole panel.
        if (resource.onError) return resource.onError(error);
        throw error;
      }
    }
    const hit = probeCache.get(name);
    if (hit && Date.now() - hit.at < PROBE_CACHE_MS) return hit.value;
    try {
      const value = resource.produce();
      probeCache.set(name, { at: Date.now(), value });
      return value;
    } catch (error) {
      if (resource.onError) return resource.onError(error);
      throw error;
    }
  }

const buildSnapshotAsync = (name) => Promise.resolve(buildSnapshot(name));

/** The hive view the analyzers and the autonomy monitor read. */
function readSnapshot() {
  return {
    summary: buildSnapshot('summary'),
    queue: buildSnapshot('queue'),
    breakers: buildSnapshot('breakers'),
    costs: buildSnapshot('costs'),
    services: buildSnapshot('services'),
    harness: buildSnapshot('harness'),
  };
}

/** Stable short hash, so a signature is one word instead of a whole payload. */
function hashOf(text) {
  return crypto.createHash('sha1').update(String(text)).digest('hex').slice(0, 16);
}

function signatureOf(name) {
  const resource = resolveResource(name);
  if (!resource) return 'error';
  const now = Date.now();
  if (resource.minIntervalMs && now - resource.checkedAt < resource.minIntervalMs) {
    return resourceSignatures.get(name) ?? 'unchecked';
  }
  resource.checkedAt = now;
  try {
    // Probing resources are async, so they carry an explicit cheap signature
    // instead of being stringified synchronously.
    if (resource.signature) return resource.signature();
    // buildSnapshot already applies the resource's onError fallback.
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

/**
 * Drop the read cache before recomputing signatures. Without this a write that
 * lands inside the cache TTL is compared against — and pushed as — the previous
 * value, so a subscriber can receive a payload that predates the change.
 */
function invalidateCaches() {
  jsonCache.clear();
}

function onHiveChanged() {
  watchTimer = null;
  invalidateCaches();
  // Parameterized resources have no fixed list, so they are re-checked against
  // what clients actually subscribe to. The agent detail is TTL-cached, so this
  // stays cheap.
  const subscribed = liveHub?.subscribedKeys() ?? [];
  const changed = [...new Set([...changedResources(), ...subscribed])];
  if (changed.length) liveHub?.publish(changed);
  broadcastSse();
  if (alertEngine) liveHub?.publishAlerts(alertEngine.evaluate());
  if (autonomy) {
    const before = autonomy.pending;
    autonomy.evaluate();
    if (autonomy.pending !== before) liveHub?.publish(['autonomy']);
  }
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
  res.write('event: hello\ndata: {}\n\n');
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
    try { res.write(': ping\n\n'); } catch { drop(); }
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
      if (res.write('event: change\ndata: {}\n\n') === false) {
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

app.post('/api/alerts/ack-all', (req, res) => {
  if (!isLocalRequest(req)) return sendError(res, 403, 'forbidden', 'alert acknowledgement is local-only');
  if (!alertEngine) return res.json({ ok: true, acked: 0 });
  res.json({ ok: true, acked: alertEngine.ackAll() });
});

app.post('/api/alerts/:fingerprint/ack', (req, res) => {
  if (!isLocalRequest(req)) return sendError(res, 403, 'forbidden', 'alert acknowledgement is local-only');
  if (!alertEngine) return sendError(res, 503, 'unavailable', 'alert engine not running');
  const ok = alertEngine.ack(String(req.params.fingerprint));
  if (!ok) return sendError(res, 404, 'unknown_alert', 'No active alert with that fingerprint');
  liveHub?.publishAlerts(alertEngine.snapshotList());
  res.json({ ok: true });
});

app.post('/api/alerts/:fingerprint/unack', (req, res) => {
  if (!isLocalRequest(req)) return sendError(res, 403, 'forbidden', 'alert acknowledgement is local-only');
  if (!alertEngine) return sendError(res, 503, 'unavailable', 'alert engine not running');
  const ok = alertEngine.unack(String(req.params.fingerprint));
  if (!ok) return sendError(res, 404, 'unknown_alert', 'No active alert with that fingerprint');
  liveHub?.publishAlerts(alertEngine.snapshotList());
  res.json({ ok: true });
});

// ---------- autonomy (opt-in; proposes, never deploys on its own) ----------

app.get('/api/autonomy', (_req, res) => {
  if (!autonomy) return res.json({ policy: null, assessment: null, proposals: [], pending: 0, audit: [] });
  autonomy.evaluate();
  res.json(autonomy.snapshot());
});

app.post('/api/autonomy/policy', (req, res) => {
  if (!isLocalRequest(req)) return sendError(res, 403, 'forbidden', 'autonomy policy is local-only');
  if (!autonomy) return sendError(res, 503, 'unavailable', 'autonomy is not running');
  try {
    const policy = autonomy.updatePolicy(req.body || {});
    liveHub?.publish(['autonomy']);
    res.json({ ok: true, policy });
  } catch (error) {
    sendError(res, 400, 'invalid_policy', error.message);
  }
});

app.post('/api/autonomy/proposals/:id/accept', (req, res) => {
  if (!isLocalRequest(req)) return sendError(res, 403, 'forbidden', 'accepting a proposal is local-only');
  if (!autonomy) return sendError(res, 503, 'unavailable', 'autonomy is not running');
  const result = autonomy.accept(String(req.params.id));
  if (!result.ok) return sendError(res, 409, 'not_accepted', result.error);
  liveHub?.publish(['autonomy']);
  res.json(result);
});

app.post('/api/autonomy/proposals/:id/dismiss', (req, res) => {
  if (!isLocalRequest(req)) return sendError(res, 403, 'forbidden', 'dismissing a proposal is local-only');
  if (!autonomy) return sendError(res, 503, 'unavailable', 'autonomy is not running');
  const result = autonomy.dismiss(
    String(req.params.id),
    String(req.body?.reason || '').slice(0, 200) || undefined
  );
  if (!result.ok) return sendError(res, 409, 'not_dismissed', result.error);
  liveHub?.publish(['autonomy']);
  res.json(result);
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
  res.set('Cache-Control', 'no-store');
  res.json(buildSnapshot('streamStatus'));
});

// A trailing wildcard, because parameterized resources are addressed as
// `agents/<id>`. Express 4 matches '*' and hands the remainder back in
// params[0]; the named form (`*name`) is Express 5 syntax and silently matches
// nothing here.
app.get('/api/live/*', async (req, res) => {
  const raw = req.params[0] ?? '';
  const name = Array.isArray(raw) ? raw.join('/') : String(raw);
  const resource = resolveResource(name);
  if (!resource) return sendError(res, 404, 'unknown_resource', `Unknown resource ${name}`);
  if (resource.noStore) res.set('Cache-Control', 'no-store');
  try {
    res.json(await buildSnapshotAsync(name));
  } catch (error) {
    sendError(res, error.statusCode || 500, 'resource_failed', error.message);
  }
});

// ---------- single-port portal ----------

function portalSlugForPort(port) {
  for (const [slug, entry] of PORTAL_SERVICES) {
    if (entry.port === port) return slug;
  }
  return null;
}

// Keep redirects inside this origin so following one never lands the operator
// back on a raw port number.
function rewriteUpstreamLocation(location) {
  const value = String(location || '');
  const match = /^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):(\d+)(\/[^?#]*)?(\?[^#]*)?/i.exec(value);
  if (!match) return value;
  const targetPort = Number(match[1]);
  const tail = match[2] || '/';
  const query = match[3] || '';
  const dest = portalSlugForPort(targetPort);
  if (!dest) return value;
  return `/port/${dest}${tail}${query}`;
}

function portalTarget(slug, rest, query) {
  const entry = PORTAL_SERVICES.get(slug);
  if (!entry) return null;
  const raw = String(rest == null ? '' : rest).replace(/^\/+/, '');
  if (/[\r\n]/.test(raw)) return null;
  // A traversal segment could walk out of the intended upstream path.
  if (raw.split('/').some((segment) => segment === '..' || segment === '.')) return null;
  // Express 4's params[0] excludes the query string, so the upstream path has to
  // carry it explicitly. Without this, a dashboard reached through the portal
  // loses `?token=` and the pubserver answers 401 — the same link works
  // directly, which is what makes this read as a portal-only fault.
  const qs = query == null ? '' : String(query);
  if (/[\r\n]/.test(qs)) return null;
  return { entry, targetPath: `/${raw}${qs ? `?${qs}` : ''}` };
}

function proxyPortal(target, slug, res, req) {
  const http = require('http');
  // Relay only the caller's own credentials. The portal holds no secret, so it
  // cannot grant access the caller did not already have.
  const forwarded = {};
  if (req && typeof req.headers.authorization === 'string') {
    forwarded.authorization = req.headers.authorization;
  }
  const upstream = http.request(
    { host: '127.0.0.1', port: target.entry.port, path: target.targetPath, method: 'GET', timeout: 10000, headers: forwarded },
    (upstreamRes) => {
      const type = String(upstreamRes.headers['content-type'] || '');
      if (type) res.setHeader('Content-Type', type);
      const location = rewriteUpstreamLocation(upstreamRes.headers.location);
      if (location) res.setHeader('Location', location);
      // Dashboards must not be served from cache or a fix would go unnoticed.
      if (type.includes('text/html')) res.setHeader('Cache-Control', 'no-store');
      res.status(upstreamRes.statusCode || 502);
      upstreamRes.pipe(res);
    },
  );
  upstream.on('timeout', () => upstream.destroy(new Error('upstream timeout')));
  upstream.on('error', (error) => {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    sendError(res, 502, 'portal_upstream_error',
      `${target.entry.label} (127.0.0.1:${target.entry.port}): ${error.message}`);
  });
  upstream.end();
}

function portalEntry(req, res) {
  // Registered wildcard-first: without strict routing `/port/dash/` also matches
  // `/port/:slug`, and a redirect there would loop onto itself forever.
  if (req.params[0] === undefined) {
    return res.redirect(302, `${req.path}/`);
  }
  if (!isLocalRequest(req)) {
    return sendError(res, 403, 'local_only', 'portal proxy is loopback-only');
  }
  const target = portalTarget(req.params.slug, req.params[0], req.originalUrl.includes('?')
    ? req.originalUrl.slice(req.originalUrl.indexOf('?') + 1)
    : '');
  if (!target) {
    return sendError(res, 404, 'unknown_portal_service', 'No such portal service');
  }
  return proxyPortal(target, req.params.slug, res, req);
}

app.get('/port/:slug/*', portalEntry);
app.head('/port/:slug/*', (_req, res) => res.status(405).end());
app.get('/port/:slug', portalEntry);

app.get('/api/portal', async (_req, res) => {
  const health = await getServiceHealth();
  const byPort = new Map((health.services || []).map((service) => [service.port, service]));
  res.json({
    host: health.host,
    checkedAt: health.checkedAt,
    entryPort: PORT,
    services: [...PORTAL_SERVICES].map(([slug, entry]) => {
      const probe = byPort.get(entry.port);
      return {
        slug,
        ...entry,
        status: probe ? probe.status : 'unknown',
        latencyMs: probe ? probe.latencyMs : null,
        path: `/port/${slug}/`,
      };
    }),
  });
});

// ---------- tournament (password-free, served HUD-side) ----------
// The public pubserver (:3002) guards its dashboards with a shared secret, so
// linking there from the HUD would prompt for a password. The HUD already runs
// on this host and only needs the feed, so it reads the file itself and serves
// both a JSON route and a self-contained page. This does NOT weaken the
// pubserver: no auth exemption is added there, and no order path is touched.
// The feed's `ts` is timezone-aware UTC (fixed in services/oa_tournament.py), so
// staleness is computed correctly instead of being ~5.5h out.

const FLEET_STATE_DIR = process.env.OPENALICE_STATE_DIR
  || path.join(os.homedir(), 'trading', 'openalice', 'fleet-state');
// NOTE: fleet-state/tournament.json is the large per-strategy STATE file (no
// ts/btc/strategies). The feed the pubserver serves -- and the one
// tournament.html renders -- is the small JSON in ui/public. Read that one.
const FLEET_FEEDS_DIR = process.env.OPENALICE_FEEDS_DIR
  || path.join(os.homedir(), 'trading', 'openalice', 'ui', 'public');
const TOURNAMENT_FEED = path.join(FLEET_FEEDS_DIR, 'tournament.json');
const TOURNAMENT_STALE_S = 660;

function tournamentPayload() {
  const feed = readJsonCached(TOURNAMENT_FEED, null);
  if (!feed || typeof feed !== 'object') {
    return { ok: false, error: 'tournament feed unavailable', path: TOURNAMENT_FEED };
  }
  const strategies = Array.isArray(feed.strategies) ? feed.strategies : [];
  let ageS = null;
  let ts = null;
  if (feed.ts) {
    ts = String(feed.ts);
    const parsed = Date.parse(feed.ts);
    if (Number.isFinite(parsed)) ageS = Math.round((Date.now() - parsed) / 1000);
  } else {
    // Fall back to file mtime so a malformed ts cannot read as "fresh".
    try {
      ageS = Math.round((Date.now() - fs.statSync(TOURNAMENT_FEED).mtimeMs) / 1000);
    } catch { /* unreadable */ }
  }
  return {
    ok: true,
    ts,
    ageS,
    stale: ageS === null ? true : ageS > TOURNAMENT_STALE_S,
    staleAfterS: TOURNAMENT_STALE_S,
    btc: feed.btc ?? null,
    eth: feed.eth ?? null,
    funding_btc: feed.funding_btc ?? null,
    funding_eth: feed.funding_eth ?? null,
    basis: feed.basis ?? null,
    pairs_z: feed.pairs_z ?? null,
    cycles: feed.cycles ?? null,
    leader: feed.leader ?? null,
    strategies: strategies.map((s) => ({
      name: s?.name ?? null,
      side: s?.side ?? null,
      return_pct: s?.return_pct ?? null,
    })),
  };
}

app.get('/api/tournament', (_req, res) => {
  const payload = tournamentPayload();
  if (!payload.ok) {
    return sendError(res, 503, 'tournament_unavailable', payload.error, { path: payload.path });
  }
  res.json(payload);
});

app.get('/tournament', (_req, res) => {
  const p = tournamentPayload();
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
  const rows = p.strategies.map((s, i) => `
      <tr>
        <td class="rank">${i + 1}</td>
        <td>${esc(s.name)}</td>
        <td>${esc(s.side)}</td>
        <td class="${(s.return_pct ?? 0) < 0 ? 'neg' : 'pos'}">${s.return_pct == null ? '—'
          : (s.return_pct >= 0 ? '+' : '') + Number(s.return_pct).toFixed(2) + '%'}</td>
      </tr>`).join('');
  const banner = p.stale
    ? `<div class="warn">STALE — last update ${p.ageS}s ago
       (threshold ${p.staleAfterS}s)</div>`
    : `<div class="ok">fresh — ${p.ageS}s ago</div>`;
  res.type('html').send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Tournament — Office HUD</title>
<style>
  :root{color-scheme:dark}
  body{margin:0;padding:24px;background:#0b0e14;color:#e6e9ef;
       font:14px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace}
  h1{font-size:18px;margin:0 0 4px;letter-spacing:.02em}
  .sub{color:#8b93a7;margin-bottom:16px}
  .cards{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:16px}
  .card{background:#141a26;border:1px solid #232c3d;border-radius:8px;padding:10px 14px}
  .card b{display:block;color:#fff;font-size:16px}
  .card span{color:#8b93a7;font-size:11px;text-transform:uppercase;letter-spacing:.06em}
  table{width:100%;border-collapse:collapse;background:#141a26;
        border:1px solid #232c3d;border-radius:8px;overflow:hidden}
  th,td{text-align:left;padding:8px 12px;border-bottom:1px solid #1c2432}
  th{color:#8b93a7;font-size:11px;text-transform:uppercase;letter-spacing:.06em}
  tr:last-child td{border-bottom:none}
  .rank{color:#8b93a7;width:44px}
  .pos{color:#3ddc97}.neg{color:#ff5c5c}
  .ok{color:#3ddc97;margin-bottom:14px}
  .warn{color:#ffb454;margin-bottom:14px}
  a{color:#6ea8fe}
</style></head><body>
  <h1>Tournament</h1>
  <div class="sub">paper strategies · served by the Office HUD · no password
    · <a href="/api/tournament">JSON</a> · <a href="/">HUD</a></div>
  ${p.ok ? `${banner}
  <div class="cards">
    <div class="card"><b>${esc(p.btc)}</b><span>BTC</span></div>
    <div class="card"><b>${esc(p.eth)}</b><span>ETH</span></div>
    <div class="card"><b>${p.cycles == null ? '—' : esc(p.cycles)}</b><span>cycles</span></div>
    <div class="card"><b>${esc(p.leader)}</b><span>leader</span></div>
  </div>
  <table><thead><tr><th>#</th><th>strategy</th><th>side</th><th>return</th></tr></thead>
  <tbody>${rows || '<tr><td colspan="4">no strategies</td></tr>'}</tbody></table>`
    : `<div class="warn">${esc(p.error)}</div>`}
</body></html>`);
});

// ---------- HUD launcher (injected, no rebuild required) ----------
// The SPA is a Vite build with hashed assets, so adding a nav entry the normal
// way means `npm run build`, which churns asset hashes and has been fragile.
// A bug fix or a small betterment must not depend on a rebuild, so the server
// injects this launcher into the served index.html instead. It is standalone
// (no dependency on React's DOM), idempotent via a marker, and degrades to a
// plain link if the script never runs.

const HUD_LAUNCHER_MARKER = '<!-- hud:tournament-launcher -->';

function hudLauncherSnippet() {
  return `${HUD_LAUNCHER_MARKER}
<style>
  #hud-tournament-launcher{position:fixed;right:16px;bottom:16px;z-index:2147483000;
    display:flex;align-items:center;gap:8px;padding:8px 12px;border-radius:8px;
    background:#141a26;color:#e6e9ef;border:1px solid #232c3d;
    font:12px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;
    text-decoration:none;box-shadow:0 6px 20px rgba(0,0,0,.45)}
  #hud-tournament-launcher:hover{border-color:#3a4a63;background:#182033}
  #hud-tournament-launcher .dot{width:8px;height:8px;border-radius:50%;background:#8b93a7;flex:none}
  #hud-tournament-launcher .dot.fresh{background:#3ddc97}
  #hud-tournament-launcher .dot.stale{background:#ffb454}
  #hud-tournament-launcher .lbl{white-space:nowrap}
  #hud-tournament-launcher b{color:#fff;font-weight:600}
</style>
<a id="hud-tournament-launcher" href="/tournament" title="Paper tournament (no password)">
  <span class="dot"></span><span class="lbl">Tournament</span>
</a>
<script>
(function(){
  var el=document.getElementById('hud-tournament-launcher');
  if(!el)return;
  var dot=el.querySelector('.dot'), lbl=el.querySelector('.lbl');
  fetch('/api/tournament',{cache:'no-store'}).then(function(r){return r.json();})
    .then(function(d){
      if(!d||!d.ok)return;
      dot.className='dot '+(d.stale?'stale':'fresh');
      var lead=(d.strategies&&d.strategies[0])||null;
      if(lead&&lead.return_pct!=null){
        var sign=lead.return_pct>=0?'+':'';
        lbl.textContent='Tournament · '+lead.name+' '+sign+Number(lead.return_pct).toFixed(1)+'%';
        el.setAttribute('aria-label',lbl.textContent);
      }
    }).catch(function(){});
})();
</script>`;
}

function injectHudLauncher(html) {
  if (typeof html !== 'string' || html.includes(HUD_LAUNCHER_MARKER)) return html;
  if (!html.includes('</body>')) return html;
  return html.replace('</body>', `${hudLauncherSnippet()}\n</body>`);
}

// ---------- static web app ----------

const dist = path.join(__dirname, '..', 'web', 'dist');
// Unknown /api paths must not fall through to the SPA and return HTML 200.
app.use('/api', (_req, res) => res.status(404).json({ error: 'Unknown API route' }));
if (fs.existsSync(dist)) {
  // Serve the SPA shell ourselves so the launcher can be injected. express.static
  // would answer `/` with the raw file before this could run.
  const indexHtml = () => {
    try {
      return injectHudLauncher(fs.readFileSync(path.join(dist, 'index.html'), 'utf8'));
    } catch {
      return null;
    }
  };
  app.get('/', (_req, res) => {
    const html = indexHtml();
    if (html === null) return res.sendFile(path.join(dist, 'index.html'));
    res.type('html').send(html);
  });
  app.use(express.static(dist));
  app.get('*', (_req, res) => {
    const html = indexHtml();
    if (html === null) return res.sendFile(path.join(dist, 'index.html'));
    res.type('html').send(html);
  });
} else {
  app.get('*', (_req, res) => res.status(503).send('web/dist is missing — run `npm run build`'));
}

// ---------- process bootstrap ----------
// Everything above is pure wiring: requiring this module yields the express app
// without binding a port, so the test suite can drive it on an ephemeral port
// against a fixture hive.

const http = require('http');

let announcedReady = false;
function announceReady(port) {
  if (announcedReady) return;
  announcedReady = true;
  console.log(`[office-hud] hive: ${HIVE} (${fs.existsSync(HIVE) ? 'found' : 'MISSING'})`);
  console.log(`[office-hud] open → http://localhost:${port}`);
}

const createServer = () => http.createServer(app);

// A launchd restart can find the old process still holding the port; retry
// briefly, but cap the backoff so a restart is never stuck for minutes.
const PORT_BACKOFF_CAP_MS = 4000;

function startServer(port = PORT, retries = 8, delay = 500) {
  const server = createServer();
  return new Promise((resolve, reject) => {
    server.listen(port, HOST, () => {
      announceReady(port);
      resolve(server);
    });

    server.once('error', (err) => {
      if (err.code === 'EADDRINUSE' && retries > 0) {
        console.log(`[office-hud] port ${port} in use, retrying in ${delay}ms... (${retries} retries left)`);
        setTimeout(() => {
          resolve(startServer(port, retries - 1, Math.min(delay * 2, PORT_BACKOFF_CAP_MS)));
        }, delay);
      } else {
        reject(err);
      }
    });
  });
}

let serverInstance = null;

function shutdown(signal) {
  console.log(`[office-hud] received ${signal}, shutting down gracefully...`);
  liveHub?.close();
  alertEngine?.stop();
  if (watcher) { try { watcher.close(); } catch { /* already closed */ } }
  // End the SSE streams first: an open event-stream response keeps the server
  // from draining, which used to trip the force-exit timer on every restart.
  for (const res of [...sseClients]) {
    sseClients.delete(res);
    try { res.end(); } catch { /* already gone */ }
  }
  if (!serverInstance) { process.exit(0); return; }
  const server = serverInstance;
  server.closeAllConnections();
  server.close((err) => {
    if (err) console.error('[office-hud] server close error:', err);
    else console.log('[office-hud] server closed');
    process.exit(0);
  });
  // Backstop only: closeAllConnections() above should have drained by now.
  setTimeout(() => {
    console.error('[office-hud] forced shutdown after timeout');
    process.exit(1);
  }, 5000);
}

/**
 * Fail loudly and once, instead of crash-looping: a half-installed
 * node_modules (an interrupted `npm ci`, a stray symlink) otherwise shows up as
 * repeated MODULE_NOT_FOUND restarts with no explanation.
 */
function verifyDependencies() {
  const required = ['express', 'js-yaml'];
  const missing = required.filter((name) => {
    try { require.resolve(name); return false; } catch { return true; }
  });
  if (missing.length) {
    console.error(
      `[office-hud] missing dependencies: ${missing.join(', ')}.\n` +
      `[office-hud] run: cd ${path.join(__dirname, '..')} && npm ci`
    );
    process.exit(1);
  }
}

function bootstrap() {
  verifyDependencies();
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

  // Spawned terminals outlive a HUD restart (launchd KeepAlive restarts this
  // process within a second of any exit), so the registry is loaded and
  // reconciled against live process state before anything is served. Without
  // this a restart would report every still-running terminal as missing, and a
  // naive fix -- trusting the file -- would report dead ones as running.
  terminalManager.load().then((count) => {
    console.log(`[office-hud] spawned terminals: ${count} reconciled`);
  }).catch((error) => {
    console.warn('[office-hud] spawned terminal load failed:', error.message);
  });

  // Reap finished terminals and their logs. Hourly is deliberate: the cutoff is
  // measured in hours, so a minute-level sweep would only churn the registry.
  // unref'd so it never holds the process open on the way down.
  const reaper = setInterval(() => {
    try { terminalManager.reap(); } catch (error) {
      console.warn('[office-hud] terminal reap failed:', error.message);
    }
  }, 60 * 60 * 1000);
  reaper.unref?.();

  // The engines are constructed at module scope; bootstrap only starts them.
  alertEngine.start();
  autonomy.evaluate();

  return startServer(PORT).then((server) => {
    serverInstance = server;
    // The live socket rides the same HTTP server as the REST API.
    liveHub = new LiveHub({
      snapshot: buildSnapshotAsync,
      alerts: () => (alertEngine ? alertEngine.snapshotList() : []),
      heartbeatMs: 25000,
      isHostAllowed: hostIsAllowed,
    });
    liveHub.attach(server);
    announceReady(PORT);
    return server;
  }).catch((err) => {
    console.error('[office-hud] failed to start server:', err);
    process.exit(1);
  });
}

// The engines exist as soon as the module is loaded, so every route is wired
// whether or not this process went through bootstrap(). bootstrap() only starts
// timers, watches the hive and binds a port.
alertEngine = new AlertEngine({ read: readSnapshot, intervalMs: 30000 });

// The controller shares the snapshot reader and routes through the same JEV
// enqueue a human uses, so an automated request is never privileged over a
// manual one.
autonomy = new AutonomyController({
  read: readSnapshot,
  route: ({ prompt, target, priority }) => enqueueJarvisCommand({
    prompt,
    target,
    priority,
    confirmed: true,
  }),
});

if (require.main === module) {
  bootstrap();
}

// A day plus a two-hour budget: the sync runs daily, so a run is still
// trustworthy a couple of hours past its nominal window.
const PUBLIC_SYNC_STALE_SECONDS = 26 * 60 * 60;
const PUBLIC_SYNC_STATUS_PATH = process.env.OPENALICE_PUBLIC_SYNC_STATUS
  || path.join(__dirname, '..', '..', 'state', 'public_sync_status.json');
function readPublicSyncStatus(now = Date.now(), statusPath = PUBLIC_SYNC_STATUS_PATH) {
  let raw;
  try {
    raw = fs.readFileSync(statusPath, 'utf8');
  } catch (err) {
    const missing = err && err.code === 'ENOENT';
    return {
      present: false,
      status: missing ? 'no_status_file' : 'unreadable',
      error: missing ? null : String((err && err.message) || err).slice(0, 160),
      last_run_at: null,
      age_seconds: null,
      stale: true,
    };
  }
  let record;
  try {
    record = JSON.parse(raw);
  } catch (err) {
    return {
      present: false,
      status: 'unreadable',
      error: String((err && err.message) || err).slice(0, 160),
      last_run_at: null,
      age_seconds: null,
      stale: true,
    };
  }
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    return { present: false, status: 'unreadable', error: 'status file is not an object',
             last_run_at: null, age_seconds: null, stale: true };
  }
  const ranAt = Date.parse(record.last_run_at || '');
  const ageSeconds = Number.isFinite(ranAt) ? Math.max(0, Math.floor((now - ranAt) / 1000)) : null;
  return {
    ...record,
    present: true,
    // A missing or unparseable timestamp is itself stale: we cannot claim the
    // job ran. Silence must never read as health.
    age_seconds: ageSeconds,
    stale: ageSeconds === null || ageSeconds > PUBLIC_SYNC_STALE_SECONDS,
  };
}

module.exports = {
  app,

  bootstrap,
  createServer,
  startServer,
  // internals the test suite asserts against
  verifyDependencies,
  isDangerousJarvisPrompt,
  enqueueJarvisCommand,
  internals: {
    injectHudLauncher, hudLauncherSnippet, tournamentPayload,
    readJson, readJsonCached, readText, readTail, readTailResult, readJsonl, clampLimit,
    parseJsonLines, parseJsonLinesCounted, getJarvisAudit,
    getFloorTaskCounts, getTaskBoard, getGraphifyCommunities, withHiveFileLock,
    getAgentDetail, getLedger, resolveResource, PARAMETERIZED,
    mergedAgents, sessionRows, rollupFloors, getWorkEvents, getQueueSummary,
    classifyTaskTruth, summarizeTasks, processView, redactRecord,
    // Exported so harnessHealthShape.test.js can compare the success and catch
    // branches without a network round trip. The bug it pins is real: the catch
    // branch used to omit degradedProviders, so the same resource changed shape
    // depending on whether the probe answered inside its 2s timeout.
    getHarnessHealth,
    readPublicSyncStatus, PUBLIC_SYNC_STALE_SECONDS,
    openaliceStatus, frozenFeedsRoute, liveDigestRoute, strategySearchRoute,
    isLocalRequest, isIdentifier, requestError, sendError, buildSnapshot,
    portalTarget, rewriteUpstreamLocation, portalSlugForPort, PORTAL_SERVICES,
    parseLaunchctlList, getFleetLaunchdState,
    changedResources, signatureOf, resourceNames, invalidateCaches, hostIsAllowed, hostOnly,
    HIVE, FLEET_ROOT, SERVICE_PORTS, JSON_CACHE_MS, RESOURCES,
  },
};
