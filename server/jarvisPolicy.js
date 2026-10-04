'use strict';
/**
 * The rules of a Jarvis command, with nothing in them that touches the disk.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Three separate copies of "is this command dangerous?" had drifted apart.
 *
 * The server had the authoritative list, and JarvisConsole.tsx carried its own
 * narrower copy in the browser. The client copy was missing clear, purge, erase,
 * overwrite, disable, enable, transfer, withdraw, deposit, buy and sell, so the
 * console showed a command as ordinary and the server then refused it with 428.
 * That is not a security hole -- the server still enforced -- but it is the UI
 * promising something the office would not do, which is the one thing this
 * codebase is trying to eliminate everywhere else.
 *
 * The client copy was also subtly broken on its own terms: it wrapped `rm\s` in
 * \b(...)\b, and a word boundary cannot follow a space, so the pattern intended
 * to catch `rm -rf` never matched it.
 *
 * So the rule now lives here, once, and both sides ask it. The stronger form of
 * the fix follows in jarvisPolicy's consumers: the browser does not re-derive
 * danger at all, it asks the server what the risk tier is, so there is nothing
 * left to drift.
 *
 * WHY IT IS PURE
 * --------------
 * evaluateJarvisCommand is what both the write path and the preview call, which
 * is the only reason a preview can be trusted to describe the write. If it read
 * the filesystem or generated an id it would drift from the write the moment the
 * queue state changed, so queue availability is passed in by the caller instead.
 */

const PRIORITIES = ['critical', 'high', 'normal', 'low'];
const TYPE_CONFIRMATION_WORD = 'EXECUTE';
const PROMPT_MIN = 3;
const PROMPT_MAX = 2000;

/**
 * Whether a prompt asks for something destructive enough to require the operator
 * to type EXECUTE before it can be queued.
 *
 * Carried over verbatim from server/index.js. The word list is deliberately
 * generous: a false positive costs the operator one word, a false negative costs
 * the guard its meaning. Widening it later is a one-line change here and now has
 * exactly one place to happen.
 */
function isDangerousJarvisPrompt(prompt) {
  return /\b(delete|remove|destroy|drop|kill|shutdown|stop|restart|reset|clear|purge|erase|overwrite|disable|enable|transfer|withdraw|deposit|buy|sell|force|password|secret|credential|private\s*key|live\s*trad(?:e|ing))\b/i.test(prompt)
    || /\b(rm|git\s+reset|place\s+(?:an?\s+)?order)\b/i.test(prompt);
}

/** Agent and floor identifiers: what a target may be named. */
function isIdentifier(value) {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value);
}

/**
 * Which agent a command goes to.
 *
 * Unchanged from index.js, including the deliberate part: an unmatched prompt
 * routes to whatever target was asked for, and only polymarket-shaped commands
 * are second-guessed. The router's job is to find the owner, not to second-guess
 * the operator's request.
 */
function routeJarvisCommand(prompt, requestedTarget) {
  const promptMatched = /\bpolymarket\b|market|\bpm\b/i.test(prompt);
  const targetMatched = !!requestedTarget && /^pm-/i.test(requestedTarget);
  if (!promptMatched && !targetMatched) {
    return { assignedAgent: requestedTarget, routing: null };
  }
  const target = requestedTarget ? requestedTarget.toLowerCase() : null;
  let resolvedTarget = target;
  let selector = 'explicit_target';
  if (!['pm-data', 'pm-signal', 'pm-risk'].includes(target)) {
    if (/\b(risk|loss|exposure|drawdown|position|portfolio|clear|stop|kill|trade|order)\b/i.test(prompt)) {
      resolvedTarget = 'pm-risk';
      selector = 'risk_intent';
    } else if (/\b(signal|predict|prediction|forecast|probability|odds|outcome|buy|sell|entry|exit)\b/i.test(prompt)) {
      resolvedTarget = 'pm-signal';
      selector = 'signal_intent';
    } else {
      resolvedTarget = 'pm-data';
      selector = 'market_data_intent';
    }
  }
  return {
    assignedAgent: resolvedTarget,
    routing: {
      domain: 'polymarket',
      prompt_matched: promptMatched,
      target_matched: targetMatched,
      requested_target: requestedTarget || null,
      resolved_target: resolvedTarget,
      selector,
    },
  };
}

