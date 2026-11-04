import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import { randomInt } from 'node:crypto';
import { OpenCodeGoRuntime, getGoModels, resolveGoProtocol } from './openCodeGoRuntime.js';
import { eventBus } from '../common/eventBus.js';
import { GoModelCatalog } from './goModelCatalog.js';

const config = { opencodeGoApiKey: 'go-secret-test', opencodeGoDefaultModel: 'glm-5.3-flash' };
const frame = data => `data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`;
const conversation = [{ role: 'system', content: 'Original system instructions.' },
  { role: 'user', content: 'Original request.' }, { role: 'assistant', content: 'Previous answer.' }];

for (const [model, protocol, frames] of [
  ['glm-5.3-flash', 'chat', [{ choices: [{ delta: { content: 'Partial' }, finish_reason: 'length' }] }]],
  ['qwen3.8-max', 'messages', [{ type: 'content_block_delta', delta: { type: 'text_delta', text: 'Partial' } }, { type: 'message_delta', delta: { stop_reason: 'max_tokens' } }]],
  ['gpt-6-luna', 'responses', [{ type: 'response.output_text.delta', delta: 'Partial' }, { type: 'response.incomplete', response: { incomplete_details: { reason: 'max_output_tokens' } } }]],
  ['gemini-4-argon', 'google', [{ candidates: [{ content: { parts: [{ text: 'Partial' }] }, finishReason: 'MAX_TOKENS' }] }]]
]) {
  test(`${protocol} output-limit diagnostics preserve partial text and never replay`, async t => {
    const fake = await serverFor(t, (_req, res) => {
      res.setHeader('Content-Type', 'text/event-stream');
      res.end(frames.map(frame).join(''));
    });
    const runtime = new OpenCodeGoRuntime(config, { ...fake, retryDelayMs: 0 });
    let answer = '';
    await assert.rejects(runtime.chatStream({ model, maxTokens: 12345, messages: conversation }, text => { answer += text; }), error => {
      assert.equal(error.modelFailure.code, 'output_token_limit');
      assert.equal(error.modelFailure.outputTokenLimit, 12345);
      assert.equal(error.modelFailure.retryable, false);
      assert.equal(error.modelFailure.partialOutput, true);
      assert.match(error.message, /checkpoint/);
      return true;
    });
    assert.equal(answer, 'Partial');
    assert.equal(fake.requests.length, 1);
    const body = fake.requests[0].body;
    assert.equal(body.max_tokens ?? body.max_output_tokens ?? body.generationConfig?.maxOutputTokens, 12345);
  });
}

for (const [model, protocol, end] of [
  ['glm-5.3-flash', 'chat', { choices: [{ delta: {}, finish_reason: 'stop' }] }],
  ['qwen3.8-max', 'messages', { type: 'message_stop' }],
  ['gpt-6-luna', 'responses', { type: 'response.completed' }],
  ['gemini-4-argon', 'google', { candidates: [{ finishReason: 'STOP' }] }]
]) {
  test(`${protocol} rejects a completed stream with no answer and no tool instead of claiming success`, async t => {
    const fake = await serverFor(t, (_req, res) => {
      res.setHeader('Content-Type', 'text/event-stream');
      res.end(frame(end));
    });
    const rt = new OpenCodeGoRuntime(config, { ...fake, retryDelayMs: 0 });
    await assert.rejects(rt.chatStream({ model, messages: conversation }, () => {}), error => error.modelFailure?.code === 'empty_response');
    assert.equal(fake.requests.length, 2);
  });
}

test('an empty completion can retry once without changing the session or request', async t => {
  const fake = await serverFor(t, (_req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.end(frame({ choices: [{ delta: fake.requests.length === 1 ? {} : { content: 'Recovered answer' }, finish_reason: 'stop' }] }));
  });
  const runtime = new OpenCodeGoRuntime(config, { ...fake, retryDelayMs: 0 });
  let answer = '';
  await runtime.chatStream({ model: 'glm-5.3-flash', messages: conversation, sessionId: 'empty-recovery' }, text => { answer += text; });
  assert.equal(answer, 'Recovered answer');
  assert.equal(fake.requests.length, 2);
  assert.deepEqual(fake.requests[0].body, fake.requests[1].body);
  assert.equal(fake.requests[0].headers['x-opencode-session'], fake.requests[1].headers['x-opencode-session']);
});

test('reasoning or whitespace without an answer is not silently completed or replayed', async t => {
  for (const delta of [{ reasoning_content: 'Still thinking' }, { content: ' \r\n' }]) {
    const fake = await serverFor(t, (_req, res) => {
      res.setHeader('Content-Type', 'text/event-stream');
      res.end(frame({ choices: [{ delta, finish_reason: 'stop' }] }));
    });
    const runtime = new OpenCodeGoRuntime(config, { ...fake, retryDelayMs: 0 });
    await assert.rejects(runtime.chatStream({ model: 'glm-5.3-flash', messages: conversation }, () => {}),
      error => error.modelFailure?.code === 'empty_response' && error.modelFailure.partialOutput === true);
    assert.equal(fake.requests.length, 1);
  }
});

