import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { ServerManager, type ServerStatus } from '../main/server-manager';

/**
 * The attach-or-spawn decision is the one behaviour that can make the HUD lie:
 * two processes binding one port means the app shows a window while the fleet
 * view is served by neither. These tests pin the ordering and the ownership
 * rule that follow from it.
 */

/** A probe whose answers are scripted, so timing does not decide the test. */
function scriptedProbe(answers: boolean[]): { probe: () => Promise<boolean>; calls: () => number } {
  let index = 0;
  let calls = 0;
  return {
    probe: async () => {
      calls += 1;
      const answer = answers[Math.min(index, answers.length - 1)];
      index += 1;
      return answer;
    },
    calls: () => calls,
  };
}

/** A child that never exits on its own, so the startup loop is driven by probes. */
class FakeChild extends EventEmitter {
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killed: NodeJS.Signals[] = [];

  kill(signal?: NodeJS.Signals): boolean {
    this.killed.push(signal ?? 'SIGTERM');
    this.signalCode = signal ?? 'SIGTERM';
    this.emit('exit', null, signal ?? 'SIGTERM');
    return true;
  }

  exitNow(): void {
    this.exitCode = 1;
    this.emit('exit', 1, null);
  }
}

test('attaches to a server already on the port and never spawns one', async () => {
  const { probe, calls } = scriptedProbe([true]);
  let spawned = 0;
  const manager = new ServerManager({
    probe,
    probeAttempts: 3,
    probeDelayMs: 1,
    spawnServer: () => { spawned += 1; return new FakeChild() as never; },
  });

  const status = await manager.ensureLive();

  assert.equal(status.state, 'live');
  assert.equal(status.ownership, 'attached');
  assert.equal(spawned, 0, 'must not spawn when the port already answers');
  assert.equal(calls(), 1, 'a live port is detected on the first probe');
});

test('spawns only after the port is proven dead, then adopts it as owned', async () => {
  const { probe } = scriptedProbe([false, false, false, true]);
  const child = new FakeChild();
  let spawned = 0;
  const manager = new ServerManager({
    probe,
    probeAttempts: 3,
    probeDelayMs: 1,
    startupTimeoutMs: 1000,
    spawnServer: () => { spawned += 1; return child as never; },
  });

  const status = await manager.ensureLive();

  assert.equal(spawned, 1);
  assert.equal(status.state, 'live');
  assert.equal(status.ownership, 'owned', 'a server we started is ours to stop');
});

test('attaching never kills the process it found', async () => {
  const { probe } = scriptedProbe([true]);
  const manager = new ServerManager({ probe, probeAttempts: 2, probeDelayMs: 1, spawnServer: () => new FakeChild() as never });

  await manager.ensureLive();
  await manager.shutdown();

  // shutdown() with no child of ours must be a no-op on the port: the
  // launchd-owned server has to survive the app quitting.
  assert.equal(manager.status().state, 'stopped');
  assert.equal(manager.status().ownership, null);
});

test('shutting down stops a server we spawned', async () => {
  // Three answers, not two: tryAttach consumes two falses before giving up, so
  // [false, true] would let the attach probe succeed and never spawn at all.
  const { probe } = scriptedProbe([false, false, true]);
  const child = new FakeChild();
  const manager = new ServerManager({
    probe,
    probeAttempts: 2,
    probeDelayMs: 1,
    startupTimeoutMs: 1000,
    spawnServer: () => child as never,
  });

  await manager.ensureLive();
  await manager.shutdown();

  assert.ok(child.killed.includes('SIGTERM'), 'our child gets a graceful stop first');
});

test('reports failure when a spawned server dies during startup', async () => {
  const probe = async (): Promise<boolean> => false;
  const child = new FakeChild();
  const manager = new ServerManager({
    probe,
    probeAttempts: 1,
    probeDelayMs: 1,
    startupTimeoutMs: 1000,
    spawnServer: () => {
      // Die on the next tick, after the first failed probe.
      setTimeout(() => { child.exitNow(); }, 5);
      return child as never;
    },
  });

  await assert.rejects(() => manager.ensureLive(), /exited during startup/);
  assert.equal(manager.status().state, 'failed');
});

