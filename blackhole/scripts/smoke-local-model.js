import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const modelArg = process.argv.find(arg => arg.startsWith('--model='));
if (!modelArg) throw new Error('Usage: node scripts/smoke-local-model.js --model=<GGUF path>');
const modelPath = path.resolve(modelArg.slice('--model='.length));
const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'blackhole-model-smoke-'));
process.env.BLACKHOLE_DATA_DIR = dataRoot;
const { LlamaCppRuntime } = await import('../src/runtime/llamaCppRuntime.js');
const runtime = new LlamaCppRuntime({
  llamaCppModelPath: modelPath,
  llamaCppUrl: 'http://127.0.0.1:18087',
  llamaCppGpuLayers: 999,
  llamaCppBatch: 512,
  contextLimit: 8192,
  llamaCppStartupTimeoutMs: 120000,
  llamaCppRequestTimeoutMs: 120000
});
const startedAt = Date.now();
try {
  let text = '';
  await runtime.chatStream({
    model: 'llamacpp:local-gguf',
    messages: [{ role: 'user', content: 'Reply briefly with OK.' }],
    maxTokens: 32,
    temperature: 0
  }, chunk => { text += chunk; });
  assert.ok(text.trim(), 'The model must stream a nonempty response.');
  const controller = new AbortController();
  let receivedBeforeStop = false;
  await assert.rejects(runtime.chatStream({
    model: 'llamacpp:local-gguf',
    messages: [{ role: 'user', content: 'Count upward from 1, continuing for as long as possible.' }],
    maxTokens: 4096,
    temperature: 0,
    signal: controller.signal
  }, () => {
    receivedBeforeStop = true;
    controller.abort();
  }), { name: 'AbortError' });
  assert.ok(receivedBeforeStop, 'Cancellation must happen during a live response.');
  const status = await runtime.status();
  console.log(JSON.stringify({
    ok: true,
    model: path.basename(modelPath),
    responsePreview: text.slice(0, 120),
    cancellation: 'passed',
    durationMs: Date.now() - startedAt,
    launchArgs: status.lastLaunch?.args
  }));
} finally {
  await runtime.stopServer();
  fs.rmSync(dataRoot, { recursive: true, force: true });
}
