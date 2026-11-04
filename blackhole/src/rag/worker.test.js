import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { scan } from './worker.js';

test('RAG worker skips download and system folders for broad roots', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'blackhole-rag-'));
  try {
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.mkdirSync(path.join(root, 'Download'), { recursive: true });
    fs.mkdirSync(path.join(root, 'Windows'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'index.js'), 'export const ok = true;\n');
    fs.writeFileSync(path.join(root, 'Download', 'skip.js'), 'export const skip = true;\n');
    fs.writeFileSync(path.join(root, 'Windows', 'skip.js'), 'export const skip = true;\n');

    const entries = await scan(root, { forceBroadRoot: true });
    const files = entries.map(entry => entry.file.toLowerCase());

    assert.ok(files.includes('src/index.js'));
    assert.equal(files.some(file => file.startsWith('download/')), false);
    assert.equal(files.some(file => file.startsWith('windows/')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('RAG worker limits broad root indexing', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'blackhole-rag-'));
  try {
    for (let index = 0; index < 350; index += 1) {
      fs.writeFileSync(path.join(root, `file-${String(index).padStart(3, '0')}.txt`), 'content\n');
    }

    const entries = await scan(root, { forceBroadRoot: true });

    assert.equal(entries.length, 300);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
