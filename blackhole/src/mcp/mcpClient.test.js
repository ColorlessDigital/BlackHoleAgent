import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import test from 'node:test';
import http from 'node:http';
import { getEventListeners } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { McpStdioClient, McpClientManager, mcpClientManager } from './mcpClient.js';
import { PassThrough } from 'node:stream';
import { StdioJsonRpcPeer } from './stdioJsonRpc.js';
import { DEFAULT_MCP_CONFIG } from './mcpConfig.js';
import { McpDiagnosticTail } from './mcpDiagnostics.js';

test('MCP diagnostics redact literal, URL and JSON credentials across stderr chunks without unbounded retention', () => {
  const secret = 'fixture.key+[42]/value';
  const quoted = 'fixture-"quoted"-credential';
  const variants = [secret, encodeURIComponent(secret), quoted, JSON.stringify(quoted).slice(1, -1)];
  for (const value of variants) {
    for (let split = 1; split < value.length; split++) {
      const diagnostics = new McpDiagnosticTail({ SERVICE_TOKEN: secret, SERVICE_PASSWORD: quoted }, 96);
      diagnostics.append(Buffer.from('X'.repeat(4096) + value.slice(0, split)));
      diagnostics.append(Buffer.from(value.slice(split) + ' error detail'));
      const text = diagnostics.text();
      assert.equal(text.includes(value), false);
      assert.match(text, /redacted/);
      assert.ok(text.length <= 96);
      assert.ok(diagnostics.tail.length + diagnostics.pending.length <= 96 + 2 * diagnostics.overlap);
    }
  }
  const diagnostics = new McpDiagnosticTail({}, 96);
  diagnostics.append(Buffer.alloc(1024 * 1024, 65));
  assert.equal(diagnostics.tail.length, 96);
  const korean = Buffer.from('\ud55c\uae00');
  for (const byte of korean) diagnostics.append(Buffer.from([byte]));
  diagnostics.end();
  assert.ok(diagnostics.text().endsWith('\ud55c\uae00'));
});

test('MCP diagnostics escape regex characters and preserve a non-cascading whole-credential match', () => {
  const diagnostics = new McpDiagnosticTail({ SERVICE_TOKEN: 'abc', OTHER_KEY: 'abcdef', MORE_SECRET: 'a.*[b](c)?' });
  assert.equal(diagnostics.redact('abcdef abc a.*[b](c)? normal'), '[redacted] [redacted] [redacted] normal');
  const safe = diagnostics.error(Object.assign(new Error('abcdef'), { code: 'EIO' }));
  assert.equal(safe.message, '[redacted]');
  assert.equal(safe.code, 'EIO');
  assert.equal(safe.stack.includes('abcdef'), false);
  assert.equal(safe.cause, undefined);
});

test('MCP initialization and RPC errors cannot expose configured or inherited authentication values', async t => {
  const token = 'fixture-token-for-mcp-diagnostics';
  const inherited = 'fixture-inherited-password';
  const old = process.env.BLACKHOLE_FIXTURE_PASSWORD;
  process.env.BLACKHOLE_FIXTURE_PASSWORD = inherited;
  t.after(() => {
    if (old === undefined) delete process.env.BLACKHOLE_FIXTURE_PASSWORD;
    else process.env.BLACKHOLE_FIXTURE_PASSWORD = old;
  });
  const manager = new McpClientManager();
  t.after(() => manager.closeAll());
  const script = `
    const readline = require('node:readline');
    readline.createInterface({input:process.stdin}).on('line', line => {
      const m = JSON.parse(line);
      if (m.method === 'initialize' && !process.env.FAIL_INITIALIZE) {
        console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{serverInfo:{name:'fixture'}}}));
      } else if (m.id !== undefined) {
        const key = process.env.SERVICE_TOKEN;
        process.stderr.write('Fixture diagnostics: ' + key.slice(0,7));
        setTimeout(() => {
          process.stderr.write(key.slice(7) + ' failure details\\n');
          console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,error:{code:-32000,message:
            'Fixture RPC error ' + key + ' ' + process.env.BLACKHOLE_FIXTURE_PASSWORD}}));
        },10);
      }
    });
  `;
  const config = { workspaceRoot: process.cwd(), servers: { fixture: { enabled: true,
    command: process.execPath, args: ['-e', script], env: { SERVICE_TOKEN: token } } } };
  const client = await manager.getClient('fixture', config);
  for (const request of [() => client.listTools(), () => client.callTool('failure')]) {
    await assert.rejects(request(), error => {
      assert.equal(error.message.includes(token), false);
      assert.equal(error.message.includes(inherited), false);
      assert.match(error.message, /Fixture RPC error.*redacted/);
      assert.equal(error.stack.includes(token), false);
      return true;
    });
  }
  assert.equal(client.getErrorTail().includes(token), false);
  assert.match(client.getErrorTail(), /failure details/);
  await manager.closeAll();
  const failed = await manager.listTools({ ...config, servers: { fixture: {
    ...config.servers.fixture, env: { SERVICE_TOKEN: token, FAIL_INITIALIZE: '1' }
  } } });
  assert.equal(failed.length, 1);
  assert.match(failed[0].error, /Fixture RPC error/);
  assert.equal(failed[0].error.includes(token), false);
  assert.equal(failed[0].error.includes(inherited), false);
});

