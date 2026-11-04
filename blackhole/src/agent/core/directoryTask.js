import path from 'node:path';
import { stat } from 'node:fs/promises';

// Recognize only a standalone, literal directory-creation request. Mixed code
// tasks stay on the existing code workflow; command text is never interpreted.
export function resolveDirectoryTask(goal, workspaceRoot) {
  const text = String(goal || '').trim().replace(/[.!?。]+$/, '').trim();
  const korean = /^(?:([a-z])\s*드라이브(?:에|에서)?\s*)?(.+?)(?:라는|란)?\s*(?:폴더|디렉터리|디렉토리)(?:를|을)?\s*(?:([a-z])\s*드라이브(?:에|에서)?\s*)?(?:생성|만들)(?:해|하|어|기|줘|주세요|라|세요|주십시오|\s)*$/i.exec(text);
  const english = /^(?:please\s+)?(?:create|make)\s+(?:(?:a|the|new)\s+)?(?:folder|directory)\s+(?:(?:named|called)\s+)?(.+?)(?:\s+(?:on|in)\s+(?:drive\s+)?([a-z]):?(?:\s+drive)?)?$/i.exec(text);
  if (!korean && !english) return null;
  let name = (korean ? korean[2] : english[1]).trim();
  const drive = korean ? korean[1] || korean[3] : english[2];
  const quoted = /^(?:".*"|'.*'|`.*`)$/s.test(name);
  if (quoted) name = name.slice(1, -1);
  else if (/\b(and|then|with)\b|폴더|디렉터리|디렉토리|[,;&|\n]/i.test(name)) return null;
  if (!name || /[\0\r\n]/.test(name) || /^[a-z]:[^\\/]/i.test(name)) return null;
  const windows = drive || /^[a-z]:[\\/]/i.test(name) || /^[a-z]:[\\/]/i.test(workspaceRoot);
  const paths = windows ? path.win32 : path;
  const target = paths.resolve(drive ? `${drive.toUpperCase()}:\\` : workspaceRoot, name);
  if (drive && target.slice(0, 2).toLowerCase() !== `${drive}:`.toLowerCase()) return null;
  return { kind: 'directory_creation', paths: [target], evidence: [] };
}

export async function observeDirectoryTask(task, workspaceRoot, { signal, automatic = false } = {}) {
  const evidence = [];
  for (const target of task.paths) {
    signal?.throwIfAborted();
    const relative = path.relative(workspaceRoot, target);
    if (automatic && (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))) {
      evidence.push({ path: target, status: 'unobserved' });
      continue;
    }
    try {
      const entry = await stat(target);
      evidence.push({ path: target, status: entry.isDirectory() ? 'directory' : 'not_directory' });
    } catch (error) {
      signal?.throwIfAborted();
      evidence.push({ path: target, status: ['ENOENT', 'ENOTDIR'].includes(error.code) ? 'missing' : 'unreadable', code: error.code });
    }
  }
  return { ...task, evidence, observedAt: new Date().toISOString() };
}

export function directoryTaskVerified(task) {
  return Boolean(Array.isArray(task?.paths) && task.paths.length && task.paths.every(target => task.evidence?.some(entry => entry.path === target && entry.status === 'directory')));
}
