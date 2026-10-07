/**
 * The frozen-feeds route, isolated so it cannot be lost to a file rewrite.
 *
 * Six feeds in ui/public/ are declared retired but the files are still there,
 * so the audit reports RETIRED_BUT_PRESENT. They are not garbage: they are the
 * last known state of a strategy, a pair book, a validation run. Deleting them
 * destroys evidence. Leaving them in a served directory without saying how old
 * they are is the other failure - a reader trusts a file that looks live.
 *
 * So this route does the honest middle thing: it publishes each deliberately
 * frozen feed WITH ITS AGE, so a panel can say "35d old" instead of implying
 * the data is current. That is the contract the feed-lifecycle registry's
 * `deliberately_static` lifecycle requires - the consumer surfaces the age - and
 * this is that consumer.
 *
 * It lives outside index.js for the same reason live_digest_route.js does: a
 * 3600-line file that multiple live sessions rewrite has already swallowed four
 * routes. Expressing it here means a rewrite of index.js cannot silently undo
 * it; mounting it stays a one-line change.
 *
 * THIS MODULE NAMES NO FEED. The list comes from the registry, which is data.
 * A hardcoded name here would (a) go stale the moment a feed is added and
 * (b) make this file a "consumer" of that feed in the audit's own text search,
 * which would quietly turn an honest orphan into a false all-clear.
 *
 * Truth over appearance: a missing registry is a named 503, never an empty 200.
 * "Nothing is declared frozen" and "I could not read the registry" are different
 * facts, and a panel that cannot tell them apart is how a HUD starts lying.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const REGISTRY_PATH = process.env.FEED_LIFECYCLE_REGISTRY || path.join(os.homedir(), 'trading', 'openalice-fleet', 'research', 'feed-lifecycle', 'registry.json');
const FEED_DIR = process.env.OPEN_UI_PUBLIC_DIR || path.join(os.homedir(), 'trading', 'openalice', 'ui', 'public');

// A feed older than this is presented as a day count rather than hours, because
// "29h" reads as recent and these are frozen by design. The number is still
// age_seconds; this only changes the unit a human reads.
const DAY_SECONDS = 86400;

function readRegistry(registryPath) {
  const raw = fs.readFileSync(registryPath, 'utf8');
  const parsed = JSON.parse(raw);
  return (parsed && parsed.feeds) || {};
}

/**
 * A human-readable age that never rounds DOWN into looking fresher than it is.
 * Truncating 35.3 days to "35d" understates by almost a day; floor-to-day is
 * still the least-wrong direction for a frozen feed, and age_seconds travels
 * alongside so nothing depends on the string.
 */
function ageLabel(ageSeconds) {
  if (ageSeconds < 0) return 'clock skew';
  if (ageSeconds < 60) return `${Math.floor(ageSeconds)}s`;
  if (ageSeconds < 3600) return `${Math.floor(ageSeconds / 60)}m`;
  if (ageSeconds < DAY_SECONDS) return `${Math.floor(ageSeconds / 3600)}h`;
  return `${Math.floor(ageSeconds / DAY_SECONDS)}d`;
}

/**
 * The frozen feeds, straight from the registry.
 *
 * Returns { registryMissing, feeds }. feeds is [] when the registry is readable
 * but declares nothing frozen - which is a real, reportable state, not an error.
 */
function collectFrozenFeeds(options) {
  const opts = options || {};
  const registryPath = opts.registryPath || REGISTRY_PATH;
  const feedDir = opts.feedDir || FEED_DIR;
  const nowMs = typeof opts.nowMs === 'number' ? opts.nowMs : Date.now();

  let registry;
  try {
    registry = readRegistry(registryPath);
  } catch (err) {
    return { registryMissing: true, error: String(err && err.message || err), feeds: [] };
  }

  const feeds = [];
  for (const [feed, entry] of Object.entries(registry)) {
    if (!entry || entry.lifecycle !== 'deliberately_static') continue;
    let stat = null;
    try {
      stat = fs.statSync(path.join(feedDir, feed));
    } catch {
      stat = null; // declared frozen but the file is gone: that is a real fact
    }
    const ageSeconds = stat ? Math.max(0, Math.round((nowMs - stat.mtimeMs) / 1000)) : null;
    feeds.push({
      feed,
      present: Boolean(stat),
      bytes: stat ? stat.size : null,
      age_seconds: ageSeconds,
      age_label: ageSeconds === null ? null : ageLabel(ageSeconds),
      reason: entry.reason || null,
      // The field a consumer should surface so the UI can explain the age.
      age_field: entry.age_field || null,
      // Never let a panel present one of these as current. It is a constant
      // field rather than a hint, so a renderer has to be wrong on purpose.
      frozen: true,
    });
  }
  feeds.sort((a, b) => a.feed.localeCompare(b.feed));
  return { registryMissing: false, feeds };
}

function register(app) {
  if (typeof app.get !== 'function') {
    throw new TypeError('frozen_feeds_route.register expects an express-like app');
  }
  app.get('/api/frozen-feeds', (_req, res) => {
    const result = collectFrozenFeeds();
    if (result.registryMissing) {
      // Named failure. An empty 200 here would read as "nothing is frozen",
      // which is a different and wrong claim.
      return res.status(503).json({
        error: 'feed lifecycle registry unreadable',
        detail: result.error,
        registry_path: REGISTRY_PATH,
      });
    }
    return res.json({
      generated_at: new Date().toISOString(),
      frozen_count: result.feeds.length,
      // Invariant a test can assert and a renderer can rely on: nothing in
      // this payload is presented as live.
      all_frozen: result.feeds.every((f) => f.frozen === true),
      feeds: result.feeds,
    });
  });
}

module.exports = {
  register,
  collectFrozenFeeds,
  ageLabel,
  readRegistry,
  REGISTRY_PATH,
  FEED_DIR,
  DAY_SECONDS,
};