async function serverFor(t, handler) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const entry = { url: req.url, headers: req.headers, body: body ? JSON.parse(body) : null };
    requests.push(entry);
    handler(entry, res);
  });
  // Keep local transport fixtures outside fetch's restricted low-port range.
  for (let attempt = 0; ; attempt++) {
    try {
      await new Promise((resolve, reject) => {
        const onError = error => { server.off('listening', onListening); reject(error); };
        const onListening = () => { server.off('error', onError); resolve(); };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(randomInt(49152, 65536), '127.0.0.1');
      });
      break;
    } catch (error) {
      if (attempt >= 19 || !['EADDRINUSE', 'EACCES'].includes(error.code)) throw error;
    }
  }
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return { requests, baseUrl: `http://127.0.0.1:${server.address().port}/zen/go/v1` };
}

test('Go protocol is model-specific, unknown models require an explicit choice', () => {
  assert.equal(resolveGoProtocol('opencode-go:glm-5.3-flash'), 'chat');
  assert.equal(resolveGoProtocol('minimax-m2.7'), 'messages');
  assert.equal(resolveGoProtocol('gpt-6-luna'), 'responses');
  assert.equal(resolveGoProtocol('future-model'), null);
  for (const id of ['constructor', '__proto__', 'toString']) assert.equal(resolveGoProtocol(id), null);
  assert.equal(resolveGoProtocol('future-model', { opencodeGoProtocolOverrides: { 'future-model': 'messages' } }), 'messages');
  const entries = getGoModels({ opencodeGoModels: ['glm-5.3-flash', 'glm-5.3-flash', 'future-model'] });
  assert.equal(entries.length, 2);
  assert.equal(entries[1].protocol, null);
});

test('Go key is separate from generic API keys and never appears in describe', () => {
  const rt = new OpenCodeGoRuntime({ opengoApiKey: 'generic', apiKeys: { openai: 'openai' } });
  assert.equal(rt.isConfigured(), false);
  assert.equal(new OpenCodeGoRuntime({ opencodeGoApiKey: '********' }).isConfigured(), false);
  assert.ok(!JSON.stringify(new OpenCodeGoRuntime(config).describe()).includes(config.opencodeGoApiKey));
});

test('Go catalog discovery is public, preserves API prefix, and does not validate keys', async t => {
  const fake = await serverFor(t, (req, res) => {
    assert.equal(req.url, '/zen/go/v1/models');
    assert.equal(req.headers.authorization, undefined);
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ data: [{ id: 'glm-5.3-flash' }, { id: 'future-model' }] }));
  });
  const rt = new OpenCodeGoRuntime({}, fake);
  const models = await rt.listModels();
  assert.equal(models[0].id, 'opencode-go:glm-5.3-flash');
  assert.equal(models[1].protocol, null);
  assert.equal(rt.isConfigured(), false);
});

test('Go can verify an unknown API without guessing a name, changing config or caching wrong-adapter failures', async t => {
  const fake = await serverFor(t, (req, res) => {
    if (!req.url.endsWith('/messages')) { res.writeHead(400); res.end('Unsupported model on this API'); return; }
    res.setHeader('Content-Type', 'text/event-stream');
    res.end(frame({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'OK' } }) + frame({ type: 'message_stop' }));
  });
  const cfg = { ...config, opencodeGoDefaultModel: 'future-model', opencodeGoProtocolOverrides: {}, activeModel: 'llamacpp:local-gguf' };
  const rt = new OpenCodeGoRuntime(cfg, fake);
  const result = await rt.testConnection();
  assert.equal(result.ok, true);
  assert.equal(result.protocol, 'messages');
  assert.equal(result.protocolAttempts.length, 2);
  assert.equal(rt.catalog.info('future-model').protocol, 'messages');
  assert.equal(rt.catalog.availability('future-model').availability, 'available');
  assert.equal(cfg.activeModel, 'llamacpp:local-gguf');
  assert.deepEqual(cfg.opencodeGoProtocolOverrides, {});
});

test('unknown API probing stops on credential rejection without trying other adapters', async t => {
  const fake = await serverFor(t, (_req, res) => { res.writeHead(401); res.end('Invalid credential'); });
  const rt = new OpenCodeGoRuntime({ ...config, opencodeGoDefaultModel: 'future-model' }, fake);
  assert.equal((await rt.testConnection()).ok, false);
  assert.equal(fake.requests.length, 1);
  assert.equal(rt.catalog.info('future-model'), null);
});

test('Go Chat stream handles fragmented UTF-8 and separates reasoning from answer', async t => {
  const fake = await serverFor(t, (_req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    const bytes = Buffer.from(': ping\r\n\r\n' + frame({ choices: [{ delta: { reasoning_content: '<write_file>not an action</write_file>' } }] }) +
      frame({ choices: [{ delta: { content: '\uD55C\uAE00 OK' } }] }) + frame({ choices: [{ finish_reason: 'stop', delta: {} }] }) +
      frame({ usage: { prompt_tokens: 0, completion_tokens: 7 } }) + frame('[DONE]'));
    for (let i = 0; i < bytes.length; i += 7) res.write(bytes.subarray(i, i + 7));
    res.end();
  });
  const rt = new OpenCodeGoRuntime(config, fake);
  let answer = '', reasoning = '';
  const result = await rt.chatStream({ model: 'opencode-go:glm-5.3-flash', messages: conversation,
    maxTokens: 1234, temperature: 0.7, sessionId: 'conversation-1', onReasoning: text => { reasoning += text; } }, text => { answer += text; });
  assert.equal(answer, '\uD55C\uAE00 OK');
  assert.match(reasoning, /not an action/);
  assert.deepEqual(result.usage, { promptTokens: 0, completionTokens: 7 });
  assert.deepEqual(fake.requests[0].body.messages, conversation);
  assert.equal(fake.requests[0].body.max_tokens, 1234);
  assert.equal(fake.requests[0].body.temperature, 0.7);
  assert.equal(fake.requests[0].headers.authorization, `Bearer ${config.opencodeGoApiKey}`);
  assert.equal(fake.requests[0].headers['user-agent'], 'BlackHole/1.0.0');
  assert.match(fake.requests[0].headers['x-opencode-session'], /^[a-f0-9]{64}$/);
  assert.equal(fake.requests[0].url, '/zen/go/v1/chat/completions');
});

