'use strict';
// Why the HUD can or cannot start a terminal on this machine.
//
// WHY THIS EXISTS
// ---------------
// The terminal allowlist is read from `hive/terminal_allowlist.json`, a file that
// travels between machines because it lives in the hive, and the hive is synced.
// Its `cwdPrefixes` are absolute paths on whichever machine wrote them.
//
// On the mini that file names `/Users/aryanagarwal` -- a laptop path, on a host
// whose home is `/Users/a`. Every cwd is therefore outside the allowed trees and
// every spawn is refused.
//
// That is FAIL-CLOSED and correct, and it is also how the mini has been running
// this whole time, so nothing broke. But from the HUD it was indistinguishable
// from "terminals are disabled": both look like a spawn that does nothing. The
// difference matters, because one is fixed by editing one line of a data file and
// the other is fixed by a policy decision.
//
// So the audit reports three separate things, and never conflates them:
//   - whether a policy file was found at all
//   - which trees it permits, and whether each one exists on THIS machine
//   - what follows from that, in words
//
// It loosens nothing. It reads the policy and the filesystem.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TERMINAL_POLICY_FILE = 'terminal_allowlist.json';

/** Locate the hive the same way the rest of the server does. */
function resolveHive() {
  return process.env.OFFICE_HUD_HIVE
    || path.join(os.homedir(), 'openalice-fleet', 'hive');
}

/**
 * A read-only account of what the terminal policy permits here.
 *
 * `effect` is the only field a UI should branch on, and it has exactly four
 * values so no caller has to re-derive the reasoning:
 *
 *   permitted            policy found, every tree exists here
 *   partial              policy found, some permitted trees do not exist here --
 *                        usually a policy that travelled from another machine
 *   none_permitted       policy found and NONE of its trees exist here
 *   no_policy_file       no file at all, so the built-in default applies
 */
function spawnPolicyAudit(hiveOverride) {
  const hive = hiveOverride || resolveHive();
  const policyPath = path.join(hive, TERMINAL_POLICY_FILE);

  if (!fs.existsSync(policyPath)) {
    return {
      source: 'built-in default (no policy file)',
      policy_path: policyPath,
      policy_file_present: false,
      this_machine: os.hostname(),
      home: os.homedir(),
      permitted_trees: [],
      missing_trees: [],
      effect: 'no_policy_file',
      summary:
        `No ${TERMINAL_POLICY_FILE} in the hive, so the built-in default applies: a terminal may `
        + 'only be started under this machine\'s own home directory.',
    };
  }

  let parsed = null;
  let readError = null;
  try {
    parsed = JSON.parse(fs.readFileSync(policyPath, 'utf8'));
  } catch (error) {
    readError = error.message || String(error);
  }

  if (!parsed || typeof parsed !== 'object') {
    return {
      source: policyPath,
      policy_path: policyPath,
      policy_file_present: true,
      readable: false,
      error: readError || 'policy file did not parse as an object',
      this_machine: os.hostname(),
      home: os.homedir(),
      permitted_trees: [],
      missing_trees: [],
      effect: 'unreadable_policy',
      summary:
        'The terminal policy file exists but could not be read, so nothing can be validated '
        + 'against it and every spawn is refused.',
    };
  }

  const permitted = Array.isArray(parsed.cwdPrefixes) ? parsed.cwdPrefixes : [];
  const missing = permitted.filter((p) => !fs.existsSync(p));
  // A path under this machine's own home is the common, intended case. Anything
  // else is worth naming: it usually means the file was written elsewhere.
  const foreign = permitted.filter((p) => !p.startsWith(os.homedir()) && fs.existsSync(p));

  let effect = 'permitted';
  if (permitted.length > 0 && missing.length === permitted.length) effect = 'none_permitted';
  else if (missing.length > 0) effect = 'partial';

  let summary;
  if (effect === 'permitted') {
    summary = `Terminals may be started under ${permitted.join(', ')}.`;
  } else if (effect === 'partial') {
    summary =
      `The policy permits ${permitted.length} tree(s) but ${missing.length} do not exist on this `
      + `machine (${os.hostname()}): ${missing.join(', ')}. Spawns under a missing tree are refused.`;
  } else {
    summary =
      `The policy permits ${permitted.length} tree(s) and NONE of them exist on this machine `
      + `(${os.hostname()}, home ${os.homedir()}): ${permitted.join(', ')}. This is fail-closed and `
      + 'usually means the policy file was written on a different machine and synced here. No '
      + 'terminal can be started until it names a tree that exists here.';
  }

  return {
    source: policyPath,
    policy_file_present: true,
    readable: true,
    this_machine: os.hostname(),
    home: os.homedir(),
    permitted_trees: permitted,
    missing_trees: missing,
    // Named separately from `missing_trees`: a tree that exists but is not under
    // this machine's home is legal and probably intentional, whereas a missing one
    // is nearly always a copy artefact.
    foreign_trees: foreign,
    effect,
    summary,
  };
}

module.exports = { spawnPolicyAudit, TERMINAL_POLICY_FILE };