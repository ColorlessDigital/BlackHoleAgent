import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomInt } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { OpenaiCompatRuntime } from './openaiCompatRuntime.js';
import { LlamaCppRuntime } from './llamaCppRuntime.js';
import { streamChatCompletion } from './chatCompletionStream.js';

const frame = value => `data: ${JSON.stringify(value)}\n\n`;
const answer = content => ({ choices: [{ delta: { content } }] });
const stop = { choices: [{ delta: {}, finish_reason: 'stop' }] };

async function listenFixture(server) {
  for (let attempt = 0; ; attempt++) {
    try {
      await new Promise((resolve, reject) => {
        const error = cause => { server.off('listening', listening); reject(cause); };
        const listening = () => { server.off('error', error); resolve(); };
        server.once('error', error);
        server.once('listening', listening);
        server.listen(randomInt(49152, 65536), '127.0.0.1');
      });
      return;
    } catch (error) {
      if (attempt >= 19 || !['EADDRINUSE', 'EACCES'].includes(error.code)) throw error;
    }
  }
}

for (const provider of ['opengo', 'llamacpp']) {
  async function fixture(t, handler) {
    const server = http.createServer(handler);
    await listenFixture(server);
    t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
    const url = `http://127.0.0.1:${server.address().port}`;
    const runtime = provider === 'opengo' ? new OpenaiCompatRuntime({ opengoBaseUrl: url })
      : new LlamaCppRuntime({ llamaCppUrl: url });
    if (provider === 'llamacpp') runtime.ensureServerRunning = async () => true;
    return { runtime, call: (options = {}, onChunk = () => {}) => runtime.chatStream({
      model: `${provider}:fixture`, messages: [{ role: 'user', content: 'fixture' }], maxTokens: 12345,
      temperature: 0.7, ...options
    }, onChunk) };
  }

  test(`${provider}: completes at DONE without waiting for the server to close`, async t => {
    let closed = false;
    const { call } = await fixture(t, (_req, res) => {
      res.on('close', () => { closed = true; });
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(frame(answer('Complete')) + frame(stop) + 'data: [DONE]\n\n');
    });
    let text = '';
    await call({ signal: AbortSignal.timeout(1000) }, chunk => { text += chunk; });
    assert.equal(text, 'Complete');
    for (let i = 0; i < 50 && !closed; i++) await delay(10);
    assert.equal(closed, true, 'The completed reader must release its HTTP connection.');
  });

  test(`${provider}: parses split UTF-8, CR delimiters and multiline data; preserves sampling and zero usage`, async t => {
    let request;
    const { call } = await fixture(t, async (req, res) => {
      const body = [];
      for await (const chunk of req) body.push(chunk);
      request = JSON.parse(Buffer.concat(body));
      res.writeHead(200, { 'Content-Type': 'Text/Event-Stream; charset=utf-8' });
      const bytes = Buffer.from(': ping\r\rdata:{"choices":\rdata:[{"delta":{"content":"완료"}}]}\r\r' +
        frame({ choices: [{ delta: { reasoning_content: 'private' } }] }) + frame(stop) +
        frame({ usage: { prompt_tokens: 0, completion_tokens: 0 } }) + 'data:[DONE]\r\r');
      for (let i = 0; i < bytes.length; i += 7) { res.write(bytes.subarray(i, i + 7)); await delay(1); }
      res.end();
    });
    let text = '', reasoning = '';
    const result = await call({ onReasoning: chunk => { reasoning += chunk; } }, chunk => { text += chunk; });
    assert.equal(text, '완료');
    assert.equal(reasoning, 'private');
    assert.deepEqual(result.usage, { promptTokens: 0, completionTokens: 0 });
    assert.equal(request.max_tokens, 12345);
    assert.equal(request.temperature, 0.7);
    assert.deepEqual(request.messages, [{ role: 'user', content: 'fixture' }]);
  });

  for (const [name, body, code, partial] of [
    ['disconnected partial answer', frame(answer('Partial')), 'stream_disconnected', true],
    ['invalid JSON', 'data: {invalid}\n\n', 'invalid_stream_event', false],
    ['provider error event', frame({ error: { message: 'fixture overload', code: 'overloaded' } }), 'overloaded', false],
    ['empty answer', frame(stop) + 'data: [DONE]\n\n', 'empty_response', false],
    ['reasoning-only answer', frame({ choices: [{ delta: { reasoning_content: 'thinking' } }] }) + frame(stop), 'empty_response', true],
    ['truncated output', frame(answer('Partial')) + frame({ choices: [{ delta: {}, finish_reason: 'length' }] }), 'output_token_limit', true]
  ]) {
    test(`${provider}: rejects ${name} with structured recovery details`, async t => {
      let requests = 0;
      const { call } = await fixture(t, (_req, res) => {
        requests++;
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'x-request-id': 'fixture-request' });
        res.end(body);
      });
      await assert.rejects(call(), error => {
        assert.equal(error.modelFailure?.provider, provider);
        assert.equal(error.modelFailure?.model, 'fixture');
        assert.equal(error.modelFailure?.code, code, error.stack);
        assert.equal(error.modelFailure?.partialOutput, partial);
        assert.equal(error.modelFailure?.requestId, 'fixture-request');
        if (code === 'output_token_limit') assert.equal(error.modelFailure.outputTokenLimit, 12345);
        return true;
      });
      assert.equal(requests, 1, 'Partial actions must never be automatically replayed.');
    });
  }

  test(`${provider}: accepts an explicit finish reason at EOF and explicit incomplete diagnostics`, async t => {
    let limited = false;
    const { call } = await fixture(t, (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end(frame(answer('OK')) + frame(limited ? { choices: [{ delta: {}, finish_reason: 'length' }] } : stop));
    });
    await call();
    limited = true;
    await call({ allowIncomplete: true });
  });

  test(`${provider}: does not swallow callback failures and releases the reader`, async t => {
    let cancelled = false;
    let timer;
    const response = new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(frame(answer('OK')) + frame(stop)));
        timer = setTimeout(() => controller.close(), 150);
      },
      cancel() { clearTimeout(timer); cancelled = true; }
    }), { headers: { 'Content-Type': 'text/event-stream' } });
    t.mock.method(globalThis, 'fetch', async () => response);
    const runtime = provider === 'opengo' ? new OpenaiCompatRuntime({ opengoBaseUrl: 'http://fixture' }) : new LlamaCppRuntime({});
    runtime.ensureServerRunning = async () => true;
    const failure = new Error('consumer failed');
    await assert.rejects(runtime.chatStream({ model: `${provider}:fixture`, messages: [] }, () => { throw failure; }), /consumer failed/);
    assert.equal(cancelled, true);
    assert.equal(response.body.locked, false);
  });

  test(`${provider}: ignores frames after the terminal marker`, async t => {
    const { call } = await fixture(t, (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end(frame(answer('OK')) + 'data: [DONE]\n\n' + frame(answer('stale')) + 'data: bad-json\n\n');
    });
    let text = '';
    await call({}, chunk => { text += chunk; });
    assert.equal(text, 'OK');
  });

  test(`${provider}: caller cancellation during a stream is not a successful response`, async t => {
    const { call } = await fixture(t, (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(frame(answer('Partial')));
    });
    const controller = new AbortController();
    await assert.rejects(call({ signal: controller.signal }, () => controller.abort()), { name: 'AbortError' });
  });
}

