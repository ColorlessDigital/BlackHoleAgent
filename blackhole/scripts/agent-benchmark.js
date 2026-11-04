import fs from 'fs';
import os from 'os';
import path from 'path';
import { performance } from 'perf_hooks';
import { fileURLToPath } from 'url';
import { AgentMemoryStore } from '../src/agent/core/agentMemoryStore.js';
import { ProjectContextEngine } from '../src/agent/core/contextEngine.js';
import { PatchTransactionManager } from '../src/agent/core/patchTransaction.js';
import { VerificationEngine } from '../src/agent/core/verificationEngine.js';
import { resolveModelRoute } from '../src/agent/modelRouting.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');
const startedAt = performance.now();
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'blackhole-agent-benchmark-'));
const results = [];

function step(name, fn) {
  const t0 = performance.now();
  return Promise.resolve()
    .then(fn)
    .then(value => {
      results.push({
        name,
        ok: true,
        durationMs: Math.round(performance.now() - t0),
        details: value || {}
      });
      return value;
    })
    .catch(error => {
      results.push({
        name,
        ok: false,
        durationMs: Math.round(performance.now() - t0),
        error: error.message
      });
      throw error;
    });
}

try {
  fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
  fs.writeFileSync(
    path.join(tempDir, 'package.json'),
    JSON.stringify({ type: 'module' }, null, 2),
    'utf8'
  );
  fs.writeFileSync(
    path.join(tempDir, 'src', 'math.js'),
    'export function add(a, b) { return a + b; }\n',
    'utf8'
  );
  fs.writeFileSync(
    path.join(tempDir, 'src', 'math.test.js'),
    "import test from 'node:test';\nimport assert from 'node:assert';\nimport { add } from './math.js';\ntest('add', () => assert.strictEqual(add(1, 2), 3));\n",
    'utf8'
  );

  const memoryStore = new AgentMemoryStore({
    workspaceRoot: tempDir,
    memoryPath: path.join(tempDir, 'data', 'agent-memory.json'),
    retentionLimit: 40
  });

  await step('project-memory', async () => {
    memoryStore.append({
      type: 'decision',
      summary: 'Use patch transactions for multi-file edits and run targeted verification afterward.',
      tags: ['patch', 'verification', 'agent-core'],
      source: 'benchmark'
    });
    const hits = memoryStore.search('patch verification', { limit: 3 });
    if (hits.length === 0) throw new Error('memory search returned no hits');
    return { hits: hits.length };
  });

  const contextEngine = new ProjectContextEngine(tempDir);
  await step('code-intelligence', async () => {
    await contextEngine.scanWorkspace();
    const summary = contextEngine.getWorkspaceSummary();
    const references = contextEngine.getSymbolReferences('add');
    const targets = contextEngine.getVerificationTargets(['src/math.js']);
    if (!references.some(ref => ref.file === 'src/math.test.js')) {
      throw new Error('symbol reference from test file was not indexed');
    }
    if (!targets.testFiles.includes('src/math.test.js')) {
      throw new Error('targeted verification did not resolve math.test.js');
    }
    return {
      indexedFiles: summary.indexedFiles,
      references: references.length,
      testTargets: targets.testFiles
    };
  });

  await step('model-routing', async () => {
    const route = resolveModelRoute({
      activeModel: 'llamacpp:local-gguf',
      localRuntime: 'llamacpp',
      contextLimit: 8192,
      maxTokens: 4096,
      temperature: 0.2,
      agentModelRoutingEnabled: true,
      agentModelProfiles: {
        coder: { temperature: 0.12, maxTokens: 3072 },
        verifier: { temperature: 0.02, maxTokens: 1024 }
      }
    }, {
      phase: 'repair',
      task: 'patch math function'
    });
    if (route.profile !== 'coder') throw new Error(`expected coder route, got ${route.profile}`);
    return route;
  });

  await step('patch-transaction', async () => {
    const manager = new PatchTransactionManager(tempDir);
    const operations = [
      { type: 'patch_file', path: 'src/math.js', search: 'return a + b;', replace: 'return a + b + 1;' },
      { type: 'patch_file', path: 'src/math.test.js', search: 'add(1, 2), 3', replace: 'add(1, 2), 4' }
    ];
    const review = await manager.review(operations);
    if (!review.ok || review.changedFiles.length !== 2) {
      throw new Error('patch transaction review did not detect both files');
    }
    const applied = await manager.apply(operations);
    if (!applied.ok) throw new Error(applied.error || 'patch transaction apply failed');
    return {
      operationCount: applied.operationCount,
      changedFiles: applied.changedFiles
    };
  });

  await step('targeted-verification', async () => {
    await contextEngine.scanWorkspace();
    const suite = await new VerificationEngine(tempDir).runVerificationSuite({
      changedFiles: ['src/math.js', 'src/math.test.js'],
      contextEngine
    });
    if (!suite.ok) {
      throw new Error(JSON.stringify(suite.results, null, 2));
    }
    return {
      syntaxTargeted: suite.results.syntax.targeted,
      testTargeted: suite.results.test.targeted,
      tests: suite.results.test.targets || []
    };
  });

  await step('benchmark-corpus', async () => {
    const corpusPath = path.join(PROJECT_ROOT, 'benchmarks', 'agent-corpus', 'coding-fixes.json');
    const corpus = JSON.parse(fs.readFileSync(corpusPath, 'utf8'));
    const caseResults = [];

    for (const corpusCase of corpus.cases || []) {
      const caseRoot = path.join(tempDir, 'corpus', corpusCase.id);
      materializeCase(caseRoot, corpusCase.files || {});

      const caseContext = new ProjectContextEngine(caseRoot);
      await caseContext.scanWorkspace();
      const targets = caseContext.getVerificationTargets(corpusCase.changedFiles || []);
      const expectedTargets = corpusCase.expected?.testTargets || [];
      for (const expectedTarget of expectedTargets) {
        if (!targets.testFiles.includes(expectedTarget)) {
          throw new Error(`${corpusCase.id}: expected target ${expectedTarget}, got ${targets.testFiles.join(', ')}`);
        }
      }

      const manager = new PatchTransactionManager(caseRoot);
      const review = await manager.review(corpusCase.operations || []);
      if (!review.ok) {
        throw new Error(`${corpusCase.id}: patch review failed: ${review.error}`);
      }

      const applied = await manager.apply(corpusCase.operations || []);
      if (!applied.ok) {
        throw new Error(`${corpusCase.id}: patch apply failed: ${applied.error}`);
      }

      for (const [relativePath, expectedText] of Object.entries(corpusCase.expected?.contains || {})) {
        const content = fs.readFileSync(path.join(caseRoot, relativePath), 'utf8');
        if (!content.includes(expectedText)) {
          throw new Error(`${corpusCase.id}: ${relativePath} does not contain expected text`);
        }
      }

      await caseContext.scanWorkspace();
      const suite = await new VerificationEngine(caseRoot).runVerificationSuite({
        changedFiles: corpusCase.changedFiles || [],
        contextEngine: caseContext
      });
      if (!suite.ok) {
        throw new Error(`${corpusCase.id}: verification failed: ${JSON.stringify(suite.results, null, 2)}`);
      }

      caseResults.push({
        id: corpusCase.id,
        changedFiles: applied.changedFiles,
        testTargets: suite.results.test.targets || []
      });
    }

    return {
      corpus: corpus.name,
      cases: caseResults.length,
      caseResults
    };
  });

  const payload = {
    ok: results.every(result => result.ok),
    durationMs: Math.round(performance.now() - startedAt),
    tempDir,
    results
  };
  console.log(JSON.stringify(payload, null, 2));
} catch (error) {
  console.error(JSON.stringify({
    ok: false,
    durationMs: Math.round(performance.now() - startedAt),
    tempDir,
    results,
    error: error.message
  }, null, 2));
  process.exitCode = 1;
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}

function materializeCase(root, files) {
  for (const [relativePath, content] of Object.entries(files)) {
    const targetPath = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, content, 'utf8');
  }
}
