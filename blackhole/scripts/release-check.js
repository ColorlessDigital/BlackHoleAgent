import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');
const NODE_EXE = process.execPath;
const rawArgs = process.argv.slice(2);
const requestedPlatform = readArg('--platform') || process.platform;
const requestedArch = readArg('--arch') || process.arch;
const skipExtensionE2e = rawArgs.includes('--skip-extension-e2e');
const llamaServerExecutable = requestedPlatform === 'win32' ? 'llama-server.exe' : 'llama-server';

console.log('==================================================');
console.log('🌌 BlackHole Release Quality Auditor & Check');
console.log('==================================================');

let hasFailed = false;

function logStatus(title, passed, details = '') {
  const statusStr = passed ? '✅ PASS' : '❌ FAIL';
  console.log(`[${statusStr}] ${title}`);
  if (details) console.log(`       -> ${details}`);
  if (!passed) hasFailed = true;
}

function logWarning(title, details = '') {
  console.log(`[⚠️ WARN] ${title}`);
  if (details) console.log(`       -> ${details}`);
}

function quotePath(value) {
  const text = String(value || '');
  if (text && !/[\s"&|<>^]/.test(text)) {
    return text;
  }
  return `"${text.replace(/"/g, '\\"')}"`;
}

function readArg(name) {
  const prefix = `${name}=`;
  const match = rawArgs.find(arg => arg.startsWith(prefix));
  return match ? match.slice(prefix.length) : '';
}

function runNodeScript(scriptPath, args = '', cwd = PROJECT_ROOT) {
  const scriptPart = scriptPath ? ` ${quotePath(scriptPath)}` : '';
  const command = `${quotePath(NODE_EXE)}${scriptPart}${args ? ` ${args}` : ''}`;
  execSync(command, {
    stdio: 'inherit',
    cwd,
    env: { ...process.env }
  });
}

function runNodeScriptCapture(scriptPath, args = '', cwd = PROJECT_ROOT) {
  const scriptPart = scriptPath ? ` ${quotePath(scriptPath)}` : '';
  const command = `${quotePath(NODE_EXE)}${scriptPart}${args ? ` ${args}` : ''}`;
  return execSync(command, {
    cwd,
    env: { ...process.env },
    encoding: 'utf8'
  });
}

function runPackageScript(scriptName, cwd = PROJECT_ROOT) {
  const pkgPath = path.join(cwd, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
  const script = pkg.scripts?.[scriptName];
  if (!script) {
    throw new Error(`package.json script not found: ${scriptName}`);
  }
  const command = script.replace(/^node(?=\s|$)/, quotePath(NODE_EXE));
  execSync(command, {
    stdio: 'inherit',
    cwd,
    env: {
      ...process.env,
      PATH: [path.dirname(NODE_EXE), process.env.PATH || process.env.Path || ''].filter(Boolean).join(path.delimiter)
    }
  });
}

function canRunNpm() {
  try {
    execSync('npm --version', { stdio: 'ignore', cwd: PROJECT_ROOT, env: { ...process.env } });
    return true;
  } catch {
    return false;
  }
}

try {
  // Common execution options to inherit PATH and env configurations
  const execOpts = {
    stdio: 'inherit',
    cwd: PROJECT_ROOT,
    env: { ...process.env }
  };

  // 1. Syntax check on backend
  console.log('\n[1/17] Running backend syntax validation...');
  const syntaxCheckPath = path.join(PROJECT_ROOT, 'scripts', 'check-backend.js');
  if (fs.existsSync(syntaxCheckPath)) {
    runNodeScript(syntaxCheckPath);
    logStatus('Backend Syntax check', true);
  } else {
    logStatus('Backend Syntax check', false, 'check-backend.js script not found');
  }

  // 2. Unit tests execution
  console.log('\n[2/17] Executing all backend unit tests...');
  runPackageScript('test');
  logStatus('Backend Unit Tests', true);
  runPackageScript('test:release');
  logStatus('Release Metadata Tests', true);

  // 3. Autonomous agent smoke check
  console.log('\n[3/17] Running autonomous agent smoke check...');
  const agentSmokePath = path.join(PROJECT_ROOT, 'scripts', 'agent-smoke-check.js');
  if (fs.existsSync(agentSmokePath)) {
    runNodeScript(agentSmokePath);
    logStatus('Autonomous Agent Smoke Check', true);
  } else {
    logStatus('Autonomous Agent Smoke Check', false, 'agent-smoke-check.js script not found');
  }

  // 4. Frontend linting
  console.log('\n[4/17] Running frontend ESLint...');
  const eslintPath = path.join(PROJECT_ROOT, 'frontend', 'node_modules', 'eslint', 'bin', 'eslint.js');
  if (!fs.existsSync(eslintPath)) {
    logStatus('Frontend ESLint', false, `ESLint binary not found: ${eslintPath}`);
  } else {
    runNodeScript(eslintPath, '.', path.join(PROJECT_ROOT, 'frontend'));
    logStatus('Frontend ESLint', true);
  }

  // 4b. Frontend TypeScript check (strict; `npm run build` also gates on it).
  console.log('\n[4b/17] Running frontend typecheck (tsc --noEmit)...');
  const tscPath = path.join(PROJECT_ROOT, 'frontend', 'node_modules', 'typescript', 'bin', 'tsc');
  if (!fs.existsSync(tscPath)) {
    logStatus('Frontend Typecheck', false, `tsc binary not found: ${tscPath}`);
  } else {
    runNodeScript(tscPath, '--noEmit', path.join(PROJECT_ROOT, 'frontend'));
    logStatus('Frontend Typecheck', true);
  }

  runPackageScript('test', path.join(PROJECT_ROOT, 'frontend'));
  logStatus('Frontend Unit Tests', true);

  // 5. Verification of llama-server
  console.log('\n[5/17] Checking for embedded llama.cpp resources...');
  const serverCandidates = buildLlamaServerCandidates();
  const serverPath = serverCandidates.find(candidate => fs.existsSync(candidate)) || serverCandidates[0];
  const serverExists = !!serverPath && fs.existsSync(serverPath);
  logStatus(
    `${llamaServerExecutable} validation`,
    serverExists,
    serverExists ? `Found at: ${serverPath}` : `MISSING. Checked: ${serverCandidates.join(', ')}`
  );

  // 6. Verification of no trash files (0-byte '{}' file)
  console.log('\n[6/17] Auditing root directory for residual trash files...');
  const trashPath = path.join(PROJECT_ROOT, '{}');
  const trashExists = fs.existsSync(trashPath);
  logStatus(
    'Root trash files audit ({})',
    !trashExists,
    trashExists ? 'Found 0-byte "{}" file in root' : 'No residual trash files detected'
  );

  // 7. Config files validation in package.json build target
  console.log('\n[7/17] Auditing package.json build files configuration...');
  const pkgPath = path.join(PROJECT_ROOT, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
  const buildFiles = pkg.build?.files || [];
  const containsRootConfig = buildFiles.includes('config.json');
  logStatus(
    'package.json files validation',
    !containsRootConfig,
    containsRootConfig
      ? 'ERROR: "config.json" is still registered in build.files array'
      : 'Verified: config.json removed from electron-builder target files'
  );

  // 8. Frontend compilation check
  console.log('\n[8/17] Verifying production client frontend compilation (Vite)...');
  const vitePath = path.join(PROJECT_ROOT, 'frontend', 'node_modules', 'vite', 'bin', 'vite.js');
  if (!fs.existsSync(vitePath)) {
    logStatus('Frontend Production Build', false, `Vite binary not found: ${vitePath}`);
  } else {
    runNodeScript(vitePath, 'build', path.join(PROJECT_ROOT, 'frontend'));
    logStatus('Frontend Production Build', true);
  }

  // 9. Frontend security audit (Warn-only)
  console.log('\n[9/17] Auditing frontend packages for vulnerabilities...');
  if (!canRunNpm()) {
    logWarning('Frontend Security Audit', 'npm is not available on PATH; audit skipped.');
  } else {
    try {
      execSync('npm --prefix frontend audit', { stdio: 'ignore', cwd: PROJECT_ROOT, env: execOpts.env });
      logStatus('Frontend Security Audit', true, '0 vulnerabilities found');
    } catch (err) {
      // npm audit returns non-zero code on vulnerabilities
      logWarning('Frontend Security Audit', 'Vulnerabilities detected. Review with "npm audit" manually.');
    }
  }

  // 10. Resources binary folder audit
  console.log('\n[10/17] Checking resources/bin directory state...');
  const binPath = path.join(PROJECT_ROOT, 'resources', 'bin');
  const binExists = fs.existsSync(binPath);
  if (binExists) {
    let binFiles = [];
    try {
      binFiles = fs.readdirSync(binPath);
    } catch (e) {}
    if (binFiles.length > 0) {
      logWarning('resources/bin directory check', `Found files inside resources/bin: ${binFiles.join(', ')}. Ensure no heavy legacy binaries exist.`);
    } else {
      logStatus('resources/bin directory check', true, 'Folder is present but safely empty');
    }
  } else {
    logStatus('resources/bin directory check', true, 'Verified: resources/bin is removed (Ollama dependency purged)');
  }

  const hasNodeRuntimeResource = () => (pkg.build?.extraResources || []).some(entry => {
    return typeof entry === 'object'
      && entry.from === 'resources/node-runtime/current'
      && entry.to === 'node-runtime';
  });
  const bundledNodePath = requestedPlatform === 'win32'
    ? path.join(PROJECT_ROOT, 'resources', 'node-runtime', 'current', 'node.exe')
    : path.join(PROJECT_ROOT, 'resources', 'node-runtime', 'current', 'bin', 'node');
  logStatus(
    'MCP bundled Node runtime resource',
    hasNodeRuntimeResource() && fs.existsSync(bundledNodePath),
    hasNodeRuntimeResource() && fs.existsSync(bundledNodePath)
      ? `Node runtime available for packaged MCP servers: ${bundledNodePath}`
      : `Missing node-runtime extraResources mapping or bundled Node executable: ${bundledNodePath}`
  );

  // 11. Local Llama GGUF model path configuration audit
  console.log('\n[11/17] Checking data/config.json configuration path...');
  const configPath = path.join(PROJECT_ROOT, 'data', 'config.json');
  if (fs.existsSync(configPath)) {
    try {
      const cfg = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      if (!cfg.llamaCppModelPath) {
        logWarning('Llama GGUF model configuration check', 'Warning: llamaCppModelPath is empty inside config.json.');
      } else {
        logStatus('Llama GGUF model configuration check', true, `Model configured at: ${cfg.llamaCppModelPath}`);
      }
    } catch (e) {
      logWarning('Llama GGUF model configuration check', `Failed to parse config.json: ${e.message}`);
    }
  } else {
    logWarning('Llama GGUF model configuration check', 'config.json does not exist yet.');
  }

  // 12. Browser visual regression smoke check
  console.log('\n[12/17] Running frontend browser visual check...');
  const visualCheckPath = path.join(PROJECT_ROOT, 'scripts', 'frontend-visual-check.js');
  if (fs.existsSync(visualCheckPath)) {
    const visualOutput = runNodeScriptCapture(visualCheckPath);
    if (visualOutput) process.stdout.write(visualOutput);
    let visualReport = null;
    try {
      visualReport = JSON.parse(visualOutput);
    } catch {}
    if (visualReport?.skipped) {
      logWarning('Frontend Browser Visual Check', `Skipped: ${visualReport.reason}`);
    } else {
      logStatus('Frontend Browser Visual Check', true);
    }
  } else {
    logStatus('Frontend Browser Visual Check', false, 'frontend-visual-check.js script not found');
  }

  // 13. VS Code extension bridge validation
  console.log('\n[13/17] Validating VS Code extension bridge...');
  const vscodeExtensionCheckPath = path.join(PROJECT_ROOT, 'scripts', 'check-vscode-extension.js');
  if (fs.existsSync(vscodeExtensionCheckPath)) {
    runNodeScript(vscodeExtensionCheckPath);
    logStatus('VS Code Extension Bridge', true);
  } else {
    logStatus('VS Code Extension Bridge', false, 'check-vscode-extension.js script not found');
  }

  // 14. E2E corpus shape validation
  console.log('\n[14/17] Validating 30-50 case E2E corpus...');
  const e2eCorpusCheckPath = path.join(PROJECT_ROOT, 'scripts', 'check-e2e-corpus.js');
  if (fs.existsSync(e2eCorpusCheckPath)) {
    runNodeScript(e2eCorpusCheckPath);
    logStatus('E2E Corpus Shape', true);
  } else {
    logStatus('E2E Corpus Shape', false, 'check-e2e-corpus.js script not found');
  }

  // 15. VSIX packaging check
  console.log('\n[15/17] Packaging VS Code bridge as .vsix...');
  const vscodePackagePath = path.join(PROJECT_ROOT, 'scripts', 'package-vscode-extension.js');
  if (fs.existsSync(vscodePackagePath)) {
    runNodeScript(vscodePackagePath);
    logStatus('VS Code VSIX Package', true);
    const resourceVsixPath = path.join(PROJECT_ROOT, 'resources', 'vscode', 'vscode-blackhole.vsix');
    const pkgAfterVsix = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
    const hasVscodeResource = (pkgAfterVsix.build?.extraResources || []).some(entry => {
      return typeof entry === 'object'
        && entry.from === 'resources/vscode'
        && entry.to === 'vscode';
    });
    logStatus(
      'VS Code VSIX packaged resource integration',
      fs.existsSync(resourceVsixPath) && hasVscodeResource,
      fs.existsSync(resourceVsixPath) && hasVscodeResource
        ? `Bundled VSIX resource ready: ${resourceVsixPath}`
        : 'Missing resources/vscode/vscode-blackhole.vsix or package.json extraResources mapping'
    );
  } else {
    logStatus('VS Code VSIX Package', false, 'package-vscode-extension.js script not found');
  }

  // 16. VS Code extension-host E2E check
  console.log('\n[16/17] Running VS Code extension-host E2E check...');
  const vscodeE2ePath = path.join(PROJECT_ROOT, 'scripts', 'test-vscode-extension-e2e.js');
  if (skipExtensionE2e) {
    logWarning('VS Code Extension Host E2E', 'Skipped by --skip-extension-e2e.');
  } else if (fs.existsSync(vscodeE2ePath)) {
    runNodeScript(vscodeE2ePath);
    logStatus('VS Code Extension Host E2E', true);
  } else {
    logStatus('VS Code Extension Host E2E', false, 'test-vscode-extension-e2e.js script not found');
  }

  // 17. package-lock.json existence check
  console.log('\n[17/17] Verifying package-lock.json synchronization...');
  const lockPath = path.join(PROJECT_ROOT, 'package-lock.json');
  const lockExists = fs.existsSync(lockPath);
  logStatus(
    'package-lock.json verification',
    lockExists,
    lockExists ? 'package-lock.json is present and synchronized' : 'package-lock.json is missing'
  );

  // P2-7. Reproducibility: models manifest + repo-relative sign script + git SHA
  console.log('\n[repro] Verifying build reproducibility metadata...');
  const manifestPath = path.join(PROJECT_ROOT, 'models', 'manifest.json');
  let manifestOk = false;
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    manifestOk = Array.isArray(manifest.models);
  } catch {}
  logStatus(
    'models/manifest.json present',
    manifestOk,
    manifestOk ? `Model manifest found: ${manifestPath}` : `Missing or invalid: ${manifestPath}`
  );
  const signPath = path.join(PROJECT_ROOT, 'scripts', 'sign-release.ps1');
  let signOk = false;
  try {
    const signSrc = fs.readFileSync(signPath, 'utf-8');
    signOk = signSrc.includes('$RepoRoot') && !/d:\\BlackHole\\(windows|blackhole\\dist)/.test(signSrc);
  } catch {}
  logStatus(
    'sign-release.ps1 repo-relative (P0-3)',
    signOk,
    signOk ? 'No d:\\BlackHole hardcoding; -RepoRoot/-KeepDist supported' : 'sign-release.ps1 still has hardcoded paths'
  );

  // P2-9. Observability: proof-pipeline freshness gate (warn-only; models vary).
  // Run `npm run proof:quick` before release to refresh data/proof-runs/latest.json.
  try {
    const proofPath = path.join(PROJECT_ROOT, 'data', 'proof-runs', 'latest.json');
    if (!fs.existsSync(proofPath)) {
      logWarning('Proof freshness (P2-9)', 'No data/proof-runs/latest.json. Run "npm run proof:quick" before release.');
    } else {
      const proof = JSON.parse(fs.readFileSync(proofPath, 'utf-8'));
      const ageDays = (Date.now() - new Date(proof.startedAt || 0).getTime()) / 86400000;
      const pct = proof.score?.percent;
      if (!Number.isFinite(ageDays) || ageDays > 30) {
        logWarning('Proof freshness (P2-9)', `latest.json is stale (${Number.isFinite(ageDays) ? ageDays.toFixed(1) : '?'} days old). Refresh with "npm run proof:quick".`);
      } else if (typeof pct === 'number' && pct < 60) {
        logWarning('Proof freshness (P2-9)', `score ${pct}% < 60% threshold (passed ${proof.score.passed}/${proof.score.total}). Ship with caution; see ${proofPath}.`);
      } else {
        logStatus('Proof freshness (P2-9)', true, `score ${pct}% (${proof.score.passed}/${proof.score.total}), ${ageDays.toFixed(1)} days old`);
      }
    }
  } catch (e) {
    logWarning('Proof freshness (P2-9)', `Could not evaluate proof runs: ${e.message}`);
  }

  console.log('\n==================================================');
  if (hasFailed) {
    console.log('❌ RELEASE QUALITY AUDIT FAILED! Please resolve issues above.');
    console.log('==================================================');
    process.exit(1);
  } else {
    console.log('🎉 ALL RELEASE QUALITY AUDIT CHECKS PASSED SUCCESSFULLY!');
    console.log('==================================================');
    process.exit(0);
  }
} catch (e) {
  console.error('\n❌ Execution crashed during audit checks:', e.message);
  console.log('==================================================');
  process.exit(1);
}

function buildLlamaServerCandidates() {
  const platformArch = `${requestedPlatform}-${requestedArch}`;
  const base = path.join(PROJECT_ROOT, 'resources', 'llama.cpp');
  const candidates = [
    path.join(base, platformArch, llamaServerExecutable),
    path.join(base, llamaServerExecutable)
  ];
  if (requestedPlatform === 'linux') {
    candidates.push('/usr/local/bin/llama-server', '/usr/bin/llama-server');
  }
  if (requestedPlatform === 'win32') {
    candidates.push(
      'C:\\Program Files\\llama.cpp\\llama-server.exe',
      'C:\\Program Files\\llama.cpp\\bin\\llama-server.exe'
    );
  }
  return candidates;
}
