/**
 * GET /api/openalice/status
 *
 * One authoritative "is OpenAlice actually alive, and how fresh is this" object.
 *
 * Why this is a projection and not a new source of truth
 * -----------------------------------------------------
 * The HUD already had every primitive this question needs, and duplicating any
 * of them would be a regression:
 *
 *   * processTruth.processView()          -> live/stale + observation age
 *   * processTruth.observationAgeSeconds()
 *   * /api/health  (hive presence)        -> is the hive reachable
 *   * hive/registry.json                   -> how many agents are REGISTERED
 *
 * So this module reads those and composes a single verdict. It never
 * re-discovers processes, never re-implements an age calculation, and never
 * invents a value: where a source cannot speak, the field is null.
 *
 * Three rules this exists to enforce
 * ----------------------------------
 * 1. A JSON file existing is NOT evidence of life. Only a fresh process
 *    observation supports LIVE.
 * 2. A missing OPTIONAL source (registry) never downgrades the verdict to
 *    OFFLINE, and never fabricates an identity.
 * 3. Stale must be obvious. `freshness` always carries the numbers the verdict
 *    was derived from, so a reader can audit the decision rather than trust it.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { processView, observationAgeSeconds, redactRecord, REDACTED } =
  require('./processTruth');

const ROOT = process.env.OPENALICE_ROOT ||
  path.resolve(__dirname, '..', '..');
const HIVE = process.env.OPENALICE_HIVE || path.join(ROOT, 'hive');

const REGISTRY_PATH = path.join(HIVE, 'registry.json');
const PROCESSES_PATH = path.join(HIVE, 'processes.json');

/**
 * Credential-shaped field names, refused on the way out.
 *
 * Deliberately NOT a bare substring match. A first version used
 * /(password|secret|token|key|...)/i and so redacted innocent metrics --
 * token_count became '***', which is a false claim about the payload, and just
 * as bad as leaking one. These forms anchor on the whole name:
 *
 *   * a standalone word: password, secret, token, credentials
 *   * the conventional suffix: *_API_KEY, *_APIKEY, *_TOKEN, *_SECRET
 *   * file-ish: sealing.key, id_rsa, *.pem
 *
 * A name like token_count or api_keys_present is a measurement, not a secret.
 */
const SECRET_NAME = [
  /^(?:password|passwd|secret|token|bearer|credential|credentials|apikey|auth|authorization)$/i,
  /_?(?:api[_-]?key|apikey|access[_-]?key|secret[_-]?key|private[_-]?key|auth[_-]?token|bearer[_-]?token|session[_-]?token)$/i,
  /(?:password|secret|token|credential)$/i,
  /(?:^|[._-])(?:key|sealing|passwd|pw)$/i,
];

/** True when a field NAME looks like it carries a credential. */
function isSecretName(name) {
  if (!name) return false;
  const n = String(name);
  if (/^(?:password|passwd|secret|token|bearer|credential|credentials|apikey|auth|authorization)$/i.test(n)) return true;
  if (/_?(?:api[_-]?key|apikey|access[_-]?key|secret[_-]?key|private[_-]?key|auth[_-]?token|bearer[_-]?token|session[_-]?token)$/i.test(n)) return true;
  // A trailing qualifier means a measurement about secrets, not a secret.
  if (/(?:count|total|present|missing|found|redacted|masked|status)$/i.test(n)) return false;
  if (/(?:password|passwd|secret|token|credential)$/i.test(n)) return true;
  if (/(?:^|[._-])(?:key|sealing|pw)$/i.test(n)) return true;
  if (/\.(?:pem|key)$/i.test(n)) return true;
  return false;
}

/**
 * Read and parse JSON, tolerating every way a live state file can be wrong.
 * Returns { value, error } so a caller can distinguish "absent" from "broken".
 */
function readJson(file) {
  try {
    if (!fs.existsSync(file)) return { value: null, error: null };
    const raw = fs.readFileSync(file, 'utf8');
    if (!raw.trim()) return { value: null, error: 'empty file' };
    return { value: JSON.parse(raw), error: null };
  } catch (err) {
    // A half-written file is normal while a writer is mid-update. That is
    // UNVERIFIABLE, never OFFLINE and never a crash.
    return { value: null, error: String(err && err.message || err) };
  }
}

/**
 * Strip anything credential-shaped from an object graph, in place-safe fashion.
 * Defence in depth: processTruth already redacts commands, but this payload is
 * assembled from files, and a future field must not be able to leak a secret by
 * being added to one of them.
 */
