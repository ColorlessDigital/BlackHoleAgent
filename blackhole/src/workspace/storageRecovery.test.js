import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { writeFile, patchFile, patchLines } from './fileBroker.js';
import { PatchTransactionManager } from '../agent/core/patchTransaction.js';
import { AgentCheckpointStore } from '../agent/core/checkpointStore.js';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bh-storage-recovery-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const target = path.join(root, 'target.txt');
  fs.writeFileSync(target, 'Original\nsecond line\n');
  return { root, target, options: { workspaceRoot: root } };
}

for (const operation of ['write', 'patch', 'lines']) {
  test(`${operation}: disk-full while staging preserves the original and removes the partial temporary file`, async t => {
    const { root, target, options } = fixture(t);
    const open = fs.promises.open.bind(fs.promises);
    t.mock.method(fs.promises, 'open', async (...args) => {
      const handle = await open(...args);
      const write = handle.writeFile.bind(handle);
      handle.writeFile = async () => { await write('partial'); throw Object.assign(new Error('fixture disk full'), { code: 'ENOSPC' }); };
      return handle;
    });
    const result = operation === 'write' ? writeFile('target.txt', 'Replacement', options)
      : operation === 'patch' ? patchFile('target.txt', 'Original', 'Replacement', options)
      : patchLines('target.txt', 1, 1, 'Replacement', options);
    await assert.rejects(result, { code: 'ENOSPC' });
    assert.equal(fs.readFileSync(target, 'utf8'), 'Original\nsecond line\n');
    assert.deepEqual(fs.readdirSync(root), ['target.txt']);
  });
}

test('locked replacement reports failure without truncating the original', async t => {
  const { root, target, options } = fixture(t);
  t.mock.method(fs.promises, 'rename', async () => { throw Object.assign(new Error('fixture locked target'), { code: 'EPERM' }); });
  await assert.rejects(writeFile('target.txt', 'Replacement', options), { code: 'EPERM' });
  assert.equal(fs.readFileSync(target, 'utf8'), 'Original\nsecond line\n');
  assert.deepEqual(fs.readdirSync(root), ['target.txt']);
});

test('a real Windows exclusive file handle prevents replacement without data loss', { skip: process.platform !== 'win32' }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bh-exclusive-lock-'));
  const target = path.join(root, 'target.txt');
  fs.writeFileSync(target, 'Original');
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    "$s=[IO.File]::Open($env:BH_STORAGE_TARGET,[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None);[Console]::WriteLine('LOCKED');[Console]::Out.Flush();[Threading.Thread]::Sleep(15000);$s.Dispose()"],
  { env: { ...process.env, BH_STORAGE_TARGET: target }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const closed = new Promise(resolve => child.once('close', resolve));
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await closed;
    fs.rmSync(root, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => {
    let text = '';
    const timer = setTimeout(() => reject(new Error('Exclusive lock fixture did not start.')), 10000);
    child.stdout.on('data', chunk => { text += chunk; if (text.includes('LOCKED')) { clearTimeout(timer); resolve(); } });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`Lock fixture exited early: ${code}`)); });
  });
  await assert.rejects(writeFile('target.txt', 'Replacement', { workspaceRoot: root }), error => ['EPERM', 'EACCES', 'EBUSY'].includes(error.code));
  child.kill();
  await closed;
  assert.equal(fs.readFileSync(target, 'utf8'), 'Original');
  assert.deepEqual(fs.readdirSync(root), ['target.txt']);
});

test('cancellation after flushing the temporary file does not publish the replacement', async t => {
  const { root, target, options } = fixture(t);
  const stop = new AbortController();
  const open = fs.promises.open.bind(fs.promises);
  t.mock.method(fs.promises, 'open', async (...args) => {
    const handle = await open(...args);
    const sync = handle.sync.bind(handle);
    handle.sync = async () => { await sync(); stop.abort(); };
    return handle;
  });
  await assert.rejects(writeFile('target.txt', 'Replacement', { ...options, abortSignal: stop.signal }), { name: 'AbortError' });
  assert.equal(fs.readFileSync(target, 'utf8'), 'Original\nsecond line\n');
  assert.deepEqual(fs.readdirSync(root), ['target.txt']);
});

