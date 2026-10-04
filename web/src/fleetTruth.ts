/**
 * What the fleet floor is allowed to say about a machine.
 *
 * In a .ts module rather than inside FleetFloor.tsx so node's runner can load it
 * and so the rules can be asserted directly. See server/test/fleetTruth.test.ts.
 *
 * The rules exist because the raw payload invites three comfortable lies:
 *
 *  - A host that stopped reporting could be dropped from the list. It is not
 *    dropped, because "this machine does not exist" and "this machine has not
 *    spoken since yesterday" are different claims and only one is true.
 *  - A row with `process_id: null` could be drawn as an unnamed process. It is
 *    drawn NOT REPORTED, because the collector did not supply an identity.
 *  - A row with `health: null` could inherit the green of its neighbours. It is
 *    drawn NOT VERIFIED, which is the honest state and is not the same as healthy.
 */

/** A host this machine runs that no plist in the repo accounts for. */
export const UNDECLARED_JOBS = [
  'com.aryan.info-swarm-awake',
  'com.aryan.openalice-cloudflared',
  'com.aryan.openalice-pubserver',
  'com.aryan.scalp-caffeinate',
] as const;

export interface HostProcessLike {
  process_id?: string | null;
  project_id?: string | null;
  health?: string | null;
}

export interface HostLike {
  host: string;
  local?: boolean;
  collected_at?: string;
  age_sec?: number | null;
  stale?: boolean;
  processes?: HostProcessLike[];
}

/** How long ago, in words a person reads at a glance. Never "0 seconds ago". */
export function ageLabel(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds)) return 'age unknown';
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

/**
 * Whether a process row carries a usable identity.
 *
 * Either field counts: a row with a project but no process id is still
 * attributable, and calling it anonymous would overstate the gap.
 */
export function isIdentified(p: HostProcessLike): boolean {
  return !!(p.process_id || p.project_id);
}

export function isVerified(p: HostProcessLike): boolean {
  return typeof p.health === 'string' && p.health.length > 0;
}

/**
 * The one-line account of a host, in which every row is placed.
 *
 * The point is that the numbers reconcile. Measured while building this: the
 * mini reported 2 processes both identified, the laptop 33 with none identified
 * and no health at all. A summary reading "2 machines, 35 processes" would have
 * buried both facts.
 */
export function hostSummary(host: HostLike): string {
  const processes = host.processes ?? [];
  const parts = [`collected ${host.collected_at ?? 'at an unrecorded time'}`];
  parts.push(`${processes.length} process${processes.length === 1 ? '' : 'es'}`);
  if (processes.length === 0) return parts.join(' · ');

  const identified = processes.filter(isIdentified).length;
  const unverified = processes.filter((p) => !isVerified(p)).length;
  if (identified < processes.length) {
    parts.push(`${processes.length - identified} NOT REPORTED`);
  }
  if (unverified > 0) parts.push(`${unverified} health NOT VERIFIED`);
  return parts.join(' · ');
}

/**
 * The one-line status of a host: reporting or stale, always with its age.
 *
 * Age is always shown, including when the host is healthy, because "reporting"
 * without a timestamp is a claim with no evidence attached.
 */
export function hostStatus(host: HostLike): string {
  return `${host.stale ? 'STALE' : 'reporting'} · ${ageLabel(host.age_sec ?? null)}`;
}

/** Jobs running here that no declared service accounts for. */
export function undeclaredJobs(declaredLabels: string[]): string[] {
  const known = new Set(declaredLabels);
  return UNDECLARED_JOBS.filter((j) => !known.has(j));
}