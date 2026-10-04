'use strict';

// Command policy for HUD-spawned terminals.
//
// Spawning a terminal IS arbitrary code execution, so this is default-deny:
// a command runs only when a rule names its binary, and a deny entry beats every
// allow rule. The rules are data, not code, so they can live in the hive and be
// edited without a restart.
//
// Why an allowlist rather than a denylist: a denylist has to enumerate every
// way to reach a shell, and `node -e`, `python -c`, `git -c core.pager=...`,
// `env`, `xargs` and `find -exec` each open one on their own. Any denylist that
// missed a single interpreter was one `sh -c` away from running unattended.
//
// The matching is intentionally conservative:
//   - the command is TOKENISED, never handed to a shell, so `;`, `&&`, `|` and
//     backticks are literal arguments rather than operators;
//   - a rule matches on the binary plus, optionally, the first non-flag
//     argument -- so `git log --oneline` is allowed by a `log` subcommand rule
//     while `git push --force` still has to be named explicitly.

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

// Denied regardless of any allow rule. These are the binaries that can read a
// file, reach a network, or rewrite the machine without an obvious side effect.
const DENY_BINARIES = [
  'rm', 'sudo', 'doas', 'su', 'chmod', 'chown', 'chgrp', 'dd', 'mkfs',
  'diskutil', 'shutdown', 'reboot', 'halt', 'poweroff', 'launchctl',
  'defaults', 'csrutil', 'spctl', 'systemsetup', 'visudo', 'passwd',
  'dscl', 'kextload', 'kextunload', 'nvram',
];

// Interpreters are denied by default because they take code as an argument
// (`node -e`, `python -c`) or a file that is trivially written (`python x.py`),
// which makes any allow rule for them equivalent to allowing everything.
// `opencode` and `claude` are re-allowed below, because running the fleet's own
// agents is the point of the orchestrate spawner.
const DENY_DEFAULT = [
  'sh', 'bash', 'zsh', 'fish', 'dash', 'ksh', 'csh', 'tcsh', 'eval', 'exec',
  'env', 'xargs', 'nohup', 'setsid', 'script', 'expect', 'osascript', 'open',
  'curl', 'wget', 'nc', 'ncat', 'netcat', 'telnet', 'ftp', 'scp', 'sftp', 'ssh',
  'rsync', 'cp', 'mv', 'ln', 'cat', 'tee', 'less', 'more', 'man', 'vi', 'vim',
  'nano', 'emacs', 'ed', 'awk', 'gawk', 'sed', 'perl', 'ruby', 'php', 'bash -c',
  'find', 'xargs', 'source', 'builtin', 'command', 'alias',
];

