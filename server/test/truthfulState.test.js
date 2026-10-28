'use strict';
// The floor-health and project-status guarantees, enforced against the
// modules rather than the routes.
//
// Why module-level and not route-level: a rewrite of server/index.js
// silently removed the /api/floors and /api/health wiring twice, and once
// restored a hardcoded `ok: true` that reported success with the hive
// missing. A route assertion disappears with the route. A test that
// imports the module directly does not, and a broken guarantee fails the
// suite instead of quietly returning a plausible-looking lie.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

const SERVER = path.join(__dirname, '..');

function withHive(overrides, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'truth-'));
  const hive = path.join(dir, 'hive');
  fs.mkdirSync(hive, { recursive: true });
  const payload = { projects: [] };
  Object.assign(payload, overrides);
  fs.writeFileSync(path.join(hive, 'projects.json'), JSON.stringify(payload));
  const prev = process.env.OFFICE_HUD_HIVE;
  process.env.OFFICE_HUD_HIVE = hive;
  try {
    return fn(hive);
  } finally {
    if (prev === undefined) delete process.env.OFFICE_HUD_HIVE;
    else process.env.OFFICE_HUD_HIVE = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Load modules fresh so they pick up the env var set above.
function loadFresh(name) {
  const full = path.join(SERVER, name);
  delete require.cache[require.resolve(full)];
  return require(full);
}

// --- project status -----------------------------------------------------

test('a registry entry whose directory does not exist is MISSING, never ACTIVE', () => {
  const { getProjectStatus } = loadFresh('project_status.js');
  withHive({ projects: [{ id: 'ghost', name: 'ghost', path: '/definitely/not/here' }] }, (hive) => {
    const result = getProjectStatus(hive);
    assert.equal(result.projects.length, 1);
    assert.equal(result.projects[0].status, 'MISSING');
    assert.match(result.projects[0].reason, /does not exist/);
  });
});

test('a registry entry with no path at all is MISSING, never ACTIVE', () => {
  const { getProjectStatus } = loadFresh('project_status.js');
  withHive({ projects: [{ id: 'no-path', name: 'no-path' }] }, (hive) => {
    const result = getProjectStatus(hive);
    assert.equal(result.projects[0].status, 'MISSING');
    assert.equal(result.projects[0].verified, false);
  });
});

  test('an existing directory that is not a git repo is UNKNOWN, not ACTIVE', () => {
    const { getProjectStatus } = loadFresh('project_status.js');
    // A real directory that is genuinely not inside any repository.
    //
    // This used to point at SERVER (office-hud/server), on the reasoning that
    // "server/ is not itself a repo root". That premise was false: the whole tree
    // lives inside /Users/a/trading/openalice-fleet, so git answers
    // `rev-parse --is-inside-work-tree` with true for it. The test only passed
    // because the probe looked for a .git DIRECTORY, which office-hud/server
    // does not have. When the probe was corrected to ask git -- so linked
    // worktrees, whose .git is a pointer file, stop being misreported as
    // UNKNOWN -- this test began failing, and the test was what was wrong.
    //
    // mkdtemp under /tmp sits outside the repository, which is what the test
    // actually needs. The assertion is unchanged: a directory that is not a
    // repository must not claim ACTIVE.
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'not-a-repo-'));
    try {
      withHive({ projects: [{ id: 'plain', name: 'plain', path: outside }] }, (hive) => {
        const result = getProjectStatus(hive);
        const plain = result.projects[0];
        assert.equal(plain.verified, true, 'the directory does exist, so it is verified');
        assert.notEqual(plain.status, 'ACTIVE');
        assert.ok(['MISSING', 'UNKNOWN'].includes(plain.status), `got ${plain.status}`);
      });
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

test('an unreadable registry never yields an ACTIVE project', () => {
  const { getProjectStatus } = loadFresh('project_status.js');
  // Two distinct failure shapes, both must be non-OPTIMISTIC:
  //   corrupt projects.json -> the probe reports an error and zero projects
  //   a hive with no probe   -> the JS fallback returns UNKNOWN entries
  withHive({}, (hive) => {
    fs.writeFileSync(path.join(hive, 'projects.json'), '{ not json');
    const corrupt = getProjectStatus(hive);
    for (const p of corrupt.projects) {
      assert.notEqual(p.status, 'ACTIVE', `${p.project_id} claimed ACTIVE without evidence`);
    }
    assert.equal(corrupt.projects.length, 0, 'a corrupt registry must yield no projects');
    assert.ok(corrupt.error, 'a corrupt registry must surface an error, not silence');
    assert.equal(corrupt.not_verified, true,
      'an errored probe must be flagged not_verified, not read as "no projects"');
  });

  // A hive whose probe binary is absent: the fallback path.
  withHive({ projects: [{ id: 'x', name: 'x', path: '/nowhere' }] }, (hive) => {
    const result = getProjectStatus(path.join(hive, 'no-such-hive'));
    assert.equal(result.not_verified, true);
    for (const p of result.projects) {
      assert.equal(p.status, 'UNKNOWN', `${p.project_id} claimed ${p.status} without a probe`);
    }
  });
});

test('a missing floor probe yields all floors UNKNOWN, never a healthy default', () => {
  const { getFloorHealth } = loadFresh('floor_health.js');
  withHive({}, (hive) => {
    // An empty hive no longer means "no producer": floor_health.js falls back
    // to the tracked producer beside it. Pin the search to a path that does
    // not exist so this exercises the missing-probe path it is named for.
    process.env.OPENALICE_FLOOR_HEALTH_SCRIPT = path.join(hive, 'absent-producer.py');
    let result;
    try {
      result = getFloorHealth(hive);
    } finally {
      delete process.env.OPENALICE_FLOOR_HEALTH_SCRIPT;
    }
    assert.equal(result.not_verified, true);
    assert.equal(result.floors.length, 12);
    for (const f of result.floors) {
      assert.equal(f.state, 'UNKNOWN', `${f.floor} defaulted to ${f.state}`);
      assert.equal(f.manager_alive, false);
      assert.ok(f.reason, 'an UNKNOWN floor must say why');
    }
  });
});

test('floor health always reports all twelve floors', () => {
  const { FLOOR_IDS } = loadFresh('floor_health.js');
  assert.equal(FLOOR_IDS.length, 12);
  for (const id of FLOOR_IDS) assert.match(id, /^F\d+$/);
});

test('BAD_STATES covers every state that must not read as healthy', () => {
  const { BAD_STATES } = loadFresh('floor_health.js');
  for (const s of ['FAILED', 'STOPPED', 'DEGRADED', 'BLOCKED', 'UNKNOWN']) {
    assert.ok(BAD_STATES.has(s), `${s} missing from BAD_STATES`);
  }
  // IDLE is a real, healthy-but-not-working state and must not be flagged.
  assert.equal(BAD_STATES.has('IDLE'), false);
});
