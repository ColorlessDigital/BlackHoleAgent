import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { VerificationEngine } from './verificationEngine.js';
import { AgentStateMachine } from './stateMachine.js';
import { AgentCheckpointStore } from './checkpointStore.js';

const correct = 'exports.add=(a,b)=>a+b;';
const wrong = 'exports.add=(a,b)=>a-b;\na + b\n';
const behaviorTest = "const test=require('node:test'),a=require('node:assert/strict'),f=require('./math.cjs');test('addition',()=>{a.equal(f.add(-2,7),5);a.equal(f.add(0,0),0);});";

function workspace(t, files = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'blackhole-behavior-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [file, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), content);
  }
  return root;
}

test('syntax success without behavioral checks is unverified, not a passing source suite', async t => {
  const root = workspace(t, { 'math.cjs': wrong });
  const suite = await new VerificationEngine(root).runVerificationSuite({ changedFiles: ['math.cjs'] });
  assert.equal(suite.results.syntax.ok, true);
  assert.equal(suite.results.test.failureKind, 'unverified');
  assert.equal(suite.results.test.reason, 'behavioral_verification_unavailable');
  assert.equal(suite.ok, false);
  assert.deepEqual(fs.readdirSync(root), ['math.cjs']);
});

test('standalone behavioral tests are discovered without a package or stale context mapping', async t => {
  const root = workspace(t, { 'math.cjs': wrong, 'behavior.test.cjs': behaviorTest });
  const engine = new VerificationEngine(root);
  const failed = await engine.runVerificationSuite({ changedFiles: ['math.cjs'] });
  assert.equal(failed.results.syntax.ok, true);
  assert.equal(failed.results.test.ok, false, JSON.stringify(failed));
  assert.notEqual(failed.results.test.failureKind, 'unverified');
  assert.match(failed.results.test.output, /ReferenceError/);
  assert.deepEqual(failed.results.test.targets, ['behavior.test.cjs']);
  fs.writeFileSync(path.join(root, 'math.cjs'), correct);
  const passed = await engine.runVerificationSuite({ changedFiles: ['math.cjs'] });
  assert.equal(passed.ok, true);
  assert.equal(passed.results.test.behavioral.testsExecuted, 1);
});

test('the declared test command retains its loader instead of forcing plain node --test', async t => {
  const root = workspace(t, {
    'package.json': JSON.stringify({ scripts: { test: 'node --test --import ./setup.mjs math.test.cjs' } }),
    'setup.mjs': "import assert from 'node:assert/strict';globalThis.fixtureAssert=assert;",
    'math.cjs': correct,
    'math.test.cjs': "const test=require('node:test'),f=require('./math.cjs');test('loader',()=>fixtureAssert.equal(f.add(2,3),5));"
  });
  const suite = await new VerificationEngine(root).runVerificationSuite({ changedFiles: ['math.cjs'],
    contextEngine: { getVerificationTargets: () => ({ changedFiles: ['math.cjs'], testFiles: ['math.test.cjs'] }) } });
  assert.equal(suite.ok, true);
  assert.match(suite.results.test.command, /--import \.\/setup\.mjs/);
  assert.equal(suite.results.test.cwd, root);
});

test('zero executed or all skipped test summaries cannot certify source behavior', t => {
  const engine = new VerificationEngine(workspace(t));
  for (const output of ['# tests 0\n# skipped 0', '# tests 3\n# skipped 3',
    'Ran 0 tests in 0.001s\nOK', 'Ran 3 tests in 0.001s\nOK (skipped=3)',
    'Tests: 3 skipped, 3 total', 'Tests 3 skipped (3)', '1 skipped in 0.01s', '0 passing (1ms)', 'collected 0 items',
    'Warning: node:test run() is being called recursively within a test file. skipping running files.']) {
    assert.equal(engine.describeTestEvidence({ ok: true, output }, 'project-test').status, 'unverified', output);
  }
  for (const output of ['# tests 3\n# skipped 1', 'Tests: 2 passed, 2 total', '2 passing (1ms)', 'Ran 2 tests in 0.01s',
    '# Subtest: no tests found error handler\n# tests 1\n# skipped 0']) {
    assert.equal(engine.describeTestEvidence({ ok: true, output }, 'project-test').status, 'passed', output);
  }
});

