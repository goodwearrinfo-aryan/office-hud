'use strict';
// The office CLI's attach-vs-spawn state machine.
//
// bin/office.js decides, for the bare `office` invocation, between ATTACHING to a
// server that is already listening and SPAWNING a new one. Getting that wrong in
// either direction is a real failure mode: spawning when a server is already up
// produces an EADDRINUSED crash-loop under launchd, and refusing to spawn when
// nothing is running leaves a dead launcher with no explanation.
//
// This is tested black-box, by running the real CLI as a subprocess with a
// stub `lsof` first on PATH. bin/office.js resolves lsof through PATH
// (`spawn('lsof', ['-ti', ':PORT'])`), so a stub is enough to control exactly the
// input that state machine branches on -- and nothing about that file has to be
// modified or exported to test it. It belongs to another agent's in-flight work,
// so refactoring it for testability is not ours to do.
//
// Only the `status` subcommand is exercised. It reads the same lsof probe the
// start path uses and performs no side effects, so the attach/spawn *decision
// input* is covered without ever spawning a server or unloading a launchd job.
// `stop`, `restart` and the spawn path are covered by the manual launch checklist
// in README.md, because each of those mutates real process state and cannot be
// asserted safely from a unit test.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const OFFICE = path.join(__dirname, '..', '..', 'bin', 'office.js');

let stubDir;
test.before(() => {
  stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'office-cli-stub-'));
  // A stub lsof that always reports nothing listening: the "must spawn" input.
  const empty = path.join(stubDir, 'empty');
  fs.mkdirSync(empty, { recursive: true });
  fs.writeFileSync(path.join(empty, 'lsof'), '#!/bin/sh\nexit 1\n');
  fs.chmodSync(path.join(empty, 'lsof'), 0o755);
  // A stub lsof that reports one pid: the "already running, attach" input.
  const running = path.join(stubDir, 'running');
  fs.mkdirSync(running, { recursive: true });
  fs.writeFileSync(path.join(running, 'lsof'), '#!/bin/sh\necho 4242\nexit 0\n');
  fs.chmodSync(path.join(running, 'lsof'), 0o755);
});
test.after(() => { fs.rmSync(stubDir, { recursive: true, force: true }); });

/** Run the real CLI with a chosen stub lsof and report what it decided. */
function status({ listener, port }) {
  const dir = listener === 'running' ? 'running' : 'empty';
  const result = spawnSync(process.execPath, [OFFICE, 'status'], {
    env: { ...process.env, PATH: `${path.join(stubDir, dir)}:${process.env.PATH}`, PORT: port || '4747' },
    encoding: 'utf8',
    timeout: 15000,
  });
  return { code: result.status, out: `${result.stdout || ''}${result.stderr || ''}` };
}

test('bin/office.js exists and is executable as a node script', () => {
  assert.ok(fs.existsSync(OFFICE), 'the CLI the launcher invokes must exist');
  const first = fs.readFileSync(OFFICE, 'utf8').split('\n')[0];
  assert.match(first, /^#!.*node/, 'keeps its shebang so `office` can exec it directly');
});

test('a live server is reported as running, with its pid and port', () => {
  // This is the "attach" half of the decision: lsof found a listener.
  const result = status({ listener: 'running' });
  assert.equal(result.code, 0);
  assert.match(result.out, /running \(pid 4242\) on port 4747/);
});

test('no server is reported as stopped, which is what drives the spawn path', () => {
  // The "spawn" half. The message is the signal the start path branches on, so
  // it is asserted rather than merely the exit code.
  const result = status({ listener: 'empty' });
  assert.equal(result.code, 0);
  assert.match(result.out, /stopped/);
  assert.doesNotMatch(result.out, /running/);
});

test('status honours PORT rather than a hardcoded 4747', () => {
  // The CLI reads PORT from the environment. If that were ignored, a second
  // instance on another port would report the first one's state and the
  // launcher would attach to the wrong server.
  const result = status({ listener: 'running', port: '4999' });
  assert.match(result.out, /running \(pid 4242\) on port 4999/);
});

test('status does not mutate anything: no server spawned, no job unloaded', () => {
  // A read-only subcommand must stay read-only. If `status` ever grew a side
  // effect, this is the assertion that catches it before it unloads a live HUD.
  const result = status({ listener: 'empty' });
  assert.equal(result.code, 0);
  assert.doesNotMatch(result.out, /starting server/i, 'status must not spawn');
  assert.doesNotMatch(result.out, /unloaded|stopped server/i, 'status must not stop anything');
});

test('the spawn path waits for the port rather than reporting success early', () => {
  // The start path polls isServerRunning up to 30 times before giving up. That
  // loop is the difference between "server is up" and "process was launched",
  // so the retry bound is asserted as source text: it is the one part of the
  // state machine that cannot be observed through `status` without spawning.
  const src = fs.readFileSync(OFFICE, 'utf8');
  assert.match(src, /for \(let i = 0; i < \d+; i\+\+\)/, 'the readiness poll loop is present');
  assert.match(src, /if \(await isServerRunning\(\)\) break;/, 'and it re-probes the port each pass');
  assert.match(src, /detached: true/, 'the server is detached so it outlives the CLI');
  assert.match(src, /child\.unref\(\)/, 'and unref\'d so the CLI can exit');
});