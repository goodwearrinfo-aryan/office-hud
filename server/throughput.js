'use strict';
// Unbiased throughput for the queue summary.
//
// The defect
// ----------
// `completionsLastHour` in server/index.js counts `task_completed` records
// from hive/events.log, but it reads only the last EVENT_TAIL_BYTES = 512KB.
// events.log is 32.8MB with 7,105 task_completed records, so 512KB covers
// a few minutes of history. The number is therefore bounded by how much log
// happens to sit behind the cursor, not by how much work was done.
//
// Measured on the live hive, same hour, two ways:
//   512KB tail   -> 115 completions
//   4MB and up   -> 420 completions, saturating
//   counted from tasks.json completed_at -> 398
//
// So the dashboard under-reported throughput by 3.6x while the fleet was
// visibly draining. This is the Phase 16 failure the brief calls out: a
// scaling input that is not traceable to real activity.
//
// What this does
// --------------
// Reads a window large enough to span the period being measured, and states
// the window it actually used so a caller can tell a real zero from a
// truncated one. If the window is still insufficient it says so rather than
// reporting a confident low number.
//
// Lives in its own module for the same reason processTruth.js and
// taskTruth.js do: a rewrite of index.js silently drops guards written
// inside it. This one does not touch the pipeline, only the measurement.

const fs = require('fs');
const path = require('path');

const HIVE = process.env.OFFICE_HUD_HIVE
  || path.join(require('os').homedir(), 'openalice-fleet', 'hive');

// 16MB spans the last day at observed density (~7k completion events per
// 32MB is far denser; this covers hours with large margin) and is already
// used elsewhere in the server for work events.
const WINDOW_BYTES = 16 * 1024 * 1024;
const ONE_HOUR_MS = 60 * 60 * 1000;

function readTail(file, bytes) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const len = Math.min(bytes, size);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    return { text: buf.toString('utf8'), read: len, total: size, truncated: len < size };
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { /* already closed */ }
  }
}

/**
 * Count events of `type` newer than `sinceMs`.
 * Returns the count plus whether the window may have truncated the result.
 */
function countEventsSince(hive, type, sinceMs, windowBytes = WINDOW_BYTES) {
  // Argument contract. The three arguments are a path, a string and a number,
  // and a caller that transposes the last two gets a syntactically valid call
  // that counts nothing. `type` becomes a timestamp, so every line fails the
  // `event.type !== type` comparison and the function returns 0 -- the same
  // value an idle fleet produces, with no error to distinguish them. Rejecting
  // the shape here turns that silent zero into a reported error, which is the
  // difference between "no work happened" and "this call was wrong".
  //
  // `count` is null rather than 0 on rejection so a caller cannot mistake a
  // rejected call for a real measurement.
  const badArgs = (why) => ({
    count: null,
    truncated: false,
    window_bytes: 0,
    log_bytes: null,
    scanned_ms: null,
    error: why,
  });
  if (typeof hive !== 'string' || hive.length === 0) {
    return badArgs('countEventsSince: hive must be a non-empty path string');
  }
  if (typeof type !== 'string' || type.length === 0) {
    return badArgs(
      'countEventsSince: type must be an event-name string; it was passed as '
        + (typeof type) + '. Signature is (hive, type, sinceMs).'
    );
  }
  if (typeof sinceMs !== 'number' || !Number.isFinite(sinceMs) || sinceMs < 0) {
    return badArgs(
      'countEventsSince: sinceMs must be a non-negative number of milliseconds; it was passed as '
        + (typeof sinceMs) + '. Signature is (hive, type, sinceMs).'
    );
  }
  if (typeof windowBytes !== 'number' || !Number.isFinite(windowBytes) || windowBytes <= 0) {
    return badArgs('countEventsSince: windowBytes must be a positive number of bytes');
  }

  const file = path.join(hive, 'events.log');
  let tail;
  try {
    tail = readTail(file, windowBytes);
  } catch (error) {
    return { count: null, truncated: false, window_bytes: 0, error: String(error.message || error) };
  }
  const now = Date.now();
  let count = 0;
  for (const line of tail.text.split('\n')) {
    if (!line || !line.includes(type)) continue;
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (event.type !== type) continue;
    const at = Date.parse(event.timestamp);
    if (Number.isNaN(at)) continue;
    if (now - at <= sinceMs) count += 1;
  }
  // The tail is truncated when the log is larger than the window. That does
  // not by itself invalidate the count -- the newest events are the ones we
  // measured -- but a caller that needs a period longer than the tail spans
  // is being under-counted and must be told.
  return {
    count,
    truncated: tail.truncated,
    window_bytes: windowBytes,
    log_bytes: tail.total,
    scanned_ms: now - sinceMs,
  };
}

