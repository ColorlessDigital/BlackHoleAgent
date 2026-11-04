// Electron runner: packaged code stays fixed; --live explicitly enables account usage.
const { app } = require('electron');
process.on('uncaughtException', error => { console.error(`Stability runner fatal: ${error.name} (${error.code || 'no-code'})`); app.exit(1); });
const fs = require('node:fs');
const rawFs = require('original-fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const arg = (name, fallback) => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const bounded = (name, fallback, max) => {
  const value = Number(arg(name, fallback));
  if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new Error(`Invalid --${name}`);
  return value;
};
const label = arg('label', `stability-${Date.now()}`);
if (!/^[a-z0-9-]+$/.test(label)) throw new Error('Invalid label');
const root = path.resolve(__dirname, '..');
const release = path.resolve(arg('release', path.join(root, '../windows/go-stabilized-11')));
const source = path.join(release, 'win-unpacked/resources/app.asar');
const directory = path.join(root, 'data/diagnostics', label);
if (fs.existsSync(directory)) throw new Error('Use a new label; earlier evidence must be retained.');
fs.mkdirSync(directory, { recursive: true });
const userRoot = path.join(process.env.APPDATA, 'BlackHole');
app.setPath('userData', userRoot);
const cache = fs.mkdtempSync(path.join(os.tmpdir(), 'bh-stability-cache-'));
if (process.argv.includes('--live')) {
  const state = JSON.parse(fs.readFileSync(path.join(userRoot, 'Local State'), 'utf8'));
  fs.writeFileSync(path.join(cache, 'Local State'), JSON.stringify({ os_crypt: state.os_crypt }), { mode: 0o600 });
}
app.setPath('sessionData', cache);
const digest = file => crypto.createHash('sha256').update((String(file).endsWith('.asar') ? rawFs : fs).readFileSync(file)).digest('hex');
const report = { ok: false, startedAt: new Date().toISOString(), release, directory,
  sourceHash: JSON.parse(fs.readFileSync(path.join(release, 'BUILDINFO.json'), 'utf8')).sourceHash,
  packageHashAtStart: digest(source), runnerHash: digest(__filename), technical: [], rounds: [],
  scope: 'Fixed packaged build; synthetic multi-file/large repositories and same-session conversations. Independent tests and protected file hashes. Not a third-party repository benchmark or an hour-long soak.' };
