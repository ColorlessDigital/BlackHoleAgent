#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import { PROJECT_ROOT } from '../src/common/paths.js';
import {
  renderPrCheckMarkdown,
  renderPrCheckSarif,
  runPrDiffChecks
} from '../src/ci/prDiffCheck.js';

const options = parseArgs(process.argv.slice(2));
const report = runPrDiffChecks({
  workspaceRoot: PROJECT_ROOT,
  baseRef: options.baseRef,
  changedFiles: options.changedFiles
});

if (options.outputDir) {
  fs.mkdirSync(options.outputDir, { recursive: true });
  if (options.format === 'all' || options.format === 'json') {
    fs.writeFileSync(path.join(options.outputDir, 'pr-check.json'), JSON.stringify(report, null, 2));
  }
  if (options.format === 'all' || options.format === 'markdown') {
    fs.writeFileSync(path.join(options.outputDir, 'pr-check.md'), renderPrCheckMarkdown(report));
  }
  if (options.format === 'all' || options.format === 'sarif') {
    fs.writeFileSync(path.join(options.outputDir, 'pr-check.sarif'), JSON.stringify(renderPrCheckSarif(report), null, 2));
  }
}

if (options.format === 'markdown') {
  console.log(renderPrCheckMarkdown(report));
} else if (options.format === 'sarif') {
  console.log(JSON.stringify(renderPrCheckSarif(report), null, 2));
} else {
  console.log(JSON.stringify(report, null, 2));
}

if (!report.ok) process.exitCode = 1;

function parseArgs(values) {
  const parsed = {
    format: 'json',
    outputDir: '',
    baseRef: '',
    changedFiles: undefined
  };
  for (const arg of values) {
    if (arg.startsWith('--format=')) parsed.format = normalizeFormat(arg.slice('--format='.length));
    else if (arg.startsWith('--output-dir=')) parsed.outputDir = path.resolve(arg.slice('--output-dir='.length));
    else if (arg.startsWith('--base-ref=')) parsed.baseRef = arg.slice('--base-ref='.length);
    else if (arg.startsWith('--changed-files=')) {
      parsed.changedFiles = arg.slice('--changed-files='.length).split(',').map(item => item.trim()).filter(Boolean);
    }
  }
  return parsed;
}

function normalizeFormat(value) {
  return ['json', 'markdown', 'sarif', 'all'].includes(value) ? value : 'json';
}
