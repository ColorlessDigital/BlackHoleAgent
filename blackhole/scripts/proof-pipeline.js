#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { performance } from 'perf_hooks';
import { PROJECT_ROOT } from '../src/common/paths.js';

const args = parseArgs(process.argv.slice(2));
const startedAt = new Date().toISOString();
const started = performance.now();
const proofDir = path.join(PROJECT_ROOT, 'data', 'proof-runs');
const nodeRuntimePath = buildNodeRuntimePath();

const report = {
  ok: true,
  kind: 'blackhole-proof-pipeline',
  version: 1,
  startedAt,
  mode: args.quick ? 'quick' : 'full',
  environment: buildEnvironmentSummary(),
  dimensions: {},
  artifacts: [],
  recommendations: []
};

try {
  const models = discoverGgufModels(args.modelDir, args.maxModelsInventory);
  report.modelInventory = {
    modelDir: args.modelDir,
    totalGguf: models.length,
    selectedForRealEval: args.realModels ? models.slice(0, args.maxModels).map(compactModel) : [],
    models: models.slice(0, 24).map(compactModel)
  };

  report.dimensions.modelSolveRate = runModelSolveRate(models);
  report.dimensions.largeRepoDurability = runLargeRepoDurability();
  report.dimensions.ideUxCompleteness = runIdeUxCompleteness();
  report.dimensions.longRunStability = runLongRunStability();
  report.dimensions.feedbackLoop = buildFeedbackLoopProof();

  report.durationMs = Math.round(performance.now() - started);
  report.ok = Object.values(report.dimensions).every(dimension => dimension.ok !== false);
  report.score = scoreDimensions(report.dimensions);
  report.recommendations = buildRecommendations(report);

  if (args.record) {
    fs.mkdirSync(proofDir, { recursive: true });
    const stamp = startedAt.replace(/[:.]/g, '-');
    const recordPath = path.join(proofDir, `${stamp}-proof.json`);
    const markdownPath = path.join(proofDir, `${stamp}-proof.md`);
    fs.writeFileSync(recordPath, JSON.stringify(report, null, 2), 'utf8');
    fs.writeFileSync(markdownPath, renderMarkdown(report), 'utf8');
    fs.writeFileSync(path.join(proofDir, 'latest.json'), JSON.stringify({ ...report, recordPath, markdownPath }, null, 2), 'utf8');
    fs.writeFileSync(path.join(proofDir, 'latest.md'), renderMarkdown({ ...report, recordPath, markdownPath }), 'utf8');
    report.recordPath = recordPath;
    report.markdownPath = markdownPath;
    report.artifacts.push(recordPath, markdownPath, path.join(proofDir, 'latest.json'), path.join(proofDir, 'latest.md'));
  }
} catch (error) {
  report.ok = false;
  report.error = error instanceof Error ? error.message : String(error);
  report.durationMs = Math.round(performance.now() - started);
  process.exitCode = 1;
}

console.log(JSON.stringify(report, null, 2));

