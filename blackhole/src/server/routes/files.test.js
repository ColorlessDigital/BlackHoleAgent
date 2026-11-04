import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import express from 'express';

test('UI file API pages one directory without traversing its children', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bh-files-api-'));
  process.env.BLACKHOLE_DATA_DIR = path.join(root, 'data');
  process.env.BLACKHOLE_DISABLE_WORKSPACE_STANDARD = '1';
  fs.mkdirSync(path.join(root, 'nested'));
  fs.writeFileSync(path.join(root, 'nested', 'child.txt'), 'contents');
  for (let i = 0; i < 10; i++) fs.writeFileSync(path.join(root, `file-${i}.txt`), 'x');
  const { saveConfig } = await import('../../config/configStore.js');
  const { createFilesRouter } = await import('./files.js');
  saveConfig({ workspaceRoot: root });
  const app = express(); app.use(createFilesRouter());
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => {
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    fs.rmSync(root, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const page = await fetch(`${base}/files?limit=3`).then(r => r.json());
  assert.equal(page.entries.length, 3);
  assert.equal(page.nextOffset, 3);
  assert.ok(page.entries.every(entry => entry.children === undefined));
  const child = await fetch(`${base}/files?path=nested`).then(r => r.json());
  assert.equal(child.entries[0].name, 'child.txt');
  assert.equal(child.nextOffset, null);
});
