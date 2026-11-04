import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';

test('Go configuration API and agent routing retain local defaults and a stable conversation header', async t => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'blackhole-go-api-'));
  process.env.BLACKHOLE_DATA_DIR = dataRoot;
  process.env.BLACKHOLE_DISABLE_WORKSPACE_STANDARD = '1';
  const { createConfigRouter } = await import('./config.js');
  const { saveConfig, loadConfig, defaultConfig } = await import('../../config/configStore.js');
  const { AgentStateMachine } = await import('../../agent/core/stateMachine.js');
  saveConfig({ ...defaultConfig, workspaceRoot: dataRoot, llamaCppUrl: 'http://127.0.0.1:1' });
  const app = express();
  app.use(express.json());
  app.use(createConfigRouter());
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const realFetch = globalThis.fetch;
  const calls = [];
  let fail = false;
  globalThis.fetch = async (url, init) => {
    if (String(url) === 'https://models.dev/api.json') return Response.json({ 'opencode-go': { npm: '@ai-sdk/openai-compatible', models: { 'glm-5.3-flash': {} } } });
    if (!String(url).startsWith('https://opencode.ai/inference/go/')) return realFetch(url, init);
    calls.push({ url: String(url), init });
    if (String(url).endsWith('/models')) return Response.json({ data: [{ id: 'glm-5.3-flash' }, { id: 'minimax-m2.7' }] });
    if (fail) return Response.json({ error: { message: 'Invalid Go key' } }, { status: 401 });
    return new Response('data: ' + JSON.stringify({ choices: [{ delta: { content: 'OK' }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 1 } }) + '\n\ndata: [DONE]\n\n',
      { headers: { 'Content-Type': 'text/event-stream' } });
  };
  t.after(async () => {
    globalThis.fetch = realFetch;
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    fs.rmSync(dataRoot, { recursive: true, force: true });
  });
  const request = async (route, body) => {
    const result = await realFetch(`http://127.0.0.1:${server.address().port}${route}`,
      body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return result.json();
  };
  const saved = await request('/config', { opencodeGoApiKey: 'separate-go-test-secret', opengoApiKey: 'generic-test-secret' });
  assert.equal(saved.opencodeGoApiKey, '********');
  assert.equal(saved.activeModel, defaultConfig.activeModel);
  const beforeInvalid = fs.readFileSync(path.join(dataRoot, 'config.json'), 'utf8');
  const invalid = await realFetch(`http://127.0.0.1:${server.address().port}/config`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
      opencodeGoModelMaxTokens: { 'glm-5.3-flash': 0 }, opencodeGoApiKey: 'must-not-save'
    })
  });
  assert.equal(invalid.status, 400);
  assert.match((await invalid.json()).error, /positive safe integer/);
  assert.equal(fs.readFileSync(path.join(dataRoot, 'config.json'), 'utf8'), beforeInvalid);
  assert.equal(loadConfig().opencodeGoApiKey, 'separate-go-test-secret');
  for (const limits of [{ agentMaxSteps: 0 }, { agentMaxSteps: 1001 }, { selfHealingMaxCycles: -1 }, { selfHealingMaxCycles: 0.5 }]) {
    const invalidBudget = await realFetch(`http://127.0.0.1:${server.address().port}/config`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...limits, opencodeGoApiKey: 'must-not-save' })
    });
    assert.equal(invalidBudget.status, 400);
    assert.equal(fs.readFileSync(path.join(dataRoot, 'config.json'), 'utf8'), beforeInvalid);
    assert.equal(loadConfig().opencodeGoApiKey, 'separate-go-test-secret');
  }
  const savedBudget = await request('/config', { agentMaxSteps: 37, selfHealingMaxCycles: 0 });
  assert.equal(savedBudget.agentMaxSteps, 37);
  assert.equal(savedBudget.selfHealingMaxCycles, 0);
  assert.equal(savedBudget.maxTokens, defaultConfig.maxTokens);
  await request('/config', { agentMaxSteps: 24, selfHealingMaxCycles: 4 });
  const withLimits = await request('/config', { opencodeGoModelMaxTokens: { 'glm-5.3-flash': 12345 } });
  assert.deepEqual(withLimits.opencodeGoModelMaxTokens, { 'glm-5.3-flash': 12345 });
  assert.equal(withLimits.maxTokens, defaultConfig.maxTokens);
  await t.test('output-limit recovery updates only the failing Go model and rejects invalid updates atomically', async () => {
    const before = loadConfig();
    const recovered = await request('/models/opencode-go/output-limit', { model: 'opencode-go:muse-spark-1.3-contributor', maxTokens: 16384 });
    assert.deepEqual(recovered.opencodeGoModelMaxTokens, { 'glm-5.3-flash': 12345, 'muse-spark-1.3-contributor': 16384 });
    assert.equal(recovered.opencodeGoApiKey, '********');
    assert.deepEqual(loadConfig(), { ...before, opencodeGoModelMaxTokens: recovered.opencodeGoModelMaxTokens });
    assert.equal(loadConfig().opencodeGoApiKey, before.opencodeGoApiKey);
    assert.equal(loadConfig().opengoApiKey, before.opengoApiKey);
    const secrets = fs.readFileSync(path.join(dataRoot, 'secrets.enc.json'));
    const savedBytes = fs.readFileSync(path.join(dataRoot, 'config.json'));
    for (const body of [{ model: '', maxTokens: 8192 }, { model: 'llamacpp:local-gguf', maxTokens: 8192 },
      { model: 'muse-spark-1.3-contributor', maxTokens: 0 }, { model: 'muse-spark-1.3-contributor', maxTokens: 1.5 },
      { model: 'muse-spark-1.3-contributor', maxTokens: null }]) {
      const response = await realFetch(`http://127.0.0.1:${server.address().port}/models/opencode-go/output-limit`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
      });
      assert.equal(response.status, 400);
      assert.deepEqual(fs.readFileSync(path.join(dataRoot, 'config.json')), savedBytes);
      assert.deepEqual(fs.readFileSync(path.join(dataRoot, 'secrets.enc.json')), secrets);
    }
  });
  const beforeDiscovery = fs.readFileSync(path.join(dataRoot, 'config.json'), 'utf8');
  const discovery = await request('/models/opencode-go');
  assert.equal(discovery.ok, true);
  assert.equal(discovery.authenticated, false);
  assert.equal(fs.readFileSync(path.join(dataRoot, 'config.json'), 'utf8'), beforeDiscovery);
  assert.equal(discovery.catalogStatus.stale, false);
  assert.equal(loadConfig().opencodeGoApiKey, 'separate-go-test-secret');
  const tested = await request('/models/test-opencode-go', {});
  assert.equal(tested.authenticated, true);
  assert.equal(JSON.parse(calls.at(-1).init.body).max_tokens, 64);
  assert.equal(loadConfig().activeModel, defaultConfig.activeModel);
  const beforeTest = loadConfig().opencodeGoDefaultModel;
  assert.equal((await request('/models/test-opencode-go', { model: 'glm-5.3-flash' })).ok, true);
  assert.equal(loadConfig().opencodeGoDefaultModel, beforeTest);
  fail = true;
  assert.equal((await request('/models/test-opencode-go', {})).ok, false);
  fail = false;

  await request('/config', { opencodeGoEnabled: true, activeModel: 'opencode-go:glm-5.3-flash' });
  const catalog = await request('/models');
  assert.ok(catalog.catalog.some(m => m.id === 'llamacpp:local-gguf'));
  assert.ok(catalog.catalog.some(m => m.id === 'opencode-go:glm-5.3-flash'));
  assert.ok(!JSON.stringify(catalog).includes('separate-go-test-secret'));
  const state = new AgentStateMachine({ config: loadConfig(), send: () => {}, providerSessionId: 'frontend-conversation-123' });
  await state.callModel('Unchanged system prompt.', [{ role: 'user', content: 'Task' }], () => {}, { phase: 'plan' });
  assert.equal(JSON.parse(calls.at(-1).init.body).max_tokens, 12345);
  await state.callModel('Unchanged summary prompt.', [{ role: 'user', content: 'Auxiliary transcript' }], () => {}, { phase: 'summarize' });
  const resumed = new AgentStateMachine({ config: loadConfig(), send: () => {}, resumeCheckpoint: state.checkpoint });
  await resumed.callModel('Unchanged system prompt.', [{ role: 'user', content: 'Continue' }], () => {}, { phase: 'act' });
  const sessions = calls.filter(c => JSON.parse(c.init?.body || '{}').max_tokens > 64).map(c => c.init.headers['x-opencode-session']);
  assert.equal(sessions.length, 3);
  assert.equal(new Set(sessions).size, 1);
  assert.equal(JSON.parse(calls.at(-1).init.body).messages[0].content, 'Unchanged system prompt.');
  await request('/config', { opencodeGoApiKey: '' });
  assert.equal(loadConfig().opencodeGoApiKey, '');
  assert.equal(loadConfig().opengoApiKey, 'generic-test-secret');
});
