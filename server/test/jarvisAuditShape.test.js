'use strict';
// /api/jarvis/audit must be able to say whether it looked.
//
// The route answered {"events": []}. Every other HUD route answers an envelope
// carrying enough to tell "nothing to report" from "I could not find out", and
// this one could not: a missing events.log, an unreadable one, a corrupt one, a
// log that was never written, and a log that genuinely holds no jarvis_command
// all produced the same byte-identical body. scripts/check_hud_route_honesty.py
// flagged it for exactly that reason and was right to.
//
// The empty it was actually returning was not even true. On the live hive,
// events.log was 11.6MB and contained exactly one real jarvis_command, emitted
// 2026-10-03T00:19:14Z at byte 87,695. The route reads a 512KB tail window that
// opens at byte 11,090,145, so the only command ever issued was nowhere in reach
// and the audit trail reported that the assistant had never been asked anything.
// The response was not merely ambiguous about whether it had looked -- it made a
// false claim about the history, and nothing in the payload allowed a caller to
// tell.
//
// These tests pin the four states apart, and pin that all four expose the same
// keys. The same-keys rule is the house convention from
// harnessHealthShape.test.js: a resource that changes shape depending on what went
// wrong is a HUD lying about its own contract, and any consumer that reads a
// field conditionally then renders a different thing per state.
//
// Every fixture is a throwaway hive from makeFixtureHive(); the real hive is never
// touched. Each case boots its own server, because eventCache is module scope and
// a second case must not inherit the first one's read.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { makeFixtureHive, loadServer, startTestServer } = require('./helpers/harness');

// The full envelope. Asserted by value rather than by count so that dropping a
// field is a failure instead of a shorter response that still passes a length check.
const EXPECTED_KEYS = [
  'checkedAt', 'count', 'error', 'events', 'limit', 'ok', 'reachable_window',
  'scanned', 'source', 'status', 'window',
];

/** Boot one server against one fixture hive and hand the response to fn. */
async function auditWith(hive, fn) {
  const http = await startTestServer(loadServer(hive).app);
  try {
    const res = await http.get('/api/jarvis/audit');
    assert.equal(res.status, 200,
      'every state answers 200; a 5xx would swap "cannot tell whether it looked" '
        + 'for "did not answer", and the payload still has to say which happened');
    assert.ok(res.json, `expected JSON, got: ${res.text.slice(0, 200)}`);
    return await fn(res.json);
  } finally {
    await http.close();
  }
}

/** Replace events.log with exactly these lines. */
function setEventsLog(hive, lines) {
  fs.writeFileSync(path.join(hive, 'events.log'), lines.map((l) => `${JSON.stringify(l)}\n`).join(''));
}

/** A jarvis_command row exactly as enqueueJarvisCommand emits one. */
function jarvisEvent(i, at) {
  return {
    type: 'jarvis_command',
    task_id: `jarvis-17909867547${i}-0c5c2${i}`,
    source: 'jarvis',
    route: 'JEV',
    actor: 'office-hud-local',
    target: i % 2 ? 'pm-signal' : null,
    requested_target: null,
    routing: null,
    priority: 'high',
    risk: 'normal',
    prompt_length: 5,
    prompt_hash: `hash${i}`,
    timestamp: at,
  };
}

const NOW = new Date().toISOString();

// --- (a) success with zero events ----------------------------------------

test('a readable log holding no jarvis_command is an honest empty, and says it looked', async () => {
  const fx = makeFixtureHive();
  try {
    await auditWith(fx.hive, (body) => {
      assert.equal(body.ok, true, 'the read succeeded, so this is not a failure');
      assert.equal(body.status, 'ok');
      assert.equal(body.error, null);
      assert.deepEqual(body.events, [], 'nothing was asked of the assistant, so no rows');
      assert.equal(body.count, 0);

      // The field that separates "looked and found none" from "had nothing to
      // look at". The fixture ships 22 events, all heartbeats and task
      // transitions, so a route that really searched has something to report
      // about the search.
      assert.ok(body.scanned > 0,
        `scanned must show the window was searched; got ${body.scanned}`);
      assert.equal(body.scanned, 22);
    });
  } finally {
    fx.cleanup();
  }
});

