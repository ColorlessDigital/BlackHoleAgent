import { test, describe } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { writeFile, readFile, patchFile, patchLines, listDirectoryTree, listDirectoryPage } from './fileBroker.js';
import { getWorkspaceRoot } from './workspaceManager.js';

describe('fileBroker', () => {
  const root = getWorkspaceRoot();
  const testFile = 'test_temp_file_bh.txt';
  const absolutePath = path.join(root, testFile);

  test('writeFile & readFile - should successfully write and read back content', async () => {
    const content = 'Hello BlackHole Agent!\nLine 2\nLine 3';
    
    // Write
    const writeResult = await writeFile(testFile, content);
    assert.strictEqual(fs.existsSync(absolutePath), true);
    
    // Read
    const readResult = await readFile(testFile);
    assert.strictEqual(readResult.content, content);

    // Clean up
    if (fs.existsSync(absolutePath)) {
      fs.unlinkSync(absolutePath);
    }
  });

  test('patchFile - should patch content matching search target', async () => {
    const content = 'Original line\nTarget block to replace\nOriginal end';
    await writeFile(testFile, content);
    
    // Patch
    await patchFile(testFile, 'Target block to replace', 'Replaced block');
    
    const readResult = await readFile(testFile);
    assert.strictEqual(readResult.content.includes('Replaced block'), true);
    assert.strictEqual(readResult.content.includes('Target block to replace'), false);

    // Clean up
    if (fs.existsSync(absolutePath)) {
      fs.unlinkSync(absolutePath);
    }
  });

  test('patchLines - should replace precise line ranges', async () => {
    const content = 'Line 1\nLine 2\nLine 3\nLine 4';
    await writeFile(testFile, content);
    
    // Patch lines 2 to 3
    await patchLines(testFile, 2, 3, 'New Line 2\nNew Line 3');
    
    const readResult = await readFile(testFile);
    const expected = 'Line 1\nNew Line 2\nNew Line 3\nLine 4';
    assert.strictEqual(readResult.content, expected);

    // Clean up
    if (fs.existsSync(absolutePath)) {
      fs.unlinkSync(absolutePath);
    }
  });

  test('workspace override - should isolate file operations to the provided root', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'blackhole-filebroker-'));
    try {
      const result = await writeFile('nested/isolated.txt', 'override-root', { workspaceRoot: tempRoot });
      assert.strictEqual(result.relativePath, 'nested/isolated.txt');
      assert.strictEqual(fs.existsSync(path.join(tempRoot, 'nested', 'isolated.txt')), true);

      const readResult = await readFile('nested/isolated.txt', { workspaceRoot: tempRoot });
      assert.strictEqual(readResult.content, 'override-root');
      assert.strictEqual(readResult.relativePath, 'nested/isolated.txt');
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});

test('directory pages are shallow, complete across pages, and keep direct access to excluded folders', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bh-tree-page-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'nested'));
  fs.mkdirSync(path.join(root, 'node_modules'));
  for (let i = 0; i < 25; i++) fs.writeFileSync(path.join(root, `file-${i}`), 'x');
  fs.writeFileSync(path.join(root, 'nested', 'deep.txt'), 'deep');
  fs.writeFileSync(path.join(root, 'node_modules', 'direct.txt'), 'direct');
  const paths = [];
  let offset = 0;
  do {
    const page = await listDirectoryPage('.', { workspaceRoot: root, limit: 7, offset });
    assert.ok(page.entries.length <= 7);
    assert.ok(page.entries.every(node => !node.children));
    paths.push(...page.entries.map(node => node.path));
    offset = page.nextOffset;
  } while (offset !== null);
  assert.strictEqual(new Set(paths).size, 26);
  assert.strictEqual(paths.includes('node_modules'), false);
  assert.strictEqual((await listDirectoryPage('node_modules', { workspaceRoot: root })).entries[0].name, 'direct.txt');
  assert.strictEqual((await readFile('node_modules/direct.txt', { workspaceRoot: root })).content, 'direct');
  const tree = await listDirectoryTree('.', 4, { workspaceRoot: root, maxEntries: 5, includeStats: true });
  assert.strictEqual(tree.scanStats.entries, 5);
  assert.strictEqual(tree.scanStats.truncated, true);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(listDirectoryPage('.', { workspaceRoot: root, abortSignal: controller.signal }), { name: 'AbortError' });
});

test('directory model previews retain file evidence for both legacy arrays and paged/tree objects', async () => {
  const { ToolRegistry } = await import('../agent/core/toolRegistry.js');
  const entries = [{ name: 'hello.js', path: 'hello.js', isDir: false }];
  for (const result of [entries, { entries, scanStats: { truncated: false } }, { entries, nextOffset: null }]) {
    const summary = ToolRegistry.getTool('list_dir').summarizeForModel(result);
    assert.match(summary, /hello\.js/);
    assert.ok(summary.length < 12000);
  }
});
