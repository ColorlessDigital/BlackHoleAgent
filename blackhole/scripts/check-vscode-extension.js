import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');
const BLACKHOLE_ROOT = path.dirname(PROJECT_ROOT);
const EXTENSION_ROOT = path.join(BLACKHOLE_ROOT, 'vscode-blackhole');

function findNodeExecutable() {
  const bundledNode = path.join(BLACKHOLE_ROOT, 'node-v24.22.2-win-x64', 'node.exe');
  if (fs.existsSync(bundledNode)) return bundledNode;
  const linuxBundledNode = path.join(BLACKHOLE_ROOT, `node-v24.22.2-${process.platform}-${process.arch}`, 'bin', 'node');
  if (fs.existsSync(linuxBundledNode)) return linuxBundledNode;
  const resourceNode = process.platform === 'win32'
    ? path.join(PROJECT_ROOT, 'resources', 'node-runtime', 'current', 'node.exe')
    : path.join(PROJECT_ROOT, 'resources', 'node-runtime', 'current', 'bin', 'node');
  if (fs.existsSync(resourceNode)) return resourceNode;
  return process.execPath;
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

try {
  const packagePath = path.join(EXTENSION_ROOT, 'package.json');
  const sourcePath = path.join(EXTENSION_ROOT, 'src', 'extension.ts');
  const outputPath = path.join(EXTENSION_ROOT, 'out', 'extension.js');
  const tscPath = path.join(EXTENSION_ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
  const nodeExe = findNodeExecutable();

  assert(fs.existsSync(packagePath), `Missing VS Code extension package.json: ${packagePath}`);
  assert(fs.existsSync(sourcePath), `Missing VS Code extension source: ${sourcePath}`);
  assert(fs.existsSync(tscPath), `Missing TypeScript compiler: ${tscPath}`);

  const manifest = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
  const commands = new Set((manifest.contributes?.commands || []).map(command => command.command));
  const requiredCommands = [
    'blackhole.focusChat',
    'blackhole.connect',
    'blackhole.setWorkspace',
    'blackhole.addToContext',
    'blackhole.askAboutSelection',
    'blackhole.resumeLatest',
    'blackhole.explainSelection',
    'blackhole.inlineEdit',
    'blackhole.fixDiagnostics',
    'blackhole.generateCompletion',
    'blackhole.reviewAgentDiffs',
    'blackhole.acceptDiffTransaction',
    'blackhole.rejectDiffTransaction',
    'blackhole.rollbackDiffTransaction',
    'blackhole.runAgentTask',
    'blackhole.runAgentTaskWithSelection'
  ];
  for (const command of requiredCommands) {
    assert(commands.has(command), `Missing contributed command: ${command}`);
  }
  assert(manifest.contributes?.views?.['blackhole-explorer']?.some(view => view.id === 'blackhole.sidebar'), 'Missing BlackHole sidebar view contribution.');
  assert(manifest.contributes?.configuration?.properties?.['blackhole.apiBaseUrl'], 'Missing blackhole.apiBaseUrl configuration.');

  const compile = spawnSync(nodeExe, [tscPath, '-p', './'], {
    cwd: EXTENSION_ROOT,
    stdio: 'inherit',
    windowsHide: true
  });
  assert(compile.status === 0, `VS Code extension TypeScript compile failed with exit code ${compile.status}.`);
  assert(fs.existsSync(outputPath), `Missing compiled extension output: ${outputPath}`);

  const syntax = spawnSync(nodeExe, ['--check', outputPath], {
    cwd: EXTENSION_ROOT,
    stdio: 'inherit',
    windowsHide: true
  });
  assert(syntax.status === 0, `Compiled extension syntax check failed with exit code ${syntax.status}.`);

  console.log(JSON.stringify({
    ok: true,
    extensionRoot: EXTENSION_ROOT,
    outputPath,
    commands: requiredCommands.length
  }, null, 2));
} catch (error) {
  console.error(JSON.stringify({
    ok: false,
    extensionRoot: EXTENSION_ROOT,
    error: error.message
  }, null, 2));
  process.exitCode = 1;
}
