import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { IS_WINDOWS, NODE_RUNTIME_BIN_DIR, PROJECT_ROOT, VSCODE_EXTENSION_VSIX_PATH } from '../common/paths.js';

export async function installVSCodeExtension({ ideExecutablePath = '' } = {}) {
  const vsixPath = getVSCodeExtensionVsixPath();
  if (vsixPath) {
    return installVSIX(vsixPath, ideExecutablePath);
  }

  const sourceDir = getVSCodeExtensionSourceDir();
  await compileVSCodeExtension(sourceDir);
  const extensionsBaseDir = getVSCodeExtensionsBaseDir();
  const targetDir = path.join(extensionsBaseDir, 'vscode-blackhole');

  removeFolderInside(extensionsBaseDir, targetDir);
  copyFolderSync(sourceDir, targetDir);

  return {
    mode: 'source-copy',
    sourceDir,
    targetDir,
    outputPath: path.join(targetDir, 'out', 'extension.js')
  };
}

async function installVSIX(vsixPath, ideExecutablePath = '') {
  const installerPath = findVSCodeInstallerExecutable(ideExecutablePath);
  if (!installerPath) {
    throw new Error('VS Code CLI was not found. Install VS Code or pass a detected code/codium executable path before installing the bundled BlackHole extension.');
  }

  const output = await runVSCodeInstall(installerPath, vsixPath);
  return {
    mode: 'vsix',
    vsixPath,
    installerPath,
    output
  };
}

function getVSCodeExtensionVsixPath() {
  const candidates = [
    VSCODE_EXTENSION_VSIX_PATH,
    path.join(PROJECT_ROOT, 'dist', 'vscode-blackhole.vsix')
  ];
  return candidates.find(candidate => fs.existsSync(candidate)) || '';
}

export async function compileVSCodeExtension(sourceDir = getVSCodeExtensionSourceDir()) {
  if (!fs.existsSync(sourceDir)) {
    throw new Error(`VS Code extension source not found: ${sourceDir}`);
  }

  const tscPath = path.join(sourceDir, 'node_modules', 'typescript', 'bin', 'tsc');
  if (!fs.existsSync(tscPath)) {
    throw new Error(`TypeScript compiler not found: ${tscPath}`);
  }

  const nodeExe = findNodeExecutable();
  const code = await new Promise((resolve) => {
    const proc = spawn(nodeExe, [tscPath, '-p', './'], {
      cwd: sourceDir,
      env: { ...process.env },
      windowsHide: true
    });
    proc.stdout.on('data', data => console.log(`[VS Code Extension] ${data.toString().trim()}`));
    proc.stderr.on('data', data => console.error(`[VS Code Extension] ${data.toString().trim()}`));
    proc.on('close', closeCode => resolve(closeCode));
    proc.on('error', error => {
      console.error(`[VS Code Extension] compile spawn failed: ${error.message}`);
      resolve(-1);
    });
  });

  if (code !== 0) {
    throw new Error('vscode-blackhole extension compile failed.');
  }

  const compiledOut = path.join(sourceDir, 'out', 'extension.js');
  if (!fs.existsSync(compiledOut)) {
    throw new Error(`Compiled extension output not found: ${compiledOut}`);
  }

  return compiledOut;
}

export function getVSCodeExtensionSourceDir() {
  return path.join(path.dirname(PROJECT_ROOT), 'vscode-blackhole');
}

function findVSCodeInstallerExecutable(ideExecutablePath = '') {
  const candidates = [];
  if (ideExecutablePath && fs.existsSync(ideExecutablePath)) {
    const derivedCli = deriveVSCodeCliPath(ideExecutablePath);
    if (derivedCli) candidates.push(derivedCli);
    candidates.push(ideExecutablePath);
  }

  const pathDirs = (process.env.Path || process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const dir of pathDirs) {
    if (IS_WINDOWS) {
      candidates.push(path.join(dir, 'code.exe'));
      candidates.push(path.join(dir, 'code.cmd'));
    } else {
      candidates.push(path.join(dir, 'code'));
      candidates.push(path.join(dir, 'codium'));
    }
  }

  if (IS_WINDOWS) {
    const userProfile = process.env.USERPROFILE || 'C:\\Users\\Default';
    candidates.push(
      path.join(userProfile, 'AppData', 'Local', 'Programs', 'Microsoft VS Code', 'Code.exe'),
      path.join(userProfile, 'AppData', 'Local', 'Programs', 'Microsoft VS Code', 'bin', 'code.cmd'),
      'C:\\Program Files\\Microsoft VS Code\\Code.exe',
      'C:\\Program Files\\Microsoft VS Code\\bin\\code.cmd',
      'C:\\Program Files (x86)\\Microsoft VS Code\\Code.exe',
      'C:\\Program Files (x86)\\Microsoft VS Code\\bin\\code.cmd'
    );
  } else {
    candidates.push(
      '/usr/bin/code',
      '/usr/local/bin/code',
      '/snap/bin/code',
      '/usr/bin/codium',
      '/usr/local/bin/codium'
    );
  }

  const existingCandidates = candidates.filter(candidate => candidate && fs.existsSync(candidate));
  return existingCandidates.find(candidate => candidate.toLowerCase().endsWith('code.cmd'))
    || existingCandidates[0]
    || '';
}