test('stdio defaults to standard newline JSON and preserves split UTF-8 responses', async t => {
  const input = new PassThrough();
  const output = new PassThrough();
  const peer = new StdioJsonRpcPeer({ input, output });
  t.after(() => peer.close());
  const response = peer.request('ping');
  assert.equal(output.read().toString(), '{"jsonrpc":"2.0","id":1,"method":"ping","params":{}}\n');
  const bytes = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { text: '\uac00\ub098' } }) + '\n');
  for (const byte of bytes) input.write(Buffer.from([byte]));
  assert.deepEqual(await response, { text: '\uac00\ub098' });
});

test('stdio rejects all pending requests immediately on EOF or invalid JSON', async t => {
  for (const invalid of [false, true]) {
    const input = new PassThrough();
    const peer = new StdioJsonRpcPeer({ input, output: new PassThrough() });
    t.after(() => peer.close());
    const waiting = peer.request('tools/list', {}, { timeoutMs: 10000 });
    const rejected = assert.rejects(waiting, /closed|JSON/i);
    if (invalid) input.write('not JSON\n');
    else input.end();
    await rejected;
    assert.equal(peer.pending.size, 0);
    assert.equal(peer.closed, true);
    await assert.rejects(peer.request('ping'), /closed|JSON/i);
  }
});

test('stdio server auto replies in the legacy frame format without losing coalesced messages', t => {
  const input = new PassThrough();
  const output = new PassThrough();
  const peer = new StdioJsonRpcPeer({ input, output });
  t.after(() => peer.close());
  peer.on('request', message => peer.respond(message.id, { ok: true }));
  const text = JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'ping' });
  const wire = `Content-Length: ${Buffer.byteLength(text)}\r\n\r\n${text}`;
  for (const byte of Buffer.from(wire + wire)) input.write(Buffer.from([byte]));
  const reply = output.read().toString();
  assert.equal(reply.split('Content-Length:').length - 1, 2);
});

test('stdio cancellation targets one pending request, ignores late replies and removes its listener', async t => {
  const input = new PassThrough();
  const output = new PassThrough();
  const peer = new StdioJsonRpcPeer({ input, output });
  t.after(() => peer.close());
  const stop = new AbortController();
  const reason = new DOMException('Fixture stopped.', 'AbortError');
  const cancelled = peer.request('tools/call', { name: 'hold' }, { signal: stop.signal });
  const survivor = peer.request('ping');
  assert.equal(getEventListeners(stop.signal, 'abort').length, 1);
  stop.abort(reason);
  await assert.rejects(cancelled, error => error === reason);
  assert.equal(getEventListeners(stop.signal, 'abort').length, 0);
  assert.equal(peer.pending.size, 1);
  const sent = output.read().toString().trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(sent.at(-1), { jsonrpc: '2.0', method: 'notifications/cancelled',
    params: { requestId: 1, reason: 'Caller stopped waiting for the request.' } });
  input.write(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { message: 'Late reply' } }) + '\n');
  input.write(JSON.stringify({ jsonrpc: '2.0', id: 2, result: { ok: true } }) + '\n');
  assert.deepEqual(await survivor, { ok: true });
  assert.equal(peer.pending.size, 0);
  assert.equal(peer.closed, false);
});

