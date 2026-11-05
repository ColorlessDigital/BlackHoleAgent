import test, { after } from 'node:test';
import { listenLoopback } from '../testSupport/loopback.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { EventEmitter } from 'node:events';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bh-llama-lifecycle-'));
process.env.BLACKHOLE_DATA_DIR = root;
const { LlamaCppRuntime } = await import('./llamaCppRuntime.js');
after(() => fs.rmSync(root, { recursive: true, force: true }));

test('stopping an unmanaged endpoint never kills the process listening on its port', async t => {
  const server = http.createServer((_req, res) => res.end('fixture'));
  await listenLoopback(server);
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const runtime = new LlamaCppRuntime({ llamaCppUrl: `http://127.0.0.1:${server.address().port}` });
  assert.equal(await runtime.stopServer(), false);
  assert.equal(server.listening, true);
});

test('spawn errors are reported as startup failure instead of an unhandled process error', async t => {
  const original = childProcess.spawn;
  const child = new EventEmitter();
  Object.assign(child, { exitCode: null, signalCode: null, unref() {} });
  t.mock.method(childProcess, 'spawn', () => {
    queueMicrotask(() => child.emit('error', Object.assign(new Error('fixture cannot launch'), { code: 'EACCES' })));
    return child;
  });
  syncBuiltinESMExports();
  t.after(() => { childProcess.spawn = original; syncBuiltinESMExports(); });
  const model = path.join(root, 'fixture.gguf');
  fs.writeFileSync(model, 'fixture');
  const runtime = new LlamaCppRuntime({ llamaCppServerPath: process.execPath, llamaCppModelPath: model });
  runtime.preflightCheck = async () => ({ ok: true, type: 'READY' });
  runtime.isHealthy = async () => false;
  assert.equal(await runtime.startServer(), false);
  assert.equal((await runtime.status()).managedProcessId, null);
});
