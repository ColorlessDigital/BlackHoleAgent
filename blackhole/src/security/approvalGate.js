import { eventBus, emitLog } from '../common/eventBus.js';

const pendingApprovals = new Map();

export function requestApproval(action, policyResult, { abortSignal } = {}) {
  abortSignal?.throwIfAborted();
  const id = `approval-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const payload = {
    id,
    action,
    policy: policyResult,
    createdAt: new Date().toISOString()
  };

  return new Promise((resolve, reject) => {
    const onAbort = () => {
      if (!pendingApprovals.delete(id)) return;
      abortSignal.removeEventListener('abort', onAbort);
      reject(abortSignal.reason);
      eventBus.emit('approval:resolved', { id, decision: 'cancelled' });
      emitLog(`Approval cancelled with its execution: ${id}`, 'info');
    };
    const cleanup = () => abortSignal?.removeEventListener('abort', onAbort);
    // Register before publishing: synchronous UI/event listeners can respond.
    pendingApprovals.set(id, { resolve, payload, cleanup });
    abortSignal?.addEventListener('abort', onAbort, { once: true });
    if (abortSignal?.aborted) { onAbort(); return; }
    emitLog(`Tool approval pending: ${action.capability} - ${policyResult.reason}`, 'warning', { approvalId: id });
    eventBus.emit('approval:pending', payload);
  });
}

export function respondToApproval(id, decision) {
  const pending = pendingApprovals.get(id);
  if (!pending) return false;
  pendingApprovals.delete(id);
  pending.cleanup();
  const approved = decision === 'approve';
  emitLog(approved ? `Approved: ${id}` : `Rejected: ${id}`, approved ? 'success' : 'error');
  pending.resolve(approved);
  eventBus.emit('approval:resolved', { id, decision: approved ? 'approved' : 'rejected' });
  return true;
}

export function listPendingApprovals() {
  return [...pendingApprovals.values()].map((item) => item.payload);
}