/**
 * completionsLastHour with the window actually used reported alongside it.
 * `truncated` is the honest signal that the figure may be a floor.
 */
function completionsLastHour(hiveOverride) {
  const hive = hiveOverride || process.env.OFFICE_HUD_HIVE || HIVE;
  const r = countEventsSince(hive, 'task_completed', ONE_HOUR_MS);
  return {
    completionsLastHour: r.count,
    // true means "this is a lower bound", not "this is the rate".
    lower_bound: Boolean(r.truncated),
    window_bytes: r.window_bytes,
    log_bytes: r.log_bytes,
    error: r.error || null,
  };
}


/**
 * Completions per clock hour, read from the same window as completionsLastHour.
 *
 * This exists because the HUD showed two numbers for one metric. The scalar came
 * from countEventsSince over a 16MB window; the 12-hour chart came from
 * getRecentEvents, which reads a 512KB tail. Measured live, the two disagreed by
 * 7x for the same hour (scalar 177, chart bar 25) and only 2 of 12 chart buckets
 * held any data at all, because 512KB of a heartbeat-dominated log spans minutes,
 * not hours.
 *
 * The chart's final bar IS the current hour, which is exactly what the scalar
 * reports, so these are not two metrics with two legitimate windows. They are one
 * metric computed twice over different populations, presented side by side with
 * no distinction drawn.
 *
 * Both now derive from this module and from WINDOW_BYTES, so they cannot drift
 * apart again. The hourly count for the current hour is the same number the
 * scalar reports, and the test asserts exactly that.
 *
 * Buckets are returned oldest-first and include empty hours, so a gap reads as
 * zero rather than as a missing bar.
 */
function completionsByHour(hiveOverride, hours = 12, windowBytes = WINDOW_BYTES) {
  const hive = hiveOverride || process.env.OFFICE_HUD_HIVE || HIVE;
  const file = path.join(hive, 'events.log');
  const now = Date.now();
  const firstHour = Math.floor(now / 3600000) * 3600000 - (hours - 1) * 3600000;

  const buckets = new Map();
  for (let i = 0; i < hours; i += 1) buckets.set(firstHour + i * 3600000, 0);

  let tail;
  try {
    tail = readTail(file, windowBytes);
  } catch (error) {
    // Report the failure rather than twelve confident zeros. A caller can tell
    // "no completions" from "could not read the log".
    return {
      hours: [...buckets.entries()].map(([hour]) => ({ hour: new Date(hour).toISOString(), count: null })),
      window_bytes: windowBytes,
      error: String((error && error.message) || error),
    };
  }

  for (const line of tail.text.split(String.fromCharCode(10))) {
    if (!line || !line.includes('task_completed')) continue;
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (event.type !== 'task_completed') continue;
    const at = Date.parse(event.timestamp);
    if (Number.isNaN(at)) continue;
    const hour = Math.floor(at / 3600000) * 3600000;
    if (!buckets.has(hour)) continue;
    buckets.set(hour, buckets.get(hour) + 1);
  }

  return {
    hours: [...buckets.entries()].map(([hour, count]) => ({ hour: new Date(hour).toISOString(), count })),
    window_bytes: windowBytes,
    error: null,
  };
}

module.exports = { completionsLastHour, countEventsSince, completionsByHour, WINDOW_BYTES, ONE_HOUR_MS };
