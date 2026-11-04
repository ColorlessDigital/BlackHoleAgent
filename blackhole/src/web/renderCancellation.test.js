import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';

test('render cancellation closes the isolated headless browser and its stalled navigation', async t => {
  let playwright;
  try { playwright = await import('playwright'); } catch { return t.skip('Optional Playwright is not installed.'); }
  try {
    const browser = await playwright.chromium.launch({ headless: true });
    await browser.close();
  } catch (error) {
    if (error.message.includes("Executable doesn't exist")) return t.skip('Optional Chromium is not installed.');
    throw error;
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bh-render-cancel-'));
  process.env.BLACKHOLE_DATA_DIR = root;
  const { RenderInspector } = await import('./renderInspector.js');
  let started;
  let closed = false;
  const requestStarted = new Promise(resolve => { started = resolve; });
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.write('<html><body>Fixture');
    res.on('close', () => { closed = true; });
    started();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    fs.rmSync(root, { recursive: true, force: true });
  });
  const stop = new AbortController();
  const reason = new Error('fixture-render-stop');
  const pending = RenderInspector.render({ url: `http://127.0.0.1:${server.address().port}` },
    { webRenderEnabled: true, webRequestTimeoutMs: 5000 }, { abortSignal: stop.signal })
    .then(value => ({ value }), error => ({ error }));
  await Promise.race([requestStarted, delay(7000, undefined, { ref: false }).then(() => { throw new Error('Fixture navigation did not start.'); })]);
  stop.abort(reason);
  const result = await Promise.race([pending, delay(1500, null)]);
  await pending;
  assert.equal(result?.error, reason);
  assert.equal(closed, true);
});
