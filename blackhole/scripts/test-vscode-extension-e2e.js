import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');
const BLACKHOLE_ROOT = path.dirname(PROJECT_ROOT);
const EXTENSION_ROOT = path.join(BLACKHOLE_ROOT, 'vscode-blackhole');

try {
  if (!fs.existsSync(EXTENSION_ROOT)) {
    throw new Error(`VS Code extension root not found: ${EXTENSION_ROOT}`);
  }
  const npmCmd = findNpmExecutable();
  const invocation = wrapWindowsCmd(npmCmd, ['run', 'test:e2e']);
  const result = spawnSync(invocation.command, invocation.args, {
    cwd: EXTENSION_ROOT,
    env: {
      ...process.env,
      Path: buildToolPath(),
      PATH: buildToolPath()
    },
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 1024 * 1024 * 30
  });

  const output = `${result.stdout || ''}${result.stderr || ''}`;
  console.log(output.trim());
  if (result.status !== 0) {
    throw new Error(`VS Code extension E2E failed with exit code ${result.status}.`);
  }
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

function findNpmExecutable() {
  const bundledNpm = path.join(BLACKHOLE_ROOT, 'node-v24.21.0-win-x64', 'npm.cmd');
  if (fs.existsSync(bundledNpm)) return bundledNpm;
  const linuxBundledNpm = path.join(BLACKHOLE_ROOT, `node-v24.21.0-${process.platform}-${process.arch}`, 'bin', 'npm');
  if (fs.existsSync(linuxBundledNpm)) return linuxBundledNpm;
  const resourceNpm = process.platform === 'win32'
    ? path.join(PROJECT_ROOT, 'resources', 'node-runtime', 'current', 'npm.cmd')
    : path.join(PROJECT_ROOT, 'resources', 'node-runtime', 'current', 'bin', 'npm');
  if (fs.existsSync(resourceNpm)) return resourceNpm;
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

function buildToolPath() {
  const candidates = [
    path.join(BLACKHOLE_ROOT, 'node-v24.21.0-win-x64'),
    path.join(BLACKHOLE_ROOT, `node-v24.21.0-${process.platform}-${process.arch}`, 'bin'),
    process.platform === 'win32'
      ? path.join(PROJECT_ROOT, 'resources', 'node-runtime', 'current')
      : path.join(PROJECT_ROOT, 'resources', 'node-runtime', 'current', 'bin')
  ].filter(candidate => fs.existsSync(candidate));
  return [...candidates, process.env.Path || process.env.PATH || ''].filter(Boolean).join(path.delimiter);
}

function wrapWindowsCmd(command, args) {
  if (process.platform === 'win32' && command.toLowerCase().endsWith('.cmd')) {
    return {
      command: process.env.ComSpec || process.env.COMSPEC || 'C:\\Windows\\System32\\cmd.exe',
      args: ['/d', '/s', '/c', command, ...args]
    };
  }
  return { command, args };
}