function scrub(value, depth = 0) {
  if (depth > 6 || value === null || value === undefined) return value ?? null;
  if (Array.isArray(value)) return value.map((v) => scrub(v, depth + 1));
  if (typeof value !== 'object') return value;
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (isSecretName(k)) { out[k] = REDACTED; continue; }
    out[k] = scrub(v, depth + 1);
  }
  return out;
}

/**
 * Identity from hive/registry.json ONLY.
 *
 * Returns null when the registry cannot truthfully provide one. There is no
 * "AliceProject" concept on this machine and none is invented; the fields below
 * are the ones the file actually contains.
 */
function readIdentity(now, registryPath = REGISTRY_PATH) {
  const { value, error } = readJson(registryPath);
  if (!value || typeof value !== 'object') {
    return { identity: null, source: REGISTRY_PATH, error };
  }
  // `agents` is a dict keyed by agent id, not a list. An earlier version read
  // only Array.isArray(), so it silently reported registered_agents: null while
  // the file held 58 -- an evidence gap dressed as an absence.
  const raw = value.agents;
  const agents = Array.isArray(raw) ? raw
    : (raw && typeof raw === 'object' ? Object.values(raw) : []);
  const floors = new Set();
  for (const a of agents) {
    const f = a && (a.floor || a.floor_id);
    // Only numbered floors are floors; worker-*/specialist-* role groupings are
    // not floor identities and counting them overstated the floor total.
    if (f && /^f\d+$/i.test(String(f))) floors.add(String(f));
  }
  let mtime = null;
  try { mtime = fs.statSync(registryPath).mtime.toISOString(); } catch (_) {}
  const age = observationAgeSeconds(mtime, now);
  return {
    identity: {
      hive: HIVE,
      registered_agents: agents.length || null,
      floors: floors.size || null,
      registry_mtime: mtime,
      registry_age_seconds: age,
      registry_stale: age === null ? null : age > 300,
    },
    source: REGISTRY_PATH,
    error,
  };
}

const AGENT_PROC = /agents\/[^/]+\/bin\/(agent_manager|office_manager)\.js/;

/** Agent processes actually observed alive, from the canonical process truth. */
function countAgentRecords(processes) {
  if (!Array.isArray(processes)) return null;
  let n = 0;
  for (const p of processes) {
    const cmd = String((p && (p.command || p.cmdline)) || '');
    if (AGENT_PROC.test(cmd)) n += 1;
  }
  return n;
}

const countLiveAgents = countAgentRecords;

/**
 * The verdict. Kept pure and exported so the state machine can be tested
 * directly, without touching the filesystem.
 *
 * Precedence, highest first: OFFLINE, STALE, DEGRADED, LIVE.
 */
function classify({ processStale, ageSeconds, staleAfterSeconds,
                    hivePresent, agentsAlive, agentsExpected, healthOk,
                    registryError, registryStale, processRecords }) {
  const issues = [];

  if (hivePresent === false) {
    return { status: 'OFFLINE', reason: 'hive not present at the configured OPENALICE_HIVE', issues };
  }
  // Liveness is asserted from OBSERVED evidence only, never from a pass-through
  // flag. processView().live is `!!(entry && entry.live)` -- it forwards a field
  // the writer sets, and hive/processes.json has no `live` key, so it is always
  // false there. Treating that as "not alive" reported OFFLINE while 54 agents
  // were running and the observation was 16s old. A false OFFLINE on a healthy
  // fleet is worse than no verdict at all.
  const observedAgents = Array.isArray(processRecords) ? countAgentRecords(processRecords) : null;
  const nothingRunning = (agentsAlive === 0) || (agentsAlive === null && observedAgents === 0);
  if (hivePresent === true && nothingRunning && processStale !== true) {
    return { status: 'OFFLINE', reason: 'no agent processes observed in a fresh observation', issues };
  }
  if (hivePresent === null && nothingRunning && processStale !== true) {
    return { status: 'OFFLINE', reason: 'no agent processes observed and hive state unknown', issues };
  }
  if (processStale === true) {
    return {
      status: 'STALE',
      reason: `process observation is ${ageSeconds}s old, past the ${staleAfterSeconds}s threshold`,
      issues,
    };
  }
  // An unmeasurable age is NOT a fresh observation. Reporting LIVE here is the
  // same error as reading a frozen file, and processTruth says so explicitly.
  // Caught by the test "an unmeasurable age is never presented as fresh".
  if (ageSeconds === null) {
    return {
      status: 'STALE',
      reason: 'process observation has no measurable timestamp, so freshness cannot be established',
      issues,
    };
  }
  if (ageSeconds > staleAfterSeconds) {
    return {
      status: 'STALE',
      reason: `process observation is ${ageSeconds}s old, past the ${staleAfterSeconds}s threshold`,
      issues,
    };
  }
  if (healthOk === false) issues.push('hive health endpoint not ok');
  if (agentsAlive !== null && agentsExpected !== null && agentsAlive < agentsExpected) {
    issues.push(`agents alive ${agentsAlive} < registered ${agentsExpected}`);
  }
  // Roster age is reported, not gating. registry.json is written when the
  // agent set changes, not on a timer, so a stable fleet accrues unbounded
  // age while staying entirely correct. The 300s threshold that suits
  // processes.json -- a live observation -- permanently mislabels a roster,
  // which made a healthy 57/58 fleet report DEGRADED on a 141h-old but
  // accurate file. The flag still ships in identity.registry_stale so the
  // age is visible to any reader; it just does not decide a verdict that is
  // derived from liveness. Matches the per-agent path and the intent in
  // rosterFreshness.test.js: precision, not blanket invalidation.
  if (registryError) issues.push(`registry unreadable: ${registryError}`);

  if (issues.length) {
    return { status: 'DEGRADED', reason: issues.join('; '), issues };
  }
  return { status: 'LIVE', reason: 'fresh runtime and process evidence, no contradictions', issues };
}

