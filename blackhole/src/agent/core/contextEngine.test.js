import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { ProjectContextEngine } from './contextEngine.js';

function makeTempWorkspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'blackhole-context-engine-'));
}

test('context engine skips large files during workspace scan', async () => {
  const root = makeTempWorkspace();
  fs.writeFileSync(path.join(root, 'small.js'), 'export const ok = true;\n', 'utf8');
  fs.writeFileSync(path.join(root, 'large.md'), `${'x'.repeat(1024 * 1024 + 8)}\n`, 'utf8');

  const engine = new ProjectContextEngine(root);
  await engine.scanWorkspace();

  assert.equal(engine.fileMap.has('small.js'), true);
  assert.equal(engine.fileMap.has('large.md'), false);
  assert.equal(engine.scanStats.skippedLargeFiles >= 1, true);
});

test('context engine honors scan file limit', () => {
  const root = makeTempWorkspace();
  for (let index = 0; index < 5; index += 1) {
    fs.writeFileSync(path.join(root, `file-${index}.js`), `export const value${index} = ${index};\n`, 'utf8');
  }

  const engine = new ProjectContextEngine(root);
  const scanState = {
    startedAt: Date.now(),
    fileLimit: 2,
    maxDepth: 4,
    broadRoot: false
  };
  const files = engine.globFiles(root, [], scanState);

  assert.equal(files.length, 2);
  assert.equal(scanState.truncated, true);
  assert.equal(scanState.reason, 'file_limit');
});

test('context engine skips download folders when scanning a broad root', () => {
  const root = makeTempWorkspace();
  const downloadDir = path.join(root, 'Download');
  const projectDir = path.join(root, 'Project');
  fs.mkdirSync(downloadDir);
  fs.mkdirSync(projectDir);
  fs.writeFileSync(path.join(downloadDir, 'ignored.js'), 'export const ignored = true;\n', 'utf8');
  fs.writeFileSync(path.join(projectDir, 'kept.js'), 'export const kept = true;\n', 'utf8');

  const engine = new ProjectContextEngine(root);
  const scanState = {
    startedAt: Date.now(),
    fileLimit: 20,
    maxDepth: 4,
    broadRoot: true
  };
  const files = engine.globFiles(root, [], scanState).map(file => path.basename(file));

  assert.deepEqual(files, ['kept.js']);
  assert.equal(scanState.skippedDirectories >= 1, true);
});

test('context indexing honors queued cancellation and a later scan can complete', async t => {
  const root = makeTempWorkspace();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (let index = 0; index < 160; index++) fs.writeFileSync(path.join(root, `file-${index}.md`), `Content ${index}`);
  const engine = new ProjectContextEngine(root);
  const stop = new AbortController();
  const timer = setTimeout(() => stop.abort(), 0);
  try { await assert.rejects(engine.scanWorkspace({ abortSignal: stop.signal }), { name: 'AbortError' }); }
  finally { clearTimeout(timer); }
  await engine.scanWorkspace();
  assert.equal(engine.fileMap.size, 160);
});

test('one disappearing file cannot stop the rest of workspace indexing', async t => {
  const root = makeTempWorkspace();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const name of ['a.md', 'b.md', 'c.md']) fs.writeFileSync(path.join(root, name), name);
  const engine = new ProjectContextEngine(root);
  const glob = engine.globFiles.bind(engine);
  engine.globFiles = (...args) => { const files = glob(...args); fs.unlinkSync(path.join(root, 'b.md')); return files; };
  await engine.scanWorkspace();
  assert.equal(engine.fileMap.has('c.md'), true);
  assert.equal(engine.fileMap.has('b.md'), false);
  assert.ok(engine.scanStats.skippedFiles >= 1);
});

test('an already cancelled scan does not consume or overwrite a warm cache', async t => {
  const root = makeTempWorkspace();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'a.md'), 'Original');
  const engine = new ProjectContextEngine(root);
  await engine.scanWorkspace();
  const scannedAt = engine.lastScanAt;
  await assert.rejects(engine.scanWorkspace({ abortSignal: AbortSignal.abort() }), { name: 'AbortError' });
  assert.equal(engine.lastScanAt, scannedAt);
});

test('a cancelled scan waiter leaves the shared workspace scan running', async t => {
  const root = makeTempWorkspace();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (let i = 0; i < 90; i++) fs.writeFileSync(path.join(root, `${i}.md`), `${i}`);
  const engine = new ProjectContextEngine(root);
  const owner = engine.scanWorkspace();
  const stop = new AbortController();
  const waiter = engine.scanWorkspace({ abortSignal: stop.signal });
  stop.abort();
  await assert.rejects(waiter, { name: 'AbortError' });
  await owner;
  assert.equal(engine.fileMap.size, 90);
  assert.equal(engine.pendingScan, null);
});

test('a queued consumer can rebuild the workspace after the owning scan is cancelled', async t => {
  const root = makeTempWorkspace();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (let i = 0; i < 90; i++) fs.writeFileSync(path.join(root, `${i}.md`), `${i}`);
  const engine = new ProjectContextEngine(root);
  const stop = new AbortController();
  const owner = assert.rejects(engine.scanWorkspace({ abortSignal: stop.signal }), { name: 'AbortError' });
  const waiter = engine.scanWorkspace();
  stop.abort();
  await owner;
  await waiter;
  assert.equal(engine.fileMap.size, 90);
  assert.ok(engine.lastScanAt > 0);
});