test('stdio sends nothing for pre-cancelled requests or cancellations after success or transport failure', async t => {
  const input = new PassThrough();
  const output = new PassThrough();
  const peer = new StdioJsonRpcPeer({ input, output });
  t.after(() => peer.close());
  const stopped = AbortSignal.abort(new DOMException('Already stopped.', 'AbortError'));
  await assert.rejects(peer.request('tools/call', {}, { signal: stopped }), /Already stopped/);
  assert.equal(peer.pending.size, 0);
  assert.equal(output.read(), null);
  for (const close of [false, true]) {
    const stop = new AbortController();
    const waiting = peer.request('ping', {}, { signal: stop.signal });
    const { id } = JSON.parse(output.read().toString());
    if (close) {
      peer.close(new Error('Fixture closed.'));
      await assert.rejects(waiting, /Fixture closed/);
    } else {
      input.write(JSON.stringify({ jsonrpc: '2.0', id, result: {} }) + '\n');
      await waiting;
    }
    assert.equal(getEventListeners(stop.signal, 'abort').length, 0);
    stop.abort();
    assert.equal(output.read(), null);
  }
});

test('stdio deadlines send a single cancellation except for initialize and never replay the request', async t => {
  for (const method of ['tools/call', 'initialize']) {
    const input = new PassThrough();
    const output = new PassThrough();
    const peer = new StdioJsonRpcPeer({ input, output });
    t.after(() => peer.close());
    const stop = new AbortController();
    await assert.rejects(peer.request(method, {}, { timeoutMs: 25, signal: stop.signal }), /timed out/);
    stop.abort();
    const sent = output.read().toString().trim().split('\n').map(line => JSON.parse(line));
    assert.equal(sent.filter(message => message.method === method).length, 1);
    assert.equal(sent.filter(message => message.method === 'notifications/cancelled').length, method === 'initialize' ? 0 : 1);
    assert.equal(peer.pending.size, 0);
    assert.equal(getEventListeners(stop.signal, 'abort').length, 0);
  }
});

test('cancelling one MCP connection consumer preserves the shared handshake and subsequent tool calls', async t => {
  const manager = new McpClientManager();
  t.after(() => manager.closeAll());
  const config = { workspaceRoot: process.cwd(), servers: { fixture: {
    enabled: true, command: process.execPath, args: ['-e', buildCancellableMcpServerScript()]
  } } };
  const stop = new AbortController();
  const reason = new DOMException('Consumer stopped.', 'AbortError');
  const cancelled = manager.getClient('fixture', config, { signal: stop.signal });
  const survivor = manager.getClient('fixture', config);
  stop.abort(reason);
  await assert.rejects(cancelled, error => error === reason);
  const client = await survivor;
  const pid = client.proc.pid;
  assert.equal(manager.clients.size, 1);
  assert.equal(client.initialized, true);
  const callStop = new AbortController();
  const held = manager.callTool('fixture', 'hold', {}, config, { signal: callStop.signal });
  await waitUntil(() => [...client.peer.pending.values()].some(entry => entry.method === 'tools/call'));
  callStop.abort();
  await assert.rejects(held, error => error.name === 'AbortError');
  const stats = await manager.callTool('fixture', 'stats', {}, config);
  assert.deepEqual(stats, { initializes: 1, calls: 1, cancellations: 1, held: 0 });
  assert.equal(client.proc.pid, pid);
  assert.equal(client.peer.pending.size, 0);
  assert.equal(getEventListeners(stop.signal, 'abort').length, 0);
  assert.equal(getEventListeners(callStop.signal, 'abort').length, 0);
});

test('MCP tool-list cancellation is propagated rather than reported as a discovery error', async t => {
  const manager = new McpClientManager();
  t.after(() => manager.closeAll());
  const config = { workspaceRoot: process.cwd(), servers: { fixture: {
    enabled: true, command: process.execPath, args: ['-e', buildCancellableMcpServerScript()]
  } } };
  const client = await manager.getClient('fixture', config);
  const stop = new AbortController();
  const listing = manager.listTools(config, { signal: stop.signal });
  await waitUntil(() => [...client.peer.pending.values()].some(entry => entry.method === 'tools/list'));
  stop.abort();
  await assert.rejects(listing, error => error.name === 'AbortError');
  assert.equal((await client.callTool('stats')).cancellations, 1);
  assert.equal(client.initialized, true);
});