test('reports failure when a spawned server never becomes live', async () => {
  const probe = async (): Promise<boolean> => false;
  const child = new FakeChild();
  const manager = new ServerManager({
    probe,
    probeAttempts: 1,
    probeDelayMs: 1,
    startupTimeoutMs: 30,
    spawnServer: () => child as never,
  });

  await assert.rejects(() => manager.ensureLive(), /did not answer/);
  assert.equal(manager.status().state, 'failed');
  assert.ok(child.killed.length > 0, 'a server that never came up is not left running');
});

test('emits a status transition for each state change', async () => {
  const { probe } = scriptedProbe([true]);
  const manager = new ServerManager({ probe, probeAttempts: 2, probeDelayMs: 1, spawnServer: () => new FakeChild() as never });
  const seen: string[] = [];
  manager.on('status', (status: ServerStatus) => { seen.push(status.state); });

  await manager.ensureLive();

  assert.deepEqual(seen, ['attaching', 'live']);
});
test('a server we deliberately stop is not respawned', async () => {
  // The regression that hung the suite: stopChild() did not mark the exit as
  // deliberate, so the exit handler re-entered ensureLive() and spawned a
  // replacement forever.
  const { probe } = scriptedProbe([false, false, true]);
  const children: FakeChild[] = [];
  const manager = new ServerManager({
    probe,
    probeAttempts: 2,
    probeDelayMs: 1,
    startupTimeoutMs: 1000,
    spawnServer: () => { const c = new FakeChild(); children.push(c); return c as never; },
  });

  await manager.ensureLive();
  await manager.shutdown();
  await new Promise((r) => { setTimeout(r, 40); });

  assert.equal(children.length, 1, 'a deliberate stop must not trigger a replacement');
});

test('ensureLive is re-entrant safe: concurrent callers share one attempt', async () => {
  const { probe } = scriptedProbe([false, false, true]);
  let spawned = 0;
  const manager = new ServerManager({
    probe,
    probeAttempts: 2,
    probeDelayMs: 1,
    startupTimeoutMs: 1000,
    spawnServer: () => { spawned += 1; return new FakeChild() as never; },
  });

  await Promise.all([manager.ensureLive(), manager.ensureLive(), manager.ensureLive()]);

  assert.equal(spawned, 1, 'three concurrent callers must not race for the port');
});

test('does not spawn after shutdown', async () => {
  const { probe } = scriptedProbe([true]);
  const manager = new ServerManager({ probe, probeAttempts: 1, probeDelayMs: 1, spawnServer: () => new FakeChild() as never });

  await manager.ensureLive();
  await manager.shutdown();

  await assert.rejects(() => manager.ensureLive(), /shutting down/);
});

test('a lost server goes to stopped and its return is reported as recovery', async () => {
  // The forward this app rides is re-created by an external keepalive, so one
  // blip must not wedge the shell permanently.
  const answers = [true, false, true];
  let i = 0;
  const manager = new ServerManager({
    probe: async () => answers[Math.min(i++, answers.length - 1)],
    probeAttempts: 1,
    probeDelayMs: 1,
    spawnServer: () => new FakeChild() as never,
  });
  const recovered: string[] = [];
  manager.on('recovered', (status: ServerStatus) => { recovered.push(status.state); });

  await manager.ensureLive();
  assert.equal(manager.status().state, 'live');

  await manager.checkHealth();
  assert.equal(manager.status().state, 'stopped', 'a failed probe must downgrade');

  await manager.checkHealth();
  assert.equal(manager.status().state, 'live', 'the server coming back must upgrade again');
  assert.deepEqual(recovered, ['stopped'], 'recovery is announced exactly once, with the pre-upgrade state');
});
