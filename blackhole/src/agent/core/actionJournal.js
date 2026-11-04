import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

export async function snapshotActionFiles(files, workspaceRoot, { signal, automatic = false } = {}) {
  const snapshots = [];
  for (const file of [...new Set(files)]) {
    signal?.throwIfAborted();
    const absolute = path.resolve(workspaceRoot, file);
    const relative = path.relative(workspaceRoot, absolute);
    if (automatic && (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))) {
      snapshots.push({ path: file, status: 'unobserved', code: 'OUTSIDE_AUTOMATIC_RECOVERY_SCOPE' });
      continue;
    }
    let opened = false;
    try {
      const before = await stat(absolute);
      opened = true;
      if (!before.isFile()) {
        snapshots.push({ path: file, status: 'non_file' });
        continue;
      }
      const hash = createHash('sha256');
      let bytes = 0;
      for await (const chunk of createReadStream(absolute, signal ? { signal } : {})) {
        signal?.throwIfAborted();
        hash.update(chunk);
        bytes += chunk.length;
      }
      const after = await stat(absolute);
      const stable = before.ino === after.ino && before.dev === after.dev && before.size === after.size
        && before.mtimeMs === after.mtimeMs && bytes === after.size;
      snapshots.push({ path: file, status: stable ? 'file' : 'unstable', size: after.size,
        ...(stable ? { sha256: hash.digest('hex') } : {}) });
    } catch (error) {
      signal?.throwIfAborted();
      snapshots.push({ path: file, status: !opened && ['ENOENT', 'ENOTDIR'].includes(error.code) ? 'missing' : 'unreadable',
        code: error.code || 'FILE_SNAPSHOT_FAILED' });
    }
  }
  return snapshots;
}

export function compareActionFiles(before = [], after = []) {
  const current = new Map(after.map(file => [file.path, file]));
  return before.map(previous => {
    const next = current.get(previous.path);
    const comparable = ['file', 'missing'].includes(previous.status) && ['file', 'missing'].includes(next?.status);
    return { path: previous.path, before: previous.status, after: next?.status || 'unknown',
      state: !comparable ? 'unknown'
        : previous.status === next.status && previous.sha256 === next.sha256 ? 'unchanged' : 'changed' };
  });
}
