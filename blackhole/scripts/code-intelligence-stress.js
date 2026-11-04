import fs from 'fs';
import os from 'os';
import path from 'path';
import { performance } from 'perf_hooks';
import { ProjectContextEngine } from '../src/agent/core/contextEngine.js';
import { VerificationEngine } from '../src/agent/core/verificationEngine.js';

const args = process.argv.slice(2);

if (args.includes('--help') || args.includes('-h')) {
  console.log(`BlackHole code intelligence stress check

Usage:
  node scripts/code-intelligence-stress.js [options]

Options:
  --files=<n>       Number of generated source modules. Default: 1600.
  --tests=<n>       Number of generated node:test files. Default: 8.
  --keep-temp       Keep the temporary workspace.
`);
  process.exit(0);
}

const fileCount = numberArg('--files', 1600);
const testCount = numberArg('--tests', 8);
const keepTemp = args.includes('--keep-temp');
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'blackhole-code-intelligence-stress-'));
const startedAt = performance.now();

try {
  materializeLargeProject(tempRoot, fileCount, testCount);

  const engine = new ProjectContextEngine(tempRoot);
  const scanStartedAt = performance.now();
  await engine.scanWorkspace();
  const scanMs = Math.round(performance.now() - scanStartedAt);

  const summary = engine.getCodeIntelligenceSummary();
  const references = engine.getSymbolReferences('sharedValue', { limit: 40 });
  const targets = engine.getVerificationTargets(['src/module-0000.js']);
  const verification = await new VerificationEngine(tempRoot).runVerificationSuite({
    changedFiles: ['src/module-0000.js'],
    contextEngine: engine
  });

  const failures = [];
  if (summary.sourceFileCount < fileCount) {
    failures.push(`sourceFileCount too low: ${summary.sourceFileCount} < ${fileCount}`);
  }
  if (fileCount > 1200 && summary.semanticSkipped !== true) {
    failures.push('semantic index should be skipped for oversized generated project');
  }
  if (!references.length) {
    failures.push('symbol reference lookup returned no references for sharedValue');
  }
  if (!targets.testFiles?.length) {
    failures.push('verification target selection returned no test files');
  }
  if (!verification.ok) {
    failures.push('targeted verification did not pass');
  }

  const payload = {
    ok: failures.length === 0,
    failures,
    durationMs: Math.round(performance.now() - startedAt),
    scanMs,
    tempRoot: keepTemp ? tempRoot : null,
    generated: {
      fileCount,
      testCount
    },
    summary,
    referenceCount: references.length,
    verificationTargets: targets,
    verification: {
      ok: verification.ok,
      syntax: compactVerification(verification.results.syntax),
      test: compactVerification(verification.results.test),
      lint: compactVerification(verification.results.lint)
    }
  };

  console.log(JSON.stringify(payload, null, 2));
  if (!payload.ok) process.exitCode = 1;
} finally {
  if (!keepTemp) {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

function numberArg(name, fallback) {
  const prefix = `${name}=`;
  const match = args.find(arg => arg.startsWith(prefix));
  if (!match) return fallback;
  const value = Number(match.slice(prefix.length));
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function materializeLargeProject(root, modules, tests) {
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.mkdirSync(path.join(root, 'test'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({ type: 'module', scripts: { test: 'node --test test/*.test.js' } }, null, 2),
    'utf8'
  );

  for (let index = 0; index < modules; index += 1) {
    const id = String(index).padStart(4, '0');
    const dependency = index > 0
      ? `import { sharedValue as previousValue } from './module-${String(index - 1).padStart(4, '0')}.js';\n`
      : '';
    const body = [
      dependency,
      `export const moduleId = ${index};`,
      `export function sharedValue(input = 0) {`,
      index > 0
        ? `  return previousValue(input) + moduleId;`
        : '  return input + moduleId;',
      '}',
      ''
    ].join('\n');
    fs.writeFileSync(path.join(root, 'src', `module-${id}.js`), body, 'utf8');
  }

  for (let index = 0; index < tests; index += 1) {
    const id = String(index).padStart(4, '0');
    const moduleIndex = Math.min(index, modules - 1);
    const moduleId = String(moduleIndex).padStart(4, '0');
    const body = [
      "import test from 'node:test';",
      "import assert from 'node:assert';",
      `import { sharedValue } from '../src/module-${moduleId}.js';`,
      '',
      `test('module ${moduleId} returns a number', () => {`,
      "  assert.strictEqual(typeof sharedValue(1), 'number');",
      '});',
      ''
    ].join('\n');
    fs.writeFileSync(path.join(root, 'test', `module-${id}.test.js`), body, 'utf8');
  }
}

function compactVerification(result = {}) {
  return {
    ok: !!result.ok,
    skipped: !!result.skipped,
    targeted: !!result.targeted,
    command: result.command || '',
    targets: result.targets || []
  };
}
