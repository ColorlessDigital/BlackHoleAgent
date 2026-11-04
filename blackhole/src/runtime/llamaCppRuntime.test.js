import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  discoverGgufModels,
  discoverLlamaCppCandidates,
  LlamaCppRuntime
} from './llamaCppRuntime.js';

function normalizedPathKey(targetPath) {
  let resolved = path.resolve(targetPath);
  try {
    resolved = fs.realpathSync.native(resolved);
  } catch {
    // The discovery helpers use the same fallback when a path disappears.
  }
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

test('discoverLlamaCppCandidates returns unique executable paths', () => {
  const candidates = discoverLlamaCppCandidates();
  const keys = candidates.map((candidate) => normalizedPathKey(candidate.path));
  assert.equal(new Set(keys).size, keys.length);
});

test('llama.cpp cancels an active inference request', async () => {
  const realFetch = globalThis.fetch;
  const controller = new AbortController();
  globalThis.fetch = (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    controller.abort();
  });
  try {
    const runtime = new LlamaCppRuntime({ llamaCppUrl: 'http://127.0.0.1:8080' });
    runtime.ensureServerRunning = async () => true;
    await assert.rejects(runtime.chatStream({ model: 'llamacpp:local-gguf', messages: [], signal: controller.signal }, () => {}),
      { name: 'AbortError' });
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('llama.cpp does not start a server for an already cancelled request', async () => {
  const controller = new AbortController();
  controller.abort();
  const runtime = new LlamaCppRuntime({});
  runtime.isHealthy = async () => { throw new Error('health check must not run'); };
  await assert.rejects(runtime.ensureServerRunning({}, { signal: controller.signal }), { name: 'AbortError' });
});

test('llama.cpp sends separate reasoning and answer fields to their own channels without changing inference settings', async t => {
  const frames = [{ choices: [{ delta: { reasoning_content: 'First thought. ' } }] },
    { choices: [{ delta: { reasoning: 'Second thought.', content: 'Answer' } }] }];
  let request;
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    request = JSON.parse(options.body);
    return new Response(frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join(''));
  });
  const runtime = new LlamaCppRuntime({});
  runtime.ensureServerRunning = async () => true;
  let answer = '', reasoning = '';
  await runtime.chatStream({ model: 'llamacpp:local-gguf', messages: [{ role: 'user', content: 'Unchanged request' }],
    maxTokens: 12345, temperature: 0.7, onReasoning: text => { reasoning += text; } }, text => { answer += text; });
  assert.equal(answer, 'Answer');
  assert.equal(reasoning, 'First thought. Second thought.');
  assert.equal(request.max_tokens, 12345);
  assert.equal(request.temperature, 0.7);
  assert.deepEqual(request.messages, [{ role: 'user', content: 'Unchanged request' }]);
});

test('discoverGgufModels deduplicates repeated search roots', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'blackhole-runtime-'));
  try {
    const modelsDir = path.join(tempRoot, 'models');
    fs.mkdirSync(modelsDir, { recursive: true });
    fs.writeFileSync(path.join(modelsDir, 'sample.gguf'), 'model');

    const models = discoverGgufModels([modelsDir, path.resolve(modelsDir)]);

    assert.equal(models.length, 1);
    assert.equal(models[0].name, 'sample.gguf');
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