test('an MCP tool deadline frees remote work without replaying it or closing the reusable server', async t => {
  const manager = new McpClientManager();
  t.after(() => manager.closeAll());
  const config = { workspaceRoot: process.cwd(), requestTimeoutMs: 200, servers: { fixture: {
    enabled: true, command: process.execPath, args: ['-e', buildCancellableMcpServerScript()]
  } } };
  const alreadyStopped = AbortSignal.abort();
  await assert.rejects(manager.getClient('fixture', config, { signal: alreadyStopped }), error => error.name === 'AbortError');
  assert.equal(manager.clients.size, 0);
  const client = await manager.getClient('fixture', config);
  const pid = client.proc.pid;
  await assert.rejects(manager.callTool('fixture', 'hold', {}, config), /timed out/);
  assert.deepEqual(await client.callTool('stats'), { initializes: 1, calls: 1, cancellations: 1, held: 0 });
  assert.equal(client.proc.pid, pid);
  assert.equal(client.peer.pending.size, 0);
});

test('an MCP initialize deadline closes its child even when no manager owns the connection', async t => {
  const client = new McpStdioClient('hang', {
    command: process.execPath, args: ['-e', 'process.stdin.resume();']
  }, { connectTimeoutMs: 100 });
  t.after(() => client.close());
  const connecting = client.connect();
  const proc = client.proc;
  await assert.rejects(connecting, /initialize/);
  await client.close();
  assert.ok(proc.exitCode !== null || proc.signalCode !== null);
  assert.equal(client.initialized, false);
});

test('BlackHole MCP server cancels a real pending web body on notification and on stdin EOF', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bh-mcp-cancel-'));
  const data = path.join(root, 'data');
  fs.mkdirSync(data);
  fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({ workspaceRoot: root,
    permissionMode: 'operator', webRequestTimeoutMs: 15000 }));
  fs.writeFileSync(path.join(root, 'probe.txt'), 'fixture readable after cancellation');
  let started = 0;
  let closed = 0;
  const web = http.createServer((_req, res) => {
    started++;
    res.on('close', () => { closed++; });
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.write('<html>');
  });
  await new Promise(resolve => web.listen(0, '127.0.0.1', resolve));
  const manager = new McpClientManager();
  t.after(async () => {
    await manager.closeAll();
    await new Promise(resolve => { web.close(resolve); web.closeAllConnections(); });
    fs.rmSync(root, { recursive: true, force: true });
  });
  const client = await manager.getClient('blackhole', { workspaceRoot: root, servers: { blackhole: {
    enabled: true, command: process.execPath, args: [path.resolve('src/mcp/blackholeMcpServer.js')],
    env: { BLACKHOLE_DATA_DIR: data, BLACKHOLE_DISABLE_WORKSPACE_STANDARD: '1' }
  } } });
  const replies = [];
  let buffer = '';
  client.proc.stdout.on('data', chunk => {
    buffer += chunk.toString();
    let end;
    while ((end = buffer.indexOf('\n')) !== -1) {
      replies.push(JSON.parse(buffer.slice(0, end)));
      buffer = buffer.slice(end + 1);
    }
  });
  const stop = new AbortController();
  const cancelledId = client.peer.nextId;
  const held = client.callTool('fetch_url', { url: `http://127.0.0.1:${web.address().port}` }, { signal: stop.signal });
  await waitUntil(() => started === 1);
  stop.abort();
  await assert.rejects(held, error => error.name === 'AbortError');
  await waitUntil(() => closed === 1);
  const read = await client.callTool('read_file', { path: 'probe.txt' });
  assert.equal(read.isError, false);
  assert.match(JSON.stringify(read), /fixture readable after cancellation/);
  assert.equal(replies.some(reply => reply.id === cancelledId), false, 'Cancelled requests must not send late results.');
  client.peer.notify('notifications/cancelled', { requestId: 'unknown' });
  client.peer.notify('notifications/cancelled');
  assert.deepEqual(await client.peer.request('ping'), {});
  const abandoned = client.callTool('fetch_url', { url: `http://127.0.0.1:${web.address().port}` });
  const rejected = assert.rejects(abandoned, /closed|EOF|exited/i);
  await waitUntil(() => started === 2);
  client.proc.stdin.end();
  await waitUntil(() => closed === 2);
  await rejected;
});