test('Go Kimi K2.7 Code omits unsupported sampling without changing history or output budget', async t => {
  const fake = await serverFor(t, (req, res) => {
    assert.equal(Object.hasOwn(req.body, 'temperature'), false);
    res.setHeader('Content-Type', 'text/event-stream');
    res.end(frame({ choices: [{ delta: { content: 'OK' }, finish_reason: 'stop' }] }));
  });
  const rt = new OpenCodeGoRuntime({ ...config, opencodeGoDefaultModel: 'kimi-k2.7-code' }, fake);
  let answer = '';
  await rt.chatStream({ model: 'opencode-go:kimi-k2.7-code', messages: conversation,
    maxTokens: 4096, temperature: 0.2 }, text => { answer += text; });
  assert.equal(answer, 'OK');
  assert.deepEqual(fake.requests[0].body.messages, conversation);
  assert.equal(fake.requests[0].body.max_tokens, 4096);
  assert.equal(rt.config.opencodeGoDefaultModel, 'kimi-k2.7-code');
  const connection = await rt.testConnection();
  assert.equal(connection.ok, true);
  assert.equal(connection.authenticated, true);
  assert.equal(fake.requests[1].body.max_tokens, 64);
});

test('Go Kimi K2.6 also omits sampling rejected by the provider', async t => {
  const fake = await serverFor(t, (req, res) => {
    assert.equal(Object.hasOwn(req.body, 'temperature'), false);
    res.setHeader('Content-Type', 'text/event-stream');
    res.end(frame({ choices: [{ delta: { content: 'OK' }, finish_reason: 'stop' }] }) + frame('[DONE]'));
  });
  await new OpenCodeGoRuntime(config, fake).chatStream({ model: 'kimi-k2.6',
    messages: conversation, temperature: 0.15 }, () => {});
});

test('Go Google preserves original instructions and history, separates thought text and counts usage', async t => {
  const fake = await serverFor(t, (req, res) => {
    assert.equal(req.url, '/zen/go/v1/models/gemini-4-argon:streamGenerateContent?alt=sse');
    assert.equal(req.headers.authorization, `Bearer ${config.opencodeGoApiKey}`);
    assert.deepEqual(req.body.systemInstruction, { parts: [{ text: conversation[0].content }] });
    assert.deepEqual(req.body.contents, conversation.slice(1).map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })));
    assert.deepEqual(req.body.generationConfig, { maxOutputTokens: 4096 });
    assert.equal(Object.hasOwn(req.body, 'safetySettings'), false);
    res.setHeader('Content-Type', 'text/event-stream');
    res.end(frame({ candidates: [{ content: { parts: [{ text: 'thinking', thought: true }, { text: 'OK' }] } }] }) +
      frame({ candidates: [{ finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 2, thoughtsTokenCount: 5 } }));
  });
  const rt = new OpenCodeGoRuntime(config, fake);
  let answer = '', reasoning = '';
  const result = await rt.chatStream({ model: 'gemini-4-argon', messages: conversation,
    maxTokens: 4096, onReasoning: chunk => { reasoning += chunk; } }, chunk => { answer += chunk; });
  assert.equal(answer, 'OK');
  assert.equal(reasoning, 'thinking');
  assert.deepEqual(result.usage, { promptTokens: 12, completionTokens: 7 });
});

test('Go Google token-limit output is incomplete for chat but usable for an explicit connection test', async t => {
  const fake = await serverFor(t, (_req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.end(frame({ candidates: [{ finishReason: 'MAX_TOKENS' }], usageMetadata: { promptTokenCount: 3, thoughtsTokenCount: 64 } }));
  });
  const rt = new OpenCodeGoRuntime({ ...config, opencodeGoDefaultModel: 'gemini-4-argon' }, fake);
  await assert.rejects(rt.chatStream({ model: 'gemini-4-argon', messages: conversation }, () => {}), /MAX_TOKENS/);
  assert.equal((await rt.testConnection()).ok, true);
});

test('Go Google retries a transient empty stream error but never replays partial thoughts', async t => {
  let requests = 0, partial = false;
  const fake = await serverFor(t, (_req, res) => {
    requests++;
    res.setHeader('Content-Type', 'text/event-stream');
    if (requests === 2) { res.end(frame({ candidates: [{ content: { parts: [{ text: 'OK' }] }, finishReason: 'STOP' }] })); return; }
    res.end((partial ? frame({ candidates: [{ content: { parts: [{ thought: true, text: 'thinking' }] } }] }) : '') +
      frame({ error: { code: 503, status: 'UNAVAILABLE', message: 'Try later' } }));
  });
  const rt = new OpenCodeGoRuntime(config, { ...fake, retryDelayMs: 1 });
  await rt.chatStream({ model: 'gemini-4-argon', messages: conversation }, () => {});
  assert.equal(requests, 2);
  partial = true;
  await assert.rejects(rt.chatStream({ model: 'gemini-4-argon', messages: conversation }, () => {}), error => {
    assert.equal(error.modelFailure.partialOutput, true);
    assert.equal(error.modelFailure.attempts, 1);
    return true;
  });
  assert.equal(requests, 3);
});

