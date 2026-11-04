import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { snapshotActionFiles, compareActionFiles } from './actionJournal.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bh-action-journal-'));
process.env.BLACKHOLE_DATA_DIR = path.join(root, 'data');
process.env.BLACKHOLE_DISABLE_WORKSPACE_STANDARD = '1';
process.env.BLACKHOLE_NODE_PATH = process.execPath;
const { AgentStateMachine } = await import('./stateMachine.js');
const { AgentCheckpointStore } = await import('./checkpointStore.js');
const { ToolRegistry } = await import('./toolRegistry.js');
const { eventBus } = await import('../../common/eventBus.js');
const { respondToApproval, listPendingApprovals } = await import('../../security/approvalGate.js');
after(() => fs.rmSync(root, { recursive: true, force: true }));

function fixture(goal = 'Inspect current files', extra = {}) {
  const workspace = fs.mkdtempSync(path.join(root, 'workspace-'));
  const events = [];
  const machine = new AgentStateMachine({ config: { workspaceRoot: workspace, permissionMode: 'full',
    agentMemoryEnabled: false, selfHealingMaxCycles: 2, ...extra },
  messages: [{ role: 'user', content: goal }], send: event => events.push(event) });
  machine.checkpointStore = new AgentCheckpointStore({ dir: path.join(workspace, 'sessions') });
  machine.contextEngine.scanWorkspace = async () => {};
  return { workspace, machine, events };
}

test('file journal stores stable hashes and explicit missing/non-file states, never source contents', async () => {
  const { workspace } = fixture();
  fs.writeFileSync(path.join(workspace, 'secret.txt'), 'fixture-private-source-content');
  fs.mkdirSync(path.join(workspace, 'directory'));
  const snapshots = await snapshotActionFiles(['secret.txt', 'absent.txt', 'directory', 'secret.txt'], workspace);
  assert.deepEqual(snapshots.map(file => file.status), ['file', 'missing', 'non_file']);
  assert.equal(snapshots[0].sha256, createHash('sha256').update('fixture-private-source-content').digest('hex'));
  assert.equal(JSON.stringify(snapshots).includes('fixture-private-source-content'), false);
  assert.equal((await snapshotActionFiles(['secret.txt'], workspace, { signal: null }))[0].status, 'file');
  await assert.rejects(snapshotActionFiles(['secret.txt'], workspace, { signal: AbortSignal.abort() }), error => error.name === 'AbortError');
});

test('reconciliation distinguishes changed, unchanged and unknown rather than assuming execution succeeded', () => {
  const before = [{ path: 'same', status: 'file', sha256: 'a' }, { path: 'changed', status: 'file', sha256: 'a' },
    { path: 'new', status: 'missing' }, { path: 'deleted', status: 'file', sha256: 'd' }, { path: 'uncertain', status: 'unreadable' }];
  const after = [{ path: 'same', status: 'file', sha256: 'a' }, { path: 'changed', status: 'file', sha256: 'b' },
    { path: 'new', status: 'file', sha256: 'c' }, { path: 'deleted', status: 'missing' }, { path: 'uncertain', status: 'file', sha256: 'e' }];
  assert.deepEqual(compareActionFiles(before, after).map(file => file.state), ['unchanged', 'changed', 'changed', 'changed', 'unknown']);
});

test('automatic recovery does not reuse past authorization to inspect paths outside its workspace', async () => {
  const { workspace } = fixture();
  const outside = path.join(root, 'outside-recovery.txt');
  fs.writeFileSync(outside, 'Fixture outside the current automatic scope');
  assert.equal((await snapshotActionFiles([outside], workspace, { automatic: true }))[0].status, 'unobserved');
  assert.equal((await snapshotActionFiles([outside], workspace))[0].status, 'file', 'Authorized direct observation remains available.');
});