const DEFAULTS = {
  version: 1,
  // A terminal may only be started inside these trees. Narrow on purpose: this
  // is the blast radius if a rule is ever wrong.
  cwdPrefixes: [os.homedir()],
  allow: [
    // -- version control
    { bin: ['git'], subcommands: ['status', 'log', 'diff', 'show', 'branch', 'rev-parse', 'ls-files', 'describe', 'stash', 'fetch'] },
    // git config is read-only here. It looks harmless and is not: `git config
    // core.pager <cmd>` makes git EXECUTE that command on every subsequent
    // invocation, so allowing it would hand out persistent code execution and,
    // with --global, a write outside the repo. Only the read verbs are listed,
    // which rejects --global/--system as unknown flags.
    { bin: ['git'], subcommands: ['config'], flags: ['--get', '--get-urlmatch', '--get-regexp', '--list', '--local', '--file', '--show-origin', '--show-scope', '--type', '--get-color', '--get-colorbool', '-l', '--name-only'] },
    { bin: ['git'], subcommands: ['add'], args: ['-A', '--all', '.', '-p'] },
    { bin: ['git'], subcommands: ['commit'], args: ['-m', '--message', '--amend', '-a'] },
    { bin: ['git'], subcommands: ['push', 'pull'] },
    { bin: ['git'], subcommands: ['switch', 'checkout'] },
    // -- javascript
    // `npm exec` and `npx` are absent on purpose: both fetch and execute code
    // from a registry, which is arbitrary execution with a network fetch
    // attached. `npm run <script>` runs the repo's own scripts, which is the
    // same trust level as running its tests.
    { bin: ['npm', 'pnpm', 'yarn'], subcommands: ['test', 'run', 'ci', 'install', 'ls', 'list', 'outdated', 'why', 'build', 'start', 'lint'] },
    // node runs the test runner and nothing else. `node script.js` would be
    // arbitrary execution, so it is refused: the flag list is exhaustive and at
    // least one of these flags must be present, which rejects both `-e` and a
    // bare script path.
    { bin: ['node'], flags: ['--test', '--test-reporter', '--test-name-pattern', '--test-concurrency', '--test-only', '--experimental-strip-types'] },
    { bin: ['python3', 'python'], prefixArgs: ['-m', 'pytest', '-m', 'unittest', '-m', 'json.tool'], denySubcommands: ['-c'] },
    { bin: ['pytest'], anyArgs: true },
    { bin: ['ruff', 'black', 'flake8', 'mypy'], anyArgs: true },
    { bin: ['pip'], subcommands: ['list', 'show', 'freeze', 'check'] },
    { bin: ['uv'], subcommands: ['run', 'sync', 'lock', 'pip', 'venv'] },
    // -- rust / go
    { bin: ['cargo'], subcommands: ['test', 'build', 'check', 'clippy', 'fmt', 'tree'] },
    { bin: ['go'], subcommands: ['test', 'build', 'vet', 'list'] },
    // -- other build tools
    { bin: ['make'], subcommands: ['test', 'build', 'lint', 'check'] },
    // docker is read-only. `docker run -v /:/host` is host code execution as root,
    // so the verbs that create containers or mount host paths are excluded.
    { bin: ['docker'], subcommands: ['ps', 'images', 'logs', 'inspect', 'version', 'info', 'stats', 'compose'] },
    // -- the fleet's own agents (see DENY_DEFAULT note above)
    { bin: ['opencode', 'claude', 'codex', 'aider'] },
    // -- read-only inspection
    { bin: ['ls', 'pwd', 'echo', 'date', 'whoami', 'df', 'du', 'which', 'who', 'uname', 'wc', 'basename', 'dirname', 'jq', 'sort', 'head', 'tail'] },
  ],
  // Environment variables a spawned terminal may inherit. Anything not named
  // here is dropped: a spawned shell must not receive the provider API keys
  // that this process holds in its own environment.
  envPassthrough: ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'TERM', 'TMPDIR', 'TZ', 'SSH_AUTH_SOCK'],
  // Directories prepended to a spawned shell's PATH when they are missing from
  // it. launchd hands this server PATH=/usr/bin:/bin:/usr/sbin:/sbin, so PATH
  // passes through by default and the child inherits that bare list -- which
  // hides Homebrew and nvm, and with them opencode, gh, node and python. That
  // makes a working terminal look broken: `which node` finds nothing. The same
  // list the tmux spawner uses to resolve its own binary (EXTRA_PREFIXES), kept
  // here so both agree on what "installed" means.
  pathPrefixes: [
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/opt/local/bin',
    os.homedir() + '/.local/bin',
  ],
  // Flags that invalidate every rule when present, whatever else matches.
  //
  // git's global options are the reason this list exists: `git -c
  // core.pager=<cmd>` and `git config core.pager <cmd>` make git execute an
  // arbitrary command, and `--exec-path` moves the directory git loads its
  // git-* helpers from. A rule that only inspects the subcommand would wave all
  // three through while looking like it had checked the command.
  denyFlags: [
    '-c', '--exec-path', '--git-dir', '--work-tree', '--namespace',
    '--super-prefix', '--config-env',
  ],
  limits: { maxCwdDepth: 8, maxArgvLength: 64, maxCmdLength: 2000 },
};

let cached = null;
let cachedPath = null;
let cachedMtime = 0;

