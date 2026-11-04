import express from 'express';
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { PROJECT_ROOT } from '../../common/paths.js';
import { getUsageSummary, resetUsage } from '../../runtime/usageTracker.js';

export function createReportsRouter() {
  const router = express.Router();

  router.get('/reports/model-benchmarks', (_req, res) => {
    res.json(buildModelBenchmarkReport());
  });

  router.get('/reports/autocomplete-benchmarks', (_req, res) => {
    res.json(buildAutocompleteBenchmarkReport());
  });

  router.get('/reports/proof', (_req, res) => {
    res.json(buildProofReport());
  });

  router.post('/reports/proof', async (req, res) => {
    try {
      const body = req.body || {};
      const args = [path.join(PROJECT_ROOT, 'scripts', 'proof-pipeline.js'), '--record'];
      args.push(body.full ? '--full' : '--quick');
      if (body.realModels) args.push('--real-models');
      if (body.ideE2e) args.push('--ide-e2e');
      if (body.prepareRepos) args.push('--prepare-repos');
      if (body.modelDir) args.push(`--model-dir=${body.modelDir}`);
      if (body.maxModels) args.push(`--max-models=${Number(body.maxModels)}`);
      if (body.maxCases) args.push(`--max-cases=${Number(body.maxCases)}`);
      if (body.realModelCases) args.push(`--real-model-cases=${Number(body.realModelCases)}`);
      if (body.soakMinutes !== undefined) args.push(`--soak-minutes=${Number(body.soakMinutes)}`);
      const timeoutMs = body.full || body.realModels ? 120 * 60 * 1000 : 15 * 60 * 1000;
      const result = await runNodeJson(args, { timeoutMs });
      res.json(result);
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  router.post('/reports/autocomplete-benchmark', async (req, res) => {
    try {
      const args = [
        path.join(PROJECT_ROOT, 'scripts', 'autocomplete-benchmark.js'),
        `--max-cases=${Number(req.body.maxCases || 12)}`
      ];
      if (req.body.realModel) args.push('--real-model');
      if (req.body.modelPath) args.push(`--model=${req.body.modelPath}`);
      const result = await runNodeJson(args, { timeoutMs: 5 * 60 * 1000 });
      res.json(result);
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  router.get('/reports/real-repo-eval', async (_req, res) => {
    try {
      const result = await runNodeJson([
        path.join(PROJECT_ROOT, 'scripts', 'real-repo-eval.js'),
        '--summary-only',
        '--no-record'
      ], { timeoutMs: 2 * 60 * 1000 });
      res.json(result);
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  router.post('/reports/real-repo-eval', async (req, res) => {
    try {
      const args = [
        path.join(PROJECT_ROOT, 'scripts', 'real-repo-eval.js'),
        `--max-repos=${Number(req.body.maxRepos || 12)}`
      ];
      if (req.body.prepare) args.push('--prepare');
      else args.push('--summary-only');
      const result = await runNodeJson(args, { timeoutMs: 20 * 60 * 1000 });
      res.json(result);
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  router.post('/reports/e2e-eval', async (req, res) => {
    try {
      const maxCases = Number(req.body.maxCases || 50);
      const args = [
        path.join(PROJECT_ROOT, 'scripts', 'agent-e2e-eval.js'),
        '--keep-going',
        '--record',
        `--max-cases=${maxCases}`
      ];
      if (req.body.realModel) args.push('--real-model');
      if (req.body.modelPath) args.push(`--model=${req.body.modelPath}`);
      const result = await runNodeJson(args, { timeoutMs: 10 * 60 * 1000 });
      res.json(result);
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  router.post('/reports/pr-check', async (req, res) => {
    try {
      const args = [path.join(PROJECT_ROOT, 'scripts', 'pr-check.js')];
      if (req.body.full) args.push('--full');
      if (req.body.skipVsix) args.push('--skip-vsix');
      const result = await runNodeJson(args, { timeoutMs: 10 * 60 * 1000 });
      res.json(result);
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  router.get('/reports/usage', (_req, res) => {
    res.json({ ok: true, usage: getUsageSummary() });
  });

  router.delete('/reports/usage', (_req, res) => {
    res.json({ ok: true, usage: resetUsage() });
  });

  return router;
}

function buildProofReport() {
  const proofDir = path.join(PROJECT_ROOT, 'data', 'proof-runs');
  const latestPath = path.join(proofDir, 'latest.json');
  const latest = readJson(latestPath, null);
  if (latest) {
    return {
      ok: true,
      available: true,
      latestPath,
      latest
    };
  }

  return {
    ok: true,
    available: false,
    latestPath,
    message: 'No proof report has been recorded yet. Run the proof pipeline to collect evidence.',
    expectedDimensions: [
      'modelSolveRate',
      'largeRepoDurability',
      'ideUxCompleteness',
      'longRunStability',
      'feedbackLoop'
    ]
  };
}

function buildAutocompleteBenchmarkReport() {
  const runDir = path.join(PROJECT_ROOT, 'data', 'autocomplete-runs');
  const corpusPath = path.join(PROJECT_ROOT, 'benchmarks', 'autocomplete', 'autocomplete-cases.json');
  const corpus = readJson(corpusPath, { cases: [] });
  const records = fs.existsSync(runDir)
    ? fs.readdirSync(runDir)
      .filter(file => file.endsWith('.json'))
      .map(file => readJson(path.join(runDir, file), null))
      .filter(Boolean)
      .sort((a, b) => String(b.startedAt || b.recordPath || '').localeCompare(String(a.startedAt || a.recordPath || '')))
    : [];

  const byModel = new Map();
  for (const record of records) {
    const modelKey = record.model || record.runtime?.modelFile || 'unknown';
    const current = byModel.get(modelKey) || {
      model: modelKey,
      runs: 0,
      bestPassAt1: 0,
      latestPassAt1: 0,
      averageLatencyMs: 0,
      cacheHitRate: 0,
      duplicateRemovalRate: 0
    };
    current.runs += 1;
    current.bestPassAt1 = Math.max(current.bestPassAt1, Number(record.passAt1 || 0));
    current.latestPassAt1 = Number(record.passAt1 || 0);
    current.averageLatencyMs = Math.round(((current.averageLatencyMs * (current.runs - 1)) + Number(record.averageLatencyMs || 0)) / current.runs);
    current.cacheHitRate = ((current.cacheHitRate * (current.runs - 1)) + Number(record.cacheHitRate || 0)) / current.runs;
    current.duplicateRemovalRate = ((current.duplicateRemovalRate * (current.runs - 1)) + Number(record.duplicateRemovalRate || 0)) / current.runs;
    byModel.set(modelKey, current);
  }

  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    corpus: {
      name: corpus.name || 'BlackHole autocomplete benchmark corpus',
      cases: corpus.cases?.length || 0,
      path: corpusPath
    },
    models: Array.from(byModel.values()).sort((a, b) => b.bestPassAt1 - a.bestPassAt1),
    latestRuns: records.slice(0, 12).map(record => ({
      model: record.model,
      total: record.total,
      passed: record.passed,
      failed: record.failed,
      passAt1: record.passAt1,
      averageLatencyMs: record.averageLatencyMs,
      recordPath: record.recordPath || ''
    }))
  };
}

function buildModelBenchmarkReport() {
  const evalDir = path.join(PROJECT_ROOT, 'data', 'eval-runs');
  const corpusPath = path.join(PROJECT_ROOT, 'benchmarks', 'agent-e2e', 'e2e-cases.json');
  const corpus = readJson(corpusPath, { cases: [] });
  const records = fs.existsSync(evalDir)
    ? fs.readdirSync(evalDir)
      .filter(file => file.endsWith('.json'))
      .map(file => readJson(path.join(evalDir, file), null))
      .filter(Boolean)
      .sort((a, b) => String(b.recordedAt || b.startedAt || b.recordPath || '').localeCompare(String(a.recordedAt || a.startedAt || a.recordPath || '')))
    : [];

  const byModel = new Map();
  for (const record of records) {
    const modelKey = record.runtime?.modelFile
      || (record.runtime?.modelPath ? path.basename(record.runtime.modelPath) : record.mode || 'deterministic-baseline');
    const current = byModel.get(modelKey) || {
      model: modelKey,
      runs: 0,
      bestSolveRate: 0,
      latestSolveRate: 0,
      latestRun: null,
      totalCasesEvaluated: 0,
      averageDurationMs: 0
    };
    current.runs += 1;
    current.bestSolveRate = Math.max(current.bestSolveRate, Number(record.solveRate || 0));
    current.latestSolveRate = Number(record.solveRate || 0);
    current.latestRun = compactEvalRecord(record);
    current.totalCasesEvaluated += Number(record.total || 0);
    current.averageDurationMs = Math.round(((current.averageDurationMs * (current.runs - 1)) + Number(record.durationMs || 0)) / current.runs);
    byModel.set(modelKey, current);
  }

  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    corpus: {
      name: corpus.name || 'BlackHole agent end-to-end task corpus',
      cases: corpus.cases?.length || 0,
      path: corpusPath
    },
    models: Array.from(byModel.values()).sort((a, b) => b.bestSolveRate - a.bestSolveRate),
    latestRuns: records.slice(0, 12).map(compactEvalRecord)
  };
}

function compactEvalRecord(record) {
  return {
    mode: record.mode,
    corpus: record.corpus,
    total: record.total,
    passed: record.passed,
    failed: record.failed,
    solveRate: record.solveRate,
    durationMs: record.durationMs,
    recordPath: record.recordPath || '',
    modelFile: record.runtime?.modelFile || '',
    modelPath: record.runtime?.modelPath || '',
    createdAt: inferRecordTime(record)
  };
}

function inferRecordTime(record) {
  if (record.recordPath) {
    const base = path.basename(record.recordPath).split('-deterministic')[0].split('-real')[0];
    return base.replace(/-(\d{3})Z$/, '.$1Z').replace(/T(\d{2})-(\d{2})-(\d{2})/, 'T$1:$2:$3');
  }
  return '';
}

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function runNodeJson(args, { timeoutMs }) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, args, {
      cwd: PROJECT_ROOT,
      windowsHide: true
    });
    let output = '';
    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error('Report command timed out.'));
    }, timeoutMs);
    proc.stdout.on('data', data => { output += data.toString(); });
    proc.stderr.on('data', data => { output += data.toString(); });
    proc.on('error', error => {
      clearTimeout(timer);
      reject(error);
    });
    proc.on('close', code => {
      clearTimeout(timer);
      const jsonStart = output.indexOf('{');
      const jsonEnd = output.lastIndexOf('}');
      if (jsonStart >= 0 && jsonEnd > jsonStart) {
        try {
          const parsed = JSON.parse(output.slice(jsonStart, jsonEnd + 1));
          if (code !== 0 && parsed.ok !== false) parsed.ok = false;
          return resolve(parsed);
        } catch {
          // Fall through.
        }
      }
      resolve({
        ok: code === 0,
        exitCode: code,
        outputPreview: output.slice(-5000)
      });
    });
  });
}
