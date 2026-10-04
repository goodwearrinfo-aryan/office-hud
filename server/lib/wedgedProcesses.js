// Reader for the wedged-process feed written by collect-wedged-processes.py.
//
// The payload must be safe to serve when the feed is missing, mid-write or
// malformed: the office-hud reads several machines' hive directories and a
// collector that has not run yet is normal, not an error. Same defensive
// posture as the other hive readers in index.js.
//
// Command lines go through redactRecord before serving, the same rule the
// processes and terminals readers follow. The feed on disk stays raw - that is
// the house pattern, redaction happens at serve time - but a wedged process's
// command line is exactly the kind of thing that can carry a credential
// (a token in an argv, an Authorization header), and serving it unredacted
// would leak it to anyone who can reach the API. The finding's tree members
// carry commands too, so they are redacted at both levels.
const { redactRecord } = require('../processTruth');
const fs = require('fs');
const path = require('path');

function redactWedged(finding) {
  const out = redactRecord(finding);
  if (Array.isArray(out.tree)) out.tree = out.tree.map(redactRecord);
  return out;
}

function buildWedgedPayload(hiveDir) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(path.join(hiveDir, 'wedged.json'), 'utf8'));
  } catch {
    return {
      source: path.join(hiveDir, 'wedged.json'),
      collected_at: null,
      live: false,
      wedged: [],
      totals: null,
    };
  }
  return {
    source: path.join(hiveDir, 'wedged.json'),
    collected_at: raw.collected_at || null,
    live: !!(raw.collected_at && raw.host),
    wedged: Array.isArray(raw.wedged) ? raw.wedged.map(redactWedged) : [],
    totals: raw.totals || null,
  };
}

function registerWedgedRoutes(app, hiveDir) {
  app.get('/api/wedged', (_req, res) => {
    res.json(buildWedgedPayload(hiveDir));
  });
}

module.exports = { buildWedgedPayload, registerWedgedRoutes, redactWedged };