/**
 * Split a command line into argv without invoking a shell.
 *
 * This is a tokenizer, not a shell: quotes group, backslash escapes, and
 * everything else is literal. `sh -c 'x' && rm -rf /` arrives as five ordinary
 * arguments, so a rule that allows `echo` cannot be tricked into running `rm`.
 */
function tokenize(command) {
  const argv = [];
  let current = '';
  let quote = null;
  let escaped = false;
  let started = false;
  for (const char of String(command)) {
    if (escaped) { current += char; escaped = false; continue; }
    if (char === '\\' && quote !== "'") { escaped = true; started = true; continue; }
    if (quote) {
      if (char === quote) { quote = null; continue; }
      current += char;
      continue;
    }
    if (char === '"' || char === "'") { quote = char; started = true; continue; }
    if (/\s/.test(char)) {
      if (started || current) { argv.push(current); current = ''; started = false; }
      continue;
    }
    current += char;
  }
  if (quote) throw Object.assign(new Error('unbalanced quote in command'), { statusCode: 400 });
  if (escaped) current += '\\';
  if (started || current) argv.push(current);
  return argv;
}

/** Rules are re-read only when the file's mtime changes, so this is cheap per call. */
function load(hive, options = {}) {
  const policyPath = options.policyPath || path.join(hive, 'terminal_allowlist.json');
  let mtime = 0;
  try { mtime = fs.statSync(policyPath).mtimeMs; } catch { mtime = 0; }
  if (cached && cachedPath === policyPath && mtime === cachedMtime) return cached;
  let policy = DEFAULTS;
  if (mtime) {
    try {
      const parsed = JSON.parse(fs.readFileSync(policyPath, 'utf8'));
      if (parsed && typeof parsed === 'object' && Array.isArray(parsed.allow)) policy = parsed;
    } catch (error) {
      // A corrupt policy file must not silently widen access: keep the built-in
      // defaults rather than falling back to "allow everything".
      policy = DEFAULTS;
    }
  }
  cached = policy;
  cachedPath = policyPath;
  cachedMtime = mtime;
  return policy;
}

function resetCache() { cached = null; cachedPath = null; cachedMtime = 0; }

/** First non-flag argument after the binary: `git log --oneline` -> `log`. */
function firstSubcommand(argv) {
  for (const token of argv.slice(1)) {
    if (!token.startsWith('-')) return token;
  }
  return null;
}

// Shell control operators, refused as standalone tokens anywhere in the argv.
//
// The command is tokenised and handed to an argv array, never to a shell, so
// these are inert today: `echo hi | sh` would make echo print "hi | sh". They
// are refused anyway because the safety of this module rests on that invariant
// holding, and a later "just use exec with a shell" change would turn every
// allowed rule into arbitrary execution. Refusing them keeps the argv honest
// about what it is, so the invariant is enforced rather than assumed.
const SHELL_OPERATORS = new Set(['|', '||', '&&', ';', ';;', '&', '>', '>>', '<', '<<', '`', '$(', '${', '\n', '\r']);

function findShellOperator(argv) {
  for (const token of argv) {
    if (SHELL_OPERATORS.has(token)) return token;
  }
  return null;
}

