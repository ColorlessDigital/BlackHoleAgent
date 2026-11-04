import fs from 'fs/promises';
import path from 'path';
import { parentPort, workerData } from 'worker_threads';

const EXCLUDES = new Set([
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

const BROAD_ROOT_EXCLUDES = new Set([
  '$recycle.bin',
  'system volume information',
  'download',
  'downloads',
  'windows',
  'program files',
  'program files (x86)',
  'recovery'
]);

const TEXT_EXTENSIONS = /\.(js|jsx|ts|tsx|json|css|html|md|txt|bat|cmd|ps1|py|go|c|cpp|h|java|cs|yml|yaml|ini|conf)$/i;
const MAX_FILES = 3000;
const BROAD_ROOT_MAX_FILES = 300;
const MAX_SCAN_DEPTH = 12;
const BROAD_ROOT_MAX_SCAN_DEPTH = 4;
const MAX_SCAN_MS = 12000;

export async function scan(root, options = {}) {
  const files = [];
  const broadRoot = options.forceBroadRoot ?? isBroadWorkspaceRoot(root);
  const state = {
    startedAt: Date.now(),
    fileLimit: broadRoot ? BROAD_ROOT_MAX_FILES : MAX_FILES,
    maxDepth: broadRoot ? BROAD_ROOT_MAX_SCAN_DEPTH : MAX_SCAN_DEPTH
  };

  async function walk(current, depth = 0) {
    if (shouldStop(files, state) || depth > state.maxDepth) return;
    let entries = [];
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of sortEntries(entries)) {
      if (shouldStop(files, state)) break;
      const name = entry.name.toLowerCase();
      if (EXCLUDES.has(name) || (broadRoot && BROAD_ROOT_EXCLUDES.has(name)) || entry.isSymbolicLink()) continue;
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(absolute, depth + 1);
      } else if (TEXT_EXTENSIONS.test(entry.name)) {
        try {
          const stat = await fs.stat(absolute);
          if (stat.size < 1024 * 1024) {
            files.push({ path: absolute, mtimeMs: stat.mtimeMs });
          }
        } catch {
          // Ignore unreadable files.
        }
      }
    }
  }

  await walk(root);
  const entries = [];
  for (const file of files) {
    try {
      const content = await fs.readFile(file.path, 'utf-8');
      entries.push({
        file: path.relative(root, file.path).replace(/\\/g, '/'),
        absolute: file.path,
        content,
        mtimeMs: file.mtimeMs
      });
    } catch {
      // Ignore files that changed during scan.
    }
  }
  return entries;
}

function isBroadWorkspaceRoot(root) {
  const resolved = path.resolve(root || '.');
  const parsed = path.parse(resolved);
  return resolved === parsed.root;
}

function shouldStop(files, state) {
  if (files.length >= state.fileLimit) return true;
  return Date.now() - state.startedAt > MAX_SCAN_MS;
}

function sortEntries(entries) {
  return [...entries].sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
}

if (parentPort && workerData?.root) {
  scan(workerData.root)
    .then((entries) => parentPort.postMessage({ ok: true, entries }))
    .catch((error) => parentPort.postMessage({ ok: false, error: error.message }));
}
