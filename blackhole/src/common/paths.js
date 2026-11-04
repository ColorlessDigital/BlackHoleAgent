import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

export const __filename = fileURLToPath(import.meta.url);
export const __dirname = path.dirname(__filename);
export const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
export const IS_PACKAGED_ASAR = PROJECT_ROOT.toLowerCase().includes('.asar');
export const PLATFORM_ARCH = `${process.platform}-${process.arch}`;
export const IS_WINDOWS = process.platform === 'win32';
export const IS_LINUX = process.platform === 'linux';
export const IS_MAC = process.platform === 'darwin';
export const LLAMA_CPP_ROOT = IS_PACKAGED_ASAR
  ? path.join(process.resourcesPath, 'llama.cpp')
  : path.join(PROJECT_ROOT, 'resources', 'llama.cpp');
export const LLAMA_SERVER_EXECUTABLE = IS_WINDOWS ? 'llama-server.exe' : 'llama-server';
export const MODEL_ROOT = IS_PACKAGED_ASAR
  ? path.join(process.resourcesPath, 'models')
  : path.join(PROJECT_ROOT, 'models');
export const VSCODE_EXTENSION_ROOT = IS_PACKAGED_ASAR
  ? path.join(process.resourcesPath, 'vscode')
  : path.join(PROJECT_ROOT, 'resources', 'vscode');
export const VSCODE_EXTENSION_VSIX_PATH = path.join(VSCODE_EXTENSION_ROOT, 'vscode-blackhole.vsix');
export const NODE_RUNTIME_ROOT = IS_PACKAGED_ASAR
  ? path.join(process.resourcesPath, 'node-runtime')
  : findDevelopmentNodeRuntimeRoot();
export const NODE_RUNTIME_BIN_DIR = NODE_RUNTIME_ROOT
  ? IS_WINDOWS ? NODE_RUNTIME_ROOT : path.join(NODE_RUNTIME_ROOT, 'bin')
  : '';

export function getDefaultLlamaServerPath() {
  const candidates = [
    path.join(LLAMA_CPP_ROOT, PLATFORM_ARCH, LLAMA_SERVER_EXECUTABLE),
    path.join(LLAMA_CPP_ROOT, LLAMA_SERVER_EXECUTABLE)
  ];
  return candidates.find(candidate => fs.existsSync(candidate)) || candidates[0];
}

export function getUserConfigRoot(appName = 'BlackHole') {
  if (process.env.BLACKHOLE_DATA_DIR) return process.env.BLACKHOLE_DATA_DIR;
  if (IS_WINDOWS) {
    return path.join(process.env.APPDATA || process.env.LOCALAPPDATA || os.homedir(), appName);
  }
  if (IS_MAC) {
    return path.join(os.homedir(), 'Library', 'Application Support', appName);
  }
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), appName);
}

export function normalizeForPolicy(targetPath) {
  return path.resolve(targetPath).toLowerCase().replace(/\\/g, '/');
}

export function isWindowsDrivePath(value) {
  return /^[a-zA-Z]:[\\/]/.test(value || '');
}

function findDevelopmentNodeRuntimeRoot() {
  const parent = path.dirname(PROJECT_ROOT);
  const candidates = IS_WINDOWS
    ? [
        path.join(PROJECT_ROOT, 'resources', 'node-runtime', 'current'),
        path.join(parent, `node-v24.21.0-win-${process.arch}`),
        path.dirname(process.execPath || '')
      ]
    : [
        path.join(PROJECT_ROOT, 'resources', 'node-runtime', 'current'),
        path.join(PROJECT_ROOT, 'resources', 'node-runtime', `${process.platform}-${process.arch}`),
        path.join(parent, `node-v24.21.0-${process.platform}-${process.arch}`),
        path.dirname(path.dirname(process.execPath || ''))
      ];
  return candidates.find(candidate => candidate && fs.existsSync(candidate)) || '';
}
