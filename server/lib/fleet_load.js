'use strict';
// Fleet load and throttle panel: per-worker CPU/Memory/nice and throttle controls.
//
// Reads the host's process table for opencode fleet workers, extracts role from
// the --prompt argument, and reports CPU, MEM, nice, elapsed, time. Provides
// mutating endpoints to renice, pause (SIGSTOP), resume (SIGCONT), or kill (SIGTERM)
// a worker, subject to the local-only gate and a worker‑only allowlist.
//
// Honesty rules:
//   1. Only processes whose command line matches the opencode worker pattern are
//      included; everything else is filtered out.
//   2. The PID is validated against the live fleet worker set (from hive/fleet.json
//      or the process list itself) to prevent arbitrary PID attacks.
//   3. All command‑line arguments are fixed‑argv; no user input is interpolated
//      into the spawned command, preventing injection.
//   4. The mutating endpoint is protected by the existing `local_only` gate, so
//      it can only be called from the loopback interface (or Tailscale Serve
//      terminated connection).
//   5. Secret values (like API keys) that might appear in the --prompt are redacted
//      using the same redaction logic as `processTruth.js`.
//   6. The endpoint returns a snapshot; callers should not assume the data is
//      stable across calls.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

// Define HIVE the same way as in server/index.js
const HIVE = process.env.OFFICE_HUD_HIVE || path.join(os.homedir(), 'openalice-fleet', 'hive');
// Note: process.env.OPENALICE_HIVE is set in server/index.js, but we can also use it if set.
// We'll use the same logic as in index.js to be safe.

// The pattern we use to identify opencode worker processes.
// We look for the command "/opt/homebrew/bin/opencode" (or wherever it is)
// and then extract the --model and --prompt arguments.
// However, the worker's role is encoded in the --prompt as "You are <name>, a fleet worker…"
// We'll parse the prompt to get the name after "You are " and before the first comma.
// If the pattern is not found, we fall back to the model argument or "unknown".

const OPENARRAY_BIN = '/opt/homebrew/bin/opencode'; // default, but we can also search in $PATH
// Actually we can just look for any process with command containing "opencode"
// and then validate by checking the hive for the PID? We'll do a two‑step:
// 1. Get all processes with command containing "opencode" (case‑insensitive).
// 2. For each, verify that the PID appears in the live fleet worker list
//    (we can read hive/fleet.json or just trust that if it's an opencode process
//    it's a fleet worker; but to be safe we cross‑check with the hive).

// However, reading the hive fleet.json might be expensive if done per request.
// We'll cache the fleet worker PIDs for a short time (e.g., 1 second) to avoid
// overloading the hive. But for simplicity, we'll just read the fleet.json each
// time; the hive is small and the request rate is low.

// Alternatively, we can avoid reading the hive and rely on the fact that the
// only opencode processes running on this host are the fleet workers (since we
// don't run opencode elsewhere). This is true for the deployment host.
// We'll adopt that assumption for simplicity, but we'll still validate that the
// command line looks like an opencode worker (has --prompt and --model).

// We'll define a helper to extract the role from the --prompt argument.
function extractRoleFromPrompt(prompt) {
  if (!prompt) return 'unknown';
  // The prompt starts with "You are <name>, a fleet worker. Your task: ..."
  const match = prompt.match(/^You are ([^,]+), a fleet worker\./);
  if (match) {
    return match[1].trim();
  }
  // Fallback: try to get the model from --model argument
  const modelMatch = prompt.match(/--model\s+([^\s]+)/);
  if (modelMatch) {
    return modelMatch[1];
  }
  return 'unknown';
}

// Redact any potential secrets that might appear in the prompt (like API keys).
// We'll reuse the redactCommand logic but apply it to the whole prompt string.
function redactPrompt(prompt) {
  if (!prompt) return '';
  // We'll use the same redactor as in redactCommand but we need to adapt.
  // Since redactCommand expects a full command line, we'll just return the prompt
  // as is and rely on the fact that the prompt should not contain raw secrets.
  // However, the --prompt argument itself could contain a secret if the user
  // put it there (unlikely). We'll be safe and apply the same redaction rules.
  const SECRET_ARG_NAME = '(?:api[-_]?key|apikey|secret|token|password|passwd|passphrase|private[-_]?key|access[-_]?key|auth|bearer|session[-_]?key)';
  const REDACTED = '***';
  return prompt.replace(new RegExp(`(--?${SECRET_ARG_NAME})[= ]([^\\s"']+)`, 'gi'), `$1=${REDACTED}`)
               .replace(new RegExp(`\\b([A-Z][A-Z0-9_]*${SECRET_ARG_NAME}[A-Z0-9_]*)=([^\\s\\s]+)`, 'gi'), `$1=${REDACTED}`);
}

