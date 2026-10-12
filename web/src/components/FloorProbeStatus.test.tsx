import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen } from '@testing-library/dom';
import '@testing-library/jest-dom';
import { renderWithProviders, mockFetch } from '../test/utils';
import FloorProbeStatus from '../components/FloorProbeStatus';

const mockFloorsPayload = {
  floors: [
    { floor: 'f1', manager: 'F1', state: 'WORKING', reason: 'manager running, tasks active', manager_alive: true, task_counts: { running: 2, queued: 1 }, current_task: 'task-1', last_activity: new Date().toISOString() },
    { floor: 'f2', manager: 'F2', state: 'IDLE', reason: 'manager running, no active tasks', manager_alive: true, task_counts: { queued: 1 }, current_task: null, last_activity: new Date().toISOString() },
    { floor: 'f3', manager: 'F3', state: 'UNKNOWN', reason: 'manager not running', manager_alive: false, task_counts: {}, current_task: null, last_activity: null },
  ],
  counts: {
    f1: { state: 'WORKING', manager_alive: true, reason: 'manager running, tasks active', current_task: 'task-1', last_activity: new Date().toISOString(), tasks: { running: 2, queued: 1 }, workers: 3, failed_workers: 0, stalled: 0, degraded: false },
    f2: { state: 'IDLE', manager_alive: true, reason: 'manager running, no active tasks', current_task: null, last_activity: new Date().toISOString(), tasks: { queued: 1 }, workers: 2, failed_workers: 0, stalled: 0, degraded: false },
    f3: { state: 'UNKNOWN', manager_alive: false, reason: 'manager not running', current_task: null, last_activity: null, tasks: {}, workers: 1, failed_workers: 0, stalled: 0, degraded: true },
  },
  summary: { WORKING: 1, IDLE: 1, UNKNOWN: 1 },
  source: 'hive/lib/floor_health.py',
  not_verified: false,
  at: Date.now(),
};

const mockFloorsPayloadNotVerified = {
  floors: [
    { floor: 'f1', manager: 'F1', state: 'UNKNOWN', reason: 'hive/lib/floor_health.py is missing', manager_alive: false, task_counts: {}, current_task: null, last_activity: null },
    { floor: 'f2', manager: 'F2', state: 'UNKNOWN', reason: 'hive/lib/floor_health.py is missing', manager_alive: false, task_counts: {}, current_task: null, last_activity: null },
  ],
  counts: {
    f1: { state: 'UNKNOWN', manager_alive: false, reason: 'hive/lib/floor_health.py is missing', current_task: null, last_activity: null, tasks: {}, workers: 0, failed_workers: 0, stalled: 0, degraded: true },
    f2: { state: 'UNKNOWN', manager_alive: false, reason: 'hive/lib/floor_health.py is missing', current_task: null, last_activity: null, tasks: {}, workers: 0, failed_workers: 0, stalled: 0, degraded: true },
  },
  summary: { UNKNOWN: 2 },
  source: 'unavailable',
  not_verified: true,
  at: Date.now(),
};

const mockFloorsPayloadError = {
  floors: [
    { floor: 'f1', manager: 'F1', state: 'UNKNOWN', reason: 'floor health probe failed: some error', manager_alive: false, task_counts: {}, current_task: null, last_activity: null },
  ],
  counts: {},
  summary: {},
  source: 'error',
  not_verified: true,
  at: Date.now(),
};

// '/api/floors' has no entry in RESOURCE_BY_PATH (api.ts:1174-1207), so
// resourceKeyForPath returns null and useLive serves it from usePolled — a real
// fetch — instead of the pushed resource store that mockUseLive feeds. Every
// other panel in this suite is socket-backed, which is why mockUseLive appears
// to be the obvious helper here and silently yields `{data: null}`.
let restoreFetch: (() => void) | null = null;

function serveFloors(payload: unknown) {
  restoreFetch = mockFetch(new Map([['/api/floors', payload]]));
}

function failFloors(status: number) {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status, json: async () => ({}) })));
}

