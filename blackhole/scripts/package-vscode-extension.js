import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');
const BLACKHOLE_ROOT = path.dirname(PROJECT_ROOT);
const EXTENSION_ROOT = path.join(BLACKHOLE_ROOT, 'vscode-blackhole');
const DIST_DIR = path.join(PROJECT_ROOT, 'dist');
const RESOURCE_DIR = path.join(PROJECT_ROOT, 'resources', 'vscode');
const RESOURCE_OUTPUT_PATH = path.join(RESOURCE_DIR, 'vscode-blackhole.vsix');
const DIST_OUTPUT_PATH = path.join(DIST_DIR, 'vscode-blackhole.vsix');

try {
  if (!fs.existsSync(EXTENSION_ROOT)) {
    throw new Error(`VS Code extension root not found: ${EXTENSION_ROOT}`);
  }
  fs.mkdirSync(DIST_DIR, { recursive: true });
  fs.mkdirSync(RESOURCE_DIR, { recursive: true });

  const npmCmd = findNpmExecutable();
  run(npmCmd, ['run', 'compile'], EXTENSION_ROOT);
  run(npmCmd, ['run', 'package:vsix', '--', '--out', RESOURCE_OUTPUT_PATH], EXTENSION_ROOT);
  fs.copyFileSync(RESOURCE_OUTPUT_PATH, DIST_OUTPUT_PATH);

  if (!fs.existsSync(RESOURCE_OUTPUT_PATH)) {
    throw new Error(`VSIX resource output not found: ${RESOURCE_OUTPUT_PATH}`);
  }

  const stat = fs.statSync(RESOURCE_OUTPUT_PATH);
  console.log(JSON.stringify({
    ok: true,
    extensionRoot: EXTENSION_ROOT,
    resourceOutputPath: RESOURCE_OUTPUT_PATH,
    distOutputPath: DIST_OUTPUT_PATH,
    sizeBytes: stat.size
  }, null, 2));
} catch (error) {
  console.error(JSON.stringify({
    ok: false,
    error: error.message,
    extensionRoot: EXTENSION_ROOT,
    resourceOutputPath: RESOURCE_OUTPUT_PATH,
    distOutputPath: DIST_OUTPUT_PATH
  }, null, 2));
  process.exit(1);
}

function run(command, args, cwd) {
  const invocation = wrapWindowsCmd(command, args);
  const result = spawnSync(invocation.command, invocation.args, {
    cwd,
    env: {
      ...process.env,
      Path: buildToolPath(),
      PATH: buildToolPath()
    },
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 1024 * 1024 * 20
  });
  if (result.status !== 0) {
    throw new Error([
      `${path.basename(command)} ${args.join(' ')} failed with exit code ${result.status}.`,
      result.error?.message,
      result.stdout,
      result.stderr
    ].filter(Boolean).join('\n'));
  }
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

function findNpmExecutable() {
  const bundledNpm = path.join(BLACKHOLE_ROOT, 'node-v24.22.2-win-x64', 'npm.cmd');
  if (fs.existsSync(bundledNpm)) return bundledNpm;
  const linuxBundledNpm = path.join(BLACKHOLE_ROOT, `node-v24.22.2-${process.platform}-${process.arch}`, 'bin', 'npm');
  if (fs.existsSync(linuxBundledNpm)) return linuxBundledNpm;
  const resourceNpm = process.platform === 'win32'
    ? path.join(PROJECT_ROOT, 'resources', 'node-runtime', 'current', 'npm.cmd')
    : path.join(PROJECT_ROOT, 'resources', 'node-runtime', 'current', 'bin', 'npm');
  if (fs.existsSync(resourceNpm)) return resourceNpm;
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

function buildToolPath() {
  const candidates = [
    path.join(BLACKHOLE_ROOT, 'node-v24.22.2-win-x64'),
    path.join(BLACKHOLE_ROOT, `node-v24.22.2-${process.platform}-${process.arch}`, 'bin'),
    process.platform === 'win32'
      ? path.join(PROJECT_ROOT, 'resources', 'node-runtime', 'current')
      : path.join(PROJECT_ROOT, 'resources', 'node-runtime', 'current', 'bin')
  ].filter(candidate => fs.existsSync(candidate));
  return [...candidates, process.env.Path || process.env.PATH || ''].filter(Boolean).join(path.delimiter);
}
