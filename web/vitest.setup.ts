import '@testing-library/jest-dom';
import { vi } from 'vitest';

// Mock the live store for tests
vi.mock('../live/store', () => {
  const mockLiveStore = {
    subscribe: vi.fn(() => () => {}),
    subscribeStatus: vi.fn(() => () => {}),
    subscribeViewers: vi.fn(() => () => {}),
    getStatus: vi.fn(() => ({ state: 'live', since: Date.now() })),
    getViewers: vi.fn(() => []),
    acquire: vi.fn(() => () => {}),
    load: vi.fn(() => Promise.resolve()),
    refresh: vi.fn(() => Promise.resolve()),
    patch: vi.fn(),
    isStale: vi.fn(() => false),
  };

  const MockLiveStoreProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => children;

  return {
    liveStore: mockLiveStore,
    useResource: vi.fn(() => ({ data: null, error: null, loading: false, updatedAt: null, stale: false, refresh: vi.fn() })),
    useConnectionStatus: vi.fn(() => ({ state: 'live', since: Date.now() })),
    useViewers: vi.fn(() => []),
    acknowledgeAlert: vi.fn(),
    acknowledgeAllAlerts: vi.fn(),
    LiveStoreProvider: MockLiveStoreProvider,
  };
});

// Export LiveStoreProvider for use in renderWithProviders
export { MockLiveStoreProvider as LiveStoreProvider } from './test/utils';
