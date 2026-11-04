import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

// A controlled UI illustration, not a live-model benchmark or user session.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const option = (key, fallback) => args.find(value => value.startsWith(`--${key}=`))?.slice(key.length + 3) || fallback;
const frontend = path.resolve(option('frontend', path.join(root, 'blackhole/frontend/dist')));
const output = path.resolve(option('output', path.join(root, 'docs/images')));
const modules = createRequire(option('modules', path.join(root, 'blackhole/package.json')));
const { chromium } = modules('playwright');
const report = { source: 'Unmodified BlackHole built frontend with scripted API/SSE fixtures', interfaceLanguage: 'en', scriptedContentLanguage: 'en', liveModel: false, personalData: false, pages: [], errors: [], blockedExternalHosts: [] };
fs.mkdirSync(output, { recursive: true });
const fixtureCode = fs.readFileSync(path.join(root, 'examples/multi-file/after/src/cart.cjs'), 'utf8');
const checkpoint = { sessionId: 'public-demo', state: 'STOPPED', workspaceRoot: 'demo/multi-file', userGoal: 'Fix three modules without changing tests.', nextRecommendedAction: 'Resume from verification' };
const server = http.createServer((req, res) => {
  const requested = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  const file = path.resolve(frontend, `.${requested === '/' ? '/index.html' : requested}`);
  if (!file.startsWith(frontend + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404).end(); return; }
  const mime = { '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.html': 'text/html' }[path.extname(file)] || 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': mime });
  fs.createReadStream(file).pipe(res);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true, executablePath: option('browser', undefined) });
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1, locale: 'en-US', timezoneId: 'UTC' });
  page.on('pageerror', error => report.errors.push(error.message));
  page.on('console', event => {
    if (event.type() === 'error' && !(event.text() === 'Failed to load resource: net::ERR_FAILED' && report.blockedExternalHosts.length)) report.errors.push(event.text());
  });
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) { report.blockedExternalHosts.push(url.hostname); await route.abort(); return; }
    if (!url.pathname.startsWith('/api/')) { await route.continue(); return; }
    const endpoint = url.pathname.slice(4);
    let result = {};
    if (endpoint === '/config') result = { activeModel: 'llamacpp:local-gguf', workspaceRoot: 'demo/multi-file', llamaCppModelPath: 'models/demo.gguf' };
    else if (endpoint === '/workspace') result = { path: 'demo/multi-file' };
    else if (endpoint === '/files') result = { entries: [
      { name: 'src', path: 'src', isDir: true, childrenLoaded: true, children: ['math.cjs', 'cart.cjs', 'label.cjs'].map(name => ({ name, path: `src/${name}` })) },
      { name: 'check.test.cjs', path: 'check.test.cjs' }, { name: 'package.json', path: 'package.json' }
    ] };
    else if (endpoint === '/files/read') result = { content: fixtureCode };
    else if (endpoint === '/chats') result = [];
    else if (endpoint === '/security/pending') result = { pending: [] };
    else if (endpoint === '/agent/checkpoints') result = { checkpoints: [checkpoint] };
    else if (endpoint.startsWith('/agent/checkpoints/')) result = { checkpoint };
    else if (endpoint === '/runtime/status') result = { healthy: false, state: 'stopped', baseUrl: 'http://127.0.0.1:8080' };
    else if (endpoint === '/runtime/discover') result = { servers: [], models: [] };
    else if (endpoint === '/models') result = { activeModel: 'llamacpp:local-gguf', catalog: [{ id: 'llamacpp:local-gguf', label: 'Local GGUF (demo fixture)', provider: 'llama.cpp' }] };
    else if (endpoint === '/models/usage') result = { total: {}, models: [] };
    await route.fulfill({ json: result });
  });
  await page.addInitScript(({ origin }) => {
    localStorage.setItem('bh_lang', 'en');
    window.blackhole = { getApiConfig: async () => ({ baseUrl: origin, token: 'public-ui-fixture' }) };
    window.EventSource = class extends EventTarget {
      constructor() { super(); queueMicrotask(() => this.dispatchEvent(new Event('open'))); }
      close() {}
    };
    const original = window.fetch.bind(window);
    window.fetch = (url, options) => {
      if (!['/api/chat', '/api/chat/resume-checkpoint'].includes(new URL(String(url), origin).pathname)) return original(url, options);
      window.__docsStreamVersion = (window.__docsStreamVersion || 0) + 1;
      const body = new ReadableStream({ start(controller) {
        window.__docsSend = event => controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`));
        window.__docsFinish = () => { try { controller.close(); } catch { /* Consumer already cancelled after end. */ } };
      } });
      return Promise.resolve(new Response(body, { headers: { 'Content-Type': 'text/event-stream' } }));
    };
  }, { origin });
  await page.goto(origin, { waitUntil: 'networkidle' });
  await page.locator('.brain-panel').waitFor();
  await page.evaluate(() => {
    const label = document.createElement('div');
    label.textContent = 'PUBLIC UI DEMO  /  SCRIPTED DATA  /  NO LIVE MODEL';
    label.style.cssText = 'position:fixed;bottom:0;right:0;left:0;height:25px;z-index:99999;background:#e9f6ee;color:#164d34;text-align:center;font:600 11px/25px Consolas,monospace;letter-spacing:0';
    document.body.append(label);
  });
  const send = event => page.evaluate(event => window.__docsSend(event), event);
  const screenshot = async name => {
    await page.waitForTimeout(250);
    assert.equal(/[\uac00-\ud7a3]/u.test(await page.locator('body').innerText()), false, `Non-English UI text in ${name}`);
    await page.screenshot({ path: path.join(output, `${name}.png`), animations: 'disabled' });
    report.pages.push({ name, viewport: { width: 1600, height: 1000 } });
  };
  await page.locator('.tree-node').filter({ hasText: 'src' }).first().click();
  await page.locator('.tree-node').filter({ hasText: 'cart.cjs' }).click();
  await page.locator('.chat-textarea').fill('Fix math.cjs, cart.cjs and label.cjs. Keep the tests and package.json unchanged, then report the verification results.');
  await page.locator('.chat-textarea').press('Enter');
  await page.waitForFunction(() => window.__docsStreamVersion === 1);
  await send({ type: 'state_change', state: 'PLAN', payload: { summary: 'Inspect three implementation files; preserve the tests.' } });
  await send({ type: 'status', phase: 'PLAN', status: 'Scope confirmed: three implementation files', timestamp: 1700000000000 });
  await send({ type: 'chunk', text: 'I reviewed the three modules and their tests. I will change only the implementation files and verify them with the existing tests.\n\n' });
  await screenshot('demo-plan');
  await send({ type: 'state_change', state: 'EXECUTE', payload: { tool: 'write_file', path: 'src/cart.cjs' } });
  await send({ type: 'tool_start', tool: 'write_file', params: { path: 'src/cart.cjs' } });
  await send({ type: 'status', phase: 'EXECUTE', status: 'Updating the cart total to include item quantities', timestamp: 1700000001000 });
  await send({ type: 'chunk', text: 'Implementation changes\n- math.cjs: add the two inputs\n- cart.cjs: sum price multiplied by quantity\n- label.cjs: convert the label to uppercase\n\n' });
  await screenshot('demo-working');
  await send({ type: 'tool_end', tool: 'write_file', result: { ok: true } });
  await send({ type: 'state_change', state: 'VERIFY', payload: { command: 'node --test check.test.cjs' } });
  await send({ type: 'status', phase: 'VERIFY', status: 'Verifying the changes with the existing tests', timestamp: 1700000002000 });
  await send({ type: 'terminal_log', log: '> node --test check.test.cjs\n✔ add\n✔ total\n✔ label\nTests: 3 passed, 0 failed (scripted UI fixture)' });
  await send({ type: 'chunk', text: 'Verification: 3 tests passed.\nThe tests and package.json are unchanged.\n\nThis response and the execution events are scripted documentation fixtures, not live model output.' });
  await send({ type: 'checkpoint', checkpoint: { ...checkpoint, state: 'COMPLETE' } });
  await send({ type: 'end', outcome: { status: 'completed', reason: 'Scripted illustration completed' } });
  await page.evaluate(() => window.__docsFinish());
  await page.locator('.chat-stop-btn').waitFor({ state: 'detached' });
  await page.locator('.tree-node').filter({ hasText: 'src' }).first().click();
  await page.locator('.tree-node').filter({ hasText: 'cart.cjs' }).click();
  await screenshot('overview');
  await page.getByRole('button', { name: 'Execution Timeline', exact: true }).click();
  await screenshot('timeline');
  await page.getByRole('button', { name: 'Agent Chat', exact: true }).click();
  await page.locator('.chat-textarea').fill('Keep the completed edits and continue from the verification checkpoint.');
  await page.locator('.chat-textarea').press('Enter');
  await page.waitForFunction(() => window.__docsStreamVersion === 2);
  await send({ type: 'checkpoint', checkpoint });
  await send({ type: 'recovery', reason: 'request_timeout', message: 'Scripted timeout: review the checkpoint before resuming.', error: 'Scripted response timeout (no provider request)', checkpoint, checkpointAvailable: true });
  await send({ type: 'end', outcome: { status: 'stopped', reason: 'Scripted timeout illustration' } });
  await page.evaluate(() => window.__docsFinish());
  await page.locator('.recovery-banner').waitFor();
  await screenshot('recovery');
  assert.equal(report.errors.length, 0, report.errors.join('\n'));
  await page.close();
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
  fs.writeFileSync(path.join(output, 'CAPTURE_REPORT.json'), JSON.stringify(report, null, 2));
}
console.log(JSON.stringify(report));
