'use strict';
// The GitHub probe's contract, enforced against the module.
//
// The properties that must not regress: a snapshot read never spawns a process,
// one failing surface cannot blank the rest of a repo, an unconfigured feed
// makes no calls at all, and an auth failure backs off instead of hammering gh.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createGithubProbe } = require('../github_probe');

const NOW = 1_800_000_000_000;

function fakeExec(responses) {
  const calls = [];
  const exec = (file, args, _opts, cb) => {
    const key = `${file} ${args.join(' ')}`;
    calls.push(key);
    queueMicrotask(() => {
      const response = responses[key];
      if (response instanceof Error) cb(response, '', response.message);
      else if (response === undefined) cb(new Error(`unexpected call: ${key}`), '', 'not mocked');
      else cb(null, response, '');
    });
  };
  return { exec, calls };
}

function reposFile(repos) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hud-github-'));
  const file = path.join(dir, 'github_repos.json');
  fs.writeFileSync(file, JSON.stringify({ repos }));
  return file;
}

test('unreadable config makes no gh calls', async () => {
  const { exec, calls } = fakeExec({});
  const probe = createGithubProbe({ reposFile: '/nonexistent/repos.json', exec, now: () => NOW });
  const snap = await probe.pollNow();
  assert.equal(snap.configured, false);
  assert.equal(snap.repos.length, 0);
  assert.equal(snap.warnings[0].kind, 'unconfigured');
  assert.equal(calls.length, 0);
});

test('a poll reports git, PRs, issues and runs per repo', async () => {
  const file = reposFile([{ id: 'acme/one', localPath: '/tmp/one' }]);
  const { exec } = fakeExec({
    '/opt/homebrew/bin/gh api user': '{"login":"tester"}',
    '/opt/homebrew/bin/gh pr list --repo acme/one --state open --limit 20 --json number,title,isDraft,reviewDecision,statusCheckRollup,author,url':
      JSON.stringify([{ number: 7, title: 'Add floor', isDraft: false, reviewDecision: 'APPROVED', author: { login: 'dev' }, url: 'https://x/7',
        statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'SUCCESS' }] }]),
    '/opt/homebrew/bin/gh issue list --repo acme/one --state open --limit 20 --json number,title,labels,assignees,url':
      JSON.stringify([{ number: 9, title: 'Bug', labels: [{ name: 'bug' }], assignees: [{ login: 'dev' }], url: 'https://x/9' }]),
    '/opt/homebrew/bin/gh run list --repo acme/one --limit 5 --json workflowName,status,conclusion,headBranch,url':
      JSON.stringify([{ workflowName: 'ci', status: 'completed', conclusion: 'failure', headBranch: 'main', url: 'https://x/r1' }]),
    'git -C /tmp/one status --porcelain=v2 --branch':
      '# branch.oid abcdef123456\n# branch.head main\n# branch.upstream origin/main\n# branch.ab +2 -3\n1 .M N... 100644 100644 100644 a b src/x.js',
    'git -C /tmp/one log -1 --format=%ct': String(NOW / 1000 - 3600),
  });
  const probe = createGithubProbe({ reposFile: file, exec, now: () => NOW });
  const snap = await probe.pollNow();
  const repo = snap.repos[0];
  assert.equal(snap.auth.account, 'tester');
  assert.deepEqual(repo.git, { branch: 'main', head: 'abcdef1', dirty: 1, ahead: 2, behind: 3, lastCommitAgeSec: 3600 });
  assert.equal(repo.prs[0].checks, 'passing');
  assert.equal(repo.counts.failing, 1);
  assert.equal(snap.totals.failing, 1);
  assert.equal(snap.ageSec, 0);
});

test('one failing surface does not blank the others', async () => {
  const file = reposFile([{ id: 'acme/partial' }]);
  const { exec } = fakeExec({
    '/opt/homebrew/bin/gh api user': '{"login":"tester"}',
    '/opt/homebrew/bin/gh pr list --repo acme/partial --state open --limit 20 --json number,title,isDraft,reviewDecision,statusCheckRollup,author,url': new Error('HTTP 404: Not Found'),
    '/opt/homebrew/bin/gh issue list --repo acme/partial --state open --limit 20 --json number,title,labels,assignees,url':
      JSON.stringify([{ number: 4, title: 'still here', labels: [], assignees: [], url: 'https://x/4' }]),
    '/opt/homebrew/bin/gh run list --repo acme/partial --limit 5 --json workflowName,status,conclusion,headBranch,url': '[]',
  });
  const probe = createGithubProbe({ reposFile: file, exec, now: () => NOW });
  const snap = await probe.pollNow();
  const repo = snap.repos[0];
  assert.match(repo.error, /^prs: .*404/);
  assert.equal(repo.issues.length, 1);
  assert.equal(repo.runs.length, 0);
  assert.ok(snap.poll.lastSuccessAt);
});