function parseArgs(values) {
  const parsed = {
    quick: true,
    record: true,
    realModels: false,
    prepareRepos: false,
    ideE2e: false,
    launchVisualStudio: false,
    modelDir: defaultModelDir(),
    maxModels: 1,
    maxModelsInventory: 64,
    maxCases: 12,
    realModelCases: 3,
    maxRepos: 12,
    maxIndexFiles: 2500,
    stressFiles: 700,
    stressTests: 6,
    soakMinutes: 0.25,
    localRepos: defaultLocalRepos()
  };

  for (const arg of values) {
    if (arg === '--full') parsed.quick = false;
    else if (arg === '--quick') parsed.quick = true;
    else if (arg === '--no-record') parsed.record = false;
    else if (arg === '--real-models') parsed.realModels = true;
    else if (arg === '--prepare-repos') parsed.prepareRepos = true;
    else if (arg === '--ide-e2e') parsed.ideE2e = true;
    else if (arg === '--launch-visual-studio') parsed.launchVisualStudio = true;
    else if (arg.startsWith('--model-dir=')) parsed.modelDir = path.resolve(arg.slice('--model-dir='.length));
    else if (arg.startsWith('--max-models=')) parsed.maxModels = positiveInt(arg, '--max-models=', parsed.maxModels);
    else if (arg.startsWith('--max-cases=')) parsed.maxCases = positiveInt(arg, '--max-cases=', parsed.maxCases);
    else if (arg.startsWith('--real-model-cases=')) parsed.realModelCases = positiveInt(arg, '--real-model-cases=', parsed.realModelCases);
    else if (arg.startsWith('--max-repos=')) parsed.maxRepos = positiveInt(arg, '--max-repos=', parsed.maxRepos);
    else if (arg.startsWith('--max-index-files=')) parsed.maxIndexFiles = positiveInt(arg, '--max-index-files=', parsed.maxIndexFiles);
    else if (arg.startsWith('--stress-files=')) parsed.stressFiles = positiveInt(arg, '--stress-files=', parsed.stressFiles);
    else if (arg.startsWith('--stress-tests=')) parsed.stressTests = positiveInt(arg, '--stress-tests=', parsed.stressTests);
    else if (arg.startsWith('--soak-minutes=')) parsed.soakMinutes = positiveNumber(arg, '--soak-minutes=', parsed.soakMinutes);
    else if (arg.startsWith('--local-repo=')) parsed.localRepos.push(path.resolve(arg.slice('--local-repo='.length)));
  }

  if (!parsed.quick) {
    parsed.maxCases = Math.max(parsed.maxCases, 50);
    parsed.stressFiles = Math.max(parsed.stressFiles, 1600);
    parsed.stressTests = Math.max(parsed.stressTests, 8);
    parsed.soakMinutes = Math.max(parsed.soakMinutes, 30);
  }

  return parsed;
}

function runModelSolveRate(models) {
  const deterministic = runNodeJson('agent-e2e-eval.js', [
    '--keep-going',
    '--record',
    `--max-cases=${args.maxCases}`
  ], { timeoutMs: 12 * 60 * 1000 });

  const realModelRuns = [];
  if (args.realModels) {
    const selected = models.slice(0, args.maxModels);
    for (const model of selected) {
      realModelRuns.push(runNodeJson('agent-e2e-eval.js', [
        '--real-model',
        '--keep-going',
        '--record',
        `--max-cases=${args.realModelCases}`,
        `--model=${model.path}`,
        `--server=${path.join(PROJECT_ROOT, 'resources', 'llama.cpp', 'llama-server.exe')}`
      ], { timeoutMs: 90 * 60 * 1000 }));
    }
  }

  const realSolveRates = realModelRuns
    .map(run => Number(run.json?.solveRate || 0))
    .filter(value => Number.isFinite(value));
  const historicalRealRecords = readRecordDir(path.join(PROJECT_ROOT, 'data', 'eval-runs'))
    .filter(record => record.mode === 'real-model');
  const historicalRealSolveRates = historicalRealRecords
    .map(record => Number(record.solveRate || 0))
    .filter(value => Number.isFinite(value));
  const bestRealSolveRate = realSolveRates.length ? Math.max(...realSolveRates) : 0;
  const bestHistoricalRealSolveRate = historicalRealSolveRates.length ? Math.max(...historicalRealSolveRates) : 0;
  const latestHistoricalReal = historicalRealRecords.at(0) || null;
  const deterministicSolveRate = Number(deterministic.json?.solveRate || 0);

  return {
    ok: deterministic.ok && (!args.realModels || realModelRuns.every(run => run.ok)),
    level: args.realModels || historicalRealRecords.length ? 'measured-real-models' : 'ready-for-real-models',
    summary: args.realModels
      ? `Measured ${realModelRuns.length} real GGUF model run(s).`
      : `Deterministic solve-rate proof ran; ${models.length} GGUF model(s) are available and ${historicalRealRecords.length} real-model record(s) exist.`,
    metrics: {
      deterministicSolveRate,
      bestRealSolveRate: Math.max(bestRealSolveRate, bestHistoricalRealSolveRate),
      latestHistoricalRealSolveRate: latestHistoricalReal?.solveRate || 0,
      evaluatedCases: deterministic.json?.total || 0,
      realModelRuns: realModelRuns.length,
      historicalRealModelRuns: historicalRealRecords.length,
      ggufModelsFound: models.length
    },
    deterministic,
    latestHistoricalReal: latestHistoricalReal ? compactEvalRecord(latestHistoricalReal) : null,
    realModelRuns: realModelRuns.map(compactCommandRun)
  };
}

