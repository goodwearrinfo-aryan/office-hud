'use strict';

// Background terminals: a detached child process whose stdout/stderr are
// appended to a log file.
//
// The right backend for a command that produces a result rather than a session
// -- a test run, a lint pass, a build. There is nothing to attach to, so paying
// tmux's session bookkeeping would be waste. The trade-off is that it cannot be
// reattached, which is why the HUD records `type` on every terminal and the
// panel can say so.
//
// `detached: true` puts the child in its own process group so it survives the
// HUD being restarted, and the manager still tracks the pid so it can be killed.

const { spawn: spawnProcess } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

/**
 * Spawn `argv` detached, appending output to `logFile`.
 *
 * `onExit` is invoked once when the child exits so the manager can move the
 * terminal out of `running` without polling for it.
 */
function spawn({ argv, cwd, logFile, env, onExit }) {
  if (!Array.isArray(argv) || !argv.length) throw new Error('background spawn requires an argv array');

  // Open the log in append mode so several terminals can share a directory and
  // a rotated file is never truncated out from under a live writer.
  let stream = null;
  if (logFile) {
    try {
      fs.mkdirSync(path.dirname(logFile), { recursive: true });
      stream = fs.createWriteStream(logFile, { flags: 'a' });
    } catch {
      stream = null;
    }
  }
  if (stream) {
    // An unhandled 'error' on a stream is thrown as an uncaught exception, and
    // this process treats that as fatal and restarts under launchd. A log that
    // cannot be opened -- read-only tmp, a full disk, a tmp reaper clearing the
    // directory -- must cost the output, not the terminal and not the HUD. The
    // terminal still runs with its output going nowhere.
    stream.on('error', () => { try { stream.destroy(); } catch { /* already gone */ } });
  }

  const child = spawnProcess(argv[0], argv.slice(1), {
    cwd,
    env,
    detached: true,
    stdio: ['ignore', stream ? 'pipe' : 'ignore', stream ? 'pipe' : 'ignore'],
  });

  if (stream) {
    // Two pipes into one append-mode fd: writes interleave safely because each
    // chunk is a single write, and stdout/stderr keep their relative order
    // closely enough to read.
    child.stdout?.pipe(stream, { end: false });
    child.stderr?.pipe(stream, { end: false });
  }

  let closed = false;
  const finish = (code, signal) => {
    if (closed) return;
    closed = true;
    if (stream) { try { stream.end(); } catch { /* already ended */ } }
    if (typeof onExit === 'function') {
      try { onExit({ code, signal }); } catch { /* a listener must not break exit */ }
    }
  };
  child.on('exit', finish);
  child.on('error', (error) => finish(null, null, error));

  return {
    pid: child.pid,
    // Unref lets the HUD exit while the child keeps running. Without this the
    // event loop stays pinned to a detached test run that outlives the request.
    child,
    unref: () => { try { child.unref(); } catch { /* already gone */ } },
  };
}

/** Signal the child's whole process group, so `npm test` takes its children too. */
function kill(pid, signal = 'SIGTERM') {
  const target = Number(pid);
  if (!Number.isInteger(target) || target <= 1) throw new Error(`refusing to signal pid ${pid}`);
  // Negative pid addresses the process group created by detached:true. Fall back
  // to the bare pid when the child was never made a group leader.
  try { process.kill(-target, signal); } catch { process.kill(target, signal); }
  return true;
}

const isAlive = (pid) => {
  const target = Number(pid);
  if (!Number.isInteger(target) || target <= 1) return false;
  try { process.kill(target, 0); return true; } catch (error) { return error.code === 'EPERM'; }
};

module.exports = { spawn, kill, isAlive };