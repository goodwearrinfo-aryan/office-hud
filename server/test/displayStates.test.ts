/**
 * The display-state truth contract.
 *
 * Each of these pins a way the office was able to describe its own people
 * inaccurately. They are cheap, they run in the normal suite, and without them
 * the next panel added will reintroduce at least one of them.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DISPLAY_STATES,
  UNKNOWN_COLOR,
  countByDisplay,
  describeRoster,
  isKnownDisplay,
  reachableCount,
  statusColorFor,
} from '../../web/src/displayStates.ts';

const agent = (display: string) => ({ display });

test('every state the server can emit is known here', () => {
  // server/index.js displayOrder. If the server grows a state this test fails,
  // which is the point: the union in api.ts is what made `stale` unrepresentable.
  assert.deepEqual([...DISPLAY_STATES], ['busy', 'idle', 'stale', 'breaker', 'offline']);
  for (const s of DISPLAY_STATES) assert.ok(isKnownDisplay(s), `${s} should be known`);
});

test('stale is not offline, and neither is any other state', () => {
  const colors = DISPLAY_STATES.map(statusColorFor);
  assert.equal(new Set(colors).size, colors.length, 'each state needs its own colour');
});

test('an unrecognised state is grey and flagged, never another state colour', () => {
  assert.equal(statusColorFor('hibernating'), UNKNOWN_COLOR);
  assert.equal(isKnownDisplay('hibernating'), false);
  // The failure this prevents: an unknown state quietly rendering as idle.
  assert.notEqual(statusColorFor('hibernating'), statusColorFor('idle'));
});

test('the roster line adds up to the headcount', () => {
  const roster = [
    agent('busy'), agent('busy'), agent('idle'), agent('stale'),
    agent('breaker'), agent('offline'), agent('offline'),
  ];
  const line = describeRoster(roster);
  assert.match(line, /2 busy/);
  assert.match(line, /1 idle/);
  assert.match(line, /1 stale/);
  assert.match(line, /1 breaker/);
  assert.match(line, /2 offline/);
  assert.match(line, /7 workers$/, 'the total must close the line');
});

test('an unrecognised state is named in the roster, not dropped', () => {
  const line = describeRoster([agent('busy'), agent('hibernating')]);
  assert.match(line, /1 hibernating \(NOT RECOGNISED\)/);
  assert.match(line, /2 workers$/, 'it still counts toward the headcount');
});

test('states absent from the roster are omitted rather than shown as zero', () => {
  const line = describeRoster([agent('busy'), agent('idle')]);
  assert.doesNotMatch(line, /breaker/, 'a state with nobody in it is not news');
  assert.match(line, /2 workers$/);
});

test('an empty roster says so instead of rendering an empty line', () => {
  assert.equal(describeRoster([]), 'no workers');
});

test('reachable excludes offline and breaker, not merely offline', () => {
  const roster = [
    agent('busy'), agent('idle'), agent('stale'), agent('breaker'), agent('offline'),
  ];
  // A stale agent has a session; it is quiet, not gone. It stays reachable.
  assert.equal(reachableCount(roster), 3);
  assert.equal(countByDisplay(roster).stale, 1);
});

test('countByDisplay and describeRoster agree on the total', () => {
  const roster = [agent('busy'), agent('stale'), agent('stale'), agent('weird')];
  const counts = countByDisplay(roster);
  const summed = Object.values(counts).reduce((a, b) => a + b, 0);
  assert.equal(summed, roster.length);
  assert.match(describeRoster(roster), new RegExp(`${roster.length} workers$`));
});