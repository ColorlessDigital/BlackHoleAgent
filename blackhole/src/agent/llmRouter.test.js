import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { resolveModelRoute } from './modelRouting.js';
import { normalizeGoModelTokenLimits } from '../config/goModelSettings.js';
import { createReasoningStream } from '../runtime/reasoningStream.js';

test('leading reasoning wrappers split at every chunk boundary without touching answer or tool literals', () => {
  for (const tag of ['think', 'thinking', 'analysis']) {
    const source = `<${tag}>첫 추론 <write_file>not an action</write_file></${tag}>Final answer`;
    for (let index = 1; index < source.length; index++) {
      let answer = '', reasoning = '';
      const stream = createReasoningStream({ onContent: text => { answer += text; }, onReasoning: text => { reasoning += text; } });
      stream.write(source.slice(0, index));
      stream.write(source.slice(index));
      stream.finish();
      stream.finish();
      assert.equal(answer, 'Final answer');
      assert.equal(reasoning, '첫 추론 <write_file>not an action</write_file>');
    }
  }
  for (const source of ['```xml\n<think>literal example</think>\n```',
    '{"tool":"write_file","params":{"content":"<think>literal</think>"}}',
    'The literal tag is <think>example</think>.', '<thi', '<article>Answer</article>']) {
    let answer = '', reasoning = '';
    const stream = createReasoningStream({ onContent: text => { answer += text; }, onReasoning: text => { reasoning += text; } });
    for (const character of source) stream.write(character);
    stream.finish();
    assert.equal(answer, source);
    assert.equal(reasoning, '');
  }
});

test('unfinished reasoning remains in its own channel when the stream ends or is interrupted', () => {
  let answer = '', reasoning = '';
  const stream = createReasoningStream({ onContent: text => { answer += text; }, onReasoning: text => { reasoning += text; } });
  for (const character of '<think>Partial thought</thi') stream.write(character);
  stream.finish();
  assert.equal(answer, '');
  assert.equal(reasoning, 'Partial thought</thi');
});

test('Go output limits are arbitrary positive integers scoped to the actual routed model', () => {
  const config = { activeModel: 'opencode-go:glm-5.2', maxTokens: 4096, agentModelRoutingEnabled: false,
    opencodeGoModelMaxTokens: { 'glm-5.2': 12345, 'glm-5.3': 32768 } };
  assert.equal(resolveModelRoute(config).maxTokens, 12345);
  assert.equal(resolveModelRoute({ ...config, activeModel: 'opencode-go:glm-5.3' }).maxTokens, 32768);
  assert.equal(resolveModelRoute({ ...config, activeModel: 'opencode-go:other' }).maxTokens, 4096);
  assert.equal(resolveModelRoute({ ...config, activeModel: 'llamacpp:local-gguf' }).maxTokens, 4096);
  const routed = { ...config, agentModelRoutingEnabled: true, agentModelProfiles: {
    coder: { model: 'opencode-go:glm-5.3', maxTokens: 2048 },
    planner: { model: 'llamacpp:local-gguf', maxTokens: 1024 }
  } };
  assert.equal(resolveModelRoute(routed, { phase: 'act' }).maxTokens, 32768);
  assert.equal(resolveModelRoute(routed, { phase: 'plan' }).maxTokens, 1024);
  assert.equal(resolveModelRoute({ ...routed, opencodeGoModelMaxTokens: {} }, { phase: 'act' }).maxTokens, 2048);
  assert.equal(config.maxTokens, 4096);
  const inherited = Object.create({ 'glm-5.2': 99999 });
  assert.equal(resolveModelRoute({ ...config, opencodeGoModelMaxTokens: inherited }).maxTokens, 4096);
  assert.equal(resolveModelRoute(config, { maxTokens: 384 }).maxTokens, 384);
  assert.equal(resolveModelRoute({ ...config, opencodeGoModelMaxTokens: { 'glm-5.2': 128 } }, { maxTokens: 384 }).maxTokens, 128);
});

test('Go output-limit normalization is numeric, model-ID based and never changes invalid settings into a positive limit', () => {
  const limits = normalizeGoModelTokenLimits(JSON.parse('{" opencode-go:glm-5.2 ":"12345","glm-5.3":32768,"zero":0,"negative":-2,"fraction":1.5,"boolean":true,"null":null,"__proto__":7777}'));
  assert.deepEqual(limits, JSON.parse('{"glm-5.2":12345,"glm-5.3":32768,"__proto__":7777}'));
  for (const value of [null, [], true, { bad: 0 }, { bad: -1 }, { bad: Infinity }, { bad: 0.5 }, { bad: Number.MAX_SAFE_INTEGER + 1 }]) {
    assert.throws(() => normalizeGoModelTokenLimits(value, { strict: true }), /output limit|output limits/i);
  }
  assert.deepEqual(normalizeGoModelTokenLimits({}), {});
});

