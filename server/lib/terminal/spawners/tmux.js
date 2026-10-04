'use strict';

// tmux-backed terminals.
//
// tmux is the right backend for anything the operator may want to attach to:
// the session outlives the HTTP request that created it, so a killed HUD or a
// closed browser does not kill the work, and `tmux attach -t <session>` from a
// real terminal picks it up mid-run.
//
// Arguments are passed to tmux as an argv array and never joined into a shell
// string, so a command containing `;` or `&&` is a literal argument here rather
// than two commands.

const { execFile } = require('node:child_process');
const os = require('node:os');
const path = require('node:path');

const TMUX = process.env.OFFICE_HUD_TMUX || 'tmux';
const DEFAULT_TIMEOUT_MS = 15000;

// launchd hands this process PATH=/usr/bin:/bin:/usr/sbin:/sbin, which does not
// include Homebrew -- so a Homebrew-installed tmux is invisible to a plain
// execFile('tmux') even though it is right there on the operator's PATH. The
// binary is resolved once against PATH plus the common install prefixes, and
// the resolved absolute path is what every call uses.
const EXTRA_PREFIXES = [
  '/opt/homebrew/bin',
  '/usr/local/bin',
  '/opt/local/bin',
  '/usr/bin',
  '/bin',
];

let resolvedBinary = null;

function resolveBinary() {
  if (TMUX !== 'tmux') return TMUX;
  if (resolvedBinary) return resolvedBinary;
  const fs = require('node:fs');
  const seen = new Set();
  const candidates = [];
  for (const dir of String(process.env.PATH || '').split(':')) {
    if (dir && !seen.has(dir)) { seen.add(dir); candidates.push(dir); }
  }
  for (const dir of EXTRA_PREFIXES) {
    if (!seen.has(dir)) { seen.add(dir); candidates.push(dir); }
  }
  for (const dir of candidates) {
    const full = path.join(dir, 'tmux');
    try {
      fs.accessSync(full, fs.constants.X_OK);
      resolvedBinary = full;
      return resolvedBinary;
    } catch { /* keep looking */ }
  }
  // Nothing found: fall back to the bare name so the error message names `tmux`.
  return 'tmux';
}

function tmux(args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(resolveBinary(), args, {
      timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, ...(options.env || {}) },
    }, (error, stdout, stderr) => {
      if (error) {
        const message = String(stderr || error.message || '').trim();
        const failure = new Error(message || `tmux ${args[0]} failed`);
        failure.stderr = message;
        failure.code = error.code;
        reject(failure);
        return;
      }
      resolve(String(stdout || '').trim());
    });
  });
}

const available = async () => {
  try {
    await tmux(['-V'], { timeoutMs: 3000 });
    return true;
  } catch {
    return false;
  }
};

/** True only when the session exists AND its pane is still alive. */
async function isAlive(session) {
  if (!session) return false;
  try {
    await tmux(['has-session', '-t', `=${session}`], { timeoutMs: 3000 });
    return true;
  } catch {
    return false;
  }
}

/** The pane id of the session's active pane, used to target pipe-pane. */
async function activePane(session) {
  const out = await tmux(['list-panes', '-t', `=${session}`, '-F', '#{pane_id}']);
  const pane = String(out).split('\n').find(Boolean);
  return pane ? pane.replace(/^%/, '') : null;
}

/**
 * Start a detached session running argv, with output teed to `logFile`.
 *
 * `pipe-pane` is how output is captured: it runs a shell command, so the log
 * path must be one this module generated. It is `-- <path>`, derived from a
 * validated terminal id, and never caller input.
 */
async function spawn({ session, argv, cwd, logFile, cols, rows, env }) {
  if (!session) throw new Error('tmux spawn requires a session name');
  if (!Array.isArray(argv) || !argv.length) throw new Error('tmux spawn requires an argv array');

  const args = ['new-session', '-d', '-s', session, '-c', cwd];
  if (Number.isFinite(cols) && Number.isFinite(rows)) args.push('-x', String(cols), '-y', String(rows));
  // `--` stops tmux from reading its own options out of the command.
  args.push('--', ...argv);

  await tmux(args, { env });
  const pane = await activePane(session);

  if (logFile) {
    try {
      // -o so the pipe is replaced rather than stacked if a pane is reused.
      await tmux(['pipe-pane', '-t', `%${pane}`, '-o', `cat >> '${logFile}'`]);
    } catch {
      // Output capture is a convenience: a session that runs but whose output
      // cannot be teed is still a working terminal, so this must not fail spawn.
    }
  }

  return { tmuxSession: session, tmuxPane: pane ? `%${pane}` : null };
}

async function kill(session, options = {}) {
  await tmux(['kill-session', '-t', `=${session}`], options);
  return true;
}

/** Send keys to the session's pane (used to answer a prompt in a live session). */
// NOTE on target syntax. Session targets here are plain names, never the
// `=name` exact-match form. Verified against tmux 3.7c: `send-keys -t =sess`
// fails with "can't find pane", `capture-pane -t =sess` fails the same way, and
// `display-message -t =sess` returns EMPTY rather than erroring -- which made
// cwd() report null for a live session. `has-session` and `list-panes` do
// accept `=`, so both forms appear below only where they actually work.

async function sendKeys(session, keys, options = {}) {
  await tmux(['send-keys', '-t', session, ...String(keys).split(' ')], options);
  return true;
}

/**
 * Send text to the pane as literal keystrokes.
 *
 * `sendKeys` splits its argument on spaces, which is right for a key name
 * (`C-c`) and wrong for typed text: a space in the input would become an
 * argument separator, and any shell metacharacter would be interpreted by tmux
 * rather than typed. `-l` is tmux's literal mode -- the string is delivered to
 * the pane exactly as given.
 */
async function sendText(session, text, options = {}) {
  const value = String(text ?? '');
  if (!value) return false;
  await tmux(['send-keys', '-t', session, '-l', '--', value], options);
  return true;
}

/** Deliver `text` followed by a Return, i.e. submit the line. */
async function sendLine(session, text, options = {}) {
  await sendText(session, text, options);
  await tmux(['send-keys', '-t', session, 'Enter'], options);
  return true;
}

/**
 * Send text to the pane as literal keystrokes.
 *
 * `sendKeys` splits its argument on spaces, which is right for a key name
 * (`C-c`) and wrong for typed text: a space in the input would become an
 * argument separator, and any shell metacharacter would be interpreted by tmux
 * rather than typed. `-l` is tmux's literal mode -- the string is delivered to
 * the pane exactly as given.
 */
async function sendText(session, text, options = {}) {
  const value = String(text ?? '');
  if (!value) return false;
  await tmux(['send-keys', '-t', `=${session}`, '-l', '--', value], options);
  return true;
}

/** Deliver `text` followed by a Return, i.e. submit the line. */
async function sendLine(session, text, options = {}) {
  await sendText(session, text, options);
  await tmux(['send-keys', '-t', `=${session}`, 'Enter'], options);
  return true;
}

const capture = (session, lines = 200) =>
  tmux(['capture-pane', '-p', '-t', session, '-S', `-${Math.max(1, Number(lines) || 200)}`]);

/** The session's current working directory, so a reload can show where it is. */
async function cwd(session) {
  try {
    return await tmux(['display-message', '-p', '-t', session, '#{pane_current_path}']);
  } catch {
    return null;
  }
}

const hostLabel = () => os.hostname().split('.')[0];

module.exports = { tmux, available, isAlive, spawn, kill, sendKeys, sendText, sendLine, capture, cwd, activePane, hostLabel, resolveBinary };