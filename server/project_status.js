// Truthful project status for the HUD.
//
// The defect
// ----------
// /api/projects returned projects.json verbatim and the web layer rendered
// every entry as `status: 'ACTIVE'`. All 14 projects claimed ACTIVE while
// 7 of their directories did not exist on disk -- ui-build, ws-build,
// sma-build, sma-verify, oh-live, openalice-fleet-converge, and
// polymarket-profitability-research, which has no path at all. Only
// openalice-sma exists but is not a git repository.
//
// "ACTIVE" asserts a project is real and being worked on. Nothing checked
// either. This wraps server/project_probe.py, which measures it from the
// filesystem and git instead.
//
// Truth contract
// --------------
//   MISSING  registry entry whose directory does not exist
//   UNKNOWN  directory exists but is not a git repo, so no real activity
//            can be established
//   IDLE     clean git tree, no recent commit
//   ACTIVE   real git repo with recent commits or uncommitted changes
//
// A registered project is not a running project. A project whose probe
// cannot run is reported with an error, never optimistically as ACTIVE.

const path = require('path');
const { execFileSync } = require('child_process');

const HIVE = process.env.OFFICE_HUD_HIVE
  || path.join(require('os').homedir(), 'openalice-fleet', 'hive');
const PROJECT_PROBE = path.join(__dirname, 'project_probe.py');

function getProjectStatus(hiveOverride) {
  // Read the hive at call time, not module load. server/project_probe.py
  // resolves OPENALICE_HIVE when IT is imported, so a value captured here
  // at require() time would silently win over a later override -- and the
  // module would probe a different hive than the caller asked for. That
  // made this untestable and, worse, could report on the wrong system.
  const hive = hiveOverride || process.env.OFFICE_HUD_HIVE || HIVE;
  try {
    const out = execFileSync('/usr/bin/python3', [PROJECT_PROBE], {
      encoding: 'utf8',
      timeout: 60000,
      env: { ...process.env, OPENALICE_HIVE: hive },
    });
    const parsed = JSON.parse(out);
    if (!parsed || !Array.isArray(parsed.projects)) {
      return {
        projects: [], source: PROJECT_PROBE,
        error: 'probe returned no project list', not_verified: true,
      };
    }
    // The probe reports its own failure as {projects: [], error} rather than
    // exiting non-zero, so the JS fallback below is not reached. An empty
    // project list with an error means nothing was verified, and callers
    // must be able to see that. Flag it here rather than returning a bare
    // empty list that reads as "no projects registered".
    if (parsed.projects.length === 0 && parsed.error) {
      return { ...parsed, not_verified: true };
    }
    return parsed;
  } catch (error) {
    // The registry is still worth showing even when the probe fails, but it
    // must be labelled UNKNOWN rather than ACTIVE.
    let registry = [];
    try {
      const fs = require('fs');
      const raw = JSON.parse(fs.readFileSync(path.join(hive, 'projects.json'), 'utf8'));
      const items = Array.isArray(raw) ? raw : (raw.projects || []);
      registry = items
        .filter((i) => i && typeof i === 'object')
        .map((i) => ({
          project_id: i.id || i.name || '(unnamed)',
          name: i.name || i.id || '(unnamed)',
          path: i.path || i.root || null,
          status: 'UNKNOWN',
          reason: 'project probe unavailable; presence not verified',
          verified: false,
        }));
    } catch { /* registry unreadable too */ }
    return {
      projects: registry,
      source: PROJECT_PROBE,
      error: `project probe failed: ${error.message || error}`,
      not_verified: true,
    };
  }
}

module.exports = { getProjectStatus };
