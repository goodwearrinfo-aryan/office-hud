'use strict';
// Remote terminals: run a command on a peer host over SSH.
//
// This exists because of where the work actually is. The single office-hud runs
// on the deployment host, but the repositories being worked on live on the
// laptop -- so without this the HUD could only ever run commands in a directory
// that does not contain them.
//
// It is the highest-privilege backend here, because it turns a local HTTP route
// into shell access on another machine. Three things bound that:
//
//   1. Peers are named in hive/terminal_peers.json. A host that is not listed
//      cannot be targeted at all -- there is no free-form host parameter.
//   2. The command is validated with the same default-deny allowlist as a local
//      spawn, against the PEER's cwdPrefixes rather than this host's, because
//      /Users/a and /Users/aryanagarwal are different trees and validating a
//      remote path against local rules would either be wrong or a hole.
//   3. The peer must already be reachable as this user. This module never
//      installs keys, never edits authorized_keys, and never relaxes
//      StrictHostKeyChecking. If the operator has not established trust, a spawn
//      fails with an honest error instead of quietly establishing it.
//
// The command is executed through a fixed `sh -c` whose cwd and argv arrive as
// POSITIONAL PARAMETERS, never interpolated into the script text. That keeps the
// no-shell guarantee the local backends have: a command containing `;` or `$( )`
// is still only ever an argument, because the script is a constant and nothing
// user-supplied is concatenated into it.

const { spawn: spawnProcess } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const allowlist = require('../allowlist');

// The constant remote script. $1 is the cwd, $2.. is the argv. Nothing from the
// request is ever pasted into this string.
//
// It must be SENT WITH ITS OWN QUOTES. ssh does not preserve argument
// boundaries: everything after the destination host is concatenated into one
// string and handed to the remote login shell, which then parses it. Passing
// this as a bare argv element arrives as the unquoted text
// `cd "$1" && shift && exec "$@"`, where "$@" is empty and `shift` aborts with
// "shift count must be <= $#". That is not theoretical -- it is what happened
// first time this ran against a zsh login shell.
const REMOTE_RUNNER = 'cd "$1" && shift && exec "$@"';

/**
 * POSIX single-quote escaping, for embedding one value in the command string
 * ssh will reassemble.
 *
 * Single quotes make every byte literal, which is what preserves the no-shell
 * guarantee across the ssh boundary: a value containing `;`, `$( )` or a space
 * stays one argument instead of becoming syntax. Embedded quotes are closed,
 * escaped, and reopened (`'\''`), the standard idiom.
 */
function shellQuote(value) {
  const text = String(value);
  if (text === '') return "''";
  // Fast path: nothing that the remote shell could interpret.
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(text)) return text;
  return `'${text.replace(/'/g, "'\\''")}'`;
}

const DEFAULT_SSH = {
  // BatchMode so a missing key fails immediately instead of hanging on a prompt.
  BatchMode: 'yes',
  ConnectTimeout: '10',
  IdentitiesOnly: 'yes',
  // Do not silently accept an unknown host: an unauthenticated peer is exactly
  // the case this module must not paper over.
  StrictHostKeyChecking: 'yes',
  ServerAliveInterval: '15',
  ServerAliveCountMax: '3',
};

let cachedPeers = null;
let cachedPath = null;
let cachedMtime = 0;

/** Peers are re-read only when the file changes, so this is cheap per call. */
function loadPeers(hive, options = {}) {
  const peersPath = options.peersPath || path.join(hive, 'terminal_peers.json');
  let mtime = 0;
  try { mtime = fs.statSync(peersPath).mtimeMs; } catch { mtime = 0; }
  if (cachedPeers && cachedPath === peersPath && mtime === cachedMtime) return cachedPeers;
  let peers = {};
  if (mtime) {
    try {
      const parsed = JSON.parse(fs.readFileSync(peersPath, 'utf8'));
      if (parsed && typeof parsed === 'object' && parsed.peers && typeof parsed.peers === 'object') {
        peers = parsed.peers;
      }
    } catch {
      // A corrupt peer file means NO peers. Treating it as empty is the safe
      // direction: a broken config must not fall back to "any host is allowed".
      peers = {};
    }
  }
  cachedPeers = peers;
  cachedPath = peersPath;
  cachedMtime = mtime;
  return peers;
}

