'use strict';
// Tournament routes on the Office HUD.
//
// These were added so the tournament is visible from the HUD origin with NO
// password. The pubserver (:3002) deliberately guards its dashboards with a
// shared secret, so linking there from the HUD would prompt; the HUD reads the
// same feed itself instead. No pubserver auth exemption is involved.
//
// Two things this pins down, both of which were wrong on the first attempt:
//   - the feed is ui/public/tournament.json, NOT fleet-state/tournament.json
//     (that one is the large per-strategy state file with no ts/strategies)
//   - `ts` is timezone-aware UTC, so staleness is real, not ~5.5h out
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { makeFixtureHive, loadServer, startTestServer } = require('./helpers/harness');

const feeds = fs.mkdtempSync(path.join(os.tmpdir(), 'hud-feeds-'));
process.env.OPENALICE_FEEDS_DIR = feeds;

const HOUR_AGO = new Date(Date.now() - 3600 * 1000).toISOString();
const NOW = new Date().toISOString();

function writeFeed(contents) {
  fs.writeFileSync(path.join(feeds, 'tournament.json'), JSON.stringify(contents));
}

const GOOD_FEED = {
  ts: NOW,
  btc: 85030.41,
  eth: 2709.67,
  cycles: 7829,
  leader: 'trend_btc_1h',
  strategies: [
    { name: 'trend_btc_1h', return_pct: 22.57 },
    { name: 'carry_eth', return_pct: -11.88 },
  ],
};

writeFeed(GOOD_FEED);
const server = loadServer(makeFixtureHive().hive);
let http;

test.before(async () => {
  http = await startTestServer(server.app);
});

test.after(async () => {
  // The HUD server keeps timers/sockets alive, so the runner will not exit until
  // the listener is closed. Without this the file hangs instead of failing.
  await http?.close();
  fs.rmSync(feeds, { recursive: true, force: true });
});

test('GET /api/tournament returns the feed with a real age', async () => {
  const { status, json } = await http.get('/api/tournament');
  assert.equal(status, 200);
  assert.equal(json.ok, true);
  assert.equal(json.btc, 85030.41);
  assert.equal(json.cycles, 7829);
  assert.equal(json.leader, 'trend_btc_1h');
  assert.equal(json.strategies.length, 2);
  // A tz-aware UTC ts must give a small, non-negative age.
  assert.ok(json.ageS >= 0, `age should not be negative, got ${json.ageS}`);
  assert.ok(json.ageS < 120, `feed written seconds ago, got ${json.ageS}`);
  assert.equal(json.stale, false);
});

test('GET /api/tournament flags a stale feed', async () => {
  writeFeed({ ...GOOD_FEED, ts: HOUR_AGO });
  const { status, json } = await http.get('/api/tournament');
  assert.equal(status, 200);
  assert.equal(json.stale, true);
  assert.ok(json.ageS > json.staleAfterS);
  writeFeed(GOOD_FEED);
});

test('a malformed ts cannot read as fresh', async () => {
  writeFeed({ ...GOOD_FEED, ts: 'not-a-timestamp' });
  const { json } = await http.get('/api/tournament');
  assert.equal(json.stale, true, 'unparseable ts must fall back to mtime, not pass');
  writeFeed(GOOD_FEED);
});

test('GET /api/tournament 503s when the feed is missing', async () => {
  fs.rmSync(path.join(feeds, 'tournament.json'));
  const { status } = await http.get('/api/tournament');
  assert.equal(status, 503);
  writeFeed(GOOD_FEED);
});

test('GET /tournament renders without a password', async () => {
  const { status, text } = await http.get('/tournament');
  assert.equal(status, 200);
  assert.match(text, /<html/i);
  assert.match(text, /no password/);
  assert.match(text, /trend_btc_1h/);
  assert.match(text, /carry_eth/);
  // returns are rendered with a sign
  assert.match(text, /\+22\.57%/);
  assert.match(text, /-11\.88%/);
  // negatives get the neg class, positives the pos class
  assert.match(text, /class="pos">\+22\.57%/);
  assert.match(text, /class="neg">-11\.88%/);
});

test('tournament page needs no Authorization header', async () => {
  // Explicit: the whole point is that this route is not behind the shared secret.
  const { status } = await http.get('/tournament', { headers: {} });
  assert.equal(status, 200);
});

test('GET /tournament shows a STALE banner when the feed is old', async () => {
  writeFeed({ ...GOOD_FEED, ts: HOUR_AGO });
  const { text } = await http.get('/tournament');
  assert.match(text, /STALE/);
  writeFeed(GOOD_FEED);
});

test('feed is read from ui/public, not the fleet-state file', () => {
  // Guards the bug that made the first version render zeros.
  const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  assert.match(src, /OPENALICE_FEEDS_DIR/);
  const fedDir = src.split('const FLEET_FEEDS_DIR')[1] || '';
  assert.match(fedDir.split('const TOURNAMENT_FEED')[0], /ui.*public|'public'/);
});

// ---------- launcher injection (no rebuild required) ----------
// A bug fix or betterment must not depend on `npm run build`. The launcher is
// injected into the served shell, so it takes effect on a server restart even
// though web/dist is a hashed Vite build that is deliberately left untouched.

test('injectHudLauncher adds the launcher exactly once', () => {
  const html = '<!doctype html><html><body><div id="root"></div></body></html>';
  const once = server.internals.injectHudLauncher(html);
  assert.match(once, /hud:tournament-launcher/);
  assert.match(once, /href="\/tournament"/);
  // Idempotent: a second pass must not duplicate the snippet.
  const twice = server.internals.injectHudLauncher(once);
  assert.equal((twice.match(/hud:tournament-launcher/g) || []).length,
    (once.match(/hud:tournament-launcher/g) || []).length);
});

test('injectHudLauncher leaves non-HTML and marker-less bodies alone', () => {
  assert.equal(server.internals.injectHudLauncher('not html'), 'not html');
  assert.equal(server.internals.injectHudLauncher(''), '');
  assert.equal(server.internals.injectHudLauncher(null), null);
});

test('launcher markup has no CSS typos and no innerHTML use', () => {
  const snippet = server.internals.hudLauncherSnippet();
  assert.doesNotMatch(snippet, /considerable/);
  // Feed-derived text must be assigned as text, never parsed as HTML.
  assert.doesNotMatch(snippet, /innerHTML/);
  assert.match(snippet, /textContent/);
});

test('GET / injects the launcher and keeps the SPA shell', async () => {
  const { status, text } = await http.get('/');
  assert.equal(status, 200);
  assert.match(text, /<div id="root"><\/div>/);
  assert.match(text, /hud:tournament-launcher/);
  // The hashed bundle must still be referenced, or the app would not boot.
  assert.match(text, /\/assets\/index-[A-Za-z0-9_-]+\.js/);
});

test('the SPA deep-link fallback also injects the launcher', async () => {
  const { status, text } = await http.get('/legs.html');
  assert.equal(status, 200);
  assert.match(text, /hud:tournament-launcher/);
});

test('web/dist is not modified by injection (no rebuild)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  // Injection must be done in-memory at request time, never written to disk.
  assert.doesNotMatch(src, /writeFileSync\([^)]*dist[^)]*index\.html/);
  const distIndex = path.join(__dirname, '..', 'web', 'dist', 'index.html');
  if (fs.existsSync(distIndex)) {
    const onDisk = fs.readFileSync(distIndex, 'utf8');
    assert.doesNotMatch(onDisk, /hud:tournament-launcher/,
      'dist must stay pristine so no rebuild is required');
  }
});
