import assert from 'assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import test from 'node:test';
import {
  buildFimPrompt,
  createAutocompleteCacheKey,
  dedupeCompletion,
  extractImportsAndSymbols,
  generateAutocompleteSuggestion,
  getAutocompleteMetrics,
  recordAutocompleteFeedback
} from './autocompleteEngine.js';

test('autocomplete cache follows the routed Go output limit without coupling local models to Go settings', () => {
  const payload = { file: 'example.js', prefix: 'const result = ', suffix: ';' };
  const config = { activeModel: 'opencode-go:glm-5.2', agentModelRoutingEnabled: false, maxTokens: 4096,
    opencodeGoModelMaxTokens: { 'glm-5.2': 8192 } };
  const changed = { ...config, opencodeGoModelMaxTokens: { 'glm-5.2': 12345 } };
  assert.notEqual(createAutocompleteCacheKey(payload, config), createAutocompleteCacheKey(payload, changed));
  assert.equal(createAutocompleteCacheKey(payload, { ...config, activeModel: 'llamacpp:local-gguf' }),
    createAutocompleteCacheKey(payload, { ...changed, activeModel: 'llamacpp:local-gguf' }));
});

test('buildFimPrompt emits prefix/suffix/middle markers', () => {
  const prompt = buildFimPrompt({
    file: 'src/example.ts',
    languageId: 'typescript',
    workspacePath: 'D:/BlackHole/blackhole',
    prefix: 'const answer = ',
    suffix: ';\n',
    currentLine: 'const answer = ',
    imports: ['import { add } from "./math";'],
    symbols: ['add']
  });
  assert.match(prompt.userPrompt, /<fim_prefix>/);
  assert.match(prompt.userPrompt, /<fim_suffix>/);
  assert.match(prompt.userPrompt, /<fim_middle>/);
  assert.match(prompt.userPrompt, /import \{ add \}/);
  assert.match(prompt.systemPrompt, /Autocomplete/);
});

test('extractImportsAndSymbols reads current file imports and symbols', () => {
  const signals = extractImportsAndSymbols(`
import fs from 'fs';
const loadUser = async () => ({ id: 1 });
export function saveUser() {}
class UserStore {}
`, 'typescript');
  assert.deepEqual(signals.imports, ["import fs from 'fs';"]);
  assert.ok(signals.symbols.includes('loadUser'));
  assert.ok(signals.symbols.includes('saveUser'));
  assert.ok(signals.symbols.includes('UserStore'));
});

test('dedupeCompletion removes surrounding-code overlap', () => {
  const deduped = dedupeCompletion('return value;\nnextStep();', {
    prefix: 'function demo() {\n  ',
    suffix: 'nextStep();\n}'
  });
  assert.equal(deduped.text, 'return value;\n');
  assert.equal(deduped.duplicateRemoved, true);
});

test('generateAutocompleteSuggestion uses local cache and records feedback', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'blackhole-autocomplete-test-'));
  const metricsPath = path.join(tempDir, 'metrics.json');
  let calls = 0;
  const callModel = async () => {
    calls += 1;
    return {
      text: 'return value;',
      route: { model: 'deterministic-autocomplete-test' }
    };
  };

  const payload = {
    file: 'src/example.js',
    languageId: 'javascript',
    workspacePath: tempDir,
    prefix: 'function demo() {\n  ',
    suffix: '\n}',
    currentLine: '  '
  };

  const first = await generateAutocompleteSuggestion(payload, { callModel, metricsPath });
  const second = await generateAutocompleteSuggestion(payload, { callModel, metricsPath });
  assert.equal(first.ok, true);
  assert.equal(second.cacheHit, true);
  assert.equal(calls, 1);
  assert.equal(first.suggestion, 'return value;');

  const metricsAfterOffer = getAutocompleteMetrics({ metricsPath });
  assert.equal(metricsAfterOffer.totals.offered, 2);
  assert.equal(metricsAfterOffer.totals.cacheHits, 1);

  recordAutocompleteFeedback({ id: first.id, accepted: true, insertedText: first.suggestion }, { metricsPath });
  const metricsAfterFeedback = getAutocompleteMetrics({ metricsPath });
  assert.equal(metricsAfterFeedback.totals.accepted, 1);
  assert.equal(metricsAfterFeedback.acceptanceRate, 1);
});
