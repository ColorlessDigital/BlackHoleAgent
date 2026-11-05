const { app } = require('electron');
const fs = require('node:fs');
const rawFs = require('original-fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const arg = (name, fallback) => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const root = path.resolve(__dirname, '..');
if (!arg('release')) throw new Error('Specify --release explicitly.');
const release = path.resolve(arg('release'));
const source = path.join(release, 'win-unpacked/resources/app.asar');
const label = arg('label', `gguf-${Date.now()}`);
if (!/^[a-z0-9-]+$/.test(label)) throw new Error('Invalid diagnostic label.');
const output = path.join(root, 'data/diagnostics', label);
if (fs.existsSync(output)) throw new Error('Use a fresh label.');
fs.mkdirSync(output, { recursive: true });
process.env.BLACKHOLE_DATA_DIR = path.join(output, 'runtime-data');
process.env.BLACKHOLE_DISABLE_WORKSPACE_STANDARD = '1';
app.setPath('userData', path.join(output, 'electron-profile'));
const digest = file => crypto.createHash('sha256').update((file.endsWith('.asar') ? rawFs : fs).readFileSync(file)).digest('hex');
const user = path.join(process.env.APPDATA, 'BlackHole');
const before = ['config.json', 'secrets.enc.json'].map(name => digest(path.join(user, name)));
const stored = JSON.parse(fs.readFileSync(path.join(user, 'config.json')));
const report = { ok: false, startedAt: new Date().toISOString(), release, packageHashAtStart: digest(source), models: [],
  scope: 'Existing GGUF bytes through packaged llama.cpp; isolated phase-sized context and bounded diagnostic prompts. Stored model/performance settings are not changed.' };
const save = () => fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
app.whenReady().then(async () => {
  let runtime;
  try {
    process.resourcesPath = path.dirname(source);
    const { LlamaCppRuntime } = require(path.join(source, 'src/runtime/llamaCppRuntime.js'));
    const { AgentStateMachine } = require(path.join(source, 'src/agent/core/stateMachine.js'));
    const { AgentCheckpointStore } = require(path.join(source, 'src/agent/core/checkpointStore.js'));
    const { ToolRegistry } = require(path.join(source, 'src/agent/core/toolRegistry.js'));
    const { callLocalModel } = require(path.join(source, 'src/agent/llmRouter.js'));
    const { eventBus } = require(path.join(source, 'src/common/eventBus.js'));
    const { respondToApproval } = require(path.join(source, 'src/security/approvalGate.js'));
    const models = [
      { name: 'Qwen3-4B-Instruct-2507-Q8_0', model: arg('small-model', path.resolve(root, '../.models/blobs/sha256-a3dedb2b35f80964dea238257bf74688c7750f648781831eb7fb5532d7fbf449')), coding: true },
      { name: 'Qwen3.6-35B-A3B-Q4_K_M', model: arg('large-model', path.join(root, 'models/large-model.gguf')), coding: false }
    ];
    const phaseContext = Number(stored.agentModelProfiles?.planner?.contextLimit) || 8192;
    report.testSettings = { contextLimit: phaseContext, storedContextLimit: stored.contextLimit,
      gpuLayers: stored.llamaCppGpuLayers, batch: stored.llamaCppBatch, startupTimeoutMs: stored.llamaCppStartupTimeoutMs,
      requestTimeoutMs: stored.llamaCppRequestTimeoutMs, promptOutputCaps: [256, 4096] };
    for (const definition of models) {
      assert.ok(fs.existsSync(definition.model), `Missing diagnostic model: ${definition.name}`);
      const header = Buffer.alloc(4), fd = fs.openSync(definition.model, 'r');
      fs.readSync(fd, header, 0, 4, 0); fs.closeSync(fd); assert.equal(header.toString(), 'GGUF');
      const diagnosticOutputLimit = definition.coding ? 256 : 1024;
      const row = { name: definition.name, bytes: fs.statSync(definition.model).size, diagnosticOutputLimit,
        checks: [], startedAt: Date.now(), warnings: [] };
      report.models.push(row); save();
      const config = { llamaCppModelPath: definition.model,
        llamaCppServerPath: path.join(release, 'win-unpacked/resources/llama.cpp/llama-server.exe'),
        llamaCppUrl: `http://127.0.0.1:${crypto.randomInt(49152, 65536)}`,
        llamaCppGpuLayers: stored.llamaCppGpuLayers, llamaCppBatch: stored.llamaCppBatch,
        llamaCppThreads: stored.llamaCppThreads, llamaCppParallel: stored.llamaCppParallel,
        contextLimit: phaseContext, llamaCppStartupTimeoutMs: stored.llamaCppStartupTimeoutMs,
        llamaCppRequestTimeoutMs: stored.llamaCppRequestTimeoutMs };
      runtime = new LlamaCppRuntime(config);
      const warning = event => { if (event.level === 'warning') row.warnings.push(String(event.message || event.log || '').slice(0, 800)); };
      eventBus.on('log', warning);
      try {
        const stopStartup = new AbortController();
        const timer = setTimeout(() => stopStartup.abort(), 200);
        try { await runtime.startServer({}, { signal: stopStartup.signal }); }
        catch (error) { assert.equal(error.name, 'AbortError'); }
        finally { clearTimeout(timer); }
        assert.equal((await runtime.status()).managedProcessId, null);
        row.checks.push({ name: 'cancel-during-startup', ok: true }); save();
        assert.equal(await runtime.ensureServerRunning(), true);
        row.launch = (await runtime.status()).lastLaunch;
        for (let i = 0; i < 3; i++) {
          let text = '', reasoningChars = 0;
          const started = Date.now();
          await runtime.chatStream({ model: 'llamacpp:local-gguf', messages: [{ role: 'user', content: 'Reply with BLACKHOLE_OK and stop.' }],
            maxTokens: diagnosticOutputLimit, temperature: 0, onReasoning: value => { reasoningChars += value.length; } }, value => { text += value; });
          assert.ok(text.includes('BLACKHOLE_OK'));
          row.checks.push({ name: `short-stream-${i + 1}`, ok: true, elapsedMs: Date.now() - started, reasoningChars }); save();
        }
        const stop = new AbortController();
        let received = false;
        await assert.rejects(runtime.chatStream({ model: 'llamacpp:local-gguf', messages: [{ role: 'user', content: 'Count upward starting at one. Keep counting.' }],
          maxTokens: 4096, temperature: 0, signal: stop.signal }, () => { received = true; stop.abort(); }), { name: 'AbortError' });
        assert.equal(received, true);
        row.checks.push({ name: 'cancel-active-inference', ok: true });
        let recovered = '';
        await runtime.chatStream({ model: 'llamacpp:local-gguf', messages: [{ role: 'user', content: 'Reply with BLACKHOLE_OK and stop.' }], maxTokens: diagnosticOutputLimit, temperature: 0 }, value => { recovered += value; });
        assert.ok(recovered.includes('BLACKHOLE_OK'));
        row.checks.push({ name: 'same-server-after-cancellation', ok: true }); save();
        let longAnswer = '';
        const history = [{ role: 'user', content: 'Report BLACKHOLE_OK when asked for the current status.' },
          ...Array.from({ length: 24 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `Old unrelated record ${i}: ${'context detail retained. '.repeat(100)}` })),
          { role: 'user', content: 'Report the current status by replying BLACKHOLE_OK only.' }];
        await callLocalModel({ ...stored, ...config, activeModel: 'llamacpp:local-gguf', maxTokens: diagnosticOutputLimit, agentModelRoutingEnabled: false },
          'Answer the current user request concisely.', history, value => { longAnswer += value; }, { phase: 'plan' });
        assert.ok(longAnswer.includes('BLACKHOLE_OK'));
        row.checks.push({ name: 'long-history-context-guard', ok: true, historyMessages: history.length }); save();
        if (definition.coding) for (let round = 1; round <= 3; round++) {
          const workspace = path.join(output, `coding-${round}`); fs.mkdirSync(workspace);
          fs.writeFileSync(path.join(workspace, 'math.cjs'), 'exports.add=(a,b)=>a-b;\n');
          const testBody = "const test=require('node:test'),a=require('node:assert/strict'),f=require('./math.cjs');test('addition',()=>{a.equal(f.add(-2,7),5);a.equal(f.add(0,0),0);a.equal(f.add(4,3),7);});\n";
          fs.writeFileSync(path.join(workspace, 'math.test.cjs'), testBody);
          const events = [];
          const machine = new AgentStateMachine({ config: { ...stored, ...config, activeModel: 'llamacpp:local-gguf', maxTokens: 4096,
            workspaceRoot: workspace, agentModelRoutingEnabled: false, agentMemoryEnabled: false },
          messages: [{ role: 'user', content: 'Read math.cjs and fix add(a,b) to return a+b. Existing math.test.cjs must remain unchanged. Only edit math.cjs, using file tools. Do not create tests or run shell tool calls; automatic verification runs the existing test.' }],
          abortSignal: AbortSignal.timeout(180000), send: event => events.push(event) });
          machine.checkpointStore = new AgentCheckpointStore({ dir: path.join(output, `coding-${round}-checkpoints`) });
          const execute = machine.executor.execute.bind(machine.executor);
          const allowed = ['read_file', 'list_dir', 'inspect_code_context', 'project_search', 'write_file', 'patch_file', 'patch_lines'];
          machine.getModelTools = () => ToolRegistry.getAllTools().filter(tool => allowed.includes(tool.name));
          machine.executor.execute = (tool, params, options) => {
            const target = params.path && path.resolve(workspace, params.path);
            const relative = target && path.relative(workspace, target);
            if (!allowed.includes(tool) || (relative && (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)))
              || (['write_file', 'patch_file', 'patch_lines'].includes(tool) && target !== path.join(workspace, 'math.cjs'))) return { ok: false, error: 'Only the isolated math implementation may be edited; its existing tests may be read.' };
            return execute(tool, params, options);
          };
          const reject = event => queueMicrotask(() => respondToApproval(event.id, 'reject'));
          eventBus.on('approval:pending', reject);
          try { await machine.run(); }
          finally { eventBus.off('approval:pending', reject); }
          const checked = spawnSync(path.resolve(root, '../node-v24.22.2-win-x64/node.exe'), ['-e', "const a=require('node:assert/strict');const f=require('./math.cjs');a.equal(f.add(-2,7),5);a.equal(f.add(0,0),0);"],
            { cwd: workspace, windowsHide: true, encoding: 'utf8', timeout: 15000 });
          row.checks.push({ name: `agent-file-edit-${round}`, ok: machine.runOutcome.status === 'completed' && checked.status === 0,
            outcome: machine.runOutcome, independentTestExitCode: checked.status,
            testFilePreserved: fs.readFileSync(path.join(workspace, 'math.test.cjs'), 'utf8') === testBody,
            verification: events.filter(event => event.state === 'VERIFY' && event.payload?.results).map(event => event.payload.results) });
          row.checks.at(-1).ok &&= row.checks.at(-1).testFilePreserved;
          save();
        }
        row.ok = row.checks.every(check => check.ok);
      } catch (error) { row.error = error.message; row.ok = false; }
      finally { await runtime.stopServer(); eventBus.off('log', warning); row.elapsedMs = Date.now() - row.startedAt; save(); }
      console.log(JSON.stringify({ model: row.name, ok: row.ok, checks: row.checks.length, elapsedMs: row.elapsedMs, error: row.error }));
    }
    report.ok = report.models.every(row => row.ok);
  } catch (error) { report.error = error.message; }
  finally {
    if (runtime) await runtime.stopServer();
    report.packageHashAtEnd = digest(source);
    report.packageUnchanged = report.packageHashAtStart === report.packageHashAtEnd;
    const after = ['config.json', 'secrets.enc.json'].map(name => digest(path.join(user, name)));
    report.configurationFileUnchanged = before[0] === after[0]; report.credentialFileUnchanged = before[1] === after[1];
    report.finishedAt = new Date().toISOString(); report.ok &&= report.packageUnchanged;
    save(); console.log(JSON.stringify({ ok: report.ok, output, error: report.error })); app.exit(report.ok ? 0 : 1);
  }
}).catch(error => { console.error(error.name); app.exit(1); });
