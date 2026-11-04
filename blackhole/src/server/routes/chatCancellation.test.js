import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import express from 'express';
import { setTimeout as delay } from 'node:timers/promises';
import { createParser } from 'eventsource-parser';

test('disconnecting a Go chat stops web tools, MCP calls and pending approvals across all four adapters', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bh-chat-cancel-'));
  process.env.BLACKHOLE_DATA_DIR = path.join(root, 'data');
  process.env.BLACKHOLE_DISABLE_WORKSPACE_STANDARD = '1';
  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(workspace);
  const { saveConfig, defaultConfig } = await import('../../config/configStore.js');
  const { createChatRouter } = await import('./chat.js');
  const { createMcpRouter } = await import('./mcp.js');
  const { listPendingApprovals, respondToApproval } = await import('../../security/approvalGate.js');
  const { AgentCheckpointStore } = await import('../../agent/core/checkpointStore.js');
  const { mcpClientManager } = await import('../../mcp/mcpClient.js');
  const { ToolRegistry } = await import('../../agent/core/toolRegistry.js');
  const { setWorkspaceRoot } = await import('../../workspace/workspaceManager.js');
  setWorkspaceRoot(workspace);
  const store = new AgentCheckpointStore();
  const app = express();
  app.use(express.json());
  app.use(createChatRouter());
  app.use(createMcpRouter());
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const web = http.createServer((_req, res) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.write('<html>'); });
  await new Promise(resolve => web.listen(0, '127.0.0.1', resolve));
  const webUrl = `http://127.0.0.1:${web.address().port}`;
  t.after(async () => {
    for (const pending of listPendingApprovals()) respondToApproval(pending.id, 'reject');
    await mcpClientManager.closeAll();
    delete ToolRegistry.tools.mcp__cancelfixture__wait;
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    await new Promise(resolve => { web.close(resolve); web.closeAllConnections(); });
    fs.rmSync(root, { recursive: true, force: true });
  });
  const frame = value => `data: ${JSON.stringify(value)}\n\n`;
  const waitFor = async condition => {
    for (let i = 0; i < 200; i++) { if (condition()) return; await delay(10); }
    assert.fail('The disconnected run did not settle within two seconds.');
  };
  const realFetch = globalThis.fetch;
  const mcp = { enabled: true, permissions: { '*': 'allow' }, servers: { cancelfixture: {
    enabled: true, command: process.execPath, args: ['-e', `
      const readline = require('node:readline');
      const http = require('node:http');
      const held = new Map(); let cancellations = 0;
      const send = (id, result) => console.log(JSON.stringify({jsonrpc:'2.0',id,result}));
      readline.createInterface({input:process.stdin}).on('line', line => {
        const m = JSON.parse(line);
        if (m.method === 'initialize') send(m.id,{serverInfo:{name:'cancelfixture'}});
        else if (m.method === 'tools/list') {
          if (process.env.HOLD_LIST) held.set(m.id,null);
          else send(m.id,{tools:[{name:'wait',inputSchema:{type:'object',properties:{url:{type:'string'}},required:['url']}}]});
        } else if (m.method === 'tools/call') {
          if (m.params.name === 'stats') send(m.id,{cancellations,held:held.size});
          else {
            const request = http.get(m.params.arguments.url,res => res.resume());
            request.on('error',()=>{}); held.set(m.id,request);
          }
        } else if (m.method === 'notifications/cancelled' && held.has(m.params.requestId)) {
          held.get(m.params.requestId)?.destroy(); held.delete(m.params.requestId); cancellations++;
        }
      });
    `]
  } } };
  let mcpPid;
  let mcpCancellations = 0;
  for (const [model, protocol] of [['glm-5.3-flash', 'chat'], ['qwen3.8-max', 'messages'],
    ['gpt-6-luna', 'responses'], ['gemini-4-argon', 'google']]) {
    for (const tool of ['fetch_url', 'run_command', 'mcp__cancelfixture__wait']) {
      await t.test(`${protocol}: ${tool}`, async sub => {
        const sessionId = `${protocol}-${tool}`;
        let modelCalls = 0;
        let webStarted = false;
        let webClosed = false;
        const onWeb = (_req, res) => { webStarted = true; res.once('close', () => { webClosed = true; }); };
        web.on('request', onWeb);
        sub.after(() => web.off('request', onWeb));
        saveConfig({ ...defaultConfig, workspaceRoot: workspace, activeModel: `opencode-go:${model}`,
          opencodeGoEnabled: true, opencodeGoApiKey: 'fixture-key', agentModelRoutingEnabled: false,
          agentMemoryEnabled: false, permissionMode: tool === 'run_command' ? 'strict' : 'operator', webRequestTimeoutMs: 10000,
          ...(tool.startsWith('mcp__') ? { mcp } : {}) });
        const params = tool === 'run_command' ? { command: 'must-not-run-fixture' } : { url: webUrl };
        sub.mock.method(globalThis, 'fetch', (url, options) => {
          if (!String(url).startsWith('https://opencode.ai/inference/go/')) return realFetch(url, options);
          modelCalls++;
          let stream;
          if (protocol === 'chat') stream = frame({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'fixture-call', function: { name: tool, arguments: JSON.stringify(params) } }] }, finish_reason: 'tool_calls' }] });
          else if (protocol === 'messages') stream = frame({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'fixture-call', name: tool, input: params } }) + frame({ type: 'message_stop' });
          else if (protocol === 'responses') stream = frame({ type: 'response.output_item.added', item: { type: 'function_call', id: 'fixture-item', call_id: 'fixture-call', name: tool, arguments: JSON.stringify(params) } }) + frame({ type: 'response.completed' });
          else stream = frame({ candidates: [{ content: { parts: [{ functionCall: { name: tool, args: params } }] }, finishReason: 'STOP' }] });
          return Promise.resolve(new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } }));
        });
        const stop = new AbortController();
        sub.after(() => stop.abort());
        const response = await realFetch(`${base}/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ providerSessionId: sessionId, messages: [{ role: 'user', content: 'Inspect the requested fixture without making file changes.' }] }), signal: stop.signal });
        assert.equal(response.status, 200);
        await waitFor(() => tool === 'run_command' ? listPendingApprovals().length > 0 : webStarted);
        const approvalId = listPendingApprovals()[0]?.id;
        stop.abort();
        await waitFor(() => { const cp = store.loadLatest(); return cp?.providerSessionId === sessionId && cp?.outcome?.status === 'stopped'; });
        if (tool !== 'run_command') await waitFor(() => webClosed);
        if (tool.startsWith('mcp__')) {
          const client = await mcpClientManager.getClient('cancelfixture', { ...mcp, workspaceRoot: workspace });
          const stats = await client.callTool('stats');
          assert.deepEqual(stats, { cancellations: ++mcpCancellations, held: 0 });
          if (mcpPid) assert.equal(client.proc.pid, mcpPid, 'Stopping one tool must preserve the reusable MCP server.');
          mcpPid = client.proc.pid;
          assert.equal(client.peer.pending.size, 0);
        }
        assert.equal(modelCalls, 1, 'Cancellation must not start a model repair/retry.');
        assert.equal(listPendingApprovals().length, 0);
        if (approvalId) assert.equal(respondToApproval(approvalId, 'approve'), false);
        assert.deepEqual(fs.readdirSync(workspace), []);
      });
    }
  }
  await t.test('cancellation during MCP discovery creates a stopped checkpoint without any model call', async sub => {
    await mcpClientManager.closeAll();
    saveConfig({ ...defaultConfig, workspaceRoot: workspace, activeModel: 'opencode-go:glm-5.3-flash',
      opencodeGoEnabled: true, opencodeGoApiKey: 'fixture-key', agentMemoryEnabled: false,
      mcp: { ...mcp, servers: { cancelfixture: { ...mcp.servers.cancelfixture, env: { HOLD_LIST: '1' } } } } });
    let modelCalls = 0;
    sub.mock.method(globalThis, 'fetch', (url, options) => {
      if (String(url).startsWith('https://opencode.ai/inference/go/')) {
        modelCalls++;
        throw new Error('No model request should start after stopping discovery.');
      }
      return realFetch(url, options);
    });
    const stop = new AbortController();
    sub.after(() => stop.abort());
    sub.mock.timers.enable({ apis: ['setInterval'] });
    const response = await realFetch(`${base}/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ providerSessionId: 'cancel-discovery', messages: [{ role: 'user', content: 'Fixture only.' }] }), signal: stop.signal });
    assert.equal(response.status, 200);
    const reader = response.body.getReader();
    let initialCheckpoint;
    let discoveryStarted = false;
    const decoder = new TextDecoder();
    const parser = createParser({ onEvent(event) {
      const data = JSON.parse(event.data);
      if (data.type === 'checkpoint') initialCheckpoint = data.checkpoint;
      if (String(data.status).includes('Discovering configured MCP tools')) discoveryStarted = true;
    } });
    while (!initialCheckpoint || !discoveryStarted) {
      const packet = await reader.read();
      assert.equal(packet.done, false);
      parser.feed(decoder.decode(packet.value, { stream: true }));
    }
    assert.equal(initialCheckpoint.providerSessionId, 'cancel-discovery');
    assert.equal(initialCheckpoint.workspaceRoot, workspace);
    await waitFor(() => [...mcpClientManager.clients.values()].some(client =>
      [...(client.peer?.pending.values() || [])].some(entry => entry.method === 'tools/list')));
    sub.mock.timers.tick(15000);
    const heartbeat = new TextDecoder().decode((await reader.read()).value);
    assert.match(heartbeat, /Connecting MCP tools/);
    assert.match(heartbeat, /"heartbeat":true/);
    stop.abort();
    await waitFor(() => { const cp = store.loadLatest(); return cp?.providerSessionId === 'cancel-discovery' && cp?.outcome?.status === 'stopped'; });
    assert.equal(modelCalls, 0);
    const client = [...mcpClientManager.clients.values()][0];
    assert.deepEqual(await client.callTool('stats'), { cancellations: 1, held: 0 });
    assert.equal(client.initialized, true);
    assert.equal(client.peer.pending.size, 0);
  });
  await t.test('disconnecting a direct MCP API request cancels only that tool and preserves the server', async sub => {
    let started = false;
    let closed = false;
    const onWeb = (_req, res) => { started = true; res.once('close', () => { closed = true; }); };
    web.on('request', onWeb);
    sub.after(() => web.off('request', onWeb));
    const stop = new AbortController();
    sub.after(() => stop.abort());
    const request = realFetch(`${base}/mcp/tools/mcp__cancelfixture__wait/call`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: webUrl }), signal: stop.signal
    });
    const rejected = assert.rejects(request, error => error.name === 'AbortError');
    await waitFor(() => started);
    const client = [...mcpClientManager.clients.values()][0];
    const pid = client.proc.pid;
    stop.abort();
    await rejected;
    await waitFor(() => closed);
    const response = await realFetch(`${base}/mcp/tools/mcp__cancelfixture__stats/call`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}'
    });
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).result, { cancellations: 2, held: 0 });
    assert.equal(client.proc.pid, pid);
    assert.equal(client.peer.pending.size, 0);
  });
});