const save = () => fs.writeFileSync(path.join(directory, 'report.json'), JSON.stringify(report, null, 2));
let runtime;
app.whenReady().then(async () => {
  process.resourcesPath = path.dirname(source);
  const before = ['config.json', 'secrets.enc.json'].map(file => digest(path.join(userRoot, file)));
  try {
    let loaded;
    if (process.argv.includes('--live')) {
      const { loadConfig } = require(path.join(source, 'src/config/configStore.js'));
      loaded = loadConfig();
    }
    process.env.BLACKHOLE_DATA_DIR = path.join(directory, 'runtime-data');
    process.env.BLACKHOLE_DISABLE_WORKSPACE_STANDARD = '1';
    const { AgentStateMachine } = require(path.join(source, 'src/agent/core/stateMachine.js'));
    const { AgentCheckpointStore } = require(path.join(source, 'src/agent/core/checkpointStore.js'));
    const { ProjectContextEngine } = require(path.join(source, 'src/agent/core/contextEngine.js'));
    const { resolveModelRoute } = require(path.join(source, 'src/agent/modelRouting.js'));
    const { estimateConversationTokens } = require(path.join(source, 'src/agent/contextGuard.js'));
    const technical = async (name, fn) => {
      const row = { name, ok: false, startedAt: Date.now() };
      try { Object.assign(row, await fn()); row.ok = true; }
      catch (error) { row.error = error.message; }
      row.elapsedMs = Date.now() - row.startedAt;
      report.technical.push(row); save(); console.log(JSON.stringify({ technical: name, ok: row.ok }));
    };
    await technical('phase-context-compaction', async () => {
      const workspace = path.join(directory, 'phase-context'); fs.mkdirSync(workspace);
      const messages = [{ role: 'user', content: 'Keep the original implementation goal.' },
        ...Array.from({ length: 24 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `Historical ${i}: ${'detail '.repeat(260)}` })),
        { role: 'user', content: 'Report the current state.' }];
      const machine = new AgentStateMachine({ send() {}, messages, config: { workspaceRoot: workspace, contextLimit: 122880,
        agentModelProfiles: { planner: { contextLimit: 8192 } }, agentMemoryEnabled: false } });
      machine.checkpointStore = new AgentCheckpointStore({ dir: path.join(workspace, 'checkpoints') });
      machine.callModel = async (_system, _messages, onChunk) => { onChunk('Original implementation goal and current status retained.'); };
      const route = resolveModelRoute(machine.config, { phase: 'plan' });
      const result = await machine.maybeCompactContext('System', machine.activeConversation);
      assert.ok(estimateConversationTokens(messages, 'System') > route.contextLimit);
      assert.equal(result.compacted, true, 'Conversation above the actual phase context must be summarized, not only silently dropped by the runtime guard.');
      return { routeLimit: route.contextLimit, compacted: result.compacted, removed: result.removed };
    });
    await technical('scan-cancellation', async () => {
      const workspace = path.join(directory, 'cancel-scan'); fs.mkdirSync(workspace);
      for (let i = 0; i < 500; i++) fs.writeFileSync(path.join(workspace, `${i}.md`), `Fixture ${i}`);
      const engine = new ProjectContextEngine(workspace);
      const stop = new AbortController();
      const timer = setTimeout(() => stop.abort(), 0);
      let aborted = false;
      try { await engine.scanWorkspace({ force: true, abortSignal: stop.signal }); }
      catch (error) { aborted = error.name === 'AbortError'; }
      finally { clearTimeout(timer); }
      assert.equal(aborted, true, 'A queued cancellation must interrupt indexing before all files are processed.');
      return { aborted, indexed: engine.fileMap.size };
    });
    await technical('scan-file-disappears', async () => {
      const workspace = path.join(directory, 'disappearing-file'); fs.mkdirSync(workspace);
      for (const name of ['a.md', 'b.md', 'c.md']) fs.writeFileSync(path.join(workspace, name), name);
      const engine = new ProjectContextEngine(workspace);
      const glob = engine.globFiles.bind(engine);
      engine.globFiles = (...args) => { const files = glob(...args); fs.unlinkSync(path.join(workspace, 'b.md')); return files; };
      await engine.scanWorkspace({ force: true });
      assert.equal(engine.fileMap.has('c.md'), true, 'One disappearing file must not stop the remaining scan.');
      return { files: [...engine.fileMap.keys()] };
    });
    if (!process.argv.includes('--live')) return;
    const { OpenCodeGoRuntime } = require(path.join(source, 'src/runtime/openCodeGoRuntime.js'));
    runtime = new OpenCodeGoRuntime(loaded);
    assert.ok(runtime.isConfigured());
    assert.ok(String(loaded.activeModel).startsWith('opencode-go:'), 'Select a Go model before running --live.');
    const { eventBus } = require(path.join(source, 'src/common/eventBus.js'));
    const { respondToApproval } = require(path.join(source, 'src/security/approvalGate.js'));
    const repeats = bounded('repeats', 3, 5), turns = bounded('turns', 12, 24), largeFiles = bounded('files', 3200, 10000);
    report.model = loaded.activeModel;
    report.limits = { repeats, turns, largeFiles };
    report.modelRoute = resolveModelRoute(loaded, { phase: 'plan' });
    const node = path.join(root, '../node-v24.21.0-win-x64/node.exe');
    function fixture(name, generated = 0) {
      const workspace = path.join(directory, name);
      const domain = generated ? 'packages/checkout' : 'domain';
      fs.mkdirSync(path.join(workspace, domain), { recursive: true });
      const implementations = {
        [`${domain}/math.cjs`]: 'exports.add = (a,b) => a-b;\n',
        [`${domain}/cart.cjs`]: 'exports.total = items => items.reduce((sum,item)=>sum+item.price,0);\n',
        [`${domain}/label.cjs`]: 'exports.label = name => name.toLowerCase();\n'
      };
      for (const [file, content] of Object.entries(implementations)) fs.writeFileSync(path.join(workspace, file), content);
      fs.writeFileSync(path.join(workspace, 'package.json'), JSON.stringify({ name: 'stability-fixture', scripts: { test: 'node --test check.test.cjs' } }));
      fs.writeFileSync(path.join(workspace, 'check.test.cjs'), `const {test}=require('node:test');const a=require('node:assert/strict');
        test('three modules',()=>{const m=require('./${domain}/math.cjs'),c=require('./${domain}/cart.cjs'),l=require('./${domain}/label.cjs');
        a.equal(m.add(-2,7),5);a.equal(m.add(0,0),0);const items=[{price:4,quantity:3},{price:2,quantity:0}];const before=JSON.stringify(items);
        a.equal(c.total(items),12);a.equal(c.total([]),0);a.equal(JSON.stringify(items),before);a.equal(l.label('AbC'),'ABC');});`);
      const untouched = [];
      if (generated) {
        fs.mkdirSync(path.join(workspace, 'src/generated'), { recursive: true });
        for (let i = 0; i < generated; i++) {
          const file = `src/generated/module-${String(i).padStart(5, '0')}.js`;
          fs.writeFileSync(path.join(workspace, file), `export function helper${i}(input) { return { id: ${i}, value: input + ${i} }; }\n`);
          untouched.push(file);
        }
      }
      const protectedFiles = ['package.json', 'check.test.cjs', ...untouched];
      return { workspace, implementations: Object.keys(implementations), domain,
        protectedHashes: Object.fromEntries(protectedFiles.map(file => [file, digest(path.join(workspace, file))])) };
    }
    const live = async (name, fixture, messages, sessionId) => {
      const started = Date.now(), events = [], wire = [];
      const realFetch = globalThis.fetch;
      globalThis.fetch = async (url, options) => {
        let row;
        if (String(url).startsWith('https://opencode.ai/inference/go/') && options?.method === 'POST') {
          const body = JSON.parse(options.body);
          row = { bytes: Buffer.byteLength(options.body), outputLimit: body.max_tokens ?? body.max_output_tokens ?? body.generationConfig?.maxOutputTokens,
            session: new Headers(options.headers).get('x-opencode-session') };
          wire.push(row);
        }
        const response = await realFetch(url, options);
        if (row) row.status = response.status;
        return response;
      };
      const machine = new AgentStateMachine({ config: { ...loaded, workspaceRoot: fixture.workspace,
        agentMemoryPath: path.join(fixture.workspace, 'memory.json') }, messages, providerSessionId: sessionId,
        abortSignal: AbortSignal.timeout(180000), send: event => events.push(event) });
      machine.checkpointStore = new AgentCheckpointStore({ dir: path.join(fixture.workspace, 'checkpoints') });
      const execute = machine.executor.execute.bind(machine.executor);
      const mutations = new Set(['write_file', 'patch_file', 'patch_lines', 'apply_patch_transaction']);
      const allowed = new Set(['read_file', 'list_dir', 'inspect_code_context', 'project_search', 'review_patch_transaction', ...mutations]);
      machine.executor.execute = (tool, params, options) => {
        let operations = params.operations || [];
        if (typeof operations === 'string') { try { operations = JSON.parse(operations); } catch { return { ok: false, error: 'Invalid fixture operations' }; } }
        const paths = [params.path, ...(Array.isArray(operations) ? operations.map(item => item?.path ?? item?.params?.path) : [])].filter(Boolean);
        const relative = paths.map(file => path.relative(fixture.workspace, path.resolve(fixture.workspace, file)).replaceAll('\\', '/'));
        if (!allowed.has(tool) || relative.some(file => file === '..' || file.startsWith('../') || path.isAbsolute(file))
          || (mutations.has(tool) && (!relative.length || relative.some(file => !fixture.implementations.includes(file))))) {
          return { ok: false, error: 'Only isolated implementation edits and local observations are allowed in this diagnostic.' };
        }
        return execute(tool, params, options);
      };
      let approvals = 0;
      const reject = payload => { approvals++; queueMicrotask(() => respondToApproval(payload.id, 'reject')); };
      eventBus.on('approval:pending', reject);
      try { await machine.run(); }
      finally { globalThis.fetch = realFetch; eventBus.off('approval:pending', reject); }
      const result = spawnSync(node, ['--test', 'check.test.cjs'], { cwd: fixture.workspace, windowsHide: true, encoding: 'utf8', timeout: 15000 });
      const protectedPreserved = Object.entries(fixture.protectedHashes).every(([file, hash]) => digest(path.join(fixture.workspace, file)) === hash);
      const row = { name, ok: machine.runOutcome?.status === 'completed' && result.status === 0 && protectedPreserved,
        outcome: machine.runOutcome, independentTestExitCode: result.status, protectedPreserved, approvals,
        elapsedMs: Date.now() - started, tools: events.filter(event => event.type === 'tool_start').map(event => event.tool),
        compactions: events.filter(event => event.type === 'state_change' && String(event.payload?.message).startsWith('Context compacted:')).length,
        scanStats: machine.contextEngine.scanStats, wire,
        errors: events.filter(event => event.type === 'error').map(event => runtime.safeError(event.error)) };
      fs.writeFileSync(path.join(directory, `${name}.test.log`), `${result.stdout || ''}${result.stderr || ''}`);
      report.rounds.push(row); save(); console.log(JSON.stringify({ round: name, ok: row.ok, elapsedMs: row.elapsedMs, reason: row.outcome?.reason }));
      return { machine, events, row };
    };
    const task = f => `Read ${f.implementations.join(', ')}. Fix add(a,b) to return a+b, total(items) to sum price*quantity (empty arrays and zero quantities; preserve input), and label(name) to uppercase. Keep CommonJS exports. Make all three file edits with write_file or patch_file. Keep tests/package.json and all generated files unchanged. Use file tools only.`;
    for (let i = 0; i < repeats; i++) {
      const f = fixture(`multi-${i + 1}`);
      await live(`multi-${i + 1}`, f, [{ role: 'user', content: task(f) }], `${label}-multi-${i + 1}`);
    }
    const conversationFixture = fixture('conversation');
    let first = await live('conversation-initial', conversationFixture, [{ role: 'user', content: task(conversationFixture) }], `${label}-conversation`);
    let messages = first.machine.activeConversation;
    if (first.row.ok) for (let i = 0; i < turns; i++) {
      const nonce = crypto.randomUUID(), file = `probe-${i + 1}.txt`;
      fs.writeFileSync(path.join(conversationFixture.workspace, file), nonce);
      const hashes = conversationFixture.implementations.map(file => digest(path.join(conversationFixture.workspace, file)));
      const next = await live(`conversation-${i + 1}`, conversationFixture, [...messages,
        { role: 'assistant', content: `Historical benchmark notes, not an action request: ${'retained local implementation context. '.repeat(160)}` },
        { role: 'user', content: `Observation round ${i + 1}: read the newly created ${file} and quote its current nonce. Report add(-2,7), total([{price:4,quantity:3}]), label('AbC'). Observation only.` }], `${label}-conversation`);
      next.row.evidenceRead = next.events.some(event => event.type === 'tool_start' && event.tool === 'read_file'
        && path.resolve(conversationFixture.workspace, event.params.path) === path.join(conversationFixture.workspace, file));
      next.row.evidenceQuoted = next.events.filter(event => event.type === 'chunk').map(event => event.text || '').join('').includes(nonce);
      next.row.implementationsPreserved = conversationFixture.implementations.every((file, index) => digest(path.join(conversationFixture.workspace, file)) === hashes[index]);
      next.row.ok &&= next.row.evidenceRead && next.row.evidenceQuoted && next.row.implementationsPreserved;
      save(); messages = next.machine.activeConversation;
      if (!next.row.ok) break;
    }
    for (let i = 0; i < repeats; i++) {
      const f = fixture(`large-${i + 1}`, largeFiles);
      await live(`large-${i + 1}`, f, [{ role: 'user', content: task(f) }], `${label}-large-${i + 1}`);
    }
  } catch (error) { report.error = runtime ? runtime.safeError(error) : error.message; }
  finally {
    report.packageHashAtEnd = digest(source);
    report.packageUnchanged = report.packageHashAtStart === report.packageHashAtEnd;
    const after = ['config.json', 'secrets.enc.json'].map(file => digest(path.join(userRoot, file)));
    report.configurationFileUnchanged = before[0] === after[0];
    report.credentialFileUnchanged = before[1] === after[1];
    report.configurationNote = 'Runner never writes user settings; concurrent app/user edits can change these hashes.';
    report.finishedAt = new Date().toISOString();
    report.ok = !report.error && report.packageUnchanged && report.technical.every(row => row.ok) && report.rounds.every(row => row.ok);
    save(); console.log(JSON.stringify({ ok: report.ok, directory, technical: report.technical.length, rounds: report.rounds.length, error: report.error }));
    app.exit(report.ok ? 0 : 1);
  }
}).catch(error => { console.error(`Stability runner failed: ${error.name}`); app.exit(1); });