test('Go Google cancellation stops a stalled native stream', async t => {
  const controller = new AbortController();
  const fake = await serverFor(t, (_req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.write(frame({ candidates: [{ content: { parts: [{ text: 'first' }] } }] }));
  });
  let answer = '';
  await assert.rejects(new OpenCodeGoRuntime(config, fake).chatStream({ model: 'gemini-4-argon', messages: conversation,
    signal: controller.signal }, chunk => { answer += chunk; controller.abort(); }), { name: 'AbortError' });
  assert.equal(answer, 'first');
  assert.equal(fake.requests.length, 1);
});

test('Go Google native tool calls retain signatures privately and return real results in the next request', async t => {
  let requests = 0;
  const tools = [{ name: 'read_file', description: 'Read file', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }];
  const fake = await serverFor(t, (req, res) => {
    requests++;
    assert.equal(req.body.tools[0].functionDeclarations[0].name, 'read_file');
    assert.equal(req.body.toolConfig.functionCallingConfig.mode, 'AUTO');
    res.setHeader('Content-Type', 'text/event-stream');
    if (requests === 1) res.end(frame({ candidates: [{ content: { parts: [{ functionCall: { id: 'call-1', name: 'read_file', args: { path: 'hello.js' } }, thoughtSignature: 'fixture-private-signature' }] }, finishReason: 'STOP' }] }));
    else {
      const parts = req.body.contents.flatMap(c => c.parts);
      assert.ok(parts.some(p => p.thoughtSignature === 'fixture-private-signature'));
      assert.deepEqual(parts.find(p => p.functionResponse).functionResponse, { id: 'call-1', name: 'read_file', response: { result: '[Tool Result (Tool: read_file)]\nOriginal file contents.' } });
      res.end(frame({ candidates: [{ content: { parts: [{ text: 'Final answer' }] }, finishReason: 'STOP' }] }));
    }
  });
  const rt = new OpenCodeGoRuntime(config, fake);
  let first = '';
  const result = await rt.chatStream({ model: 'gemini-4-argon', messages: conversation, tools, sessionId: 'same-conversation' }, chunk => { first += chunk; });
  assert.deepEqual(JSON.parse(first), { tool_calls: [{ tool: 'read_file', params: { path: 'hello.js' } }] });
  assert.ok(!first.includes('fixture-private-signature'));
  const messages = [...conversation, { role: 'assistant', content: first, goGoogleState: result.goGoogleState },
    { role: 'user', content: '[Tool Result (Tool: read_file)]\nOriginal file contents.' }];
  await rt.chatStream({ model: 'gemini-4-argon', messages, tools, sessionId: 'same-conversation' }, () => {});
});

test('Go Google does not emit tool calls from a malformed or undeclared response', async t => {
  let malformed = true;
  const fake = await serverFor(t, (_req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.end(frame({ candidates: [{ content: { parts: [{ functionCall: { name: 'write_file', args: { path: 'never.txt' } } }] },
      finishReason: malformed ? 'MALFORMED_FUNCTION_CALL' : 'STOP' }] }));
  });
  const rt = new OpenCodeGoRuntime(config, fake);
  let output = '';
  await assert.rejects(rt.chatStream({ model: 'gemini-4-argon', tools: [] }, chunk => { output += chunk; }), /MALFORMED_FUNCTION_CALL/);
  assert.equal(output, '');
  malformed = false;
  await assert.rejects(rt.chatStream({ model: 'gemini-4-argon', tools: [] }, chunk => { output += chunk; }), /Undeclared Google function call/);
  assert.equal(output, '');
});

test('Go uses official native endpoints for all four adapters without metadata URL overrides', async t => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    calls.push({ url, init });
    const end = url.includes('/responses') ? { type: 'response.completed' } : url.includes('/messages')
      ? { type: 'message_stop' } : url.includes('/google/') ? { candidates: [{ finishReason: 'STOP' }] } : '[DONE]';
    const text = url.includes('/responses') ? { type: 'response.output_text.delta', delta: 'OK' }
      : url.includes('/messages') ? { type: 'content_block_delta', delta: { type: 'text_delta', text: 'OK' } }
        : url.includes('/google/') ? { candidates: [{ content: { parts: [{ text: 'OK' }] } }] }
          : { choices: [{ delta: { content: 'OK' } }] };
    return new Response(frame(text) + frame(end), { headers: { 'Content-Type': 'text/event-stream' } });
  });
  const catalog = new GoModelCatalog({ cacheFile: null });
  const rt = new OpenCodeGoRuntime(config, { catalog });
  for (const model of ['glm-5.3-flash', 'qwen3.8-max', 'muse-spark-1.3-contributor', 'gemini-4-argon']) {
    await rt.chatStream({ model, messages: conversation, sessionId: 'same' }, () => {});
  }
  assert.deepEqual(calls.map(c => c.url), [
    'https://opencode.ai/inference/go/openai/v1/chat/completions',
    'https://opencode.ai/inference/go/anthropic/v1/messages',
    'https://opencode.ai/inference/go/openai/v1/responses',
    'https://opencode.ai/inference/go/google/v1beta/models/gemini-4-argon:streamGenerateContent?alt=sse'
  ]);
  assert.equal(new Set(calls.map(c => c.init.headers['x-opencode-session'])).size, 1);
});