/**
 * Judge a command's fields. Pure: no clock, no id, no filesystem.
 *
 * Returns ok:true with the normalized command when the fields are usable, and
 * ok:false with the FIRST field problem otherwise. First-problem ordering is
 * preserved from the write path on purpose -- a request that is both
 * unconfirmed and mis-prioritised has always answered with the priority, and
 * changing that would alter behaviour nobody asked to change.
 *
 * Confirmation is deliberately NOT judged here. Previewing is what an operator
 * does before confirming, so requiring confirmation inside the validator would
 * make the preview unable to describe the write it exists to describe. It is
 * reported as a requirement instead, and judged separately by acceptance().
 */
function evaluateJarvisCommand(input = {}) {
  const { prompt, target, priority } = input || {};

  if (typeof prompt !== 'string') {
    return { ok: false, statusCode: 400, reason: `prompt must be a string between ${PROMPT_MIN} and ${PROMPT_MAX} characters` };
  }
  const normalizedPrompt = prompt.trim();
  if (normalizedPrompt.length < PROMPT_MIN || normalizedPrompt.length > PROMPT_MAX) {
    return { ok: false, statusCode: 400, reason: `prompt must be between ${PROMPT_MIN} and ${PROMPT_MAX} characters` };
  }

  const normalizedPriority = priority === undefined ? 'high' : typeof priority === 'string' ? priority.trim().toLowerCase() : '';
  if (!PRIORITIES.includes(normalizedPriority)) {
    // Spelled out rather than joined from PRIORITIES, because this string is what
    // an operator reads when a floor rejects their command. The trailing "or" is
    // kept from the original message for the same reason: changing it would be a
    // behaviour change nobody asked for.
    return { ok: false, statusCode: 400, reason: 'priority must be critical, high, normal, or low' };
  }

  let normalizedTarget = null;
  if (target !== undefined && target !== null) {
    if (typeof target !== 'string') {
      return { ok: false, statusCode: 400, reason: 'target must be a valid agent or floor identifier' };
    }
    if (target.trim()) {
      normalizedTarget = target.trim();
      if (!isIdentifier(normalizedTarget)) {
        return { ok: false, statusCode: 400, reason: 'target must be a valid agent or floor identifier' };
      }
    }
  }

  const dangerous = isDangerousJarvisPrompt(normalizedPrompt);
  const routed = routeJarvisCommand(normalizedPrompt, normalizedTarget);
  return {
    ok: true,
    statusCode: null,
    reason: null,
    normalized: { prompt: normalizedPrompt, priority: normalizedPriority, target: normalizedTarget },
    risk: dangerous ? 'destructive' : 'normal',
    requiresTypeConfirmation: dangerous,
    assignedAgent: routed.assignedAgent,
    routing: routed.routing,
  };
}

/**
 * Whether an otherwise-valid command would be accepted for queueing, given what
 * the caller actually sent.
 *
 * Split from evaluateJarvisCommand so that preview can ask the field question
 * without a confirmed flag it does not have yet, and so the write path asks
 * both questions in the order it always did: fields, then confirmation, then
 * type-to-confirm.
 */
function acceptance(verdict, input = {}) {
  if (!verdict || !verdict.ok) {
    return { accepted: false, statusCode: verdict ? verdict.statusCode : 400, reason: verdict ? verdict.reason : 'command could not be read' };
  }
  const { confirmed, typeConfirmation } = input || {};
  if (confirmed !== true) {
    return { accepted: false, statusCode: 428, reason: 'explicit confirmation is required' };
  }
  if (verdict.requiresTypeConfirmation && typeConfirmation !== TYPE_CONFIRMATION_WORD) {
    return { accepted: false, statusCode: 428, reason: `type-to-confirm value ${TYPE_CONFIRMATION_WORD} is required for this command` };
  }
  return { accepted: true, statusCode: null, reason: null };
}

module.exports = {
  PRIORITIES,
  TYPE_CONFIRMATION_WORD,
  PROMPT_MIN,
  PROMPT_MAX,
  isDangerousJarvisPrompt,
  isIdentifier,
  routeJarvisCommand,
  evaluateJarvisCommand,
  acceptance,
};