test('a pre-cancelled write does not create a file', async t => {
  const { root, options } = fixture(t);
  await assert.rejects(writeFile('nested/new.txt', 'Replacement', { ...options, abortSignal: AbortSignal.abort() }), { name: 'AbortError' });
  assert.equal(fs.existsSync(path.join(root, 'nested')), false);
});

test('a null optional signal still writes successfully through the agent adapter', async t => {
  const { target, options } = fixture(t);
  await writeFile('target.txt', 'Replacement', { ...options, abortSignal: null });
  assert.equal(fs.readFileSync(target, 'utf8'), 'Replacement');
});

test('atomic replacement preserves existing and dangling file symlinks', async t => {
  const { root, target, options } = fixture(t);
  const link = path.join(root, 'link.txt');
  try { fs.symlinkSync(target, link, 'file'); }
  catch (error) { if (error.code === 'EPERM') { t.skip('This Windows account cannot create file symlinks.'); return; } throw error; }
  await writeFile('link.txt', 'Replacement', options);
  assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
  assert.equal(fs.readFileSync(target, 'utf8'), 'Replacement');
  fs.unlinkSync(target);
  await writeFile('link.txt', 'Created through dangling link', options);
  assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
  assert.equal(fs.readFileSync(target, 'utf8'), 'Created through dangling link');
});

test('transaction operations against the same file compose in order', t => {
  const { root, target } = fixture(t);
  const result = new PatchTransactionManager(root).apply([
    { type: 'write_file', path: 'target.txt', content: 'First\nsecond line\n' },
    { type: 'patch_file', path: 'target.txt', search: 'First', replace: 'Final' }
  ]);
  assert.equal(result.ok, true);
  assert.equal(fs.readFileSync(target, 'utf8'), 'Final\nsecond line\n');
});

for (const rollbackFails of [false, true]) {
  test(`transaction preserves unwritten files and reports ${rollbackFails ? 'incomplete' : 'complete'} rollback`, t => {
    const { root, target } = fixture(t);
    fs.writeFileSync(path.join(root, 'other.txt'), 'Other original');
    const rename = fs.renameSync.bind(fs);
    let writes = 0;
    t.mock.method(fs, 'renameSync', (from, to) => {
      writes++;
      if (writes === 2 || (rollbackFails && writes === 3)) throw Object.assign(new Error('fixture locked target'), { code: 'EPERM' });
      return rename(from, to);
    });
    const result = new PatchTransactionManager(root).apply([
      { type: 'write_file', path: 'target.txt', content: 'Replacement' },
      { type: 'write_file', path: 'other.txt', content: 'Other replacement' }
    ]);
    assert.equal(result.ok, false);
    assert.equal(result.rolledBack, !rollbackFails);
    assert.equal(result.rollbackFailures.length, rollbackFails ? 1 : 0);
    assert.equal(fs.readFileSync(path.join(root, 'other.txt'), 'utf8'), 'Other original');
    assert.equal(fs.readFileSync(target, 'utf8'), rollbackFails ? 'Replacement' : 'Original\nsecond line\n');
    assert.equal(fs.readdirSync(root).some(name => name.endsWith('.tmp')), false);
  });
}

test('rollback does not overwrite an independent edit made after a transaction write', t => {
  const { root, target } = fixture(t);
  const rename = fs.renameSync.bind(fs);
  let writes = 0;
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (++writes === 2) { fs.writeFileSync(target, 'Independent edit'); throw new Error('fixture commit failure'); }
    return rename(from, to);
  });
  const result = new PatchTransactionManager(root).apply([
    { type: 'write_file', path: 'target.txt', content: 'Replacement' },
    { type: 'write_file', path: 'new.txt', content: 'Other replacement' }
  ]);
  assert.equal(result.rolledBack, false);
  assert.equal(fs.readFileSync(target, 'utf8'), 'Independent edit');
});

