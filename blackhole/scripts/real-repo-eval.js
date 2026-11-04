#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { performance } from 'perf_hooks';
import { PROJECT_ROOT } from '../src/common/paths.js';

const args = parseArgs(process.argv.slice(2));
const manifest = readJson(path.join(PROJECT_ROOT, 'benchmarks', 'real-repos', 'repos.json'), { repos: [] });
const taskMatrix = readJson(path.join(PROJECT_ROOT, 'benchmarks', 'real-repos', 'tasks.json'), { tasks: [] });
const worktreeRoot = args.worktreeRoot || path.join(PROJECT_ROOT, 'benchmarks', 'real-repos', 'worktrees');
const startedAt = new Date().toISOString();
const started = performance.now();

const repos = manifest.repos.slice(0, args.maxRepos || manifest.repos.length);
const prepareResults = args.prepare ? prepareRepos(repos, worktreeRoot) : [];
const indexing = repos.map(repo => measureRepoIndex(repo, worktreeRoot, args.maxIndexFiles));
const realRecords = readRecords(path.join(PROJECT_ROOT, 'data', 'real-repo-runs'));
const agentRecords = readRecords(path.join(PROJECT_ROOT, 'data', 'eval-runs'));
const autocompleteRecords = readRecords(path.join(PROJECT_ROOT, 'data', 'autocomplete-runs'));
const metrics = computeEvaluationMetrics(realRecords, taskMatrix.tasks);
const report = {
  ok: true,
  kind: 'real-repo-eval',
  startedAt,
  durationMs: Math.round(performance.now() - started),
  fixtureSet: {
    repos: manifest.repos.length,
    selectedRepos: repos.length,
    preparedRepos: indexing.filter(item => item.prepared).length,
    worktreeRoot,
    ecosystems: countBy(repos, repo => repo.ecosystem),
    sizeClasses: countBy(repos, repo => repo.sizeClass)
  },
  taskMatrix: {
    tasks: taskMatrix.tasks.length,
    byType: countBy(taskMatrix.tasks, task => task.type),
    byRepo: countBy(taskMatrix.tasks, task => task.repoId)
  },
  metrics,
  indexing,
  modelComparison: buildModelComparison({
    realRecords,
    agentRecords,
    autocompleteRecords
  }),
  failureClassification: classifyFailures(realRecords.concat(agentRecords)),
  prepareResults
};