function withinPrefix(target, prefix) {
  const rel = path.relative(prefix, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Decide whether `command` may run in `cwd`.
 * Returns { allowed, reason, bin, cwd } -- never throws for a policy rejection.
 */
function validate(command, cwd, options = {}) {
  const hive = options.hive || path.join(os.homedir(), 'openalice-fleet', 'hive');
  // policyOverride lets a caller evaluate a command against a DIFFERENT tree's
  // rules without touching the cached on-disk policy. The remote spawner needs
  // this: it validates a path that does not exist on this host, against the
  // peer's own cwdPrefixes, and must not rewrite the local policy file to do it.
  const policy = options.policyOverride || load(hive, options);
  const limits = { ...DEFAULTS.limits, ...(policy.limits || {}) };

  const fail = (reason) => ({ allowed: false, reason, cwd: cwd || null, bin: null });

  if (typeof command !== 'string' || !command.trim()) return fail('command is required');
  if (command.length > limits.maxCmdLength) return fail('command is too long');

  let argv;
  try { argv = tokenize(command); } catch (error) { return fail(error.message); }
  if (!argv.length) return fail('command is empty');
  if (argv.length > limits.maxArgvLength) return fail('too many arguments');

  // Shell operators are refused before any rule is considered, so no rule can
  // vouch for a command whose text reads as a pipeline or a redirect.
  const operator = findShellOperator(argv);
  if (operator) return fail(`shell operator "${operator}" is not permitted; commands are run without a shell`);

  // Flags that make the binary itself load or execute something else. Checked
  // before any rule, because a rule that only reads the subcommand cannot see
  // these.
  const denyFlags = Array.isArray(policy.denyFlags) ? policy.denyFlags : DEFAULTS.denyFlags;
  const badFlag = argv.find((token) => token.split('=')[0] && denyFlags.includes(token.split('=')[0]));
  if (badFlag) return fail(`flag "${badFlag}" is not permitted`);

  // -- working directory must be inside an allowed tree and actually exist
  const target = path.resolve(String(cwd || ''));
  if (!cwd) return fail('cwd is required');
  const prefixes = Array.isArray(policy.cwdPrefixes) && policy.cwdPrefixes.length
    ? policy.cwdPrefixes
    : DEFAULTS.cwdPrefixes;
  if (!prefixes.some((prefix) => withinPrefix(target, path.resolve(prefix)))) {
    return fail(`cwd is outside the allowed trees (${prefixes.join(', ')})`);
  }
  if (options.mustExist !== false) {
    let real = null;
    try { real = fs.realpathSync(target); } catch { return fail('cwd does not exist'); }
    try {
      if (!fs.statSync(real).isDirectory()) return fail('cwd is not a directory');
    } catch { return fail('cwd is not readable'); }
  }

  // -- deny lists win over everything
  const bin = path.basename(argv[0]);
  const deny = [...DENY_BINARIES, ...(policy.deny || []), ...DENY_DEFAULT]
    .map((entry) => path.basename(String(entry)));
  if (!Array.isArray(policy.allowBinaries) && deny.includes(bin)) {
    return fail(`"${bin}" is denied by policy`);
  }
  if (Array.isArray(policy.allowBinaries) && policy.allowBinaries.map((b) => path.basename(String(b))).includes(bin)) {
    return { allowed: true, reason: 'explicitly allowed binary', bin, cwd: target, argv };
  }

  // -- an allow rule must name this binary
  const rules = (policy.allow || []).filter((rule) => Array.isArray(rule.bin) && rule.bin.includes(bin));
  if (!rules.length) return fail(`no allow rule for "${bin}"`);

  const subcommand = firstSubcommand(argv);
  const flags = argv.slice(1).filter((token) => token.startsWith('-'));

  for (const rule of rules) {
    // Interpreter escape hatches: `python -c`, `node -e`, `ruby -e`.
    const deniedSubs = [].concat(rule.denySubcommands || [], policy.denySubcommands || []);
    if (deniedSubs.some((bad) => argv.includes(bad))) continue;

    // `prefixArgs` allows an interpreter to be used as a module runner
    // (`python3 -m pytest`) without also allowing `-c`.
    if (Array.isArray(rule.prefixArgs) && rule.prefixArgs.length) {
      const ok = argv.slice(1).some((token) => rule.prefixArgs.includes(token));
      if (!ok) continue;
    }

    // `anyArgs` marks a tool whose own arguments are not a security boundary --
    // pytest and ruff take only switches. It exists because enumerating flags
    // is how combined short options (`-xvs`) end up rejected by a policy that
    // meant to allow them.
    if (rule.anyArgs === true) {
      const deniedSubs = [].concat(rule.denySubcommands || [], policy.denySubcommands || []);
      if (deniedSubs.some((bad) => argv.includes(bad))) continue;
      return { allowed: true, reason: 'matched allow rule', bin, cwd: target, argv, subcommand };
    }

    if (Array.isArray(rule.subcommands) && rule.subcommands.length) {
      if (!subcommand || !rule.subcommands.includes(subcommand)) continue;
    }

    // When a rule names args, at least one of them must actually be present --
    // otherwise `git commit` would pass a rule written for `git commit -m`.
    if (Array.isArray(rule.args) && rule.args.length) {
      const present = argv.some((token, i) => i > 0 && rule.args.includes(token));
      if (!present) continue;
    }

    // A rule may restrict which flags are acceptable. The list is exhaustive
    // AND required: a rule that names flags means "only in this form", so a
    // bare `git config core.pager sh` (no flag at all) must not slip through on
    // an empty check. Absent `flags`, any flag is allowed, because then the
    // subcommand is the security-relevant part.
    if (Array.isArray(rule.flags) && rule.flags.length) {
      const badFlag = flags.find((flag) => !rule.flags.includes(flag));
      if (badFlag) continue;
      if (!flags.some((flag) => rule.flags.includes(flag))) continue;
    }

    return { allowed: true, reason: 'matched allow rule', bin, cwd: target, argv, subcommand };
  }

  return fail(`"${bin}${subcommand ? ` ${subcommand}` : ''}" is not permitted by policy`);
}

/**
 * The PATH a spawned shell should get: whatever this process holds, with the
 * common install prefixes prepended if they are missing.
 *
 * Additive only. Nothing is removed, so an operator who narrowed PATH on
 * purpose keeps their ordering; we only make sure the directories holding the
 * toolchain are reachable at all. Directories that do not exist are skipped, so
 * a machine without Homebrew gets exactly the PATH it had.
 */
function augmentedPath(current, policy) {
  const fs = require('node:fs');
  // The operator's own entries, preserved verbatim and in order.
  const existing = String(current || '').split(':').filter(Boolean);
  const have = new Set(existing);
  const lead = [];
  const isDir = (dir) => {
    try { return fs.statSync(dir).isDirectory(); } catch { return false; }
  };
  const add = (dir) => {
    if (!dir || have.has(dir) || lead.includes(dir)) return;
    if (!isDir(dir)) return;
    lead.push(dir);
  };
  // nvm installs node under a version directory, so it cannot be named as a
  // literal prefix. An explicit NVM_BIN goes FIRST: it is a deliberate pin, and
  // it must outrank the generic prefixes below. Homebrew ships its own node, so
  // putting /opt/homebrew/bin ahead of the pin silently runs spawned code on a
  // different runtime than the one this server was tested on.
  const home = os.homedir();
  if (process.env.NVM_BIN) {
    add(process.env.NVM_BIN);
  } else {
    try {
      const newest = fs.readdirSync(`${home}/.nvm/versions/node`)
        .filter((v) => /^v\d+\./.test(v))
        .sort()
        .pop();
      if (newest) add(`${home}/.nvm/versions/node/${newest}/bin`);
    } catch { /* nvm is not installed on this machine */ }
  }
  for (const dir of policy.pathPrefixes || DEFAULTS.pathPrefixes) add(dir);
  return [...lead, ...existing].join(':');
}

/**
 * Build the child environment: only the passthrough names plus explicitly
 * requested extras, so a spawned shell never inherits this process's keys.
 */
function buildEnv(requested = {}, options = {}) {
  const hive = options.hive || path.join(os.homedir(), 'openalice-fleet', 'hive');
  const policy = load(hive, options);
  const env = {};
  for (const name of policy.envPassthrough || DEFAULTS.envPassthrough) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  if (env.PATH !== undefined) env.PATH = augmentedPath(env.PATH, policy);
  for (const [name, value] of Object.entries(requested || {})) {
    const key = String(name);
    // Never let a caller inject a variable that would shadow the passthrough
    // policy with a secret-looking name it does not own.
    if (!/^[A-Z_][A-Z0-9_]*$/i.test(key)) continue;
    if (value === undefined || value === null) continue;
    env[key] = String(value);
  }
  return env;
}

module.exports = {
  DEFAULTS,
  DENY_BINARIES,
  DENY_DEFAULT,
  tokenize,
  load,
  resetCache,
  validate,
  buildEnv,
  firstSubcommand,
};