function runLargeRepoDurability() {
  const localRepoScans = uniqueExistingPaths(args.localRepos).map(repoPath => scanLocalRepo(repoPath, args.maxIndexFiles));
  const stress = runNodeJson('code-intelligence-stress.js', [
    `--files=${args.stressFiles}`,
    `--tests=${args.stressTests}`
  ], { timeoutMs: 10 * 60 * 1000 });
  const realRepoArgs = [
    `--max-repos=${args.maxRepos}`,
    `--max-index-files=${args.maxIndexFiles}`
  ];
  if (args.prepareRepos) realRepoArgs.push('--prepare');
  else realRepoArgs.push('--summary-only', '--no-record');
  const realRepoSummary = runNodeJson('real-repo-eval.js', realRepoArgs, { timeoutMs: args.prepareRepos ? 45 * 60 * 1000 : 3 * 60 * 1000 });

  const largestScan = localRepoScans.reduce((max, scan) => Math.max(max, scan.filesIndexed || 0), 0);
  return {
    ok: stress.ok && realRepoSummary.ok && localRepoScans.length > 0,
    level: args.prepareRepos ? 'fixture-and-local-repos' : 'local-repos-plus-fixture-summary',
    summary: `Scanned ${localRepoScans.length} local repo(s), stress target ${args.stressFiles} files.`,
    metrics: {
      localRepos: localRepoScans.length,
      largestLocalFileSample: largestScan,
      stressScanMs: stress.json?.scanMs || 0,
      stressFiles: stress.json?.generated?.fileCount || args.stressFiles,
      realRepoFixtures: realRepoSummary.json?.fixtureSet?.selectedRepos || 0
    },
    localRepoScans,
    stress: compactCommandRun(stress),
    realRepoSummary: compactCommandRun(realRepoSummary)
  };
}

function runIdeUxCompleteness() {
  const extensionRoot = path.resolve(PROJECT_ROOT, '..', 'vscode-blackhole');
  const packageJson = readJson(path.join(extensionRoot, 'package.json'), { contributes: {} });
  const packageVsix = runNodeJson('package-vscode-extension.js', [], { timeoutMs: 5 * 60 * 1000 });
  const extensionCheck = runNodeJson('check-vscode-extension.js', [], { timeoutMs: 5 * 60 * 1000 });
  const e2e = args.ideE2e
    ? runNodeJson('test-vscode-extension-e2e.js', [], { timeoutMs: 20 * 60 * 1000 })
    : null;
  const visualStudio = detectVisualStudio(args.launchVisualStudio);

  const commands = packageJson.contributes?.commands || [];
  const requiredCommands = [
    'blackhole.inlineEdit',
    'blackhole.fixDiagnostics',
    'blackhole.generateCompletion',
    'blackhole.reviewAgentDiffs',
    'blackhole.acceptDiffTransaction',
    'blackhole.rollbackDiffTransaction',
    'blackhole.runAgentTask'
  ];
  const commandIds = new Set(commands.map(command => command.command));
  const missingCommands = requiredCommands.filter(command => !commandIds.has(command));

  return {
    ok: packageVsix.ok && extensionCheck.ok && missingCommands.length === 0 && (!e2e || e2e.ok),
    level: e2e ? 'packaged-and-e2e-tested' : 'packaged-and-static-checked',
    summary: `VS Code bridge exposes ${commands.length} commands; Visual Studio detected: ${visualStudio.detected}.`,
    metrics: {
      commandCount: commands.length,
      missingRequiredCommands: missingCommands.length,
      vsixSizeBytes: packageVsix.json?.sizeBytes || 0,
      visualStudioDetected: visualStudio.detected ? 1 : 0
    },
    missingCommands,
    packageVsix: compactCommandRun(packageVsix),
    extensionCheck: compactCommandRun(extensionCheck),
    e2e: e2e ? compactCommandRun(e2e) : { skipped: true, reason: 'Run with --ide-e2e to execute VS Code E2E.' },
    visualStudio
  };
}

