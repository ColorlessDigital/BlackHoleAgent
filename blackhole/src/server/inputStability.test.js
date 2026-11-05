import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { gzipSync } from 'node:zlib';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { listenLoopback } from '../testSupport/loopback.js';

test('test loopback allocation retries collisions using fetch-compatible ports without leaking listeners', async () => {
  const server = new EventEmitter();
  let attempts = 0;
  server.listen = (port, host) => {
    assert.ok(port >= 49152 && port <= 65535);
    assert.equal(host, '127.0.0.1');
    attempts++;
    queueMicrotask(() => attempts === 1 ? server.emit('error', Object.assign(new Error('Busy'), { code: 'EADDRINUSE' })) : server.emit('listening'));
  };
  assert.equal(await listenLoopback(server), server);
  assert.equal(attempts, 2);
  assert.equal(server.listenerCount('error'), 0);
  assert.equal(server.listenerCount('listening'), 0);
});

test('test loopback allocation reports non-collision bind errors without retrying', async () => {
  const server = new EventEmitter();
  let attempts = 0;
  server.listen = () => { attempts++; queueMicrotask(() => server.emit('error', Object.assign(new Error('Denied'), { code: 'EACCES' }))); };
  await assert.rejects(listenLoopback(server), { code: 'EACCES' });
  assert.equal(attempts, 1);
  assert.equal(server.listenerCount('error'), 0);
  assert.equal(server.listenerCount('listening'), 0);
});

test('malformed compressed JSON cannot terminate the API process and subsequent requests still work', async t => {
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import express from 'express';
    const app=express(); app.use(express.json({limit:'2mb'}));
    app.get('/health',(_req,res)=>res.json({ok:true}));
    app.post('/echo',(req,res)=>res.json(req.body));
    app.use((error,_req,res,_next)=>res.status(error.status||400).json({error:'Invalid body'}));
    const server=app.listen(0,'127.0.0.1',()=>process.send({port:server.address().port}));
  `], { cwd: process.cwd(), windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  const closed = new Promise(resolve => child.once('close', resolve));
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill(); await closed; });
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('API fixture did not start.')), 10000);
    child.once('message', message => { clearTimeout(timer); resolve(message.port); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`API fixture exited: ${code}`)); });
  });
  const request = (method, pathname, body, headers = {}) => new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: pathname, method,
      headers: { ...headers, ...(body ? { 'Content-Length': body.length } : {}) }, timeout: 5000 }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('Fixture request timed out.')));
    req.end(body);
  });
  for (const payload of [Buffer.concat([gzipSync('{"fixture":true}'), Buffer.from('trailing-invalid-bytes')]),
    Buffer.from('invalid-gzip')]) {
    await request('POST', '/echo', payload, { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' });
    const health = await request('GET', '/health');
    assert.equal(health.status, 200);
    assert.equal(JSON.parse(health.body).ok, true);
    assert.equal(child.exitCode, null);
  }
  const valid = await request('POST', '/echo', gzipSync('{"fixture":true}'), { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' });
  assert.equal(valid.status, 200);
  assert.equal(JSON.parse(valid.body).fixture, true);
});