test('file snapshots and backups start only after the existing approval gate allows execution', async t => {
  const { workspace, machine } = fixture('Fix target.txt', { permissionMode: 'strict' });
  fs.writeFileSync(path.join(workspace, 'target.txt'), 'Original');
  const pending = new Promise(resolve => eventBus.once('approval:pending', resolve));
  t.after(() => { for (const entry of listPendingApprovals()) respondToApproval(entry.id, 'reject'); });
  const execution = machine.executeJournaledTool({ tool: 'write_file', params: { path: 'target.txt', content: 'Replacement' } });
  const approval = await pending;
  assert.equal(machine.checkpointStore.loadLatest().pendingAction.phase, 'requested');
  assert.deepEqual(machine.checkpointStore.loadLatest().pendingAction.files, []);
  assert.equal(machine.diffTracker.backups.size, 0);
  respondToApproval(approval.id, 'reject');
  const result = await execution;
  assert.equal(result.result.rejected, true);
  machine.finishJournaledTool(result);
  assert.equal(fs.readFileSync(path.join(workspace, 'target.txt'), 'utf8'), 'Original');
  assert.equal(machine.checkpointStore.loadLatest().pendingAction, null);
});

test('completed actions are acknowledged without persisting arguments or source text', async () => {
  const { machine } = fixture('Fix target.txt');
  const execution = await machine.executeJournaledTool({ tool: 'write_file', params: {
    path: 'target.txt', content: 'fixture-source-value-not-for-the-journal' } });
  assert.equal(execution.result.ok, true);
  const pending = machine.checkpointStore.loadLatest();
  assert.equal(pending.pendingAction.phase, 'executing');
  assert.equal(pending.pendingAction.files[0].status, 'missing');
  assert.equal(JSON.stringify(pending.pendingAction).includes('fixture-source-value'), false);
  machine.diffTracker.trackChange('target.txt');
  machine.finishJournaledTool(execution);
  const acknowledged = machine.checkpointStore.loadLatest();
  assert.equal(acknowledged.pendingAction, null);
  assert.equal(acknowledged.recentActions.at(-1).outcome, 'completed');
  assert.deepEqual(acknowledged.changedFiles, ['target.txt']);
});

test('a named checkpoint is durable and sent before the first model call', async () => {
  const { machine, events } = fixture('Explain the project');
  machine.callModel = async (_system, _messages, onChunk) => {
    const disk = machine.checkpointStore.loadLatest();
    const sent = events.find(event => event.type === 'checkpoint')?.checkpoint;
    assert.equal(sent.sessionId, disk.sessionId);
    assert.equal(sent.providerSessionId, disk.providerSessionId);
    onChunk('This is the fixture project.');
  };
  await machine.run();
  assert.equal(machine.runOutcome.status, 'completed');
});

test('the first recovered checkpoint is announced after a storage failure without announcing every journal update', () => {
  const { machine, events } = fixture();
  const store = machine.checkpointStore;
  let calls = 0;
  machine.checkpointStore = { save(checkpoint) {
    if (++calls === 1) throw new Error('Fixture temporary storage failure');
    return store.save(checkpoint);
  } };
  assert.equal(machine.saveCheckpoint('Initialize'), null);
  machine.saveCheckpoint('Recovered journal', { notify: false });
  machine.saveCheckpoint('Next quiet journal', { notify: false });
  assert.equal(events.filter(event => event.type === 'checkpoint').length, 1);
  assert.equal(events.some(event => event.checkpointSaveFailed), true);
  machine.checkpointStore = { save() { throw new Error('Fixture later storage failure'); } };
  assert.equal(machine.saveCheckpoint('Later failure', { notify: false }), null);
  machine.checkpointStore = store;
  machine.saveCheckpoint('Later recovery', { notify: false });
  machine.saveCheckpoint('Quiet after recovery', { notify: false });
  assert.equal(events.filter(event => event.type === 'checkpoint').length, 2);
  assert.equal(events.filter(event => event.type === 'checkpoint').at(-1).checkpoint.nextRecommendedAction, 'Later recovery');
});