function runLongRunStability() {
  const targetMs = Math.max(0, args.soakMinutes) * 60 * 1000;
  const startedLoop = performance.now();
  const samples = [];
  let iterations = 0;
  let failures = 0;
  const maxIterations = args.quick ? 3 : 10_000;

  do {
    const before = process.memoryUsage().rss;
    const run = runNodeJson('agent-e2e-eval.js', [
      '--keep-going',
      '--max-cases=1'
    ], { timeoutMs: 4 * 60 * 1000 });
    const after = process.memoryUsage().rss;
    iterations += 1;
    if (!run.ok) failures += 1;
    samples.push({
      iteration: iterations,
      ok: run.ok,
      durationMs: run.durationMs,
      rssMb: mb(after),
      rssDeltaMb: mb(after - before),
      solveRate: run.json?.solveRate || 0
    });
  } while ((performance.now() - startedLoop) < targetMs && iterations < maxIterations);

  const memoryDriftMb = samples.length ? Number((samples.at(-1).rssMb - samples[0].rssMb).toFixed(1)) : 0;
  return {
    ok: failures === 0 && iterations > 0,
    level: args.soakMinutes >= 60 ? 'long-soak' : 'short-soak-ready',
    summary: `Completed ${iterations} soak iteration(s) over ${Math.round(performance.now() - startedLoop)} ms.`,
    metrics: {
      soakMinutes: args.soakMinutes,
      iterations,
      failures,
      memoryDriftMb
    },
    samples
  };
}

function buildFeedbackLoopProof() {
  const evalRecords = readRecordDir(path.join(PROJECT_ROOT, 'data', 'eval-runs'));
  const autocompleteRecords = readRecordDir(path.join(PROJECT_ROOT, 'data', 'autocomplete-runs'));
  const realRepoRecords = readRecordDir(path.join(PROJECT_ROOT, 'data', 'real-repo-runs'));
  const proofRecords = readRecordDir(proofDir);

  const latestEval = evalRecords.at(0) || null;
  const latestAutocomplete = autocompleteRecords.at(0) || null;
  const acceptedAutocomplete = autocompleteRecords.reduce((sum, record) => sum + Number(record.accepted || record.acceptedCount || 0), 0);
  const offeredAutocomplete = autocompleteRecords.reduce((sum, record) => sum + Number(record.total || record.offered || record.offeredCount || 0), 0);

  return {
    ok: evalRecords.length + autocompleteRecords.length + realRepoRecords.length > 0,
    level: 'recorded-local-feedback',
    summary: `Loaded ${evalRecords.length} agent eval, ${autocompleteRecords.length} autocomplete, ${realRepoRecords.length} real-repo record(s).`,
    metrics: {
      evalRuns: evalRecords.length,
      autocompleteRuns: autocompleteRecords.length,
      realRepoRuns: realRepoRecords.length,
      proofRuns: proofRecords.length,
      latestSolveRate: latestEval?.solveRate || 0,
      latestAutocompletePassAt1: latestAutocomplete?.passAt1 || 0,
      autocompleteAcceptanceRate: offeredAutocomplete ? acceptedAutocomplete / offeredAutocomplete : 0
    },
    latestEval: latestEval ? compactEvalRecord(latestEval) : null,
    latestAutocomplete: latestAutocomplete ? compactAutocompleteRecord(latestAutocomplete) : null
  };
}