test('Go unsupported-model rejection is visible, auth errors are not misclassified, and a retest recovers', async t => {
  let status = 400;
  const fake = await serverFor(t, (_req, res) => {
    if (status !== 200) { res.writeHead(status); res.end(JSON.stringify({ error: { message: 'Unsupported model mimo-v2.5-pro' } })); return; }
    res.setHeader('Content-Type', 'text/event-stream');
    res.end(frame({ choices: [{ delta: { content: 'OK' }, finish_reason: 'stop' }] }));
  });
  const rt = new OpenCodeGoRuntime({ ...config, opencodeGoDefaultModel: 'mimo-v2.5-pro' }, fake);
  const first = await rt.testConnection();
  assert.equal(first.modelFailure.category, 'unsupported_model');
  assert.equal(rt.describe().models.find(m => m.name === 'mimo-v2.5-pro').availability, 'unsupported');
  status = 401;
  const unauthorized = await rt.testConnection();
  assert.equal(unauthorized.modelFailure.category, undefined);
  assert.equal(rt.catalog.availability('mimo-v2.5-pro').availability, 'request_failed');
  status = 200;
  assert.equal((await rt.testConnection()).ok, true);
  assert.equal(rt.describe().models.find(m => m.name === 'mimo-v2.5-pro').availability, 'available');
});

test('Go 410 is a visible retired state without retrying or replacing the selected model', async t => {
  let retired = true;
  const fake = await serverFor(t, (_req, res) => {
    if (retired) { res.writeHead(410); res.end('Model retired. Select a replacement explicitly.'); return; }
    res.setHeader('Content-Type', 'text/event-stream');
    res.end(frame({ choices: [{ delta: { content: 'OK' }, finish_reason: 'stop' }] }));
  });
  const cfg = { ...config, activeModel: 'opencode-go:mimo-v2.5-pro', opencodeGoDefaultModel: 'mimo-v2.5-pro' };
  const runtime = new OpenCodeGoRuntime(cfg, fake);
  const first = await runtime.testConnection();
  assert.equal(first.modelFailure.category, 'retired');
  assert.equal(first.modelFailure.retryable, false);
  assert.equal(fake.requests.length, 1);
  assert.equal(runtime.catalog.availability('mimo-v2.5-pro').availability, 'retired');
  assert.equal(cfg.activeModel, 'opencode-go:mimo-v2.5-pro');
  retired = false;
  assert.equal((await runtime.testConnection()).ok, true);
  assert.equal(runtime.catalog.availability('mimo-v2.5-pro').availability, 'available');
});

test('Go exhausted transient failures replace old availability without exposing credentials or switching models', async t => {
  let failed = true;
  const fake = await serverFor(t, (_req, res) => {
    if (failed) { res.writeHead(503); res.end(`Upstream endpoint unavailable ${config.opencodeGoApiKey}`); return; }
    res.setHeader('Content-Type', 'text/event-stream');
    res.end(frame({ choices: [{ delta: { content: 'OK' }, finish_reason: 'stop' }] }));
  });
  const rt = new OpenCodeGoRuntime(config, { ...fake, retryDelayMs: 0 });
  rt.catalog.observe('glm-5.3-flash', 'available');
  const result = await rt.testConnection();
  assert.equal(result.ok, false);
  assert.equal(fake.requests.length, 2);
  const availability = rt.catalog.availability('glm-5.3-flash');
  assert.equal(availability.availability, 'temporary_error');
  assert.match(availability.availabilityReason, /http_503/);
  assert.ok(!availability.availabilityReason.includes(config.opencodeGoApiKey));
  assert.equal(config.opencodeGoDefaultModel, 'glm-5.3-flash');
  failed = false;
  assert.equal((await rt.testConnection()).ok, true);
  assert.equal(rt.catalog.availability('glm-5.3-flash').availability, 'available');
});

test('Go Messages preserves system text, extracts text blocks and includes cached token usage', async t => {
  const fake = await serverFor(t, (_req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.end(frame({ type: 'message_start', message: { usage: { input_tokens: 3, cache_read_input_tokens: 4, cache_creation_input_tokens: 5 } } }) +
      frame({ type: 'content_block_start', content_block: { type: 'text', text: 'Hello' } }) +
      frame({ type: 'content_block_delta', delta: { type: 'text_delta', text: '!' } }) +
      frame({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 8 } }) + frame({ type: 'message_stop' }));
  });
  const rt = new OpenCodeGoRuntime(config, fake);
  let answer = '';
  const result = await rt.chatStream({ model: 'minimax-m2.7', messages: conversation, maxTokens: 2048 }, chunk => { answer += chunk; });
  assert.equal(answer, 'Hello!');
  assert.deepEqual(result.usage, { promptTokens: 12, completionTokens: 8 });
  assert.deepEqual(fake.requests[0].body.system, [{ type: 'text', text: conversation[0].content }]);
  assert.deepEqual(fake.requests[0].body.messages, conversation.slice(1));
  assert.equal(fake.requests[0].headers['x-api-key'], config.opencodeGoApiKey);
  assert.equal(fake.requests[0].headers['anthropic-version'], '2023-06-01');
  assert.equal(fake.requests[0].url, '/zen/go/v1/messages');
});

