const { app } = require('electron');
const fs = require('node:fs');
const rawFs = require('original-fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { setImmediate: nextTurn } = require('node:timers/promises');

const arg = (name, fallback) => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const release = path.resolve(arg('release', ''));
assert.ok(arg('release'), 'Specify --release.');
const count = Number(arg('workspaces', 80));
assert.ok(Number.isSafeInteger(count) && count >= 12 && count <= 300);
const label = arg('label', `workspace-memory-${Date.now()}`);
assert.match(label, /^[a-z0-9-]+$/);
const output = path.resolve(__dirname, '../data/diagnostics', label);
assert.ok(!fs.existsSync(output), 'Use a fresh label.');
fs.mkdirSync(output, { recursive: true });
app.setPath('userData', path.join(output, 'electron-data'));
const source = path.join(release, 'win-unpacked/resources/app.asar');
const hash = file => crypto.createHash('sha256').update(rawFs.readFileSync(file)).digest('hex');
const report = { ok: false, startedAt: new Date().toISOString(), release, packageHashAtStart: hash(source),
  scope: 'Packaged context indexing only, without models, credentials or user workspaces. Explicit diagnostic GC separates retained engines from allocator/temporary compiler memory. Not natural-GC RSS or full-process-tree peak certification.',
  workspaceCount: count, indexedFilesPerWorkspace: 40, samples: [] };

app.whenReady().then(async () => {
  try {
    assert.equal(typeof global.gc, 'function', 'Launch Electron with --js-flags=--expose-gc.');
    const api = require(path.join(source, 'src/agent/core/contextEngine.js'));
    const refs = [];
    async function collect() {
      for (let i = 0; i < 3; i++) { await nextTurn(); global.gc(); }
      await nextTurn();
    }
    function sample(phase) {
      const memory = process.memoryUsage();
      const row = { phase, at: new Date().toISOString(), ...memory,
        liveEngines: refs.filter(reference => reference.deref()).length,
        cache: api.getContextEngineCacheStats?.() ?? null };
      report.samples.push(row);
      return row;
    }
    async function indexWorkspace(index) {
      const root = path.join(output, 'workspaces', `repo-${index}`);
      fs.mkdirSync(root, { recursive: true });
      for (let file = 0; file < 40; file++) {
        fs.writeFileSync(path.join(root, `module-${file}.js`),
          Array.from({ length: 20 }, (_, line) => `export function value${file}_${line}(value) { return value + ${line}; }`).join('\n'));
      }
      const engine = api.getContextEngine(root);
      await engine.scanWorkspace();
      assert.equal(engine.fileMap.size, 40);
      assert.ok(engine.getSymbolReferences('value0_0').length > 0);
      assert.equal(api.getContextEngine(path.join(root, '.')), engine);
      refs.push(new WeakRef(engine));
    }
    await collect(); sample('before');
    for (let index = 0; index < count; index++) {
      await indexWorkspace(index);
      if ((index + 1) % 10 === 0) {
        await collect();
        console.log(JSON.stringify(sample(`indexed-${index + 1}`)));
      }
    }
    await collect();
    const retained = sample('after-indexing');
    report.boundedRetention = retained.liveEngines <= 4;
    await nextTurn();
    api.clearAllContextEngineCaches();
    await collect();
    const cleared = sample('after-explicit-clear-control');
    report.releasedHeapBytes = retained.heapUsed - cleared.heapUsed;
    report.explicitClearReleasesEngines = cleared.liveEngines === 0;
    const firstRoot = path.join(output, 'workspaces/repo-0');
    const rebuilt = api.getContextEngine(firstRoot);
    await rebuilt.scanWorkspace();
    report.coldRebuild = rebuilt.fileMap.size === 40 && rebuilt.getSymbolReferences('value0_0').length > 0;
    report.ok = report.boundedRetention && report.explicitClearReleasesEngines && report.coldRebuild;
  } catch (error) { report.error = { name: error.name, message: error.message }; }
  finally {
    report.packageHashAtEnd = hash(source);
    report.packageUnchanged = report.packageHashAtStart === report.packageHashAtEnd;
    report.finishedAt = new Date().toISOString();
    report.ok &&= report.packageUnchanged;
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ ok: report.ok, boundedRetention: report.boundedRetention,
      releasedHeapBytes: report.releasedHeapBytes, output, error: report.error }));
    app.exit(report.ok ? 0 : 1);
  }
});