test('an empty events.log is success-with-no-data, not a failure', async () => {
  const fx = makeFixtureHive();
  try {
    fs.writeFileSync(path.join(fx.hive, 'events.log'), '');
    await auditWith(fx.hive, (body) => {
      assert.equal(body.ok, true, 'a readable file holding nothing is a truthful empty');
      assert.equal(body.status, 'empty');
      assert.equal(body.error, null);
      assert.equal(body.scanned, 0);
      assert.deepEqual(body.events, []);
      assert.equal(body.count, 0);
      assert.equal(body.window.source_bytes, 0);
    });
  } finally {
    fx.cleanup();
  }
});

// --- (b) underlying read failure -----------------------------------------

test('an events.log that cannot be read is reported as a failure, with the reason', async () => {
  const fx = makeFixtureHive();
  try {
    fs.unlinkSync(path.join(fx.hive, 'events.log'));
    await auditWith(fx.hive, (body) => {
      assert.equal(body.ok, false, 'the source could not be opened, so this is not an empty');
      assert.equal(body.status, 'unreadable');
      assert.match(String(body.error), /ENOENT/,
        'the reason the lookup failed is part of the answer');
      assert.deepEqual(body.events, [],
        'events stays an array on the failure branch so no consumer can crash on it');
      assert.equal(body.count, 0);
    });
  } finally {
    fx.cleanup();
  }
});

test('bytes that are not events are reported as a failure, not as an empty audit trail', async () => {
  const fx = makeFixtureHive();
  try {
    // Reachable by stat, readable, and containing no event at all. Reporting []
    // here would claim the assistant was never asked anything on the strength of
    // a corrupt file.
    fs.writeFileSync(path.join(fx.hive, 'events.log'), 'not json\nnor this\nnor this\n');
    await auditWith(fx.hive, (body) => {
      assert.equal(body.ok, false);
      assert.equal(body.status, 'unparsed');
      assert.match(String(body.error), /parsed/i);
      assert.equal(body.window.unparsed_lines, 3);
      assert.equal(body.scanned, 0);
      assert.deepEqual(body.events, []);
    });
  } finally {
    fx.cleanup();
  }
});

// --- (a) and (b) are genuinely different responses -----------------------

test('success-with-no-data and could-not-read are different responses', async () => {
  const good = makeFixtureHive();
  const broken = makeFixtureHive();
  let emptyBody;
  let brokenBody;
  try {
    emptyBody = await auditWith(good.hive, (b) => b);
    fs.unlinkSync(path.join(broken.hive, 'events.log'));
    brokenBody = await auditWith(broken.hive, (b) => b);

    // The whole point of the change: identical arrays, different meaning, and the
    // envelope is what tells them apart.
    assert.deepEqual(emptyBody.events, brokenBody.events);
    assert.notEqual(emptyBody.ok, brokenBody.ok);
    assert.notEqual(emptyBody.status, brokenBody.status);
    assert.notEqual(
      JSON.stringify({ ok: emptyBody.ok, status: emptyBody.status, scanned: emptyBody.scanned }),
      JSON.stringify({ ok: brokenBody.ok, status: brokenBody.status, scanned: brokenBody.scanned }),
      'a caller must be able to tell these apart without inspecting the log itself',
    );
  } finally {
    good.cleanup();
    broken.cleanup();
  }
});

test('every state exposes the same keys, so the shape never depends on what went wrong', async () => {
  const cases = [
    ['ok', (fx) => {}],
    ['empty', (fx) => fs.writeFileSync(path.join(fx.hive, 'events.log'), '')],
    ['unparsed', (fx) => fs.writeFileSync(path.join(fx.hive, 'events.log'), 'nope\n')],
    ['unreadable', (fx) => fs.unlinkSync(path.join(fx.hive, 'events.log'))],
  ];
  const seen = [];
  for (const [label, arrange] of cases) {
    const fx = makeFixtureHive();
    try {
      arrange(fx);
      // eslint-disable-next-line no-await-in-loop
      seen.push([label, await auditWith(fx.hive, (b) => b)]);
    } finally {
      fx.cleanup();
    }
  }

  for (const [label, body] of seen) {
    assert.deepEqual(Object.keys(body).sort(), EXPECTED_KEYS,
      `the ${label} branch must expose the whole envelope; a field present only on `
        + 'some branches breaks any consumer that reads it conditionally');
  }
  const statuses = seen.map(([label, body]) => [label, body.status]);
  assert.deepEqual(statuses.map(([l]) => l), statuses.map((_, i) => cases[i][0]),
    'each case must land in the state it was arranged to produce');
  assert.equal(new Set(statuses.map(([, s]) => s)).size, statuses.length,
    'the four states must be four distinct status values, not one value reused');
});

