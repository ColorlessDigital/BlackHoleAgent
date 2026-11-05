// Isolated, seeded-fault tests in pinned third-party repositories. No upstream edits or publishing.
const { app } = require('electron');
const fs = require('node:fs');
const rawFs = require('original-fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const arg = (name, fallback) => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const root = path.resolve(__dirname, '..');
const release = path.resolve(arg('release', ''));
if (!arg('release')) throw new Error('Specify --release explicitly.');
const source = path.join(release, 'win-unpacked/resources/app.asar');
const label = arg('label', `real-repos-${Date.now()}`);
if (!/^[a-z0-9-]+$/.test(label)) throw new Error('Invalid diagnostic label.');
const minutes = Number(arg('minutes', 60));
if (!Number.isFinite(minutes) || minutes < 1 || minutes > 120) throw new Error('Use --minutes=1..120.');
const input = path.resolve(arg('upstream', path.join(root, 'data/diagnostics/stabilized-15/upstream')));
const tools = path.resolve(arg('test-tools', path.join(root, 'data/diagnostics/stabilized-15/test-tools/node_modules')));
const output = path.join(root, 'data/diagnostics', label);
if (fs.existsSync(output)) throw new Error('Use a fresh label; do not erase earlier failures.');
fs.mkdirSync(output, { recursive: true });
const user = path.join(process.env.APPDATA, 'BlackHole');
const digest = file => crypto.createHash('sha256').update((file.endsWith('.asar') ? rawFs : fs).readFileSync(file)).digest('hex');
const before = ['config.json', 'secrets.enc.json'].map(name => digest(path.join(user, name)));
app.setPath('userData', user);
const cache = fs.mkdtempSync(path.join(os.tmpdir(), 'bh-real-repos-'));
const state = JSON.parse(fs.readFileSync(path.join(user, 'Local State')));
fs.writeFileSync(path.join(cache, 'Local State'), JSON.stringify({ os_crypt: state.os_crypt }));
app.setPath('sessionData', cache);
const report = { ok: false, startedAt: new Date().toISOString(), release, packageHashAtStart: digest(source),
  sourceHash: JSON.parse(fs.readFileSync(path.join(release, 'BUILDINFO.json'))).sourceHash,
  minutes, rounds: [], provenance: [], scope: 'Pinned real repositories with explicitly seeded faults, immutable tests/config and independent assertions. Not newly discovered upstream bugs or full upstream browser/type test certification.' };
const save = () => fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
const walk = (directory, prefix = '') => fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
  if (['.git', 'node_modules', 'checkpoints'].includes(entry.name)) return [];
  const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
  return entry.isDirectory() ? walk(path.join(directory, entry.name), relative) : [relative];
});
const definitions = [
  { id: 'axios', tag: 'v1.7.9', commit: 'b2cb45d5a533a5465c99559b16987e4d5fc08cbc', file: 'lib/helpers/isAbsoluteURL.js',
    seed: text => text.replace(/return \/\^.*\.test\(url\);/, 'return false;'),
    goal: 'Restore isAbsoluteURL: accept scheme:// and protocol-relative // URLs, reject relative paths, support case-insensitive scheme names and RFC scheme characters.',
    assertions: `const f=(await import(url.pathToFileURL(target).href)).default; for(const s of ['https://x','//cdn/x','HTTP://x','a+b.c-d://x']) a.equal(f(s),true);for(const s of ['/local','relative','https:x',''])a.equal(f(s),false);` },
  { id: 'commander', tag: 'v14.0.0', commit: '395cf7145fe28122f5a69026b310e02df114f907', file: 'lib/argument.js',
    seed: text => text.replace('this.defaultValue = value;', 'this.defaultValue = undefined;'),
    goal: 'Restore Argument.default(value, description): retain the exact supplied value including false, zero and null; retain its description and return the same Argument for chaining.',
    assertions: `const {Argument}=req(target);for(const v of [0,false,null,'ok']){const x=new Argument('[value]');a.equal(x.default(v,'description'),x);a.equal(x.defaultValue,v);a.equal(x.defaultValueDescription,'description');}` },
  { id: 'ms', tag: '2.1.3', commit: '1c6264b795492e8fdecbc82cb8802fcfbfc08d26', file: 'index.js',
    seed: text => text.replace('var m = s * 60;', 'var m = s * 6;'),
    goal: 'Restore duration unit conversion: a minute is 60 seconds; keep hours/days/weeks/years and short/long formatting consistent without changing the public API.',
    assertions: `const f=req(target);a.equal(f('2m'),120000);a.equal(f('1h'),3600000);a.equal(f('1d'),86400000);a.equal(f(120000),'2m');a.equal(f(120000,{long:true}),'2 minutes');a.equal(f('1s'),1000);` }
];
app.whenReady().then(async () => {
  let runtime;
  try {
    process.resourcesPath = path.dirname(source);
    const { loadConfig } = require(path.join(source, 'src/config/configStore.js'));
    const config = loadConfig();
    assert.ok(String(config.activeModel).startsWith('opencode-go:'), 'Select a Go model before account tests.');
    process.env.BLACKHOLE_DATA_DIR = path.join(output, 'runtime-data');
    process.env.BLACKHOLE_DISABLE_WORKSPACE_STANDARD = '1';
    const { AgentStateMachine } = require(path.join(source, 'src/agent/core/stateMachine.js'));
    const { ToolRegistry } = require(path.join(source, 'src/agent/core/toolRegistry.js'));
    const { AgentCheckpointStore } = require(path.join(source, 'src/agent/core/checkpointStore.js'));
    const { OpenCodeGoRuntime } = require(path.join(source, 'src/runtime/openCodeGoRuntime.js'));
    const { eventBus } = require(path.join(source, 'src/common/eventBus.js'));
    const { respondToApproval } = require(path.join(source, 'src/security/approvalGate.js'));
    runtime = new OpenCodeGoRuntime(config);
    report.model = config.activeModel;
    const node = path.resolve(root, '../node-v24.22.2-win-x64/node.exe');
    for (const definition of definitions) {
      const directory = path.join(input, definition.id);
      const revision = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: directory, encoding: 'utf8', windowsHide: true });
      assert.equal(revision.stdout.trim(), definition.commit);
      report.provenance.push({ id: definition.id, tag: definition.tag, commit: definition.commit, files: walk(directory).length });
    }
    function fixture(definition, name, existingWorkspace) {
      const workspace = existingWorkspace || path.join(output, name);
      if (!existingWorkspace) fs.cpSync(path.join(input, definition.id), workspace, { recursive: true, filter: file => path.basename(file) !== '.git' });
      const target = path.join(workspace, definition.file);
      const original = fs.readFileSync(target, 'utf8');
      if (!existingWorkspace) {
        const seeded = definition.seed(original);
        assert.notEqual(seeded, original, 'Seed must change exactly the intended upstream file.');
        fs.writeFileSync(target, seeded);
      }
      const assertion = path.join(output, `${name}.assert.mjs`);
      fs.writeFileSync(assertion, `import a from 'node:assert/strict';import{createRequire}from'node:module';import*as url from'node:url';const req=createRequire(import.meta.url),target=${JSON.stringify(target)};${definition.assertions}`);
      const protectedFiles = walk(workspace).filter(file => file !== definition.file);
      const hashes = protectedFiles.map(file => digest(path.join(workspace, file)));
      const independent = () => spawnSync(node, [assertion], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
      if (!existingWorkspace) assert.notEqual(independent().status, 0, 'The seeded fault must fail the independent assertions.');
      return { workspace, target, definition, independent, protectedFiles, hashes };
    }
    function upstreamTests(f) {
      const env = { ...process.env, NODE_PATH: tools };
      if (f.definition.id === 'ms') return spawnSync(node, [path.join(tools, 'mocha/bin/mocha.js'), 'tests.js'], { cwd: f.workspace, env, windowsHide: true, encoding: 'utf8', timeout: 30000 });
      if (f.definition.id === 'commander') return spawnSync(node, [path.join(tools, 'jest/bin/jest.js'), '--runInBand', '--testPathPattern=argument\\.',
        `--config=${JSON.stringify({ rootDir: f.workspace, testEnvironment: 'node', transform: {}, collectCoverage: false })}`],
      { cwd: f.workspace, env, windowsHide: true, encoding: 'utf8', timeout: 60000 });
      return null;
    }
    if (process.argv.includes('--prepare-only')) {
      report.prepareOnly = true;
      for (const definition of definitions) {
        const f = fixture(definition, `baseline-${definition.id}`);
        fs.copyFileSync(path.join(input, definition.id, definition.file), f.target);
        const checked = f.independent(), upstream = upstreamTests(f);
        report.rounds.push({ name: `baseline-${definition.id}`, ok: checked.status === 0 && (!upstream || upstream.status === 0),
          seededAssertionFailureVerified: true, pristineAssertionExitCode: checked.status, upstreamTestExitCode: upstream?.status ?? null });
        fs.writeFileSync(path.join(output, `${definition.id}.baseline.log`), `${checked.stdout || ''}${checked.stderr || ''}\n${upstream?.stdout || ''}${upstream?.stderr || ''}`);
      }
      report.ok = report.rounds.every(row => row.ok);
      return;
    }
    async function run(f, name, messages, { resume, stopAfterMutation = false, readOnly = false } = {}) {
      const started = Date.now(), events = [], controller = new AbortController();
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(180000)]);
      let lastSaved = 0;
      const targetBefore = digest(f.target);
      const machine = new AgentStateMachine({ config: { ...config, workspaceRoot: f.workspace, agentMemoryPath: path.join(output, 'memory.json') },
        messages, resumeCheckpoint: resume || null, providerSessionId: `${label}-${path.basename(f.workspace)}`,
        abortSignal: signal, send(event) {
          events.push(event);
          if (stopAfterMutation && event.type === 'tool_end' && event.result?.ok === true && digest(f.target) !== targetBefore) controller.abort();
          if (event.type === 'status' && Date.now() - lastSaved > 5000) {
            report.current = { name, elapsedMs: Date.now() - started, status: event.status };
            lastSaved = Date.now(); save();
          }
        } });
      machine.checkpointStore = new AgentCheckpointStore({ dir: path.join(output, `${name}-checkpoints`) });
      const execute = machine.executor.execute.bind(machine.executor);
      const mutations = new Set(['write_file', 'patch_file', 'patch_lines', 'apply_patch_transaction']);
      const allowed = new Set(['read_file', 'list_dir', 'inspect_code_context', 'project_search', 'review_patch_transaction', ...mutations]);
      machine.getModelTools = () => ToolRegistry.getAllTools().filter(tool => allowed.has(tool.name) && (!readOnly || !mutations.has(tool.name)));
      machine.executor.execute = (tool, params, options) => {
        let operations = params.operations || [];
        if (typeof operations === 'string') { try { operations = JSON.parse(operations); } catch { return { ok: false, error: 'Invalid diagnostic operations.' }; } }
        const paths = [params.path, ...(Array.isArray(operations) ? operations.map(item => item?.path ?? item?.params?.path) : [])].filter(Boolean);
        const relative = paths.map(file => path.relative(f.workspace, path.resolve(f.workspace, file)).replaceAll('\\', '/'));
        if (!allowed.has(tool) || relative.some(file => file === '..' || file.startsWith('../') || path.isAbsolute(file))
          || (mutations.has(tool) && (readOnly || !relative.length || relative.some(file => file !== f.definition.file)))) {
          return { ok: false, error: 'This diagnostic permits isolated target implementation edits and file observations only.' };
        }
        return execute(tool, params, options);
      };
      // Independent verification adapter: avoids running unrelated browser/type tooling or allowing test edits.
      machine.verificationEngine.runVerificationSuite = async () => {
        const checked = f.independent();
        return { ok: checked.status === 0, results: { syntax: { ok: true, skipped: true }, test: { ok: checked.status === 0, output: checked.stderr || checked.stdout }, lint: { ok: true, skipped: true } } };
      };
      let approvals = 0;
      const reject = event => { approvals++; queueMicrotask(() => respondToApproval(event.id, 'reject')); };
      eventBus.on('approval:pending', reject);
      try { await machine.run(); }
      finally { eventBus.off('approval:pending', reject); }
      const checked = f.independent();
      const upstream = checked.status === 0 && !readOnly ? upstreamTests(f) : null;
      const preserved = f.protectedFiles.every((file, i) => digest(path.join(f.workspace, file)) === f.hashes[i]);
      const row = { name, repository: f.definition.id, outcome: machine.runOutcome, elapsedMs: Date.now() - started,
        independentTestExitCode: checked.status, upstreamTestExitCode: upstream?.status ?? null, upstreamTestRun: Boolean(upstream),
        protectedFiles: f.protectedFiles.length, protectedPreserved: preserved, approvals,
        tools: events.filter(event => event.type === 'tool_start').map(event => event.tool),
        compactions: events.filter(event => event.type === 'state_change' && String(event.payload?.message).startsWith('Context compacted:')).length,
        diagnosticDeadlineMs: 180000, diagnosticDeadlineReached: signal.aborted && signal.reason?.name === 'TimeoutError',
        expectedStop: stopAfterMutation, resumed: Boolean(resume),
        sameSession: !resume || machine.checkpoint.sessionId === resume.sessionId,
        ok: (stopAfterMutation ? machine.runOutcome.status === 'stopped' : machine.runOutcome.status === 'completed')
          && checked.status === 0 && preserved && (!upstream || upstream.status === 0) && (!readOnly || digest(f.target) === targetBefore) };
      fs.writeFileSync(path.join(output, `${name}.test.log`), `${checked.stdout || ''}${checked.stderr || ''}\n${upstream?.stdout || ''}${upstream?.stderr || ''}`);
      report.rounds.push(row); save(); console.log(JSON.stringify({ name, ok: row.ok, elapsedMs: row.elapsedMs, reason: row.outcome.reason }));
      return { row, machine, events };
    }
    if (arg('resume-checkpoints')) {
      const directory = fs.realpathSync(path.resolve(arg('resume-checkpoints')));
      const allowedRoot = fs.realpathSync(path.join(root, 'data/diagnostics')) + path.sep;
      assert.ok(directory.toLowerCase().startsWith(allowedRoot.toLowerCase()));
      const checkpoint = new AgentCheckpointStore({ dir: directory }).loadLatest();
      assert.ok(checkpoint);
      const workspace = fs.realpathSync(checkpoint.workspaceRoot);
      assert.ok(workspace.toLowerCase().startsWith(allowedRoot.toLowerCase()));
      const definition = definitions.find(item => item.id === arg('resume-repo'));
      assert.ok(definition, 'Specify the pinned repository with --resume-repo.');
      fs.writeFileSync(path.join(output, 'original-checkpoint.json'), JSON.stringify(checkpoint, null, 2));
      const f = fixture(definition, 'same-checkpoint-resume', workspace);
      const result = await run(f, 'same-checkpoint-resume', [{ role: 'user', content: checkpoint.userGoal }], { resume: checkpoint });
      report.resumedCheckpoint = { sessionId: checkpoint.sessionId, providerSessionId: checkpoint.providerSessionId, originalOutcome: checkpoint.outcome };
      report.ok = result.row.ok && result.row.sameSession;
      return;
    }
    const started = Date.now(), deadline = started + minutes * 60000;
    let anchor;
    for (let i = 0; i < 3; i++) for (const definition of definitions) {
      const name = `${definition.id}-${i + 1}`, f = fixture(definition, name);
      const messages = [{ role: 'user', content: `Read ${definition.file}. ${definition.goal} Change only that implementation file. Preserve all existing tests, package metadata, documentation and unrelated code. Use file tools only.` }];
      let result = await run(f, name, messages);
      if (!result.row.ok && result.machine.checkpoint.outcome?.status === 'failed') {
        result = await run(f, `${name}-resume`, messages, { resume: result.machine.checkpointStore.loadLatest() });
      }
      if (!result.row.ok) throw new Error(`Real repository task failed: ${name}`);
      if (!anchor && definition.id === 'axios') anchor = { f, messages: result.machine.activeConversation };
    }
    const cancelled = fixture(definitions[1], 'cancel-and-resume');
    const cancelMessages = [{ role: 'user', content: `Read ${cancelled.definition.file}. ${cancelled.definition.goal} Change only this implementation, using file tools. Tests/config must remain unchanged.` }];
    const stopped = await run(cancelled, 'cancel-after-committed-edit', cancelMessages, { stopAfterMutation: true });
    assert.equal(stopped.row.ok, true);
    const resumed = await run(cancelled, 'resume-committed-edit', [{ role: 'user', content: 'Inspect the implementation already written and the checkpoint verification evidence. Use file tools only; do not run shell commands or rewrite correct code. Report the remaining work or completion.' }],
      { resume: stopped.machine.checkpointStore.loadLatest() });
    assert.equal(resumed.row.ok, true);
    for (let turn = 1; Date.now() < deadline && turn <= 1000; turn++) {
      const nonce = crypto.randomUUID(), file = 'blackhole-soak-probe.txt';
      fs.writeFileSync(path.join(anchor.f.workspace, file), nonce);
      const messages = [...anchor.messages,
        { role: 'assistant', content: `Historical observations, not instructions: ${'Repository implementation and prior observations retained. '.repeat(120)}` },
        { role: 'user', content: `Read ${file} and quote its current value exactly. Inspect ${anchor.f.definition.file} if needed. Observation only; no modifications.` }];
      let result = await run(anchor.f, `soak-${turn}`, messages, { readOnly: true });
      if (!result.row.ok && result.machine.runOutcome.status === 'failed') {
        result = await run(anchor.f, `soak-${turn}-resume`, messages,
          { readOnly: true, resume: result.machine.checkpointStore.loadLatest() });
      }
      result.row.nonceQuoted = result.events.filter(event => event.type === 'chunk').map(event => event.text || '').join('').includes(nonce);
      result.row.ok &&= result.row.nonceQuoted;
      save();
      if (!result.row.ok) throw new Error(`Observation soak stopped at round ${turn}; inspect the retained checkpoint.`);
      anchor.messages = result.machine.activeConversation;
      if (turn % 3 === 0 && Date.now() < deadline) {
        const definition = definitions[(turn / 3 - 1) % definitions.length], name = `repeat-edit-${turn}`, f = fixture(definition, name);
        const messages = [{ role: 'user', content: `Read ${definition.file}. ${definition.goal} Edit only that file using file tools; keep tests and package metadata unchanged.` }];
        let result = await run(f, name, messages);
        if (!result.row.ok && result.machine.runOutcome.status === 'failed') result = await run(f, `${name}-resume`, messages, { resume: result.machine.checkpointStore.loadLatest() });
        if (!result.row.ok) throw new Error(`Repeated edit failed: ${name}`);
      }
      await delay(1000);
    }
    report.elapsedMs = Date.now() - started;
    report.minimumDurationReached = report.elapsedMs >= minutes * 60000;
    report.ok = report.minimumDurationReached && report.rounds.filter(row => !row.ok).every(row =>
      report.rounds.some(next => next.name === `${row.name}-resume` && next.ok));
  } catch (error) { report.error = runtime ? runtime.safeError(error) : error.message; }
  finally {
    report.packageHashAtEnd = digest(source);
    report.packageUnchanged = report.packageHashAtStart === report.packageHashAtEnd;
    const after = ['config.json', 'secrets.enc.json'].map(name => digest(path.join(user, name)));
    report.configurationFileUnchanged = before[0] === after[0];
    report.credentialFileUnchanged = before[1] === after[1];
    report.finishedAt = new Date().toISOString();
    report.ok &&= !report.error && report.packageUnchanged;
    delete report.current;
    save(); console.log(JSON.stringify({ ok: report.ok, rounds: report.rounds.length, output, error: report.error }));
    app.exit(report.ok ? 0 : 1);
  }
}).catch(error => { console.error(error.name); app.exit(1); });
