import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { HUD_HEALTH_PATH, HUD_HOST, HUD_PORT, HUD_ORIGIN, OWNED_HIVE_LABEL } from '../shared/config';

/**
 * Who is serving the HUD port right now.
 *
 * ATTACHED means something else already owns the port — a launchd job, a
 * manually started process, or an SSH forward to the deployment host. We never
 * stop or restart that process; quitting the app must not take the fleet's HUD
 * down with it.
 *
 * OWNED means we spawned the server ourselves and are therefore responsible for
 * stopping it.
 */
export type Ownership = 'attached' | 'owned';

export type ServerState =
  | 'booting'
  | 'attaching'
  | 'live'
  | 'starting'
  | 'stopped'
  | 'failed';

export interface ServerStatus {
  state: ServerState;
  ownership: Ownership | null;
  port: number;
  detail: string;
}

export interface ServerManagerOptions {
  /** Injected for tests; defaults to a real HTTP GET. */
  probe?: (origin: string) => Promise<boolean>;
  /** Injected for tests; defaults to spawning `node server/index.js`. */
  spawnServer?: () => ChildProcess;
  /** How many probe attempts before declaring the port dead. */
  probeAttempts?: number;
  probeDelayMs?: number;
  /** How long a spawned server gets to become live before it is killed. */
  startupTimeoutMs?: number;
}

const DEFAULTS = {
  probeAttempts: 5,
  probeDelayMs: 200,
  startupTimeoutMs: 15_000,
};

const sleep = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); });

