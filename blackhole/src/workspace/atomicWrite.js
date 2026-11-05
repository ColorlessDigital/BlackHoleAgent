import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

function temporaryPath(target) {
  return path.join(path.dirname(target), `.bh-atomic-${randomUUID()}.tmp`);
}

function prepareTarget(target) {
  for (let depth = 0; depth < 40; depth++) {
    let entry;
    try { entry = fs.lstatSync(target); }
    catch (error) { if (error.code === 'ENOENT') return { target }; throw error; }
    if (!entry.isSymbolicLink()) return { target: fs.realpathSync(target), mode: entry.mode };
    target = path.resolve(path.dirname(target), fs.readlinkSync(target));
  }
  throw Object.assign(new Error('Too many symbolic links while resolving the write target.'), { code: 'ELOOP' });
}

export async function writeFileAtomic(target, content, { signal } = {}) {
  signal?.throwIfAborted();
  const prepared = prepareTarget(target);
  target = prepared.target;
  const mode = prepared.mode;
  const temporary = temporaryPath(target);
  let handle;
  try {
    handle = await fs.promises.open(temporary, 'wx', mode === undefined ? 0o666 : mode & 0o777);
    await handle.writeFile(content ?? '', { encoding: 'utf8', ...(signal ? { signal } : {}) });
    await handle.sync();
    await handle.close();
    handle = null;
    signal?.throwIfAborted();
    await fs.promises.rename(temporary, target);
  } finally {
    if (handle) await handle.close().catch(() => {});
    await fs.promises.rm(temporary, { force: true }).catch(() => {});
  }
}

export function writeFileAtomicSync(target, content) {
  const prepared = prepareTarget(target);
  target = prepared.target;
  const mode = prepared.mode;
  const temporary = temporaryPath(target);
  try {
    fs.writeFileSync(temporary, content ?? '', { encoding: 'utf8', flag: 'wx', flush: true,
      mode: mode === undefined ? 0o666 : mode & 0o777 });
    fs.renameSync(temporary, target);
  } finally {
    try { fs.rmSync(temporary, { force: true }); } catch {}
  }
}
