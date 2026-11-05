const { app } = require('electron');
const fs = require('node:fs');
const rawFs = require('original-fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const arg = (name, fallback) => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
assert.ok(arg('release'), 'Specify --release.');
const release = path.resolve(arg('release'));
const label = arg('label', `behavior-${Date.now()}`);
assert.match(label, /^[a-z0-9-]+$/);
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'data/diagnostics', label);
assert.ok(!fs.existsSync(output), 'Use a fresh label.');
fs.mkdirSync(output, { recursive: true });
process.env.BLACKHOLE_DATA_DIR = path.join(output, 'data');
process.env.BLACKHOLE_DISABLE_WORKSPACE_STANDARD = '1';
app.setPath('userData', path.join(output, 'profile'));
const archive = path.join(release, 'win-unpacked/resources/app.asar');
const hash = file => crypto.createHash('sha256').update(rawFs.readFileSync(file)).digest('hex');
const report = { ok: false, startedAt: new Date().toISOString(), packageHashAtStart: hash(archive),
  scope: 'Packaged state machine, executor and real verification commands. Scripted model output, no verification adapter, no account or user workspace. Behavioral tests are independent immutable fixture inputs.', cases: [] };
const wrong = 'exports.add=(a,b)=>a-b;\na + b\n';
const correct = 'exports.add=(a,b)=>a+b;\n';
const testBody = "const test=require('node:test'),a=require('node:assert/strict'),f=require('./math.cjs');test('addition',()=>{a.equal(f.add(-2,7),5);a.equal(f.add(0,0),0);a.equal(f.add(4,3),7);});\n";