for (const phase of ['response_headers', 'response_stream']) {
  test(`transport timeout preserves ${phase} diagnostics and releases its connection`, async t => {
    let closed = false;
    let requests = 0;
    const server = http.createServer((_req, res) => {
      requests++;
      res.on('close', () => { closed = true; });
      if (phase === 'response_stream') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'x-request-id': 'timeout-fixture' });
        res.write(frame(answer('Partial')));
      }
    });
    await listenFixture(server);
    t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
    await assert.rejects(streamChatCompletion({ url: `http://127.0.0.1:${server.address().port}`, body: {},
      timeoutMs: 100, provider: 'fixture', model: 'fixture' }, () => {}), error => {
      assert.equal(error.name, 'TimeoutError');
      assert.equal(error.modelFailure.code, 'request_timeout');
      assert.equal(error.modelFailure.requestPhase, phase);
      assert.equal(error.modelFailure.requestTimeoutMs, 100);
      assert.equal(error.modelFailure.partialOutput, phase === 'response_stream');
      return true;
    });
    for (let i = 0; i < 50 && !closed; i++) await delay(10);
    assert.equal(closed, true);
    assert.equal(requests, 1);
  });
}

test('transport rejects HTML and overlong stream events without holding reader locks', async t => {
  for (const [body, contentType] of [['<html>gateway error</html>', 'text/html'],
    [`data: ${'x'.repeat(1024 * 1024 + 1)}`, 'text/event-stream']]) {
    const response = new Response(body, { headers: { 'Content-Type': contentType } });
    t.mock.method(globalThis, 'fetch', async () => response);
    await assert.rejects(streamChatCompletion({ url: 'http://fixture', body: {}, timeoutMs: 1000,
      provider: 'fixture', model: 'fixture' }, () => {}));
    assert.equal(response.body.locked, false);
  }
});