function scanLocalRepo(root, maxFiles) {
  const startedScan = performance.now();
  const memoryBefore = process.memoryUsage().rss;
  let filesIndexed = 0;
  let bytesSampled = 0;
  let largestFile = { path: '', bytes: 0 };
  let maxDepth = 0;
  const byExtension = {};

  for (const filePath of walkSourceFiles(root, maxFiles)) {
    try {
      const relative = path.relative(root, filePath);
      const stat = fs.statSync(filePath);
      filesIndexed += 1;
      bytesSampled += Math.min(stat.size, 128 * 1024);
      const ext = path.extname(filePath).toLowerCase() || '[none]';
      byExtension[ext] = (byExtension[ext] || 0) + 1;
      if (stat.size > largestFile.bytes) largestFile = { path: relative, bytes: stat.size };
      maxDepth = Math.max(maxDepth, relative.split(path.sep).length - 1);
    } catch {
      // Ignore unreadable files in durability sampling.
    }
  }

  return {
    root,
    exists: fs.existsSync(root),
    filesIndexed,
    bytesSampled,
    largestFile,
    maxDepth,
    byExtension,
    durationMs: Math.round(performance.now() - startedScan),
    memoryDeltaMb: mb(process.memoryUsage().rss - memoryBefore)
  };
}

function* walkSourceFiles(root, maxFiles) {
  if (!root || !fs.existsSync(root)) return;
  const stack = [root];
  let yielded = 0;
  while (stack.length > 0 && yielded < maxFiles) {
    const current = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (!shouldSkipDir(entry.name)) stack.push(fullPath);
      } else if (entry.isFile() && shouldIndexFile(entry.name)) {
        yielded += 1;
        yield fullPath;
        if (yielded >= maxFiles) break;
      }
    }
  }
}

function shouldSkipDir(name) {
  return new Set([
    '.git',
    '.blackhole',
    '.vscode-test',
    'node_modules',
    'dist',
    'build',
    'coverage',
    '.venv',
    'venv',
    '__pycache__',
    '.pytest_cache',
    '.mypy_cache',
    'bin',
    'obj'
  ]).has(name);
}

function shouldIndexFile(name) {
  return /\.(js|jsx|ts|tsx|mjs|cjs|py|cs|cpp|c|h|hpp|java|go|rs|json|md|css|html|yml|yaml|xml)$/i.test(name);
}

function runNodeJson(scriptName, scriptArgs, { timeoutMs }) {
  const scriptPath = path.join(PROJECT_ROOT, 'scripts', scriptName);
  const startedCommand = performance.now();
  const result = spawnSync(process.execPath, [scriptPath, ...scriptArgs], {
    cwd: PROJECT_ROOT,
    env: {
      ...process.env,
      Path: nodeRuntimePath,
      PATH: nodeRuntimePath
    },
    encoding: 'utf8',
    timeout: timeoutMs,
    windowsHide: true,
    maxBuffer: 1024 * 1024 * 60
  });
  const output = `${result.stdout || ''}${result.stderr || ''}`;
  const json = parseJsonFromOutput(output);
  return {
    ok: result.status === 0 && !result.error && json?.ok !== false,
    command: `node scripts/${scriptName} ${scriptArgs.join(' ')}`.trim(),
    exitCode: result.status,
    durationMs: Math.round(performance.now() - startedCommand),
    json,
    error: result.error?.message || '',
    outputPreview: output.slice(-4000)
  };
}

