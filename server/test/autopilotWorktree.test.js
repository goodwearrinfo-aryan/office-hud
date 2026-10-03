'use strict';
// The worktree layer is the autopilot's structural guarantee: it is the reason
// the autopilot cannot reach anyone's working tree. So these tests are mostly
// about what it refuses and about proving the worktree is really gone
// afterwards, because a leaked worktree is a leaked lock and a leaked branch.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const {
  withWorktree, dirtyCount, staleWorktrees, clearPark, isInside, git, DEFAULT_PARK,
} = require('../lib/autopilot_worktree.js');

const GIT = { cwd: '/tmp', timeout: 60000 };

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-wt-repo-'));
  const run = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
  run('init', '-q', '-b', 'main');
  run('config', 'user.email', 'test@example.invalid');
  run('config', 'user.name', 'test');
  fs.writeFileSync(path.join(dir, 'README.md'), 'seed\n');
  run('add', '.');
  run('commit', '-q', '-m', 'seed');
  return dir;
}

function park() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ap-wt-park-'));
}

// ------------------------------------------------------------------- path maths

test('isInside recognises a child and rejects a sibling with a shared prefix', () => {
  assert.equal(isInside('/a/b', '/a/b/c'), true);
  assert.equal(isInside('/a/b', '/a/b'), true);
  // The classic bug: /a/bc must not count as inside /a/b.
  assert.equal(isInside('/a/b', '/a/bc'), false);
  assert.equal(isInside('/a/b', '/a'), false);
});

test('DEFAULT_PARK sits outside the repos it operates on', () => {
  assert.ok(!isInside(path.join(os.homedir(), 'openalice-fleet'), DEFAULT_PARK));
});

// --------------------------------------------------------------- happy lifecycle

test('withWorktree hands fn a real checkout of the requested ref and cleans up', async () => {
  const repo = makeRepo();
  const p = park();
  let seen = null;
  const result = await withWorktree({
    repo, ref: 'HEAD', name: 'ok', park: p,
    fn: async (wt) => {
      seen = wt;
      assert.ok(fs.existsSync(path.join(wt, 'README.md')), 'worktree has the checked-out file');
      assert.equal(await dirtyCount(wt), 0, 'a fresh worktree is clean');
      return 'returned-value';
    },
  });
  assert.equal(result, 'returned-value', "fn's return value reaches the caller");
  assert.equal(fs.existsSync(seen), false, 'the worktree directory is gone afterwards');
});

test('the worktree is removed even when fn throws', async () => {
  const repo = makeRepo();
  const p = park();
  let seen = null;
  await assert.rejects(withWorktree({
    repo, ref: 'HEAD', name: 'boom', park: p,
    fn: async (wt) => { seen = wt; throw new Error('kaboom'); },
  }), /kaboom/);
  assert.equal(fs.existsSync(seen), false, 'a crash must not leak the worktree');
  assert.deepEqual(await staleWorktrees(repo, p), [], 'and it is not left in the park');
});

test('git worktree bookkeeping is pruned so the repo does not think it still exists', async () => {
  const repo = makeRepo();
  const p = park();
  await withWorktree({ repo, ref: 'HEAD', name: 'book', park: p, fn: async () => 'ok' });
  const listed = execFileSync('git', ['worktree', 'list'], { cwd: repo, encoding: 'utf8' });
  assert.ok(!listed.includes(path.basename(p)), 'the removed worktree is not still registered');
});

// ------------------------------------------------------------------- refusals

test('withWorktree refuses a path that is not a git repository', async () => {
  const notRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-wt-notrepo-'));
  await assert.rejects(
    withWorktree({ repo: notRepo, ref: 'HEAD', name: 'x', park: park(), fn: async () => 1 }),
    /not a git repository/,
  );
});

test('withWorktree refuses a repo that lives inside the park', async () => {
  const p = park();
  const inner = path.join(p, 'nested-repo');
  fs.mkdirSync(inner, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: inner, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 't@e.invalid'], { cwd: inner, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 't'], { cwd: inner, stdio: 'ignore' });
  fs.writeFileSync(path.join(inner, 'f'), 'x');
  execFileSync('git', ['add', '.'], { cwd: inner, stdio: 'ignore' });
  execFileSync('git', ['commit', '-q', '-m', 'x'], { cwd: inner, stdio: 'ignore' });
  await assert.rejects(
    withWorktree({ repo: inner, ref: 'HEAD', name: 'y', park: p, fn: async () => 1 }),
    /inside the autopilot park/,
    'nesting a worktree inside the park is refused, not silently allowed',
  );
});

test('a bad ref fails loudly instead of producing an empty worktree', async () => {
  const repo = makeRepo();
  const p = park();
  await assert.rejects(
    withWorktree({ repo, ref: 'no-such-ref', name: 'bad', park: p, fn: async () => 1 }),
    /git worktree failed/,
  );
});

// ---------------------------------------------------------------- park hygiene

test('staleWorktrees finds leftovers from a crashed run and clearPark removes them', async () => {
  const repo = makeRepo();
  const p = park();
  // Simulate a hard crash: a directory in the park that git never cleaned.
  const orphan = path.join(p, 'orphan-from-last-week');
  fs.mkdirSync(orphan, { recursive: true });
  assert.deepEqual(await staleWorktrees(repo, p), [orphan]);

  const removed = await clearPark(repo, p);
  assert.deepEqual(removed, [orphan]);
  assert.equal(fs.existsSync(orphan), false);
  assert.deepEqual(await staleWorktrees(repo, p), []);
});

test('withWorktree clears a colliding leftover rather than refusing to run', async () => {
  const repo = makeRepo();
  const p = park();
  fs.mkdirSync(path.join(p, 'same-name'), { recursive: true });
  // Asserted inside fn: by the time withWorktree resolves, the worktree has
  // already been removed, so its path is legitimately gone at this point.
  await withWorktree({
    repo, ref: 'HEAD', name: 'same-name', park: p,
    fn: async (wt) => {
      assert.ok(fs.existsSync(wt), 'the run proceeded despite the stale directory');
      assert.ok(fs.existsSync(path.join(wt, 'README.md')), 'and the checkout is usable');
    },
  });
  assert.deepEqual(await staleWorktrees(repo, p), [], 'nothing left behind');
});

test('a name with unsafe characters cannot escape the park', async () => {
  const repo = makeRepo();
  const p = park();
  const sneaky = '../../escape';
  const wt = await withWorktree({ repo, ref: 'HEAD', name: sneaky, park: p, fn: async (d) => d });
  assert.ok(wt.startsWith(p + path.sep), `worktree stayed inside the park (got ${wt})`);
});

test('dirtyCount counts modified and untracked files', async () => {
  const repo = makeRepo();
  assert.equal(await dirtyCount(repo), 0);
  fs.writeFileSync(path.join(repo, 'README.md'), 'changed\n');
  assert.equal(await dirtyCount(repo), 1);
  fs.writeFileSync(path.join(repo, 'new.txt'), 'x');
  assert.equal(await dirtyCount(repo), 2, 'untracked files count as dirty too');
});

test('git failures surface the first line of stderr, not a bare exit code', async () => {
  await assert.rejects(git(['rev-parse', '--verify', 'nope'], '/tmp'), /git rev-parse failed/);
});
void GIT;