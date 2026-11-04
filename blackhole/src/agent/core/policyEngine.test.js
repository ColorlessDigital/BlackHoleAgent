import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateCapability } from '../../security/policyEngine.js';
import { CapabilityExecutor } from '../../capabilities/executor.js';
import { RiskLevel } from '../../security/riskLevels.js';

test('P0-2: legacy default downgrades BLOCKED to approval escalation', () => {
  const r = evaluateCapability(
    { capability: 'run_command', params: { command: 'format C:' } },
    { permissionMode: 'operator' }
  );
  assert.equal(r.level, RiskLevel.WARNING);
  assert.equal(r.requiresApproval, true);
});

test('P0-2: strictBlocking keeps BLOCKED as hard deny', () => {
  const r = evaluateCapability(
    { capability: 'run_command', params: { command: 'format C:' } },
    { permissionMode: 'operator', strictBlocking: true }
  );
  assert.equal(r.level, RiskLevel.BLOCKED);
});

test('P0-2: operator keeps WARNING (approval), autonomous demotes to SAFE', () => {
  const op = evaluateCapability({ capability: 'render_page', params: {} }, { permissionMode: 'operator' });
  const auto = evaluateCapability({ capability: 'render_page', params: {} }, { permissionMode: 'autonomous' });
  assert.equal(op.level, RiskLevel.WARNING);
  assert.equal(auto.level, RiskLevel.SAFE);
});

test('P0-2: strictBlocking prevents autonomous WARNING->SAFE demotion', () => {
  const r = evaluateCapability(
    { capability: 'render_page', params: {} },
    { permissionMode: 'autonomous', strictBlocking: true }
  );
  assert.equal(r.level, RiskLevel.WARNING);
});

test('P0-2: executor hard-denies BLOCKED under strictBlocking without approval', async () => {
  const ex = new CapabilityExecutor({
    getConfig: () => ({ permissionMode: 'operator', strictBlocking: true, workspaceRoot: process.cwd() })
  });
  const res = await ex.execute('run_command', { command: 'format C:' }, { actor: 'test' });
  assert.equal(res.ok, false);
  assert.equal(res.blocked, true);
});