// --- (c) a real event list still comes through --------------------------

test('a real jarvis_command list still comes through, as an array on the envelope', async () => {
  const fx = makeFixtureHive();
  try {
    setEventsLog(fx.hive, [jarvisEvent(1, NOW), jarvisEvent(2, NOW), jarvisEvent(3, NOW)]);
    await auditWith(fx.hive, (body) => {
      assert.equal(body.ok, true);
      assert.equal(body.status, 'ok');
      assert.equal(body.count, 3, 'every row the window holds must be served');
      assert.equal(body.scanned, 3);
      assert.equal(body.error, null);
      assert.ok(Array.isArray(body.events), 'events remains an array, so the old field survives');

      // Newest first, which is the order the event cache reverses into and the
      // order the route has always served. Pinned so a change of order cannot
      // quietly repaint which command looks most recent.
      assert.deepEqual(
        body.events.map((e) => e.task_id),
        ['jarvis-179098675473-0c5c23', 'jarvis-179098675472-0c5c22', 'jarvis-179098675471-0c5c21'],
        'all three rows must come through, newest first',
      );

      const [first] = body.events;
      assert.equal(first.task_id, 'jarvis-179098675473-0c5c23');
      assert.equal(first.actor, 'office-hud-local');
      assert.equal(first.priority, 'high');
      assert.equal(first.risk, 'normal');
      assert.equal(first.prompt_length, 5);
      assert.equal(first.prompt_hash, 'hash3');
      assert.equal(first.timestamp, NOW);
      assert.equal(first.target, 'pm-signal');
      assert.equal(first.requested_target, null);
      assert.equal(first.routing, null);
    });
  } finally {
    fx.cleanup();
  }
});

test('limit caps the rows and is published, so a capped list is not read as the whole audit', async () => {
  const fx = makeFixtureHive();
  try {
    setEventsLog(fx.hive, [jarvisEvent(1, NOW), jarvisEvent(2, NOW), jarvisEvent(3, NOW)]);
    const http = await startTestServer(loadServer(fx.hive).app);
    try {
      const res = await http.get('/api/jarvis/audit?limit=2');
      assert.equal(res.status, 200);
      assert.equal(res.json.limit, 2);
      assert.equal(res.json.count, 2);
      assert.equal(res.json.scanned, 3,
        'scanned reports what the window held even when the list is capped');
    } finally {
      await http.close();
    }
  } finally {
    fx.cleanup();
  }
});

// --- the bounded window stays declared ----------------------------------

test('the bounded read is declared, so a capped window is never read as the full history', async () => {
  const fx = makeFixtureHive();
  try {
    // Comfortably past EVENT_TAIL_BYTES (512KB), which is the condition that made
    // the one real command on the live hive invisible.
    const many = [];
    for (let i = 0; i < 7000; i += 1) {
      many.push({ type: 'heartbeat', agent_id: 'worker-a', session_id: 'sess-1', timestamp: NOW, pad: 'x'.repeat(80) });
    }
    many.push(jarvisEvent(9, NOW));
    fs.writeFileSync(path.join(fx.hive, 'events.log'), many.map((e) => `${JSON.stringify(e)}\n`).join(''));

    await auditWith(fx.hive, (body) => {
      assert.equal(body.reachable_window, true,
        'this is a bounded tail read, not the whole history; say so on every response');
      assert.equal(body.window.limit_bytes, 512 * 1024);
      assert.equal(body.window.truncated, true,
        'the log is larger than the window, so history above it was never examined');
      assert.ok(body.window.source_bytes > body.window.read_bytes,
        'the bytes reported as read must be fewer than the bytes in the file');
      assert.equal(body.window.read_bytes, 512 * 1024);
      assert.equal(body.window.unparsed_lines, 0);
    });
  } finally {
    fx.cleanup();
  }
});

test('a log smaller than the window is not reported as truncated', async () => {
  const fx = makeFixtureHive();
  try {
    setEventsLog(fx.hive, [jarvisEvent(1, NOW)]);
    await auditWith(fx.hive, (body) => {
      assert.equal(body.window.truncated, false);
      assert.equal(body.source, 'events.log',
        'the source is named, the way /api/ledger names which store it read');
    });
  } finally {
    fx.cleanup();
  }
});
