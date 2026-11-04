#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import { PROJECT_ROOT } from '../src/common/paths.js';
import { loadConfig } from '../src/config/configStore.js';
import { runAutocompleteBenchmark } from '../src/ide/autocompleteEngine.js';

const args = process.argv.slice(2);
const options = parseArgs(args);
const config = loadConfig();
if (options.modelPath) {
  config.llamaCppModelPath = options.modelPath;
  config.activeModel = 'llamacpp:local-gguf';
}

const result = await runAutocompleteBenchmark({
  casesPath: options.casesPath,
  maxCases: options.maxCases,
  realModel: options.realModel,
  modelLabel: options.modelLabel || inferModelLabel(config, options.realModel),
  config
});

if (options.record) {
  const recordDir = path.join(PROJECT_ROOT, 'data', 'autocomplete-runs');
  fs.mkdirSync(recordDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const recordPath = path.join(recordDir, `${stamp}-${sanitizeFilePart(result.model)}.json`);
  const payload = {
    ...result,
    recordPath,
    runtime: {
      realModel: options.realModel,
      modelPath: options.modelPath || config.llamaCppModelPath || '',
      modelFile: path.basename(options.modelPath || config.llamaCppModelPath || '')
    }
  };
  fs.writeFileSync(recordPath, JSON.stringify(payload, null, 2));
  result.recordPath = recordPath;
}

console.log(JSON.stringify(result, null, 2));
if (!result.ok && options.failOnRegression) {
  process.exitCode = 1;
}

function parseArgs(values) {
  const parsed = {
    casesPath: path.join(PROJECT_ROOT, 'benchmarks', 'autocomplete', 'autocomplete-cases.json'),
    maxCases: 0,
    realModel: false,
    modelPath: '',
    modelLabel: '',
    record: true,
    failOnRegression: false
  };
  for (const arg of values) {
    if (arg === '--real-model') parsed.realModel = true;
    else if (arg === '--no-record') parsed.record = false;
    else if (arg === '--fail-on-regression') parsed.failOnRegression = true;
    else if (arg.startsWith('--max-cases=')) parsed.maxCases = Number(arg.slice('--max-cases='.length));
    else if (arg.startsWith('--cases=')) parsed.casesPath = path.resolve(arg.slice('--cases='.length));
    else if (arg.startsWith('--model=')) parsed.modelPath = path.resolve(arg.slice('--model='.length));
    else if (arg.startsWith('--model-label=')) parsed.modelLabel = arg.slice('--model-label='.length);
  }
  return parsed;
}

function inferModelLabel(config, realModel) {
  if (!realModel) return 'deterministic-baseline';
  return path.basename(config.llamaCppModelPath || '') || config.activeModel || 'real-local-model';
}

function sanitizeFilePart(value) {
  return String(value || 'model').replace(/[^a-zA-Z0-9_.-]+/g, '_').slice(0, 80);
}
