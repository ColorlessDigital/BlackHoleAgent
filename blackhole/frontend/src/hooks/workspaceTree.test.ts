import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeDirectoryPage, shouldRefreshWorkspace, updateDirectory } from './workspaceTree.ts';

test('read-only tools never refresh the file tree', () => {
  for (const tool of ['web_search', 'fetch_url', 'read_file', 'list_dir', 'search_project_memory']) assert.equal(shouldRefreshWorkspace(tool), false);
  assert.equal(shouldRefreshWorkspace('write_file'), true);
  assert.equal(shouldRefreshWorkspace('run_command'), true);
  assert.equal(shouldRefreshWorkspace('patch_file', false), false);
});

test('directory updates and paging preserve unrelated branches and deduplicate paths', () => {
  const original = [{ name: 'root', path: 'root', children: [{ name: 'a', path: 'root/a' }] }];
  const updated = updateDirectory(original, 'root', node => ({ ...node, children: mergeDirectoryPage(node.children || [],
    [{ name: 'a', path: 'root/a' }, { name: 'b', path: 'root/b' }]) }));
  assert.equal(updated[0].children?.length, 2);
  assert.equal(original[0].children.length, 1);
});