function resetCache() { cachedPeers = null; cachedPath = null; cachedMtime = 0; }

function listPeers(hive, options = {}) {
  const peers = loadPeers(hive, options);
  return Object.entries(peers).map(([name, config]) => ({
    name,
    // A peer with no sshHost is listed but not targetable, so a half-written
    // config is visible rather than mysteriously absent.
    reachable: Boolean(config && config.sshHost),
    cwdPrefixes: (config && config.cwdPrefixes) || null,
  }));
}

function getPeer(hive, name, options = {}) {
  const peers = loadPeers(hive, options);
  const name_ = String(name || '');
  // Key characters only: the name becomes part of an argv entry, and a peer name
  // with a space or a dash-dash prefix could be read as ssh syntax.
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name_)) {
    throw Object.assign(new Error(`invalid peer name "${name}"`), { statusCode: 400 });
  }
  const config = peers[name_];
  if (!config || !config.sshHost) {
    throw Object.assign(new Error(`peer "${name_}" is not configured in terminal_peers.json`), { statusCode: 404 });
  }
  return { name: name_, sshHost: String(config.sshHost), cwdPrefixes: config.cwdPrefixes || null };
}

/**
 * Validate a command for execution on a peer.
 *
 * The allowlist is evaluated with a policy whose cwdPrefixes are the PEER's,
 * because the paths that will be checked do not exist on this host -- so the
 * existence check has to be skipped and the prefix check done against the
 * peer's own tree.
 */
function validateForPeer(command, cwd, peer, options = {}) {
  const hive = options.hive || path.join(os.homedir(), 'openalice-fleet', 'hive');
  const policyPath = options.policyPath;
  const policy = allowlist.load(hive, { policyPath });
  const peerPolicy = {
    ...policy,
    cwdPrefixes: Array.isArray(peer.cwdPrefixes) && peer.cwdPrefixes.length
      ? peer.cwdPrefixes
      : [os.homedir()],
  };
  // mustExist:false because the directory lives on the other machine. The
  // prefix containment check still applies, so the blast radius stays bounded.
  return allowlist.validate(command, cwd, {
    hive,
    policyPath,
    mustExist: false,
    ...{ policyOverride: peerPolicy },
  });
}

/**
 * Start a command on a peer. Output is appended to `logFile` exactly as it is
 * for a local background terminal.
 *
 * `onExit` fires when the ssh client exits. Note the honest limitation: closing
 * the ssh channel sends SIGHUP to the remote process, but a remote process that
 * ignores SIGHUP would survive, so `isAlive` cannot be answered from this side
 * without a second round trip. The record therefore reflects the ssh session,
 * which is what this host actually controls.
 */
/**
 * Discover a PATH on the PEER that can find development tools.
 *
 * Two facts make this necessary, both found by running it:
 *
 *  1. A non-interactive ssh session gets the login shell's default PATH, not the
 *     operator's. On this laptop that is /Users/aryanagarwal/bin:/usr/bin:/bin:
 *     /usr/sbin:/sbin -- no Homebrew, no Python framework -- so `pytest` and
 *     `ruff` fail with exit 127 even though both are installed. Setting PATH on
 *     the LOCAL ssh client does not help; ssh only forwards variables with
 *     SendEnv, which is not configured, and the remote shell picks its own.
 *
 *  2. The PATH cannot be built from this machine's prefixes either. The two Macs
 *     install different Python framework versions (3.9 here, 3.14 there), so a
 *     locally-assembled PATH names directories the peer does not have.
 *
 * So the peer is asked, once, and the answer cached briefly.
 */
const pathCache = new Map(); // peer -> { at, path }
const PEER_PATH_TTL_MS = 5 * 60 * 1000;

