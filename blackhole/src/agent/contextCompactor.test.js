import assert from 'node:assert/strict';
import test from 'node:test';
import { estimateTextTokens } from './contextGuard.js';
import {
  buildCompactionTranscript,
  compactConversation,
  needsCompaction,
  selectCompactionWindow
} from './contextCompactor.js';

function makeMessages(n) {
  return Array.from({ length: n }, (_, i) => ({
    role: i % 2 === 0 ? 'user' : 'assistant',
    content: `message-${i} ` + 'lorem ipsum dolor sit amet '.repeat(40)
  }));
}

test('needsCompaction respects threshold', () => {
  const short = [{ role: 'user', content: 'hi' }];
  assert.equal(needsCompaction(short, '', 8192, 0.9).needed, false);
  const long = makeMessages(30);
  assert.equal(needsCompaction(long, '', 100, 0.9).needed, true);
  assert.equal(needsCompaction(long, '', 1000000, 0).needed, true);
});

test('selectCompactionWindow anchors goal and tail', () => {
  const messages = makeMessages(12);
  const window = selectCompactionWindow(messages, 4);
  assert.ok(window);
  assert.equal(window.head.length, 1);
  assert.equal(window.head[0].content.includes('message-0'), true);
  assert.equal(window.tail.length, 4);
  assert.equal(window.middle.length, 7);
  assert.equal(selectCompactionWindow(makeMessages(4), 4), null);
});

test('compactConversation replaces middle with summary', async () => {
  const messages = makeMessages(12);
  const result = await compactConversation({
    messages,
    systemPrompt: '',
    limitTokens: 100,
    threshold: 0.9,
    summarize: async (transcript) => {
      assert.match(transcript, /message-1/);
      return 'SUMMARY: user goal done, 3 files changed.';
    }
  });
  assert.equal(result.compacted, true);
  assert.equal(result.messages.length, 1 + 1 + 4);
  assert.equal(result.messages[0].content.includes('message-0'), true);
  assert.match(result.messages[1].content, /SUMMARY/);
  assert.ok(result.estimatedTokens < result.previousTokens);
});

test('compactConversation never throws: short / no-summarizer / failure', async () => {
  const short = await compactConversation({ messages: makeMessages(3), limitTokens: 10, summarize: async () => 'x' });
  assert.equal(short.compacted, false);

  const noSum = await compactConversation({ messages: makeMessages(12), limitTokens: 10 });
  assert.equal(noSum.compacted, false);
  assert.equal(noSum.reason, 'no-summarizer');

  const failed = await compactConversation({
    messages: makeMessages(12),
    limitTokens: 10,
    summarize: async () => { throw new Error('down'); }
  });
  assert.equal(failed.compacted, false);
  assert.match(failed.reason, /down/);
});

test('buildCompactionTranscript caps message length', () => {
  const text = buildCompactionTranscript([{ role: 'user', content: 'a'.repeat(9000) }]);
  assert.ok(text.length < 5000);
});

test('compaction transcript fits the summarizer budget while retaining evidence from each turn', () => {
  const messages = Array.from({ length: 40 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user',
    content: `turn-${i}-start ${'기록 '.repeat(2000)} turn-${i}-end` }));
  const text = buildCompactionTranscript(messages, { maxTokens: 2500 });
  assert.ok(estimateTextTokens(text) <= 2500);
  for (let i = 0; i < messages.length; i++) {
    assert.ok(text.includes(`turn-${i}-start`));
    assert.ok(text.includes(`turn-${i}-end`));
  }
});

test('context compaction propagates cancellation instead of continuing the agent', async () => {
  const controller = new AbortController();
  await assert.rejects(compactConversation({
    messages: makeMessages(12),
    limitTokens: 100,
    abortSignal: controller.signal,
    summarize: async () => {
      controller.abort();
      return 'cancelled summary';
    }
  }), { name: 'AbortError' });
});

test('compaction bounds its newest tool payload and preserves the latest real question outside the tail', async () => {
  const goal = 'Current user request';
  const messages = [{ role: 'assistant', content: '' }, { role: 'user', content: 'Original goal' },
    { role: 'assistant', content: 'Old answer' }, { role: 'user', content: goal },
    ...Array.from({ length: 8 }, (_, i) => ({ role: 'user', content: `[Tool Result (Tool: list_dir)]\n${i}:${'x'.repeat(100000)}` }))];
  const result = await compactConversation({ messages, limitTokens: 100, userGoal: goal, summarize: async () => 'Summary' });
  assert.ok(result.messages.some(m => m.content === goal));
  assert.ok(result.messages.every(m => m.content.length <= 6000));
  assert.equal(result.messages[0].content, 'Original goal');
});

test('compaction retains the active request and all its small observations outside the recent tail', async () => {
  const goal = 'Read release.txt and quote its current value exactly.';
  const history = [{ role: 'user', content: 'Fix the previous implementation.' }, ...makeMessages(14),
    { role: 'user', content: goal },
    { role: 'assistant', content: 'Reading the requested release value.' },
    { role: 'user', content: '[Tool Result (Tool: read_file)]\nrelease.txt: release-2026.11-current' },
    ...Array.from({ length: 6 }, (_, i) => ({ role: i % 2 ? 'user' : 'assistant',
      content: i % 2 ? `[Tool Result (Tool: read_file)]\nAdditional file ${i}` : 'Inspecting supporting code.' }))];
  let transcript;
  const result = await compactConversation({ messages: history, limitTokens: 1800, userGoal: goal,
    summarize: async text => { transcript = text; return 'Previous implementation was repaired.'; } });
  assert.equal(result.compacted, true);
  assert.doesNotMatch(transcript, /release-2026\.11-current/);
  assert.deepEqual(result.messages.slice(-9), history.slice(-9));
  assert.ok(result.messages.some(message => message.content === goal));
});
