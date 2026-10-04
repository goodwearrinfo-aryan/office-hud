'use strict';
// Truthful process records for the HUD.
//
// This lives in its own module rather than inside server/index.js on purpose.
// The HUD's process view has twice been refactored back into a form that
// reported a frozen file as live state: hive/processes.json has no writer, and
// when it is read directly the HUD served 82 records of which 78 PIDs had
// exited, with nothing in the payload to say so. A change to index.js can
// silently remove a guard written there; it cannot remove a module plus the
// tests that import it.
//
// Two rules, and nothing else:
//   1. a process is only called RUNNING while a live source supports it, and
//   2. a command line never carries a credential-looking value in its payload.

// Credential-shaped names only. Masking on "any long value" would redact pids
// and paths and make the process view useless for its actual job.
const SECRET_ARG_NAME = '(?:api[-_]?key|apikey|secret|token|password|passwd|passphrase|private[-_]?key|access[-_]?key|auth|bearer|session[-_]?key)';

const REDACTED = '***';

// The terminal collector rewrites terminals.json every 60s. Five minutes is
// generous; it exists to catch a collector that stops, not to flag jitter.
const PROCESS_STALE_AFTER_S = 300;

function redactCommand(command) {
  // Return non-strings untouched: masking a value must not change the SHAPE of
  // the payload. A record with no `command` key has none, and inventing
  // `command: ''` asserts an empty command line that does not exist.
  if (typeof command !== 'string' || !command) return command;
  return command
    .replace(new RegExp(`(--?${SECRET_ARG_NAME})[= ]([^\\s"']+)`, 'gi'), `$1=${REDACTED}`)
    .replace(new RegExp(`\\b([A-Z][A-Z0-9_]*${SECRET_ARG_NAME}[A-Z0-9_]*)=([^\\s"']+)`, 'gi'), `$1=${REDACTED}`)
    .replace(/(Authorization:\s*Bearer\s+)\S+/gi, `$1${REDACTED}`);
}

function redactRecord(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return record;
  const out = { ...record };
  for (const field of ['command', 'args', 'cmdline']) {
    if (typeof out[field] === 'string') out[field] = redactCommand(out[field]);
    else if (Array.isArray(out[field])) out[field] = out[field].map(redactCommand);
  }
  return out;
}

/** Age of an ISO observation, or null when it cannot be measured. */
function observationAgeSeconds(iso, now = Date.now()) {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.round((now - t) / 1000));
}

/**
 * Turn a process collection into something the HUD may present as fact.
 *
 * `live` is what the caller actually has: an object with a processes array and
 * a collected_at, or a frozen cache. The result always says which, how old, and
 * whether that age supports a RUNNING claim.
 */
function processView(entry, options = {}) {
  const staleAfterS = options.staleAfterSeconds ?? PROCESS_STALE_AFTER_S;
  const now = options.now ?? Date.now();
  const records = (entry && entry.processes) || [];
  const age = observationAgeSeconds(entry && entry.collected_at, now);
  // No measurable age is not a fresh observation. Reporting an unknown age as
  // live is the same error as reading a frozen file.
  const stale = age === null || age > staleAfterS;

  return {
    processes: records.map((raw) => {
      const p = redactRecord(raw);
      return {
        ...p,
        status: stale ? 'STALE' : (p.status || 'UNKNOWN'),
        stored_status: p.status || null,
        observation_age_seconds: age,
      };
    }),
    collected_at: (entry && entry.collected_at) || null,
    observation_age_seconds: age,
    observation_source: (entry && entry.source) || null,
    live: !!(entry && entry.live),
    stale,
    stale_after_seconds: staleAfterS,
  };
}

module.exports = {
  PROCESS_STALE_AFTER_S,
  REDACTED,
  SECRET_ARG_NAME,
  observationAgeSeconds,
  processView,
  redactCommand,
  redactRecord,
};
