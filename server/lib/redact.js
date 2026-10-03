'use strict';
// Command lines are served by both /api/terminals and /api/processes, so a
// credential typed into a shell is one `curl` away from being broadcast to every
// browser that can reach the HUD. This module masks those before serving.
//
// The hard part is not masking, it is NOT over-masking. A redactor that eats
// `--port 4096`, `--verbose`, or `/Users/a/app.js` makes the terminal view
// useless, and a view nobody trusts is a view people route around. So the rule
// is narrow on purpose:
//
//   - Mask only when the token *looks* like a credential. That means either the
//     name matches a credential word (api_key, token, secret, password, ...), or
//     the value matches a known key shape (sk-..., nvapi-..., ghp_..., AKIA...).
//     A bare `--port 4096` is not a credential and survives untouched.
//
// Three shapes are handled, because shells accept all three:
//
//     --api-key=sk-abc123    ->  --api-key=***
//     --token xyz789         ->  --token=***
//     MY_SECRET=hunter2      ->  MY_SECRET=***
//
// The second form is normalised to `=` deliberately: the value is destroyed
// either way, and one consistent output shape is far easier to assert against
// than preserving whichever separator the user happened to type.

const MASK = '***';

// A credential-ish *name*. Matched case-insensitively against the flag or
// variable name, with `-`/`_` treated as equivalent so --api-key, --api_key and
// API_KEY all hit.
const SECRET_NAME = /(?:^|[^a-z0-9])(?:api[-_]?key|apikey|access[-_]?key|secret[-_]?key|secret|token|password|passwd|pwd|auth[-_]?token|bearer|credential|private[-_]?key|session[-_]?key)(?:[^a-z0-9]|$)/i;

// A credential-ish *value*, for the case where the name is innocuous but the
// value is unmistakably a key. Longest-first so AKIA wins over a shorter match.
const SECRET_VALUE = [
  /nvapi-[A-Za-z0-9_-]{16,}/g,
  /\bsk-[A-Za-z0-9_-]{12,}/g,
  /\bsk_live_[A-Za-z0-9]{12,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{16,}/g,
  /\bAKIA[0-9A-Z]{12,}\b/g,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/g,
  /-----BEGIN[A-Z ]*PRIVATE KEY-----[\s\S]*?-----END[A-Z ]*PRIVATE KEY-----/g,
];

/** True when `name` reads like a credential rather than an ordinary flag. */
function isSecretName(name) {
  return SECRET_NAME.test(String(name));
}

/**
 * Redact one command line.
 *
 * Two passes rather than one, because a single combined pattern is a trap: on
 * `zsh --api-key=sk-abc123` a naive `(\w+)(\s+)(\S+)` happily matches the WHOLE
 * line as name=`zsh`, sep=space, value=`--api-key=sk-abc123`, sees a
 * non-secret name, and returns it untouched — silently leaking the key while
 * looking like it worked. Anchoring each pass to its own separator avoids that.
 *
 * @param {string} command
 * @returns {string} the command with credential values replaced by ***
 */
function redactCommand(command) {
  if (typeof command !== 'string' || command.length === 0) return command;

  // Pass 1: assignment form, where the name sits directly against the `=`.
  // Covers `--api-key=sk-abc123` and `MY_SECRET=hunter2`.
  let out = command.replace(
    /(\b[A-Za-z_][A-Za-z0-9_.-]*)=("[^"]*"|'[^']*'|\S+)/g,
    (match, name, value) => {
      if (!isSecretName(name)) return match;
      const quoted = /^(["'])([\s\S]*)["']$/.exec(value);
      return quoted ? `${name}=${quoted[1]}${MASK}${quoted[1]}` : `${name}=${MASK}`;
    },
  );

  // Pass 2: the space-separated flag form, `--token xyz789`. Required to start
  // with `--` so ordinary positionals are never treated as flag/value pairs.
  // The separator is normalised to `=` (see the note at the top of this file).
  out = out.replace(
    /(--[A-Za-z0-9_.-]+)(\s+)("[^"]*"|'[^']*'|\S+)/g,
    (match, flag, gap, value) => {
      if (!isSecretName(flag)) return match;
      const quoted = /^(["'])([\s\S]*)["']$/.exec(value);
      const shown = flag;
      return quoted ? `${shown}=${quoted[1]}${MASK}${quoted[1]}` : `${shown}=${MASK}`;
    },
  );

  // Pass 3: a value that is unmistakably a key, even under an innocent name.
  // Runs last so an already-masked token is not re-matched, and so the name-based
  // passes above have already dealt with anything they claimed.
  for (const pattern of SECRET_VALUE) {
    out = out.replace(pattern, MASK);
  }

  return out;
}

/**
 * Redact an argv-style array.
 *
 * Elements cannot be redacted one at a time, because a flag and its value are
 * two separate elements: `['--api-key', 'sk-abc123']`. Mapping each element on
 * its own leaves the secret completely untouched — the flag alone has no value
 * to mask and the value alone has no name to justify it. So the array is walked
 * as a sequence, and a credential-named flag consumes the element after it.
 *
 * The value element is masked in place rather than joined onto the flag, so the
 * list keeps its positional meaning: ['--port','4096','--api-key','***'].
 */
function redactArgv(argv) {
  const out = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (typeof arg !== 'string') { out.push(arg); continue; }

    // A `--name=value` element is self-contained and handled normally.
    if (/^--?[A-Za-z0-9_.-]*=/.test(arg)) { out.push(redactCommand(arg)); continue; }

    if (/^--?[A-Za-z0-9_.-]+$/.test(arg) && isSecretName(arg) && i + 1 < argv.length) {
      out.push(arg, MASK);
      i += 1; // consume the value element so it is never emitted
      continue;
    }
    out.push(redactCommand(arg));
  }
  return out;
}

/**
 * Redact every credential-bearing field on a process/terminal-shaped object, in
 * place. Non-objects and absent fields are left exactly as they were.
 */
function redactEntry(entry) {
  if (!entry || typeof entry !== 'object') return entry;
  if (typeof entry.command === 'string') entry.command = redactCommand(entry.command);
  // Some collectors spell it `cmd` or `args`; a leaked argv is the same leak.
  if (typeof entry.cmd === 'string') entry.cmd = redactCommand(entry.cmd);
  if (Array.isArray(entry.args)) entry.args = redactArgv(entry.args);
  return entry;
}

/** Redact an array of entries, preserving order and non-entry values. */
function redactAll(entries) {
  if (!Array.isArray(entries)) return entries;
  return entries.map((entry) => redactEntry(entry));
}

module.exports = {
  redactCommand,
  redactEntry,
  redactAll,
  redactArgv,
  isSecretName,
  MASK,
  SECRET_NAME,
  SECRET_VALUE,
};