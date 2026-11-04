import assert from 'node:assert/strict';
import test from 'node:test';
import { parseSseLine, consumeAgentEvents, createApiClient } from './client.ts';
import type { StreamEvent } from '../types.ts';

test('P1-6: parseSseLine handles data/done/partial', () => {
  assert.deepEqual(parseSseLine(''), { kind: 'ignore' });
  assert.deepEqual(parseSseLine(': ping'), { kind: 'ignore' });
  assert.deepEqual(parseSseLine('data: [DONE]'), { kind: 'done' });
  const ev = parseSseLine('data: {"type":"chunk","text":"hi"}');
  assert.equal(ev.kind, 'event');
  if (ev.kind === 'event') {
    assert.equal(ev.event.text, 'hi');
  }
  assert.deepEqual(parseSseLine('data: {partial'), { kind: 'ignore' });
});

const response = (text: string) => new Response(text, { headers: { 'Content-Type': 'text/event-stream' } });

test('agent SSE preserves byte-fragmented UTF-8, CRLF and an unterminated final event', async () => {
  const bytes = new TextEncoder().encode(': heartbeat\r\ndata:{"type":"chunk","text":"한글"}\r\n\r\ndata: {"type":"end"}');
  const body = new ReadableStream<Uint8Array>({ start(controller) {
    for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
    controller.close();
  } });
  const events: StreamEvent[] = [];
  await consumeAgentEvents(new Response(body, { headers: { 'Content-Type': 'text/event-stream' } }), event => events.push(event));
  assert.deepEqual(events, [{ type: 'chunk', text: '한글' }, { type: 'end' }]);
});

test('agent SSE rejects EOF without completion and preserves prior partial output', async () => {
  const events: StreamEvent[] = [];
  await assert.rejects(consumeAgentEvents(response('data: {"type":"chunk","text":"partial"}\n\n'), e => events.push(e)), /before completion/);
  assert.deepEqual(events, [{ type: 'chunk', text: 'partial' }]);
});

test('agent SSE rejects malformed complete frames and non-streaming bodies', async () => {
  for (const text of ['data: {broken}\n\n', 'data: null\n\n', 'data: {}\n\n']) {
    await assert.rejects(consumeAgentEvents(response(text), () => {}), /invalid stream event/);
  }
  await assert.rejects(consumeAgentEvents(new Response('<html>Not SSE</html>'), () => {}), /non-streaming/);
});

test('agent SSE completes once, cancels a held-open response and supports multiline data', async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({ start(controller) {
    controller.enqueue(new TextEncoder().encode('data: {"type":"chunk",\ndata: "text":"OK"}\n\ndata: {"type":"end"}\n\ndata: [DONE]\n\n'));
  }, cancel() { cancelled = true; } });
  const events: StreamEvent[] = [];
  await consumeAgentEvents(new Response(body, { headers: { 'Content-Type': 'text/event-stream' } }), e => events.push(e));
  assert.deepEqual(events, [{ type: 'chunk', text: 'OK' }, { type: 'end' }]);
  assert.equal(cancelled, true);
});

test('generic API streams do not manufacture completion after a disconnected response', async t => {
  t.mock.method(globalThis, 'fetch', async () => response('data: {"type":"chunk","text":"partial"}\n\n'));
  const events: StreamEvent[] = [];
  const client = createApiClient({ baseUrl: 'http://fixture.invalid', token: 'fixture' });
  await assert.rejects(client.stream('/chat', {}, e => events.push(e)), /before completion/);
  assert.equal(events.some(e => e.type === 'end'), false);
});
