import fs from 'fs';
import os from 'os';
import path from 'path';
import { performance } from 'perf_hooks';
import { fileURLToPath } from 'url';
import { AgentStateMachine } from '../src/agent/core/stateMachine.js';
import { VerificationEngine } from '../src/agent/core/verificationEngine.js';
import { loadConfig } from '../src/config/configStore.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');
const rawArgs = process.argv.slice(2);
const args = new Set(rawArgs);

if (args.has('--help') || args.has('-h')) {
  printUsage();
  process.exit(0);
}

const useRealModel = args.has('--real-model');
const maxCasesArg = rawArgs.find(arg => arg.startsWith('--max-cases='));
const maxCases = maxCasesArg ? Number(maxCasesArg.split('=')[1]) : Infinity;
const corpusPathArg = rawArgs.find(arg => arg.startsWith('--corpus='));
const modelPathArg = readArgValue('--model');
const serverPathArg = readArgValue('--server');
const urlArg = readArgValue('--url');
const recordDirArg = readArgValue('--record-dir');
const gpuLayersArg = readArgValue('--gpu-layers');
const contextLimitArg = readArgValue('--ctx');
const maxTokensArg = readArgValue('--max-tokens');
const temperatureArg = readArgValue('--temperature');
const cyclesArg = readArgValue('--cycles');
const corpusPath = corpusPathArg
  ? path.resolve(corpusPathArg.split('=').slice(1).join('='))
  : path.join(PROJECT_ROOT, 'benchmarks', 'agent-e2e', 'e2e-cases.json');

const corpus = JSON.parse(fs.readFileSync(corpusPath, 'utf8'));
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'blackhole-agent-e2e-'));
const startedAt = performance.now();
const results = [];

try {
  const cases = (corpus.cases || []).slice(0, Number.isFinite(maxCases) ? maxCases : undefined);
  for (const testCase of cases) {
    const result = await runCase(testCase);
    results.push(result);
    if (!result.ok && !args.has('--keep-going')) {
      break;
    }
  }

  const passed = results.filter(result => result.ok).length;
  const payload = {
    ok: passed === cases.length,
    mode: useRealModel ? 'real-model' : 'deterministic-baseline',
    corpus: corpus.name,
    corpusPath,
    runtime: buildRuntimeSummary(),
    total: cases.length,
    passed,
    failed: cases.length - passed,
    solveRate: cases.length ? Number((passed / cases.length).toFixed(3)) : 0,
    durationMs: Math.round(performance.now() - startedAt),
    results
  };

  if (args.has('--record')) {
    payload.recordPath = writeEvalRecord(payload);
  }

  console.log(JSON.stringify(payload, null, 2));
  if (!payload.ok) {
    process.exitCode = 1;
  }
} finally {
  if (!args.has('--keep-temp')) {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  } else {
    console.error(`Kept temp root: ${tempRoot}`);
  }
}

