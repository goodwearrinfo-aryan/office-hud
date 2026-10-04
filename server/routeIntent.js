'use strict';
/**
 * Every GET the server serves, and who it is for.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * A sweep on 2026-10-04 found 19 of the server's 59 GET routes with no consumer
 * anywhere: not the web build, not a script, nothing. They were not broken --
 * they answered correctly, and the HUD paid for computing them on every poll
 * while nobody could see the result. Route 3 of the mini reconcile had already
 * found the same class of problem on the type side, where four orphan panels
 * were mounted nowhere and twelve live routes had no consumer.
 *
 * The failure mode this prevents is silence. An unconsumed route is not a bug,
 * so nothing goes red; it just quietly accumulates, and the list of things the
 * HUD could show grows while the list of things it does show does not.
 *
 * So every GET must be either claimed by the web build (checked automatically,
 * including template-literal references) or carry a stated reason here. The
 * companion test fails when a route is added without a decision, which is the
 * only moment anyone is actually looking.
 *
 * The reasons are deliberately specific. "internal" is not a reason; "read by the
 * native shell, which has no fetch for it" is.
 */

/** Consumed by the web build. Verified by the companion test, not asserted here. */
const WEB = 'web';

/**
 * reason: the route is served on purpose for something other than a floor.
 * surface: the route has no consumer yet, and the named floor is where it goes.
 */
const INTENT = {
  // ---- served, but not to a floor ----
  '/api/terminals/peers': {
    reason: 'Read-only dispatch targets, ungated on purpose so a caller can discover where work may go before asking for it to be placed. No floor renders it yet.',
  },
  '/api/terminals/:id/follow': {
    surface: 'F18',
    reason: 'The follow pane on the desk reads it as a stream. The pane is a reader and labels itself read-only: nothing can be typed into this stream, and rendering it as a shell would imply otherwise. xterm.js is deliberately not here.',
  },
  '/api/terminals/:id/logs': {
    reason: 'Backlog of a terminal\'s output, the non-streaming counterpart to follow. Same viewer surface as above.',
  },
  '/api/terminals/spawned': {
    surface: 'F18',
    reason: 'The desk floor lists what this HUD started so the follow pane has something to attach to. Kept apart from the human shells collect-terminals.py reports, which is why it is not simply the fleet list.',
  },
  '/api/terminals/health': {
    reason: 'Concurrency and log-volume health for the spawned-terminal manager. Feeds the same viewer surface.',
  },
  '/api/terminals/:id': {
    reason: 'One spawned terminal. Same viewer surface.',
  },
  '/api/live/*': {
    reason: 'Catch-all REST mirror of every socket resource, addressed as /api/live/agents/<id>. The web build uses the socket; this exists so a payload the browser received can be fetched with curl.',
  },
  '/api/live/resources': {
    reason: 'REST mirror of the socket resource table, for debugging a payload the browser received. Deliberately not a floor: it is a diagnostic.',
  },
  '/api/health': {
    reason: 'Liveness plus hive presence. The offline banner reads the socket stream instead, so this stays an operator probe.',
  },
  '/api/replay': {
    reason: 'Replays a recorded event window. F13 Time Machine renders recorded windows from the snapshot; this is the on-demand variant, kept for an operator asking for a specific range.',
  },
  '/api/stream': {
    reason: 'SSE fallback for the resource socket, used when EventSource is unavailable. A transport, not a surface.',
  },

  // ---- awaiting a floor ----
  '/api/recovery/stats': {
    reason: 'Recovery-system counters. Honest only alongside the recovery actions themselves, which the HUD deliberately does not expose yet.',
    surface: 'F9, beside the approval queue',
  },
  '/api/llm/rate-limits': {
    surface: 'F18, the Headroom section',
    reason: 'Drawn by the desk, and only after the route stopped answering res.json({}). It reports `unobserved` rather than a number, because the limiter substitutes a full bucket for any key it has never seen and keeps its key list private. The section draws no bar from that; it prints the reason.',
  },
  '/api/jarvis/audit': {
    surface: 'F18',
    reason: 'Drawn by the desk floor, and the route had to grow before it could be drawn honestly: it reports the read outcome alongside the events, so a partly-read log cannot be rendered as an empty history. F18 shows that outcome verbatim instead of summarising it.',
  },
  '/api/office/classification': {
    reason: 'Python-side classification of office data. Its output is a judgement about the fleet, so it is shown next to the fleet view that produced the inputs.',
    surface: 'F17, the fleet floor',
  },
  '/api/tournament': {
    reason: 'Strategy standings with a leader and a staleness field. Real data, and the most obviously useful unclaimed payload on the server.',
    surface: 'a trading floor (F6 or F8)',
  },
};

/** Every path served by a GET, with its stated consumer. */
function routeIntent() {
  return { ...INTENT };
}

/**
 * Is this path claimed by the web build?
 *
 * `referencedByWeb` is passed in as a predicate so this module stays free of
 * filesystem walking and the test owns that. Template-literal references count:
 * the web fetches `/api/agents/${id}`, which is the same route as the server's
 * `/api/agents/:id`, and a naive string compare would call that unclaimed.
 */
function classify(path, referencedByWeb) {
  if (referencedByWeb(path)) return { status: WEB };
  const intent = INTENT[path];
  if (intent) return { status: 'stated', ...intent };
  return { status: 'unstated' };
}

module.exports = { WEB, INTENT, routeIntent, classify, UNDECLARED_JOBS_COUNT: 4 };