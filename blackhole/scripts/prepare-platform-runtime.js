import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');
const BLACKHOLE_ROOT = path.dirname(PROJECT_ROOT);
const rawArgs = process.argv.slice(2);
const platform = readArg('--platform') || process.platform;
const arch = readArg('--arch') || process.arch;
const runtimeRoot = path.join(PROJECT_ROOT, 'resources', 'node-runtime');
const targetRoot = path.join(runtimeRoot, 'current');

try {
  const sourceRoot = findRuntimeSource();
  const nodePath = getNodePath(sourceRoot);
  if (!fs.existsSync(nodePath)) {
    throw new Error(`Node executable not found in runtime source: ${nodePath}`);
  }

  if (path.resolve(sourceRoot) !== path.resolve(targetRoot)) {
    removeCurrentRuntime();
    fs.mkdirSync(path.dirname(targetRoot), { recursive: true });
    copyRuntimeSubset(sourceRoot, targetRoot);
  }

  fs.writeFileSync(
    path.join(targetRoot, '.blackhole-runtime.json'),
    JSON.stringify({
      platform,
      arch,
      sourceRoot,
      preparedAt: new Date().toISOString()
    }, null, 2),
    'utf8'
  );

  console.log(JSON.stringify({
    ok: true,
    platform,
    arch,
    sourceRoot,
    targetRoot,
    nodePath: getNodePath(targetRoot)
  }, null, 2));
} catch (error) {
  console.error(JSON.stringify({
    ok: false,
    platform,
    arch,
    targetRoot,
    error: error.message,
    hint: platform === 'linux'
      ? 'Run scripts/setup-kali-runtime.sh on Kali Linux to download Node and build llama.cpp first.'
      : 'Download Node 24.21.0 into the repository parent or resources/node-runtime/win32-x64.'
  }, null, 2));
  process.exit(1);
}

function readArg(name) {
  const prefix = `${name}=`;
  const match = rawArgs.find(arg => arg.startsWith(prefix));
  return match ? match.slice(prefix.length) : '';
}

function findRuntimeSource() {
  const candidates = buildRuntimeCandidates();
  const match = candidates.find(candidate => fs.existsSync(getNodePath(candidate)));
  if (!match) {
    throw new Error(`No ${platform}-${arch} Node runtime source found. Checked: ${candidates.join(', ')}`);
  }
  return match;
}

function buildRuntimeCandidates() {
  if (platform === 'win32') {
    return [
      path.join(BLACKHOLE_ROOT, `node-v24.21.0-win-${arch}`),
      path.join(runtimeRoot, `win32-${arch}`)
    ];
  }
  if (platform === 'linux') {
    return [
      path.join(runtimeRoot, `linux-${arch}`),
      path.join(BLACKHOLE_ROOT, `node-v24.21.0-linux-${arch}`)
    ];
  }
  if (platform === 'darwin') {
    return [
      path.join(runtimeRoot, `darwin-${arch}`),
      path.join(BLACKHOLE_ROOT, `node-v24.21.0-darwin-${arch}`)
    ];
  }
  return [path.join(runtimeRoot, `${platform}-${arch}`)];
}

function getNodePath(root) {
  return platform === 'win32'
    ? path.join(root, 'node.exe')
    : path.join(root, 'bin', 'node');
}

function copyRuntimeSubset(sourceRoot, targetRoot) {
  const entries = platform === 'win32'
    ? [
        'node.exe',
        'npm',
        'npm.cmd',
        'npx',
        'npx.cmd',
        'corepack',
        'corepack.cmd',
        'nodevars.bat',
        'LICENSE',
        'README.md',
        'CHANGELOG.md',
        path.join('node_modules', 'npm'),
        path.join('node_modules', 'corepack')
      ]
    : [
        path.join('bin', 'node'),
        path.join('bin', 'npm'),
        path.join('bin', 'npx'),
        path.join('bin', 'corepack'),
        'LICENSE',
        'README.md',
        'CHANGELOG.md',
        path.join('lib', 'node_modules', 'npm'),
        path.join('lib', 'node_modules', 'corepack')
      ];

  for (const relativePath of entries) {
    const source = path.join(sourceRoot, relativePath);
    if (!fs.existsSync(source)) continue;
    const target = path.join(targetRoot, relativePath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.cpSync(source, target, {
      recursive: true,
      force: true,
      dereference: false,
      verbatimSymlinks: true,
      errorOnExist: false
    });
  }
}

function removeCurrentRuntime() {
  const resolvedTarget = path.resolve(targetRoot);
  const resolvedAllowedRoot = path.resolve(runtimeRoot);
  if (resolvedTarget === resolvedAllowedRoot || !resolvedTarget.startsWith(`${resolvedAllowedRoot}${path.sep}`)) {
    throw new Error(`Refusing to remove unsafe runtime target: ${resolvedTarget}`);
  }
  fs.rmSync(resolvedTarget, { recursive: true, force: true });
}
