import test from 'node:test';
import assert from 'node:assert';
import {
  estimateTextTokens,
  compactToolResultContent,
  applySlidingContextGuard,
  OBSERVATION_EVIDENCE
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
  assert.ok(compacted.includes('read_file startLine and lineCount'));
  assert.ok(compacted.length < raw.length);
});

test('small source ranges retain middle-file evidence under the same context budget that clips a full read', () => {
  const marker = 'this.defaultValue = undefined;';
  const wholeFile = `[Tool Result (Tool: read_file)]\n${'unrelated header\n'.repeat(100)}${marker}\n${'unrelated footer\n'.repeat(100)}`;
  const system = 's'.repeat(23000);
  const full = applySlidingContextGuard([{ role: 'user', content: 'Fix the argument default value.' }, { role: 'user', content: wholeFile }], system, 8192);
  assert.ok(!full.messages.at(-1).content.includes(marker));
  const range = `[Tool Result (Tool: read_file)]\nLines: 100-105 of 200\nContent:\ndefault(value, description) {\n  ${marker}\n  return this;\n}`;
  const partial = applySlidingContextGuard([{ role: 'user', content: 'Fix the argument default value.' }, { role: 'user', content: range }], system, 8192);
  assert.ok(partial.messages.at(-1).content.includes(marker));
  assert.equal(partial.limitExceeded, false);
});

test('old resume metadata cannot force the newest source evidence into a tiny head/tail excerpt', () => {
  const goal = 'Fix the argument default value.';
  const code = `[Tool Result (Tool: read_file)]\n${'source header\n'.repeat(100)}default(value, description) { this.defaultValue = undefined; }\n${'source footer\n'.repeat(100)}`;
  const messages = [{ role: 'user', content: goal },
    { role: 'user', content: `[Checkpoint Resume Context]\n${'old metadata '.repeat(400)}` },
    { role: 'assistant', content: '{"tool":"read_file","params":{"path":"lib/argument.js"}}' },
    { role: 'user', content: code },
    { role: 'user', content: '[Observation-Only Edit Redirect]\nUse the observed source for the requested edit.' }];
  const guarded = applySlidingContextGuard(messages, 's'.repeat(17000), 8192, { userGoal: goal });
  assert.ok(guarded.messages.some(message => message.content === code));
  assert.ok(guarded.removed > 0);
  assert.equal(guarded.limitExceeded, false);
  assert.equal(messages[3].content, code);
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
test('current requested quotation evidence survives guard pressure and stale pins do not displace it', () => {
  const goal = 'Read release.txt and quote its current value exactly.';
  const messages = [{ role: 'user', content: 'Old task' },
    { role: 'user', content: '[Tool Result (Tool: read_file)]\nold value', [OBSERVATION_EVIDENCE]: 'release.txt' },
    { role: 'user', content: goal },
    { role: 'user', content: '[Tool Result (Tool: read_file)]\ncurrent value', [OBSERVATION_EVIDENCE]: 'release.txt' },
    { role: 'assistant', content: 'Inspecting support code.' },
    { role: 'user', content: `[Tool Result (Tool: read_file)]\n${'source\n'.repeat(3000)}` }];
  const result = applySlidingContextGuard(messages, 'System', 800, { userGoal: goal });
  assert.equal(result.limitExceeded, false);
  assert.ok(result.messages.some(message => message.content.includes('current value')));
  assert.equal(result.messages.some(message => message.content.includes('old value')), false);
  const retained = result.messages.find(message => message.content.startsWith('[Tool Result') && message.content.includes('current value'));
  assert.equal(retained[OBSERVATION_EVIDENCE], 'release.txt');
  for (const message of JSON.parse(JSON.stringify(result.messages))) assert.deepEqual(Object.keys(message).sort(), ['content', 'role']);
});
