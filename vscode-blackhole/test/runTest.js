const fs = require('fs');
const os = require('os');
const path = require('path');
const { runTests } = require('@vscode/test-electron');

async function main() {
  const extensionDevelopmentPath = path.resolve(__dirname, '..');
  const extensionTestsPath = path.resolve(__dirname, 'suite', 'index.js');
  const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'blackhole-vscode-e2e-'));
  const workspacePath = path.join(testRoot, 'workspace');

  fs.mkdirSync(path.join(workspacePath, 'src'), { recursive: true });
  fs.writeFileSync(
    path.join(workspacePath, 'src', 'sample.js'),
    'export function add(a, b) {\n  return a + b;\n}\n',
    'utf8'
  );

  try {
    await runTests({
      extensionDevelopmentPath,
      extensionTestsPath,
      launchArgs: [
        workspacePath,
        `--user-data-dir=${path.join(testRoot, 'user-data')}`,
        `--extensions-dir=${path.join(testRoot, 'extensions')}`,
        '--disable-workspace-trust',
        '--skip-welcome',
        '--skip-release-notes'
      ]
    });
  } finally {
    const resolved = fs.realpathSync(testRoot);
    if (!resolved.toLowerCase().startsWith(path.resolve(os.tmpdir(), 'blackhole-vscode-e2e-').toLowerCase())) throw new Error('Unsafe test cleanup path.');
    fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
