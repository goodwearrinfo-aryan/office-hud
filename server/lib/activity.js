'use strict';

// /api/activity: the human-first view of the same hive data /api/terminals
// already serves. Pure function + one route-mount helper. Lives in its own
// module so a whole-file rewrite of index.js cannot silently drop the route,
// which is exactly how /api/alphainsider/poller was once lost.

function activitySnapshot(terminalSnapshotResult) {
  const t = terminalSnapshotResult && typeof terminalSnapshotResult === 'object'
    ? terminalSnapshotResult
    : { hosts: [], terminals: [], stale_hosts: [] };
  const terminals = Array.isArray(t.terminals) ? t.terminals : [];
  const projects = new Map();
  for (const row of terminals) {
    const cwd = typeof row.cwd === 'string' && row.cwd ? row.cwd : '(unknown)';
    let p = projects.get(cwd);
    if (!p) {
      const segs = cwd.split('/').filter(Boolean);
      p = {
        cwd,
        label: segs.length >= 2 ? `${segs[segs.length - 2]}/${segs[segs.length - 1]}` : cwd,
        shells: 0,
        process_shells: 0,
        hosts: new Set(),
        host_stale: false,
        oldest_age_sec: 0,
      };
      projects.set(cwd, p);
    }
    p.shells += 1;
    const cmd = String(row.command || '');
    if (row.kind === 'process' || (cmd && !/^-?(zsh|bash|fish)$/.test(cmd))) p.process_shells += 1;
    if (row.host) p.hosts.add(String(row.host));
    if (row.host_stale === true || row.host_stale === 'True') p.host_stale = true;
    const a = Number(row.age_sec);
    if (Number.isFinite(a) && a > p.oldest_age_sec) p.oldest_age_sec = a;
  }
  const projectList = [...projects.values()]
    .map((p) => ({
      cwd: p.cwd,
      label: p.label,
      shells: p.shells,
      hosts: [...p.hosts],
      host_stale: p.host_stale,
      last_seen_age_sec: p.oldest_age_sec,
      running_a_command: p.process_shells > 0,
      running_command_count: p.process_shells,
    }))
    .sort((a, b) => b.shells - a.shells);
  const stale = Array.isArray(t.stale_hosts) ? t.stale_hosts : [];
  return {
    projects: projectList,
    totals: {
      shells: terminals.length,
      projects: projectList.length,
      hosts: Array.isArray(t.hosts) ? t.hosts.length : 0,
      stale_hosts: stale.length,
    },
    stale_hosts: stale,
  };
}

function mountActivityRoute(app, opts = {}) {
  const snapshotFn = opts.snapshotFn;
  if (!app || typeof app.get !== 'function' || typeof snapshotFn !== 'function') {
    throw new TypeError('mountActivityRoute requires app.get and opts.snapshotFn');
  }
  const handler = (_req, res) => {
    try {
      res.set('Cache-Control', 'no-store');
      res.json(activitySnapshot(snapshotFn()));
    } catch (e) {
      res.status(503).json({ error: 'activity_unavailable', detail: String(e) });
    }
  };
  app.get('/api/activity', handler);
  return handler;
}

module.exports = { activitySnapshot, mountActivityRoute };