app.whenReady().then(async () => {
  try {
    process.resourcesPath = path.dirname(archive);
    const { AgentStateMachine } = require(path.join(archive, 'src/agent/core/stateMachine.js'));
    const { AgentCheckpointStore } = require(path.join(archive, 'src/agent/core/checkpointStore.js'));
    const node = path.join(release, 'win-unpacked/resources/node-runtime/node.exe');
    async function run(name, { files = {}, changes, expected, repair = false, assertion = true }) {
      const workspace = path.join(output, name);
      fs.mkdirSync(workspace);
      for (const [file, text] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(workspace, file)), { recursive: true });
        fs.writeFileSync(path.join(workspace, file), text);
      }
      const protectedFiles = Object.keys(files).filter(file => !changes.some(change => change.path === file));
      const before = protectedFiles.map(file => hash(path.join(workspace, file)));
      const events = [];
      const machine = new AgentStateMachine({ config: { workspaceRoot: workspace, permissionMode: 'autonomous',
        activeModel: 'llamacpp:local-gguf', contextLimit: 16384, maxTokens: 4096, agentModelRoutingEnabled: false,
        agentMemoryEnabled: false, selfHealingMaxCycles: 2, agentMaxSteps: 6 },
      messages: [{ role: 'user', content: 'Fix the requested implementation. Preserve all existing tests and metadata. Use file tools only.' }],
      send: event => events.push(event) });
      machine.checkpointStore = new AgentCheckpointStore({ dir: path.join(output, `${name}-checkpoints`) });
      let calls = 0;
      machine.callModel = async (_system, _messages, chunk) => {
        calls++;
        if (calls > (repair ? 2 : 1)) return chunk('No more implementation changes are needed.');
        chunk(JSON.stringify({ tool_calls: changes.map(change => ({ tool: 'write_file', params: {
          path: change.path, content: repair && calls === 2 ? correct : change.content
        } })) }));
      };
      await machine.run();
      const checked = assertion ? spawnSync(node, ['-e', "const a=require('node:assert/strict'),f=require('./math.cjs');a.equal(f.add(-2,7),5);a.equal(f.add(0,0),0);"],
        { cwd: workspace, windowsHide: true, encoding: 'utf8', timeout: 15000 }) : null;
      const syntax = changes.filter(change => /\.[cm]?js$/.test(change.path)).map(change => spawnSync(node, ['--check', change.path],
        { cwd: workspace, windowsHide: true, encoding: 'utf8', timeout: 15000 }).status);
      const preserved = protectedFiles.every((file, i) => hash(path.join(workspace, file)) === before[i]);
      const unavailable = machine.runOutcome.reason === 'behavioral_verification_unavailable';
      const ok = preserved && syntax.every(code => code === 0) && (expected === 'unverified'
        ? machine.runOutcome.status === 'incomplete' && unavailable && calls === 1 && machine.repairCycleCount === 0
        : machine.runOutcome.status === 'completed' && (!checked || checked.status === 0) && calls === (repair ? 2 : 1));
      const row = { name, ok, outcome: machine.runOutcome, modelCalls: calls, repairCycles: machine.repairCycleCount,
        syntaxExitCodes: syntax, independentBehaviorExitCode: checked?.status ?? null, protectedFilesPreserved: preserved,
        checkpoints: machine.checkpoint.failedVerifications,
        verificationEvents: events.filter(event => event.state === 'VERIFY').map(event => event.payload),
        files: fs.readdirSync(workspace), visibleAnswer: events.filter(event => event.type === 'chunk').map(event => event.text || '').join('') };
      report.cases.push(row);
      console.log(JSON.stringify({ name, ok, status: row.outcome.status, reason: row.outcome.reason, calls }));
    }
    await run('syntax-pass-behavior-wrong-without-tests', { changes: [{ path: 'math.cjs', content: wrong }], expected: 'unverified' });
    await run('configured-noop-is-not-a-behavioral-test', { files: { 'package.json': JSON.stringify({ scripts: { test: 'node --version' } }) },
      changes: [{ path: 'math.cjs', content: correct }], expected: 'unverified' });
    await run('syntax-only-test-script', { files: { 'package.json': JSON.stringify({ scripts: { test: 'node --check math.cjs' } }) },
      changes: [{ path: 'math.cjs', content: wrong }], expected: 'unverified' });
    await run('all-tests-skipped', { files: { 'math.cjs': 'exports.add=(a,b)=>a-b;',
      'math.test.cjs': "require('node:test').skip('not implemented',()=>{});" },
    changes: [{ path: 'math.cjs', content: correct }], expected: 'unverified' });
    await run('new-source-existing-behavior-test', { files: { 'behavior.test.cjs': testBody },
      changes: [{ path: 'math.cjs', content: wrong }], expected: 'completed', repair: true });
    await run('existing-tests-detect-and-repair-wrong-code', { files: { 'math.cjs': 'exports.add=(a,b)=>a-b;', 'math.test.cjs': testBody },
      changes: [{ path: 'math.cjs', content: wrong }], expected: 'completed', repair: true });
    await run('declared-test-runner-retains-loader', { files: { 'package.json': JSON.stringify({ scripts: { test: 'node --test --import ./setup.mjs math.test.cjs' } }),
      'math.cjs': 'exports.add=(a,b)=>a-b;', 'setup.mjs': "import assert from 'node:assert/strict';globalThis.fixtureAssert=assert;",
      'math.test.cjs': "const test=require('node:test'),f=require('./math.cjs');test('loader',()=>fixtureAssert.equal(f.add(2,3),5));" },
    changes: [{ path: 'math.cjs', content: correct }], expected: 'completed' });
    await run('one-package-tested-does-not-cover-another', { files: { 'a/package.json': '{}', 'b/package.json': '{}',
      'a/math.test.cjs': testBody }, changes: [{ path: 'a/math.cjs', content: correct }, { path: 'b/math.cjs', content: correct }],
    expected: 'unverified', assertion: false });
    await run('documentation-does-not-require-code-tests', { changes: [{ path: 'README.md', content: 'Updated documentation.' }],
      expected: 'completed', assertion: false });
    report.ok = report.cases.every(row => row.ok);
  } catch (error) { report.error = { name: error.name, message: error.message }; }
  finally {
    report.packageUnchanged = hash(archive) === report.packageHashAtStart;
    report.finishedAt = new Date().toISOString(); report.ok &&= report.packageUnchanged;
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ ok: report.ok, output, error: report.error }));
    app.exit(report.ok ? 0 : 1);
  }
});