if (args.record) {
  const recordDir = path.join(PROJECT_ROOT, 'data', 'real-repo-reports');
  fs.mkdirSync(recordDir, { recursive: true });
  const recordPath = path.join(recordDir, `${startedAt.replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(recordPath, JSON.stringify(report, null, 2));
  report.recordPath = recordPath;
}

console.log(JSON.stringify(report, null, 2));

function parseArgs(values) {
  const parsed = {
    prepare: false,
    record: true,
    maxRepos: 0,
    maxIndexFiles: 2500,
    worktreeRoot: ''
  };
  for (const arg of values) {
    if (arg === '--prepare') parsed.prepare = true;
    else if (arg === '--no-record') parsed.record = false;
    else if (arg === '--summary-only') parsed.prepare = false;
    else if (arg.startsWith('--max-repos=')) parsed.maxRepos = Number(arg.slice('--max-repos='.length));
    else if (arg.startsWith('--max-index-files=')) parsed.maxIndexFiles = Number(arg.slice('--max-index-files='.length));
    else if (arg.startsWith('--worktrees=')) parsed.worktreeRoot = path.resolve(arg.slice('--worktrees='.length));
  }
  return parsed;
}

function prepareRepos(repos, targetRoot) {
  fs.mkdirSync(targetRoot, { recursive: true });
  return repos.map(repo => {
    const targetPath = path.join(targetRoot, repo.id);
    if (fs.existsSync(path.join(targetPath, '.git'))) {
      return { repoId: repo.id, ok: true, skipped: true, path: targetPath };
    }
    const result = spawnSync('git', [
      'clone',
      '--depth',
      '1',
      '--branch',
      repo.defaultBranch,
      repo.url,
      targetPath
    ], {
      cwd: targetRoot,
      encoding: 'utf8',
      maxBuffer: 1024 * 1024 * 10
    });
    return {
      repoId: repo.id,
      ok: result.status === 0,
      exitCode: result.status,
      path: targetPath,
      outputPreview: `${result.stdout || ''}${result.stderr || ''}`.slice(-2000)
    };
  });
}

function measureRepoIndex(repo, targetRoot, maxFiles) {
  const repoPath = path.join(targetRoot, repo.id);
  if (!fs.existsSync(repoPath)) {
    return {
      repoId: repo.id,
      ecosystem: repo.ecosystem,
      sizeClass: repo.sizeClass,
      prepared: false,
      filesIndexed: 0,
      bytesSampled: 0,
      symbolHints: 0,
      durationMs: 0,
      memoryDeltaMb: 0
    };
  }

  const started = performance.now();
  const memoryBefore = process.memoryUsage().rss;
  let filesIndexed = 0;
  let bytesSampled = 0;
  let symbolHints = 0;
  for (const filePath of walkSourceFiles(repoPath, maxFiles)) {
    try {
      const text = fs.readFileSync(filePath, 'utf8').slice(0, 64 * 1024);
      filesIndexed += 1;
      bytesSampled += Buffer.byteLength(text);
      symbolHints += countSymbolHints(text, path.extname(filePath));
    } catch {
      // Skip unreadable fixture files; the report is about aggregate durability.
    }
  }
  const memoryAfter = process.memoryUsage().rss;
  return {
    repoId: repo.id,
    ecosystem: repo.ecosystem,
    sizeClass: repo.sizeClass,
    prepared: true,
    filesIndexed,
    bytesSampled,
    symbolHints,
    durationMs: Math.round(performance.now() - started),
    memoryDeltaMb: Math.round(((memoryAfter - memoryBefore) / 1024 / 1024) * 10) / 10
  };
}

function* walkSourceFiles(root, maxFiles) {
  const stack = [root];
  let yielded = 0;
  while (stack.length && yielded < maxFiles) {
    const current = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (shouldSkipDir(entry.name)) continue;
        stack.push(fullPath);
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
    'node_modules',
    'dist',
    'build',
    'coverage',
    '.venv',
    'venv',
    '__pycache__',
    '.pytest_cache',
    '.mypy_cache'
  ]).has(name);
}

function shouldIndexFile(name) {
  return /\.(js|jsx|ts|tsx|py|json|md|css|html|yml|yaml)$/i.test(name);
}

function countSymbolHints(text, ext) {
  const source = String(text || '');
  const patterns = /\.py$/i.test(ext)
    ? [/\b(?:async\s+def|def)\s+\w+\s*\(/g, /\bclass\s+\w+/g]
    : [/\bfunction\s+\w+\s*\(/g, /\b(?:class|interface|type|enum)\s+\w+/g, /\b(?:const|let|var)\s+\w+\s*=/g];
  return patterns.reduce((sum, pattern) => sum + (source.match(pattern) || []).length, 0);
}

function computeEvaluationMetrics(records, tasks) {
  const taskRecords = records.flatMap(record => Array.isArray(record.tasks) ? record.tasks : Array.isArray(record.records) ? record.records : []);
  const total = taskRecords.length || tasks.length;
  const passed = taskRecords.filter(record => record.passed || record.ok).length;
  const toolFailures = taskRecords.reduce((sum, record) => sum + Number(record.failedToolCount || record.toolFailures || 0), 0);
  const rollbacks = taskRecords.filter(record => record.rollback || record.rolledBack).length;
  return {
    source: taskRecords.length ? 'recorded-real-runs' : 'fixture-matrix-no-runs-yet',
    totalTasks: total,
    evaluatedTasks: taskRecords.length,
    passAt1: taskRecords.length ? passed / taskRecords.length : 0,
    solveRate: taskRecords.length ? passed / taskRecords.length : 0,
    toolFailureRate: taskRecords.length ? toolFailures / taskRecords.length : 0,
    rollbackRate: taskRecords.length ? rollbacks / taskRecords.length : 0,
    byType: buildMetricsByType(taskRecords, tasks)
  };
}

function buildMetricsByType(records, tasks) {
  const types = new Set(tasks.map(task => task.type));
  for (const record of records) types.add(record.type || 'unknown');
  const result = {};
  for (const type of types) {
    const typed = records.filter(record => (record.type || 'unknown') === type);
    const planned = tasks.filter(task => task.type === type).length;
    const passed = typed.filter(record => record.passed || record.ok).length;
    result[type] = {
      planned,
      evaluated: typed.length,
      solveRate: typed.length ? passed / typed.length : 0
    };
  }
  return result;
}

function buildModelComparison({ realRecords, agentRecords, autocompleteRecords }) {
  const groups = new Map();
  for (const record of realRecords.concat(agentRecords)) {
    const key = classifyModelFamily(getModelName(record));
    const group = ensureModelGroup(groups, key);
    group.agentRuns += 1;
    group.bestSolveRate = Math.max(group.bestSolveRate, Number(record.solveRate || record.passAt1 || 0));
    group.latestSolveRate = Number(record.solveRate || record.passAt1 || 0);
    group.toolFailureRate = average(group.toolFailureRate, Number(record.toolFailureRate || inferToolFailureRate(record)), group.agentRuns);
    group.rollbackRate = average(group.rollbackRate, Number(record.rollbackRate || inferRollbackRate(record)), group.agentRuns);
  }
  for (const record of autocompleteRecords) {
    const key = classifyModelFamily(getModelName(record));
    const group = ensureModelGroup(groups, key);
    group.autocompleteRuns += 1;
    group.autocompletePassAt1 = average(group.autocompletePassAt1, Number(record.passAt1 || 0), group.autocompleteRuns);
    group.autocompleteLatencyMs = average(group.autocompleteLatencyMs, Number(record.averageLatencyMs || 0), group.autocompleteRuns);
  }
  return Array.from(groups.values()).sort((a, b) => {
    const left = Math.max(a.bestSolveRate, a.autocompletePassAt1);
    const right = Math.max(b.bestSolveRate, b.autocompletePassAt1);
    return right - left;
  });
}

function ensureModelGroup(groups, key) {
  if (!groups.has(key)) {
    groups.set(key, {
      modelFamily: key,
      agentRuns: 0,
      autocompleteRuns: 0,
      bestSolveRate: 0,
      latestSolveRate: 0,
      toolFailureRate: 0,
      rollbackRate: 0,
      autocompletePassAt1: 0,
      autocompleteLatencyMs: 0
    });
  }
  return groups.get(key);
}

function classifyFailures(records) {
  const buckets = {
    syntax: 0,
    test: 0,
    tool: 0,
    timeout: 0,
    rollback: 0,
    modelEmpty: 0,
    expectedOutput: 0,
    unknown: 0
  };
  for (const record of records) {
    const failures = Array.isArray(record.failures)
      ? record.failures
      : Array.isArray(record.records)
        ? record.records.filter(item => !(item.passed || item.ok))
        : [];
    for (const failure of failures) {
      buckets[classifyFailure(failure)] += 1;
    }
  }
  return buckets;
}

function classifyFailure(failure) {
  const text = JSON.stringify(failure || {}).toLowerCase();
  if (/syntax|parse|unexpected token/.test(text)) return 'syntax';
  if (/assert|test|expected/.test(text)) return 'test';
  if (/tool|command|spawn|enoent/.test(text)) return 'tool';
  if (/timeout|timed out/.test(text)) return 'timeout';
  if (/rollback|rolled back/.test(text)) return 'rollback';
  if (/empty|no response|no completion/.test(text)) return 'modelEmpty';
  if (/expected file|missing file|output/.test(text)) return 'expectedOutput';
  return 'unknown';
}

function readRecords(dirPath) {
  if (!fs.existsSync(dirPath)) return [];
  return fs.readdirSync(dirPath)
    .filter(file => file.endsWith('.json'))
    .map(file => readJson(path.join(dirPath, file), null))
    .filter(Boolean);
}

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function countBy(items, getKey) {
  return items.reduce((acc, item) => {
    const key = getKey(item) || 'unknown';
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
}

function getModelName(record) {
  return record.model
    || record.runtime?.modelFile
    || record.runtime?.modelPath
    || record.modelFile
    || record.mode
    || 'unknown';
}

function classifyModelFamily(value) {
  const model = String(value || '').toLowerCase();
  if (model.includes('qwen')) return 'Qwen';
  if (model.includes('deepseek')) return 'DeepSeek';
  if (model.includes('codellama') || model.includes('code-llama')) return 'CodeLlama';
  if (model.includes('mistral') || model.includes('mixtral')) return 'Mistral';
  if (model.includes('deterministic')) return 'Deterministic baseline';
  if (model === 'unknown') return 'Unknown';
  return 'Other';
}

function inferToolFailureRate(record) {
  const records = Array.isArray(record.records) ? record.records : [];
  if (!records.length) return 0;
  const failures = records.reduce((sum, item) => sum + Number(item.failedToolCount || 0), 0);
  return failures / records.length;
}

function inferRollbackRate(record) {
  const records = Array.isArray(record.records) ? record.records : [];
  if (!records.length) return 0;
  return records.filter(item => item.rollback || item.rolledBack).length / records.length;
}

function average(previous, next, count) {
  return ((previous * Math.max(0, count - 1)) + next) / Math.max(1, count);
}