function runVSCodeInstall(installerPath, vsixPath) {
  return new Promise((resolve, reject) => {
    const args = ['--install-extension', vsixPath, '--force'];
    const invocation = wrapWindowsCmd(installerPath, args);
    const proc = spawn(invocation.command, invocation.args, { windowsHide: true });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', data => { stdout += data.toString(); });
    proc.stderr.on('data', data => { stderr += data.toString(); });
    proc.on('close', code => {
      if (code === 0) {
        resolve([stdout.trim(), stderr.trim()].filter(Boolean).join('\n'));
      } else {
        reject(new Error(`VS Code extension install failed with exit code ${code}.\n${[stdout, stderr].filter(Boolean).join('\n')}`.trim()));
      }
    });
    proc.on('error', reject);
  });
}

function wrapWindowsCmd(command, args) {
  if (IS_WINDOWS && command.toLowerCase().endsWith('.cmd')) {
    return {
      command: process.env.ComSpec || process.env.COMSPEC || 'C:\\Windows\\System32\\cmd.exe',
      args: ['/d', '/s', '/c', command, ...args]
    };
  }
  return { command, args };
}

function deriveVSCodeCliPath(ideExecutablePath) {
  const normalized = String(ideExecutablePath || '');
  if (IS_WINDOWS) {
    if (!normalized.toLowerCase().endsWith('code.exe')) return '';
    const candidate = path.join(path.dirname(normalized), 'bin', 'code.cmd');
    return fs.existsSync(candidate) ? candidate : '';
  }
  const basename = path.basename(normalized);
  if (basename === 'code' || basename === 'codium') return normalized;
  for (const candidate of [
    path.join(path.dirname(normalized), 'bin', 'code'),
    path.join(path.dirname(normalized), 'bin', 'codium')
  ]) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return '';
}

function quotePowerShellArg(value) {
  const text = String(value || '');
  return `'${text.replace(/'/g, "''")}'`;
}

function copyFolderSync(from, to) {
  if (!fs.existsSync(to)) {
    fs.mkdirSync(to, { recursive: true });
  }

  for (const element of fs.readdirSync(from)) {
    if (['node_modules', '.git', '.vscode-test'].includes(element)) continue;
    const fromPath = path.join(from, element);
    const toPath = path.join(to, element);
    if (fs.statSync(fromPath).isDirectory()) {
      copyFolderSync(fromPath, toPath);
    } else {
      fs.copyFileSync(fromPath, toPath);
    }
  }
}

function removeFolderInside(baseDir, targetDir) {
  const resolvedBase = path.resolve(baseDir);
  const resolvedTarget = path.resolve(targetDir);
  if (!resolvedTarget.startsWith(`${resolvedBase}${path.sep}`)) {
    throw new Error(`Refusing to remove path outside extension directory: ${resolvedTarget}`);
  }
  fs.rmSync(resolvedTarget, { recursive: true, force: true });
}

function findNodeExecutable() {
  const bundledNode = IS_WINDOWS
    ? path.join(NODE_RUNTIME_BIN_DIR, 'node.exe')
    : path.join(NODE_RUNTIME_BIN_DIR, 'node');
  if (fs.existsSync(bundledNode)) return bundledNode;
  if (process.execPath && fs.existsSync(process.execPath)) return process.execPath;
  return 'node';
}

function getVSCodeExtensionsBaseDir() {
  if (IS_WINDOWS) {
    const userProfile = process.env.USERPROFILE || 'C:\\Users\\Default';
    return path.join(userProfile, '.vscode', 'extensions');
  }
  const home = process.env.HOME || process.env.USERPROFILE || '';
  return path.join(home, '.vscode', 'extensions');
}
