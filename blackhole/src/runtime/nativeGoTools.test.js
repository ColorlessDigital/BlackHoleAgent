import test from 'node:test';
import assert from 'node:assert/strict';
import { NativeGoToolStream, nativeGoHistory, normalizeGoToolDefinitions } from './nativeGoTools.js';

test('parameterless registry tools still have an explicit object schema on every native API', () => {
  assert.deepEqual(normalizeGoToolDefinitions([{ name: 'stop_runtime', parameters: {} }])[0].parameters, { type: 'object', properties: {} });
});

test('native tool streams reject malformed arguments and undeclared functions before emission', () => {
  const stream = new NativeGoToolStream();
  stream.collect('chat', { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call', function: { name: 'write_file', arguments: '{invalid' } }] } }] });
  assert.throws(() => stream.finish([{ name: 'read_file' }]), /undeclared/);
  assert.throws(() => stream.finish([{ name: 'write_file' }]), /Invalid JSON/);
});

test('a request without any declared native tools cannot accept an unsolicited function', () => {
  const stream = new NativeGoToolStream();
  stream.collect('chat', { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call', function: { name: 'read_file', arguments: '{}' } }] } }] });
  assert.throws(() => stream.finish(), /undeclared/);
});

for (const protocol of ['chat', 'messages', 'responses']) {
  test(`${protocol} binds native history to its model/session and closes unavailable results`, () => {
    const state = { protocol, model: 'model', sessionId: 'session', text: '', calls: [{ id: 'call-1', name: 'read_file', params: { path: 'a' } }] };
    const assistant = { role: 'assistant', content: 'Tool text', goToolState: state };
    const original = nativeGoHistory([assistant], { protocol, model: 'different', sessionId: 'session' });
    assert.deepEqual(original, [{ role: 'assistant', content: 'Tool text' }]);
    const retained = nativeGoHistory([assistant, { role: 'user', content: '[Loop Guard Triggered] Change strategy.' }], { protocol, model: 'model', sessionId: 'session' });
    assert.match(JSON.stringify(retained), /unavailable/);
    assert.ok(!JSON.stringify(retained).includes('encrypted_content'));
    assert.ok(JSON.stringify(retained).includes('call-1'));
  });
}