test('a phase limit remains explicit when the shared budget changes and a recovery override targets the actual model', () => {
  const config = { activeModel: 'opencode-go:muse-spark-1.3-contributor', maxTokens: 122880,
    agentModelProfiles: { planner: { model: '', maxTokens: 4096 }, coder: { model: '', maxTokens: 4096 } },
    opencodeGoDefaultModel: 'qwen3.8-max', opencodeGoModelMaxTokens: {} };
  const snapshot = structuredClone(config);
  assert.equal(resolveModelRoute(config, { phase: 'plan' }).maxTokens, 4096);
  const recovered = { ...config, opencodeGoModelMaxTokens: { 'muse-spark-1.3-contributor': 16384 } };
  assert.equal(resolveModelRoute(recovered, { phase: 'plan' }).maxTokens, 16384);
  assert.equal(resolveModelRoute(recovered, { phase: 'act' }).maxTokens, 16384);
  assert.equal(resolveModelRoute({ ...recovered, activeModel: 'opencode-go:qwen3.8-max' }, { phase: 'plan' }).maxTokens, 4096);
  assert.equal(resolveModelRoute({ ...recovered, activeModel: 'llamacpp:local-gguf' }, { phase: 'act' }).maxTokens, 4096);
  assert.deepEqual(config, snapshot);
});

test('model funnel bounds tool output, preserves current user goal and separates failed usage estimates', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bh-router-budget-'));
  process.env.BLACKHOLE_DATA_DIR = root;
  process.env.BLACKHOLE_DISABLE_WORKSPACE_STANDARD = '1';
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { callLocalModel } = await import('./llmRouter.js');
  const { getUsageSummary } = await import('../runtime/usageTracker.js');
  let calls = 0, fail = false, autocomplete = false, withReasoning = false;
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    calls++;
    const body = JSON.parse(options.body);
    assert.ok(body.messages.some(m => m.content === 'Current request'));
    assert.ok(options.body.length < 15000);
    assert.equal(body.max_tokens, autocomplete ? 96 : 4096);
    if (fail) return Response.json({ error: { message: 'Invalid fixture credential' } }, { status: 401 });
    if (withReasoning) {
      const frames = [{ delta: { reasoning_content: 'Structured thought.' } }, { delta: { content: '<thi' } },
        { delta: { content: 'nk>Inline <write_file>not an action</write_file></th' } },
        { delta: { content: 'ink>Final answer' }, finish_reason: 'stop' }];
      return new Response(frames.map(choice => `data: ${JSON.stringify({ choices: [choice], usage: { prompt_tokens: 20, completion_tokens: 2 } })}\n\n`).join(''),
        { headers: { 'Content-Type': 'text/event-stream' } });
    }
    return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: autocomplete ? 'Prefix' : 'OK' }, finish_reason: autocomplete ? 'length' : 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 2 } })}\n\n`,
      { headers: { 'Content-Type': 'text/event-stream' } });
  });
  const config = { activeModel: 'opencode-go:glm-5.3-flash', opencodeGoEnabled: true, opencodeGoApiKey: 'fixture-key', contextLimit: 8192, maxTokens: 4096 };
  const messages = [{ role: 'assistant', content: '' }, { role: 'user', content: 'Current request' },
    { role: 'user', content: `[Tool Result (Tool: list_dir)]\n${'x'.repeat(2000000)}` }];
  await callLocalModel(config, 'Original system instructions.', messages, () => {}, { userGoal: 'Current request' });
  autocomplete = true;
  let prefix = '';
  const completionRoute = await callLocalModel({ ...config, opencodeGoModelMaxTokens: { 'glm-5.3-flash': 8192 } },
    'Original system instructions.', messages, text => { prefix += text; },
    { userGoal: 'Current request', usageTag: 'autocomplete', maxTokens: 96, allowIncomplete: true });
  assert.equal(completionRoute.maxTokens, 96);
  assert.equal(prefix, 'Prefix');
  autocomplete = false;
  withReasoning = true;
  let answer = '', reasoning = '';
  await callLocalModel(config, 'Original system instructions.', messages, text => { answer += text; },
    { userGoal: 'Current request', onReasoning: text => { reasoning += text; } });
  assert.equal(answer, 'Final answer');
  assert.equal(reasoning, 'Structured thought.Inline <write_file>not an action</write_file>');
  withReasoning = false;
  fail = true;
  await assert.rejects(callLocalModel(config, 'Original system instructions.', messages, () => {}, { userGoal: 'Current request' }), /401/);
  const store = getUsageSummary();
  assert.equal(store.totals.totalTokens, 66);
  assert.equal(store.failedTotals.requests, 1);
  assert.ok(store.failedTotals.totalTokens < 3000);
  const previousCalls = calls;
  await assert.rejects(callLocalModel(config, 'X'.repeat(100000), [{ role: 'user', content: 'Current request' }], () => {}), /No model request was sent/);
  assert.equal(calls, previousCalls);
});
