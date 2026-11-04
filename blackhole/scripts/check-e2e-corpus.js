import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');
const corpusPath = process.argv.find(arg => arg.startsWith('--corpus='))?.slice('--corpus='.length)
  || path.join(PROJECT_ROOT, 'benchmarks', 'agent-e2e', 'e2e-cases.json');

try {
  const corpus = JSON.parse(fs.readFileSync(corpusPath, 'utf8'));
  const cases = corpus.cases || [];
  const ids = new Set();
  const errors = [];

  if (cases.length < 30 || cases.length > 50) {
    errors.push(`Expected 30-50 E2E cases, got ${cases.length}.`);
  }

  for (const testCase of cases) {
    if (!testCase.id) errors.push('A case is missing id.');
    if (ids.has(testCase.id)) errors.push(`Duplicate case id: ${testCase.id}`);
    ids.add(testCase.id);
    if (!testCase.instruction) errors.push(`${testCase.id}: missing instruction.`);
    if (!Array.isArray(testCase.changedFiles) || testCase.changedFiles.length === 0) {
      errors.push(`${testCase.id}: missing changedFiles.`);
    }
    if (!testCase.files || !testCase.files['package.json']) {
      errors.push(`${testCase.id}: missing package.json fixture.`);
    }
    if (!Array.isArray(testCase.operations) || testCase.operations.length === 0) {
      errors.push(`${testCase.id}: missing deterministic operations.`);
    }
    const hasTest = Object.keys(testCase.files || {}).some(file => file.endsWith('.test.js'));
    if (!hasTest) errors.push(`${testCase.id}: missing focused test fixture.`);
  }

  const payload = {
    ok: errors.length === 0,
    corpus: corpus.name,
    corpusPath: path.resolve(corpusPath),
    cases: cases.length,
    errors
  };
  console.log(JSON.stringify(payload, null, 2));
  if (!payload.ok) process.exitCode = 1;
} catch (error) {
  console.error(JSON.stringify({
    ok: false,
    corpusPath: path.resolve(corpusPath),
    error: error.message
  }, null, 2));
  process.exitCode = 1;
}
