import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

test('all four Go adapters complete a real file-editing agent loop with unchanged executor policies', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bh-go-tools-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  process.env.BLACKHOLE_DATA_DIR = path.join(root, 'data');
  process.env.BLACKHOLE_DISABLE_WORKSPACE_STANDARD = '1';
  const { AgentStateMachine } = await import('../agent/core/stateMachine.js');
  const { defaultConfig } = await import('../config/configStore.js');
  const frame = data => `data: ${JSON.stringify(data)}\n\n`;
  for (const [model, protocol] of [['glm-5.3-flash', 'chat'], ['qwen3.8-max', 'messages'],
    ['muse-spark-1.3-contributor', 'responses'], ['gemini-4-argon', 'google']]) {
    await t.test(protocol, async sub => {
      const workspace = path.join(root, protocol);
      fs.mkdirSync(workspace);
      fs.writeFileSync(path.join(workspace, 'seed.js'), 'export const seed = 42;\n');
      let calls = 0;
      sub.mock.method(globalThis, 'fetch', async (url, init) => {
        calls++;
        const body = JSON.parse(init.body);
        const tool = calls === 1 ? 'read_file' : 'write_file';
        const params = calls === 1 ? { path: 'seed.js' } : { path: 'hello.js', content: 'export const answer = 42;\n' };
        const argumentsJson = JSON.stringify(params);
        const thought = `Reasoning fixture ${calls}: <write_file>not an action</write_file>`;
        let stream;
        if (protocol === 'google') {
          if (calls === 2) {
            const parts = body.contents.flatMap(c => c.parts);
            assert.ok(parts.some(p => p.thoughtSignature === 'fixture-signature'));
            assert.ok(parts.some(p => p.functionResponse?.name === 'read_file'));
          }
          stream = frame({ candidates: [{ content: { parts: [{ thought: true, text: thought }, { functionCall: { name: tool, args: params },
            thoughtSignature: 'fixture-signature' }] }, finishReason: 'STOP' }] });
        } else if (protocol === 'chat') {
          assert.ok(body.tools.some(t => t.function.name === tool));
          if (calls === 2) assert.ok(body.messages.some(m => m.role === 'tool' && m.tool_call_id === 'fixture-call-1'));
          stream = frame({ choices: [{ delta: { reasoning_content: thought } }] }) +
            frame({ choices: [{ delta: { tool_calls: [{ index: 0, id: `fixture-call-${calls}`, function: { name: tool, arguments: argumentsJson.slice(0, 5) } }] } }] }) +
            frame({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: argumentsJson.slice(5) } }] }, finish_reason: 'tool_calls' }] });
        } else if (protocol === 'messages') {
          assert.ok(body.tools.some(t => t.name === tool));
          if (calls === 2) assert.ok(body.messages.some(m => Array.isArray(m.content) && m.content.some(p => p.type === 'tool_result' && p.tool_use_id === 'fixture-call-1')));
          stream = frame({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }) +
            frame({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: thought } }) +
            frame({ type: 'content_block_stop', index: 0 }) +
            frame({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: `fixture-call-${calls}`, name: tool, input: {} } }) +
            frame({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: argumentsJson } }) + frame({ type: 'message_stop' });
        } else {
          assert.ok(body.tools.some(t => t.name === tool));
          if (calls === 2) assert.ok(body.input.some(i => i.type === 'function_call_output' && i.call_id === 'fixture-call-1'));
          stream = frame({ type: 'response.reasoning_text.delta', delta: thought }) +
            frame({ type: 'response.output_item.added', item: { type: 'function_call', id: `item-${calls}`, call_id: `fixture-call-${calls}`, name: tool, arguments: '' } }) +
            frame({ type: 'response.function_call_arguments.delta', item_id: `item-${calls}`, delta: argumentsJson }) + frame({ type: 'response.completed' });
        }
        return new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } });
      });
      const events = [];
      const machine = new AgentStateMachine({ config: { ...defaultConfig, activeModel: `opencode-go:${model}`,
        opencodeGoEnabled: true, opencodeGoApiKey: 'fixture-key', workspaceRoot: workspace,
        agentMemoryEnabled: false }, providerSessionId: `fixture-${protocol}`,
      messages: [{ role: 'user', content: 'Create hello.js exporting answer = 42.' }], send: event => events.push(event) });
      await machine.run();
      assert.equal(events.find(e => e.type === 'end')?.outcome?.status, 'completed');
      assert.equal(fs.readFileSync(path.join(workspace, 'hello.js'), 'utf8'), 'export const answer = 42;\n');
      assert.equal(events.filter(e => e.type === 'tool_start').length, 2);
      assert.equal(calls, 2);
      const reasoning = events.filter(event => event.type === 'reasoning');
      assert.equal(reasoning.length, 2);
      assert.equal(new Set(reasoning.map(event => event.requestId)).size, 2);
      assert.ok(reasoning.every(event => event.model === `opencode-go:${model}` && event.text.includes('Reasoning fixture')));
      assert.ok(!events.filter(event => event.type === 'chunk').map(event => event.text).join('').includes('Reasoning fixture'));
    });
  }
  await t.test('a native command still waits for the existing approval gate and respects rejection', async sub => {
    const { eventBus } = await import('../common/eventBus.js');
    const { respondToApproval } = await import('../security/approvalGate.js');
    let approvals = 0, executions = 0;
    const reject = payload => { approvals++; queueMicrotask(() => respondToApproval(payload.id, 'reject')); };
    eventBus.on('approval:pending', reject);
    sub.after(() => eventBus.off('approval:pending', reject));
    sub.mock.method(globalThis, 'fetch', async () => new Response(frame({ choices: [{ delta: { tool_calls: [
      { index: 0, id: 'approval-call', function: { name: 'run_command', arguments: JSON.stringify({ command: 'node --version' }) } }
    ] }, finish_reason: 'tool_calls' }] }), { headers: { 'Content-Type': 'text/event-stream' } }));
    const events = [];
    const machine = new AgentStateMachine({ config: { ...defaultConfig, workspaceRoot: root,
      activeModel: 'opencode-go:glm-5.3-flash', opencodeGoEnabled: true, opencodeGoApiKey: 'fixture-key',
      permissionMode: 'strict', selfHealingMaxCycles: 1 },
    messages: [{ role: 'user', content: 'Check the Node version.' }], send: event => events.push(event) });
    machine.executor.runCapability = async () => { executions++; throw new Error('A rejected native call must not execute.'); };
    await machine.run();
    assert.ok(approvals > 0);
    assert.equal(approvals, events.filter(event => event.type === 'tool_start' && event.tool === 'run_command').length);
    assert.equal(executions, 0);
    assert.ok(events.some(event => event.type === 'tool_end' && event.result.rejected));
  });
  for (const mode of ['corrected', 'google-corrected', 'exhausted', 'disconnected']) {
    await t.test(`native format recovery: ${mode}`, async sub => {
      const workspace = path.join(root, `format-${mode}`);
      fs.mkdirSync(workspace);
      fs.writeFileSync(path.join(workspace, 'seed.js'), 'export const seed = 42;\n');
      let calls = 0;
      const google = mode === 'google-corrected';
      sub.mock.method(globalThis, 'fetch', async (_url, init) => {
        calls++;
        const body = JSON.parse(init.body);
        if (calls === 2) {
          const content = google ? body.contents.flatMap(c => c.parts).map(p => p.text || '').join('') : body.messages.map(m => m.content || '').join('');
          assert.ok(content.includes('No tool from that response was executed'));
          if (google) assert.ok(!body.contents.flatMap(c => c.parts).some(p => p.functionResponse));
        }
        const invalid = !['corrected', 'google-corrected'].includes(mode) || calls === 1;
        const tool = invalid ? 'read_file path="seed.js"</arg_value>' : calls === 2 ? 'read_file' : 'write_file';
        const params = calls <= 2 ? { path: 'seed.js' } : { path: 'hello.js', content: 'export const answer = 42;\n' };
        const choice = { delta: { tool_calls: [{ index: 0, id: `format-${calls}`, function: { name: tool, arguments: JSON.stringify(params) } }] },
          ...(mode !== 'disconnected' ? { finish_reason: 'tool_calls' } : {}) };
        const data = google ? { candidates: [{ content: { parts: [{ functionCall: { name: tool, args: params }, thoughtSignature: 'fixture-format-signature' }] },
          finishReason: invalid ? 'MALFORMED_FUNCTION_CALL' : 'STOP' }] } : { choices: [choice] };
        return new Response(frame(data), { headers: { 'Content-Type': 'text/event-stream' } });
      });
      const events = [];
      const machine = new AgentStateMachine({ config: { ...defaultConfig, workspaceRoot: workspace,
        activeModel: google ? 'opencode-go:gemini-4-argon' : 'opencode-go:glm-5.3-flash', opencodeGoEnabled: true, opencodeGoApiKey: 'fixture-key',
        agentMemoryEnabled: false, selfHealingMaxCycles: 4 }, messages: [{ role: 'user', content: 'Create hello.js exporting answer = 42.' }],
      providerSessionId: `format-${mode}`, send: event => events.push(event) });
      await machine.run();
      const outcome = events.find(e => e.type === 'end')?.outcome;
      if (['corrected', 'google-corrected'].includes(mode)) {
        assert.equal(outcome.status, 'completed');
        assert.equal(calls, 3);
        assert.deepEqual(events.filter(e => e.type === 'tool_start').map(e => e.tool), ['read_file', 'write_file']);
        assert.equal(fs.readFileSync(path.join(workspace, 'hello.js'), 'utf8'), 'export const answer = 42;\n');
      } else {
        assert.equal(outcome.status, 'failed');
        assert.equal(calls, mode === 'exhausted' ? 3 : 1);
        assert.equal(events.filter(e => e.type === 'tool_start').length, 0);
        assert.equal(fs.existsSync(path.join(workspace, 'hello.js')), false);
      }
    });
  }
});