describe('FloorProbeStatus', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    restoreFetch = null;
  });

  afterEach(() => {
    restoreFetch?.();
    restoreFetch = null;
    vi.unstubAllGlobals();
  });

  it('renders without crashing when data is available', async () => {
    serveFloors(mockFloorsPayload);
    const { container } = renderWithProviders(<FloorProbeStatus />);
    // The table only exists once the poll resolves, so waiting for a row is
    // what makes "data is available" true rather than merely hoped for.
    expect(await screen.findByText('F1')).toBeInTheDocument();
    expect(container).toBeInTheDocument();
  });

  it('shows floor title', async () => {
    serveFloors(mockFloorsPayload);
    renderWithProviders(<FloorProbeStatus />);
    // The heading renders in the loading branch too (line 32), so resolve it
    // only after the table lands: once the data arrives the heading moves into
    // the header wrapper (line 44) and React replaces that DOM node.
    await screen.findByRole('table');
    expect(screen.getByText('FLOOR PROBE')).toBeInTheDocument();
  });

  it('shows managers alive count', async () => {
    serveFloors(mockFloorsPayload);
    renderWithProviders(<FloorProbeStatus />);
    // Component line 46 renders `{alive}/{data.floors.length} managers alive`
    // over floors[]; f1 and f2 are alive, f3 is not.
    expect(await screen.findByText('2/3 managers alive')).toBeInTheDocument();
  });

  it('shows not verified banner when probe unavailable', async () => {
    serveFloors(mockFloorsPayloadNotVerified);
    renderWithProviders(<FloorProbeStatus />);
    // The banner (component lines 51-55) is one div assembled from three JSX
    // expressions, so its text content is the whole sentence — an exact
    // getByText('NOT VERIFIED') can never match it.
    const banner = await screen.findByText(/NOT VERIFIED/);
    expect(banner).toBeInTheDocument();
    expect(banner).toHaveTextContent('the hive probe could not be consulted');
    // source === 'unavailable' selects the parenthetical on component line 53.
    expect(banner).toHaveTextContent('lib/floor_health.py is not present on this hive');
    // The banner must say the UNKNOWN rows are unmeasured, not broken.
    expect(banner).toHaveTextContent('Every floor below reads UNKNOWN');
    // Both floors carry the probe reason in the Reason column (line 81).
    const reasons = await screen.findAllByText('hive/lib/floor_health.py is missing');
    expect(reasons).toHaveLength(2);
  });

  it('shows not verified banner when probe errors', async () => {
    serveFloors(mockFloorsPayloadError);
    renderWithProviders(<FloorProbeStatus />);
    const banner = await screen.findByText(/NOT VERIFIED/);
    expect(banner).toHaveTextContent('the hive probe could not be consulted');
    // source is 'error', so the unavailable-source parenthetical must NOT appear.
    expect(banner).not.toHaveTextContent('lib/floor_health.py is not present on this hive');
    expect(await screen.findByText('floor health probe failed: some error')).toBeInTheDocument();
  });

  it('shows source when verified', async () => {
    serveFloors(mockFloorsPayload);
    renderWithProviders(<FloorProbeStatus />);
    // Component lines 57-60 render `Source {data.source}` with the stalled
    // suffix appended only when stalled > 0; this payload has stalled === 0, so
    // the text is exactly the source with nothing appended.
    expect(await screen.findByText('Source hive/lib/floor_health.py')).toBeInTheDocument();
  });

  it('shows stalled count when > 0', async () => {
    const payloadWithStalled = {
      ...mockFloorsPayload,
      counts: {
        ...mockFloorsPayload.counts,
        f1: { ...mockFloorsPayload.counts.f1, stalled: 2 },
      },
    };
    serveFloors(payloadWithStalled);
    renderWithProviders(<FloorProbeStatus />);
    // Component line 59 pluralises: `${stalled} stalled task${stalled === 1 ? '' : 's'}`.
    // 2 must render with the trailing 's'; the un-pluralised expectation this
    // test used to carry was already stale against that line.
    const line = await screen.findByText((content) => content.includes('2 stalled'));
    expect(line).toHaveTextContent('2 stalled tasks');
  });

  it('renders floor table with all floors', async () => {
    serveFloors(mockFloorsPayload);
    renderWithProviders(<FloorProbeStatus />);
    // Component line 73 upper-cases the floor key for display.
    expect(await screen.findByText('F1')).toBeInTheDocument();
    expect(screen.getByText('F2')).toBeInTheDocument();
    expect(screen.getByText('F3')).toBeInTheDocument();
  });

  it('shows manager alive status', async () => {
    serveFloors(mockFloorsPayload);
    renderWithProviders(<FloorProbeStatus />);
    // Component line 75 renders 'alive' / 'not running' per floor, so with two
    // live managers 'alive' legitimately appears twice.
    const alive = await screen.findAllByText('alive');
    expect(alive).toHaveLength(2);
    expect(screen.getByText('not running')).toBeInTheDocument();
  });

  it('shows floor state', async () => {
    serveFloors(mockFloorsPayload);
    renderWithProviders(<FloorProbeStatus />);
    // Component line 78 renders f.state verbatim.
    expect(await screen.findByText('WORKING')).toBeInTheDocument();
    expect(screen.getByText('IDLE')).toBeInTheDocument();
    expect(screen.getByText('UNKNOWN')).toBeInTheDocument();
  });

  it('shows stalled count per floor', async () => {
    serveFloors(mockFloorsPayload);
    renderWithProviders(<FloorProbeStatus />);
    // Component line 80 renders `data.counts[f.floor]?.stalled ?? 0` in its own
    // cell, so one '0' per floor — three, not one.
    const stalled = await screen.findAllByText('0');
    expect(stalled).toHaveLength(3);
  });

  it('shows reason per floor', async () => {
    serveFloors(mockFloorsPayload);
    renderWithProviders(<FloorProbeStatus />);
    // Component line 81 renders f.reason per row.
    expect(await screen.findByText('manager running, tasks active')).toBeInTheDocument();
    expect(screen.getByText('manager running, no active tasks')).toBeInTheDocument();
    expect(screen.getByText('manager not running')).toBeInTheDocument();
  });

  it('shows loading state when data is not ready', () => {
    // A poll that never settles is the honest way to hold the pre-data state:
    // component lines 29-36 render this until `data` is non-null.
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
    renderWithProviders(<FloorProbeStatus />);
    expect(screen.getByText('Reading floor probe…')).toBeInTheDocument();
    // The table must not be on screen yet — this is the state under test.
    expect(screen.queryByText('FLOOR PROBE')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('shows error state when fetch fails', async () => {
    failFloors(503);
    renderWithProviders(<FloorProbeStatus />);
    // Component lines 20-27 render one div on the error branch; both fragments
    // live inside that single sentence, so match on content.
    const errorLine = await screen.findByText((content) => content.includes('/api/floors did not answer'));
    expect(errorLine).toHaveTextContent('NOT VERIFIED');
    // The error branch is terminal — no table may render underneath it.
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });
});
