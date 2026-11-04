import assert from 'node:assert/strict';
import test from 'node:test';
import {
  detectPassiveRefusal,
  goalLikelyRequiresMutation,
  shouldRetryPrematureCompletion,
  createToolCallSignature,
  applyToolBatchGuard,
  levenshteinDistance,
  getToolNameSuggestions
} from './phaseGuards.js';

test('P1-5: detectPassiveRefusal ko/en', () => {
  assert.equal(detectPassiveRefusal('직접 입력하세요'), true);
  assert.equal(detectPassiveRefusal('run this command yourself'), true);
  assert.equal(detectPassiveRefusal('파일을 수정했습니다'), false);
});

test('P1-5: goalLikelyRequiresMutation (dead-code fixed)', () => {
  assert.equal(goalLikelyRequiresMutation('Fix the login bug'), true);
  assert.equal(goalLikelyRequiresMutation('로그인 버그 수정해줘'), true);
  assert.equal(goalLikelyRequiresMutation('이 코드 설명해줘'), false);
});

test('Informational questions mentioning development do not require file changes', () => {
  for (const goal of [
    '\uc774 \uc5d0\uc774\uc804\ud2b8\ub294 \ub204\uac00 \ub9cc\ub4e4\uc5c8\ub294\uc9c0 \uc544\ub098?',
    '\uc774 \ud504\ub85c\uadf8\ub7a8\uc740 \ub204\uac00 \ub9cc\ub4e4\uc5c8\uc5b4?',
    '\uac1c\ubc1c\uc790\ub294 \ub204\uad6c\ub2c8?',
    '\uc774 \ucf54\ub4dc\ub294 \uc5b4\ub5bb\uac8c \uc218\uc815\ud558\ub294 \uac70\uc57c?',
    '\ud30c\uc77c \uc0dd\uc131 \ubc29\ubc95\uc744 \uc124\uba85\ud574\uc918',
    '\ud504\ub85c\uc81d\ud2b8 \uac1c\ubc1c \ubc29\ud5a5\uc744 \uc124\uba85\ud574\uc918',
    'Explain how to fix the login bug',
    'How do I create a file?',
    'What does the build command do?',
    'Can you explain how to add a test?',
    'Observation round 1: read calc.cjs and report add(2,3). Observation only.',
    'Read calc.cjs and report the add() return value.', 'Inspect what build() does.',
    'Check whether remove() returns the deleted element.', 'Show the patch() function. Read-only.'
  ]) assert.equal(goalLikelyRequiresMutation(goal), false, goal);
});

test('Explicit and polite change requests still require file changes', () => {
  for (const goal of [
    '\ub85c\uadf8\uc778 \ubc84\uadf8 \uc218\uc815\ud574\uc918', '\ud30c\uc77c\uc744 \ub9cc\ub4e4\uc5b4\uc8fc\uc138\uc694',
    '\ud30c\uc77c\uc744 \ub9cc\ub4e4\uc5b4 \uc904 \uc218 \uc788\ub098\uc694?', '\uc218\uc815 \ubc29\ubc95\uc744 \uc124\uba85\ud558\uace0 \ucf54\ub4dc\ub97c \uc218\uc815\ud574\uc918',
    '\uac1c\ubc1c \ubc29\ud5a5\uc744 \uc124\uba85\ud558\uace0 \ud574\ub2f9 \uae30\ub2a5\uc744 \uad6c\ud604\ud574\uc8fc\uc138\uc694', '\ub204\uac00 \ub9cc\ub4e0 \ucf54\ub4dc\ub4e0 \ubc84\uadf8\ub97c \uace0\uccd0\uc918',
    '\uc124\uba85 \ubb38\uc11c \ucd94\uac00', '\uc791\uc5c5 \uc9c4\ud589', '\uac1c\ubc1c \uc9c4\ud589',
    'Fix what is broken in the login page', 'Can you fix the login bug?',
    'Read calc.cjs and then fix add().', 'Review the bug and make the necessary changes.',
    'Inspect the files and apply the requested patches.',
    'Please create a file named how.txt', 'Explain the bug and then fix it',
    'Explain the bug and fix it', '\uc218\uc815 \ubc29\ubc95\uc744 \uc124\uba85\ud558\uace0 \ucf54\ub4dc\ub97c \uc218\uc815\ud558\ub77c',
    '\uc218\uc815 \ubc29\ubc95\uc744 \uc124\uba85\ud558\uace0 \ucf54\ub4dc\ub97c \uc218\uc815'
  ]) assert.equal(goalLikelyRequiresMutation(goal), true, goal);
});

test('Informational tool results do not trigger an edit-focused retry', () => {
  assert.equal(shouldRetryPrematureCompletion({ cycleCount: 1, maxCycles: 4,
    changedFileCount: 0, userGoal: '\uc774 \uc5d0\uc774\uc804\ud2b8\ub294 \ub204\uac00 \ub9cc\ub4e4\uc5c8\ub294\uc9c0 \uc544\ub098?', hasToolResult: true }), false);
});

test('P1-5: shouldRetryPrematureCompletion gates', () => {
  const base = { cycleCount: 1, maxCycles: 4, changedFileCount: 0, userGoal: 'fix bug', hasToolResult: true };
  assert.equal(shouldRetryPrematureCompletion(base), true);
  assert.equal(shouldRetryPrematureCompletion({ ...base, changedFileCount: 1 }), false);
  assert.equal(shouldRetryPrematureCompletion({ ...base, cycleCount: 4 }), false);
  assert.equal(shouldRetryPrematureCompletion({ ...base, userGoal: 'explain code' }), false);
});

test('P1-5: tool signature is key-order stable', () => {
  const a = createToolCallSignature([{ tool: 'read_file', params: { b: 1, a: 2 } }]);
  const b = createToolCallSignature([{ tool: 'read_file', params: { a: 2, b: 1 } }]);
  assert.equal(a, b);
});

test('P1-5: batch guard trims obs-only batches on edit tasks', () => {
  const calls = Array.from({ length: 10 }, (_, i) => ({ tool: 'read_file', params: { path: `f${i}.js` } }));
  const res = applyToolBatchGuard(calls, {
    goalRequiresMutation: true, maxTotal: 8, maxRunCommands: 1, getMutationPaths: () => []
  });
  assert.equal(res.trimmed, true);
  assert.equal(res.toolCalls.length, 8);
});

test('P1-5: fuzzy tool suggestions', () => {
  assert.deepEqual(getToolNameSuggestions('read_fil', ['read_file', 'write_file']), ['read_file']);
  assert.equal(levenshteinDistance('kitten', 'sitting'), 3);
});
