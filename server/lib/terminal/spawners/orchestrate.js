'use strict';

// Orchestrate-backed terminals: one agent per git worktree, run by the fleet's
// own orchestrate scripts.
//
// This is deliberately the most restricted of the three backends. `spawn-agent.sh`
// launches `claude --permission-mode bypassPermissions` inside a tmux window on a
// fresh worktree, so reaching it from an HTTP route is a privilege-escalation
// surface, not just a process spawn. It therefore requires an explicit
// confirmation flag from the caller, refuses to run unless the orchestrate
// scripts are actually present, and reports the worktree mapping so a kill can
// hand the worktree back instead of leaking it.
//
// The scripts stay the single source of truth for the worktree lifecycle: this
// module shells out to them rather than reimplementing branch and window
// bookkeeping, which is the part that is easy to get subtly wrong.

const { execFile } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SKILL_DIR = process.env.ORCHESTRATE_SKILL_DIR
  || path.join(os.homedir(), '.claude', 'skills', 'aryan-skills', 'skills', 'orchestrate');
const SCRIPTS = path.join(SKILL_DIR, 'scripts');
const STATE_FILE = path.join(os.homedir(), '.claude', 'orchestrator-state.json');

const findSpare = `${SCRIPTS}/find-spare.sh`;
const spawnAgent = `${SCRIPTS}/spawn-agent.sh`;
const recycleAgent = `${SCRIPTS}/recycle-agent.sh`;

function run(script, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile('/bin/bash', [script, ...args], {
      timeout: options.timeoutMs ?? 180000,
      maxBuffer: 4 * 1024 * 1024,
      cwd: options.cwd,
      env: { ...process.env },
    }, (error, stdout, stderr) => {
      if (error) {
        const failure = new Error(String(stderr || error.message || '').trim() || `${script} failed`);
        failure.code = error.code;
        reject(failure);
        return;
      }
      resolve(String(stdout || ''));
    });
  });
}

/** Every script this backend needs must exist before any of it is offered. */
function available() {
  return [findSpare, spawnAgent, recycleAgent].every((script) => fs.existsSync(script));
}

/**
 * Worktrees on spare/N branches, as { path, branch }.
 * find-spare.sh prints "PATH BRANCH" per line; a non-zero exit means none free.
 */
async function listSpares(repoRoot) {
  let out = '';
  try {
    out = await run(findSpare, [repoRoot], { cwd: repoRoot, timeoutMs: 30000 });
  } catch {
    return [];
  }
  const spares = [];
  for (const line of out.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // A path may contain spaces, so split on the last run of whitespace.
    const match = /^(.*\S)\s+(\S+)$/.exec(trimmed);
    if (!match) continue;
    spares.push({ worktreePath: match[1], spareBranch: match[2] });
  }
  return spares;
}

/**
 * Spawn `count` agents on spares, one window each.
 * Returns one descriptor per agent so each is tracked as its own terminal.
 */
async function spawn({ repoRoot, objective, steps = [], count = 1, branchPrefix = 'feat/hud', session }) {
  if (!available()) throw Object.assign(new Error('orchestrate scripts are not installed'), { statusCode: 501 });
  if (!repoRoot) throw Object.assign(new Error('orchestrate spawn requires a repoRoot'), { statusCode: 400 });
  if (!objective) throw Object.assign(new Error('orchestrate spawn requires an objective'), { statusCode: 400 });

  const spares = await listSpares(repoRoot);
  if (!spares.length) {
    throw Object.assign(new Error(`no spare worktrees free in ${repoRoot}`), { statusCode: 409 });
  }
  const wanted = Math.max(1, Math.min(Number(count) || 1, spares.length));
  const created = [];
  const failures = [];

  for (let index = 0; index < wanted; index++) {
    const spare = spares[index];
    // One branch per agent, slugged so the window list is readable later.
    const slug = String(branchPrefix).replace(/[^A-Za-z0-9._/-]+/g, '-').replace(/^-+|-+$/g, '');
    const newBranch = `${slug || 'feat/hud'}-${Date.now().toString(36)}-${index}`;
    try {
      // Stdout is exactly "SESSION:WINDOW"; callers rely on that being the only
      // line, so it is trimmed and not decorated.
      const out = await run(
        spawnAgent,
        [session || 'autogpt1', spare.worktreePath, spare.spareBranch, newBranch, objective, ...steps],
        { cwd: repoRoot },
      );
      const target = out.trim().split('\n').pop() || '';
      if (!target.includes(':')) throw new Error(`unexpected spawn-agent output: ${target || '(empty)'}`);
      created.push({
        orchestrateWindow: target,
        tmuxSession: target.split(':')[0],
        worktreePath: spare.worktreePath,
        spareBranch: spare.spareBranch,
        branch: newBranch,
        objective,
        steps,
      });
    } catch (error) {
      failures.push({ worktreePath: spare.worktreePath, error: error.message });
    }
  }

  return { created, failures, repoRoot };
}

/** Hand a worktree back to its spare branch and drop the window. */
async function kill({ orchestrateWindow, worktreePath, spareBranch }) {
  if (!orchestrateWindow || !worktreePath || !spareBranch) {
    throw Object.assign(new Error('orchestrate kill requires window, worktree and spare branch'), { statusCode: 400 });
  }
  if (!available()) throw Object.assign(new Error('orchestrate scripts are not installed'), { statusCode: 501 });
  const out = await run(recycleAgent, [orchestrateWindow, worktreePath, spareBranch], {
    cwd: worktreePath,
    timeoutMs: 60000,
  });
  return { output: out.trim() };
}

/** A session id the fleet already owns, so the HUD does not invent a new one. */
function currentSession() {
  try {
    const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (state && typeof state.tmux_session === 'string' && state.tmux_session) return state.tmux_session;
  } catch { /* no state file yet */ }
  return 'autogpt1';
}

const isAlive = async ({ orchestrateWindow }) => {
  if (!orchestrateWindow) return false;
  try {
    const { execFile } = require('node:child_process');
    await new Promise((resolve, reject) => {
      execFile('tmux', ['has-session', '-t', `=${orchestrateWindow.split(':')[0]}`], { timeout: 3000 },
        (error) => (error ? reject(error) : resolve()));
    });
    return true;
  } catch {
    return false;
  }
};

module.exports = { available, listSpares, spawn, kill, isAlive, currentSession, SKILL_DIR, STATE_FILE };