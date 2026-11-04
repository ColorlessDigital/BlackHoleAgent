import { spawnSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');
const NODE_EXE = process.execPath;
const args = new Set(process.argv.slice(2));
const full = args.has('--full');
const withVsix = !args.has('--skip-vsix');
const startedAt = Date.now();

const steps = [];

runStep('backend-syntax', [path.join(PROJECT_ROOT, 'scripts', 'check-backend.js')]);
runStep('release-metadata-tests', ['--test', 'scripts/release-metadata.test.js']);
runStep('pr-diff-check', [
  path.join(PROJECT_ROOT, 'scripts', 'pr-diff-check.js'),
  '--format=all',
  `--output-dir=${path.join(PROJECT_ROOT, 'data', 'pr-checks', 'latest')}`
]);
runStep('workspace-rules', [path.join(PROJECT_ROOT, 'scripts', 'check-workspace-rules.js')]);
const frontendRoot = path.join(PROJECT_ROOT, 'frontend');
runStep('frontend-typecheck', [path.join(frontendRoot, 'node_modules/typescript/bin/tsc'), '--noEmit'], frontendRoot);
runStep('frontend-lint', [path.join(frontendRoot, 'node_modules/eslint/bin/eslint.js'), '.'], frontendRoot);
runStep('frontend-unit-tests', ['--import', 'tsx', '--test', 'src/api/sse.test.ts'], frontendRoot);
// P2-9: keep in sync with package.json "test" (was missing 8 files).
runStep('backend-unit-tests', [
  '--test',
  'src/agent/toolParser.test.js',
  'src/agent/orchestrator.test.js',
  'src/agent/contextGuard.test.js',
  'src/agent/contextCompactor.test.js',
  'src/agent/core/stateMachine.test.js',
  'src/agent/core/phaseGuards.test.js',
  'src/agent/core/contextEngine.test.js',
  'src/agent/core/astPackaging.test.js',
  'src/agent/core/policyEngine.test.js',
  'src/config/configStore.test.js',
  'src/config/secretStore.test.js',
  'src/config/keychain.test.js',
  'src/config/workspaceConfig.test.js',
  'src/workspace/fileBroker.test.js',
  'src/workspace/terminalBroker.test.js',
  'src/web/webService.test.js',
  'src/mcp/mcpConfig.test.js',
  'src/mcp/mcpClient.test.js',
  'src/ide/autocompleteEngine.test.js',
  'src/ci/prDiffCheck.test.js',
  'src/runtime/llamaCppRuntime.test.js',
  'src/runtime/runtimeRouter.test.js',
  'src/runtime/openaiCompatRuntime.test.js',
  'src/runtime/usageTracker.test.js',
  'src/server/auth.test.js',
  'src/rag/worker.test.js'
]);
runStep('autocomplete-benchmark', [
  path.join(PROJECT_ROOT, 'scripts', 'autocomplete-benchmark.js'),
  `--max-cases=${full ? 12 : 6}`
]);
runStep('real-repo-eval-summary', [
  path.join(PROJECT_ROOT, 'scripts', 'real-repo-eval.js'),
  '--summary-only',
  '--max-repos=12'
]);
runStep('e2e-corpus-shape', [path.join(PROJECT_ROOT, 'scripts', 'check-e2e-corpus.js')]);
runStep('agent-e2e-solve-rate', [
  path.join(PROJECT_ROOT, 'scripts', 'agent-e2e-eval.js'),
  '--keep-going',
  '--record',
  `--max-cases=${full ? 50 : 12}`
]);
runStep('vscode-extension-bridge', [path.join(PROJECT_ROOT, 'scripts', 'check-vscode-extension.js')]);
if (withVsix) {
  runStep('vscode-vsix-package', [path.join(PROJECT_ROOT, 'scripts', 'package-vscode-extension.js')]);
}

const payload = {
  ok: steps.every(step => step.ok),
  mode: full ? 'full' : 'quick',
  durationMs: Date.now() - startedAt,
  steps
};

console.log(JSON.stringify(payload, null, 2));
if (!payload.ok) process.exitCode = 1;

function runStep(name, nodeArgs, cwd = PROJECT_ROOT) {
  const started = Date.now();
  const result = spawnSync(NODE_EXE, nodeArgs, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 20
  });
  const output = `${result.stdout || ''}${result.stderr || ''}`.trim();
  steps.push({
    name,
    ok: result.status === 0,
    exitCode: result.status,
    durationMs: Date.now() - started,
    summary: summarizeOutput(output),
    outputPreview: output.slice(-3000)
  });
}

function summarizeOutput(output) {
  if (!output) return '';
  const jsonStart = output.indexOf('{');
  const jsonEnd = output.lastIndexOf('}');
  if (jsonStart >= 0 && jsonEnd > jsonStart) {
    try {
      const parsed = JSON.parse(output.slice(jsonStart, jsonEnd + 1));
      if (parsed.solveRate !== undefined) {
        return `solveRate=${parsed.solveRate} passed=${parsed.passed}/${parsed.total}`;
      }
      if (parsed.passAt1 !== undefined) {
        return `passAt1=${parsed.passAt1} passed=${parsed.passed}/${parsed.total}`;
      }
      if (parsed.summary?.errors !== undefined) {
        return `errors=${parsed.summary.errors} warnings=${parsed.summary.warnings}`;
      }
      if (parsed.fixtureSet?.repos !== undefined) {
        return `fixtures=${parsed.fixtureSet.preparedRepos}/${parsed.fixtureSet.selectedRepos} prepared`;
      }
      if (parsed.cases !== undefined) {
        return `cases=${parsed.cases} ok=${parsed.ok}`;
      }
      if (parsed.outputPath) {
        return parsed.outputPath;
      }
      return `ok=${parsed.ok}`;
    } catch {
      // Fall through to textual summary.
    }
  }
  return output.split(/\r?\n/).filter(Boolean).slice(-3).join(' | ');
}