test('a returned failure with partial file effects still records the changes and cannot report success', async t => {
  const { workspace, machine } = fixture('Fix target.js');
  fs.writeFileSync(path.join(workspace, 'target.js'), 'const original = true;');
  t.mock.method(ToolRegistry.getTool('write_file'), 'execute', async () => {
    fs.writeFileSync(path.join(workspace, 'target.js'), 'function broken(');
    return { ok: false, error: 'Fixture partial write failed' };
  });
  let calls = 0;
  machine.callModel = async (_system, _messages, onChunk) => onChunk(++calls === 1
    ? JSON.stringify({ tool: 'write_file', params: { path: 'target.js', content: 'replacement' } }) : 'Done.');
  machine.verificationEngine.runVerificationSuite = async ({ changedFiles }) => {
    assert.ok(changedFiles.includes('target.js'));
    return { ok: false, results: { syntax: { ok: false }, test: { ok: true, skipped: true }, lint: { ok: true, skipped: true } } };
  };
  await machine.run();
  assert.equal(machine.runOutcome.status, 'incomplete');
  assert.ok(machine.checkpointStore.loadLatest().changedFiles.includes('target.js'), JSON.stringify({
    outcome: machine.runOutcome, current: machine.checkpoint, tracked: [...machine.diffTracker.changedFiles]
  }));
  assert.equal(machine.checkpointStore.loadLatest().recentActions.at(-1).outcome, 'failed');
  assert.equal(machine.toolExecutionSummary[0].mutated, true);
});

test('an interrupted opaque action is not automatically replayed or marked successful during hydration', async () => {
  const { workspace, machine } = fixture('Inspect the previous action result');
  fs.writeFileSync(path.join(workspace, 'effect.txt'), '1');
  machine.resumeCheckpoint = { sessionId: machine.checkpoint.sessionId, workspaceRoot: workspace };
  machine.checkpoint.pendingAction = { id: 'opaque', tool: 'run_command', phase: 'executing', files: [], requestedAt: new Date().toISOString() };
  let calls = 0;
  const executed = [];
  const original = machine.executor.execute.bind(machine.executor);
  machine.executor.execute = async (tool, params, options) => { executed.push(tool); return original(tool, params, options); };
  machine.callModel = async (_system, messages, onChunk) => {
    assert.match(JSON.stringify(messages), /automaticallyReplayed/);
    onChunk(++calls === 1 ? JSON.stringify({ tool: 'read_file', params: { path: 'effect.txt' } }) : 'The existing result is 1.');
  };
  await machine.run();
  assert.equal(machine.runOutcome.status, 'completed');
  assert.deepEqual(executed, ['read_file']);
  assert.equal(machine.checkpoint.actionRecoveries[0].outcome, 'unknown');
  assert.equal(machine.checkpoint.actionRecoveries[0].automaticallyReplayed, false);
  assert.equal(fs.readFileSync(path.join(workspace, 'effect.txt'), 'utf8'), '1');
});