test('concurrent MCP consumers share one handshake and an exited server fails pending requests promptly', async t => {
  const manager = new McpClientManager();
  t.after(() => manager.closeAll());
  const config = { workspaceRoot: process.cwd(), connectTimeoutMs: 5000, servers: { fixture: {
    enabled: true, command: process.execPath, args: ['--input-type=module', '-e', `
      import readline from 'node:readline';
      readline.createInterface({input:process.stdin}).on('line', line => {
        const m = JSON.parse(line);
        if (m.method === 'initialize') console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{serverInfo:{name:'fixture'}}}));
        else if (m.method === 'tools/call') process.exit(17);
      });
    `] } } };
  const clients = await Promise.all(Array.from({ length: 8 }, () => manager.getClient('fixture', config)));
  assert.ok(clients.every(client => client === clients[0]));
  const start = Date.now();
  await assert.rejects(clients[0].callTool('exit'), /closed|exited|EOF/i);
  assert.ok(Date.now() - start < 3000);
  const next = await manager.getClient('fixture', config);
  assert.equal(next.initialized, true);
});

test('a missing MCP executable is returned as a server error without crashing the process', async t => {
  const manager = new McpClientManager();
  t.after(() => manager.closeAll());
  const entries = await manager.listTools({ servers: { missing: {
    enabled: true, command: path.join(os.tmpdir(), 'blackhole-nonexistent-mcp', 'missing.exe')
  } } });
  assert.equal(entries.length, 1);
  assert.match(entries[0].error, /ENOENT|spawn|closed/i);
  assert.equal(manager.clients.size, 0);
});

test('an MCP isError result reaches the real executor as a failed tool without changing permissions', async t => {
  const { registerMcpProxyTools } = await import('./mcpToolBridge.js');
  const { ToolRegistry } = await import('../agent/core/toolRegistry.js');
  const { CapabilityExecutor } = await import('../capabilities/executor.js');
  const name = 'mcp__failurefixture__echo';
  t.after(() => { delete ToolRegistry.tools[name]; });
  t.mock.method(mcpClientManager, 'listTools', async () => [{ serverName: 'failurefixture', tool: {
    name: 'echo', inputSchema: { type: 'object', properties: {} }
  } }]);
  let failed = true;
  t.mock.method(mcpClientManager, 'callTool', async () => ({ isError: failed,
    content: [{ type: 'text', text: failed ? 'Fixture MCP failure' : 'OK' }] }));
  const config = { workspaceRoot: os.tmpdir(), permissionMode: 'full', mcp: {
    enabled: true, permissions: { '*': 'allow' }, servers: { failurefixture: { enabled: true, command: 'node' } }
  } };
  assert.equal((await registerMcpProxyTools(config)).ok, true);
  const executor = new CapabilityExecutor({ getConfig: () => config });
  const result = await executor.execute(name, {});
  assert.equal(result.ok, false);
  assert.match(result.error, /Fixture MCP failure/);
  assert.equal(result.result.isError, true);
  assert.match(ToolRegistry.getTool(name).summarizeForModel(result.result), /mcp tool failed/);
  failed = false;
  assert.equal((await executor.execute(name, {})).ok, true);
});

test('McpClientManager should initialize, list tools, and call a legacy framed stdio MCP server', async t => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'blackhole-mcp-client-'));
  const serverPath = path.join(tempDir, 'fake-mcp-server.cjs');
  fs.writeFileSync(serverPath, buildFakeMcpServerScript(), 'utf8');

  const manager = new McpClientManager();
  t.after(async () => { await manager.closeAll(); fs.rmSync(tempDir, { recursive: true, force: true }); });
  const config = {
    enabled: true,
    workspaceRoot: tempDir,
    connectTimeoutMs: 5000,
    requestTimeoutMs: 5000,
    servers: {
      fake: {
        enabled: true,
        framing: 'content-length',
        command: process.execPath,
        args: [serverPath],
        env: {},
        cwd: tempDir,
        timeoutMs: 5000
      }
    }
  };

  const tools = await manager.listTools(config);
  assert.strictEqual(tools.length, 1);
  assert.strictEqual(tools[0].serverName, 'fake');
  assert.strictEqual(tools[0].tool.name, 'echo');

  const result = await manager.callTool('fake', 'echo', { message: 'hello' }, config);
  assert.strictEqual(result.isError, false);
  assert.deepStrictEqual(result.structuredContent, { echoed: 'hello' });
  assert.strictEqual(result.content[0].text, 'hello');

  await manager.closeAll();
});

