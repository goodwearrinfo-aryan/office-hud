// Floor health for the HUD, sourced from the hive's own probe.
//
// Why a separate module
// ---------------------
// An earlier inline edit of server/index.js adding this was silently lost
// when another process rewrote that file. server/index.js is large and
// concurrently edited, so anything durable lives in its own module and the
// route stays a thin call.
//
// Truth contract
// --------------
// Floor state is derived, never asserted. `rollupFloors` in index.js
// infers liveness from `evidence.sessionFresh`, which the spec explicitly
// rejects as proof ("do not treat a session record as proof that work is
// occurring"). This module instead reports what hive/lib/floor_health.py
// measures: manager process liveness, status-file freshness, worker
// health, and stalled tasks.
//
// When the probe is unavailable, every floor is reported UNKNOWN with a
// reason. It is never optimistically reported healthy, and a floor whose
// state cannot be established is visibly NOT VERIFIED rather than blank.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const HIVE = process.env.OFFICE_HUD_HIVE
  || path.join(require('os').homedir(), 'openalice-fleet', 'hive');

// The producer module can live in two places, and both are legitimate:
//   <hive>/lib/floor_health.py  -- original location, still preferred when
//                                  present so hive-local tooling keeps working
//   <this dir>/floor_health.py  -- the tracked copy
// hive/ is git-ignored (it holds runtime state), so the first location can
// never be delivered by git. That meant the mini simply did not have the
// producer, and all twelve floors reported UNKNOWN with "file is missing" --
// a deployment gap rendered as a fleet-wide health failure. The tracked
// sibling is what makes this module portable across hosts.
function resolveScript(hive) {
  // Explicit seam: pin the producer to one path and disable the search.
  // Operators use it to run against a second hive; the route tests use it to
  // express "no producer anywhere", which an empty hive no longer conveys now
  // that a tracked sibling exists.
  const pinned = process.env.OPENALICE_FLOOR_HEALTH_SCRIPT;
  if (pinned) return fs.existsSync(pinned) ? pinned : null;
  const inHive = path.join(hive, 'lib', 'floor_health.py');
  if (fs.existsSync(inHive)) return inHive;
  const sibling = path.join(__dirname, 'floor_health.py');
  if (fs.existsSync(sibling)) return sibling;
  return null;
}

const FLOOR_IDS = Array.from({ length: 12 }, (_, i) => `F${i + 1}`);

// States that mean "the floor is not doing what it claims". Used to derive a
// single roll-up so the nav can colour a floor without re-deriving policy.
const BAD_STATES = new Set(['FAILED', 'STOPPED', 'DEGRADED', 'BLOCKED', 'UNKNOWN']);

function unknownFloors(reason) {
  return FLOOR_IDS.map((id) => ({
    floor: id.toLowerCase(),
    manager: id,
    state: 'UNKNOWN',
    reason,
    manager_alive: false,
    task_counts: {},
  }));
}

function getFloorHealth(hiveOverride) {
  // Resolve the script per call. Capturing it at require() time meant a
  // later OFFICE_HUD_HIVE override was ignored and the module probed a
  // different hive than the caller asked for -- untestable, and capable of
  // reporting on the wrong system.
  const hive = hiveOverride || process.env.OFFICE_HUD_HIVE || HIVE;
  const script = resolveScript(hive);
  if (!script) {
    return {
      floors: unknownFloors(
        `floor health producer not found: looked for ${path.join(hive, 'lib', 'floor_health.py')}`
        + ` and ${path.join(__dirname, 'floor_health.py')}`
      ),
      source: 'unavailable',
      not_verified: true,
    };
  }
  try {
    // Pass the hive explicitly. The producer falls back to its own parent
    // directory when OPENALICE_HIVE is unset, which is correct for the hive
    // copy but wrong for the tracked sibling beside this file -- it would
    // silently read office-hud/ as if it were the hive and report on nothing.
    const out = execFileSync('/usr/bin/python3', [script, '--json'], {
      encoding: 'utf8',
      timeout: 25000,
      env: { ...process.env, OPENALICE_HIVE: hive },
    });
    const floors = JSON.parse(out);
    if (!Array.isArray(floors) || floors.length === 0) {
      return {
        floors: unknownFloors('floor_health.py returned no floors'),
        source: 'empty',
        not_verified: true,
      };
    }
    // A partial payload is itself a truth problem: a caller would render a
    // missing floor as absent rather than unknown. Pad to the full set.
    const byId = new Map(floors.map((f) => [String(f.floor || '').toLowerCase(), f]));
    const complete = FLOOR_IDS.map((id) => byId.get(id.toLowerCase())
      || {
        floor: id.toLowerCase(),
        manager: id,
        state: 'UNKNOWN',
        reason: 'not reported by the floor health probe',
        manager_alive: false,
        task_counts: {},
      });

    const summary = {};
    for (const f of complete) summary[f.state] = (summary[f.state] || 0) + 1;

    return {
      floors: complete,
      source: script,
      summary,
      at: Date.now(),
    };
  } catch (error) {
    return {
      floors: unknownFloors(`floor health probe failed: ${error.message || error}`),
      source: 'error',
      not_verified: true,
    };
  }
}

// Per-floor view counts the nav needs, taken from the same probe rather than
// recomputed here, so the badge and the state can never disagree.
function floorCounts(hiveOverride) {
  const { floors } = getFloorHealth(hiveOverride);
  const counts = {};
  for (const f of floors) {
    counts[f.floor] = {
      state: f.state,
      manager_alive: !!f.manager_alive,
      reason: f.reason,
      current_task: f.current_task,
      last_activity: f.last_activity,
      tasks: f.task_counts || {},
      workers: f.worker_count || 0,
      failed_workers: f.failed_workers || 0,
      stalled: f.stalled_tasks || 0,
      degraded: BAD_STATES.has(f.state),
    };
  }
  return counts;
}

module.exports = { getFloorHealth, floorCounts, resolveScript, FLOOR_IDS, BAD_STATES };