test('version, syntax-only and echo scripts do not verify source behavior', async t => {
  for (const command of ['node --version', 'node --check math.cjs', 'echo OK']) {
    const root = workspace(t, { 'math.cjs': correct, 'package.json': JSON.stringify({ scripts: { test: command } }) });
    const suite = await new VerificationEngine(root).runVerificationSuite({ changedFiles: ['math.cjs'] });
    assert.equal(suite.ok, false, command);
    assert.equal(suite.results.test.behavioral.reason, 'non_behavioral_test_command', command);
  }
});

test('a test in one package does not certify another package with no tests', async t => {
  const root = workspace(t, { 'a/package.json': '{}', 'a/math.cjs': correct, 'a/math.test.cjs': behaviorTest,
    'b/package.json': '{}', 'b/math.cjs': correct });
  const suite = await new VerificationEngine(root).runVerificationSuite({ changedFiles: ['a/math.cjs', 'b/math.cjs'] });
  assert.equal(suite.ok, false);
  assert.equal(suite.results.test.failureKind, 'unverified');
  assert.equal(suite.results.test.projects[0].ok, true);
  assert.equal(suite.results.test.projects[1].behavioral.status, 'unverified');
});

test('fallback test discovery never traverses unrelated child packages', async t => {
  const root = workspace(t, { 'math.cjs': correct, 'child/package.json': '{}',
    'child/tests/bad.test.cjs': "require('node:assert').fail('unrelated child');" });
  const suite = await new VerificationEngine(root).runVerificationSuite({ changedFiles: ['math.cjs'] });
  assert.equal(suite.results.test.failureKind, 'unverified');
  assert.equal(suite.results.test.command, undefined);
});

test('documentation changes do not require behavioral code tests or run sibling checks', async t => {
  const root = workspace(t, { 'README.md': 'Documentation', 'other/package.json': JSON.stringify({ scripts: { test: 'exit 99' } }) });
  const suite = await new VerificationEngine(root).runVerificationSuite({ changedFiles: ['README.md'] });
  assert.equal(suite.ok, true);
  assert.ok(Object.values(suite.results).every(result => result.skipped));
});

test('unverified code stops without self-repair and can resume after an existing check is supplied', async t => {
  const root = workspace(t);
  const events = [];
  const config = { workspaceRoot: root, permissionMode: 'autonomous', agentMemoryEnabled: false, contextLimit: 16384 };
  const first = new AgentStateMachine({ config, send: event => events.push(event), messages: [{ role: 'user', content: 'Fix math.cjs.' }] });
  first.checkpointStore = new AgentCheckpointStore({ dir: path.join(root, 'checkpoints') });
  let calls = 0;
  first.callModel = async (_system, _messages, chunk) => { calls++; chunk(JSON.stringify({ tool: 'write_file', params: { path: 'math.cjs', content: correct } })); };
  await first.run();
  assert.equal(first.runOutcome.status, 'incomplete');
  assert.equal(first.runOutcome.reason, 'behavioral_verification_unavailable');
  assert.equal(first.repairCycleCount, 0);
  assert.equal(calls, 1);
  assert.match(first.checkpoint.nextRecommendedAction, /behavioral check/);
  assert.equal(events.some(event => event.state === 'REPAIR'), false);
  const unavailable = new AgentStateMachine({ config, send() {}, resumeCheckpoint: {
    ...first.checkpointStore.loadLatest(), repairPlan: { recommendedFiles: ['math.cjs'] }
  } });
  unavailable.checkpointStore = first.checkpointStore;
  unavailable.callModel = async () => assert.fail('Missing checks must not restart source repair.');
  await unavailable.run();
  assert.equal(unavailable.runOutcome.reason, 'behavioral_verification_unavailable');
  assert.equal(unavailable.checkpoint.repairPlan, null);
  fs.writeFileSync(path.join(root, 'math.test.cjs'), behaviorTest);
  const resumed = new AgentStateMachine({ config, send() {}, resumeCheckpoint: first.checkpointStore.loadLatest() });
  resumed.checkpointStore = first.checkpointStore;
  resumed.callModel = async (_system, _messages, chunk) => chunk('The existing implementation passes its behavioral test.');
  await resumed.run();
  assert.equal(resumed.runOutcome.status, 'completed');
  assert.equal(resumed.checkpoint.sessionId, first.checkpoint.sessionId);
  assert.equal(resumed.checkpoint.failedVerifications.length, 0);
  assert.equal(fs.readFileSync(path.join(root, 'math.cjs'), 'utf8'), correct);
});
