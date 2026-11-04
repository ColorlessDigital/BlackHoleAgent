import assert from 'assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import test from 'node:test';
import {
  loadCheckRules,
  renderPrCheckMarkdown,
  renderPrCheckSarif,
  runPrDiffChecks
} from './prDiffCheck.js';

test('loadCheckRules parses markdown directives', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'blackhole-pr-check-rules-'));
  const checksDir = path.join(root, '.blackhole', 'checks');
  fs.mkdirSync(checksDir, { recursive: true });
  fs.writeFileSync(path.join(checksDir, 'quality.md'), [
    '# Quality Gate',
    '- level: must-pass',
    '- changed-only: true',
    '- applies-to: src/**/*.js',
    '- forbid-text: FAIL_ME',
    '- warn-text: TODO',
    '- require-file: package.json',
    '- require-script: npm test'
  ].join('\n'));

  const rules = loadCheckRules(checksDir);
  assert.equal(rules.length, 1);
  assert.equal(rules[0].level, 'must-pass');
  assert.deepEqual(rules[0].appliesTo, ['src/**/*.js']);
  assert.deepEqual(rules[0].forbidText, ['FAIL_ME']);
  assert.deepEqual(rules[0].warnText, ['TODO']);
  assert.deepEqual(rules[0].requireFiles, ['package.json']);
});

test('runPrDiffChecks evaluates changed files and renders reports', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'blackhole-pr-check-'));
  const checksDir = path.join(root, '.blackhole', 'checks');
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.mkdirSync(checksDir, { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), '{}');
  fs.writeFileSync(path.join(root, 'src', 'app.js'), 'const value = "FAIL_ME";\n// TODO: clean\n');
  fs.writeFileSync(path.join(checksDir, 'quality.md'), [
    '# Quality Gate',
    '- level: must-pass',
    '- changed-only: true',
    '- applies-to: src/**/*.js',
    '- forbid-text: FAIL_ME',
    '- warn-text: TODO'
  ].join('\n'));

  const report = runPrDiffChecks({
    workspaceRoot: root,
    checksDir,
    changedFiles: ['src/app.js']
  });
  assert.equal(report.ok, false);
  assert.equal(report.summary.errors, 1);
  assert.equal(report.summary.warnings, 1);
  assert.match(renderPrCheckMarkdown(report), /BlackHole PR Check: FAIL/);
  assert.equal(renderPrCheckSarif(report).runs[0].results.length, 2);
});
