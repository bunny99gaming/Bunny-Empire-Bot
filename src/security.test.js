import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyModerationAction, shouldMonitorActor, shouldTriggerProtection } from './security.js';

const events = { MemberKick: 20, MemberBanAdd: 22, MemberUpdate: 24 };

test('classifies kicks and bans', () => {
  assert.equal(classifyModerationAction({ action: 20 }, events).label, 'Kick');
  assert.equal(classifyModerationAction({ action: 22 }, events).label, 'Ban');
});

test('detects a newly applied timeout, not a removed timeout', () => {
  assert.equal(classifyModerationAction({ action: 24, changes: [{ key: 'communication_disabled_until', new: '2026-10-11T12:00:00.000Z' }] }, events).label, 'Timeout');
  assert.equal(classifyModerationAction({ action: 24, changes: [{ key: 'communication_disabled_until', new: null }] }, events), null);
  assert.equal(classifyModerationAction({ action: 24, changes: [{ key: 'nick', new: 'Bunny' }] }, events), null);
});

test('continues monitoring an actor after their staff role is removed for quarantine', () => {
  assert.equal(shouldMonitorActor(true, false), true);
  assert.equal(shouldMonitorActor(false, true), true);
  assert.equal(shouldMonitorActor(false, false), false);
});

test('protection threshold: one action and spaced pair do not trigger; rapid pair or three actions do', () => {
  assert.equal(shouldTriggerProtection([1_000]), false);
  assert.equal(shouldTriggerProtection([1_000, 20_000]), false);
  assert.equal(shouldTriggerProtection([1_000, 9_000]), true);
  assert.equal(shouldTriggerProtection([1_000, 20_000, 40_000]), true);
});
