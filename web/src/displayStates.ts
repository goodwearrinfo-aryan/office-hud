/**
 * What each agent display state means, and how it is drawn.
 *
 * Why this is its own module
 * -------------------------
 * Every panel that colours an agent needs the same answer, and the answers were
 * drifting: OfficeScene carried a Record keyed by Agent['display'], AgentDrawer
 * carried a three-way ternary ending in the offline grey, and JarvisConsole
 * counted three of the five states. So `stale` -- a state the server really
 * emits -- was drawn as `offline` in one panel and described by no number at all
 * in another.
 *
 * It lives in a .ts file rather than inside a component because node's test
 * runner can strip types from .ts but not JSX, and the rule that the fleet's
 * numbers add up is worth a test. See server/test/displayStates.test.ts.
 *
 * The server's own ordering is used throughout: busy, idle, stale, breaker,
 * offline (server/index.js `displayOrder`).
 */

/** Every state the server can currently emit, in the order it ranks them. */
export const DISPLAY_STATES = ['busy', 'idle', 'stale', 'breaker', 'offline'] as const;

export type DisplayState = (typeof DISPLAY_STATES)[number];

/**
 * One colour per state, deliberately NOT typed as Record<DisplayState, string>.
 * A total record forces a compile error when a state is added, which is what we
 * want for the colour map -- but it cannot express "the server may send
 * something this build has never heard of", which is the case that must not
 * borrow another state's colour.
 */
const COLORS: Record<DisplayState, string> = {
  busy: '#34d399',
  idle: '#f5a623',
  // Its own colour, because it is not offline. The server derives `stale` for an
  // agent that HAS a session which is no longer fresh: still on the clock,
  // nothing heard. Drawn in offline grey it says they were never here.
  stale: '#c084fc',
  breaker: '#f87171',
  offline: '#475569',
};

/** Fallback for a state this build does not recognise: grey, and flagged as such. */
export const UNKNOWN_COLOR = '#94a3b8';

export function isKnownDisplay(display: string): display is DisplayState {
  return (DISPLAY_STATES as readonly string[]).includes(display);
}

/**
 * The colour for a display state. An unrecognised state gets UNKNOWN_COLOR
 * rather than another state's colour: "cannot tell" must not look like "idle".
 */
export function statusColorFor(display: string): string {
  return isKnownDisplay(display) ? COLORS[display] : UNKNOWN_COLOR;
}

/** Per-state headcounts, always covering every agent handed in. */
export function countByDisplay(agents: Array<{ display: string }>): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const a of agents) counts[a.display] = (counts[a.display] ?? 0) + 1;
  return counts;
}

/**
 * A roster line the reader can add up.
 *
 * This replaced "{liveCount} live - {workers.length} workers", which could not be
 * reconciled: an agent that was stale, in breaker, or offline sat in the total
 * and in neither visible number, so "3 live / 7 workers" said nothing about
 * whether the other four were asleep or gone. Every state is named, unknown
 * states are named too rather than dropped, and the total closes the line.
 */
export function describeRoster(agents: Array<{ display: string }>, noun = 'worker'): string {
  if (agents.length === 0) return `no ${noun}s`;
  const counts = countByDisplay(agents);
  const parts: string[] = [];
  for (const state of DISPLAY_STATES) {
    if (counts[state]) parts.push(`${counts[state]} ${state}`);
  }
  const unknown = Object.keys(counts).filter((s) => !isKnownDisplay(s));
  for (const state of unknown.sort()) {
    parts.push(`${counts[state]} ${state} (NOT RECOGNISED)`);
  }
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  return `${parts.join(' · ')} · ${total} ${noun}${total === 1 ? '' : 's'}`;
}

/**
 * Agents that can actually be reached: not offline, not in breaker.
 *
 * Used where a panel used to claim `agents.length` was "online". An agent with
 * no reachable process is not online, whatever the roster says about its past.
 */
export function reachableCount(agents: Array<{ display: string }>): number {
  return agents.filter((a) => a.display !== 'offline' && a.display !== 'breaker').length;
}