function parseJsonFromOutput(output) {
  const text = String(output || '');
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

function detectVisualStudio(launch) {
  if (process.platform !== 'win32') {
    return { detected: false, unsupported: true };
  }
  const vswhere = 'C:\\Program Files (x86)\\Microsoft Visual Studio\\Installer\\vswhere.exe';
  let productPath = '';
  if (fs.existsSync(vswhere)) {
    const result = spawnSync(vswhere, ['-latest', '-property', 'productPath'], {
      encoding: 'utf8',
      windowsHide: true
    });
    productPath = String(result.stdout || '').trim();
  }
  if (!productPath || !fs.existsSync(productPath)) {
    productPath = [
      'C:\\Program Files\\Microsoft Visual Studio\\2022\\Community\\Common7\\IDE\\devenv.exe',
      'C:\\Program Files\\Microsoft Visual Studio\\2022\\Professional\\Common7\\IDE\\devenv.exe',
      'C:\\Program Files\\Microsoft Visual Studio\\2022\\Enterprise\\Common7\\IDE\\devenv.exe',
      'D:\\VSIDE\\Common7\\IDE\\devenv.exe'
    ].find(candidate => fs.existsSync(candidate)) || '';
  }
  return {
    detected: !!productPath,
    path: productPath,
    launchSkipped: !launch,
    launchMode: launch ? 'manual-option-requested' : 'not-launched-by-default'
  };
}

function discoverGgufModels(root, limit) {
  if (!root || !fs.existsSync(root)) return [];
  const results = [];
  const stack = [root];
  while (stack.length > 0 && results.length < limit) {
    const current = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (!['node_modules', '.git', 'logs'].includes(entry.name)) stack.push(fullPath);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.gguf')) {
        const stat = fs.statSync(fullPath);
        results.push({
          path: fullPath,
          name: entry.name,
          sizeBytes: stat.size,
          sizeGb: Number((stat.size / 1024 / 1024 / 1024).toFixed(2)),
          family: classifyModelFamily(entry.name)
        });
      }
      if (results.length >= limit) break;
    }
  }
  return results.sort((left, right) => {
    const leftScore = modelPriority(left.name);
    const rightScore = modelPriority(right.name);
    if (leftScore !== rightScore) return leftScore - rightScore;
    return left.sizeBytes - right.sizeBytes;
  });
}

function modelPriority(name) {
  const lower = name.toLowerCase();
  if (lower.includes('coder')) return 0;
  if (lower.includes('qwen')) return 1;
  if (lower.includes('deepseek')) return 2;
  if (lower.includes('mistral')) return 3;
  return 4;
}

function classifyModelFamily(name = '') {
  const lower = name.toLowerCase();
  if (lower.includes('qwen')) return 'qwen';
  if (lower.includes('deepseek')) return 'deepseek';
  if (lower.includes('codellama')) return 'codellama';
  if (lower.includes('mistral')) return 'mistral';
  if (lower.includes('gemma')) return 'gemma';
  return 'other';
}

function buildFeedbackSummaryFromRecords(records) {
  const latest = records.at(0);
  return latest ? {
    solveRate: latest.solveRate,
    passAt1: latest.passAt1,
    modelFile: latest.runtime?.modelFile || latest.model || ''
  } : null;
}

function readRecordDir(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(file => file.endsWith('.json') && file !== 'latest.json')
    .map(file => {
      const fullPath = path.join(dir, file);
      const parsed = readJson(fullPath, null);
      return parsed ? { ...parsed, recordPath: parsed.recordPath || fullPath } : null;
    })
    .filter(Boolean)
    .sort((left, right) => String(right.recordPath || '').localeCompare(String(left.recordPath || '')));
}

function compactEvalRecord(record) {
  return {
    mode: record.mode || '',
    modelFile: record.runtime?.modelFile || '',
    total: record.total || 0,
    passed: record.passed || 0,
    failed: record.failed || 0,
    solveRate: record.solveRate || 0,
    durationMs: record.durationMs || 0,
    recordPath: record.recordPath || ''
  };
}

function compactAutocompleteRecord(record) {
  return {
    model: record.model || record.runtime?.modelFile || '',
    total: record.total || 0,
    passed: record.passed || 0,
    passAt1: record.passAt1 || 0,
    averageLatencyMs: record.averageLatencyMs || 0,
    recordPath: record.recordPath || ''
  };
}

function compactModel(model) {
  return {
    name: model.name,
    path: model.path,
    sizeGb: model.sizeGb,
    family: model.family
  };
}

function compactCommandRun(run) {
  return {
    ok: !!run.ok,
    command: run.command,
    exitCode: run.exitCode,
    durationMs: run.durationMs,
    error: run.error,
    metrics: run.json ? pickMetrics(run.json) : null,
    outputPreview: run.ok ? '' : run.outputPreview
  };
}

function pickMetrics(json) {
  return {
    total: json.total,
    passed: json.passed,
    failed: json.failed,
    solveRate: json.solveRate,
    passAt1: json.passAt1,
    durationMs: json.durationMs,
    recordPath: json.recordPath,
    scanMs: json.scanMs,
    filesIndexed: json.filesIndexed,
    ok: json.ok
  };
}

