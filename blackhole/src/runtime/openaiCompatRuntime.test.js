import assert from 'node:assert/strict';
import test from 'node:test';
import { OpenaiCompatRuntime, resolveOpengoEndpoint } from './openaiCompatRuntime.js';

test('provider endpoints include one API version and preserve proxy paths', () => {
  for (const base of ['https://api.example.test', 'https://api.example.test/v1', 'https://api.example.test/v1/']) {
    assert.equal(resolveOpengoEndpoint(base, 'models'), 'https://api.example.test/v1/models');
  }
  assert.equal(resolveOpengoEndpoint('https://api.example.test/proxy/v1?tenant=one', 'chat/completions'),
    'https://api.example.test/proxy/v1/chat/completions?tenant=one');
});

function sseBody(frames) {
  const text = frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join('') + 'data: [DONE]\n\n';
  const bytes = new TextEncoder().encode(text);
  return {
    getReader() {
      let sent = false;
      return {
        async read() {
          if (sent) return { done: true, value: undefined };
          sent = true;
          return { done: false, value: bytes };
        }
      };
    }
  };
}

test('opengo runtime requires baseUrl', async () => {
  const rt = new OpenaiCompatRuntime({});
  assert.equal(rt.isConfigured(), false);
  await assert.rejects(() => rt.chatStream({ model: 'opengo:foo', messages: [] }, () => {}), /baseUrl/);
  assert.deepEqual(await rt.listModels(), []);
  const probed = await rt.testConnection();
  assert.equal(probed.ok, false);
});

test('opengo chatStream parses deltas and server usage', async () => {
  const seen = {};
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    seen.url = String(url);
    seen.body = JSON.parse(options.body);
    seen.auth = options.headers?.Authorization || '';
    return {
      ok: true,
      body: sseBody([
        { choices: [{ delta: { reasoning_content: 'First thought. ' } }] },
        { choices: [{ delta: { content: 'hello ' } }] },
        { choices: [{ delta: { content: 'world', reasoning: 'Second thought.' } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }
      ])
    };
  };
  try {
    const rt = new OpenaiCompatRuntime({ opengoBaseUrl: 'http://gateway:8080/', opengoApiKey: 'k', opengoEnabled: true });
    let text = '';
    let reasoning = '';
    const result = await rt.chatStream(
      { model: 'opengo:supplied-model', messages: [{ role: 'user', content: 'hi' }], maxTokens: 64, temperature: 0.1,
        onReasoning: chunk => { reasoning += chunk; } },
      (chunk) => { text += chunk; }
    );
    assert.equal(text, 'hello world');
    assert.equal(reasoning, 'First thought. Second thought.');
    assert.deepEqual(result.usage, { promptTokens: 10, completionTokens: 5 });
    assert.equal(seen.url, 'http://gateway:8080/v1/chat/completions');
    assert.equal(seen.body.model, 'supplied-model');
    assert.equal(seen.auth, 'Bearer k');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('opengo presets fill baseUrl so only a key is needed', async () => {
  const { resolveOpengoBaseUrl, getOpengoPreset, OPENGO_PRESETS } = await import('./openaiCompatRuntime.js');
  assert.ok(OPENGO_PRESETS.some((p) => p.id === 'openai' && p.baseUrl.includes('openai.com')));
  assert.equal(getOpengoPreset('nope').id, 'custom');
  assert.equal(resolveOpengoBaseUrl({ opengoPreset: 'openai', opengoBaseUrl: '' }), 'https://api.openai.com/v1');
  assert.equal(resolveOpengoBaseUrl({ opengoPreset: 'openai', opengoBaseUrl: 'http://proxy/v1/' }), 'http://proxy/v1');
  const rt = new OpenaiCompatRuntime({ opengoPreset: 'openai', opengoEnabled: true });
  assert.equal(rt.isConfigured(), true);
  assert.equal(rt.baseUrl, 'https://api.openai.com/v1');
});

test('connection test requires key for keyed presets and suggests a model', async () => {
  const realFetch = globalThis.fetch;
  try {
    const rtNoKey = new OpenaiCompatRuntime({ opengoPreset: 'openai', opengoEnabled: true });
    const missing = await rtNoKey.testConnection();
    assert.equal(missing.ok, false);
    assert.match(missing.error, /API 키/);

    globalThis.fetch = async (url) => {
      assert.equal(String(url), 'https://api.openai.com/v1/models');
      return {
      ok: true,
      json: async () => ({ data: [{ id: 'gpt-x' }, { id: 'gpt-y' }] })
      };
    };
    const rt = new OpenaiCompatRuntime({ opengoPreset: 'openai', opengoApiKey: 'k', opengoEnabled: true });
    const result = await rt.testConnection();
    assert.equal(result.ok, true);
    assert.equal(result.suggestedModel, 'opengo:gpt-x');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('opengo cancels an active request when the caller stops', async () => {
  const realFetch = globalThis.fetch;
  const controller = new AbortController();
  globalThis.fetch = (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    controller.abort();
  });
  try {
    const rt = new OpenaiCompatRuntime({ opengoBaseUrl: 'http://gateway:8080' });
    await assert.rejects(rt.chatStream({ model: 'opengo:m', messages: [], signal: controller.signal }, () => {}),
      { name: 'AbortError' });
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('opengo chatStream surfaces HTTP errors', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 401, text: async () => 'bad key' });
  try {
    const rt = new OpenaiCompatRuntime({ opengoBaseUrl: 'http://gateway:8080', opengoEnabled: true });
    await assert.rejects(() => rt.chatStream({ model: 'opengo:m', messages: [] }, () => {}), /HTTP 401/);
  } finally {
    globalThis.fetch = realFetch;
  }
});