test('checkpoint recovery survives corrupt latest and an unpublished latest pointer', t => {
  const { root } = fixture(t);
  const store = new AgentCheckpointStore({ dir: path.join(root, 'sessions') });
  const first = { sessionId: 'session-first', state: 'PLAN', userGoal: 'First' };
  store.save(first);
  fs.writeFileSync(path.join(store.dir, 'latest.json'), '{broken');
  assert.equal(store.loadLatest().sessionId, first.sessionId);
  const rename = fs.renameSync.bind(fs);
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (path.basename(to) === 'latest.json') throw Object.assign(new Error('fixture locked latest'), { code: 'EPERM' });
    return rename(from, to);
  });
  assert.throws(() => store.save({ sessionId: 'session-new', state: 'PLAN', userGoal: 'New' }), { code: 'EPERM' });
  assert.equal(store.load('session-new').userGoal, 'New');
  assert.equal(store.loadLatest().sessionId, 'session-new');
  assert.equal(store.load('unrelated-missing'), null);
});

test('disk-full checkpoint staging preserves the previous durable snapshot', t => {
  const { root } = fixture(t);
  const store = new AgentCheckpointStore({ dir: path.join(root, 'sessions') });
  store.save({ sessionId: 'session', state: 'PLAN', userGoal: 'Original goal' });
  const write = fs.writeFileSync.bind(fs);
  t.mock.method(fs, 'writeFileSync', (file, ...args) => {
    if (String(file).endsWith('.tmp')) { write(file, '{partial'); throw Object.assign(new Error('fixture disk full'), { code: 'ENOSPC' }); }
    return write(file, ...args);
  });
  assert.throws(() => store.save({ sessionId: 'session', state: 'ACT', userGoal: 'New goal' }), { code: 'ENOSPC' });
  assert.equal(store.load('session').userGoal, 'Original goal');
  assert.equal(fs.readdirSync(store.dir).some(name => name.endsWith('.tmp')), false);
});

for (const committed of [false, true]) {
  test(`force-kill ${committed ? 'after' : 'before'} atomic publication leaves a complete file, never partial bytes`, async t => {
    const { root, target } = fixture(t);
    const helper = pathToFileURL(path.resolve('src/workspace/atomicWrite.js')).href;
    const child = spawn(process.execPath, ['--input-type=module', '-e', `
      import fs from 'node:fs';
      const {writeFileAtomic} = await import(${JSON.stringify(helper)});
      const open=fs.promises.open.bind(fs.promises), rename=fs.promises.rename.bind(fs.promises);
      process.on('message',()=>{});
      const pause=()=>{process.send({ready:true});return new Promise(()=>{});};
      if (${committed}) fs.promises.rename=async(...args)=>{await rename(...args);await pause();};
      else fs.promises.open=async(...args)=>{const h=await open(...args),sync=h.sync.bind(h);h.sync=async()=>{await sync();await pause();};return h;};
      await writeFileAtomic(process.env.BH_STORAGE_TARGET,'Replacement'.repeat(10000));
    `], { env: { ...process.env, BH_STORAGE_TARGET: target }, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    const closed = new Promise(resolve => child.once('close', resolve));
    t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await closed; });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Child did not reach the publication boundary.')), 10000);
      child.once('message', () => { clearTimeout(timer); resolve(); });
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', code => { clearTimeout(timer); reject(new Error(`Child exited early: ${code}`)); });
    });
    child.kill('SIGKILL');
    await closed;
    assert.equal(fs.readFileSync(target, 'utf8'), committed ? 'Replacement'.repeat(10000) : 'Original\nsecond line\n');
    assert.ok(root.includes('bh-storage-recovery-'));
  });
}
