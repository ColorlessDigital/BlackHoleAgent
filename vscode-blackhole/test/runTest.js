const fs = require('fs');
const os = require('os');
const path = require('path');
const { runTests } = require('@vscode/test-electron');

async function main() {
  const extensionDevelopmentPath = path.resolve(__dirname, '..');
  const extensionTestsPath = path.resolve(__dirname, 'suite', 'index.js');
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'blackhole-vscode-e2e-'));

  fs.mkdirSync(path.join(workspacePath, 'src'), { recursive: true });
  fs.writeFileSync(
    path.join(workspacePath, 'src', 'sample.js'),
    'export function add(a, b) {\n  return a + b;\n}\n',
    'utf8'
  );

  await runTests({
    extensionDevelopmentPath,
    extensionTestsPath,
    launchArgs: [
      workspacePath,
      '--disable-workspace-trust',
      '--skip-welcome',
      '--skip-release-notes'
    ]
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