test('force-killing the process after a file effect but before tool return preserves evidence for fresh-process resume', async t => {
  const { workspace, machine } = fixture('Fix both calc.cjs and cart.cjs');
  fs.writeFileSync(path.join(workspace, 'calc.cjs'), 'exports.add=(a,b)=>a-b;\n');
  fs.writeFileSync(path.join(workspace, 'cart.cjs'), 'exports.total=items=>items.reduce((s,i)=>s+i.price,0);\n');
  const store = machine.checkpointStore;
  const source = path.resolve('src/agent/core/stateMachine.js');
  const checkpointSource = path.resolve('src/agent/core/checkpointStore.js');
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import fs from 'node:fs'; import path from 'node:path';
    const {AgentStateMachine}=await import(${JSON.stringify(pathToFileURL(source).href)});
    const {AgentCheckpointStore}=await import(${JSON.stringify(pathToFileURL(checkpointSource).href)});
    const root=process.env.BH_JOURNAL_WORKSPACE;
    process.on('message',()=>{});
    const machine=new AgentStateMachine({config:{workspaceRoot:root,permissionMode:'full',agentMemoryEnabled:false},
      messages:[{role:'user',content:'Fix both calc.cjs and cart.cjs'}],providerSessionId:'crash-fixture',send:()=>{}});
    machine.checkpointStore=new AgentCheckpointStore({dir:path.join(root,'sessions')});
    machine.contextEngine.scanWorkspace=async()=>{};
    machine.callModel=async(_s,_m,chunk)=>chunk(JSON.stringify({tool_calls:[
      {tool:'write_file',params:{path:'calc.cjs',content:'exports.add=(a,b)=>a+b;\\n'}},
      {tool:'write_file',params:{path:'cart.cjs',content:'exports.total=items=>items.reduce((s,i)=>s+i.price*i.quantity,0);\\n'}}]}));
    const run=machine.executor.runCapability.bind(machine.executor);
    machine.executor.runCapability=async(...args)=>{
      const result=await run(...args);
      if(args[0]==='write_file'&&args[1].path==='calc.cjs'){
        process.send({stage:'effect-written'}); await new Promise(()=>{});
      }
      return result;
    };
    await machine.run(); process.exit(2);
  `], { env: { ...process.env, BH_JOURNAL_WORKSPACE: workspace }, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  const stopped = new Promise(resolve => child.once('close', resolve));
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await stopped; });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Child never reached the committed file effect.')), 10000);
    child.once('message', message => { clearTimeout(timer); assert.equal(message.stage, 'effect-written'); resolve(); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`Child exited before the test interruption: ${code}`)); });
  });
  assert.equal(child.exitCode, null);
  const disk = store.loadLatest();
  assert.equal(disk.pendingAction.phase, 'executing');
  assert.equal(disk.pendingAction.tool, 'write_file');
  assert.deepEqual(disk.changedFiles, []);
  assert.equal(fs.readFileSync(path.join(workspace, 'cart.cjs'), 'utf8'), 'exports.total=items=>items.reduce((s,i)=>s+i.price,0);\n');
  assert.equal(child.kill('SIGKILL'), true);
  await stopped;

  const resumed = new AgentStateMachine({ config: { workspaceRoot: root, permissionMode: 'full', agentMemoryEnabled: false },
    resumeCheckpoint: store.loadLatest(), send: () => {} });
  resumed.checkpointStore = store;
  resumed.contextEngine.scanWorkspace = async () => {};
  resumed.verificationEngine.runVerificationSuite = async () => ({ ok: true,
    results: { syntax: { ok: true }, test: { ok: true, skipped: true }, lint: { ok: true, skipped: true } } });
  const writes = [];
  const execute = resumed.executor.execute.bind(resumed.executor);
  resumed.executor.execute = async (tool, params, options) => {
    if (tool === 'write_file') writes.push(params.path);
    return execute(tool, params, options);
  };
  let turn = 0;
  resumed.callModel = async (_system, messages, onChunk) => {
    assert.ok(messages.some(message => String(message.content).includes('"state":"changed"')));
    onChunk(++turn === 1 ? JSON.stringify({ tool_calls: [
      { tool: 'read_file', params: { path: 'calc.cjs' } }, { tool: 'read_file', params: { path: 'cart.cjs' } }
    ] }) : JSON.stringify({ tool: 'write_file', params: { path: 'cart.cjs', content: 'exports.total=items=>items.reduce((s,i)=>s+i.price*i.quantity,0);\n' } }));
  };
  await resumed.run();
  assert.equal(resumed.runOutcome.status, 'completed');
  assert.deepEqual(writes, ['cart.cjs']);
  assert.equal(resumed.checkpoint.providerSessionId, 'crash-fixture');
  assert.deepEqual([...resumed.diffTracker.changedFiles].sort(), ['calc.cjs', 'cart.cjs']);
  assert.equal(resumed.checkpoint.actionRecoveries[0].outcome, 'unknown');
  assert.equal(store.loadLatest().pendingAction, null);
  execFileSync(process.execPath, ['-e', "const a=require('node:assert/strict');a.equal(require('./calc.cjs').add(2,3),5);a.equal(require('./cart.cjs').total([{price:4,quantity:3}]),12);"],
    { cwd: workspace, windowsHide: true, timeout: 10000 });
});
