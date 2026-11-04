import test from 'node:test';
import assert from 'node:assert';
import {
  estimateTextTokens,
  compactToolResultContent,
  applySlidingContextGuard
} from './contextGuard.js';

test('estimateTextTokens correctly weights Hangul and Latin text', () => {
  const english = 'Hello world, this is a test.';
  const korean = '안녕하세요, 이것은 테스트입니다.';
  
  const engTokens = estimateTextTokens(english);
  const korTokens = estimateTextTokens(korean);
  
  assert.ok(engTokens > 0);
  assert.ok(korTokens > 0);
  assert.ok(korTokens >= 10);
});

test('compactToolResultContent preserves tool header while trimming long payload', () => {
  const longPayload = 'x'.repeat(1000);
  const raw = `[Tool Result (Tool: read_file)]\n${longPayload}`;
  const compacted = compactToolResultContent(raw, 600);

  assert.ok(compacted.includes('[Tool Result (Tool: read_file)]'));
  assert.ok(compacted.includes('Trimmed'));
  assert.ok(compacted.length < raw.length);
});

test('applySlidingContextGuard anchors initial goal and compacts long tool results', () => {
  const initialGoal = 'CRITICAL_USER_GOAL: Fix bug in server.js';
  const longToolResult = `[Tool Result (Tool: read_file)]\n${'A'.repeat(5000)}`;
  const recentAssistant = 'Assistant response planning next step';
  const recentUser = 'Recent user question';

  const messages = [
    { role: 'user', content: initialGoal },
    { role: 'assistant', content: 'Let me inspect files' },
    { role: 'user', content: longToolResult },
    { role: 'assistant', content: recentAssistant },
    { role: 'user', content: recentUser }
  ];

  const guarded = applySlidingContextGuard(messages, 'System prompt', 1000);

  // Goal must always be preserved
  assert.strictEqual(guarded.messages[0].content, initialGoal);
  // Tool result should have been compacted or removed
  assert.ok(guarded.compacted > 0 || guarded.removed > 0);
  // Recent turns should be intact
  const lastMessage = guarded.messages[guarded.messages.length - 1];
  assert.strictEqual(lastMessage.content, recentUser);
});

test('large latest tool results cannot evict the current request behind an empty welcome', () => {
  const currentGoal = 'Who built this project?';
  const original = [
    { role: 'assistant', content: '' }, { role: 'user', content: 'Earlier question' },
    { role: 'assistant', content: 'Earlier answer' }, { role: 'user', content: currentGoal },
    { role: 'assistant', content: '<list_dir path="." />' },
    { role: 'user', content: `[Tool Result (Tool: list_dir)]\n${'x'.repeat(2000000)}` },
    { role: 'user', content: '[Tool Result (Tool: search_project_memory)]\nNo matching memory.' }
  ];
  const result = applySlidingContextGuard(original, 'System', 8192, { userGoal: currentGoal });
  assert.ok(result.messages.some(m => m.content === currentGoal));
  assert.ok(result.messages.some(m => m.content === 'Earlier question'));
  assert.ok(result.estimatedTokens <= Math.floor(8192 * 0.85));
  assert.ok(result.compacted > 0);
  assert.strictEqual(result.limitExceeded, false);
  assert.strictEqual(original[5].content.length > 2000000, true);
});

test('short sessions also compact oversized tool messages and signal unfit user instructions without clipping', () => {
  const result = applySlidingContextGuard([{ role: 'user', content: 'Goal' },
    { role: 'user', content: `[Tool Result (Tool: read_file)]\n${'x'.repeat(100000)}` }], '', 500);
  assert.ok(result.estimatedTokens <= 425);
  const largeGoal = 'original user input '.repeat(1000);
  const unfit = applySlidingContextGuard([{ role: 'user', content: largeGoal }], '', 100);
  assert.strictEqual(unfit.limitExceeded, true);
  assert.strictEqual(unfit.messages[0].content, largeGoal);
});