test('Go Responses preserves history, uses output budget and reports terminal usage', async t => {
  const fake = await serverFor(t, (_req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.end(frame({ type: 'response.output_text.delta', delta: 'OK' }) + frame({ type: 'response.completed', response: { usage: { input_tokens: 11, output_tokens: 2 } } }));
  });
  const rt = new OpenCodeGoRuntime(config, fake);
  let answer = '';
  const result = await rt.chatStream({ model: 'gpt-6-luna', messages: conversation, maxTokens: 555 }, text => { answer += text; });
  assert.equal(answer, 'OK');
  assert.deepEqual(result.usage, { promptTokens: 11, completionTokens: 2 });
  assert.deepEqual(fake.requests[0].body.input, conversation);
  assert.equal(fake.requests[0].body.max_output_tokens, 555);
  assert.equal(fake.requests[0].body.store, false);
  assert.equal(fake.requests[0].body.temperature, undefined);
  assert.equal(fake.requests[0].url, '/zen/go/v1/responses');
});

test('Go session header stays stable across auxiliary calls and differs between conversations', async t => {
  const fake = await serverFor(t, (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.end(req.url.endsWith('/responses')
      ? frame({ type: 'response.output_text.delta', delta: 'OK' }) + frame({ type: 'response.completed' })
      : frame({ choices: [{ delta: { content: 'OK' } }] }) + frame('[DONE]'));
  });
  for (const [sessionId, model] of [['same', 'glm-5.3-flash'], ['same', 'gpt-6-luna'], ['different', 'glm-5.3-flash']]) {
    await new OpenCodeGoRuntime(config, fake).chatStream({ model, messages: conversation, sessionId }, () => {});
  }
  const headers = fake.requests.map(req => req.headers['x-opencode-session']);
  assert.equal(headers[0], headers[1]);
  assert.notEqual(headers[1], headers[2]);
});

test('Go authentication test performs real inference, does not call public models', async t => {
  const fake = await serverFor(t, (_req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.end(frame({ choices: [{ delta: { content: 'OK' }, finish_reason: 'stop' }] }));
  });
  const result = await new OpenCodeGoRuntime(config, fake).testConnection();
  assert.equal(result.ok, true);
  assert.equal(result.authenticated, true);
  assert.equal(fake.requests.length, 1);
  assert.equal(fake.requests[0].body.max_tokens, 64);
});

test('Go authentication test accepts a reasoning-only token-budget completion with usage', async t => {
  const fake = await serverFor(t, (_req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.end(frame({ type: 'response.incomplete', response: { incomplete_details: { reason: 'max_output_tokens' }, usage: { input_tokens: 5, output_tokens: 64 } } }));
  });
  const result = await new OpenCodeGoRuntime({ ...config, opencodeGoDefaultModel: 'gpt-6-luna' }, fake).testConnection();
  assert.equal(result.ok, true);
  assert.equal(result.authenticated, true);
});

test('A free-model response is not claimed as API key authentication', async t => {
  const fake = await serverFor(t, (_req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.end(frame({ choices: [{ delta: { content: 'OK' }, finish_reason: 'stop' }] }));
  });
  const result = await new OpenCodeGoRuntime({ ...config, opencodeGoDefaultModel: 'space-bunny-free' }, fake).testConnection();
  assert.equal(result.ok, true);
  assert.equal(result.authenticated, false);
});

test('Go HTTP errors redact keys and never emit them in logs', async t => {
  const fake = await serverFor(t, (_req, res) => { res.writeHead(401); res.end(`Invalid key: ${config.opencodeGoApiKey}`); });
  const logs = [];
  const listener = entry => logs.push(entry);
  eventBus.on('log', listener);
  t.after(() => eventBus.off('log', listener));
  const result = await new OpenCodeGoRuntime(config, fake).testConnection();
  assert.equal(result.ok, false);
  assert.match(result.error, /401/);
  assert.ok(!result.error.includes(config.opencodeGoApiKey));
  assert.ok(!JSON.stringify(logs).includes(config.opencodeGoApiKey));
});

for (const [name, model, payload] of [
  ['Chat', 'glm-5.3-flash', { error: { message: 'Quota exceeded' } }],
  ['Messages', 'minimax-m2.7', { type: 'error', error: { message: 'Overloaded' } }],
  ['Responses', 'gpt-6-luna', { type: 'response.failed', response: { error: { message: 'Failed' } } }],
  ['Incomplete', 'gpt-6-luna', { type: 'response.incomplete', response: { incomplete_details: { reason: 'max_output_tokens' } } }]
]) {
  test(`Go ${name} stream errors are not swallowed`, async t => {
    const fake = await serverFor(t, (_req, res) => { res.setHeader('Content-Type', 'text/event-stream'); res.end(frame(payload)); });
    await assert.rejects(new OpenCodeGoRuntime(config, fake).chatStream({ model, messages: conversation }, () => {}));
  });
}

test('Go detects a disconnected partial stream', async t => {
  const fake = await serverFor(t, (_req, res) => { res.setHeader('Content-Type', 'text/event-stream'); res.end(frame({ choices: [{ delta: { content: 'partial' } }] })); });
  await assert.rejects(new OpenCodeGoRuntime(config, fake).chatStream({ model: 'glm-5.3-flash', messages: conversation }), /before completion/);
});

