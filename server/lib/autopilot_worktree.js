'use strict';
// Worktree lifecycle for the autopilot.
//
// The autopilot's first non-negotiable rule is that it never edits the shared
// working tree. That rule is enforced here, structurally: every command the
// autopilot runs happens inside a git worktree that this module created, and
// that worktree lives outside every repository on the machine. There is no code
// path that hands the autopilot a path inside someone's checkout.
//
// Two properties are load-bearing and worth stating plainly:
//
//   1. The park directory is outside every repo (~/.openalice/...). Adding a
//      worktree inside the fleet would show up as untracked noise in the
//      superproject and in the app repo, which is exactly the kind of litter
//      this whole exercise exists to avoid.
//   2. `withWorktree` removes the worktree in a `finally`. A crashed test run
//      leaves a stale directory at most; it never leaves a live worktree holding
//      a lock or a half-applied edit.
//
// Nothing here merges, pushes, or rewrites history. It shells out to `git
// worktree` and `git` plumbing only.

const { execFile } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DEFAULT_PARK = path.join(os.homedir(), '.openalice', 'autopilot-worktrees');
const GIT_TIMEOUT_MS = 120_000;

/** Run a git command, resolving with stdout. Rejects with a useful message. */
function git(args, cwd, { timeoutMs = GIT_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const detail = String(stderr || err.message).trim().split('\n')[0];
        reject(new Error(`git ${args[0]} failed: ${detail}`));
        return;
      }
      resolve(String(stdout));
    });
  });
}

/** True when `child` resolves inside `parent` (or is `parent`). */
function isInside(parent, child) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Refuse to operate on anything that is not plausibly a git checkout, and
 * refuse a repo whose path is inside the park (which would nest worktrees
 * inside worktrees).
 */
function assertUsableRepo(repo, park) {
  const resolved = path.resolve(repo);
  if (!fs.existsSync(path.join(resolved, '.git'))) {
    throw new Error(`not a git repository: ${resolved}`);
  }
  if (isInside(park, resolved)) {
    throw new Error('refusing to use a repository that lives inside the autopilot park');
  }
  return resolved;
}

/**
 * Create a detached worktree for `ref` and hand its path to `fn`.
 *
 * Detached, not branched: a verification run has nothing to commit, and a
 * detached HEAD cannot be pushed by accident. Callers that want a branch for a
 * proposal create it themselves from the returned path.
 *
 * `fn` may return a value, which is passed back to the caller. Whatever `fn`
 * does, the worktree is removed before this promise settles.
 */
async function withWorktree({ repo, ref = 'HEAD', name, park = DEFAULT_PARK, fn, timeoutMs }) {
  const resolvedPark = path.resolve(park);
  const resolvedRepo = assertUsableRepo(repo, resolvedPark);
  const slug = String(name || `wt-${process.pid}-${Date.now()}`).replace(/[^A-Za-z0-9._-]/g, '-');
  const target = path.join(resolvedPark, slug);

  fs.mkdirSync(resolvedPark, { recursive: true });
  if (fs.existsSync(target)) {
    // A previous run died hard enough to leave this behind. Clear it rather
    // than refusing: it is our own scratch space, not anyone's work.
    await git(['worktree', 'remove', '--force', target], resolvedRepo).catch(() => {});
    fs.rmSync(target, { recursive: true, force: true });
  }

  await git(['worktree', 'add', '--detach', target, ref], resolvedRepo, { timeoutMs });

  try {
    return await fn(target);
  } finally {
    // `worktree remove` also updates .git/worktrees bookkeeping; a plain rm
    // would leave git thinking the worktree still exists.
    await git(['worktree', 'remove', '--force', target], resolvedRepo)
      .catch(() => fs.rmSync(target, { recursive: true, force: true }));
  }
}

/**
 * Count uncommitted changes in a worktree. Used for the autopilot's own gate:
 * a freshly created worktree is always 0, which is the point — the gate is
 * about *our* tree, not the operator's.
 */
async function dirtyCount(worktreePath) {
  const out = await git(['status', '--porcelain'], worktreePath);
  return out.split('\n').filter((line) => line.trim().length > 0).length;
}

/**
 * Worktrees this module left behind. Non-zero means a previous run crashed, and
 * the autopilot refuses to propose until it is cleared, because a stale
 * worktree means we do not know what state the last attempt reached.
 */
async function staleWorktrees(repo, park = DEFAULT_PARK) {
  const resolvedPark = path.resolve(park);
  if (!fs.existsSync(resolvedPark)) return [];
  return fs.readdirSync(resolvedPark, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => path.join(resolvedPark, e.name));
}

/** Remove every parked worktree for `repo`. Operator-facing cleanup. */
async function clearPark(repo, park = DEFAULT_PARK) {
  const removed = [];
  for (const dir of await staleWorktrees(repo, park)) {
    await git(['worktree', 'remove', '--force', dir], path.resolve(repo)).catch(() => {});
    fs.rmSync(dir, { recursive: true, force: true });
    removed.push(dir);
  }
  await git(['worktree', 'prune'], path.resolve(repo)).catch(() => {});
  return removed;
}

module.exports = {
  DEFAULT_PARK,
  git,
  withWorktree,
  dirtyCount,
  staleWorktrees,
  clearPark,
  isInside,
};