import test from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// Set up temporary configuration directory for isolated testing
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const tempConfigDir = path.join(__dirname, 'temp_test_config');
process.env.BLACKHOLE_DATA_DIR = tempConfigDir;
process.env.BLACKHOLE_DISABLE_WORKSPACE_STANDARD = '1';

// Dynamically import configStore after setting the environment variable
const { loadConfig, saveConfig, defaultConfig } = await import('./configStore.js');
const configStore = await import('./configStore.js');
const secretStore = await import('./secretStore.js');

test('configuration and secrets use the same selected data directory', () => {
  assert.strictEqual(configStore.CONFIG_DIR, tempConfigDir);
  assert.strictEqual(secretStore.CONFIG_DIR, configStore.CONFIG_DIR);
});

test('configStore', async (t) => {
  // Setup: ensure temp directory is clean
  if (fs.existsSync(tempConfigDir)) {
    fs.rmSync(tempConfigDir, { recursive: true, force: true });
  }

  t.after(() => {
    // Cleanup: remove temporary config directory
    if (fs.existsSync(tempConfigDir)) {
      fs.rmSync(tempConfigDir, { recursive: true, force: true });
    }
  });

  await t.test('loadConfig - should return defaultConfig if file does not exist', () => {
    const config = loadConfig();
    assert.strictEqual(config.activeModel, defaultConfig.activeModel);
    assert.strictEqual(config.localRuntime, 'llamacpp');
    assert.deepStrictEqual(config.apiKeys, defaultConfig.apiKeys);
  });

  await t.test('saveConfig & loadConfig - should save config successfully and merge defaults', () => {
    const customConfig = {
      llamaCppUrl: 'http://127.0.0.1:9090',
      temperature: 0.8,
      apiKeys: {
        openai: 'sk-test-key'
      }
    };

    const saved = saveConfig(customConfig);
    assert.strictEqual(saved.llamaCppUrl, 'http://127.0.0.1:9090');
    assert.strictEqual(saved.temperature, 0.8);
    assert.strictEqual(saved.apiKeys.openai, 'sk-test-key');
    assert.strictEqual(saved.apiKeys.anthropic, ''); // merged from default

    const loaded = loadConfig();
    assert.strictEqual(loaded.llamaCppUrl, 'http://127.0.0.1:9090');
    assert.strictEqual(loaded.temperature, 0.8);
    assert.strictEqual(loaded.apiKeys.openai, 'sk-test-key');
  });

  await t.test('independent run limits preserve existing output, model, permissions and secrets', () => {
    const before = loadConfig();
    const saved = saveConfig({ agentMaxSteps: '37', selfHealingMaxCycles: 0 });
    assert.strictEqual(saved.agentMaxSteps, 37);
    assert.strictEqual(saved.selfHealingMaxCycles, 0);
    for (const key of ['activeModel', 'maxTokens', 'llamaCppGpuLayers', 'contextLimit', 'permissionMode', 'systemInstruction']) assert.deepStrictEqual(saved[key], before[key]);
    assert.deepStrictEqual(saved.apiKeys, before.apiKeys);
    assert.strictEqual(loadConfig().agentMaxSteps, 37);
    saveConfig({ agentMaxSteps: 24, selfHealingMaxCycles: 4 });
  });

  await t.test('Go key is encrypted, separately masked, retained on masked save, and removable', () => {
    const saved = saveConfig({ opencodeGoApiKey: 'go-independent-secret', opengoApiKey: 'generic-independent-secret' });
    assert.strictEqual(saved.activeModel, 'llamacpp:local-gguf');
    assert.strictEqual(saved.opencodeGoEnabled, false);
    const redacted = secretStore.redactSecrets(saved);
    assert.strictEqual(redacted.opencodeGoApiKey, '********');
    assert.strictEqual(redacted.opengoApiKey, '********');
    const raw = fs.readFileSync(path.join(tempConfigDir, 'config.json'), 'utf8');
    const encrypted = fs.readFileSync(path.join(tempConfigDir, 'secrets.enc.json'), 'utf8');
    assert.ok(!raw.includes('go-independent-secret'));
    assert.ok(!encrypted.includes('go-independent-secret'));
    saveConfig({ opencodeGoApiKey: '********', temperature: 0.8 });
    assert.strictEqual(loadConfig().opencodeGoApiKey, 'go-independent-secret');
    saveConfig({ opencodeGoApiKey: '' });
    assert.strictEqual(loadConfig().opencodeGoApiKey, '');
    assert.strictEqual(loadConfig().opengoApiKey, 'generic-independent-secret');
  });

  await t.test('Go config normalizes discovery, protocol overrides and provider routing', () => {
    const saved = saveConfig({ activeModel: 'opencode-go:glm-5.3-flash', opencodeGoEnabled: true,
      opencodeGoModels: ['glm-5.3-flash', 'glm-5.3-flash', '', null, ' future-model '],
      opencodeGoProtocolOverrides: { 'future-model': 'responses', gemini: 'google', wrong: 'unsupported' }, opencodeGoRequestTimeoutMs: -1 });
    assert.strictEqual(saved.localRuntime, 'opencode-go');
    assert.deepStrictEqual(saved.opencodeGoModels, ['glm-5.3-flash', 'future-model']);
    assert.deepStrictEqual(saved.opencodeGoProtocolOverrides, { 'future-model': 'responses', gemini: 'google' });
    assert.strictEqual(saved.opencodeGoRequestTimeoutMs, 5000);
    const tokens = saveConfig({ opencodeGoModelMaxTokens: { 'glm-5.2': '12345', 'glm-5.3': 32768, bad: -1 } });
    assert.deepStrictEqual(tokens.opencodeGoModelMaxTokens, { 'glm-5.2': 12345, 'glm-5.3': 32768 });
    assert.deepStrictEqual(loadConfig().opencodeGoModelMaxTokens, tokens.opencodeGoModelMaxTokens);
    saveConfig({ opencodeGoModelMaxTokens: {} });
    assert.deepStrictEqual(loadConfig().opencodeGoModelMaxTokens, {});
    saveConfig({ activeModel: 'llamacpp:local-gguf', opencodeGoEnabled: false });
  });

  await t.test('normalizeConfig - should normalize activeModel Ollama remnants to llamacpp', () => {
    const legacyConfig = {
      activeModel: 'ollama:llama3'
    };

    const saved = saveConfig(legacyConfig);
    // Should fallback/normalize to llamacpp:local-gguf
    assert.strictEqual(saved.activeModel, 'llamacpp:local-gguf');
    assert.strictEqual(saved.localRuntime, 'llamacpp');
  });

  await t.test('normalizeConfig - should migrate guard permission mode to operator (P0-2)', () => {
    const saved = saveConfig({ permissionMode: 'guard' });
    assert.strictEqual(saved.permissionMode, 'operator');

    const loaded = loadConfig();
    assert.strictEqual(loaded.permissionMode, 'operator');
  });

  await t.test('normalizeConfig - should default strictBlocking to false (P0-2)', () => {
    const saved = saveConfig({ permissionMode: 'operator' });
    assert.strictEqual(saved.strictBlocking, false);
    assert.strictEqual(saved.permissionMode, 'operator');
  });

  await t.test('normalizeConfig - should default opengo provider and compaction settings', () => {
    const config = loadConfig();
    assert.strictEqual(config.opengoEnabled, false);
    assert.strictEqual(config.opengoBaseUrl, '');
    assert.deepStrictEqual(config.opengoModels, []);
    assert.strictEqual(config.contextCompactionEnabled, true);
    assert.strictEqual(config.contextCompactionThreshold, 0.9);
  });

  await t.test('normalizeConfig - should normalize opengo models and route opengo activeModel', () => {
    const saved = saveConfig({
      activeModel: 'opengo:supplied-a',
      opengoEnabled: true,
      opengoBaseUrl: 'http://gw:8080/',
      opengoApiKey: 'secret-key',
      opengoModels: ['supplied-a', { id: 'supplied-a', label: 'dup' }, { id: 'supplied-b', label: 'B', contextLimit: '32768' }]
    });
    assert.strictEqual(saved.localRuntime, 'opengo');
    assert.strictEqual(saved.opengoBaseUrl, 'http://gw:8080');
    assert.strictEqual(saved.opengoModels.length, 2);
    assert.strictEqual(saved.opengoModels[1].contextLimit, 32768);
    assert.strictEqual(saved.opengoApiKey, 'secret-key');
    const loaded = loadConfig();
    assert.strictEqual(loaded.opengoApiKey, 'secret-key');
  });

  await t.test('normalizeConfig - should validate opengo preset ids', () => {
    const saved = saveConfig({ opengoPreset: 'openai' });
    assert.strictEqual(saved.opengoPreset, 'openai');
    const fallback = saveConfig({ opengoPreset: 'unknown-preset' });
    assert.strictEqual(fallback.opengoPreset, 'custom');
  });

  await t.test('normalizeConfig - should normalize model routing profiles', () => {
    const saved = saveConfig({
      agentModelProfiles: {
        coder: {
          model: '  llamacpp:coder  ',
          contextLimit: '12288',
          maxTokens: '2048',
          temperature: '0.12'
        },
        verifier: {
          contextLimit: 'not-a-number'
        }
      }
    });

    assert.strictEqual(saved.agentModelProfiles.coder.model, 'llamacpp:coder');
    assert.strictEqual(saved.agentModelProfiles.coder.contextLimit, 12288);
    assert.strictEqual(saved.agentModelProfiles.coder.maxTokens, 2048);
    assert.strictEqual(saved.agentModelProfiles.coder.temperature, 0.12);
    assert.strictEqual(saved.agentModelProfiles.verifier.contextLimit, defaultConfig.agentModelProfiles.verifier.contextLimit);
    assert.ok(saved.agentModelProfiles.general);
  });
});
