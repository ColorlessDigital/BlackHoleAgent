import { test, describe, mock } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentStateMachine } from './stateMachine.js';
import { AgentState } from './types.js';
import { ToolRegistry } from './toolRegistry.js';
import { VerificationEngine } from './verificationEngine.js';
import { AgentCheckpointStore } from './checkpointStore.js';
import { ProjectContextEngine } from './contextEngine.js';
import { RepairPlanner } from './repairPlanner.js';
import { TaskGraphPlanner } from './taskGraphPlanner.js';
import { AgentMemoryStore } from './agentMemoryStore.js';
import { buildCheckpointResumePrompt } from './checkpointResume.js';
import { resolveModelRoute } from '../modelRouting.js';
import { applySlidingContextGuard, estimateTextTokens } from '../contextGuard.js';
import { CapabilityExecutor } from '../../capabilities/executor.js';
import { PatchTransactionManager } from './patchTransaction.js';
import { DiffTracker } from './diffTracker.js';
import { normalizeAgentRunLimits } from '../../config/agentRunLimits.js';
import { resolveDirectoryTask, observeDirectoryTask, directoryTaskVerified } from './directoryTask.js';
import { ObservationEvidence, resolveFileQuoteRequest } from './observationEvidence.js';

describe('AgentStateMachine', () => {
  test('default observation graph does not invent implementation or changed-file verification work', () => {
    const planner = new TaskGraphPlanner();
    for (const goal of ['Read release.txt and quote its current value exactly. Observation only.', '변경 없이 package.json을 읽고 설명해줘.']) {
      const graph = planner.buildTaskGraph({ goal, workspaceSummary: { sourceFileCount: 50 } });
      assert.equal(graph.nodes.some(node => ['implement', 'patch', 'verify'].includes(node.type)), false);
      assert.ok(graph.nodes.some(node => node.type === 'analyze'));
      assert.ok(graph.nodes.some(node => node.type === 'summarize'));
    }
    assert.ok(planner.buildTaskGraph({ goal: 'Fix math.cjs.' }).nodes.some(node => node.type === 'implement'));
    for (const goal of ['Read math.cjs. Fix addition and keep the tests unchanged.', 'Read version.txt. Restore the existing format.', 'Inspect the implementation.\nPlease update the return value.', 'Restore the previous implementation.', 'Handle the remaining task.']) {
      const graph = planner.buildTaskGraph({ goal });
      assert.ok(graph.nodes.some(node => node.type === 'implement'), goal);
      assert.ok(planner.resumeTaskGraph(graph).nodes.some(node => node.type === 'implement'), goal);
    }
    const mistaken = planner.buildTaskGraph({ goal: 'Fix math.cjs.' });
    mistaken.goal = 'Read version.txt and quote its value. Observation only.';
    assert.equal(planner.resumeTaskGraph(mistaken).nodes.some(node => node.type === 'implement'), false);
    assert.equal(planner.buildTaskGraph({ goal: 'Inspect version.txt.', planSteps: ['Patch version.txt'] }).nodes.some(node => node.type === 'implement'), false);
  });

  test('an exact file quotation cannot complete with stale history or an omitted value', async t => {
    const { machine, events } = isolatedRun(t, 'Read release.txt and quote its current value exactly. Observation only; no modifications.',
      { selfHealingMaxCycles: 3 });
    fs.writeFileSync(path.join(machine.workspaceRoot, 'release.txt'), 'release-2026-current');
    let calls = 0, executions = 0;
    machine.executor.execute = async (tool, params) => {
      executions++;
      assert.equal(tool, 'read_file');
      assert.equal(params.path, 'release.txt');
      return { ok: true, result: { path: path.join(machine.workspaceRoot, 'release.txt'), content: 'release-2026-current',
        startLine: 1, hasMore: false } };
    };
    machine.callModel = async (_system, _messages, onChunk) => {
      calls++;
      if (calls === 1) onChunk('The old release was release-2025.');
      else if (calls === 2) onChunk('{"tool":"read_file","params":{"path":"release.txt"}}');
      else if (calls === 3) onChunk('The file has been read successfully.');
      else onChunk('The current value is release-2026-current.');
    };
    await machine.run();
    assert.equal(calls, 4);
    assert.equal(executions, 1);
    assert.equal(machine.runOutcome.status, 'completed');
    const text = events.filter(event => event.type === 'chunk').map(event => event.text).join('');
    assert.match(text, /release-2026-current/);
    assert.doesNotMatch(text, /release-2025/);
    assert.equal(events.filter(event => event.observationVerification).length, 2);
  });

  test('failed requested reads and approval rejections are not erased by quotation recovery', async t => {
    const { machine } = isolatedRun(t, 'Read release.txt and quote its current value exactly.', { selfHealingMaxCycles: 1 });
    machine.executor.execute = async () => ({ ok: false, rejected: true, error: 'User rejected this read.' });
    let calls = 0;
    machine.callModel = async (_system, _messages, onChunk) => {
      onChunk(++calls === 1 ? '{"tool":"read_file","params":{"path":"release.txt"}}' : 'No read was performed.');
    };
    await machine.run();
    assert.notEqual(machine.runOutcome.status, 'completed');
    assert.equal(machine.checkpoint.toolFailures[0].reason, 'rejected');
  });

  test('quotation evidence is literal, run-scoped, bounded, and never reads files by itself', () => {
    const root = path.resolve(os.tmpdir());
    for (const goal of ['Read `release notes.txt` and quote its contents.', 'Observation round 7: read the newly created version.txt and quote its value.', '"version.txt" 파일을 읽고 내용을 그대로 보여줘.']) {
      assert.ok(resolveFileQuoteRequest(goal));
    }
    for (const goal of ['Explain how to read version.txt and quote its value.', 'Can you explain how to read version.txt and quote its value?',
      'Please describe how to read version.txt and quote its value.', 'Read https://example.test/page and quote its text exactly.',
      'Read file:///tmp/version.txt and quote its contents exactly.', 'Read this and quote it.', 'Read *.txt and quote it.', 'Inspect the implementation.']) {
      assert.equal(resolveFileQuoteRequest(goal), null);
    }
    const evidence = new ObservationEvidence('Read version.txt and quote its value exactly.', root);
    const call = { tool: 'read_file', params: { path: 'version.txt' } };
    assert.equal(evidence.verify('prior value').reason, 'requested_file_not_read');
    assert.equal(evidence.observe(call, { ok: false, rejected: true }), null);
    assert.equal(evidence.observe(call, { ok: true, result: { content: 'partial', startLine: 2, hasMore: false } }), null);
    assert.equal(evidence.observe(call, { ok: true, result: { content: 'partial', startLine: 1, hasMore: true } }), null);
    assert.ok(evidence.observe(call, { ok: true, result: { content: 'new\r\nvalue\n', startLine: 1, hasMore: false } }));
    assert.equal(evidence.verify('new\nvalue').ok, true);
    assert.equal(evidence.verify('new value').ok, false);
    assert.equal(new ObservationEvidence('Read version.txt and quote its value exactly.', root).verify('new\nvalue').ok, false);
    evidence.observe(call, { ok: true, result: { content: 'x'.repeat(5000), hasMore: false } });
    assert.equal(evidence.verify('Large contents were inspected.').scope, 'fresh_read_only');
    assert.ok(evidence.recoveryMessage({ reason: 'requested_quote_missing' }).length < 1000);
    const partial = new ObservationEvidence('Read version.txt and quote the first line exactly.', root);
    assert.equal(partial.request, null);
    partial.observe(call, { ok: true, result: { content: 'one requested line', startLine: 3, hasMore: true } });
    assert.equal(partial.verify('one requested line').applicable, false);
    assert.equal(new ObservationEvidence('Read version.txt and quote its value exactly. Restore the original implementation.', root).request, null);
    assert.equal(resolveFileQuoteRequest('Read data:text/plain,value and quote its text exactly.'), null);
    assert.equal(resolveFileQuoteRequest('Read above and quote its text exactly.'), null);
    assert.equal(resolveFileQuoteRequest('Read logs/ and quote its contents exactly.'), null);
    assert.equal(resolveFileQuoteRequest('Read details.json and quote its author exactly.').exactQuote, false);
    assert.equal(resolveFileQuoteRequest('"version.txt" 파일을 읽고 두 번째 줄을 정확히 인용해줘.').exactQuote, false);
  });

  test('an unfulfilled exact quote stops as incomplete when its configured repair budget is exhausted', async t => {
    const { machine, events } = isolatedRun(t, 'Read version.txt and quote its value exactly.', { selfHealingMaxCycles: 1 });
    let calls = 0;
    machine.callModel = async (_system, _messages, onChunk) => { calls++; onChunk('The request is complete.'); };
    machine.executor.execute = async () => assert.fail('No unrequested automatic reads may bypass the executor.');
    await machine.run();
    assert.equal(calls, 2);
    assert.equal(machine.runOutcome.status, 'incomplete');
    assert.equal(machine.runOutcome.reason, 'observation_not_verified');
    assert.equal(machine.runOutcome.executionBudget.limitReached, 'repair_cycles');
    assert.equal(events.some(event => event.type === 'chunk' && event.text === 'The request is complete.'), false);
  });

  test('advertised tools can match the execution host without changing executor permissions', () => {
    const machine = new AgentStateMachine({ send() {}, messages: [{ role: 'user', content: 'Inspect the project.' }],
      config: { workspaceRoot: os.tmpdir(), activeModel: 'opencode-go:glm-5.3-flash', agentMemoryEnabled: false } });
    const originalExecutor = machine.executor;
    machine.getModelTools = () => [ToolRegistry.getTool('read_file')];
    const prompt = machine.buildToolPrompt();
    assert.match(prompt, /1\. read_file/);
    assert.doesNotMatch(prompt, /record_project_memory/);
    assert.equal(machine.executor, originalExecutor);
    assert.ok(ToolRegistry.getTool('record_project_memory'));
  });

  test('observation loop recovery never recommends unrelated patches', t => {
    const { machine } = isolatedRun(t, 'Read version.txt and report the value.', { agentLoopGuardMaxRepeats: 1 });
    const calls = [{ tool: 'read_file', params: { path: 'version.txt' } }];
    assert.equal(machine.evaluateToolCallLoop(calls).blocked, false);
    const loop = machine.evaluateToolCallLoop(calls);
    assert.equal(loop.blocked, true);
    assert.match(machine.buildLoopGuardHint(loop), /current observation request/);
    assert.doesNotMatch(machine.buildLoopGuardHint(loop), /apply a minimal patch/);
    machine.checkpoint.userGoal = 'Restore the previous implementation.';
    assert.match(machine.buildLoopGuardHint(loop), /apply a minimal patch/);
  });

  test('an optional failed memory write remains a warning after a verified quotation, never a claimed write', async t => {
    const { machine, events } = isolatedRun(t, 'Read version.txt and quote its value exactly.', { selfHealingMaxCycles: 3 });
    let calls = 0;
    machine.callModel = async (_system, _messages, onChunk) => onChunk(++calls === 1
      ? '{"tool_calls":[{"tool":"read_file","params":{"path":"version.txt"}},{"tool":"record_project_memory","params":{"summary":"Version inspected."}}]}'
      : 'The current value is 2026.11-release.');
    machine.executor.execute = async tool => tool === 'read_file'
      ? { ok: true, result: { content: '2026.11-release', hasMore: false } }
      : { ok: false, error: 'Fixture memory storage unavailable.' };
    await machine.run();
    assert.equal(machine.runOutcome.status, 'completed');
    assert.equal(machine.runOutcome.warnings[0].tool, 'record_project_memory');
    assert.equal(machine.checkpoint.toolFailures.length, 0);
    assert.equal(machine.checkpoint.nonBlockingToolFailures[0].effectStatus, 'failed_not_replayed');
    assert.equal(events.some(event => event.level === 'warning' && event.optionalToolFailures), true);
  });

  test('required, approval-related, and unrelated failures cannot become optional observation warnings', t => {
    const { machine } = isolatedRun(t, 'Read version.txt and quote its value exactly.');
    machine.observationEvidence.observe({ tool: 'read_file', params: { path: 'version.txt' } },
      { ok: true, result: { content: 'release', hasMore: false } });
    for (const failure of [
      { tool: 'record_project_memory', reason: 'rejected' },
      { tool: 'record_project_memory', reason: 'blocked' },
      { tool: 'record_project_memory', reason: 'execution_failed', policy: { requiresApproval: true } },
      { tool: 'run_command', reason: 'execution_failed' }
    ]) assert.deepEqual(machine.resolveOptionalObservationFailures([failure], 'release'), [failure]);
    const failure = { tool: 'record_project_memory', reason: 'execution_failed' };
    assert.deepEqual(machine.resolveOptionalObservationFailures([failure], 'omitted value'), [failure]);
    machine.checkpoint.userGoal += ' Save this value to project memory.';
    assert.deepEqual(machine.resolveOptionalObservationFailures([failure], 'release'), [failure]);
  });

  for (const [status, differentModel, rejects] of [[429, false, true], [401, false, true], [402, false, true], [429, true, false], [null, false, false]]) {
    test(`compaction handles ${status || 'transport'} failure without repeating a limited shared model (different model: ${differentModel})`, async t => {
      const { machine } = isolatedRun(t, 'Report the current implementation.', {
        activeModel: 'opencode-go:gemini-4-argon', contextLimit: 8192,
        agentModelProfiles: differentModel ? { summarizer: { model: 'opencode-go:glm-5.3-flash' } } : {}
      });
      const history = [{ role: 'user', content: machine.checkpoint.userGoal },
        ...Array.from({ length: 14 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `Historical ${i}: ${'detail '.repeat(500)}` })),
        { role: 'user', content: 'Report the current implementation.' }];
      const failure = Object.assign(new Error(status ? `HTTP ${status}: fixture limit` : 'Transport timeout'),
        { modelFailure: { httpStatus: status, code: status === 429 ? 'rate_limit_exceeded' : status ? 'provider_error' : 'request_timeout' } });
      let calls = 0;
      machine.callModel = async () => { calls++; throw failure; };
      if (rejects) await assert.rejects(machine.maybeCompactContext('System', history), error => error === failure);
      else {
        const result = await machine.maybeCompactContext('System', history);
        assert.equal(result.compacted, false);
        assert.match(result.reason, /summarizer-failed/);
      }
      assert.equal(calls, 1);
      assert.equal(history.at(-1).content, 'Report the current implementation.');
    });
  }

  test('resume supplies the actual verification result before requesting more work', async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bh-resume-verification-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.writeFileSync(path.join(root, 'math.cjs'), 'exports.add=(a,b)=>a+b;\n');
    const goal = 'Fix math.cjs to add the supplied values.';
    const machine = new AgentStateMachine({ send() {}, messages: [{ role: 'user', content: goal }],
      config: { workspaceRoot: root, contextLimit: 8192, agentMemoryEnabled: false },
      resumeCheckpoint: { sessionId: 'verified-resume', workspaceRoot: root, userGoal: goal,
        state: 'STOPPED', changedFiles: ['math.cjs'] } });
    stubCheckpointStore(machine);
    let verifications = 0, modelCalls = 0;
    machine.verificationEngine.runVerificationSuite = async () => {
      verifications++;
      return { ok: true, results: { syntax: { ok: true }, test: { ok: true }, lint: { ok: true, skipped: true } } };
    };
    machine.executor.execute = async () => assert.fail('A completed edit must not need duplicate test commands.');
    machine.callModel = async (_system, messages, onChunk) => {
      modelCalls++;
      const evidence = messages.find(message => message.content.startsWith('[Checkpoint Verification Result]'));
      assert.ok(evidence);
      const result = JSON.parse(evidence.content.slice(evidence.content.indexOf('\n') + 1));
      assert.equal(result.ok, true);
      assert.equal(result.checks.test.ok, true);
      assert.equal(result.checks.lint.skipped, true);
      assert.deepEqual(result.changedFiles, ['math.cjs']);
      onChunk('The implementation is correct and the available verification checks passed.');
    };
    await machine.run();
    assert.equal(machine.runOutcome.status, 'completed');
    assert.equal(verifications, 1);
    assert.equal(modelCalls, 1);
  });

  test('native declarations are supplied once while local tool descriptions remain available', () => {
    const make = model => new AgentStateMachine({ send() {}, messages: [{ role: 'user', content: 'Inspect the implementation.' }],
      config: { workspaceRoot: os.tmpdir(), activeModel: model, agentModelRoutingEnabled: false, agentMemoryEnabled: false } });
    const native = make('opencode-go:gemini-4-argon').buildToolPrompt();
    assert.match(native, /native function declarations/);
    assert.doesNotMatch(native, /read_file \(path:/);
    assert.match(native, /read_file/);
    const local = make('llamacpp:fixture').buildToolPrompt();
    assert.match(local, /read_file \(path:string:required/);
    assert.match(local, /Read the contents of a file/);
    assert.match(native, /After editing, allow the verification phase to run/);
    assert.match(local, /After editing, allow the verification phase to run/);
  });

  test('resume diagnostics and native schemas fit the planner without changing its context setting', () => {
    const goal = 'Read lib/argument.js and restore default(value, description) to preserve all supplied values and descriptions. Only edit that implementation file.';
    const machine = new AgentStateMachine({ send() {}, messages: [{ role: 'user', content: goal }],
      config: { workspaceRoot: os.tmpdir(), activeModel: 'opencode-go:gemini-4-argon', contextLimit: 8192,
        agentModelRoutingEnabled: false, agentMemoryEnabled: false },
      resumeCheckpoint: { sessionId: 'resume-native-fixture', workspaceRoot: os.tmpdir(), userGoal: goal, state: 'FAIL',
        loopGuardEvents: Array.from({ length: 4 }, (_, i) => ({ reason: 'repeated_identical_tool_calls', repeatCount: i + 3,
          toolCalls: [{ tool: 'read_file', params: { path: 'lib/argument.js' } }] })) } });
    const declarations = JSON.stringify(ToolRegistry.getAllTools().map(tool => ({ name: tool.name, description: tool.description, parameters: tool.inputSchema })));
    const guarded = applySlidingContextGuard(machine.activeConversation, machine.buildSystemPrompt() + declarations, 8192, { userGoal: goal });
    assert.equal(guarded.limitExceeded, false);
    assert.ok(guarded.messages.some(message => message.content === goal));
    assert.equal(machine.config.contextLimit, 8192);
  });

  test('large background index samples leave the latest requested implementation intact on resume', () => {
    const goal = 'Restore Argument.default(value, description) in lib/argument.js.';
    const machine = new AgentStateMachine({ send() {}, messages: [{ role: 'user', content: goal }],
      config: { workspaceRoot: os.tmpdir(), activeModel: 'opencode-go:gemini-4-argon', contextLimit: 122880,
        agentModelProfiles: { planner: { contextLimit: 8192 } }, agentMemoryEnabled: false },
      resumeCheckpoint: { sessionId: 'large-index-resume', workspaceRoot: os.tmpdir(), userGoal: goal, state: 'FAIL' } });
    let limits;
    const summary = { workspaceRoot: os.tmpdir(), fileCount: 50000, scanStats: { indexedFiles: 1200 },
      sampleSourceFiles: Array.from({ length: 100 }, (_, i) => `packages/${'nested/'.repeat(50)}source-${i}.js`),
      symbols: Array.from({ length: 100 }, () => ({ name: 'symbol'.repeat(100), file: 'source.js', line: 1 })) };
    machine.contextEngine = { getRecentlyChangedFiles: () => [], getWorkspaceSummary: options => { limits = options; return summary; } };
    const background = machine.buildWorkspacePromptSection();
    assert.ok(estimateTextTokens(background) < 1050);
    assert.match(background, /50000/);
    assert.match(background, /indexedFiles/);
    assert.deepEqual(limits, { fileLimit: 4, symbolLimit: 6 });
    const body = `// implementation\n${'const preserved = true;\n'.repeat(90)}default(value, description) {\n  this.defaultValue = undefined;\n}\n${'// existing code\n'.repeat(90)}`;
    const messages = [...machine.activeConversation, { role: 'user', content: `[Tool Result (Tool: read_file)]\n${body}` },
      { role: 'user', content: '[Observation-Only Edit Redirect] Continue the requested edit.' }];
    const declarations = JSON.stringify(ToolRegistry.getAllTools().map(tool => ({ name: tool.name, description: tool.description, parameters: tool.inputSchema })));
    const guarded = applySlidingContextGuard(messages, machine.buildSystemPrompt() + declarations, 8192, { userGoal: goal });
    assert.equal(guarded.limitExceeded, false);
    assert.ok(guarded.messages.some(message => message.content.includes('this.defaultValue = undefined;')));
    assert.equal(summary.sampleSourceFiles.length, 100);
    assert.equal(machine.config.contextLimit, 122880);
    assert.equal(machine.config.agentModelProfiles.planner.contextLimit, 8192);
  });

  function stubCheckpointStore(stateMachine) {
    stateMachine.config.agentMemoryEnabled = false;
    stateMachine.checkpointStore = {
      save(checkpoint) {
        return {
          sessionId: checkpoint.sessionId,
          savedAt: new Date().toISOString(),
          path: path.join(os.tmpdir(), `${checkpoint.sessionId}.json`),
          latestPath: path.join(os.tmpdir(), 'latest.json')
        };
      }
    };
  }

  function isolatedRun(t, goal, extraConfig = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'blackhole-run-outcome-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const events = [];
    const machine = new AgentStateMachine({
      send: event => events.push(event),
      messages: [{ role: 'user', content: goal }],
      config: { workspaceRoot: root, selfHealingMaxCycles: 1, ...extraConfig }
    });
    stubCheckpointStore(machine);
    machine.contextEngine.scanWorkspace = async () => {};
    return { machine, events };
  }

  test('literal directory requests resolve without interpreting command text or accepting mixed code tasks', () => {
    for (const goal of ['ABC라는 폴더를 D 드라이브에 생성', 'd 드라이브에 ABC 폴더를 생성', 'D 드라이브에 ABC 폴더를 만들어줘']) {
      assert.deepEqual(resolveDirectoryTask(goal, 'D:\\').paths, ['D:\\ABC']);
    }
    assert.deepEqual(resolveDirectoryTask('Create directory "ABC folder"', path.resolve('.')).paths, [path.resolve('ABC folder')]);
    for (const goal of ['Create folder ABC on drive D', 'Create directory ABC on D drive']) assert.deepEqual(resolveDirectoryTask(goal, 'D:\\').paths, ['D:\\ABC']);
    for (const goal of ['Create folder ABC and write README.txt', 'ABC 폴더를 생성하고 코드를 작성', 'Explain how to create a folder', 'Fix app.js']) {
      assert.equal(resolveDirectoryTask(goal, path.resolve('.')), null);
    }
  });

  test('a real directory command completes without file artifacts, sibling verification, or a second model call', async t => {
    const { machine, events } = isolatedRun(t, 'Create directory ABC', { permissionMode: 'autonomous' });
    const unrelated = path.join(machine.workspaceRoot, 'unrelated');
    fs.mkdirSync(unrelated);
    fs.writeFileSync(path.join(unrelated, 'package.json'), JSON.stringify({ scripts: { test: 'pnpm -r test', lint: 'pnpm -r lint' } }));
    let calls = 0;
    machine.callModel = async (_prompt, _messages, chunk) => {
      calls++;
      chunk(JSON.stringify({ tool_calls: [
        { tool: 'run_command', params: { command: `"${process.execPath}" -e "require('fs').mkdirSync('ABC',{recursive:true})"` } },
        { tool: 'write_file', params: { path: 'ABC/README.txt', content: 'Unnecessary artifact' } }
      ] }));
    };
    machine.verificationEngine.runVerificationSuite = async () => { throw new Error('Directory creation must not run project checks.'); };
    await machine.run();
    assert.equal(machine.runOutcome.status, 'completed');
    assert.equal(calls, 1);
    assert.equal(machine.repairCycleCount, 0);
    assert.deepEqual(fs.readdirSync(path.join(machine.workspaceRoot, 'ABC')), []);
    assert.deepEqual([...machine.diffTracker.changedFiles], []);
    assert.deepEqual(events.filter(event => event.type === 'tool_start').map(event => event.tool), ['run_command']);
    assert.equal(events.some(event => event.state === AgentState.REPAIR), false);
    assert.equal(directoryTaskVerified(machine.checkpoint.directoryTask), true);
  });

  test('an existing requested directory completes idempotently without invoking the model or editing its contents', async t => {
    const { machine } = isolatedRun(t, 'Create directory ABC');
    fs.mkdirSync(path.join(machine.workspaceRoot, 'ABC'));
    fs.writeFileSync(path.join(machine.workspaceRoot, 'ABC', 'existing.txt'), 'Keep this user file');
    machine.callModel = async () => { throw new Error('Existing directory needs no model action.'); };
    await machine.run();
    assert.equal(machine.runOutcome.status, 'completed');
    assert.equal(machine.stepCount, 0);
    assert.equal(fs.readFileSync(path.join(machine.workspaceRoot, 'ABC', 'existing.txt'), 'utf8'), 'Keep this user file');
  });

  test('exit zero without the requested directory is not completion and never forces an unrelated source edit', async t => {
    const { machine, events } = isolatedRun(t, 'Create directory ABC', { permissionMode: 'autonomous' });
    let calls = 0;
    machine.callModel = async (_prompt, _messages, chunk) => chunk(++calls === 1
      ? JSON.stringify({ tool: 'run_command', params: { command: `"${process.execPath}" -e "process.exit(0)"` } }) : 'The folder was created.');
    await machine.run();
    assert.equal(machine.runOutcome.status, 'incomplete');
    assert.equal(machine.runOutcome.reason, 'directory_not_verified');
    assert.ok(!events.filter(event => event.type === 'chunk').map(event => event.text).join('').includes('The folder was created.'));
    assert.equal(fs.existsSync(path.join(machine.workspaceRoot, 'ABC')), false);
    assert.equal(events.some(event => event.payload?.observationOnlyEditRedirect || event.payload?.prematureCompletion), false);
    assert.equal(machine.repairCycleCount, 0);
  });

  test('a rejected directory command still uses the existing approval gate and cannot create or verify the target', async t => {
    const { machine } = isolatedRun(t, 'Create directory ABC', { permissionMode: 'strict', selfHealingMaxCycles: 0 });
    const { eventBus } = await import('../../common/eventBus.js');
    const { respondToApproval } = await import('../../security/approvalGate.js');
    let approvals = 0;
    const reject = event => { approvals++; queueMicrotask(() => respondToApproval(event.id, 'reject')); };
    eventBus.on('approval:pending', reject);
    t.after(() => eventBus.off('approval:pending', reject));
    machine.callModel = async (_prompt, _messages, chunk) => chunk(JSON.stringify({ tool: 'run_command', params: {
      command: `"${process.execPath}" -e "require('fs').mkdirSync('ABC')"`
    } }));
    await machine.run();
    assert.equal(approvals, 1);
    assert.equal(machine.runOutcome.status, 'incomplete');
    assert.equal(fs.existsSync(path.join(machine.workspaceRoot, 'ABC')), false);
    assert.equal(directoryTaskVerified(machine.directoryTask), false);
  });

  test('automatic directory observation does not reuse approval outside the workspace', async t => {
    const { machine } = isolatedRun(t, 'Inspect workspace');
    const parent = path.dirname(machine.workspaceRoot);
    const task = { kind: 'directory_creation', paths: [parent], evidence: [] };
    assert.equal((await observeDirectoryTask(task, machine.workspaceRoot, { automatic: true })).evidence[0].status, 'unobserved');
  });

  test('non-code artifacts and unowned drive roots never execute sibling Node project checks', async t => {
    const { machine } = isolatedRun(t, 'Inspect workspace');
    const root = machine.workspaceRoot;
    fs.mkdirSync(path.join(root, 'ABC'));
    fs.writeFileSync(path.join(root, 'ABC', 'README.txt'), 'Not source code');
    fs.mkdirSync(path.join(root, 'unrelated'));
    fs.writeFileSync(path.join(root, 'unrelated', 'package.json'), JSON.stringify({ scripts: { test: 'pnpm -r test', lint: 'pnpm -r lint' } }));
    const engine = new VerificationEngine(root, { runCommand: async () => { throw new Error('Unrelated command executed'); } });
    assert.equal(engine.detectProjectInfo().hasNode, false);
    const suite = await engine.runVerificationSuite({ changedFiles: ['ABC/README.txt'] });
    assert.equal(suite.ok, true);
    assert.ok(Object.values(suite.results).every(result => result.skipped));
    assert.deepEqual(suite.targets.verificationPlan.projectScopes, []);
  });

  test('source checks are scoped to their nearest owning package, not sibling or parent scripts', async t => {
    const { machine } = isolatedRun(t, 'Inspect workspace');
    const root = machine.workspaceRoot;
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ scripts: { test: 'pnpm unrelated-root-test' } }));
    for (const name of ['actual', 'sibling']) {
      fs.mkdirSync(path.join(root, name));
      fs.writeFileSync(path.join(root, name, 'package.json'), JSON.stringify({ scripts: { test: `node ${name}-test.cjs` } }));
    }
    fs.writeFileSync(path.join(root, 'actual', 'code.cjs'), 'module.exports=1;');
    const commands = [];
    const engine = new VerificationEngine(root, { runCommand: async (command, options) => { commands.push({ command, cwd: options.cwd }); return { code: 0, output: 'OK' }; } });
    const suite = await engine.runVerificationSuite({ changedFiles: ['actual/code.cjs'] });
    assert.equal(suite.ok, true);
    assert.ok(commands.length >= 2);
    assert.ok(commands.every(command => command.cwd === path.join(root, 'actual')));
    assert.ok(commands.some(command => command.command.includes('actual-test.cjs')));
    assert.ok(!commands.some(command => /sibling|unrelated-root-test/.test(command.command)));
  });

  test('Python dependency manifests are not mistaken for ordinary text documentation', async t => {
    const { machine } = isolatedRun(t, 'Inspect workspace');
    fs.writeFileSync(path.join(machine.workspaceRoot, 'pyproject.toml'), '[tool.pytest.ini_options]\n');
    fs.writeFileSync(path.join(machine.workspaceRoot, 'requirements.txt'), 'example-package==1.0\n');
    const commands = [];
    const engine = new VerificationEngine(machine.workspaceRoot, { runCommand: async command => { commands.push(command); return { code: 0 }; } });
    const suite = await engine.runVerificationSuite({ changedFiles: ['requirements.txt'] });
    assert.equal(suite.ok, true);
    assert.equal(suite.results.test.skipped, false);
    assert.ok(commands.includes('pytest'));
  });

  test('missing verification tooling stops without source self-repair or false success', async t => {
    const { machine, events } = isolatedRun(t, 'Fix result.cjs', { permissionMode: 'autonomous' });
    fs.writeFileSync(path.join(machine.workspaceRoot, 'package.json'), JSON.stringify({ scripts: { test: 'pnpm -r test', lint: 'pnpm -r lint' } }));
    machine.verificationEngine.runCommand = async command => command.startsWith('pnpm')
      ? { code: 9009, output: "'pnpm' is not recognized" } : { code: 0, output: 'OK' };
    let calls = 0;
    machine.callModel = async (_prompt, _messages, chunk) => { calls++; chunk(JSON.stringify({ tool: 'write_file', params: { path: 'result.cjs', content: 'module.exports=42;' } })); };
    await machine.run();
    assert.equal(calls, 1);
    assert.equal(machine.runOutcome.status, 'incomplete');
    assert.equal(machine.runOutcome.reason, 'verification_environment');
    assert.equal(machine.repairCycleCount, 0);
    assert.equal(events.some(event => event.state === AgentState.REPAIR), false);
    assert.deepEqual(machine.checkpoint.repairPlan.recommendedFiles, []);
    assert.deepEqual(machine.checkpoint.repairPlan.toolSequence, []);
    assert.ok(machine.checkpoint.failedVerifications.every(failure => failure.failureKind === 'environment'));
  });

  test('shell missing-command exit codes are environment failures but assertions and source imports are not', t => {
    const { machine } = isolatedRun(t, 'Inspect workspace');
    const engine = machine.verificationEngine;
    for (const code of [127, 9009]) assert.equal(engine.detectEnvironmentIssue({ code, output: 'Localized error' }, 'pnpm test').code, 'command_unavailable');
    for (const output of ['AssertionError: expected 42', 'Cannot find module ./src/missing.js']) assert.equal(engine.detectEnvironmentIssue({ code: 1, output }, 'node test.cjs'), null);
  });

  test('an actually missing verification executable is reported as environment failure', async t => {
    const { machine } = isolatedRun(t, 'Inspect workspace');
    fs.writeFileSync(path.join(machine.workspaceRoot, 'package.json'), JSON.stringify({ scripts: { test: 'blackhole_missing_verification_tool_42' } }));
    const result = await machine.verificationEngine.runVerification('test');
    assert.equal(result.ok, false);
    assert.equal(result.failureKind, 'environment');
    assert.equal(result.environmentIssue.code, 'command_unavailable');
  });

  test('resuming an already-created folder rechecks only its non-code artifact and preserves the existing contents', async t => {
    const { machine } = isolatedRun(t, 'Create directory ABC');
    fs.mkdirSync(path.join(machine.workspaceRoot, 'ABC'));
    fs.writeFileSync(path.join(machine.workspaceRoot, 'ABC', 'README.txt'), 'Existing content from an earlier run');
    const restored = new AgentStateMachine({ config: machine.config, send: () => {}, resumeCheckpoint: {
      ...machine.checkpoint, changedFiles: ['ABC/README.txt'], failedVerifications: [{ type: 'test', analysis: { rawLogSnippet: 'pnpm unavailable' } }]
    } });
    stubCheckpointStore(restored);
    restored.contextEngine.scanWorkspace = async () => {};
    restored.callModel = async () => { throw new Error('A verified directory needs no extra model work.'); };
    restored.verificationEngine.runCommand = async () => { throw new Error('Non-code artifact must not run project commands.'); };
    await restored.run();
    assert.equal(restored.runOutcome.status, 'completed');
    assert.deepEqual(restored.checkpoint.failedVerifications, []);
    assert.equal(fs.readFileSync(path.join(machine.workspaceRoot, 'ABC', 'README.txt'), 'utf8'), 'Existing content from an earlier run');
  });

  test('resuming a source checkpoint with missing tooling does not call the model to patch source', async t => {
    const { machine } = isolatedRun(t, 'Fix result.cjs');
    fs.writeFileSync(path.join(machine.workspaceRoot, 'package.json'), JSON.stringify({ scripts: { test: 'pnpm test' } }));
    fs.writeFileSync(path.join(machine.workspaceRoot, 'result.cjs'), 'module.exports=1;');
    const restored = new AgentStateMachine({ config: machine.config, send: () => {}, resumeCheckpoint: {
      ...machine.checkpoint, changedFiles: ['result.cjs'], failedVerifications: [{ type: 'test' }]
    } });
    stubCheckpointStore(restored);
    restored.contextEngine.scanWorkspace = async () => {};
    restored.callModel = async () => { throw new Error('Environment failure must not trigger source repair.'); };
    restored.verificationEngine.runCommand = async command => command.startsWith('pnpm') ? { code: 9009, output: 'pnpm unavailable' } : { code: 0 };
    await restored.run();
    assert.equal(restored.runOutcome.status, 'incomplete');
    assert.equal(restored.runOutcome.reason, 'verification_environment');
    assert.equal(restored.repairCycleCount, 0);
    assert.equal(fs.readFileSync(path.join(machine.workspaceRoot, 'result.cjs'), 'utf8'), 'module.exports=1;');
  });

  test('agent run limits normalize independently and reject invalid API values without clamping', () => {
    assert.deepEqual(normalizeAgentRunLimits(), { agentMaxSteps: 24, selfHealingMaxCycles: 4 });
    assert.deepEqual(normalizeAgentRunLimits({ agentMaxSteps: '1000', selfHealingMaxCycles: 0 }, { strict: true }),
      { agentMaxSteps: 1000, selfHealingMaxCycles: 0 });
    assert.deepEqual(normalizeAgentRunLimits({ other: true }, { strict: true, partial: true }), {});
    for (const value of [0, -1, 1.5, 1001, '', ' ', null, true, [], {}, Number.MAX_SAFE_INTEGER]) {
      assert.throws(() => normalizeAgentRunLimits({ agentMaxSteps: value }, { strict: true }), /agentMaxSteps/);
    }
    for (const value of [-1, 1.5, 1001, '', ' ', null, false, [], {}]) {
      assert.throws(() => normalizeAgentRunLimits({ selfHealingMaxCycles: value }, { strict: true, partial: true }), /selfHealingMaxCycles/);
    }
  });

  test('normal observation steps do not spend the disabled repair budget before the actual edit', async t => {
    const { machine, events } = isolatedRun(t, 'Fix result.txt after reading six input files', { agentMaxSteps: 7, selfHealingMaxCycles: 0 });
    for (let index = 1; index <= 6; index++) fs.writeFileSync(path.join(machine.workspaceRoot, `input-${index}.txt`), String(index));
    let calls = 0;
    machine.callModel = async (_system, _messages, chunk) => chunk(JSON.stringify(++calls <= 6
      ? { tool: 'read_file', params: { path: `input-${calls}.txt` } }
      : { tool: 'write_file', params: { path: 'result.txt', content: 'done' } }));
    machine.verificationEngine.runVerificationSuite = async () => ({ ok: true, results: {
      syntax: { ok: true }, test: { ok: true }, lint: { ok: true }
    } });
    await machine.run();
    assert.equal(machine.runOutcome.status, 'completed');
    assert.equal(calls, 7);
    assert.equal(machine.repairCycleCount, 0);
    assert.equal(machine.checkpoint.executionBudget.stepsUsed, 7);
    assert.equal(machine.runOutcome.executionBudget.limitReached, null);
    assert.equal(fs.readFileSync(path.join(machine.workspaceRoot, 'result.txt'), 'utf8'), 'done');
    assert.ok(events.some(event => event.payload?.executionBudget?.stepsUsed === 7));
  });

  test('a step limit is exact, does not start another model call, and retains named recovery evidence', async t => {
    const { machine, events } = isolatedRun(t, 'Inspect workspace', { agentMaxSteps: 3, selfHealingMaxCycles: 20 });
    let calls = 0;
    machine.callModel = async (_system, _messages, chunk) => chunk(JSON.stringify({ tool: 'read_file', params: { path: `file-${++calls}.txt` } }));
    machine.executor.execute = async () => ({ ok: true, result: 'Fixture observation' });
    await machine.run();
    assert.equal(calls, 3);
    assert.equal(machine.runOutcome.status, 'incomplete');
    assert.equal(machine.runOutcome.reason, 'step_limit');
    assert.deepEqual(machine.runOutcome.executionBudget, { maxSteps: 3, stepsUsed: 3, maxRepairCycles: 20, repairCyclesUsed: 0, limitReached: 'steps' });
    assert.ok(events.some(event => event.type === 'recovery' && event.checkpoint?.sessionId && event.executionBudget.limitReached === 'steps'));
  });

  test('repair budget zero permits an initial attempt but no automatic retry after a tool failure', async t => {
    const { machine } = isolatedRun(t, 'Inspect workspace', { agentMaxSteps: 24, selfHealingMaxCycles: 0 });
    let calls = 0;
    machine.callModel = async (_system, _messages, chunk) => { calls++; chunk(JSON.stringify({ tool: 'run_command', params: { command: 'node diagnostic.js' } })); };
    machine.executor.execute = async () => ({ ok: false, error: 'Fixture command failure' });
    await machine.run();
    assert.equal(calls, 1);
    assert.equal(machine.runOutcome.reason, 'tool_failure');
    assert.equal(machine.runOutcome.executionBudget.limitReached, 'repair_cycles');
    assert.equal(machine.repairCycleCount, 0);
  });

  test('new tool failures consume only the explicit repair budget, not the larger step budget', async t => {
    const { machine } = isolatedRun(t, 'Inspect workspace', { agentMaxSteps: 24, selfHealingMaxCycles: 1 });
    let calls = 0;
    machine.callModel = async (_system, _messages, chunk) => chunk(JSON.stringify({ tool: 'run_command', params: { command: `node diagnostic-${++calls}.js` } }));
    machine.executor.execute = async () => ({ ok: false, error: 'Fixture command failure' });
    await machine.run();
    assert.equal(calls, 2);
    assert.equal(machine.runOutcome.reason, 'tool_failure');
    assert.equal(machine.runOutcome.executionBudget.limitReached, 'repair_cycles');
    assert.equal(machine.repairCycleCount, 1);
  });

  test('observing a pending failure does not consume another repair and success on the last step is completed', async t => {
    const { machine } = isolatedRun(t, 'Inspect workspace', { agentMaxSteps: 9, selfHealingMaxCycles: 1 });
    let calls = 0;
    machine.callModel = async (_system, _messages, chunk) => {
      calls++;
      if (calls === 9) return chunk('The diagnostic now succeeds.');
      chunk(JSON.stringify(calls === 1 || calls === 8
        ? { tool: 'run_command', params: { command: `node diagnostic-${calls}.js` } }
        : { tool: 'read_file', params: { path: `input-${calls}.txt` } }));
    };
    machine.executor.execute = async () => calls === 1 ? { ok: false, error: 'Fixture command failure' } : { ok: true, result: 'Fixture observation' };
    await machine.run();
    assert.equal(calls, 9);
    assert.equal(machine.runOutcome.status, 'completed');
    assert.equal(machine.repairCycleCount, 1);
    assert.equal(machine.runOutcome.executionBudget.limitReached, null);
    assert.deepEqual(machine.checkpoint.toolFailures, []);
  });

  test('native format corrections still count toward the exact step limit', async t => {
    const { machine } = isolatedRun(t, 'Inspect workspace', { agentMaxSteps: 2 });
    let calls = 0;
    machine.callModel = async () => {
      calls++;
      const error = new Error('Fixture invalid native tool call');
      error.modelFailure = { code: 'malformed_tool_call', toolCallValidationComplete: true, toolCallsEmitted: false };
      throw error;
    };
    await machine.run();
    assert.equal(calls, 2);
    assert.equal(machine.runOutcome.reason, 'step_limit');
    assert.equal(machine.checkpoint.executionBudget.stepsUsed, 2);
    assert.equal(machine.toolExecutionSummary.length, 0);
  });

  test('explicit resume starts a new bounded run while preserving the previous run budget and provider session', async t => {
    const { machine } = isolatedRun(t, 'Inspect workspace', { agentMaxSteps: 1 });
    machine.callModel = async (_system, _messages, chunk) => chunk(JSON.stringify({ tool: 'list_dir', params: { path: '.' } }));
    machine.executor.execute = async () => ({ ok: true, result: [] });
    await machine.run();
    assert.equal(machine.runOutcome.reason, 'step_limit');
    const restored = new AgentStateMachine({ config: { ...machine.config, agentMaxSteps: 3 }, resumeCheckpoint: machine.checkpoint, send: () => {} });
    stubCheckpointStore(restored);
    restored.contextEngine.scanWorkspace = async () => {};
    restored.callModel = async (_system, _messages, chunk) => chunk('Workspace inspection is complete.');
    await restored.run();
    assert.equal(restored.runOutcome.status, 'completed');
    assert.equal(restored.checkpoint.resumedFrom.executionBudget.limitReached, 'steps');
    assert.equal(restored.checkpoint.executionBudget.stepsUsed, 1);
    assert.equal(restored.checkpoint.executionBudget.maxSteps, 3);
    assert.equal(restored.checkpoint.providerSessionId, machine.checkpoint.providerSessionId);
  });

  test('an identity question completes without file edits or a false recovery banner', async t => {
    const goal = '\uc774 \uc5d0\uc774\uc804\ud2b8\ub294 \ub204\uac00 \ub9cc\ub4e4\uc5c8\ub294\uc9c0 \uc544\ub098?';
    const { machine, events } = isolatedRun(t, goal);
    let modelCalls = 0;
    machine.callModel = async (_prompt, messages, onChunk) => {
      modelCalls++;
      assert.equal(messages.at(-1).content, goal);
      onChunk('The project author is identified in package.json.');
    };
    await machine.run();
    assert.equal(modelCalls, 1);
    assert.equal(machine.runOutcome.status, 'completed');
    assert.equal(machine.runOutcome.reason, 'completed');
    assert.equal(machine.diffTracker.changedFiles.size, 0);
    assert.ok(!events.some(event => event.type === 'recovery' || event.type === 'error'));
    assert.equal(events.find(event => event.type === 'end').outcome.status, 'completed');
  });

  test('reading a function named add does not force edits or an edit-repair loop', async t => {
    const { machine, events } = isolatedRun(t, 'Read calc.cjs and report add(2,3). Observation only.');
    let calls = 0;
    machine.callModel = async (_prompt, _messages, onChunk) => {
      calls++;
      onChunk(calls === 1 ? '<read_file path="calc.cjs" />' : 'The result is 5.');
    };
    t.mock.method(machine.executor, 'execute', async tool => {
      assert.equal(tool, 'read_file');
      return { ok: true, content: 'exports.add = (a,b) => a+b;' };
    });
    await machine.run();
    assert.equal(machine.runOutcome.status, 'completed');
    assert.equal(machine.diffTracker.changedFiles.size, 0);
    assert.equal(calls, 2);
    assert.equal(events.some(event => event.type === 'recovery'), false);
  });

  test('an empty or whitespace-only model reply cannot report a completed information request', async t => {
    for (const reply of ['', '  \r\n\t']) {
      const { machine, events } = isolatedRun(t, 'Explain the current module.');
      machine.callModel = async (_prompt, _messages, onChunk) => onChunk(reply);
      await machine.run();
      assert.notEqual(events.find(e => e.type === 'end')?.outcome?.status, 'completed');
      assert.ok(events.some(e => e.type === 'error'));
    }
  });

  test('a mixed explanation and edit request cannot complete without actual file changes', async t => {
    for (const goal of ['\uc218\uc815 \ubc29\ubc95\uc744 \uc124\uba85\ud558\uace0 \ucf54\ub4dc\ub97c \uc218\uc815\ud574\uc918',
      '\uc218\uc815 \ubc29\ubc95\uc744 \uc124\uba85\ud558\uace0 \ucf54\ub4dc\ub97c \uc218\uc815\ud558\ub77c', 'Explain the bug and fix it']) {
      const { machine } = isolatedRun(t, goal);
      machine.callModel = async (_prompt, _messages, onChunk) => onChunk('Here is an explanation of the fix.');
      await machine.run();
      assert.equal(machine.runOutcome.status, 'incomplete', goal);
      assert.equal(machine.runOutcome.reason, 'no_changes_applied', goal);
    }
  });

  test('executor preserves a tool-reported failure instead of wrapping it as successful', async t => {
    const tool = ToolRegistry.getTool('fetch_url');
    t.mock.method(tool, 'execute', async () => ({ ok: false, error: 'Fixture body timeout' }));
    const executor = new CapabilityExecutor({ getConfig: () => ({ permissionMode: 'operator' }) });
    const result = await executor.execute('fetch_url', { url: 'https://fixture.example/' });
    assert.equal(result.ok, false);
    assert.equal(result.result.ok, false);
    assert.equal(result.error, 'Fixture body timeout');
  });

  test('a long-running action emits tool progress and always clears its heartbeat', async t => {
    const { machine, events } = isolatedRun(t, 'Read the fixture.');
    const timers = [];
    const cleared = [];
    t.mock.method(globalThis, 'setInterval', callback => {
      const timer = { callback, unref() {} };
      timers.push(timer);
      return timer;
    });
    t.mock.method(globalThis, 'clearInterval', timer => { cleared.push(timer); });
    machine.callModel = async (_prompt, _messages, onChunk) => onChunk(JSON.stringify({ tool_calls: [{ tool: 'read_file', params: { path: 'fixture.txt' } }] }));
    machine.executor.execute = async () => {
      timers.at(-1).callback();
      return { ok: true, result: 'Fixture' };
    };
    await machine.run();
    assert.ok(events.some(e => e.type === 'status' && e.heartbeat && e.tool === 'read_file'));
    assert.deepEqual(cleared, timers);
  });

  test('cancellation during native approval stops without execution or a dangling approval', async t => {
    const { eventBus } = await import('../../common/eventBus.js');
    const { listPendingApprovals, respondToApproval } = await import('../../security/approvalGate.js');
    const stop = new AbortController();
    const { machine, events } = isolatedRun(t, 'Check the runtime version.', { permissionMode: 'strict' });
    machine.abortSignal = stop.signal;
    let id;
    const pending = payload => { id = payload.id; stop.abort(); };
    eventBus.on('approval:pending', pending);
    t.after(() => eventBus.off('approval:pending', pending));
    machine.callModel = async (_prompt, _messages, onChunk) => onChunk(JSON.stringify({ tool_calls: [{ tool: 'run_command', params: { command: 'node --version' } }] }));
    let executions = 0;
    machine.executor.runCapability = async () => { executions++; };
    await machine.run();
    assert.equal(events.find(e => e.type === 'end')?.outcome?.status, 'stopped');
    assert.equal(executions, 0);
    assert.equal(listPendingApprovals().some(p => p.id === id), false);
    assert.equal(respondToApproval(id, 'approve'), false);
  });

  test('unresolved verification failure ends incomplete and retains recovery', async (t) => {
    const { machine, events } = isolatedRun(t, 'Fix result.txt');
    machine.callModel = async (_prompt, _messages, onChunk) => {
      onChunk(JSON.stringify({ tool_calls: [{ tool: 'write_file', params: { path: 'result.txt', content: 'updated' } }] }));
    };
    machine.executor.runCapability = async (_tool, params) => {
      fs.writeFileSync(path.join(machine.workspaceRoot, params.path), params.content);
      return { ok: true, result: {} };
    };
    machine.verificationEngine.runVerificationSuite = async () => ({
      ok: false, results: { syntax: { ok: true }, test: { ok: false }, lint: { ok: true } }
    });
    await machine.run();
    assert.equal(events.find(event => event.type === 'end').outcome.status, 'incomplete');
    assert.ok(events.some(event => event.type === 'recovery' && event.checkpoint));
    const answer = events.filter(event => event.type === 'chunk').map(event => event.text).join('');
    assert.match(answer, /Work remains incomplete/);
    assert.doesNotMatch(answer, /Work completed/);
  });

  test('a repaired verification failure ends completed', async (t) => {
    const { machine, events } = isolatedRun(t, 'Fix result.txt');
    machine.callModel = async (_prompt, _messages, onChunk) => {
      onChunk(JSON.stringify({ tool_calls: [{ tool: 'write_file', params: { path: 'result.txt', content: 'updated' } }] }));
    };
    machine.executor.runCapability = async (_tool, params) => {
      fs.writeFileSync(path.join(machine.workspaceRoot, params.path), params.content);
      return { ok: true, result: {} };
    };
    let verificationCalls = 0;
    machine.verificationEngine.runVerificationSuite = async () => {
      const ok = ++verificationCalls > 1;
      return { ok, results: { syntax: { ok: true }, test: { ok }, lint: { ok: true } } };
    };
    await machine.run();
    assert.equal(events.find(event => event.type === 'end').outcome.status, 'completed');
    assert.deepEqual(machine.checkpoint.failedVerifications, []);
    assert.equal(machine.checkpoint.outcome.status, 'completed');
  });

  test('stopping a tool batch prevents later actions and saves a checkpoint', async (t) => {
    const controller = new AbortController();
    const { machine, events } = isolatedRun(t, 'Inspect workspace');
    machine.abortSignal = controller.signal;
    machine.callModel = async (_prompt, _messages, onChunk) => {
      onChunk(JSON.stringify({ tool_calls: [
        { tool: 'list_dir', params: { path: '.' } },
        { tool: 'read_file', params: { path: 'next.txt' } }
      ] }));
    };
    let executions = 0;
    machine.executor.execute = async () => {
      executions++;
      controller.abort();
      return { ok: true, result: { files: [] } };
    };
    await machine.run();
    assert.equal(executions, 1);
    assert.equal(events.find(event => event.type === 'end').outcome.status, 'stopped');
    assert.ok(events.some(event => event.type === 'checkpoint'));
  });

  test('executor reports a nonzero command exit as a tool failure', async () => {
    const executor = new CapabilityExecutor({ getConfig: () => ({ permissionMode: 'full' }) });
    executor.runCapability = async () => ({ code: 2, output: 'Command failed' });
    const result = await executor.execute('run_command', { command: 'echo diagnostic' });
    assert.equal(result.ok, false);
    assert.equal(result.result.code, 2);
    assert.match(result.error, /code 2/);
  });

  test('summarizes original history before sliding context deletion', async (t) => {
    const { machine } = isolatedRun(t, 'Analyze conversation history', { contextLimit: 1000 });
    machine.activeConversation = Array.from({ length: 12 }, () => ({ role: 'user', content: 'history '.repeat(500) }));
    machine.maybeCompactContext = async (_prompt, messages) => {
      assert.equal(messages.length, 12);
      return { compacted: true, messages: [{ role: 'user', content: 'Preserved history summary' }] };
    };
    machine.callModel = async (_prompt, messages, onChunk) => {
      assert.match(messages[0].content, /Preserved history summary/);
      onChunk('Conversation analyzed.');
    };
    await machine.run();
    assert.equal(machine.runOutcome.status, 'completed');
  });

  test('an unrelated successful observation does not resolve a failed command', async (t) => {
    const { machine } = isolatedRun(t, 'Inspect workspace', { selfHealingMaxCycles: 3 });
    let calls = 0;
    machine.callModel = async (_prompt, messages, onChunk) => {
      calls++;
      if (calls > 1) assert.ok(messages.some(message => String(message.content).includes('missing-module')));
      if (calls === 1) onChunk(JSON.stringify({ tool_calls: [{ tool: 'run_command', params: { command: 'node diagnostic.js' } }] }));
      else if (calls === 2) onChunk(JSON.stringify({ tool_calls: [{ tool: 'list_dir', params: { path: '.' } }] }));
      else onChunk('All work completed.');
    };
    machine.executor.execute = async tool => tool === 'run_command'
      ? { ok: false, error: 'Command exited with code 1.', result: { output: 'missing-module' } }
      : { ok: true, result: [] };
    await machine.run();
    assert.equal(machine.runOutcome.status, 'incomplete');
    assert.equal(machine.runOutcome.reason, 'tool_failure');
  });

  test('a successful corrected command clears its pending failure', async (t) => {
    const { machine } = isolatedRun(t, 'Inspect workspace', { selfHealingMaxCycles: 3 });
    let calls = 0;
    machine.callModel = async (_prompt, _messages, onChunk) => {
      if (++calls <= 2) onChunk(JSON.stringify({ tool_calls: [{ tool: 'run_command', params: { command: `echo attempt-${calls}` } }] }));
      else onChunk('Diagnostic complete.');
    };
    machine.executor.execute = async () => calls === 1
      ? { ok: false, error: 'Command exited with code 1.' }
      : { ok: true, result: { code: 0, output: 'OK' } };
    await machine.run();
    assert.equal(machine.runOutcome.status, 'completed');
    assert.deepEqual(machine.checkpoint.toolFailures, []);
  });

  test('a failed patch preview can be superseded by a verified edit of all its target files', async t => {
    const { machine } = isolatedRun(t, 'Fix result.js', { selfHealingMaxCycles: 3 });
    fs.writeFileSync(path.join(machine.workspaceRoot, 'result.js'), 'export const result = 1;\n');
    let calls = 0;
    machine.callModel = async (_prompt, _messages, onChunk) => {
      const tool = ++calls === 1 ? { tool: 'review_patch_transaction', params: { operations: [
        { tool: 'patch_file', params: { path: 'result.js', search: '1', replace: '2' } }
      ] } } : { tool: 'write_file', params: { path: 'result.js', content: 'export const result = 2;\n' } };
      onChunk(JSON.stringify({ tool_calls: [tool] }));
    };
    machine.executor.runCapability = async (tool, params) => {
      if (tool === 'review_patch_transaction') return { ok: false, error: 'Fixture stale preview' };
      fs.writeFileSync(path.join(machine.workspaceRoot, params.path), params.content);
      return { ok: true, result: {} };
    };
    machine.verificationEngine.runVerificationSuite = async () => ({ ok: true, results: {
      syntax: { ok: true }, test: { ok: true }, lint: { ok: true, skipped: true }
    } });
    await machine.run();
    assert.equal(machine.runOutcome.status, 'completed');
    assert.deepEqual(machine.checkpoint.toolFailures, []);
    assert.equal(machine.checkpoint.resolvedToolFailures.length, 1);
  });

  test('nested patch operation parameters preserve preview, application and change tracking', async t => {
    const { machine } = isolatedRun(t, 'Fix result.js');
    fs.writeFileSync(path.join(machine.workspaceRoot, 'result.js'), 'export const result = 1;\n');
    const operations = [{ tool: 'patch_file', params: { path: 'result.js', search: '= 1', replace: '= 2' } }];
    const preview = await machine.executor.execute('review_patch_transaction', { operations });
    assert.equal(preview.ok, true);
    assert.match(fs.readFileSync(path.join(machine.workspaceRoot, 'result.js'), 'utf8'), /= 1/);
    assert.deepEqual(machine.getMutationPaths({ tool: 'apply_patch_transaction', params: { operations } }), ['result.js']);
    const applied = new PatchTransactionManager(machine.workspaceRoot).apply(operations);
    assert.equal(applied.ok, true);
    assert.match(fs.readFileSync(path.join(machine.workspaceRoot, 'result.js'), 'utf8'), /= 2/);
  });

  test('preview recovery retains unrelated, partial, denied and later failures', t => {
    const { machine } = isolatedRun(t, 'Fix result.js');
    const failure = { tool: 'review_patch_transaction', reason: 'execution_failed', params: { operations: [
      { type: 'patch_file', path: 'result.js', search: '1', replace: '2' }
    ] } };
    const otherTarget = { ...failure, params: { operations: [
      ...failure.params.operations, { type: 'write_file', path: 'other.js', content: '2' }
    ] } };
    const denied = { ...failure, reason: 'rejected' };
    const blocked = { ...failure, reason: 'blocked' };
    const realEditFailure = { ...failure, tool: 'patch_file' };
    const commandFailure = { tool: 'run_command', reason: 'execution_failed' };
    const malformed = { ...failure, params: { operations: [{ tool: 'patch_file' }] } };
    const escaped = { ...failure, params: { operations: [{ type: 'write_file', path: '../outside.js' }] } };
    const failures = [failure, otherTarget, denied, blocked, realEditFailure, commandFailure, malformed, escaped];
    const mutations = new Map([['result.js', 2]]);
    assert.deepEqual(machine.resolveVerifiedPatchPreviews(failures, mutations, new Map([[failure, 3]])), failures);
    assert.deepEqual(machine.resolveVerifiedPatchPreviews(failures, new Map([['unrelated.js', 4]])), failures);
    assert.deepEqual(machine.resolveVerifiedPatchPreviews(failures, mutations), failures.slice(1));
    assert.equal(machine.checkpoint.resolvedToolFailures.length, 1);
  });

  test('patch normalization keeps outer fields authoritative and rejects workspace escapes', t => {
    const { machine } = isolatedRun(t, 'Fix result.js');
    const manager = new PatchTransactionManager(machine.workspaceRoot);
    const op = manager.normalizeOperation({ tool: 'patch_file', path: 'result.js', replace: 'outer',
      params: { type: 'write_file', path: 'other.js', search: '1', replace: 'inner' } });
    assert.equal(op.type, 'patch_file');
    assert.equal(op.path, 'result.js');
    assert.equal(op.search, '1');
    assert.equal(op.replace, 'outer');
    assert.equal(op.params, undefined);
    const legacy = { op: 'patch_file', path: 'result.js', search: '1', replace: '2' };
    assert.equal(manager.normalizeOperation(legacy).type, 'patch_file');
    const failure = { tool: 'review_patch_transaction', reason: 'execution_failed', params: { operations: [legacy] } };
    assert.deepEqual(machine.resolveVerifiedPatchPreviews([failure], new Map([['result.js', 1]])), []);
    for (const name of ['review_patch_transaction', 'apply_patch_transaction']) {
      const items = ToolRegistry.getTool(name).inputSchema.properties.operations.items;
      assert.deepEqual(items.required, ['type', 'path']);
      assert.deepEqual(items.properties.type.enum, ['write_file', 'patch_file', 'patch_lines']);
    }
    assert.throws(() => manager.normalizeOperation({ tool: 'write_file', params: { path: '../outside.js' } }), /escapes workspace/);
    assert.throws(() => manager.normalizeOperation([]), /must be an object/);
    assert.deepEqual(machine.getMutationPaths({ tool: 'apply_patch_transaction', params: { operations: [
      { tool: 'write_file', params: { path: '../outside.js' } }
    ] } }), []);
  });

  test('failed verification never resolves a failed preview after a replacement edit', async t => {
    const { machine } = isolatedRun(t, 'Fix result.js');
    const failure = { tool: 'review_patch_transaction', reason: 'execution_failed', params: { operations: [
      { type: 'write_file', path: 'result.js', content: '2' }
    ] } };
    machine.checkpoint.toolFailures = [failure];
    machine.callModel = async (_prompt, _messages, onChunk) => onChunk(JSON.stringify({ tool_calls: [
      { tool: 'write_file', params: { path: 'result.js', content: 'broken' } }
    ] }));
    machine.executor.execute = async () => ({ ok: true, result: {} });
    machine.verificationEngine.runVerificationSuite = async () => ({ ok: false, results: {
      syntax: { ok: false, analysis: 'Fixture syntax error' }, test: { ok: true }, lint: { ok: true, skipped: true }
    } });
    await machine.run();
    assert.equal(machine.runOutcome.status, 'incomplete');
    assert.deepEqual(machine.checkpoint.toolFailures, [failure]);
    assert.equal(machine.checkpoint.resolvedToolFailures, undefined);
  });

  test('should initialize with correct default states and checkpoint', () => {
    const sentEvents = [];
    const send = (evt) => sentEvents.push(evt);
    const messages = [{ role: 'user', content: 'Create a status page' }];
    const config = { selfHealingMaxCycles: 2, systemInstruction: 'System prompt', workspaceRoot: path.resolve('.') };

    const stateMachine = new AgentStateMachine({ send, messages, config });
    stubCheckpointStore(stateMachine);

    assert.strictEqual(stateMachine.state, AgentState.PLAN);
    assert.strictEqual(stateMachine.cycleCount, 0);
    assert.strictEqual(stateMachine.checkpoint.userGoal, 'Create a status page');
    assert.strictEqual(stateMachine.checkpoint.cycleCount, 0);
    assert.strictEqual(stateMachine.contextEngine.workspaceRoot, path.resolve(config.workspaceRoot || '.'));
  });

  test('should transition through lifecycle stages during a run', async () => {
    const sentEvents = [];
    const send = (evt) => sentEvents.push(evt);
    const messages = [{ role: 'user', content: 'Fix compiler errors' }];
    const config = { selfHealingMaxCycles: 2, systemInstruction: 'System', workspaceRoot: path.resolve('.') };

    const stateMachine = new AgentStateMachine({ send, messages, config });
    stubCheckpointStore(stateMachine);

    // Mock callModel to simulate agent finalizing work in one cycle (no tool calls)
    stateMachine.callModel = async (systemPrompt, conversation, onChunk) => {
      onChunk('Plan: 1. Verify files\nI believe all tasks are completed.');
    };

    // Mock ContextEngine scan to prevent actual fs scan
    stateMachine.contextEngine.scanWorkspace = async () => {};

    await stateMachine.run();

    // Validate that we transitioned through PLAN and then completed (SUMMARIZE)
    const stateChanges = sentEvents.filter(e => e.type === 'state_change');
    assert.ok(stateChanges.length >= 2);

    const states = stateChanges.map(sc => sc.state);
    assert.ok(states.includes(AgentState.PLAN));
    assert.ok(states.includes(AgentState.SUMMARIZE));

    const endEvents = sentEvents.filter(e => e.type === 'end');
    assert.strictEqual(endEvents.length, 1);
  });

  test('should emit context indexing status during a run', async () => {
    const sentEvents = [];
    const send = (evt) => sentEvents.push(evt);
    const messages = [{ role: 'user', content: 'Summarize the workspace' }];
    const config = { selfHealingMaxCycles: 1, systemInstruction: 'System', workspaceRoot: path.resolve('.') };

    const stateMachine = new AgentStateMachine({ send, messages, config });
    stubCheckpointStore(stateMachine);
    stateMachine.contextEngine.scanWorkspace = async () => {
      stateMachine.contextEngine.scanStats = {
        indexedFiles: 12,
        skippedLargeFiles: 1,
        broadRoot: false
      };
    };
    stateMachine.callModel = async (_systemPrompt, _conversation, onChunk) => {
      onChunk('Plan: Done\nWorkspace summary complete.');
    };

    await stateMachine.run();

    const statusEvents = sentEvents.filter(event => event.type === 'status');
    assert.ok(statusEvents.some(event => event.status === 'Indexing workspace context...'));
    const readyEvent = statusEvents.find(event => String(event.status || '').startsWith('Workspace context ready:'));
    assert.ok(readyEvent);
    assert.strictEqual(readyEvent.phase, 'CONTEXT');
    assert.strictEqual(readyEvent.scanStats.indexedFiles, 12);
  });

  test('should emit recovery event and checkpoint on agent error', async () => {
    const sentEvents = [];
    const send = (evt) => sentEvents.push(evt);
    const messages = [{ role: 'user', content: 'Trigger recoverable failure' }];
    const config = { selfHealingMaxCycles: 1, systemInstruction: 'System', workspaceRoot: path.resolve('.') };

    const stateMachine = new AgentStateMachine({ send, messages, config });
    stubCheckpointStore(stateMachine);
    stateMachine.contextEngine.scanWorkspace = async () => {
      throw new Error('scan exploded');
    };

    await stateMachine.run();

    const recoveryEvent = sentEvents.find(event => event.type === 'recovery' && event.reason === 'agent_error');
    assert.ok(recoveryEvent);
    assert.match(recoveryEvent.error, /scan exploded/);
    assert.ok(recoveryEvent.checkpoint?.sessionId);
    assert.ok(sentEvents.some(event => event.type === 'checkpoint'));
    assert.ok(sentEvents.some(event => event.type === 'error' && /scan exploded/.test(event.error)));
    assert.ok(sentEvents.some(event => event.type === 'end'));
  });

  test('model retry and reasoning progress reach status UX without entering assistant text', async t => {
    const events = [], requests = [], chunks = [];
    const machine = new AgentStateMachine({ send: event => events.push(event),
      messages: [{ role: 'user', content: 'Reply with OK.' }],
      config: { activeModel: 'opencode-go:muse-spark-1.3-contributor', opencodeGoEnabled: true,
        opencodeGoApiKey: 'test-go-key', workspaceRoot: path.resolve('.') }, providerSessionId: 'test-go-session' });
    t.mock.method(globalThis, 'fetch', async (_url, options) => {
      requests.push(options);
      const payload = requests.length === 1
        ? [{ type: 'response.failed', response: { error: { code: 'server_error', message: 'The model failed to generate a response.' } } }]
        : [{ type: 'response.reasoning_text.delta', delta: '<run_command>not an action</run_command>' },
          { type: 'response.output_text.delta', delta: 'OK' }, { type: 'response.completed' }];
      return new Response(payload.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''),
        { headers: { 'Content-Type': 'text/event-stream', 'x-request-id': 'test-go-request' } });
    });
    await machine.callModel('Original system instructions.', machine.messages, text => chunks.push(text));
    assert.deepEqual(chunks, ['OK']);
    assert.equal(requests.length, 2);
    assert.equal(requests[0].body, requests[1].body);
    assert.ok(events.some(event => event.type === 'status' && event.retryAttempt === 2 && event.level === 'warning'));
    assert.ok(events.some(event => event.type === 'status' && /reasoning in progress/.test(event.status)));
    assert.ok(events.some(event => event.type === 'status' && /Receiving model output/.test(event.status)));
    const reasoning = events.filter(event => event.type === 'reasoning');
    assert.equal(reasoning.length, 1);
    assert.equal(reasoning[0].text, '<run_command>not an action</run_command>');
    assert.equal(reasoning[0].model, 'opencode-go:muse-spark-1.3-contributor');
    assert.equal(typeof reasoning[0].requestId, 'string');
    assert.equal(machine.toolExecutionSummary.length, 0);
  });

  test('final provider error diagnostics survive the recovery checkpoint', async () => {
    const events = [];
    const machine = new AgentStateMachine({ send: event => events.push(event),
      messages: [{ role: 'user', content: 'Reply with OK.' }],
      config: { workspaceRoot: path.resolve('.') } });
    stubCheckpointStore(machine);
    machine.contextEngine.scanWorkspace = async () => {};
    const error = new Error('OpenCode Go model failed.');
    error.modelFailure = { provider: 'opencode-go', model: 'muse-spark-1.3-contributor',
      protocol: 'responses', code: 'server_error', requestId: 'test-request', attempts: 2 };
    machine.callModel = async () => { throw error; };
    await machine.run();
    assert.deepEqual(machine.checkpoint.outcome.modelFailure, error.modelFailure);
    assert.deepEqual(events.find(event => event.type === 'end').outcome.modelFailure, error.modelFailure);
    assert.ok(events.some(event => event.type === 'recovery' && event.checkpoint));
  });

  test('should handle tool execution and observation state streaming', async () => {
    const sentEvents = [];
    const send = (evt) => sentEvents.push(evt);
    const messages = [{ role: 'user', content: 'Scan the folder' }];
    const config = { selfHealingMaxCycles: 2, workspaceRoot: path.resolve('.') };

    const stateMachine = new AgentStateMachine({ send, messages, config });
    stubCheckpointStore(stateMachine);
    
    let callCount = 0;
    stateMachine.callModel = async (systemPrompt, conversation, onChunk) => {
      callCount++;
      if (callCount === 1) {
        onChunk('Plan: 1. List files\n<list_dir path="." />');
      } else {
        onChunk('Plan: Done\nEverything is set.');
      }
    };

    // Mock engines
    stateMachine.contextEngine.scanWorkspace = async () => {};
    stateMachine.executor.execute = async (tool, params, options) => {
      return { ok: true, result: { files: ['index.js'] } };
    };

    await stateMachine.run();

    const stateChanges = sentEvents.filter(e => e.type === 'state_change');
    const states = stateChanges.map(sc => sc.state);

    // Should transition PLAN -> ACT -> OBSERVE -> SUMMARIZE
    assert.ok(states.includes(AgentState.PLAN));
    assert.ok(states.includes(AgentState.ACT));
    assert.ok(states.includes(AgentState.OBSERVE));
    assert.ok(states.includes(AgentState.SUMMARIZE));

    // Verify tool execution ended properly
    const toolEnd = sentEvents.find(e => e.type === 'tool_end');
    assert.ok(toolEnd);
    assert.strictEqual(toolEnd.tool, 'list_dir');
  });

  test('should continue planning after observation-only tools', async () => {
    const sentEvents = [];
    const send = (evt) => sentEvents.push(evt);
    const messages = [{ role: 'user', content: 'Inspect package file' }];
    const config = { selfHealingMaxCycles: 2, workspaceRoot: path.resolve('.') };

    const stateMachine = new AgentStateMachine({ send, messages, config });
    stubCheckpointStore(stateMachine);

    let callCount = 0;
    stateMachine.callModel = async (_systemPrompt, _conversation, onChunk) => {
      callCount++;
      if (callCount === 1) {
        onChunk('Plan: inspect package\n{"tool":"read_file","params":{"path":"package.json"}}');
      } else {
        onChunk('I inspected package.json and can continue from the observed context.');
      }
    };
    stateMachine.contextEngine.scanWorkspace = async () => {};
    stateMachine.executor.execute = async () => ({
      ok: true,
      result: { path: 'package.json', content: '{"name":"blackhole"}' }
    });

    await stateMachine.run();

    assert.strictEqual(callCount, 2);
    assert.ok(sentEvents.some(evt => evt.type === 'state_change' && evt.payload?.observationOnly));
    const visibleText = sentEvents.filter(evt => evt.type === 'chunk').map(evt => evt.text).join('');
    assert.match(visibleText, /observed context/);
  });

  test('should retry premature completion after observation-only tools when edits are required', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'blackhole-premature-completion-'));
    try {
      fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
      fs.writeFileSync(path.join(tempDir, 'src', 'stats.js'), 'export function average() { return NaN; }\n', 'utf8');

      const sentEvents = [];
      const send = (evt) => sentEvents.push(evt);
      const messages = [{ role: 'user', content: 'Fix average([]) so it returns 0.' }];
      const config = { selfHealingMaxCycles: 3, workspaceRoot: tempDir };

      const stateMachine = new AgentStateMachine({ send, messages, config });
      stubCheckpointStore(stateMachine);

      let callCount = 0;
      stateMachine.callModel = async (_systemPrompt, _conversation, onChunk) => {
        callCount++;
        if (callCount === 1) {
          onChunk('Plan: inspect the file\n{"tool":"read_file","params":{"path":"src/stats.js"}}');
        } else if (callCount === 2) {
          onChunk('The task is complete.');
        } else {
          onChunk('Plan: apply the fix\n{"tool":"patch_file","params":{"path":"src/stats.js","search":"return NaN;","replace":"return 0;"}}');
        }
      };
      stateMachine.contextEngine.scanWorkspace = async () => {};
      stateMachine.executor.runCapability = async (tool) => ({
        ok: true,
        result: tool === 'read_file'
          ? { path: 'src/stats.js', content: 'export function average() { return NaN; }\n' }
          : { path: path.join(tempDir, 'src', 'stats.js') }
      });
      stateMachine.verificationEngine.runVerificationSuite = async () => ({
        ok: true,
        results: {
          syntax: { ok: true, skipped: false },
          test: { ok: true, skipped: true },
          lint: { ok: true, skipped: true }
        },
        targets: {}
      });

      await stateMachine.run();

      assert.strictEqual(callCount, 3);
      assert.ok(sentEvents.some(evt => evt.type === 'state_change' && evt.payload?.prematureCompletion));
      assert.ok(sentEvents.some(evt => evt.type === 'tool_end' && evt.tool === 'patch_file'));
      assert.ok(stateMachine.activeConversation.some(msg => String(msg.content).includes('Premature Completion Guard')));
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('should redirect observation-only cycles toward mutation when edits are required', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'blackhole-observation-edit-redirect-'));
    try {
      fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
      fs.writeFileSync(path.join(tempDir, 'src', 'stats.js'), 'export function average() { return NaN; }\n', 'utf8');

      const sentEvents = [];
      const send = (evt) => sentEvents.push(evt);
      const messages = [{ role: 'user', content: 'Fix average so it returns 0.' }];
      const config = { selfHealingMaxCycles: 2, workspaceRoot: tempDir };

      const stateMachine = new AgentStateMachine({ send, messages, config });
      stubCheckpointStore(stateMachine);

      let callCount = 0;
      stateMachine.callModel = async (_systemPrompt, conversation, onChunk) => {
        callCount++;
        const transcript = conversation.map(message => String(message.content || '')).join('\n');
        if (callCount === 1) {
          onChunk('Plan: read the file\n{"tool":"read_file","params":{"path":"src/stats.js"}}');
        } else {
          assert.match(transcript, /Observation-Only Edit Redirect/);
          onChunk('Plan: patch the file\n{"tool":"patch_file","params":{"path":"src/stats.js","search":"return NaN;","replace":"return 0;"}}');
        }
      };
      stateMachine.contextEngine.scanWorkspace = async () => {};
      stateMachine.executor.runCapability = async (tool) => ({
        ok: true,
        result: tool === 'read_file'
          ? { path: 'src/stats.js', content: 'export function average() { return NaN; }\n' }
          : { path: path.join(tempDir, 'src', 'stats.js') }
      });
      stateMachine.verificationEngine.runVerificationSuite = async () => ({
        ok: true,
        results: {
          syntax: { ok: true, skipped: false },
          test: { ok: true, skipped: true },
          lint: { ok: true, skipped: true }
        },
        targets: {}
      });

      await stateMachine.run();

      assert.strictEqual(callCount, 2);
      assert.ok(sentEvents.some(evt => evt.type === 'state_change' && evt.payload?.observationOnlyEditRedirect));
      assert.ok(sentEvents.some(evt => evt.type === 'tool_end' && evt.tool === 'patch_file'));
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('should trigger loop guard for repeated identical tool calls', async () => {
    const sentEvents = [];
    const send = (evt) => sentEvents.push(evt);
    const messages = [{ role: 'user', content: 'Avoid repeating reads' }];
    const config = { selfHealingMaxCycles: 3, agentLoopGuardMaxRepeats: 1, workspaceRoot: path.resolve('.') };

    const stateMachine = new AgentStateMachine({ send, messages, config });
    stubCheckpointStore(stateMachine);

    let callCount = 0;
    let executeCount = 0;
    stateMachine.callModel = async (_systemPrompt, _conversation, onChunk) => {
      callCount++;
      if (callCount <= 2) {
        onChunk('Plan: repeat read\n{"tool":"read_file","params":{"path":"package.json"}}');
      } else {
        onChunk('Changed strategy after loop guard.');
      }
    };
    stateMachine.contextEngine.scanWorkspace = async () => {};
    stateMachine.executor.execute = async () => {
      executeCount++;
      return { ok: true, result: { path: 'package.json', content: '{}' } };
    };

    await stateMachine.run();

    assert.strictEqual(executeCount, 1);
    const loopGuardEvent = sentEvents.find(evt => evt.type === 'state_change' && evt.state === AgentState.REPAIR && evt.payload?.loopGuard);
    assert.ok(loopGuardEvent);
    assert.strictEqual(loopGuardEvent.payload.loopGuard.reason, 'repeated_identical_tool_calls');
    assert.match(
      stateMachine.activeConversation.map(msg => msg.content).join('\n'),
      /Loop Guard Triggered/
    );
  });

  test('should retry after tool validation failures instead of completing early', async () => {
    const sentEvents = [];
    const send = (evt) => sentEvents.push(evt);
    const messages = [{ role: 'user', content: 'Read a file' }];
    const config = { selfHealingMaxCycles: 2, workspaceRoot: path.resolve('.') };

    const stateMachine = new AgentStateMachine({ send, messages, config });
    stubCheckpointStore(stateMachine);

    let callCount = 0;
    stateMachine.callModel = async (_systemPrompt, _conversation, onChunk) => {
      callCount++;
      if (callCount === 1) {
        onChunk('Plan: read file\n{"tool":"read_file","params":{}}');
      } else {
        onChunk('Tool call corrected. No more actions needed.');
      }
    };
    stateMachine.contextEngine.scanWorkspace = async () => {};
    stateMachine.verificationEngine.runVerificationSuite = async () => {
      throw new Error('verification should not run for pure tool validation failure');
    };

    await stateMachine.run();

    assert.strictEqual(callCount, 2);
    const repairEvent = sentEvents.find(evt => evt.type === 'state_change' && evt.state === AgentState.REPAIR && evt.payload?.toolFailures);
    assert.ok(repairEvent);
    assert.strictEqual(repairEvent.payload.toolFailures[0].reason, 'validation_failed');
    assert.match(
      stateMachine.activeConversation.map(msg => msg.content).join('\n'),
      /Tool Call Failure Detected/
    );
  });

  test('should not stream internal tool-call planning text as the user answer', async () => {
    const sentEvents = [];
    const send = (evt) => sentEvents.push(evt);
    const messages = [{ role: 'user', content: 'List files and summarize' }];
    const config = { selfHealingMaxCycles: 1, workspaceRoot: path.resolve('.') };

    const stateMachine = new AgentStateMachine({ send, messages, config });
    stubCheckpointStore(stateMachine);

    stateMachine.callModel = async (_systemPrompt, _conversation, onChunk) => {
      onChunk('Plan: inspect files\n<list_dir path="." />');
    };
    stateMachine.contextEngine.scanWorkspace = async () => {};
    stateMachine.executor.execute = async () => ({ ok: true, result: { files: ['index.js'] } });
    stateMachine.diffTracker.getSessionDiff = async () => ({ changedFiles: [] });

    await stateMachine.run();

    const visibleText = sentEvents
      .filter(evt => evt.type === 'chunk')
      .map(evt => evt.text)
      .join('');

    assert.ok(visibleText.length > 0);
    assert.doesNotMatch(visibleText, /<list_dir/);
    assert.doesNotMatch(visibleText, /^Plan:/);
    assert.match(visibleText, /Work remains incomplete/);
  });

  test('tool result summarizers should accept params without runtime crashes', () => {
    const runCommand = ToolRegistry.getTool('run_command');
    const patchLines = ToolRegistry.getTool('patch_lines');

    assert.doesNotThrow(() => {
      const summary = runCommand.summarizeForUi({ code: 0, output: 'ok' }, { command: 'echo ok' });
      assert.strictEqual(summary.command, 'echo ok');
      assert.strictEqual(summary.code, 0);
    });

    assert.doesNotThrow(() => {
      const modelSummary = patchLines.summarizeForModel(
        { path: 'src/example.js' },
        { startLine: 2, endLine: 4 }
      );
      assert.match(modelSummary, /Lines 2-4/);
    });
  });

  test('should build tool prompt from ToolRegistry', () => {
    const stateMachine = new AgentStateMachine({
      send: () => {},
      messages: [{ role: 'user', content: 'test' }],
      config: { workspaceRoot: path.resolve('.') }
    });
    stubCheckpointStore(stateMachine);

    const prompt = stateMachine.buildToolPrompt();
    assert.match(prompt, /list_dir/);
    assert.match(prompt, /run_command/);
    assert.match(prompt, /required parameters/);

    const systemPrompt = stateMachine.buildSystemPrompt();
    assert.match(systemPrompt, /Workspace Summary/);
  });

  test('web and search UI summarizers should accept params without runtime crashes', () => {
    const cases = [
      ['project_search', [], { query: 'AgentStateMachine' }],
      ['web_search', { results: [] }, { query: 'llama.cpp' }],
      ['fetch_url', { http: { status: 200 } }, { url: 'https://example.com' }],
      ['inspect_url', { findings: [] }, { url: 'https://example.com' }],
      ['render_page', { title: 'Example' }, { url: 'https://example.com' }],
      ['crawl_site', { results: [] }, { url: 'https://example.com' }],
      ['monitor_target', { diffs: { changed: false } }, { url: 'https://example.com' }]
    ];

    for (const [toolName, result, params] of cases) {
      const tool = ToolRegistry.getTool(toolName);
      assert.doesNotThrow(() => tool.summarizeForUi(result, params), `${toolName} summarizeForUi should not throw`);
    }
  });

  test('ToolRegistry should validate and normalize tool parameters', () => {
    const patchLines = ToolRegistry.getTool('patch_lines');
    const okResult = ToolRegistry.validateParams(patchLines, {
      path: 'src/example.js',
      startLine: '2',
      endLine: '4',
      replacement: 'const ok = true;'
    });
    assert.strictEqual(okResult.ok, true);
    assert.strictEqual(okResult.params.startLine, 2);
    assert.strictEqual(okResult.params.endLine, 4);

    const deleteLineResult = ToolRegistry.validateParams(patchLines, {
      path: 'src/example.js',
      startLine: 4,
      endLine: 4,
      replacement: ''
    });
    assert.strictEqual(deleteLineResult.ok, true);
    assert.strictEqual(deleteLineResult.params.replacement, '');

    const invalidResult = ToolRegistry.validateParams(patchLines, {
      path: 'src/example.js',
      startLine: 5,
      endLine: 2,
      replacement: 'bad'
    });
    assert.strictEqual(invalidResult.ok, false);
    assert.ok(invalidResult.errors.some(error => error.includes('endLine')));

    const commandResult = ToolRegistry.validateParams(ToolRegistry.getTool('run_command'), {
      cmd: 'node --version'
    });
    assert.strictEqual(commandResult.ok, true);
    assert.strictEqual(commandResult.params.command, 'node --version');
  });

  test('VerificationEngine should run node scripts without npm and skip missing lint', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'blackhole-verification-'));
    try {
      fs.writeFileSync(
        path.join(tempDir, 'package.json'),
        JSON.stringify({ type: 'module', scripts: { test: 'node --version' } }, null, 2),
        'utf8'
      );

      const engine = new VerificationEngine(tempDir);
      const testResult = await engine.runVerification('test');
      assert.strictEqual(testResult.ok, true);
      assert.strictEqual(testResult.skipped, false);
      assert.match(testResult.command, /node/i);

      const lintResult = await engine.runVerification('lint');
      assert.strictEqual(lintResult.ok, true);
      assert.strictEqual(lintResult.skipped, true);

      const suite = await engine.runVerificationSuite();
      assert.strictEqual(suite.ok, true);
      assert.ok(suite.results.syntax);
      assert.ok(suite.results.test);
      assert.ok(suite.results.lint);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('ContextEngine should resolve impacted tests for targeted verification', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'blackhole-targeted-verification-'));
    try {
      fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
      fs.writeFileSync(
        path.join(tempDir, 'package.json'),
        JSON.stringify({ type: 'module' }, null, 2),
        'utf8'
      );
      fs.writeFileSync(
        path.join(tempDir, 'src', 'foo.js'),
        'export function foo() { return 42; }\n',
        'utf8'
      );
      fs.writeFileSync(
        path.join(tempDir, 'src', 'foo.test.js'),
        "import test from 'node:test';\nimport assert from 'node:assert';\nimport { foo } from './foo.js';\ntest('foo', () => assert.strictEqual(foo(), 42));\n",
        'utf8'
      );

      const contextEngine = new ProjectContextEngine(tempDir);
      await contextEngine.scanWorkspace();
      const targets = contextEngine.getVerificationTargets(['src/foo.js']);
      assert.deepStrictEqual(targets.testFiles, ['src/foo.test.js']);
      assert.ok(targets.impactedFiles.includes('src/foo.test.js'));

      const engine = new VerificationEngine(tempDir);
      const suite = await engine.runVerificationSuite({
        changedFiles: ['src/foo.js'],
        contextEngine
      });

      assert.strictEqual(suite.ok, true);
      assert.strictEqual(suite.results.test.targeted, true);
      assert.deepStrictEqual(suite.results.test.targets, ['src/foo.test.js']);
      assert.match(suite.results.test.command, /--test/);
      assert.ok(suite.targets.verificationPlan.syntaxFiles.includes('src/foo.js'));
      assert.strictEqual(suite.results.syntax.targeted, true);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('ContextEngine should index outline references and call graph', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'blackhole-code-intelligence-'));
    try {
      fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
      fs.writeFileSync(
        path.join(tempDir, 'src', 'math.js'),
        'export function add(a, b) { return a + b; }\n',
        'utf8'
      );
      fs.writeFileSync(
        path.join(tempDir, 'src', 'main.js'),
        "import { add } from './math.js';\nexport function run(value) { return add(value, 1); }\n",
        'utf8'
      );

      const contextEngine = new ProjectContextEngine(tempDir);
      await contextEngine.scanWorkspace();

      const summary = contextEngine.getWorkspaceSummary();
      assert.ok(summary.importEdgeCount >= 1);
      assert.ok(summary.referenceCount >= 1);
      assert.ok(summary.callEdgeCount >= 1);

      const references = contextEngine.getSymbolReferences('add');
      assert.ok(references.some(ref => ref.file === 'src/main.js'));

      const outline = contextEngine.getFileOutline('src/main.js');
      assert.ok(outline.some(item => item.name === 'run' && item.type === 'function'));

      const graph = contextEngine.getCallGraphFor('run');
      assert.ok(graph.outgoing.some(edge => edge.callee === 'add'));

      assert.strictEqual(summary.codeIntelligence.astBackendAvailable, true);
      assert.ok(summary.codeIntelligence.parsers['typescript-compiler-api'] >= 1);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('ContextEngine should expose AST parse diagnostics', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'blackhole-ast-diagnostics-'));
    try {
      fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
      fs.writeFileSync(
        path.join(tempDir, 'src', 'broken.js'),
        'export function broken( {\n',
        'utf8'
      );

      const contextEngine = new ProjectContextEngine(tempDir);
      await contextEngine.scanWorkspace();
      const diagnostics = contextEngine.getFileDiagnostics('src/broken.js');
      assert.ok(diagnostics.length > 0);
      assert.match(diagnostics[0].message, /expected|Declaration|','|'\)'/i);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('ContextEngine should expose semantic diagnostics and rename impact', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'blackhole-semantic-code-intelligence-'));
    try {
      fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
      fs.writeFileSync(
        path.join(tempDir, 'src', 'types.ts'),
        [
          'export interface User { name: string }',
          'export function label(user: User): string {',
          '  return user.name.toUpperCase();',
          '}',
          ''
        ].join('\n'),
        'utf8'
      );
      fs.writeFileSync(
        path.join(tempDir, 'src', 'main.ts'),
        "import { label } from './types';\nexport const display = label({ name: 'Ada' });\n",
        'utf8'
      );
      fs.writeFileSync(
        path.join(tempDir, 'src', 'broken.ts'),
        'const count: number = "oops";\n',
        'utf8'
      );

      const contextEngine = new ProjectContextEngine(tempDir);
      await contextEngine.scanWorkspace();

      const semanticDiagnostics = contextEngine.getSemanticDiagnostics('src/broken.ts');
      assert.ok(semanticDiagnostics.some(diagnostic => /string|number|assignable/i.test(diagnostic.message)));

      const impact = contextEngine.getRenameImpact('label');
      assert.strictEqual(impact.confidence, 'semantic');
      assert.ok(impact.affectedFiles.includes('src/types.ts'));
      assert.ok(impact.affectedFiles.includes('src/main.ts'));
      assert.ok(impact.references.some(reference => reference.backend === 'typescript-type-checker'));

      const summary = contextEngine.getCodeIntelligenceSummary();
      assert.strictEqual(summary.semanticBackendAvailable, true);
      assert.ok(summary.semanticReferenceCount >= 1);
      assert.ok(summary.semanticDiagnosticCount >= 1);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('TaskGraphPlanner should build and update a dependency-aware task graph', () => {
    const planner = new TaskGraphPlanner();
    const graph = planner.buildTaskGraph({
      goal: 'Fix a bug',
      planSteps: ['Inspect code', 'Implement fix', 'Run tests']
    });
    assert.strictEqual(graph.nodes.length, 3);
    assert.strictEqual(graph.nextNodeId, 'task-1');

    const updated = planner.updateTaskGraph(graph, {
      toolCalls: [{ tool: 'read_file', params: { path: 'src/a.js' } }]
    });
    assert.strictEqual(updated.nodes[0].status, 'in_progress');
    assert.match(planner.formatTaskGraphForPrompt(updated), /Task Graph/);
  });

  test('TaskGraphPlanner should resume incomplete checkpoint nodes as ready work', () => {
    const planner = new TaskGraphPlanner();
    const graph = {
      goal: 'resume work',
      nodes: [
        { id: 'task-1', title: 'Inspect files', type: 'analyze', status: 'completed', dependsOn: [], evidence: [] },
        { id: 'task-2', title: 'Patch files', type: 'implement', status: 'in_progress', dependsOn: ['task-1'], evidence: [] },
        { id: 'task-3', title: 'Verify', type: 'verify', status: 'pending', dependsOn: ['task-2'], evidence: [] }
      ],
      edges: [{ from: 'task-1', to: 'task-2' }, { from: 'task-2', to: 'task-3' }]
    };

    const resumed = planner.resumeTaskGraph(graph);
    assert.strictEqual(resumed.nextNodeId, 'task-2');
    assert.strictEqual(resumed.nodes[1].status, 'ready');

    const lists = planner.deriveStepLists(resumed);
    assert.deepStrictEqual(lists.completedSteps, ['Inspect files']);
    assert.deepStrictEqual(lists.pendingSteps, ['Patch files', 'Verify']);
  });

  test('RepairPlanner should classify failures and format repair prompts', () => {
    const planner = new RepairPlanner();
    const failures = [{
      type: 'test',
      analysis: {
        errorMessages: ['ReferenceError: add is not defined'],
        suspectedFiles: [{ file: 'src/main.js', line: 3 }],
        rawLogSnippet: 'ReferenceError: add is not defined\n    at src/main.js:3:10'
      }
    }];

    const plan = planner.buildRepairPlan(failures, {
      changedFiles: ['src/main.js']
    });

    assert.ok(plan.categories.some(category => category.id === 'runtime-reference'));
    assert.ok(plan.recommendedFiles.some(file => file.file === 'src/main.js'));

    const prompt = planner.formatRepairPrompt(plan);
    assert.match(prompt, /Repair Planner/);
    assert.match(prompt, /read_file/);
    assert.match(prompt, /src\/main\.js/);
  });

  test('inspect_code_context should expose structured code intelligence through executor', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'blackhole-inspect-code-tool-'));
    try {
      fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
      fs.writeFileSync(
        path.join(tempDir, 'src', 'math.js'),
        'export function add(a, b) { return a + b; }\n',
        'utf8'
      );
      fs.writeFileSync(
        path.join(tempDir, 'src', 'main.js'),
        "import { add } from './math.js';\nexport function run(value) { return add(value, 1); }\n",
        'utf8'
      );

      const contextEngine = new ProjectContextEngine(tempDir);
      await contextEngine.scanWorkspace();
      const executor = new CapabilityExecutor({
        getConfig: () => ({ permissionMode: 'autonomous', workspaceRoot: tempDir })
      });

      const outline = await executor.execute('inspect_code_context', {
        mode: 'outline',
        path: 'src/main.js'
      }, {
        actor: 'ai',
        contextEngine
      });
      assert.strictEqual(outline.ok, true);
      assert.ok(outline.result.outline.some(item => item.name === 'run'));

      const graph = await executor.execute('inspect_code_context', {
        mode: 'call_graph',
        query: 'run'
      }, {
        actor: 'ai',
        contextEngine
      });
      assert.strictEqual(graph.ok, true);
      assert.ok(graph.result.graph.outgoing.some(edge => edge.callee === 'add'));

      const aliasedReferences = await executor.execute('inspect_code_context', {
        mode: 'symbol_references',
        query: 'add',
        direction: 'forward'
      }, {
        actor: 'ai',
        contextEngine
      });
      assert.strictEqual(aliasedReferences.ok, true);
      assert.strictEqual(aliasedReferences.result.mode, 'references');
      assert.ok(aliasedReferences.result.references.length >= 1);

      const hyphenatedGraph = await executor.execute('inspect_code_context', {
        mode: 'call-graph',
        path: 'src/main.js'
      }, {
        actor: 'ai',
        contextEngine
      });
      assert.strictEqual(hyphenatedGraph.ok, true);
      assert.strictEqual(hyphenatedGraph.result.mode, 'call_graph');

      const hyphenatedSemantic = await executor.execute('inspect_code_context', {
        mode: 'semantic-diagnostics',
        path: 'src/main.js'
      }, {
        actor: 'ai',
        contextEngine
      });
      assert.strictEqual(hyphenatedSemantic.ok, true);
      assert.strictEqual(hyphenatedSemantic.result.mode, 'semantic_diagnostics');

      const renameImpact = await executor.execute('inspect_code_context', {
        mode: 'rename_impact',
        query: 'add'
      }, {
        actor: 'ai',
        contextEngine
      });
      assert.strictEqual(renameImpact.ok, true);
      assert.ok(renameImpact.result.impact.references.length >= 1);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('patch transaction tools should preview and apply multi-file changes', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'blackhole-patch-transaction-'));
    try {
      fs.writeFileSync(path.join(tempDir, 'a.js'), 'const value = 1;\n', 'utf8');
      const executor = new CapabilityExecutor({
        getConfig: () => ({ permissionMode: 'autonomous', workspaceRoot: tempDir })
      });
      const operations = [
        { type: 'patch_file', path: 'a.js', search: '1', replace: '2' },
        { type: 'write_file', path: 'b.js', content: 'export const created = true;\n' }
      ];

      const review = await executor.execute('review_patch_transaction', { operations }, { actor: 'ai' });
      assert.strictEqual(review.ok, true);
      assert.strictEqual(review.result.ok, true);
      assert.match(review.result.previews[0].diff, /-const value = 1/);
      assert.strictEqual(fs.readFileSync(path.join(tempDir, 'a.js'), 'utf8'), 'const value = 1;\n');

      const applied = await executor.execute('apply_patch_transaction', { operations }, { actor: 'ai' });
      assert.strictEqual(applied.ok, true);
      assert.strictEqual(applied.result.ok, true);
      assert.strictEqual(fs.readFileSync(path.join(tempDir, 'a.js'), 'utf8'), 'const value = 2;\n');
      assert.ok(fs.existsSync(path.join(tempDir, 'b.js')));
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('AgentMemoryStore should record and search durable project memory', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'blackhole-memory-'));
    try {
      const store = new AgentMemoryStore({
        workspaceRoot: tempDir,
        memoryPath: path.join(tempDir, 'data', 'agent-memory.json'),
        retentionLimit: 3
      });
      store.append({
        type: 'decision',
        summary: 'Use patch transactions before applying broad multi-file edits.',
        tags: ['patch', 'transaction'],
        source: 'test'
      });
      store.recordRun({
        goal: 'Fix broken tests',
        changedFiles: ['src/a.js'],
        verification: 'targeted tests passed',
        status: 'completed'
      });

      const hits = store.search('patch transaction', { limit: 5 });
      assert.strictEqual(hits.length >= 1, true);
      assert.match(store.buildPromptSection('broken tests'), /Project Memory/);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('project memory tools should work through the capability executor', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'blackhole-memory-tool-'));
    try {
      const memoryStore = new AgentMemoryStore({
        workspaceRoot: tempDir,
        memoryPath: path.join(tempDir, 'memory.json')
      });
      const executor = new CapabilityExecutor({
        getConfig: () => ({ permissionMode: 'autonomous', workspaceRoot: tempDir })
      });

      const recorded = await executor.execute('record_project_memory', {
        summary: 'Record code intelligence findings before broad edits.',
        type: 'handoff',
        tags: ['code-intelligence', 'handoff']
      }, {
        actor: 'ai',
        memoryStore
      });
      assert.strictEqual(recorded.ok, true);
      assert.strictEqual(recorded.result.recorded, true);

      const searched = await executor.execute('search_project_memory', {
        query: 'code intelligence'
      }, {
        actor: 'ai',
        memoryStore
      });
      assert.strictEqual(searched.ok, true);
      assert.ok(searched.result.results.length >= 1);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('resolveModelRoute should select phase-specific model profiles', () => {
    const route = resolveModelRoute({
      activeModel: 'llamacpp:base',
      localRuntime: 'llamacpp',
      contextLimit: 8192,
      maxTokens: 4096,
      temperature: 0.2,
      agentModelRoutingEnabled: true,
      agentModelProfiles: {
        coder: {
          model: 'llamacpp:coder',
          maxTokens: 3072,
          temperature: 0.11
        },
        verifier: {
          maxTokens: 1024,
          temperature: 0.03
        }
      }
    }, {
      phase: 'repair',
      task: 'repair failing test'
    });

    assert.strictEqual(route.profile, 'coder');
    assert.strictEqual(route.model, 'llamacpp:coder');
    assert.strictEqual(route.maxTokens, 3072);
    assert.strictEqual(route.temperature, 0.11);

    const disabled = resolveModelRoute({
      activeModel: 'llamacpp:base',
      agentModelRoutingEnabled: false
    }, {
      phase: 'verify'
    });
    assert.strictEqual(disabled.profile, 'general');
    assert.strictEqual(disabled.reason, 'model routing disabled');
  });

  test('AgentCheckpointStore should save latest checkpoint and enforce retention', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'blackhole-checkpoint-'));
    try {
      const store = new AgentCheckpointStore({ dir: tempDir, retentionLimit: 2 });
      store.save({ sessionId: 'one', state: AgentState.PLAN, userGoal: 'first' });
      store.save({ sessionId: 'two', state: AgentState.ACT, userGoal: 'second' });
      store.save({ sessionId: 'three', state: AgentState.SUMMARIZE, userGoal: 'third' });

      const latest = store.loadLatest();
      assert.strictEqual(latest.sessionId, 'three');
      const entries = store.list();
      assert.strictEqual(entries.length, 2);
      assert.strictEqual(entries[0].sessionId, 'three');
      assert.strictEqual(entries[0].state, AgentState.SUMMARIZE);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('AgentCheckpointStore should load a specific checkpoint and build resume prompt', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'blackhole-checkpoint-resume-'));
    try {
      const store = new AgentCheckpointStore({ dir: tempDir, retentionLimit: 4 });
      store.save({
        sessionId: 'agent-resume-test',
        state: AgentState.REPAIR,
        userGoal: 'finish the agent core',
        workspaceRoot: tempDir,
        cycleCount: 2,
        pendingSteps: ['Run targeted verification'],
        completedSteps: ['Patch files'],
        changedFiles: ['src/core.js'],
        failedVerifications: [{ type: 'test', analysis: { errorMessages: ['boom'] } }],
        taskGraph: {
          summary: '2 tasks, 1 pending',
          nextNodeId: 'task-2',
          nodes: [
            { id: 'task-1', title: 'Patch files', status: 'completed' },
            { id: 'task-2', title: 'Run targeted verification', status: 'in_progress' }
          ]
        },
        nextRecommendedAction: 'Run verification'
      });

      const loaded = store.load('agent-resume-test');
      assert.strictEqual(loaded.userGoal, 'finish the agent core');

      const prompt = buildCheckpointResumePrompt(loaded);
      assert.match(prompt, /Checkpoint Resume Request/);
      assert.match(prompt, /Run targeted verification/);
      assert.match(prompt, /src\/core\.js/);
      assert.match(prompt, /Run verification/);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('AgentStateMachine should hydrate resumable task graph from checkpoint', async () => {
    const sentEvents = [];
    const send = (evt) => sentEvents.push(evt);
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'blackhole-resume-machine-'));
    try {
      fs.writeFileSync(path.join(tempDir, 'package.json'), JSON.stringify({ type: 'module' }), 'utf8');
      const resumeCheckpoint = {
        sessionId: 'agent-resume-hydrate',
        state: AgentState.REPAIR,
        userGoal: 'finish resumed task',
        workspaceRoot: tempDir,
        cycleCount: 4,
        planSteps: ['Inspect files', 'Patch files', 'Verify'],
        taskGraph: {
          goal: 'finish resumed task',
          nodes: [
            { id: 'task-1', title: 'Inspect files', type: 'analyze', status: 'completed', dependsOn: [], evidence: [] },
            { id: 'task-2', title: 'Patch files', type: 'implement', status: 'blocked', dependsOn: ['task-1'], evidence: [] }
          ],
          edges: [{ from: 'task-1', to: 'task-2' }]
        },
        nextRecommendedAction: 'Patch files'
      };

      const stateMachine = new AgentStateMachine({
        send,
        messages: [],
        config: { selfHealingMaxCycles: 1, workspaceRoot: tempDir, systemInstruction: 'System' },
        resumeCheckpoint
      });
      stubCheckpointStore(stateMachine);
      stateMachine.contextEngine.scanWorkspace = async () => {};
      stateMachine.callModel = async (systemPrompt, conversation, onChunk) => {
        assert.match(systemPrompt, /Resume Checkpoint/);
        assert.match(systemPrompt, /Patch files/);
        assert.ok(conversation.some(message => String(message.content).includes('Checkpoint Resume Context')));
        onChunk('Resumed and ready.');
      };

      assert.strictEqual(stateMachine.cycleCount, 0);
      assert.strictEqual(stateMachine.checkpoint.resumedFrom.cycleCount, 4);
      assert.strictEqual(stateMachine.checkpoint.taskGraph.nextNodeId, 'task-2');
      assert.strictEqual(stateMachine.checkpoint.taskGraph.nodes[1].status, 'ready');

      await stateMachine.run();
      assert.ok(sentEvents.some(event => event.type === 'end'));
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe('checkpoint persistence and process resume', () => {
  function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bh-checkpoint-durable-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    return { root, store: new AgentCheckpointStore({ dir: path.join(root, 'sessions') }) };
  }

  test('a partial temporary write cannot truncate either existing checkpoint', t => {
    const { root, store } = fixture(t);
    store.save({ sessionId: 'stable', state: AgentState.PLAN, userGoal: 'Original' });
    const write = fs.writeFileSync;
    const mocked = t.mock.method(fs, 'writeFileSync', (file, text, options) => {
      if (String(file).endsWith('.tmp')) {
        assert.equal(options.flush, true);
        write(file, '{"partial":', options);
        throw Object.assign(new Error('Fixture disk full'), { code: 'ENOSPC' });
      }
      return write(file, text, options);
    });
    assert.throws(() => store.save({ sessionId: 'stable', state: AgentState.ACT, userGoal: 'Replacement' }), /disk full/);
    mocked.mock.restore();
    assert.equal(new AgentCheckpointStore({ dir: store.dir }).load('stable').userGoal, 'Original');
    assert.equal(store.loadLatest().userGoal, 'Original');
    assert.deepEqual(fs.readdirSync(path.join(root, 'sessions')).sort(), ['latest.json', 'stable.json']);
  });

  test('a failed latest publication is recovered from the completed named snapshot after restart', t => {
    const { store } = fixture(t);
    store.save({ sessionId: 'older', state: AgentState.PLAN, userGoal: 'Original' });
    const old = { ...store.load('older'), savedAt: '2000-01-01T00:00:00.000Z' };
    for (const file of ['older.json', 'latest.json']) fs.writeFileSync(path.join(store.dir, file), JSON.stringify(old));
    const rename = fs.renameSync;
    const mocked = t.mock.method(fs, 'renameSync', (from, to) => {
      if (path.basename(to) === 'latest.json') throw Object.assign(new Error('Fixture latest is locked'), { code: 'EPERM' });
      return rename(from, to);
    });
    assert.throws(() => store.save({ sessionId: 'newer', state: AgentState.REPAIR, userGoal: 'Durable replacement' }), /locked/);
    mocked.mock.restore();
    assert.equal(JSON.parse(fs.readFileSync(path.join(store.dir, 'latest.json'))).userGoal, 'Original');
    const restarted = new AgentCheckpointStore({ dir: store.dir });
    assert.equal(restarted.loadLatest().userGoal, 'Durable replacement');
    assert.equal(restarted.load('newer.json').sessionId, 'newer');
    assert.equal(fs.readdirSync(store.dir).some(file => file.endsWith('.tmp')), false);
  });

  test('missing or corrupt latest files fall back to valid records, never orphan temporary or mismatched records', t => {
    const { store } = fixture(t);
    store.save({ sessionId: 'valid', state: AgentState.PLAN, userGoal: 'Keep this' });
    fs.writeFileSync(path.join(store.dir, '.orphan.json.123.tmp'), JSON.stringify({ sessionId: 'orphan', state: 'PLAN', userGoal: 'Do not use' }));
    fs.writeFileSync(path.join(store.dir, 'mismatch.json'), JSON.stringify({ sessionId: 'other', state: 'PLAN', userGoal: 'Do not use' }));
    for (const text of ['{', '[]', 'null', '{"sessionId":"broken"}']) {
      fs.writeFileSync(path.join(store.dir, 'latest.json'), text);
      assert.equal(store.loadLatest().sessionId, 'valid');
    }
    fs.rmSync(path.join(store.dir, 'latest.json'));
    assert.equal(store.loadLatest().sessionId, 'valid');
    assert.deepEqual(store.list().map(entry => entry.sessionId), ['valid']);
    assert.equal(store.load('mismatch'), null);
  });

  test('save IDs stay inside the store, cannot overwrite latest, and generated IDs do not collide', t => {
    const { root, store } = fixture(t);
    for (const sessionId of ['../escape', '..', '.', 'latest', 'latest.json', 'LATEST']) {
      assert.throws(() => store.save({ sessionId, state: 'PLAN', userGoal: 'Invalid' }), /Invalid checkpoint/);
    }
    assert.equal(fs.existsSync(path.join(root, 'escape.json')), false);
    const first = store.save({ state: 'PLAN', userGoal: 'First' });
    const second = store.save({ state: 'PLAN', userGoal: 'Second' });
    assert.notEqual(first.sessionId, second.sessionId);
    assert.equal(store.list().length, 2);
  });

  function resumedFixture(t, verificationOk = true) {
    const { root, store } = fixture(t);
    const original = path.join(root, 'original');
    const other = path.join(root, 'other');
    fs.mkdirSync(original);
    fs.mkdirSync(other);
    fs.writeFileSync(path.join(original, 'calc.cjs'), 'exports.add = (a,b) => a+b;\n');
    fs.writeFileSync(path.join(other, 'calc.cjs'), 'Do not touch the current workspace.');
    const config = { workspaceRoot: other, agentMemoryEnabled: false, selfHealingMaxCycles: 1, permissionMode: 'operator' };
    const events = [];
    const machine = new AgentStateMachine({ config, messages: [], send: event => events.push(event), resumeCheckpoint: {
      sessionId: 'resumed', providerSessionId: 'same-provider-session', state: AgentState.STOPPED,
      userGoal: 'Fix calc.cjs addition.', workspaceRoot: original, changedFiles: ['calc.cjs']
    } });
    machine.checkpointStore = store;
    machine.contextEngine.scanWorkspace = async () => {};
    const verification = t.mock.method(machine.verificationEngine, 'runVerificationSuite', async options => {
      assert.deepEqual(options.changedFiles, ['calc.cjs']);
      return { ok: verificationOk, targets: {}, results: {
        syntax: { ok: true }, test: { ok: verificationOk, analysis: verificationOk ? null : { errorMessages: ['Fixture test failed'] } },
        lint: { ok: true, skipped: true }
      } };
    });
    machine.callModel = async (_prompt, messages, onChunk) => {
      if (!verificationOk) assert.match(JSON.stringify(messages), /Fixture test failed/);
      onChunk('The previous file edit is complete.');
    };
    return { root, store, machine, config, events, original, other, verification };
  }

  test('resuming binds the executor to its original workspace and preserves earlier changes without rewriting them', async t => {
    const { store, machine, config, original, other, verification } = resumedFixture(t);
    assert.equal(config.workspaceRoot, other, 'Resume must not overwrite the caller or saved configuration.');
    assert.equal(machine.config.workspaceRoot, original);
    assert.equal(machine.checkpoint.providerSessionId, 'same-provider-session');
    const read = await machine.executor.execute('read_file', { path: 'calc.cjs' });
    assert.equal(read.ok, true);
    assert.match(JSON.stringify(read), /a\+b/);
    await machine.run();
    assert.equal(machine.runOutcome.status, 'completed');
    assert.equal(verification.mock.callCount(), 1);
    assert.deepEqual(store.loadLatest().changedFiles, ['calc.cjs']);
    assert.equal(fs.readFileSync(path.join(other, 'calc.cjs'), 'utf8'), 'Do not touch the current workspace.');
  });

  test('a failing recheck cannot be reported complete merely because the model says done', async t => {
    const { machine, store } = resumedFixture(t, false);
    await machine.run();
    assert.equal(machine.runOutcome.status, 'incomplete');
    assert.equal(machine.runOutcome.reason, 'verification_failed');
    assert.equal(store.loadLatest().failedVerifications[0].type, 'test');
  });

  test('checkpoint persistence failures are visible and never claim a recovery checkpoint exists', async t => {
    const { machine, events } = resumedFixture(t);
    machine.checkpointStore = { save() { throw new Error('Fixture disk full'); } };
    machine.callModel = async () => { throw new Error('Fixture provider stopped'); };
    await machine.run();
    assert.ok(events.some(event => event.checkpointSaveFailed));
    assert.equal(events.some(event => String(event.status).includes('Recovery checkpoint is available')), false);
    assert.equal(events.find(event => event.type === 'error').checkpoint, null);
    assert.equal(events.find(event => event.type === 'recovery').checkpointAvailable, false);
    assert.equal(machine.runOutcome.status, 'failed');
  });

  test('manual diffs distinguish restored changes from a new file or edits made after resume', async t => {
    const { root } = fixture(t);
    const file = path.join(root, 'existing.txt');
    fs.writeFileSync(file, 'State at resume');
    const tracker = new DiffTracker(root);
    tracker.restoreChangedFiles(['existing.txt']);
    const restored = await tracker.getSessionDiff();
    assert.match(restored.patches['existing.txt'], /original diff baseline is unavailable/);
    assert.doesNotMatch(restored.patches['existing.txt'], /dev\/null/);
    tracker.backupFile('existing.txt');
    fs.writeFileSync(file, 'New edit');
    const updated = await tracker.getSessionDiff();
    assert.match(updated.patches['existing.txt'], /Changes since checkpoint resume/);
    assert.match(updated.patches['existing.txt'], /-State at resume/);
    assert.match(updated.patches['existing.txt'], /\+New edit/);
  });

  test('an output limit preserves structured recovery and does not enter source repair or silently raise the budget', async t => {
    const { machine, events, store, config } = resumedFixture(t);
    const modelFailure = { provider: 'opencode-go', model: 'muse-spark-1.3-contributor', code: 'output_token_limit', outputTokenLimit: 4096 };
    const before = structuredClone(config);
    machine.callModel = async () => {
      machine.lastModelRoute = { model: 'opencode-go:muse-spark-1.3-contributor', profile: 'planner', maxTokens: 4096 };
      throw Object.assign(new Error('Fixture output token limit'), { modelFailure });
    };
    await machine.run();
    assert.equal(machine.runOutcome.reason, 'output_token_limit');
    assert.equal(machine.repairCycleCount, 0);
    assert.equal(events.some(event => event.state === AgentState.REPAIR), false);
    for (const type of ['recovery', 'error']) {
      const event = events.find(event => event.type === type);
      assert.deepEqual(event.modelFailure, modelFailure);
      assert.equal(event.modelRoute.profile, 'planner');
      assert.equal(event.modelRoute.maxTokens, 4096);
      assert.equal(event.checkpoint.sessionId, 'resumed');
    }
    assert.deepEqual(store.loadLatest().outcome.modelFailure, modelFailure);
    assert.match(store.loadLatest().nextRecommendedAction, /Adjust the output limit/);
    assert.deepEqual(config, before);
  });

  test('long conversations compact against the active phase context rather than the larger shared setting', async t => {
    const { machine } = resumedFixture(t);
    machine.config.contextLimit = 122880;
    machine.config.agentModelProfiles = { planner: { contextLimit: 8192 }, summarizer: { contextLimit: 8192 } };
    machine.checkpoint.userGoal = 'Keep the original task';
    let summaries = 0;
    machine.callModel = async (_system, _messages, onChunk) => { summaries++; onChunk('Original task and relevant changes retained.'); };
    const messages = [{ role: 'user', content: machine.checkpoint.userGoal },
      ...Array.from({ length: 24 }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user', content: 'History '.repeat(240) })),
      { role: 'user', content: 'Inspect current state' }];
    const result = await machine.maybeCompactContext('System', messages);
    assert.equal(result.compacted, true);
    assert.equal(summaries, 1);
    assert.equal(result.messages[0].content, machine.checkpoint.userGoal);
    assert.equal(result.messages.at(-1).content, 'Inspect current state');
    assert.equal(machine.config.contextLimit, 122880);
    assert.equal(machine.config.agentModelProfiles.planner.contextLimit, 8192);
  });
});