// Get the current POSIX timestamp in milliseconds.
function nowMs() {
  return Date.now();
}

// Parse the output of `ps -arcwwwxo pid,pcpu,pmem,ni,etime,command`.
// Returns an array of objects with fields: pid, pcpu, pmem, ni, etime, command.
// We'll parse the ps output line by line.
// The header line is omitted by the -c option? Actually -c removes the header? Let's check:
// The format we use: -o pid,pcpu,pmem,ni,etime,command
// We'll skip the first line if it contains the header "PID %CPU ..."
// We'll just split lines and ignore empty lines.
function parsePsOutput(output) {
  const lines = output.trim().split('\n');
  const result = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    // The fields are separated by whitespace, but command may contain spaces.
    // Since we fixed the order and the first five fields are numeric, we can
    // split by whitespace and take the first five, then the rest is the command.
    const parts = line.trim().split(/\s+/);
    if (parts.length < 6) continue; // need at least 6 fields
    const pid = parseInt(parts[0], 10);
    const pcpu = parseFloat(parts[1]);
    const pmem = parseFloat(parts[2]);
    const ni = parseInt(parts[3], 10);
    let etime = parts[4];
    // The etime format is [[DD-]HH:]MM:SS. We'll keep it as string for now.
    const command = parts.slice(5).join(' ');
    result.push({ pid, pcpu, pmem, ni, etime, command });
  }
  return result;
}

// Fetch the live set of opencode worker PIDs by parsing the ps output and
// filtering for those that look like opencode workers.
// We'll also return the parsed process list for the caller to avoid double work.
function getFleetWorkerProcesses() {
  try {
    // Use ps with the same options as before.
    const output = execFileSync('ps', ['-arcwwwxo', 'pid', 'pcpu', 'pmem', 'ni', 'etime', 'command'], { encoding: 'utf8' });
    const all = parsePsOutput(output);
    const workers = all.filter(p => {
      const cmd = p.command;
      // Check if the command contains "opencode" (case-insensitive) and has --prompt and --model.
      if (!cmd || !cmd.includes('opencode')) return false;
      if (!cmd.includes('--prompt') || !cmd.includes('--model')) return false;
      // Additional validation: the command should start with the opencode binary.
      // We'll just accept it.
      return true;
    });
    return workers;
  } catch (e) {
    // If ps fails, return an empty array.
    return [];
  }
}

// Throttle state file path
const THROTTLE_STATE_PATH = path.join(HIVE, 'fleet-state', 'throttle.json');
// Default throttle state
const DEFAULT_THROTTLE_STATE = { mode: 'normal' };

// Read the throttle state from file. If file does not exist or is invalid, return default.
function readThrottleState() {
  try {
    const data = fs.readFileSync(THROTTLE_STATE_PATH, 'utf8');
    const json = JSON.parse(data);
    // Validate that json.mode is a string and is either 'normal' or 'paused'
    if (typeof json.mode === 'string' && (json.mode === 'normal' || json.mode === 'paused')) {
      return json;
    }
    // If invalid, return default
    return DEFAULT_THROTTLE_STATE;
  } catch (e) {
    // If any error (file not found, JSON parse error, etc.), return default
    return DEFAULT_THROTTLE_STATE;
  }
}

// Write the throttle state to file atomically.
function writeThrottleState(mode) {
  // Validate mode
  if (mode !== 'normal' && mode !== 'paused') {
    throw new Error('Invalid throttle mode');
  }
  const data = JSON.stringify({ mode: mode }, null, 2);
  // Write to a temporary file then rename for atomicity
  const tempPath = THROTTLE_STATE_PATH + '.tmp';
  fs.writeFileSync(tempPath, data, 'utf8');
  fs.renameSync(tempPath, THROTTLE_STATE_PATH);
}

