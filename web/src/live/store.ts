export const liveStore = null;
export const useResource = <T>(_key: string) => ({
  data: null as unknown as T,
  error: null as unknown as string | null,
  loading: false,
  refresh: () => {},
  updatedAt: null as unknown as number | null,
});
export const useConnectionStatus = () => ({
  state: 'offline' as string,
});
export const useViewers = <T>(_key: string) => ({
  data: null as unknown as T,
  error: null as unknown as string | null,
  loading: false,
  refresh: () => {},
  updatedAt: null as unknown as number | null,
});
export const acknowledgeAlert = (_fingerprint: string, _acknowledged: boolean) => null;
export const acknowledgeAllAlerts = () => null;

export type Alert = any;
export type AlertSummary = any;
export type ResolvedAlert = any;
export type LiveStatus = any;
export type ConnectionStatus = any;
export type Viewer = any;
export type AutonomyState = any;
export type AutonomyPolicy = any;
export type AutonomyProposal = any;
export type AutonomyAuditEntry = any;
export type CapacityAssessment = any;