test('gh:false repos are measured locally without gh', async () => {
  const file = reposFile([{ id: 'acme/local', localPath: '/tmp/local', gh: false }]);
  const { exec, calls } = fakeExec({
    'git -C /tmp/local status --porcelain=v2 --branch': '# branch.oid abcdef123456\n# branch.head main',
    'git -C /tmp/local log -1 --format=%ct': String(NOW / 1000 - 60),
  });
  const probe = createGithubProbe({ reposFile: file, exec, now: () => NOW });
  const snap = await probe.pollNow();
  assert.equal(snap.repos[0].gh, false);
  assert.equal(snap.repos[0].git.branch, 'main');
  assert.equal(calls.filter((call) => call.startsWith('/opt/homebrew/bin/gh ')).length, 0);
});

test('auth failure backs off and keeps the reason', async () => {
  const file = reposFile([{ id: 'acme/one' }]);
  const { exec } = fakeExec({ '/opt/homebrew/bin/gh api user': new Error('HTTP 401: Bad credentials') });
  const probe = createGithubProbe({ reposFile: file, exec, now: () => NOW });
  const snap = await probe.pollNow();
  assert.equal(snap.auth.ok, false);
  assert.equal(snap.poll.failures, 1);
  assert.equal(snap.poll.nextPollAt, NOW + 300_000);
  assert.equal(snap.warnings[0].kind, 'gh-unavailable');
  assert.match(snap.poll.lastError, /Bad credentials/);
});

test('a snapshot read never spawns a process', async () => {
  const { exec, calls } = fakeExec({});
  const probe = createGithubProbe({ reposFile: '/nonexistent/repos.json', exec, now: () => NOW });
  probe.snapshot();
  probe.snapshot();
  assert.equal(calls.length, 0);
});

test('concurrent polls share one cycle', async () => {
  const file = reposFile([{ id: 'acme/one' }]);
  const { exec, calls } = fakeExec({
    '/opt/homebrew/bin/gh api user': '{"login":"tester"}',
    '/opt/homebrew/bin/gh pr list --repo acme/one --state open --limit 20 --json number,title,isDraft,reviewDecision,statusCheckRollup,author,url': '[]',
    '/opt/homebrew/bin/gh issue list --repo acme/one --state open --limit 20 --json number,title,labels,assignees,url': '[]',
    '/opt/homebrew/bin/gh run list --repo acme/one --limit 5 --json workflowName,status,conclusion,headBranch,url': '[]',
  });
  const probe = createGithubProbe({ reposFile: file, exec, now: () => NOW });
  await Promise.all([probe.pollNow(), probe.pollNow()]);
  assert.equal(calls.filter((call) => call.endsWith('api user')).length, 1);
  probe.stop();
});

test('the load cap is opt-in', async () => {
  const file = reposFile([{ id: 'acme/one' }]);
  const { exec } = fakeExec({
    '/opt/homebrew/bin/gh api user': '{"login":"tester"}',
    '/opt/homebrew/bin/gh pr list --repo acme/one --state open --limit 20 --json number,title,isDraft,reviewDecision,statusCheckRollup,author,url': '[]',
    '/opt/homebrew/bin/gh issue list --repo acme/one --state open --limit 20 --json number,title,labels,assignees,url': '[]',
    '/opt/homebrew/bin/gh run list --repo acme/one --limit 5 --json workflowName,status,conclusion,headBranch,url': '[]',
  });
  const uncapped = createGithubProbe({ reposFile: file, exec, now: () => NOW, loadavg: () => [60, 50, 40] });
  assert.equal((await uncapped.pollNow()).poll.deferred, false);

  const capped = createGithubProbe({ reposFile: file, exec, now: () => NOW, loadavg: () => [60, 50, 40], maxLoad: 24 });
  const snap = await capped.pollNow();
  assert.equal(snap.poll.deferred, true);
  assert.equal(snap.poll.nextPollAt, NOW + 180_000);
});