test('BlackHole MCP server should expose internal tools over standard stdio', async t => {
  const manager = new McpClientManager();
  t.after(() => manager.closeAll());
  const config = {
    enabled: true,
    workspaceRoot: process.cwd(),
    connectTimeoutMs: DEFAULT_MCP_CONFIG.connectTimeoutMs,
    requestTimeoutMs: DEFAULT_MCP_CONFIG.requestTimeoutMs,
    servers: {
      blackhole: {
        enabled: true,
        command: process.execPath,
        args: [path.resolve('src/mcp/blackholeMcpServer.js')],
        env: {},
        cwd: process.cwd(),
        timeoutMs: DEFAULT_MCP_CONFIG.requestTimeoutMs
      }
    }
  };

  const tools = await manager.listTools(config);
  assert.deepEqual(tools.filter(entry => entry.error), [], 'MCP discovery should not return transport errors');
  const toolNames = tools.map(entry => entry.tool.name);
  assert.ok(toolNames.includes('read_file'), 'read_file should be exposed as an MCP tool');
  assert.ok(toolNames.includes('run_command'), 'run_command should be exposed as an MCP tool');
  assert.ok(!toolNames.some(name => name.startsWith('mcp__')), 'MCP proxy tools should not be re-exported');

  manager.closeAll();
});

async function waitUntil(condition) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (condition()) return;
    await delay(10);
  }
  assert.fail('MCP fixture did not reach the expected state within five seconds.');
}

function buildCancellableMcpServerScript() {
  return String.raw`
const readline = require('node:readline');
let initializes = 0, calls = 0, cancellations = 0;
const held = new Set();
const send = (id, result) => console.log(JSON.stringify({jsonrpc:'2.0',id,result}));
readline.createInterface({input:process.stdin}).on('line', line => {
  const m = JSON.parse(line);
  if (m.method === 'initialize') {
    initializes++;
    setTimeout(() => send(m.id, {serverInfo:{name:'fixture'}}), 100);
  } else if (m.method === 'tools/list') held.add(m.id);
  else if (m.method === 'tools/call') {
    if (m.params.name === 'stats') send(m.id, {initializes,calls,cancellations,held:held.size});
    else { calls++; held.add(m.id); }
  } else if (m.method === 'notifications/cancelled' && held.delete(m.params.requestId)) cancellations++;
});
`;
}

function buildFakeMcpServerScript() {
  return String.raw`
let buffer = Buffer.alloc(0);
process.stdin.on('data', chunk => {
  buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
  while (true) {
    const headerEnd = buffer.indexOf('\r\n\r\n');
    if (headerEnd === -1) return;
    const header = buffer.slice(0, headerEnd).toString('utf8');
    const match = header.match(/Content-Length:\s*(\d+)/i);
    if (!match) return;
    const length = Number(match[1]);
    const start = headerEnd + 4;
    const end = start + length;
    if (buffer.length < end) return;
    const message = JSON.parse(buffer.slice(start, end).toString('utf8'));
    buffer = buffer.slice(end);
    handle(message);
  }
});

function send(message) {
  const payload = JSON.stringify(message);
  process.stdout.write('Content-Length: ' + Buffer.byteLength(payload) + '\r\n\r\n' + payload);
}

function handle(message) {
  if (message.method === 'initialize') {
    send({ jsonrpc: '2.0', id: message.id, result: {
      protocolVersion: '2025-06-18',
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'fake', version: '1.0.0' }
    }});
    return;
  }
  if (message.method === 'notifications/initialized') return;
  if (message.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: message.id, result: {
      tools: [{ name: 'echo', description: 'Echo a message', inputSchema: {
        type: 'object',
        properties: { message: { type: 'string' } },
        required: ['message']
      }}]
    }});
    return;
  }
  if (message.method === 'tools/call') {
    const text = message.params.arguments.message || '';
    send({ jsonrpc: '2.0', id: message.id, result: {
      content: [{ type: 'text', text }],
      structuredContent: { echoed: text },
      isError: false
    }});
    return;
  }
  send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'not found' }});
}
`;
}