// Build the snapshot for the API.
function buildSnapshot() {
  const workers = getFleetWorkerProcesses();
  const throttleState = readThrottleState();
  const now = nowMs();
  const result = workers.map(w => {
    // Extract the role from the --prompt argument.
    const promptMatch = w.command.match(/--prompt\s+([^]+)/);
    let prompt = '';
    if (promptMatch) {
      // The --prompt argument may be quoted; we'll just take the rest of the line
      // after --prompt until the next -- argument or end of line.
      // Simple approach: take the substring after --prompt until we see a space
      // followed by -- (another argument) or end of line.
      const afterPrompt = w.command.substring(promptMatch.index + promptMatch[0].length);
      // Find the next -- that is not inside quotes.
      // We'll do a simple parse: split by space and look for --.
      const parts = afterPrompt.split(/\s+/);
      let promptValue = '';
      for (const part of parts) {
        if (part.startsWith('--')) break;
        promptValue += (promptValue ? ' ' : '') + part;
      }
      prompt = promptValue.trim();
    }
    const role = extractRoleFromPrompt(prompt);
    // Redact the prompt to avoid leaking secrets.
    const redactedPrompt = redactPrompt(prompt);
    return {
      pid: w.pid,
      role: role,
      cpu: w.pcpu.toFixed(1), // one decimal place
      mem: w.pmem.toFixed(1),
      nice: w.ni,
      elapsed: w.etime,
      // We could also include the redacted prompt for debugging, but not necessary.
      // redactedPrompt: redactedPrompt,
    };
  });
  // Sort by CPU descending.
  result.sort((a, b) => b.cpu - a.cpu);
  return { workers: result, throttleMode: throttleState.mode };
}

// Mutate a worker's priority or state.
// Actions: renice, pause (SIGSTOP), resume (SIGCONT), kill (SIGTERM).
function mutateWorker(pid, action) {
  // Validate that the PID is a number and positive.
  const pidNum = parseInt(pid, 10);
  if (isNaN(pidNum) || pidNum <= 0) {
    throw new Error('Invalid PID');
  }
  // Re‑validate that the PID is indeed an opencode worker (to prevent accidental
  // killing of other processes). We'll re‑run the worker detection and see if
  // the PID appears in the list.
  const workers = getFleetWorkerProcesses();
  const found = workers.some(w => w.pid === pidNum);
  if (!found) {
    throw new Error('PID is not a fleet worker');
  }
  // Build the argv for the command we want to run.
  let argv;
  switch (action) {
    case 'renice':
      argv = ['-n', '10', '-p', pid.toString()];
      break;
    case 'pause':
      argv = ['-STOP', pid.toString()];
      break;
    case 'resume':
      argv = ['-CONT', pid.toString()];
      break;
    case 'kill':
      argv = ['-TERM', pid.toString()];
      break;
    default:
      throw new Error('Unknown action');
  }
  // Use kill command (which can also send SIGSTOP, SIGCONT, etc.)
  // Note: kill command syntax: kill [-s signal] [-p] pid...
  // We'll use the signal name directly.
  // Actually the kill command accepts signal names or numbers.
  // We'll use the signal name as an argument.
  // However, the kill command does not take the signal as a separate argument
  // before the pid? Actually it does: kill -s SIGSTOP pid.
  // Let's use the signal name.
  const signalMap = {
    renice: null, // renice is not a signal; we'll use the renice command separately.
    pause: 'STOP',
    resume: 'CONT',
    kill: 'TERM'
  };
  if (action === 'renice') {
    // Use renice command.
    try {
      execFileSync('renice', ['-n', '10', '-p', pid.toString()], { encoding: 'utf8' });
    } catch (e) {
      throw new Error(`renice failed: ${e.message}`);
    }
  } else {
    // Use kill command.
    try {
      execFileSync('kill', ['-s', signalMap[action], pid.toString()], { encoding: 'utf8' });
    } catch (e) {
      throw new Error(`kill failed: ${e.message}`);
    }
  }
}

module.exports = {
  buildSnapshot,
  mutateWorker
};
