'use strict';

// Guards against the failure mode where a component is replaced by a
// `return null` stub. The whole web UI was gutted that way once: every floor
// and panel became a four-line stub, and `tsc` stayed green because the stubs
// cast `as unknown as T`. A type-checker cannot see a deleted UI, and no test
// read these files, so nothing complained until the HUD rendered blank.
//
// These are source-read assertions, not rendering tests. There is no jsdom or
// react-testing-library in this repo yet, so "does it still render" is checked
// structurally: the component must carry real substance, must actually render,
// and must not return null unconditionally.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const COMPONENTS = path.join(__dirname, '..', '..', 'web', 'src', 'components');

function read(name) {
  const file = path.join(COMPONENTS, `${name}.tsx`);
  assert.ok(fs.existsSync(file), `${name}.tsx must exist at ${file}`);
  return fs.readFileSync(file, 'utf8');
}

// A component is "gutted" when its whole render collapses to null. Conditional
// guards are legitimate and common (`if (!data) return null;`), so this looks
// for a `return null` that is NOT inside an if/guard -- i.e. a bare one that
// terminates the render path.
function hasUnconditionalNullReturn(source) {
  return /(^|\n)\s*return null;\s*(\n|$)/.test(source) && !/if\s*\([^)]*\)\s*return null/.test(source);
}

// The floor and panel components with no test coverage before this file. Every
// entry is asserted so a future gut is caught at the gate rather than in the
// browser.
const COMPONENTS_WITH_COVERAGE = [
  ['FloorNav', 80],
  ['DeskFloor', 120],
  ['FleetFloor', 120],
  ['ActivityBoard', 80],
  ['OfficeScene', 80],
  ['AgentDrawer', 80],
  ['LiveTrading', 60],
  ['RiskMetrics', 60],
  ['Charts', 80],
  ['TimeMachine', 120],
  ['AutonomyPanel', 100],
  ['KnowledgeGraph', 80],
  ['CombinedPortfolioPanel', 80],
  ['ValidationFloor', 100],
  ['CommandPalette', 100],
  ['SessionsPanel', 60],
  ['AlertRail', 40],
  ['ExportButton', 20],
  ['GlobalSearch', 50],
];

test('every floor and panel component still has real substance', () => {
  for (const [name, minLines] of COMPONENTS_WITH_COVERAGE) {
    const source = read(name);
    const lines = source.split('\n').length;
    assert.ok(
      lines >= minLines,
      `${name}.tsx is ${lines} lines, below the ${minLines}-line floor — it may have been replaced by a stub`,
    );
    assert.ok(
      /export (function|const) \w+/.test(source) || /export default/.test(source),
      `${name}.tsx must still export a component`,
    );
  }
});

test('no floor or panel component renders an unconditional null', () => {
  for (const [name] of COMPONENTS_WITH_COVERAGE) {
    const source = read(name);
    assert.ok(
      !hasUnconditionalNullReturn(source),
      `${name}.tsx has a bare \`return null;\` — this is the gutted-component shape that blanked the HUD`,
    );
    // Real components build JSX. A stub with no JSX cannot render anything.
    assert.ok(
      /<[A-Za-z][\w.]*[ />]/.test(source) || /createElement\(/.test(source),
      `${name}.tsx builds no JSX — it cannot be rendering anything`,
    );
  }
});

test('FloorNav keeps a populated routing table', () => {
  // FloorNav is the routing hub for every floor. Gutting it silently removes
  // navigation for the whole app, which is why it is asserted separately from
  // the generic substance checks.
  const source = read('FloorNav');
  const table = /const FLOORS: FloorDefinition\[\] = \[([\s\S]*?)\n\];/.exec(source);
  assert.ok(table, 'FloorNav must declare a FLOORS: FloorDefinition[] table');

  const entries = [...table[1].matchAll(/\{ id: '([^']+)', label: '([^']*)', name: '([^']+)'/g)];
  assert.ok(entries.length >= 16, `FloorNav declares ${entries.length} floors, expected at least 16`);

  const ids = entries.map((m) => m[1]);
  assert.equal(new Set(ids).size, ids.length, 'floor ids must be unique');

  for (const [, id, label, name] of entries) {
    assert.ok(label.length > 0, `floor ${id} must carry a label`);
    assert.ok(name.length > 0, `floor ${id} must carry a name`);
  }

  // The named floors the user navigates by must stay reachable.
  for (const expected of ['f8', 'f13', 'f16']) {
    assert.ok(ids.includes(expected), `FloorNav must keep floor ${expected}`);
  }
  assert.ok(source.includes('FLOORS.map'), 'FloorNav must render the FLOORS table');
});
test('App keeps a failing floor from blanking the whole shell', () => {
  // A render error in any one floor used to take down the whole app, and an
  // un-keyed boundary left the fallback stuck across navigation until reload.
  // The shell must mount each overlay behind its own boundary and remount the
  // floor boundary when the floor changes, so one bad floor stays contained.
  const app = fs.readFileSync(path.join(__dirname, '..', '..', 'web', 'src', 'App.tsx'), 'utf8');
  assert.ok(app.includes('key={floor}'), 'the floor boundary must be keyed on `floor` so navigation clears a caught error');
  const boundaries = (app.match(/<ErrorBoundary/g) || []).length;
  assert.ok(boundaries >= 6, `App.tsx mounts ${boundaries} error boundaries, expected the floor plus each overlay (>=6)`);
  for (const overlay of ['CommandPalette', 'AgentDrawer', 'GlobalSearch']) {
    const at = app.indexOf(`<${overlay}`);
    assert.ok(at > 0, `App.tsx must still render ${overlay}`);
    const pre = app.slice(0, at);
    const boundary = pre.lastIndexOf('<ErrorBoundary');
    assert.ok(boundary > -1 && boundary > pre.lastIndexOf('</ErrorBoundary>'), `${overlay} must sit inside its own ErrorBoundary`);
  }
});

test('the follow pane keeps a working input path', () => {
  // The pane grew a send form when terminals became writable. Assert the form
  // and the endpoint it posts to, so removing either is caught here rather than
  // discovered as "the box is there but nothing happens".
  const source = read('DeskFloor');
  assert.ok(source.includes('/input'), 'DeskFloor must post to the terminal input endpoint');
  assert.ok(source.includes("'writable'") || source.includes('>writable<'), 'the badge must reflect writability');
  assert.ok(source.includes('writable'), 'DeskFloor must compute whether the attached terminal accepts input');
  // It must stay gated on the backend that can actually accept input, rather
  // than offering a box to a background terminal that will always 400.
  assert.ok(/type === 'tmux'/.test(source), 'the input form must be gated on a tmux terminal');
});
