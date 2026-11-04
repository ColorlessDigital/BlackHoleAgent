import path from 'path';
import { loadConfig, saveConfig } from '../config/configStore.js';

let workspaceRoot = loadConfig().workspaceRoot;

export function getWorkspaceRoot() {
  return workspaceRoot;
}

export function resolveWorkspaceRoot(rootOverride = '') {
  const candidate = typeof rootOverride === 'string' && rootOverride.trim()
    ? rootOverride
    : workspaceRoot;
  return path.resolve(candidate);
}

export function setWorkspaceRoot(nextRoot) {
  workspaceRoot = path.resolve(nextRoot);
  saveConfig({ workspaceRoot });
  return workspaceRoot;
}

export function resolveWorkspacePath(inputPath, rootOverride = '') {
  const root = resolveWorkspaceRoot(rootOverride);
  if (!inputPath || typeof inputPath !== 'string') return root;
  const trimmed = inputPath.trim();
  if (/^[a-zA-Z]:[\\/]/.test(trimmed)) return path.resolve(trimmed);
  if (path.isAbsolute(trimmed)) return path.resolve(trimmed);
  if (trimmed.startsWith('/') || trimmed.startsWith('\\')) {
    return path.join(root, trimmed.slice(1));
  }
  return path.join(root, trimmed);
}

export function toWorkspaceRelative(absolutePath, rootOverride = '') {
  return path.relative(resolveWorkspaceRoot(rootOverride), absolutePath).replace(/\\/g, '/');
}
