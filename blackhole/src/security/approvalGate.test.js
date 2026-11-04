import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { eventBus } from '../common/eventBus.js';
import { requestApproval, respondToApproval, listPendingApprovals } from './approvalGate.js';

const action = { capability: 'run_command', params: { command: 'fixture-only' } };
const policy = { reason: 'Fixture approval' };

test('approval exists before notification so an immediate human/UI response is not lost', async t => {
  let id;
  let accepted;
  const listener = payload => { id = payload.id; accepted = respondToApproval(id, 'approve'); };
  eventBus.on('approval:pending', listener);
  t.after(() => { eventBus.off('approval:pending', listener); if (id) respondToApproval(id, 'reject'); });
  const pending = requestApproval(action, policy);
  const result = await Promise.race([pending, delay(100, null)]);
  respondToApproval(id, 'reject');
  await pending;
  assert.equal(accepted, true);
  assert.equal(result, true);
  assert.ok(!listPendingApprovals().some(p => p.id === id));
});

test('cancelling an execution removes only its pending approval and never approves it later', async t => {
  const stop = new AbortController();
  const reason = new Error('fixture-approval-stop');
  let id;
  const listener = payload => { id = payload.id; };
  eventBus.on('approval:pending', listener);
  t.after(() => { eventBus.off('approval:pending', listener); if (id) respondToApproval(id, 'reject'); });
  const pending = requestApproval(action, policy, { abortSignal: stop.signal }).then(value => ({ value }), error => ({ error }));
  assert.ok(listPendingApprovals().some(p => p.id === id));
  stop.abort(reason);
  const result = await Promise.race([pending, delay(100, null)]);
  const lateResponse = respondToApproval(id, 'approve');
  await pending;
  assert.equal(result?.error, reason);
  assert.equal(lateResponse, false);
  assert.ok(!listPendingApprovals().some(p => p.id === id));
});

test('a pre-cancelled execution never publishes an approval', async t => {
  let notifications = 0;
  let id;
  const listener = payload => { notifications++; id = payload.id; };
  eventBus.on('approval:pending', listener);
  t.after(() => { eventBus.off('approval:pending', listener); if (id) respondToApproval(id, 'reject'); });
  const stop = new AbortController();
  stop.abort(new Error('already-stopped'));
  const pending = Promise.resolve().then(() => requestApproval(action, policy, { abortSignal: stop.signal }))
    .then(value => ({ value }), error => ({ error }));
  const result = await Promise.race([pending, delay(100, null)]);
  if (id) respondToApproval(id, 'reject');
  await pending;
  assert.equal(notifications, 0);
  assert.equal(result.error, stop.signal.reason);
});
