// Run with Electron and --live. This consumes the saved Go account's usage.
if (!process.argv.includes('--live')) throw new Error('Pass --live to authorize real Go agent inference.');
const { app } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const userRoot = process.env.BLACKHOLE_DATA_DIR || path.join(process.env.APPDATA, 'BlackHole');
app.setPath('userData', userRoot);

app.whenReady().then(async () => {
  const root = process.env.BLACKHOLE_SOURCE_ROOT || path.resolve(__dirname, '..');
  if (root.endsWith('.asar')) process.resourcesPath = path.dirname(root);
  const label = process.argv.find(a => a.startsWith('--label='))?.slice(8) || `go-agent-${Date.now()}`;
  if (!/^[a-zA-Z0-9-]+$/.test(label)) throw new Error('Invalid diagnostic label');
  const artifacts = path.join(path.resolve(__dirname, '..'), 'data', 'diagnostics', label);
  fs.mkdirSync(artifacts, { recursive: true });
  const digest = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const userDigest = name => digest(path.join(userRoot, name));
  const before = ['config.json', 'secrets.enc.json'].map(userDigest);
  const report = { ok: false, startedAt: new Date().toISOString(), source: root, models: [],
    scope: 'Real inference, file read/edit, independent Node tests; isolated fixture only; no UI interaction.' };
  const multiFile = process.argv.includes('--multi-file');
  const withMcp = process.argv.includes('--with-mcp');
  report.scenario = `${multiFile ? 'two-module-repair' : 'single-function-repair'}${withMcp ? '-mcp' : ''}`;
  const { createBuildInfo } = require(path.join(__dirname, 'release-metadata.js'));
  report.sourceHashAtStart = createBuildInfo(path.resolve(__dirname, '..'), process.platform).sourceHash;
  const save = () => fs.writeFileSync(path.join(artifacts, 'report.json'), JSON.stringify(report, null, 2));
  let runtime;
  let mcpManager;
  try {
    const { loadConfig } = require(path.join(root, 'src/config/configStore.js'));
    const config = loadConfig();
    if (process.env.BLACKHOLE_TEST_OUTPUT_LIMITS) {
      const { normalizeGoModelTokenLimits } = require(path.join(root, 'src/config/goModelSettings.js'));
      const limits = normalizeGoModelTokenLimits(JSON.parse(process.env.BLACKHOLE_TEST_OUTPUT_LIMITS), { strict: true });
      config.opencodeGoModelMaxTokens = { ...config.opencodeGoModelMaxTokens, ...limits };
      report.inMemoryModelOutputLimits = limits;
    }
    const { OpenCodeGoRuntime, resolveGoProtocol, getGoModels } = require(path.join(root, 'src/runtime/openCodeGoRuntime.js'));
    runtime = new OpenCodeGoRuntime(config);
    if (!runtime.isConfigured()) throw new Error('Saved Go key is not configured.');
    await runtime.catalog.refresh({ force: true });
    const requested = process.argv.find(a => a.startsWith('--models='))?.slice(9);
    const models = requested ? requested.split(',') : getGoModels(config).map(m => m.name);
    report.totalModels = models.length;
    // Imports below bind their audit/usage paths to diagnostics, not the live app.
    process.env.BLACKHOLE_DATA_DIR = artifacts;
    const { AgentStateMachine } = require(path.join(root, 'src/agent/core/stateMachine.js'));
    const { AgentCheckpointStore } = require(path.join(root, 'src/agent/core/checkpointStore.js'));
    const { eventBus } = require(path.join(root, 'src/common/eventBus.js'));
    const { respondToApproval } = require(path.join(root, 'src/security/approvalGate.js'));
    const { registerMcpProxyTools } = require(path.join(root, 'src/mcp/mcpToolBridge.js'));
    const { mcpClientManager } = require(path.join(root, 'src/mcp/mcpClient.js'));
    mcpManager = mcpClientManager;
    const node = process.env.BLACKHOLE_TEST_NODE || path.resolve(__dirname, '..', '..', 'node-v24.21.0-win-x64', 'node.exe');
    const realFetch = globalThis.fetch;
    let requestSizes = [];
    let wire = [];
    const partShape = part => ({ keys: Object.keys(part), textCharacters: part.text?.length,
      thought: part.thought, signatureCharacters: part.thoughtSignature?.length,
      signatureHash: part.thoughtSignature ? crypto.createHash('sha256').update(part.thoughtSignature).digest('hex') : undefined,
      functionCall: part.functionCall ? { id: part.functionCall.id, name: part.functionCall.name, argumentNames: Object.keys(part.functionCall.args || {}) } : undefined,
      functionResponse: part.functionResponse ? { id: part.functionResponse.id, name: part.functionResponse.name, responseKeys: Object.keys(part.functionResponse.response || {}) } : undefined });
    globalThis.fetch = async (url, options) => {
      const goRequest = String(url).startsWith('https://opencode.ai/inference/go/') && options?.method === 'POST';
      let entry;
      if (goRequest) {
        requestSizes.push(Buffer.byteLength(options.body || ''));
        const body = JSON.parse(options.body);
        entry = { endpoint: String(url), bytes: requestSizes.at(-1), outputTokenLimit: body.max_tokens ?? body.max_output_tokens ?? body.generationConfig?.maxOutputTokens,
          contents: body.contents?.map(c => ({ role: c.role, parts: c.parts.map(partShape) })) };
        wire.push(entry);
      }
      const response = await realFetch(url, options);
      if (entry) {
        entry.status = response.status;
        if (!response.ok) entry.errorBody = runtime.safeError(await response.clone().text()).slice(0, 2000);
        else if (String(url).includes('/google/')) {
          entry.parts = [];
          response.clone().text().then(text => {
            for (const line of text.split('\n')) {
              if (!line.startsWith('data:')) continue;
              try {
                const data = JSON.parse(line.slice(5));
                entry.parts.push(...(data.candidates?.[0]?.content?.parts || []).map(partShape));
                if (data.candidates?.[0]?.finishReason) entry.finishReason = data.candidates[0].finishReason;
              } catch {}
            }
          }).catch(() => {});
        }
      }
      return response;
    };
    let consecutiveAccountFailures = 0;
    for (const model of models) {
      const row = { model, protocol: resolveGoProtocol(model, config), status: 'unverified', tools: [] };
      const started = Date.now();
      if (!row.protocol) {
        const probe = await new OpenCodeGoRuntime({ ...config, opencodeGoDefaultModel: model }).testConnection();
        row.protocolProbe = probe;
        row.protocol = probe.ok ? probe.protocol : null;
        if (!row.protocol) {
          row.status = 'protocol_unavailable'; row.elapsedMs = Date.now() - started;
          report.models.push(row); console.log(JSON.stringify(row)); save(); continue;
        }
      }
      const workspace = path.join(artifacts, crypto.createHash('sha256').update(model).digest('hex').slice(0, 16));
      fs.mkdirSync(workspace, { recursive: true });
      fs.writeFileSync(path.join(workspace, 'calc.cjs'), 'exports.add = (a, b) => a - b;\n');
      fs.writeFileSync(path.join(workspace, 'calc.test.cjs'), "const {test}=require('node:test');const assert=require('node:assert/strict');const {add}=require('./calc.cjs');test('addition',()=>{assert.equal(add(2,3),5);assert.equal(add(-4,2),-2);assert.equal(add(0,0),0);});\n");
      if (multiFile) {
        fs.writeFileSync(path.join(workspace, 'cart.cjs'), 'exports.total = items => items.reduce((sum, item) => sum + item.price, 0);\n');
        fs.appendFileSync(path.join(workspace, 'calc.test.cjs'), "const {total}=require('./cart.cjs');test('cart quantities',()=>{const items=[{price:12,quantity:3},{price:5,quantity:2}];const before=JSON.stringify(items);assert.equal(total(items),46);assert.equal(JSON.stringify(items),before);assert.equal(total([]),0);assert.equal(total([{price:7,quantity:0}]),0);assert.equal(total([{price:1.5,quantity:2}]),3);});\n");
      }
      fs.writeFileSync(path.join(workspace, 'package.json'), JSON.stringify({ name: 'go-agent-fixture', scripts: { test: 'node --test calc.test.cjs' } }));
      const testBefore = digest(path.join(workspace, 'calc.test.cjs'));
      const packageBefore = digest(path.join(workspace, 'package.json'));
      const events = [];
      const stop = new AbortController();
      const fixtureMcp = { enabled: true, permissions: { 'fixture/read_file': 'allow' }, servers: { fixture: {
        enabled: true, command: node, cwd: workspace, args: ['-e', `
          const fs = require('node:fs'), path = require('node:path'), readline = require('node:readline');
          const reads = [];
          const send = (id,result) => console.log(JSON.stringify({jsonrpc:'2.0',id,result}));
          readline.createInterface({input:process.stdin}).on('line', line => {
            const m = JSON.parse(line);
            if (m.method === 'initialize') send(m.id,{protocolVersion:'2025-06-18',capabilities:{tools:{}},serverInfo:{name:'fixture'}});
            else if (m.method === 'tools/list') send(m.id,{tools:[{name:'read_file',description:'Read calc.cjs or cart.cjs from the current task fixture.',inputSchema:{type:'object',properties:{path:{type:'string'}},required:['path']}}]});
            else if (m.method === 'tools/call') {
              if (m.params.name === 'stats') return send(m.id,{reads});
              const file = path.resolve(m.params.arguments.path || '');
              if (!['calc.cjs','cart.cjs'].some(name => file === path.resolve(name))) {
                return send(m.id,{isError:true,content:[{type:'text',text:'Only fixture implementation files may be read.'}]});
              }
              let text;
              try { text = fs.readFileSync(file,'utf8'); }
              catch { return send(m.id,{isError:true,content:[{type:'text',text:'Fixture file could not be read.'}]}); }
              reads.push(path.basename(file));
              send(m.id,{content:[{type:'text',text}],structuredContent:{path:path.basename(file),content:text}});
            }
          });
        `]
      } } };
      const machineConfig = { ...config, workspaceRoot: workspace,
        activeModel: `opencode-go:${model}`, opencodeGoEnabled: true, agentModelRoutingEnabled: false,
        agentMemoryPath: path.join(workspace, 'memory.json'), ...(withMcp ? { mcp: fixtureMcp } : {}) };
      if (withMcp) {
        const registered = await registerMcpProxyTools(machineConfig);
        if (!registered.ok) throw new Error('MCP fixture registration failed.');
      }
      const machine = new AgentStateMachine({ config: machineConfig,
      messages: [{ role: 'user', content: (multiFile
        ? 'Read both calc.cjs and cart.cjs. Fix add(a,b) to return a+b, and total(items) to sum price*quantity, including empty arrays and zero quantities, without mutating input. Keep CommonJS exports. Complete both actual file edits using file tools only. Do not run commands, use network tools, or change calc.test.cjs/package.json.'
        : 'Read calc.cjs, then fix add(a,b) to return a+b. Keep its CommonJS export. Use file tools only. Do not run commands, use network tools or change calc.test.cjs/package.json. Complete the actual edit.')
        + (withMcp ? ` Before editing, inspect ${multiFile ? 'both implementation files' : 'calc.cjs'} using mcp__fixture__read_file. Then make the required edits using the built-in file tools.` : '') }],
      providerSessionId: `${label}-${model}`, abortSignal: AbortSignal.any([stop.signal, AbortSignal.timeout(180000)]), send: event => events.push(event) });
      machine.checkpointStore = new AgentCheckpointStore({ dir: path.join(workspace, 'checkpoints') });
      const execute = machine.executor.execute.bind(machine.executor);
      machine.executor.execute = async (tool, params, options) => {
        let operations = params.operations || [];
        if (typeof operations === 'string') {
          try { operations = JSON.parse(operations); } catch { return { ok: false, error: 'Invalid fixture operation JSON.' }; }
        }
        if (!Array.isArray(operations)) return { ok: false, error: 'Fixture operations must be an array.' };
        const paths = [params.path, ...operations.map(o => o?.path ?? o?.params?.path)].filter(Boolean);
        if (paths.some(p => { const target = path.resolve(workspace, p); return target !== workspace && !target.startsWith(workspace + path.sep); })) {
          stop.abort(new Error('Fixture requested a path outside its isolated workspace.'));
          throw stop.signal.reason;
        }
        const mutators = new Set(['write_file', 'patch_file', 'patch_lines', 'apply_patch_transaction']);
        const editable = new Set([path.join(workspace, 'calc.cjs'), ...(multiFile ? [path.join(workspace, 'cart.cjs')] : [])]);
        if (mutators.has(tool) && (!paths.length || paths.some(p => !editable.has(path.resolve(workspace, p))))) {
          stop.abort(new Error('Fixture attempted to change a protected test/support file.'));
          throw stop.signal.reason;
        }
        if (!['read_file', 'list_dir', 'write_file', 'patch_file', 'patch_lines', 'inspect_code_context', 'review_patch_transaction', 'apply_patch_transaction',
          ...(withMcp ? ['mcp__fixture__read_file'] : [])].includes(tool)) {
          return { ok: false, error: 'This isolated evaluation allows file tools only; no command or network tool was executed.' };
        }
        return execute(tool, params, options);
      };
      requestSizes = [];
      wire = [];
      row.fixtureApprovals = 0;
      const approveFixture = payload => {
        // Exercise the real gate only for the explicitly requested isolated edit.
        const allowed = payload.action.capability === 'apply_patch_transaction';
        queueMicrotask(() => {
          if (respondToApproval(payload.id, allowed ? 'approve' : 'reject') && allowed) row.fixtureApprovals++;
        });
      };
      eventBus.on('approval:pending', approveFixture);
      try {
        await machine.run();
        row.outcome = events.find(e => e.type === 'end')?.outcome;
        row.error = events.find(e => e.type === 'error')?.error || null;
        row.tools = events.filter(e => e.type === 'tool_start').map(e => e.tool);
        row.routes = [...new Set(events.flatMap(e => e.payload?.modelRoute?.model ? [e.payload.modelRoute.model] : []))];
        row.maxRequestBytes = Math.max(0, ...requestSizes);
        row.inferenceRequests = requestSizes.length;
        row.outputTokenLimits = [...new Set(wire.map(request => request.outputTokenLimit))];
        row.toolFailures = machine.checkpoint.toolFailures;
        row.resolvedToolFailures = machine.checkpoint.resolvedToolFailures || [];
        row.testFilesPreserved = testBefore === digest(path.join(workspace, 'calc.test.cjs')) && packageBefore === digest(path.join(workspace, 'package.json'));
        try {
          execFileSync(node, ['--test', 'calc.test.cjs'], { cwd: workspace, windowsHide: true, timeout: 15000, stdio: 'pipe' });
          row.independentTests = 'passed';
        } catch { row.independentTests = 'failed'; }
        if (withMcp) {
          row.mcpReads = (await mcpClientManager.callTool('fixture', 'stats', {}, { ...fixtureMcp, workspaceRoot: workspace })).reads;
          row.mcpReadVerified = ['calc.cjs', ...(multiFile ? ['cart.cjs'] : [])].every(name => row.mcpReads.includes(name));
        }
        row.status = row.outcome?.status === 'completed' && row.independentTests === 'passed' && row.testFilesPreserved
          && (!withMcp || row.mcpReadVerified)
          && row.routes.every(route => route === `opencode-go:${model}`) ? 'passed' : 'failed';
      } catch (error) { row.status = 'failed'; row.error = runtime.safeError(error); }
      finally {
        eventBus.off('approval:pending', approveFixture);
        if (withMcp) await mcpClientManager.closeAll();
      }
      row.elapsedMs = Date.now() - started;
      report.models.push(row);
      fs.writeFileSync(path.join(workspace, 'wire-summary.json'), JSON.stringify(wire, null, 2));
      fs.writeFileSync(path.join(workspace, 'model-turns.json'), JSON.stringify(machine.activeConversation.filter(m => m.role === 'assistant')
        .map(m => ({ content: runtime.safeError(m.content || '') })), null, 2));
      console.log(JSON.stringify(row));
      save();
      if ([401, 402, 429].includes(row.outcome?.modelFailure?.httpStatus)) consecutiveAccountFailures++;
      else consecutiveAccountFailures = 0;
      if (consecutiveAccountFailures >= 2) { report.stoppedReason = 'Two consecutive account/quota rejections'; break; }
      await delay(750);
    }
    globalThis.fetch = realFetch;
    report.ok = report.models.length === models.length && report.models.every(m => m.status === 'passed');
  } catch (error) { report.error = runtime ? runtime.safeError(error) : error.message; }
  finally {
    await mcpManager?.closeAll();
    report.configurationPreserved = before[0] === userDigest('config.json');
    report.credentialsPreserved = before[1] === userDigest('secrets.enc.json');
    report.finishedAt = new Date().toISOString();
    report.sourceHashAtEnd = createBuildInfo(path.resolve(__dirname, '..'), process.platform).sourceHash;
    report.sourceChangedDuringRun = report.sourceHashAtStart !== report.sourceHashAtEnd;
    save();
    console.log(JSON.stringify({ ok: report.ok, tested: report.models.length, report: path.join(artifacts, 'report.json'),
      error: report.error || null, configurationPreserved: report.configurationPreserved, credentialsPreserved: report.credentialsPreserved }));
    app.exit(report.ok ? 0 : 1);
  }
});
