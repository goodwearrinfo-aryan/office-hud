/**
 * What the browser is allowed to conclude about a command.
 *
 * The rule that matters is the first one: an unanswered preview is UNKNOWN, never
 * OPS TASK. The alternative is the failure this codebase keeps removing — a
 * control that reports "safe" because nobody checked.
 *
 * These are the browser's copy of nothing. The risk tier comes from the server
 * (POST /api/jarvis/preview, judged by the same function as the write), so the
 * only judgement left here is how to present an answer that may be missing.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import type { JarvisPreview } from '../../web/src/api.ts';
import {
  canDispatch,
  needsTypeConfirmation,
  ownerLabel,
  riskLabel,
  routingLabel,
} from '../../web/src/jarvisPreview.ts';

const preview = (over: Partial<JarvisPreview> = {}): JarvisPreview => ({
  ok: true,
  reason: null,
  field_status: null,
  prompt: 'refresh the floor snapshot',
  priority: 'normal',
  target: null,
  risk: 'normal',
  requires_type_confirmation: false,
  assigned_agent: 'office-manager',
  routing: null,
  would_accept: true,
  blocked_by: null,
  blocked_reason: null,
  dispatch: { available: true, host: 'As-Mac-mini', requirement: 'Dispatch must be issued by a process on this host.' },
  queue_available: true,
  ...over,
});

test('no preview means UNKNOWN, not OPS TASK', () => {
  assert.equal(riskLabel(null), 'UNKNOWN');
  assert.equal(riskLabel(preview({ ok: false })), 'UNKNOWN');
  assert.equal(riskLabel(preview({ risk: 'normal' })), 'OPS TASK');
  assert.equal(riskLabel(preview({ risk: 'destructive' })), 'DESTRUCTIVE');
});

test('an unanswered preview demands the confirm word rather than waving the command through', () => {
  // Asking for confirmation when we do not know is the safe direction to be wrong
  // in: it costs the operator one word, the other direction costs the guard.
  assert.equal(needsTypeConfirmation(null), true);
  assert.equal(needsTypeConfirmation(preview({ risk: 'normal', requires_type_confirmation: false })), false);
  assert.equal(needsTypeConfirmation(preview({ risk: 'destructive', requires_type_confirmation: true })), true);
});

test('dispatch is refused when this host may not dispatch, and says why', () => {
  const remote = preview({
    dispatch: { available: false, host: 'As-Mac-mini', requirement: 'Dispatch must be issued by a process on this host.' },
    blocked_by: 'not_local',
    blocked_reason: 'This HUD is served from As-Mac-mini, and dispatch requires a request that reaches that host\'s own loopback interface.',
  });
  const gate = canDispatch(remote, '');
  assert.equal(gate.allowed, false);
  assert.match(gate.reason ?? '', /loopback interface/);
});

test('the three reasons to refuse are reported separately, not collapsed', () => {
  // Collapsing them into one boolean is how a console disables a button for the
  // wrong reason, which is worse than not disabling it at all.
  assert.match(canDispatch(null, '').reason ?? '', /has not judged/);
  assert.match(canDispatch(preview({ ok: false, reason: 'prompt must be between 3 and 2000 characters' }), '').reason ?? '',
    /prompt must be between/);
  assert.match(canDispatch(preview({ queue_available: false }), '').reason ?? '', /queue is unavailable/);
  assert.match(canDispatch(preview({ requires_type_confirmation: true, risk: 'destructive' }), '').reason ?? '', /EXECUTE/);
  assert.equal(canDispatch(preview({ requires_type_confirmation: true, risk: 'destructive' }), 'EXECUTE').allowed, true);
  assert.equal(canDispatch(preview(), '').allowed, true);
});

test('the confirm word is case-insensitive and trimmed, because the input uppercases as it is typed', () => {
  const destructive = preview({ risk: 'destructive', requires_type_confirmation: true });
  assert.equal(canDispatch(destructive, 'execute').allowed, true);
  assert.equal(canDispatch(destructive, '  EXECUTE ').allowed, true);
  assert.equal(canDispatch(destructive, 'EXECUTE NOW').allowed, false);
});

test('an unrouted command names no agent rather than inventing one', () => {
  assert.equal(ownerLabel(null), 'not routed');
  assert.equal(ownerLabel(preview({ assigned_agent: null })), 'JEV auto-route');
  assert.equal(ownerLabel(preview({ assigned_agent: 'pm-risk' })), 'pm-risk');
});

test('routing is shown when there is a decision to show, and omitted when there is not', () => {
  assert.equal(routingLabel(preview({ routing: null })), null);
  assert.equal(routingLabel(null), null);
  assert.match(routingLabel(preview({
    routing: { domain: 'polymarket', selector: 'risk_intent', resolved_target: 'pm-risk' },
  })) ?? '', /polymarket · risk intent → pm-risk/);
});