import assert from 'node:assert/strict';
import test from 'node:test';
import { googleContents } from './googleToolAdapter.js';

test('Google signatures are bound to their original model and conversation', () => {
  const message = { role: 'assistant', content: 'Original text', goGoogleState: { model: 'one', sessionId: 'session',
    parts: [{ functionCall: { name: 'read_file', args: {} }, thoughtSignature: 'private-signature' }] } };
  for (const [model, sessionId] of [['two', 'session'], ['one', 'different']]) {
    const result = googleContents([message], model, sessionId);
    assert.deepEqual(result, [{ role: 'model', parts: [{ text: 'Original text' }] }]);
  }
});

test('Google retained history closes missing results without fabricating execution or merging signed parts', () => {
  const state = { model: 'one', sessionId: 'session', parts: [
    { functionCall: { name: 'read_file', args: { path: 'a' }, id: 'a' }, thoughtSignature: 'one-signature' },
    { functionCall: { name: 'read_file', args: { path: 'b' }, id: 'b' }, thoughtSignature: 'two-signature' }
  ] };
  const contents = googleContents([{ role: 'assistant', content: '', goGoogleState: state },
    { role: 'user', content: '[Tool Result (Tool: read_file)]\na contents' },
    { role: 'user', content: '[Loop Guard Triggered]\nChange strategy.' }], 'one', 'session');
  assert.deepEqual(contents[0].parts, state.parts);
  const responses = contents[1].parts.filter(p => p.functionResponse);
  assert.equal(responses.length, 2);
  assert.equal(responses[0].functionResponse.id, 'a');
  assert.equal(responses[1].functionResponse.id, 'b');
  assert.match(responses[1].functionResponse.response.error, /unavailable/);
  assert.ok(contents[1].parts.every(part => part.functionResponse));
  assert.ok(contents[2].parts.every(part => part.text));
});

test('Google omits unsigned empty stream tail parts but preserves signed empty parts', () => {
  const parts = [{ functionCall: { name: 'read_file', args: {} }, thoughtSignature: 'call-signature' },
    { text: '' }, { text: '', thoughtSignature: 'signed-empty' }];
  const contents = googleContents([{ role: 'assistant', content: '', goGoogleState: { model: 'one', sessionId: 'session', parts } }], 'one', 'session');
  assert.deepEqual(contents[0].parts, [parts[0], parts[2]]);
});
