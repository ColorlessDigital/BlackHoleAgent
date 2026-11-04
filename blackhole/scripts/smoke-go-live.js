import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { _electron } from 'playwright';
import { createParser } from 'eventsource-parser';

// Explicit opt-in: this exercises the saved Go account and consumes usage.
assert.ok(process.argv.includes('--live'), 'Pass --live to authorize real Go inference.');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const exe = path.resolve(process.argv.find(arg => arg.startsWith('--exe='))?.slice(6)
  || path.join(root, '..', 'windows', 'win-unpacked', 'BlackHole.exe'));
const label = process.argv.find(arg => arg.startsWith('--label='))?.slice(8) || 'go-live';
assert.match(label, /^[a-zA-Z0-9-]+$/);
const diagnostics = path.join(root, 'data', 'diagnostics');
fs.mkdirSync(diagnostics, { recursive: true });
const userRoot = path.join(process.env.APPDATA, 'BlackHole');
const digest = name => crypto.createHash('sha256').update(fs.readFileSync(path.join(userRoot, name))).digest('hex');
const originalConfig = digest('config.json');
const originalSecrets = digest('secrets.enc.json');
const report = { ok: false, executablePath: exe, turns: [] };
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
let app;
let page;
try {
  app = await _electron.launch({ executablePath: exe, env, timeout: 30000 });
  page = await app.firstWindow();
  const rendererErrors = [];
  page.on('pageerror', error => rendererErrors.push(error.message));
  await page.locator('.chat-textarea').waitFor();
  const api = await page.evaluate(() => window.blackhole.getApiConfig());
  const headers = { 'x-blackhole-token': api.token };
  const config = await fetch(`${api.baseUrl}/api/config`, { headers }).then(r => r.json());
  assert.ok(config.opencodeGoEnabled && config.opencodeGoApiKey === '********', 'Saved Go credentials are not configured.');
  assert.match(config.activeModel, /^opencode-go:/);
  report.model = config.activeModel;
  report.workspaceRoot = config.workspaceRoot;
  report.startedAt = new Date().toISOString();
  const prompts = [
    '\uAD6C\uB3D9 \uAC80\uC99D\uC6A9 \uC9C8\uBB38\uC785\uB2C8\uB2E4. \uD30C\uC77C\uC774\uB098 \uD130\uBBF8\uB110 \uB3C4\uAD6C\uB97C \uC0AC\uC6A9\uD558\uC9C0 \uB9D0\uACE0, \uC790\uBC14\uC2A4\uD06C\uB9BD\uD2B8 Promise\uC640 async/await\uC758 \uCC28\uC774\uB97C \uD55C\uAD6D\uC5B4\uB85C 5\uBB38\uC7A5\uC73C\uB85C \uC124\uBA85\uD574 \uC8FC\uC138\uC694.',
    '\uD30C\uC77C\uC774\uB098 \uD130\uBBF8\uB110 \uB3C4\uAD6C\uB97C \uC0AC\uC6A9\uD558\uC9C0 \uB9D0\uACE0, \uC55E\uC120 \uC124\uBA85\uC5D0 \uC774\uC5B4 \uB124\uD2B8\uC6CC\uD06C \uC694\uCCAD\uC758 \uC624\uB958\uB97C try/catch\uB85C \uCC98\uB9AC\uD558\uB294 \uC608\uC81C\uC640 \uC124\uBA85\uC744 \uC791\uC131\uD574 \uC8FC\uC138\uC694. \uCF54\uB4DC\uB97C \uC2E4\uD589\uD558\uC9C0\uB294 \uB9C8\uC138\uC694.',
    '\uD30C\uC77C\uC774\uB098 \uD130\uBBF8\uB110 \uB3C4\uAD6C\uB97C \uC0AC\uC6A9\uD558\uC9C0 \uB9D0\uACE0, \uC55E\uC120 \uC608\uC81C\uC5D0\uC11C \uC7AC\uC2DC\uB3C4\uD558\uBA74 \uC548 \uB418\uB294 \uC624\uB958\uC640 \uC7AC\uC2DC\uB3C4\uD560 \uC218 \uC788\uB294 \uC624\uB958\uB97C \uAC01\uAC01 \uC124\uBA85\uD574 \uC8FC\uC138\uC694.'
  ];
  let providerSessionId;
  for (const [index, prompt] of prompts.entries()) {
    const started = Date.now();
    const responsePromise = page.waitForResponse(r => new URL(r.url()).pathname === '/api/chat'
      && r.request().method() === 'POST', { timeout: 180000 });
    await page.locator('.chat-textarea').fill(prompt);
    await page.locator('.chat-textarea').press('Enter');
    const response = await responsePromise;
    assert.equal(response.status(), 200);
    const request = response.request().postDataJSON();
    providerSessionId ||= request.providerSessionId;
    assert.equal(request.providerSessionId, providerSessionId, 'Conversation ID changed.');
    await page.locator('.chat-stop-btn').waitFor({ state: 'detached', timeout: 180000 });
    await response.finished();
    const events = [];
    const parser = createParser({ onEvent: event => events.push(JSON.parse(event.data)) });
    parser.feed(await response.text());
    parser.reset({ consume: true });
    const errors = events.filter(e => e.type === 'error');
    const end = events.find(e => e.type === 'end');
    const answer = events.filter(e => e.type === 'chunk').map(e => e.text || '').join('');
    const scan = events.find(e => e.type === 'status' && e.scanStats)?.scanStats;
    const turn = { turn: index + 1, elapsedMs: Date.now() - started, outcome: end?.outcome,
      answerCharacters: answer.length, chunks: events.filter(e => e.type === 'chunk').length,
      retries: events.filter(e => e.type === 'status' && e.retryAttempt).length,
      errors: errors.map(e => e.error), scan,
      progress: [...new Set(events.filter(e => e.type === 'status').map(e => e.status))] };
    report.turns.push(turn);
    console.log(JSON.stringify(turn));
    assert.deepEqual(errors, [], 'Agent reported a model failure.');
    assert.equal(end?.outcome?.status, 'completed', 'Agent did not complete.');
    assert.ok(answer.trim().length >= 60, 'No substantive visible answer.');
    assert.ok(!events.some(e => e.type === 'tool_start'), 'Unexpected tool use during answer-only test.');
    assert.ok(events.some(e => e.type === 'state_change' && e.payload?.modelRoute?.model === config.activeModel));
    await page.locator('.recovery-banner').waitFor({ state: 'detached' });
    const visible = await page.locator('.brain-panel .chat-message.assistant').last().innerText();
    assert.ok(!/\[Agent Error\]|\[Error\]/.test(visible));
  }
  assert.deepEqual(rendererErrors, []);
  assert.equal(digest('config.json'), originalConfig, 'Saved configuration was changed.');
  assert.equal(digest('secrets.enc.json'), originalSecrets, 'Saved credentials were changed.');
  const saveResponse = page.waitForResponse(r => new URL(r.url()).pathname === '/api/chats/save');
  await page.locator('.sidebar-header button').filter({ hasText: /^(\uC800\uC7A5|Save|\u4FDD\u5B58)$/ }).click();
  const saved = await (await saveResponse).json();
  assert.equal(saved.success, true);
  report.savedSessionId = saved.session.id;
  report.savedSessionTitle = saved.session.title;
  report.screenshotPath = path.join(diagnostics, `${label}.png`);
  await page.screenshot({ path: report.screenshotPath });
  report.rendererErrors = rendererErrors;
  report.configurationPreserved = true;
  report.credentialsPreserved = true;
  report.ok = true;
} catch (error) {
  report.error = error.message;
  if (page) await page.screenshot({ path: path.join(diagnostics, `${label}-failed.png`) }).catch(() => {});
  process.exitCode = 1;
} finally {
  report.configurationPreserved = digest('config.json') === originalConfig;
  report.credentialsPreserved = digest('secrets.enc.json') === originalSecrets;
  if (!report.configurationPreserved || !report.credentialsPreserved) {
    report.ok = false;
    process.exitCode = 1;
  }
  report.finishedAt = new Date().toISOString();
  fs.writeFileSync(path.join(diagnostics, `${label}.json`), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
  await app?.close();
}