function probePeerPath(peer, options = {}) {
  const cached = pathCache.get(peer.name);
  if (cached && Date.now() - cached.at < PEER_PATH_TTL_MS) return Promise.resolve(cached.path);
  const probe = ['-o', 'BatchMode=yes', '-o', `ConnectTimeout=${options.timeoutSec || 10}`,
    '-o', 'StrictHostKeyChecking=yes', peer.sshHost,
    'echo "$PATH"; ls -d /Library/Frameworks/Python.framework/Versions/*/bin 2>/dev/null; ls -d /opt/homebrew/bin /usr/local/bin /opt/local/bin 2>/dev/null'];
  return new Promise((resolve) => {
    const child = spawnProcess('ssh', probe, { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, 15000);
    child.stdout.on('data', (d) => { out += d; });
    child.on('exit', (code) => {
      clearTimeout(timer);
      const lines = out.split('\n').map((l) => l.trim()).filter(Boolean);
      // Line 0 is the peer's own PATH; the rest are discovered bin dirs. The
      // peer's PATH comes first so a tool the user already prefers wins.
      const peerPath = lines[0] || '/usr/bin:/bin:/usr/sbin:/sbin';
      const discovered = lines.slice(1).filter((l) => l.startsWith('/'));
      const merged = [...new Set([...peerPath.split(':'), ...discovered, '/usr/bin', '/bin', '/usr/sbin', '/sbin'])]
        .filter(Boolean).join(':');
      if (code === 0) pathCache.set(peer.name, { at: Date.now(), path: merged });
      resolve(merged);
    });
    child.on('error', () => { clearTimeout(timer); resolve('/usr/bin:/bin:/usr/sbin:/sbin'); });
  });
}

function resetPathCache() { pathCache.clear(); }

function spawn({ peer, argv, cwd, logFile, env, onExit, resolvedPath, timeoutMs, graceMs = 5000 }) {
  if (!Array.isArray(argv) || !argv.length) throw new Error('remote spawn requires an argv array');

  const args = ['-F', String(process.env.REMOTE_SSH_CONFIG || path.join(os.homedir(), '.ssh', 'config'))];
  for (const [key, value] of Object.entries(DEFAULT_SSH)) args.push('-o', `${key}=${value}`);
  // No -t: this is a non-interactive background command, and forcing a PTY
  // makes the remote refuse to run when stdin is not a terminal ("Pseudo-terminal
  // will not be allocated") while changing how the command handles signals.
  //
  // Everything after the host is ONE string that ssh hands to the remote login
  // shell (zsh on a Mac). It is NOT run with `sh -c` implicitly, so the script
  // must name its own interpreter or the remote tries to execute the script TEXT
  // as a program name ("command not found: cd \"$1\" && shift ..."), and an
  // unquoted script arrives with no positional parameters at all ("shift count
  // must be <= $#"). Hence an explicit `sh -c`, the script quoted as one word,
  // then $0/cwd/argv each quoted so nothing becomes syntax.
  // PATH is set on the REMOTE side. Setting it on the local ssh client does
  // nothing: ssh forwards no environment without SendEnv, and the remote login
  // shell would overwrite it anyway. `env PATH=... sh -c` sets it where it is
  // actually read.
  const remoteCommand = [
    'env',
    `PATH=${shellQuote(resolvedPath || '/usr/bin:/bin:/usr/sbin:/sbin')}`,
    'sh',
    '-c',
    shellQuote(REMOTE_RUNNER),
    'hud-remote',
    shellQuote(cwd),
    ...argv.map(shellQuote),
  ].join(' ');
  args.push(peer.sshHost, remoteCommand);

  let stream = null;
  if (logFile) {
    try {
      fs.mkdirSync(path.dirname(logFile), { recursive: true });
      stream = fs.createWriteStream(logFile, { flags: 'a' });
      // Same reasoning as the local background spawner: an unloggable terminal
      // must cost the output, not the HUD.
      stream.on('error', () => { try { stream.destroy(); } catch { /* gone */ } });
    } catch {
      stream = null;
    }
  }

  const child = spawnProcess('ssh', args, {
    stdio: ['ignore', stream ? 'pipe' : 'ignore', stream ? 'pipe' : 'ignore'],
    // Only PATH and HOME cross the wire: passing this process's environment on
    // would leak provider keys into a login shell on the peer. PATH is built by
    // peerPath() rather than forwarded, because the daemon's own PATH is bare.
    env: { PATH: process.env.PATH || '/usr/bin:/bin:/usr/sbin:/sbin', HOME: os.homedir() },
  });

  if (stream) {
    child.stdout?.pipe(stream, { end: false });
    child.stderr?.pipe(stream, { end: false });
  }

  let closed = false;
  let timedOut = false;
  const finish = (code, signal) => {
    if (closed) return;
    closed = true;
    if (timer) clearTimeout(timer);
    if (stream) { try { stream.end(); } catch { /* ended */ } }
    if (typeof onExit === 'function') {
      try { onExit({ code, signal, timedOut }); } catch { /* a listener must not break exit */ }
    }
  };

  // Same ceiling as the local background backend, and for the same reason: a
  // hung remote holds its slot until the ssh client dies, and the reconcile loop
  // rightly keeps reporting `running` while that pid is alive. Killing the ssh
  // client closes the channel, which is what actually stops the remote command.
  let grace = null;
  let timer = null;
  if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
    timer = setTimeout(() => {
      timedOut = true;
      try { fs.appendFileSync(logFile, `[hud] timed out after ${timeoutMs}ms; closing ssh channel\n`); } catch { /* log gone */ }
      try { child.kill('SIGTERM'); } catch { /* already gone */ }
      grace = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* already gone */ }
      }, graceMs);
      grace.unref?.();
    }, timeoutMs);
    timer.unref?.();
  }

  child.on('exit', finish);
  child.on('error', (error) => {
    // execFile-style failures (ssh missing, auth refused) surface here before
    // any exit code exists, and must not be silent.
    if (logFile) {
      try { fs.appendFileSync(logFile, `[hud] ssh failed to start: ${error.message}\n`); } catch { /* gone */ }
    }
    finish(255, null);
  });

  return { pid: child.pid, unref: () => { try { child.unref(); } catch { /* gone */ } } };
}