async function runCase(testCase) {
  const started = performance.now();
  const workspaceRoot = path.join(tempRoot, testCase.id);
  materializeFiles(workspaceRoot, testCase.files || {});

  const events = [];
  const send = (event) => events.push(event);
  const loadedConfig = loadConfig();
  const runtimeOverrides = buildRuntimeOverrides();
  const config = {
    ...loadedConfig,
    ...runtimeOverrides,
    workspaceRoot,
    permissionMode: 'autonomous',
    selfHealingMaxCycles: Number(cyclesArg || (useRealModel ? 4 : 1)),
    agentMemoryEnabled: false,
    systemInstruction: [
      'You are BlackHole running an end-to-end coding evaluation.',
      'Solve the user request by inspecting files, applying minimal edits, and relying on verification.',
      'Use JSON tool calls only. Prefer read_file, inspect_code_context, patch_lines, patch_file, review_patch_transaction, and apply_patch_transaction.',
      'For simple single-file bug fixes, one read_file is enough context; then call patch_lines, patch_file, or a patch transaction immediately.',
      'Do not call run_command before the first edit unless the instruction explicitly asks for diagnosis-only work. Verification will run automatically after edits.',
      'Do not loop through project_search or inspect_code_context after the target file content is already known unless the target file is missing.',
      'When using patch_file or patch_file operations, copy the exact current file block from read_file including whitespace and line breaks. If exact matching is uncertain, use patch_lines or write_file.',
      'Do not provide a final answer until the code is fixed and verified.'
    ].join('\n')
  };
  config.agentModelProfiles = buildEvalModelProfiles(loadedConfig.agentModelProfiles, config, runtimeOverrides);

  const stateMachine = new AgentStateMachine({
    send,
    messages: [{ role: 'user', content: testCase.instruction }],
    config
  });
  stateMachine.checkpointStore = {
    save(checkpoint) {
      return {
        sessionId: checkpoint.sessionId,
        savedAt: new Date().toISOString(),
        path: path.join(workspaceRoot, `${checkpoint.sessionId}.json`),
        latestPath: path.join(workspaceRoot, 'latest.json')
      };
    }
  };

  if (!useRealModel) {
    stateMachine.callModel = async (_systemPrompt, _conversation, onChunk) => {
      onChunk(buildDeterministicToolResponse(testCase));
    };
  }

  let runError = null;
  try {
    await stateMachine.run();
  } catch (error) {
    runError = error;
  }

  const verification = await new VerificationEngine(workspaceRoot).runVerificationSuite({
    changedFiles: testCase.changedFiles || [],
    contextEngine: stateMachine.contextEngine
  });
  const expectedChecks = evaluateExpectedFiles(workspaceRoot, testCase);
  const toolEnds = events.filter(event => event.type === 'tool_end');
  const failedTools = toolEnds.filter(event => event.result?.ok === false || event.result?.blocked || event.result?.rejected);
  const ok = !runError && verification.ok && expectedChecks.ok;
  const stateChanges = events.filter(event => event.type === 'state_change');
  const routeEvents = stateChanges.filter(event => event.payload?.modelRoute);
  const lastRoute = routeEvents.at(-1)?.payload?.modelRoute || null;
  const finalChunks = events
    .filter(event => event.type === 'chunk')
    .map(event => event.text)
    .join('');

  return {
    id: testCase.id,
    ok,
    durationMs: Math.round(performance.now() - started),
    instruction: testCase.instruction,
    toolCount: toolEnds.length,
    failedToolCount: failedTools.length,
    recoveredToolFailureCount: ok ? failedTools.length : 0,
    toolEvents: toolEnds.map(compactToolEvent),
    failedTools: failedTools.map(compactToolEvent),
    modelRoute: lastRoute,
    stateEventCount: stateChanges.length,
    finalAnswerPreview: finalChunks.slice(0, 500),
    verification: {
      ok: verification.ok,
      syntax: compactVerification(verification.results.syntax),
      test: compactVerification(verification.results.test),
      lint: compactVerification(verification.results.lint)
    },
    expected: expectedChecks,
    error: runError?.message || null
  };
}

function readArgValue(name) {
  const prefix = `${name}=`;
  const match = rawArgs.find(arg => arg.startsWith(prefix));
  return match ? match.slice(prefix.length) : '';
}

function buildRuntimeOverrides() {
  const overrides = {};
  if (modelPathArg) {
    overrides.llamaCppModelPath = path.resolve(modelPathArg);
    overrides.activeModel = 'llamacpp:local-gguf';
    overrides.localRuntime = 'llamacpp';
  }
  if (serverPathArg) overrides.llamaCppServerPath = path.resolve(serverPathArg);
  if (urlArg) overrides.llamaCppUrl = urlArg;
  if (gpuLayersArg !== '') overrides.llamaCppGpuLayers = Number(gpuLayersArg);
  if (contextLimitArg !== '') overrides.contextLimit = Number(contextLimitArg);
  if (maxTokensArg !== '') overrides.maxTokens = Number(maxTokensArg);
  if (temperatureArg !== '') overrides.temperature = Number(temperatureArg);
  return overrides;
}

function buildEvalModelProfiles(existingProfiles = {}, config = {}, overrides = {}) {
  const profileNames = ['general', 'planner', 'coder', 'verifier', 'summarizer'];
  const nextProfiles = {};
  for (const profileName of profileNames) {
    nextProfiles[profileName] = {
      ...(existingProfiles?.[profileName] || {}),
      ...(overrides.activeModel ? { model: overrides.activeModel } : {}),
      ...(overrides.contextLimit ? { contextLimit: Number(overrides.contextLimit) } : {}),
      ...(overrides.maxTokens ? { maxTokens: Number(overrides.maxTokens) } : {}),
      ...(overrides.temperature !== undefined ? { temperature: Number(overrides.temperature) } : {})
    };
    if (!nextProfiles[profileName].model) nextProfiles[profileName].model = config.activeModel;
    if (!nextProfiles[profileName].contextLimit) nextProfiles[profileName].contextLimit = config.contextLimit;
    if (!nextProfiles[profileName].maxTokens) nextProfiles[profileName].maxTokens = config.maxTokens;
    if (nextProfiles[profileName].temperature === undefined || nextProfiles[profileName].temperature === null || nextProfiles[profileName].temperature === '') {
      nextProfiles[profileName].temperature = config.temperature;
    }
  }
  return nextProfiles;
}

