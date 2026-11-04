import fs from 'fs';
import path from 'path';
import { resolveWorkspacePath, toWorkspaceRelative } from './workspaceManager.js';

const DEFAULT_EXCLUDES = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.next',
  '.venv',
  'venv',
  '__pycache__',
  '.gradle',
  '.idea',
  '.vscode',
  'coverage',
  'tmp',
  'temp',
  '.cache',
  'data'
]);

export async function listDirectoryTree(targetPath = '.', depth = 4, options = {}) {
  options.abortSignal?.throwIfAborted();
  const workspaceRoot = options.workspaceRoot || '';
  const root = resolveWorkspacePath(targetPath, workspaceRoot);
  const maxEntries = Math.min(10000, Math.max(1, Number(options.maxEntries) || 1500));
  const deadline = Date.now() + Math.max(1, Number(options.timeoutMs) || 2000);
  const scanStats = { entries: 0, truncated: false, reason: null };
  const maxDepth = Math.min(20, Math.max(0, Number(depth) || 0));
  function canContinue() {
    options.abortSignal?.throwIfAborted();
    if (scanStats.entries >= maxEntries || Date.now() >= deadline) {
      scanStats.truncated = true;
      scanStats.reason = scanStats.entries >= maxEntries ? 'entry_limit' : 'time_limit';
      return false;
    }
    return true;
  }

  async function walk(current, level) {
    if (level > maxDepth || !canContinue()) return [];
    let entries;
    try {
      entries = await fs.promises.opendir(current);
    } catch {
      return [];
    }
    const result = [];
    for await (const entry of entries) {
      if (!canContinue()) break;
      if (DEFAULT_EXCLUDES.has(entry.name)) continue;
      scanStats.entries++;
      const absolute = path.join(current, entry.name);
      const item = {
        name: entry.name,
        path: toWorkspaceRelative(absolute, workspaceRoot),
        isDir: entry.isDirectory()
      };
      if (entry.isDirectory()) {
        if (level < maxDepth) item.children = await walk(absolute, level + 1);
        else item.childrenLoaded = false;
      } else {
        try {
          const stat = await fs.promises.stat(absolute);
          item.size = stat.size;
        } catch {
          item.size = 0;
        }
      }
      result.push(item);
    }
    return result.sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name));
  }

  const entries = await walk(root, 0);
  return options.includeStats ? { entries, scanStats } : entries;
}

export async function listDirectoryPage(targetPath = '.', options = {}) {
  options.abortSignal?.throwIfAborted();
  const workspaceRoot = options.workspaceRoot || '';
  const root = resolveWorkspacePath(targetPath, workspaceRoot);
  const offset = Math.max(0, Math.floor(Number(options.offset) || 0));
  const limit = Math.min(1000, Math.max(1, Math.floor(Number(options.limit) || 200)));
  const entries = [];
  let index = 0, hasMore = false;
  const directory = await fs.promises.opendir(root);
  for await (const entry of directory) {
    options.abortSignal?.throwIfAborted();
    if (DEFAULT_EXCLUDES.has(entry.name)) continue;
    if (index++ < offset) continue;
    if (entries.length >= limit) { hasMore = true; break; }
    entries.push({ name: entry.name, path: toWorkspaceRelative(path.join(root, entry.name), workspaceRoot),
      isDir: entry.isDirectory(), ...(entry.isDirectory() ? { childrenLoaded: false } : {}) });
  }
  return { entries, path: targetPath, nextOffset: hasMore ? offset + entries.length : null, hasMore };
}

export async function readFile(targetPath, options = {}) {
  const workspaceRoot = options.workspaceRoot || '';
  const absolute = resolveWorkspacePath(targetPath, workspaceRoot);
  const stat = await fs.promises.stat(absolute);
  if (stat.size > 2 * 1024 * 1024) {
    throw new Error('Files larger than 2MB are not loaded by the preview reader.');
  }
  const content = await fs.promises.readFile(absolute, 'utf-8');
  return {
    path: absolute,
    relativePath: toWorkspaceRelative(absolute, workspaceRoot),
    content
  };
}

export async function writeFile(targetPath, content, options = {}) {
  const workspaceRoot = options.workspaceRoot || '';
  const absolute = resolveWorkspacePath(targetPath, workspaceRoot);
  const parent = path.dirname(absolute);
  await fs.promises.mkdir(parent, { recursive: true });
  await fs.promises.writeFile(absolute, content ?? '', 'utf-8');
  return { path: absolute, relativePath: toWorkspaceRelative(absolute, workspaceRoot) };
}

export async function patchFile(targetPath, search, replace, options = {}) {
  const workspaceRoot = options.workspaceRoot || '';
  const absolute = resolveWorkspacePath(targetPath, workspaceRoot);
  const current = await fs.promises.readFile(absolute, 'utf-8');
  if (!current.includes(search)) {
    throw new Error('The search block does not exactly match the current file content.');
  }
  await fs.promises.writeFile(absolute, current.replace(search, replace), 'utf-8');
  return { path: absolute, relativePath: toWorkspaceRelative(absolute, workspaceRoot) };
}

export async function patchLines(targetPath, startLine, endLine, replacement, options = {}) {
  const workspaceRoot = options.workspaceRoot || '';
  const absolute = resolveWorkspacePath(targetPath, workspaceRoot);
  const current = await fs.promises.readFile(absolute, 'utf-8');
  const lines = current.split('\n');
  const start = Number(startLine) - 1;
  const end = Number(endLine) - 1;
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || end >= lines.length) {
    throw new Error(`Invalid line range: ${startLine}-${endLine}`);
  }
  lines.splice(start, end - start + 1, ...(replacement ?? '').split('\n'));
  await fs.promises.writeFile(absolute, lines.join('\n'), 'utf-8');
  return { path: absolute, relativePath: toWorkspaceRelative(absolute, workspaceRoot) };
}
