import assert from 'node:assert/strict';
import test from 'node:test';
import { getRuntimeKind, createRuntimeForModel } from './runtimeRouter.js';
import { resolveModelRoute } from '../agent/modelRouting.js';

test('P1-4: getRuntimeKind routes llamacpp family, rejects others', () => {
  assert.equal(getRuntimeKind('llamacpp:local-gguf'), 'llamacpp');
  assert.equal(getRuntimeKind(''), 'llamacpp');
  assert.equal(getRuntimeKind('local-gguf'), 'llamacpp');
  assert.equal(getRuntimeKind('opengo:supplied-model'), 'opengo');
  assert.equal(getRuntimeKind('openai-compat:foo'), 'opengo');
  assert.equal(getRuntimeKind('opencode-go:glm-5.3-flash'), 'opencode-go');
  assert.equal(getRuntimeKind('openai:gpt-4'), 'unsupported');
  assert.equal(getRuntimeKind('ollama:llama3'), 'unsupported');
});

test('P1-4: createRuntimeForModel throws actionable error on unsupported', () => {
  assert.throws(() => createRuntimeForModel('openai:gpt-4', {}), /llamacpp:\*" \(local GGUF\) or "opengo/);
});

test('opengo runtime requires configuration', () => {
  assert.throws(() => createRuntimeForModel('opengo:m', {}), /baseUrl/);
  const rt = createRuntimeForModel('opengo:m', { opengoBaseUrl: 'http://gw:8080', opengoEnabled: true });
  assert.equal(rt.describe().runtime, 'opengo');
});

test('OpenCode Go routing requires its separate key and respects the provider toggle', () => {
  assert.throws(() => createRuntimeForModel('opencode-go:glm-5.3-flash', { opengoApiKey: 'generic' }), /separate API key/);
  assert.throws(() => createRuntimeForModel('opencode-go:glm-5.3-flash', { opencodeGoApiKey: 'key', opencodeGoEnabled: false }), /Enable/);
  assert.equal(createRuntimeForModel('opencode-go:glm-5.3-flash', { opencodeGoApiKey: 'key', opencodeGoEnabled: true }).describe().runtime, 'opencode-go');
});

test('Go catalog is opt-in, does not discover remotely, and omits unknown API types', async () => {
  const { getModelCatalog } = await import('./runtimeRouter.js');
  const base = { opencodeGoModels: ['glm-5.3-flash', 'future-model'], llamaCppUrl: 'http://127.0.0.1:1' };
  const disabled = await getModelCatalog(base);
  assert.ok(!disabled.some(m => m.provider === 'opencode-go'));
  const enabled = await getModelCatalog({ ...base, opencodeGoEnabled: true });
  assert.ok(enabled.some(m => m.id === 'llamacpp:local-gguf'));
  assert.ok(enabled.some(m => m.id === 'opencode-go:glm-5.3-flash'));
  assert.ok(!enabled.some(m => m.name === 'future-model'));
  const overridden = await getModelCatalog({ ...base, opencodeGoEnabled: true, opencodeGoProtocolOverrides: { 'future-model': 'messages' } });
  assert.equal(overridden.find(m => m.name === 'future-model').protocol, 'messages');
});

test('getModelCatalog merges slot + registered opengo models', async () => {
  const { getModelCatalog } = await import('./runtimeRouter.js');
  const catalog = await getModelCatalog({
    contextLimit: 8192,
    maxTokens: 4096,
    opengoEnabled: false,
    opengoBaseUrl: '',
    opengoModels: [{ id: 'supplied-a', label: 'Supplied A', contextLimit: 32768, maxTokens: 4096 }]
  });
  const ids = catalog.map((c) => c.id);
  assert.ok(ids.includes('llamacpp:local-gguf'));
  assert.ok(ids.includes('opengo:supplied-a'));
  const entry = catalog.find((c) => c.id === 'opengo:supplied-a');
  assert.equal(entry.provider, 'opengo');
  assert.equal(entry.contextLimit, 32768);
  assert.equal(entry.source, 'registered');
});

test('P1-4: resolveModelRoute marks inherited vs override', () => {
  const base = { activeModel: 'llamacpp:local-gguf', agentModelRoutingEnabled: true, agentModelProfiles: {} };
  const inherited = resolveModelRoute(base, { phase: 'act' });
  assert.equal(inherited.model, 'llamacpp:local-gguf');
  assert.equal(inherited.inherited, true);
  assert.match(inherited.reason, /inherit:llamacpp:local-gguf/);

  const over = resolveModelRoute(
    { ...base, agentModelProfiles: { coder: { model: 'llamacpp:coder' } } },
    { phase: 'act' }
  );
  assert.equal(over.model, 'llamacpp:coder');
  assert.equal(over.inherited, false);
});