function buildRuntimeSummary() {
  const runtime = {
    realModel: useRealModel,
    modelPath: modelPathArg ? path.resolve(modelPathArg) : loadConfig().llamaCppModelPath || '',
    serverPath: serverPathArg ? path.resolve(serverPathArg) : loadConfig().llamaCppServerPath || '',
    url: urlArg || loadConfig().llamaCppUrl || '',
    gpuLayers: gpuLayersArg !== '' ? Number(gpuLayersArg) : loadConfig().llamaCppGpuLayers,
    contextLimit: contextLimitArg !== '' ? Number(contextLimitArg) : loadConfig().contextLimit,
    maxTokens: maxTokensArg !== '' ? Number(maxTokensArg) : loadConfig().maxTokens,
    temperature: temperatureArg !== '' ? Number(temperatureArg) : loadConfig().temperature
  };
  if (runtime.modelPath && fs.existsSync(runtime.modelPath)) {
    const stat = fs.statSync(runtime.modelPath);
    runtime.modelFile = path.basename(runtime.modelPath);
    runtime.modelSizeGB = Number((stat.size / 1024 / 1024 / 1024).toFixed(2));
  }
  return runtime;
}

function writeEvalRecord(payload) {
  const recordDir = recordDirArg
    ? path.resolve(recordDirArg)
    : path.join(PROJECT_ROOT, 'data', 'eval-runs');
  fs.mkdirSync(recordDir, { recursive: true });
  const safeMode = payload.mode.replace(/[^a-z0-9_.-]/gi, '-');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const recordPath = path.join(recordDir, `${stamp}-${safeMode}.json`);
  fs.writeFileSync(recordPath, JSON.stringify(payload, null, 2), 'utf8');
  return recordPath;
}

function printUsage() {
  console.log(`BlackHole agent E2E evaluation

Usage:
  node scripts/agent-e2e-eval.js [options]

Options:
  --real-model              Use the configured or supplied llama.cpp model instead of deterministic patches.
  --model=<path.gguf>       Override llamaCppModelPath for this run without editing config.json.
  --server=<path>           Override llama-server path for this run.
  --url=<url>               Override llama.cpp server URL.
  --gpu-layers=<n>          Override llama.cpp GPU offload layers.
  --ctx=<n>                 Override context size.
  --max-tokens=<n>          Override max generated tokens.
  --temperature=<n>         Override temperature.
  --cycles=<n>              Override self-healing cycle limit.
  --max-cases=<n>           Limit number of corpus cases.
  --corpus=<path.json>      Use a custom E2E corpus.
  --keep-going              Continue after failures.
  --keep-temp               Keep temporary case workspaces.
  --record                  Save JSON result under data/eval-runs.
  --record-dir=<path>       Save JSON result under a custom directory.
`);
}

function buildDeterministicToolResponse(testCase) {
  return [
    `Plan: solve ${testCase.id} with a reviewed patch transaction.`,
    JSON.stringify({
      tool_calls: [
        {
          tool: 'review_patch_transaction',
          params: { operations: testCase.operations || [] }
        },
        {
          tool: 'apply_patch_transaction',
          params: { operations: testCase.operations || [] }
        }
      ]
    })
  ].join('\n');
}

function materializeFiles(root, files) {
  for (const [relativePath, content] of Object.entries(files)) {
    const targetPath = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, content, 'utf8');
  }
}

function evaluateExpectedFiles(workspaceRoot, testCase) {
  const changedFiles = testCase.changedFiles || [];
  const missing = changedFiles.filter(file => !fs.existsSync(path.join(workspaceRoot, file)));
  const containsFailures = [];
  for (const [relativePath, expectedText] of Object.entries(testCase.expected?.contains || {})) {
    const absolutePath = path.join(workspaceRoot, relativePath);
    if (!fs.existsSync(absolutePath)) {
      containsFailures.push({ file: relativePath, expected: expectedText, error: 'file missing' });
      continue;
    }
    const content = fs.readFileSync(absolutePath, 'utf8');
    const alternatives = Array.isArray(expectedText) ? expectedText : [expectedText];
    if (!alternatives.some(text => content.includes(text))) {
      containsFailures.push({ file: relativePath, expected: expectedText, error: 'expected text not found' });
    }
  }
  return {
    ok: missing.length === 0 && containsFailures.length === 0,
    changedFiles,
    missing,
    containsFailures
  };
}

function compactVerification(result = {}) {
  return {
    ok: !!result.ok,
    skipped: !!result.skipped,
    targeted: !!result.targeted,
    command: result.command || '',
    targets: result.targets || []
  };
}

function compactToolEvent(event = {}) {
  const result = event.result || {};
  return {
    tool: event.tool,
    ok: result.ok !== false && !result.blocked && !result.rejected,
    blocked: !!result.blocked,
    rejected: !!result.rejected,
    error: result.error || '',
    validation: result.validation || null,
    params: event.params || result.params || null
  };
}