function scoreDimensions(dimensions) {
  const entries = Object.values(dimensions);
  const passed = entries.filter(entry => entry.ok).length;
  return {
    passed,
    total: entries.length,
    percent: entries.length ? Math.round((passed / entries.length) * 100) : 0
  };
}

function buildRecommendations(payload) {
  const recommendations = [];
  if (!payload.dimensions.modelSolveRate?.metrics?.realModelRuns) {
    recommendations.push('Run with --real-models --max-models=2 --real-model-cases=10 to collect real GGUF solve-rate evidence.');
  }
  if (payload.dimensions.longRunStability?.metrics?.soakMinutes < 60) {
    recommendations.push('Run --full or --soak-minutes=60 for a portfolio-grade long-run stability report.');
  }
  if (!payload.dimensions.ideUxCompleteness?.e2e || payload.dimensions.ideUxCompleteness.e2e.skipped) {
    recommendations.push('Run with --ide-e2e before release to prove the VS Code bridge end-to-end.');
  }
  if (!payload.dimensions.largeRepoDurability?.realRepoSummary?.ok) {
    recommendations.push('Prepare real repository fixtures when network is available: --prepare-repos.');
  }
  return recommendations;
}

function renderMarkdown(payload) {
  const lines = [
    '# BlackHole Proof Report',
    '',
    `- Started: ${payload.startedAt}`,
    `- Mode: ${payload.mode}`,
    `- Score: ${payload.score?.passed || 0}/${payload.score?.total || 0} (${payload.score?.percent || 0}%)`,
    `- Duration: ${payload.durationMs || 0} ms`,
    '',
    '## Dimensions',
    ''
  ];

  for (const [name, dimension] of Object.entries(payload.dimensions || {})) {
    lines.push(`### ${titleCase(name)}`);
    lines.push(`- Status: ${dimension.ok ? 'OK' : 'Needs work'}`);
    lines.push(`- Level: ${dimension.level || 'unknown'}`);
    lines.push(`- Summary: ${dimension.summary || ''}`);
    if (dimension.metrics) {
      lines.push('- Metrics:');
      for (const [key, value] of Object.entries(dimension.metrics)) {
        lines.push(`  - ${key}: ${value}`);
      }
    }
    lines.push('');
  }

  if (payload.recommendations?.length) {
    lines.push('## Recommendations');
    for (const item of payload.recommendations) lines.push(`- ${item}`);
    lines.push('');
  }

  return lines.join('\n');
}

function titleCase(value) {
  return String(value || '')
    .replace(/([A-Z])/g, ' $1')
    .replace(/^./, char => char.toUpperCase());
}

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function uniqueExistingPaths(paths) {
  return Array.from(new Set(paths.filter(Boolean).map(item => path.resolve(item))))
    .filter(item => fs.existsSync(item));
}

function defaultLocalRepos() {
  return [
    PROJECT_ROOT,
    path.resolve(PROJECT_ROOT, '..', 'vscode-blackhole'),
  ];
}

function defaultModelDir() {
  return path.join(PROJECT_ROOT, 'models');
}

function buildEnvironmentSummary() {
  return {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    projectRoot: PROJECT_ROOT,
    llamaServerPath: path.join(PROJECT_ROOT, 'resources', 'llama.cpp', process.platform === 'win32' ? 'llama-server.exe' : 'llama-server'),
    dataDir: path.join(PROJECT_ROOT, 'data')
  };
}

function buildNodeRuntimePath() {
  const candidates = [
    path.resolve(PROJECT_ROOT, '..', 'node-v24.22.2-win-x64'),
    path.join(PROJECT_ROOT, 'resources', 'node-runtime', 'current'),
    process.env.Path || process.env.PATH || ''
  ].filter(Boolean);
  return candidates.join(path.delimiter);
}

function positiveInt(arg, prefix, fallback) {
  const value = Number(arg.slice(prefix.length));
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function positiveNumber(arg, prefix, fallback) {
  const value = Number(arg.slice(prefix.length));
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function mb(bytes) {
  return Number((bytes / 1024 / 1024).toFixed(1));
}
