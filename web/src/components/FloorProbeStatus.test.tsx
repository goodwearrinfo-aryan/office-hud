import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderWithProviders, mockUseLive, clearMockUseLive } from '../test/utils';
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

describe('FloorProbeStatus', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearMockUseLive();
  });

  it('renders without crashing when data is available', () => {
    mockUseLive('/api/floors', mockFloorsPayload, null, false);
    const { container } = renderWithProviders(<FloorProbeStatus />);
    expect(container).toBeInTheDocument();
  });

  it('shows floor title', () => {
    mockUseLive('/api/floors', mockFloorsPayload, null, false);
    const { getByText } = renderWithProviders(<FloorProbeStatus />);
    expect(getByText('FLOOR PROBE')).toBeInTheDocument();
  });

  it('shows managers alive count', () => {
    mockUseLive('/api/floors', mockFloorsPayload, null, false);
    const { getByText } = renderWithProviders(<FloorProbeStatus />);
    expect(getByText('2/3 managers alive')).toBeInTheDocument();
  });

  it('shows not verified banner when probe unavailable', () => {
    mockUseLive('/api/floors', mockFloorsPayloadNotVerified, null, false);
    const { getByText } = renderWithProviders(<FloorProbeStatus />);
    expect(getByText('NOT VERIFIED')).toBeInTheDocument();
    expect(getByText('hive/lib/floor_health.py is missing')).toBeInTheDocument();
  });

  it('shows not verified banner when probe errors', () => {
    mockUseLive('/api/floors', mockFloorsPayloadError, null, false);
    const { getByText } = renderWithProviders(<FloorProbeStatus />);
    expect(getByText('NOT VERIFIED')).toBeInTheDocument();
    expect(getByText('floor health probe failed: some error')).toBeInTheDocument();
  });

  it('shows source when verified', () => {
    mockUseLive('/api/floors', mockFloorsPayload, null, false);
    const { getByText } = renderWithProviders(<FloorProbeStatus />);
    expect(getByText('Source hive/lib/floor_health.py')).toBeInTheDocument();
  });

  it('shows stalled count when > 0', () => {
    const payloadWithStalled = {
      ...mockFloorsPayload,
      counts: {
        ...mockFloorsPayload.counts,
        f1: { ...mockFloorsPayload.counts.f1, stalled: 2 },
      },
    };
    mockUseLive('/api/floors', payloadWithStalled, null, false);
    const { getByText } = renderWithProviders(<FloorProbeStatus />);
    expect(getByText('2 stalled task')).toBeInTheDocument();
  });

  it('renders floor table with all floors', () => {
    mockUseLive('/api/floors', mockFloorsPayload, null, false);
    const { getByText } = renderWithProviders(<FloorProbeStatus />);
    expect(getByText('F1')).toBeInTheDocument();
    expect(getByText('F2')).toBeInTheDocument();
    expect(getByText('F3')).toBeInTheDocument();
  });

  it('shows manager alive status', () => {
    mockUseLive('/api/floors', mockFloorsPayload, null, false);
    const { getByText } = renderWithProviders(<FloorProbeStatus />);
    expect(getByText('alive')).toBeInTheDocument();
    expect(getByText('not running')).toBeInTheDocument();
  });

  it('shows floor state', () => {
    mockUseLive('/api/floors', mockFloorsPayload, null, false);
    const { getByText } = renderWithProviders(<FloorProbeStatus />);
    expect(getByText('WORKING')).toBeInTheDocument();
    expect(getByText('IDLE')).toBeInTheDocument();
    expect(getByText('UNKNOWN')).toBeInTheDocument();
  });

  it('shows stalled count per floor', () => {
    mockUseLive('/api/floors', mockFloorsPayload, null, false);
    const { getByText } = renderWithProviders(<FloorProbeStatus />);
    expect(getByText('0')).toBeInTheDocument(); // stalled counts
  });

  it('shows reason per floor', () => {
    mockUseLive('/api/floors', mockFloorsPayload, null, false);
    const { getByText } = renderWithProviders(<FloorProbeStatus />);
    expect(getByText('manager running, tasks active')).toBeInTheDocument();
    expect(getByText('manager running, no active tasks')).toBeInTheDocument();
    expect(getByText('manager not running')).toBeInTheDocument();
  });

  it('shows loading state when data is not ready', () => {
    mockUseLive('/api/floors', null, null, true);
    const { getByText } = renderWithProviders(<FloorProbeStatus />);
    expect(getByText('Reading floor probe…')).toBeInTheDocument();
  });

  it('shows error state when fetch fails', () => {
    mockUseLive('/api/floors', null, 'Failed to fetch', false);
    const { getByText } = renderWithProviders(<FloorProbeStatus />);
    expect(getByText('NOT VERIFIED')).toBeInTheDocument();
    expect(getByText('/api/floors did not answer')).toBeInTheDocument();
  });
});