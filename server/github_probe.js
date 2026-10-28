'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const DEFAULT_INTERVAL_MS = 180_000;
const BACKOFF_MS = [300_000, 600_000];
const CALL_TIMEOUT_MS = 10_000;
const GIT_TIMEOUT_MS = 8_000;
const MAX_OUTPUT = 2 * 1024 * 1024;
const PATH_ENV = '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin';
const REPO_ID = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

const DEFAULT_REPOS_FILE = path.join(__dirname, '..', 'github_repos.json');

/**
 * Cached GitHub snapshot for the HUD.
 *
 * Every call is async: /api/health once blocked the event loop with a
 * synchronous probe and that shape must not come back. http handlers only read
 * the in-memory snapshot; gh and git are spawned by the timer, one cycle at a
 * time. A failing surface degrades that surface, never the whole repo.
 */
function createGithubProbe({
  reposFile = process.env.OFFICE_HUD_GITHUB_REPOS || DEFAULT_REPOS_FILE,
  ghBin = process.env.OFFICE_HUD_GH_BIN || '/opt/homebrew/bin/gh',
  intervalMs = Number(process.env.OFFICE_HUD_GITHUB_INTERVAL_MS) || DEFAULT_INTERVAL_MS,
  maxLoad = Number(process.env.OFFICE_HUD_GITHUB_MAX_LOAD) || 0,
  exec = execFile,
  now = Date.now,
  loadavg = () => os.loadavg(),
  log = () => {},
} = {}) {
  let timer = null;
  let inflight = null;
  let stopped = true;

  const snapshot = {
    disabled: false,
    configured: false,
    generatedAt: null,
    poll: {
      lastSuccessAt: null,
      lastErrorAt: null,
      lastError: null,
      failures: 0,
      nextPollAt: null,
      deferred: false,
    },
    auth: { ok: null, account: null, checkedAt: null },
    repos: [],
    warnings: [],
  };

  function run(file, args, timeoutMs) {
    return new Promise((resolve, reject) => {
      exec(file, args, {
        timeout: timeoutMs,
        maxBuffer: MAX_OUTPUT,
        env: { ...process.env, PATH: PATH_ENV },
      }, (error, stdout, stderr) => {
        if (error) {
          const detail = String(stderr || '').trim() || error.message;
          reject(new Error(detail.split('\n')[0].slice(0, 220)));
          return;
        }
        resolve(String(stdout || '').trim());
      });
    });
  }

  const gh = (args) => run(ghBin, args, CALL_TIMEOUT_MS);
  const ghJson = (args) => gh(args).then((out) => (out ? JSON.parse(out) : null));

  function loadConfig() {
    try {
      const raw = JSON.parse(fs.readFileSync(reposFile, 'utf8'));
      const list = Array.isArray(raw) ? raw : (Array.isArray(raw.repos) ? raw.repos : []);
      const repos = list
        .filter((entry) => entry && typeof entry === 'object' && REPO_ID.test(String(entry.id || '')))
        .map((entry) => ({
          id: String(entry.id),
          localPath: typeof entry.localPath === 'string' && entry.localPath.startsWith('/') ? entry.localPath : null,
          gh: entry.gh !== false,
        }));
      if (repos.length === 0) return { repos: [], error: 'no valid repos in config' };
      return { repos, error: null };
    } catch (error) {
      return { repos: [], error: `config unreadable: ${error.message}` };
    }
  }

  function checksState(rollup) {
    if (!Array.isArray(rollup) || rollup.length === 0) return 'none';
    let pending = false;
    let failing = false;
    for (const check of rollup) {
      const conclusion = String(check && check.conclusion || '').toUpperCase();
      const state = String(check && check.state || '').toUpperCase();
      const status = String(check && check.status || '').toUpperCase();
      if (['FAILURE', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE'].includes(conclusion)) failing = true;
      else if (['FAILURE', 'ERROR'].includes(state)) failing = true;
      else if (status === 'IN_PROGRESS' || status === 'QUEUED' || status === 'PENDING' || state === 'PENDING' || state === 'EXPECTED') pending = true;
    }
    return failing ? 'failing' : pending ? 'pending' : 'passing';
  }

  async function probeGit(localPath) {
    const out = await run('git', ['-C', localPath, 'status', '--porcelain=v2', '--branch'], GIT_TIMEOUT_MS);
    let branch = null;
    let head = null;
    let ahead = null;
    let behind = null;
    let dirty = 0;
    for (const line of out.split('\n')) {
      if (!line) continue;
      if (line.startsWith('# branch.head ')) {
        const value = line.slice('# branch.head '.length).trim();
        branch = value.startsWith('(') ? null : value;
      } else if (line.startsWith('# branch.oid ')) {
        const value = line.slice('# branch.oid '.length).trim();
        head = value.startsWith('(') ? null : value.slice(0, 7);
      } else if (line.startsWith('# branch.ab ')) {
        const match = /\+(\d+)\s+-(\d+)/.exec(line);
        if (match) {
          ahead = Number(match[1]);
          behind = Number(match[2]);
        }
      } else if (!line.startsWith('#')) {
        dirty += 1;
      }
    }
    let lastCommitAgeSec = null;
    try {
      const ts = Number(await run('git', ['-C', localPath, 'log', '-1', '--format=%ct'], GIT_TIMEOUT_MS));
      if (Number.isFinite(ts) && ts > 0) lastCommitAgeSec = Math.max(0, Math.round(now() / 1000 - ts));
    } catch { /* no commits yet: age stays unknown */ }
    return { branch, head, dirty, ahead, behind, lastCommitAgeSec };
  }

  async function probeRepo(repo) {
    const record = {
      id: repo.id,
      localPath: repo.localPath,
      gh: repo.gh !== false,
      git: null,
      prs: [],
      issues: [],
      runs: [],
      errors: [],
      error: null,
      counts: { prs: 0, issues: 0, runs: 0, failing: 0 },
    };
    if (repo.localPath) {
      try {
        record.git = await probeGit(repo.localPath);
      } catch (error) {
        record.errors.push(`git: ${error.message}`);
      }
    }
    if (record.gh) {
      const calls = [
        ['prs', ['pr', 'list', '--repo', repo.id, '--state', 'open', '--limit', '20',
          '--json', 'number,title,isDraft,reviewDecision,statusCheckRollup,author,url']],
        ['issues', ['issue', 'list', '--repo', repo.id, '--state', 'open', '--limit', '20',
          '--json', 'number,title,labels,assignees,url']],
        ['runs', ['run', 'list', '--repo', repo.id, '--limit', '5',
          '--json', 'workflowName,status,conclusion,headBranch,url']],
      ];
      const settled = await Promise.allSettled(calls.map(([, args]) => ghJson(args)));
      settled.forEach((result, index) => {
        const [surface] = calls[index];
        if (result.status === 'rejected') {
          record.errors.push(`${surface}: ${(result.reason && result.reason.message) || 'failed'}`);
          return;
        }
        const list = Array.isArray(result.value) ? result.value : [];
        if (surface === 'prs') {
          record.prs = list.map((pr) => ({
            number: pr.number,
            title: String(pr.title || '').slice(0, 200),
            author: pr.author && pr.author.login || null,
            draft: Boolean(pr.isDraft),
            review: pr.reviewDecision || null,
            checks: checksState(pr.statusCheckRollup),
            url: pr.url || null,
          }));
        } else if (surface === 'issues') {
          record.issues = list.map((issue) => ({
            number: issue.number,
            title: String(issue.title || '').slice(0, 200),
            labels: (issue.labels || []).map((label) => label.name).slice(0, 6),
            assignees: (issue.assignees || []).map((user) => user.login).slice(0, 4),
            url: issue.url || null,
          }));
        } else {
          record.runs = list.map((item) => ({
            workflow: item.workflowName || null,
            status: item.status || null,
            conclusion: item.conclusion || null,
            branch: item.headBranch || null,
            url: item.url || null,
          }));
        }
      });
      record.counts = {
        prs: record.prs.length,
        issues: record.issues.length,
        runs: record.runs.length,
        failing: record.runs.filter((item) => item.conclusion === 'failure' || item.conclusion === 'timed_out').length,
      };
    }
    record.error = record.errors.length ? record.errors.join(' · ').slice(0, 300) : null;
    return record;
  }

  async function cycle() {
    const startedAt = now();
    if (maxLoad > 0 && loadavg()[0] > maxLoad) {
      snapshot.poll.deferred = true;
      snapshot.poll.nextPollAt = startedAt + intervalMs;
      return snapshot;
    }
    snapshot.poll.deferred = false;

    const config = loadConfig();
    snapshot.configured = config.repos.length > 0;
    if (!snapshot.configured) {
      snapshot.warnings = [{ kind: 'unconfigured', text: config.error || 'no repos configured' }];
      snapshot.poll.nextPollAt = startedAt + intervalMs;
      return snapshot;
    }

    if (!config.repos.some((repo) => repo.gh !== false)) {
      snapshot.auth = { ok: null, account: null, checkedAt: startedAt };
      const localOnly = [];
      for (const repo of config.repos) localOnly.push(await probeRepo(repo));
      snapshot.repos = localOnly;
      snapshot.warnings = [];
      snapshot.generatedAt = now();
      snapshot.poll.lastSuccessAt = snapshot.generatedAt;
      snapshot.poll.lastError = null;
      snapshot.poll.failures = 0;
      snapshot.poll.nextPollAt = snapshot.generatedAt + intervalMs;
      return snapshot;
    }

    snapshot.auth.checkedAt = startedAt;
    try {
      const me = await ghJson(['api', 'user']);
      snapshot.auth.ok = true;
      snapshot.auth.account = (me && me.login) || null;
    } catch (error) {
      snapshot.auth.ok = false;
      snapshot.auth.account = null;
      snapshot.poll.failures += 1;
      snapshot.poll.lastErrorAt = startedAt;
      snapshot.poll.lastError = `gh: ${error.message}`;
      snapshot.warnings = [{ kind: 'gh-unavailable', text: error.message }];
      const backoff = BACKOFF_MS[Math.min(snapshot.poll.failures - 1, BACKOFF_MS.length - 1)];
      snapshot.poll.nextPollAt = startedAt + backoff;
      log(`[github] auth probe failed: ${error.message}`);
      return snapshot;
    }

    const results = [];
    for (const repo of config.repos) results.push(await probeRepo(repo));
    snapshot.repos = results;
    const failed = results.filter((repo) => repo.error);
    snapshot.warnings = failed.length
      ? [{ kind: 'repo-errors', text: `${failed.length} repo(s) with errors: ${failed.map((repo) => repo.id).join(', ')}` }]
      : [];
    snapshot.generatedAt = now();
    snapshot.poll.lastSuccessAt = snapshot.generatedAt;
    snapshot.poll.lastError = null;
    snapshot.poll.failures = 0;
    snapshot.poll.nextPollAt = snapshot.generatedAt + intervalMs;
    log(`[github] polled ${results.length} repos`);
    return snapshot;
  }

  function pollNow() {
    if (!inflight) {
      inflight = cycle()
        .then(() => api.snapshot())
        .catch((error) => {
          snapshot.poll.lastErrorAt = now();
          snapshot.poll.lastError = error.message;
          return api.snapshot();
        })
        .finally(() => {
          inflight = null;
          schedule();
        });
    }
    return inflight;
  }

  function schedule() {
    if (stopped) return;
    if (timer) clearTimeout(timer);
    const delay = Math.max(5_000, (snapshot.poll.nextPollAt || now() + intervalMs) - now());
    timer = setTimeout(() => {
      timer = null;
      pollNow();
    }, delay);
    if (timer.unref) timer.unref();
  }

  const api = {
    register(app) {
      app.get('/api/github', (_req, res) => res.json(api.snapshot()));
    },
    start() {
      if (!stopped) return;
      stopped = false;
      pollNow();
    },
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
    },
    pollNow,
    snapshot() {
      const ageSec = snapshot.generatedAt == null ? null : Math.max(0, Math.round((now() - snapshot.generatedAt) / 1000));
      return {
        ...snapshot,
        ageSec,
        totals: {
          repos: snapshot.repos.length,
          prs: snapshot.repos.reduce((sum, repo) => sum + (repo.counts && repo.counts.prs || 0), 0),
          issues: snapshot.repos.reduce((sum, repo) => sum + (repo.counts && repo.counts.issues || 0), 0),
          failing: snapshot.repos.reduce((sum, repo) => sum + (repo.counts && repo.counts.failing || 0), 0),
        },
      };
    },
  };

  return api;
}

module.exports = { createGithubProbe };
