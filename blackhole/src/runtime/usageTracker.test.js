import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bh-usage-'));
process.env.BLACKHOLE_DATA_DIR = tempDataDir;

const { recordUsage, getUsageSummary, resetUsage } = await import('./usageTracker.js');

test('usage ledger accumulates per-model tokens and tags', () => {
  resetUsage();
  recordUsage({ model: 'opengo:supplied-a', usageTag: 'agent', promptTokens: 100, completionTokens: 50 });
  recordUsage({ model: 'opengo:supplied-a', usageTag: 'autocomplete', promptTokens: 20, completionTokens: 5 });
  recordUsage({ model: 'llamacpp:local-gguf', usageTag: 'agent', promptTokens: 1000, completionTokens: 200 });

  const summary = getUsageSummary();
  assert.equal(summary.byModel['opengo:supplied-a'].requests, 2);
  assert.equal(summary.byModel['opengo:supplied-a'].totalTokens, 175);
  assert.equal(summary.byModel['opengo:supplied-a'].tags.agent, 1);
  assert.equal(summary.byModel['opengo:supplied-a'].tags.autocomplete, 1);
  assert.equal(summary.totals.requests, 3);
  assert.equal(summary.totals.totalTokens, 175 + 1200);
  assert.ok(fs.existsSync(path.join(tempDataDir, 'model-usage.json')));
});

test('usage reset clears the ledger', () => {
  resetUsage();
  assert.deepEqual(getUsageSummary().byModel, {});
  assert.equal(getUsageSummary().totals.requests, 0);
});

test('failed estimates cannot inflate server-reported totals and legacy totals stay unclassified', () => {
  resetUsage();
  recordUsage({ model: 'go:model', promptTokens: 12, completionTokens: 3 });
  recordUsage({ model: 'go:model', promptTokens: 1000, estimated: true });
  recordUsage({ model: 'go:model', promptTokens: 16000000, estimated: true, failed: true });
  let store = getUsageSummary();
  assert.equal(store.totals.totalTokens, 15);
  assert.equal(store.estimatedTotals.totalTokens, 1000);
  assert.equal(store.failedTotals.requests, 1);
  fs.writeFileSync(path.join(tempDataDir, 'model-usage.json'), JSON.stringify({ version: 1,
    totals: { requests: 3, totalTokens: 16000000 }, byModel: { 'go:model': { requests: 3, totalTokens: 16000000 } } }));
  store = getUsageSummary();
  assert.equal(store.totals.totalTokens, 0);
  assert.equal(store.legacyTotals.totalTokens, 16000000);
  assert.equal(store.byModel['go:model'].legacyTotals.totalTokens, 16000000);
  fs.rmSync(tempDataDir, { recursive: true, force: true });
});