test('Go caller cancellation stops inference without later chunks', async t => {
  const controller = new AbortController();
  const fake = await serverFor(t, (_req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.write(frame({ choices: [{ delta: { content: 'first' } }] }));
  });
  const chunks = [];
  await assert.rejects(new OpenCodeGoRuntime(config, fake).chatStream({ model: 'glm-5.3-flash', messages: conversation, signal: controller.signal }, text => {
    chunks.push(text); controller.abort();
  }), error => error.name === 'AbortError');
  assert.deepEqual(chunks, ['first']);
});

test('Go pre-aborted requests and missing/unknown configuration never contact the server', async t => {
  const fake = await serverFor(t, (_req, res) => res.end());
  const aborted = AbortSignal.abort();
  await assert.rejects(new OpenCodeGoRuntime(config, fake).chatStream({ model: 'glm-5.3-flash', signal: aborted }), e => e.name === 'AbortError');
  await assert.rejects(new OpenCodeGoRuntime({}, fake).chatStream({ model: 'glm-5.3-flash' }), /key is missing/);
  await assert.rejects(new OpenCodeGoRuntime(config, fake).chatStream({ model: 'future-model' }), /API type/);
  assert.equal(fake.requests.length, 0);
});

test('Go request timeout stops a stalled stream', async t => {
  const fake = await serverFor(t, (_req, res) => { res.setHeader('Content-Type', 'text/event-stream'); res.flushHeaders(); });
  const runtime = new OpenCodeGoRuntime(config, fake);
  runtime.timeoutMs = 50;
  await assert.rejects(runtime.chatStream({ model: 'glm-5.3-flash', messages: conversation }), error => error.name === 'TimeoutError');
});

test('Go completion marker ends inference even if a proxy keeps its socket open', async t => {
  const fake = await serverFor(t, (_req, res) => { res.setHeader('Content-Type', 'text/event-stream'); res.write(frame({ choices: [{ delta: { content: 'OK' } }] }) + frame('[DONE]')); });
  await new OpenCodeGoRuntime(config, fake).chatStream({ model: 'glm-5.3-flash', messages: conversation, signal: AbortSignal.timeout(2000) });
});

test('Go rejects malformed stream JSON and output truncation', async t => {
  let malformed = true;
  const fake = await serverFor(t, (_req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.end(malformed ? frame('{not json') : frame({ choices: [{ finish_reason: 'length' }] }));
  });
  const runtime = new OpenCodeGoRuntime(config, fake);
  await assert.rejects(runtime.chatStream({ model: 'glm-5.3-flash', messages: conversation }), /invalid stream event/);
  malformed = false;
  await assert.rejects(runtime.chatStream({ model: 'glm-5.3-flash', messages: conversation }), /token limit/);
});

for (const code of ['server_error', undefined]) {
  test(`Muse generation failure (${code || 'legacy message'}) retries only inference and preserves the request`, async t => {
    let calls = 0;
    const fake = await serverFor(t, (_req, res) => {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('x-request-id', 'go-request-1');
      res.end(++calls === 1
        ? frame({ type: 'response.failed', response: { error: { code, message: 'The model failed to generate a response.' } } })
        : frame({ type: 'response.output_text.delta', delta: 'Recovered.' }) + frame({ type: 'response.completed', response: { usage: { input_tokens: 10, output_tokens: 3 } } }));
    });
    const statuses = [], chunks = [];
    const result = await new OpenCodeGoRuntime(config, { ...fake, retryDelayMs: 1 }).chatStream({
      model: 'muse-spark-1.3-contributor', messages: conversation, sessionId: 'original-session', maxTokens: 4096,
      onStatus: status => statuses.push(status)
    }, text => chunks.push(text));
    assert.deepEqual(chunks, ['Recovered.']);
    assert.deepEqual(result.usage, { promptTokens: 10, completionTokens: 3 });
    assert.equal(calls, 2);
    assert.deepEqual(fake.requests[0].body, fake.requests[1].body);
    assert.deepEqual(fake.requests[0].body.input, conversation);
    assert.equal(fake.requests[0].headers['x-opencode-session'], fake.requests[1].headers['x-opencode-session']);
    assert.equal(statuses.length, 1);
    assert.equal(statuses[0].retryAttempt, 2);
    assert.equal(statuses[0].modelFailure.requestId, 'go-request-1');
    assert.equal(statuses[0].level, 'warning');
  });
}

test('Go bounds retries and retains sanitized model diagnostics on final failure', async t => {
  const fake = await serverFor(t, (_req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('x-request-id', config.opencodeGoApiKey);
    res.end(frame({ type: 'response.failed', response: { error: { code: 'server_error', message: `Failed ${config.opencodeGoApiKey}` } } }));
  });
  await assert.rejects(new OpenCodeGoRuntime(config, { ...fake, retryDelayMs: 1 }).chatStream({ model: 'muse-spark-1.3-contributor' }), error => {
    assert.match(error.message, /muse-spark-1.3-contributor.*responses, server_error/);
    assert.equal(error.modelFailure.attempts, 2);
    assert.equal(error.modelFailure.partialOutput, false);
    assert.ok(!JSON.stringify(error.modelFailure).includes(config.opencodeGoApiKey));
    assert.ok(!error.message.includes(config.opencodeGoApiKey));
    return true;
  });
  assert.equal(fake.requests.length, 2);
});

