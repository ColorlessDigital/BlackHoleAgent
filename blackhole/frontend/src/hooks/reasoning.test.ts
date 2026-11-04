import test from 'node:test';
import assert from 'node:assert/strict';
import { appendReasoning, messagesWithoutReasoning } from './reasoning.ts';
import type { ChatMessage } from '../types.ts';

test('reasoning records remain separate from answer text and append by model request', () => {
  const original: ChatMessage[] = [{ role: 'user', content: 'Task' }, { role: 'assistant', content: 'Answer' }];
  const first = appendReasoning(original, 1, { requestId: 'one', text: 'First ', model: 'local', phase: 'PLAN', step: 1, timestamp: 100 });
  const second = appendReasoning(first, 1, { requestId: 'one', text: 'thought', timestamp: 101 });
  const third = appendReasoning(second, 1, { requestId: 'two', text: 'Next thought', timestamp: 102 });
  assert.equal(original[1].reasoning, undefined);
  assert.equal(third[1].content, 'Answer');
  assert.equal(third[1].reasoning?.[0].text, 'First thought');
  assert.equal(third[1].reasoning?.[0].startedAt, 100);
  assert.equal(third[1].reasoning?.[0].updatedAt, 101);
  assert.equal(third[1].reasoning?.length, 2);
  assert.equal(third[0], original[0]);
  assert.deepEqual(JSON.parse(JSON.stringify(third))[1].reasoning, third[1].reasoning);
});

test('requests omit reasoning and log-only archives without changing persisted messages', () => {
  const messages = appendReasoning([{ role: 'assistant', content: 'Answer', providerSessionId: 'same-session' }], 0,
    { requestId: 'one', text: 'Recorded thought', timestamp: 100 });
  messages.push({ role: 'assistant', content: '', reasoning: messages[0].reasoning });
  const outgoing = messagesWithoutReasoning(messages);
  assert.deepEqual(outgoing, [{ role: 'assistant', content: 'Answer', providerSessionId: 'same-session' }]);
  assert.equal(messages[0].reasoning?.[0].text, 'Recorded thought');
  assert.equal(messages.length, 2);
  assert.equal(appendReasoning(messages, 9, { text: 'Late data' }), messages);
  assert.equal(appendReasoning(messages, 0, { text: '' }), messages);
});
