'use strict';
// Truthful completion labels for the task view.
//
// The problem, measured on the live payload: 601 tasks report status COMPLETE,
// and only 419 of them are evidenced work. 86 carry engagement.verdict
// OFF_TOPIC -- the response check's own words were "no task-relevant vocabulary
// and no structural evidence" -- 95 are ENGAGED on a score below 0.9, and 1 has
// no verification record at all. That is 30% of the completed column shown as
// completed.
//
// Why the pipeline is not changed here. `hive/scripts/continuous_feed_daemon.py`
// already calls classify_engagement() and already knows the answer: it appends
// OFF_TOPIC tasks to a list and logs "OK verdict but no task engagement", then
// writes verdict:'OK' regardless. So the signal is computed, recorded and
// discarded. Flipping those 86 verdicts is a product decision with a requeue and
// quarantine blast radius, not a display fix, and it belongs to whoever owns the
// task pipeline.
//
// The brief asks the HUD not to mark work completed without evidence, and it
// carries its own rule for missing data: show NOT VERIFIED. Every fact needed is
// already in the payload -- verified.engagement.verdict is present on 600 of the
// 601 -- so the HUD can stop overstating these without the pipeline changing at
// all. That is all this module does: label, never mutate.
//
// It lives in its own file rather than inside server/index.js for the same
// reason processTruth.js does: a guard written inside index.js can be removed by
// a rewrite that never sees it. A module plus the tests that import it survives
// that. index.js is also being actively rewritten by another session, so adding
// a file is the only way to land this without a write war.

const EVIDENCE_SCORE_FLOOR = 0.9;

// Ordered worst-first, because the label must reflect the strongest objection.
// A task that is both OFF_TOPIC and low-scoring is NOT VERIFIED, not "weak".
const TRUTH = {
  UNVERIFIED: 'UNVERIFIED',   // no verification record exists
  OFF_TOPIC: 'OFF_TOPIC',     // its own evidence check rejected the response
  WEAK: 'WEAK',               // engaged, but on a thin signal
  EVIDENCED: 'EVIDENCED',     // engaged and scored at or above the floor
};

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Classify one task. Pure: reads the record, returns a verdict, changes nothing.
 *
 * Returns:
 *   { raw, truth, label, reason, score, engagement }
 *
 * `raw` is the status exactly as stored, so the label can always be traced back
 * to what the pipeline actually said. Nothing is inferred from a missing field:
 * a task with no verified object is UNVERIFIED, never assumed good.
 */
function classifyTaskTruth(task) {
  if (!isPlainObject(task)) {
    return {
      raw: null,
      truth: TRUTH.UNVERIFIED,
      label: 'NOT VERIFIED',
      reason: 'task record is not an object',
      score: null,
      engagement: null,
    };
  }

  const raw = typeof task.status === 'string' ? task.status : null;
  const v = task.verified;

  // A task that is not complete makes no completion claim, so there is nothing
  // to substantiate. Label it by its own raw state and stop.
  const complete = typeof raw === 'string' && raw.toUpperCase() === 'COMPLETE';
  if (!complete) {
    return {
      raw,
      truth: null,
      label: raw || 'UNKNOWN',
      reason: 'not a completed task, so no completion claim to evidence',
      score: null,
      engagement: null,
    };
  }

  if (!isPlainObject(v)) {
    return {
      raw,
      truth: TRUTH.UNVERIFIED,
      label: 'COMPLETE / NOT VERIFIED',
      reason: 'no verification record exists for a completed task',
      score: null,
      engagement: null,
    };
  }

  const engagement = isPlainObject(v.engagement)
    ? (typeof v.engagement.verdict === 'string' ? v.engagement.verdict : null)
    : null;
  const score = typeof v.score === 'number' ? v.score : null;
  const reasons = (isPlainObject(v.engagement) && Array.isArray(v.engagement.reasons))
    ? v.engagement.reasons
    : [];

  if (engagement === 'OFF_TOPIC') {
    return {
      raw,
      truth: TRUTH.OFF_TOPIC,
      label: 'COMPLETE / NOT VERIFIED',
      reason: reasons[0]
        || 'the response check found no task-relevant vocabulary and no structural evidence',
      score,
      engagement,
    };
  }

  if (score === null) {
    return {
      raw,
      truth: TRUTH.UNVERIFIED,
      label: 'COMPLETE / NOT VERIFIED',
      reason: 'verification record carries no score, so the claim cannot be weighed',
      score: null,
      engagement,
    };
  }

  if (score < EVIDENCE_SCORE_FLOOR) {
    return {
      raw,
      truth: TRUTH.WEAK,
      label: 'COMPLETE / WEAK EVIDENCE',
      reason: 'engaged, but the evidence score is below the floor',
      score,
      engagement,
    };
  }

  return {
    raw,
    truth: TRUTH.EVIDENCED,
    label: 'COMPLETE',
    reason: 'engaged with the task and scored at or above the evidence floor',
    score,
    engagement,
  };
}

/**
 * Summarise a task list. Never returns a bare completion count, because a bare
 * count is the number that made this problem invisible.
 */
function summarizeTasks(tasks) {
  const list = Array.isArray(tasks) ? tasks : [];
  const counts = {
    total: list.length,
    complete_claimed: 0,
    evidenced: 0,
    weak: 0,
    off_topic: 0,
    unverified: 0,
    not_complete: 0,
  };
  const byAgent = new Map();

  for (const t of list) {
    const r = classifyTaskTruth(t);
    if (!r.truth) {
      counts.not_complete += 1;
      continue;
    }
    counts.complete_claimed += 1;
    if (r.truth === TRUTH.EVIDENCED) counts.evidenced += 1;
    else if (r.truth === TRUTH.WEAK) counts.weak += 1;
    else if (r.truth === TRUTH.OFF_TOPIC) counts.off_topic += 1;
    else counts.unverified += 1;

    if (r.truth !== TRUTH.EVIDENCED) {
      const who = (isPlainObject(t) && t.assigned_agent) || 'unassigned';
      byAgent.set(who, (byAgent.get(who) || 0) + 1);
    }
  }

  const unsupported = counts.complete_claimed - counts.evidenced;
  const share = counts.complete_claimed
    ? unsupported / counts.complete_claimed
    : 0;

  return {
    ...counts,
    unsupported_completions: unsupported,
    unsupported_share: Number(share.toFixed(4)),
    // One sentence a human can read without trusting the counts.
    statement:
      `${counts.evidenced} of ${counts.complete_claimed} completed tasks are `
      + `evidenced work; ${unsupported} `
      + `(${(share * 100).toFixed(0)}%) are not.`,
    worst_offenders: [...byAgent.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([agent, n]) => ({ agent, unsupported: n })),
  };
}

module.exports = {
  EVIDENCE_SCORE_FLOOR,
  TRUTH,
  classifyTaskTruth,
  summarizeTasks,
};