for (const status of [401, 400, 500, 503]) {
  test(`Go HTTP ${status} retries only transient statuses`, async t => {
    const fake = await serverFor(t, (_req, res) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Request failed' } }));
    });
    await assert.rejects(new OpenCodeGoRuntime(config, { ...fake, retryDelayMs: 1 }).chatStream({ model: 'glm-5.3-flash' }), error => {
      assert.equal(error.modelFailure.httpStatus, status);
      assert.equal(error.modelFailure.requestId, null);
      assert.ok(!error.message.includes('request: Unknown error'));
      return true;
    });
    assert.equal(fake.requests.length, status >= 500 ? 2 : 1);
  });
}

for (const type of ['response.output_text.delta', 'response.reasoning_text.delta']) {
  test(`Go never retries after partial ${type} and cannot duplicate output`, async t => {
    const fake = await serverFor(t, (_req, res) => {
      res.setHeader('Content-Type', 'text/event-stream');
      res.end(frame({ type, delta: 'Partial.' }) + frame({ type: 'response.failed', response: { error: { code: 'server_error', message: 'Failed' } } }));
    });
    const chunks = [];
    await assert.rejects(new OpenCodeGoRuntime(config, { ...fake, retryDelayMs: 1 }).chatStream({ model: 'gpt-6-luna',
      onReasoning: text => chunks.push(text) }, text => chunks.push(text)), error => {
      assert.equal(error.modelFailure.partialOutput, true);
      return true;
    });
    assert.deepEqual(chunks, ['Partial.']);
    assert.equal(fake.requests.length, 1);
  });
}

test('Go cancellation during retry delay prevents any second request', async t => {
  const controller = new AbortController();
  const fake = await serverFor(t, (_req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.end(frame({ error: { code: 'server_error', message: 'Failed' } }));
  });
  await assert.rejects(new OpenCodeGoRuntime(config, fake).chatStream({ model: 'glm-5.3-flash', signal: controller.signal,
    onStatus: () => controller.abort() }), error => error.name === 'AbortError');
  assert.equal(fake.requests.length, 1);
});

test('Go retry delay shares the original timeout and is not reported as user cancellation', async t => {
  const fake = await serverFor(t, (_req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.end(frame({ error: { code: 'server_error', message: 'Failed' } }));
  });
  const runtime = new OpenCodeGoRuntime(config, fake);
  runtime.timeoutMs = 50;
  await assert.rejects(runtime.chatStream({ model: 'glm-5.3-flash' }), error => {
    assert.equal(error.name, 'TimeoutError');
    assert.equal(error.modelFailure.code, 'request_timeout');
    assert.equal(error.modelFailure.requestTimeoutMs, 50);
    assert.equal(error.modelFailure.requestPhase, 'retry_delay');
    return true;
  });
  assert.equal(fake.requests.length, 1);
});

for (const kind of ['headers', 'answer', 'reasoning']) {
  test(`Go timeout preserves model diagnostics during ${kind} waiting without replay`, async t => {
    const fake = await serverFor(t, (_req, res) => {
      if (kind !== 'headers') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'x-request-id': 'timeout-fixture' });
        res.write(frame({ choices: [{ delta: kind === 'answer' ? { content: 'Partial' } : { reasoning_content: 'Partial' } }] }));
      }
    });
    const runtime = new OpenCodeGoRuntime(config, fake);
    runtime.timeoutMs = 150;
    const chunks = [];
    await assert.rejects(runtime.chatStream({ model: 'glm-5.3-flash', onReasoning: text => chunks.push(text) }, text => chunks.push(text)), error => {
      assert.equal(error.name, 'TimeoutError');
      assert.equal(error.modelFailure.code, 'request_timeout');
      assert.equal(error.modelFailure.model, 'glm-5.3-flash');
      assert.equal(error.modelFailure.protocol, 'chat');
      assert.equal(error.modelFailure.requestTimeoutMs, 150);
      assert.equal(error.modelFailure.requestPhase, kind === 'headers' ? 'response_headers' : 'response_stream');
      assert.equal(error.modelFailure.partialOutput, kind !== 'headers');
      assert.equal(error.modelFailure.attempts, 1);
      if (kind !== 'headers') assert.equal(error.modelFailure.requestId, 'timeout-fixture');
      return true;
    });
    assert.equal(fake.requests.length, 1);
    assert.deepEqual(chunks, kind === 'headers' ? [] : ['Partial']);
  });
}

test('Go honors Retry-After and never retries invalid credentials even with a server error code', async t => {
  let status = 429;
  const fake = await serverFor(t, (_req, res) => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Retry-After': '1' });
    res.end(JSON.stringify({ error: { code: 'server_error', message: 'Request failed' } }));
  });
  const waits = [];
  const runtime = new OpenCodeGoRuntime(config, { ...fake, retryDelayMs: 1 });
  runtime.timeoutMs = 100;
  await assert.rejects(runtime.chatStream({ model: 'glm-5.3-flash', onStatus: event => waits.push(event) }), error => error.name === 'TimeoutError');
  assert.match(waits[0].status, /in 1s/);
  assert.equal(fake.requests.length, 1);
  status = 401;
  await assert.rejects(runtime.chatStream({ model: 'glm-5.3-flash' }));
  assert.equal(fake.requests.length, 2);
});