/** Terminate the ssh client, which closes the channel and SIGHUPs the peer. */
function kill(pid, signal = 'SIGTERM') {
  const target = Number(pid);
  if (!Number.isInteger(target) || target <= 1) throw new Error(`refusing to signal pid ${pid}`);
  try { process.kill(-target, signal); } catch { process.kill(target, signal); }
  return true;
}

const isAlive = (pid) => {
  const target = Number(pid);
  if (!Number.isInteger(target) || target <= 1) return false;
  try { process.kill(target, 0); return true; } catch (error) { return error.code === 'EPERM'; }
};

/** Cheap reachability probe, used by health rather than on the spawn path. */
async function probe(peer, options = {}) {
  const args = ['-o', 'BatchMode=yes', '-o', `ConnectTimeout=${options.timeoutSec || 6}`,
    '-o', 'StrictHostKeyChecking=yes', peer.sshHost, 'true'];
  return new Promise((resolve) => {
    const child = spawnProcess('ssh', args, { stdio: 'ignore' });
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, (options.timeoutSec || 6) * 1000 + 2000);
    child.on('exit', (code) => { clearTimeout(timer); resolve({ ok: code === 0, code }); });
    child.on('error', () => { clearTimeout(timer); resolve({ ok: false, code: null }); });
  });
}

module.exports = {
  REMOTE_RUNNER,
  shellQuote,
  probePeerPath,
  resetPathCache,
  DEFAULT_SSH,
  loadPeers,
  resetCache,
  listPeers,
  getPeer,
  validateForPeer,
  spawn,
  kill,
  isAlive,
  probe,
};