function buildStatus(options = {}) {
  const now = options.now ?? Date.now();
  const staleAfterSeconds = options.staleAfterSeconds ?? 300;

  const proc = options.processes !== undefined
    ? { value: options.processes, error: null }
    : readJson(PROCESSES_PATH);

  // Reuse the canonical view rather than re-deriving liveness.
  const view = processView(proc.value || {}, { now, staleAfterSeconds });
  const ageSeconds = view.observation_age_seconds ?? null;

  const health = options.health !== undefined ? options.health : null;
  const hivePresent = health === null
    ? (proc.error ? null : Boolean(proc.value))
    : Boolean(health && health.present);

  const agentsAlive = options.agentsAlive !== undefined
    ? options.agentsAlive
    : countLiveAgents(view.processes);
  const reg = readIdentity(now, options.registryPath || REGISTRY_PATH);
  const agentsExpected = reg.identity ? reg.identity.registered_agents : null;

  const verdict = classify({
    processRecords: view.processes,
    processStale: view.stale,
    ageSeconds,
    staleAfterSeconds,
    hivePresent,
    agentsAlive,
    agentsExpected,
    healthOk: health === null ? null : Boolean(health.ok),
    registryError: reg.error,
    registryStale: reg.identity ? reg.identity.registry_stale : null,
  });

  return {
    status: verdict.status,
    reason: verdict.reason,
    issues: verdict.issues,
    identity: reg.identity,
    runtime: {
      hive_present: hivePresent,
      agents_alive: agentsAlive,
      agents_expected: agentsExpected,
      process_count: Array.isArray(view.processes) ? view.processes.length : null,
    },
    freshness: {
      observed_at: (proc.value && proc.value.collected_at) || null,
      age_ms: ageSeconds === null ? null : ageSeconds * 1000,
      stale: view.stale,
      stale_after_seconds: staleAfterSeconds,
    },
    sources: {
      processes: proc.error ? `unreadable: ${proc.error}` : PROCESSES_PATH,
      registry: reg.error ? `unreadable: ${reg.error}` : (options.registryPath || REGISTRY_PATH),
    },
  };
}

function register(app) {
  if (!app || typeof app.get !== 'function') return false;
  app.get('/api/openalice/status', (req, res) => {
    try {
      // Scrub the whole payload: a future field must not be able to leak.
      res.json(scrub(buildStatus()));
    } catch (err) {
      // Never fabricate a healthy answer on failure.
      res.status(503).json({ status: 'UNKNOWN', reason: String(err && err.message || err) });
    }
  });
  return true;
}

module.exports = {
  REDACTED,
  buildStatus,
  classify,
  countAgentRecords,
  countLiveAgents,
  isSecretName,
  readIdentity,
  readJson,
  register,
  scrub,
  REGISTRY_PATH,
  PROCESSES_PATH,
  SECRET_NAME,
};