async function httpProbe(origin: string): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => { controller.abort(); }, 500);
  try {
    const response = await fetch(`${origin}${HUD_HEALTH_PATH}`, { signal: controller.signal });
    return response.status === 200;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Owns the question "is the HUD being served, and if not, who starts it".
 *
 * The ordering is the whole point: probe before spawn, always. Two processes
 * binding one port is the single failure that makes the fleet view lie, because
 * the loser silently serves nothing while the app shows a window.
 */
export class ServerManager extends EventEmitter {
  private state: ServerState = 'booting';
  private ownership: Ownership | null = null;
  private detail = 'not started';
  private child: ChildProcess | null = null;
  private probe: (origin: string) => Promise<boolean>;
  private spawnServer: () => ChildProcess;
  private probeAttempts: number;
  private probeDelayMs: number;
  private startupTimeoutMs: number;
  private healthTimer: NodeJS.Timeout | null = null;
  /** Set while a deliberate stop is in flight so exit is not read as a crash. */
  private stopping = false;
  /** In-flight startup, shared by concurrent callers instead of racing. */
  private pending: Promise<ServerStatus> | null = null;
  /** Tail of the spawned server's output, surfaced when startup fails. */
  private outputTail: string[] = [];

  constructor(options: ServerManagerOptions = {}) {
    super();
    this.probe = options.probe ?? httpProbe;
    this.spawnServer = options.spawnServer ?? defaultSpawn;
    this.probeAttempts = options.probeAttempts ?? DEFAULTS.probeAttempts;
    this.probeDelayMs = options.probeDelayMs ?? DEFAULTS.probeDelayMs;
    this.startupTimeoutMs = options.startupTimeoutMs ?? DEFAULTS.startupTimeoutMs;
  }

  status(): ServerStatus {
    return { state: this.state, ownership: this.ownership, port: HUD_PORT, detail: this.detail };
  }

  private set(state: ServerState, detail: string, ownership: Ownership | null = this.ownership): void {
    this.state = state;
    this.detail = detail;
    this.ownership = ownership;
    this.emit('status', this.status());
  }

  /**
   * Resolve to live, whether by attaching to an existing server or by starting
   * one. Resolves only on `live`; rejects if the port stays dead and our own
   * child fails to come up.
   */
  async ensureLive(): Promise<ServerStatus> {
    // Quit can land while a startup is still in flight; spawning after
    // shutdown() would orphan a listener on the fleet's HUD port.
    if (this.stopping) throw new Error('the HUD shell is shutting down');
    // app.whenReady(), the Retry button and the respawn path can all call this
    // at once. Concurrent callers must share one attempt, not race for the port.
    if (this.pending) return this.pending;

    this.pending = this.bringUp().finally(() => { this.pending = null; });
    return this.pending;
  }

  private async bringUp(): Promise<ServerStatus> {
    // A previous deliberate stop must not suppress this new attempt.
    this.stopping = false;
    if (await this.tryAttach()) return this.status();

    this.set('starting', `nothing on :${HUD_PORT}, starting the HUD server`, 'owned');
    const child = this.spawnServer();
    this.child = child;
    this.drainOutput(child);
    this.wireChild(child);

    const deadline = Date.now() + this.startupTimeoutMs;
    while (Date.now() < deadline) {
      if (await this.probe(HUD_ORIGIN)) {
        this.startHealthWatch();
        this.set('live', `attached to the server we started on :${HUD_PORT}`, 'owned');
        return this.status();
      }
      // The child died during startup; there is nothing left to wait for.
      if (child.exitCode !== null || child.signalCode !== null) {
        this.child = null;
        this.set('failed', `the HUD server exited during startup (${child.signalCode ?? `code ${child.exitCode}`})${this.lastOutput() ? `\n\n${this.lastOutput()}` : ''}`, null);
        throw new Error(`HUD server exited during startup: ${this.detail}`);
      }
      await sleep(this.probeDelayMs);
    }

    this.stopChild();
    this.set('failed', `the HUD server did not answer on :${HUD_PORT} within ${this.startupTimeoutMs}ms${this.lastOutput() ? `\n\n${this.lastOutput()}` : ''}`, null);
    throw new Error(this.detail);
  }

  /** Probe the port. On success we are attached and must not touch the process. */
  private async tryAttach(): Promise<boolean> {
    this.set('attaching', `looking for a HUD server on :${HUD_PORT}`, null);
    for (let attempt = 0; attempt < this.probeAttempts; attempt += 1) {
      if (await this.probe(HUD_ORIGIN)) {
        this.startHealthWatch();
        this.set('live', `attached to the HUD server already on :${HUD_PORT}`, 'attached');
        return true;
      }
      await sleep(this.probeDelayMs);
    }
    return false;
  }

  /**
   * Read the child's pipes. Without this the output is discarded, so a spawn
   * failure can only be reported as "exited during startup" with the real cause
   * thrown away, and an undrained pipe eventually blocks the child in write().
   */
  private drainOutput(child: ChildProcess): void {
    const capture = (chunk: Buffer | string): void => {
      for (const line of String(chunk).split('\n')) {
        const text = line.trim();
        if (!text) continue;
        this.outputTail.push(text);
        if (this.outputTail.length > 40) this.outputTail.shift();
      }
    };
    child.stdout?.on('data', capture);
    child.stderr?.on('data', capture);
  }

  private lastOutput(): string {
    return this.outputTail.slice(-8).join('\n');
  }

  private wireChild(child: ChildProcess): void {
    child.once('exit', (code, signal) => {
      const wasStopping = this.stopping;
      this.child = null;
      if (wasStopping) return;
      // Someone else may have taken the port (launchd respawn, tunnel up), or
      // our child may have crashed. Either way, re-resolve from scratch.
      void this.ensureLive().catch(() => {
        this.set('failed', `the HUD server exited (${signal ?? `code ${code}`})${this.lastOutput() ? `\n\n${this.lastOutput()}` : ''}`, null);
      });
    });
  }

  /**
   * One health tick. Extracted from the interval so the down-then-up
   * transition is testable without waiting ten seconds.
   */
  async checkHealth(): Promise<void> {
    if (this.stopping) return;
    const up = await this.probe(HUD_ORIGIN);
    if (up) {
      if (this.state === 'stopped' || this.state === 'failed') {
        this.emit('recovered', this.status());
        this.set('live', `reconnected to the HUD server on :${HUD_PORT}`, this.ownership);
      }
      return;
    }
    if (this.state === 'live') {
      this.set('stopped', `lost the HUD server on :${HUD_PORT}`, this.ownership);
    }
  }

  /**
   * Periodic re-check. Losing the server downgrades to `stopped`; getting it
   * back upgrades again. The forward this app often rides is re-created by an
   * external keepalive, so a single blip must not wedge the shell permanently.
   */
  private startHealthWatch(): void {
    if (this.healthTimer) return;
    this.healthTimer = setInterval(() => { void this.checkHealth(); }, 10_000);
    this.healthTimer.unref?.();
  }

  /** Quit path. Only ever stops a server we spawned. */
  async shutdown(): Promise<void> {
    this.stopping = true;
    if (this.healthTimer) { clearInterval(this.healthTimer); this.healthTimer = null; }
    this.stopChild();
    this.set('stopped', 'shut down', null);
  }

  private stopChild(): void {
    const child = this.child;
    if (!child) return;
    this.child = null;
    // The exit handler below respawns on an unexpected exit. Suppress that for
    // a stop we asked for, otherwise every deliberate kill re-enters
    // ensureLive() and spawns a replacement: an unbounded loop that also made
    // the test runner hang.
    this.stopping = true;
    child.kill('SIGTERM');
    // The server drains SSE streams before exit; give it a moment, then insist.
    setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }, 5000).unref?.();
  }
}

function defaultSpawn(): ChildProcess {
  const path = require('node:path');
  // dist/main -> dist -> electron -> office-hud. The HUD server is a sibling of
  // electron/, not of electron/dist, so this needs three levels up. Getting this
  // wrong is invisible until the port is empty, which is exactly the WiFi-off
  // case where the shell is the only thing that can serve the HUD.
  const hudRoot = path.join(__dirname, '..', '..', '..');
  return spawn(process.execPath, [path.join(hudRoot, 'server', 'index.js')], {
    cwd: hudRoot,
    env: {
      ...process.env,
      PORT: String(HUD_PORT),
      HOST: HUD_HOST,
      OFFICE_HUD_LABEL: OWNED_HIVE_LABEL,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}