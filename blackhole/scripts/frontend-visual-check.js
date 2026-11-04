import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');
const DIST_DIR = path.join(PROJECT_ROOT, 'frontend', 'dist');
const BASELINE_PATH = path.join(PROJECT_ROOT, 'benchmarks', 'frontend-visual-baseline.json');

const args = new Set(process.argv.slice(2));
const updateBaseline = args.has('--update-baseline');
const urlArg = process.argv.find(arg => arg.startsWith('--url='));

const defaultBaseline = {
  name: 'BlackHole frontend visual baseline',
  requiredSelectors: ['#root', '.titlebar', '.dashboard', '.brain-panel'],
  viewports: {
    desktop: {
      width: 1440,
      height: 900,
      minScreenshotBytes: 20000,
      minTextLength: 120,
      minButtonCount: 8,
      maxConsoleErrors: 0
    },
    mobile: {
      width: 390,
      height: 844,
      minScreenshotBytes: 12000,
      minTextLength: 80,
      minButtonCount: 4,
      maxConsoleErrors: 0
    }
  }
};

function loadBaseline() {
  if (!fs.existsSync(BASELINE_PATH)) return defaultBaseline;
  try {
    return {
      ...defaultBaseline,
      ...JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'))
    };
  } catch {
    return defaultBaseline;
  }
}

async function startIsolatedServer() {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'blackhole-visual-data-'));
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    const { saveConfig, defaultConfig } = await import('./src/config/configStore.js');
    saveConfig({ ...defaultConfig, workspaceRoot: process.env.BLACKHOLE_DATA_DIR });
    const { startApiServer } = await import('./src/server/apiGateway.js');
    const api = await startApiServer({ port: 0 });
    process.send({ url: api.baseUrl });
  `], {
    cwd: PROJECT_ROOT,
    env: { ...process.env, BLACKHOLE_DATA_DIR: dataRoot },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    windowsHide: true
  });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  const stop = async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill();
      await exited;
    }
    fs.rmSync(dataRoot, { recursive: true, force: true });
  };
  try {
    const url = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`API startup timed out: ${output}`)), 30000);
      const finish = (error, value) => {
        clearTimeout(timer);
        child.off('message', onMessage);
        child.off('error', onError);
        child.off('exit', onExit);
        if (error) reject(error);
        else resolve(value);
      };
      const onMessage = message => { if (message.url) finish(null, message.url); };
      const onError = error => finish(error);
      const onExit = code => finish(new Error(`API exited (${code}): ${output}`));
      child.on('message', onMessage);
      child.once('error', onError);
      child.once('exit', onExit);
    });
    return { url, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}

function assertCondition(condition, message, failures) {
  if (!condition) failures.push(message);
}

async function inspectViewport(browser, targetUrl, name, viewport, baseline, artifactsDir) {
  const page = await browser.newPage({ viewport: { width: viewport.width, height: viewport.height } });
  const consoleErrors = [];
  const failedRequests = [];

  page.on('console', msg => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('requestfailed', request => {
    failedRequests.push({
      url: request.url(),
      failureText: request.failure()?.errorText || 'unknown'
    });
  });

  await page.goto(targetUrl, { waitUntil: 'load', timeout: 30000 });
  await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});

  const metrics = await page.evaluate(requiredSelectors => {
    const bodyText = document.body?.innerText || '';
    const root = document.querySelector('#root');
    const rootBox = root?.getBoundingClientRect();
    const chatBox = document.querySelector('.brain-panel')?.getBoundingClientRect();
    return {
      title: document.title,
      textLength: bodyText.trim().length,
      buttonCount: document.querySelectorAll('button').length,
      inputCount: document.querySelectorAll('input, textarea, select').length,
      rootWidth: rootBox?.width || 0,
      rootHeight: rootBox?.height || 0,
      chatWidth: chatBox?.width || 0,
      chatInViewport: !!chatBox && chatBox.x >= 0 && chatBox.right <= window.innerWidth + 1,
      selectors: Object.fromEntries(requiredSelectors.map(selector => [selector, !!document.querySelector(selector)]))
    };
  }, baseline.requiredSelectors || defaultBaseline.requiredSelectors);

  const screenshotPath = path.join(artifactsDir, `blackhole-${name}.png`);
  const screenshot = await page.screenshot({ path: screenshotPath, fullPage: true });
  await page.close();

  const failures = [];
  const viewportBaseline = baseline.viewports?.[name] || viewport;
  assertCondition(consoleErrors.length <= (viewportBaseline.maxConsoleErrors ?? 0), `${name}: console errors detected: ${consoleErrors.join(' | ')}`, failures);
  assertCondition(metrics.textLength >= viewportBaseline.minTextLength, `${name}: visible text is too small (${metrics.textLength})`, failures);
  assertCondition(metrics.buttonCount >= viewportBaseline.minButtonCount, `${name}: too few buttons rendered (${metrics.buttonCount})`, failures);
  assertCondition(metrics.rootWidth > 0 && metrics.rootHeight > 0, `${name}: root element has empty layout`, failures);
  assertCondition(metrics.chatWidth >= Math.min(280, viewport.width * 0.6) && metrics.chatInViewport, `${name}: chat panel is clipped or too narrow (${metrics.chatWidth})`, failures);
  assertCondition(screenshot.length >= viewportBaseline.minScreenshotBytes, `${name}: screenshot is suspiciously small (${screenshot.length} bytes)`, failures);

  for (const [selector, exists] of Object.entries(metrics.selectors)) {
    assertCondition(exists, `${name}: required selector missing (${selector})`, failures);
  }

  return {
    name,
    ok: failures.length === 0,
    failures,
    metrics,
    consoleErrors,
    failedRequests,
    screenshotPath,
    screenshotBytes: screenshot.length,
    baseline: viewportBaseline
  };
}

function buildUpdatedBaseline(results) {
  return {
    ...defaultBaseline,
    updatedAt: new Date().toISOString(),
    viewports: Object.fromEntries(results.map(result => [
      result.name,
      {
        width: result.baseline.width,
        height: result.baseline.height,
        minScreenshotBytes: Math.max(1000, Math.floor(result.screenshotBytes * 0.7)),
        minTextLength: Math.max(20, Math.floor(result.metrics.textLength * 0.7)),
        minButtonCount: Math.max(1, Math.floor(result.metrics.buttonCount * 0.6)),
        maxConsoleErrors: 0
      }
    ]))
  };
}

async function inspectStreamUx(browser, url, artifactsDir) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  try {
    await page.route('**/api/agent/checkpoints/latest', route => route.fulfill({ json: { checkpoint: {
      sessionId: 'unrelated-latest', workspaceRoot: 'D:/fixture-other', userGoal: 'Different conversation', state: 'STOPPED'
    } } }));
    await page.route('**/api/agent/checkpoints/ui-fixture', route => route.fulfill({ json: { checkpoint: {
      sessionId: 'ui-fixture', providerSessionId: 'ui-provider', workspaceRoot: 'D:/fixture-original',
      userGoal: 'Resume the original conversation', state: 'STOPPED'
    } } }));
    await page.route('**/api/agent/checkpoints/missing-fixture', route => route.fulfill({ status: 404,
      json: { error: 'Requested fixture checkpoint was removed.' } }));
    await page.route('**/api/agent/checkpoints/broken-stream-fixture', route => route.fulfill({ json: { checkpoint: {
      sessionId: 'broken-stream-fixture', providerSessionId: 'stream-provider', workspaceRoot: 'D:/fixture-original',
      userGoal: 'Continue the interrupted stream', state: 'STOPPED'
    } } }));
    await page.goto(url, { waitUntil: 'load' });
    await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
    // Feed controlled SSE into the real built UI; runtime cancellation is tested separately.
    await page.evaluate(() => {
      const realFetch = window.fetch.bind(window);
      window.fetch = (input, init) => {
        const endpoint = new URL(String(input), window.location.href).pathname;
        if (!['/api/chat', '/api/chat/resume-checkpoint'].includes(endpoint)) return realFetch(input, init);
        window.__blackholeTestBody = JSON.parse(init.body);
        if (endpoint === '/api/chat/resume-checkpoint') window.__blackholeTestResumeCount = (window.__blackholeTestResumeCount || 0) + 1;
        let settled = false;
        let onAbort;
        const detach = () => init?.signal?.removeEventListener('abort', onAbort);
        const stream = new ReadableStream({
          start(controller) {
            window.__blackholeTestStream = {
              send(event) { controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`)); },
              end() {
                if (settled) return;
                settled = true;
                detach();
                controller.close();
              }
            };
            onAbort = () => {
              if (settled) return;
              settled = true;
              detach();
              controller.error(new DOMException('Stopped', 'AbortError'));
            };
            init?.signal?.addEventListener('abort', onAbort, { once: true });
          },
          cancel() {
            settled = true;
            detach();
          }
        });
        return Promise.resolve(new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } }));
      };
    });
    const startTurn = async label => {
      await page.evaluate(() => { window.__blackholeTestStream = null; });
      await page.locator('.chat-textarea').fill(label);
      await page.locator('.chat-textarea').press('Enter');
      await page.waitForFunction(() => !!window.__blackholeTestStream);
    };
    const send = event => page.evaluate(value => window.__blackholeTestStream.send(value), event);
    const finish = async outcome => {
      await send({ type: 'end', outcome });
      await page.evaluate(() => window.__blackholeTestStream.end());
      await page.locator('.chat-stop-btn').waitFor({ state: 'detached' });
    };

    await startTurn('UI status regression test');
    await send({ type: 'reasoning', requestId: 'reasoning-one', text: 'Reasoning-only fixture ',
      model: 'opencode-go:fixture-model', phase: 'PLAN', step: 1, timestamp: 100 });
    await send({ type: 'reasoning', requestId: 'reasoning-one', text: '<write_file>not an action</write_file>', timestamp: 101 });
    assert.doesNotMatch(await page.locator('.chat-messages').innerText(), /Reasoning-only fixture/);
    assert.doesNotMatch(await page.locator('.terminal-logs').innerText(), /Reasoning-only fixture/);
    await page.locator('.brain-tab').filter({ hasText: /^추론 기록$/ }).click();
    await page.locator('.reasoning-log-entry pre').filter({ hasText: 'Reasoning-only fixture <write_file>not an action</write_file>' }).waitFor();
    await send({ type: 'reasoning', requestId: 'reasoning-two', text: `Second reasoning fixture ${'long-evidence-'.repeat(80)}`,
      model: 'llamacpp:local-gguf', phase: 'PLAN', step: 2, timestamp: 102 });
    await page.waitForFunction(() => document.querySelectorAll('.reasoning-log-entry').length === 2);
    await send({ type: 'chunk', text: 'Visible answer fixture. ' });
    await page.setViewportSize({ width: 390, height: 844 });
    assert.ok(await page.locator('.reasoning-log').evaluate(element => element.scrollWidth <= element.clientWidth));
    await page.screenshot({ path: path.join(artifactsDir, 'blackhole-reasoning-mobile.png') });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.screenshot({ path: path.join(artifactsDir, 'blackhole-reasoning-desktop.png') });
    await page.locator('.brain-tab').first().click();
    assert.match(await page.locator('.chat-messages').innerText(), /Visible answer fixture/);
    assert.doesNotMatch(await page.locator('.chat-messages').innerText(), /Reasoning-only fixture|Second reasoning fixture/);
    await send({ type: 'status', status: 'Model heartbeat fixture', phase: 'PLAN', heartbeat: true,
      executionBudget: { maxSteps: 24, stepsUsed: 7, maxRepairCycles: 4, repairCyclesUsed: 0 } });
    await page.locator('.status-detail').filter({ hasText: 'Model heartbeat fixture' }).waitFor();
    await page.locator('.agent-status-bar .run-budget').filter({ hasText: '7/24' }).waitFor();
    assert.match(await page.locator('.agent-status-bar .run-budget').innerText(), /0\/4/);
    await page.screenshot({ path: path.join(artifactsDir, 'blackhole-heartbeat.png') });
    for (const text of ['ha', 'ha', '!']) await send({ type: 'chunk', text });
    await page.waitForFunction(() => [...document.querySelectorAll('.chat-message.assistant')].at(-1)?.textContent.includes('haha!'));
    await send({ type: 'recovery', reason: 'verification_failed', message: 'Verification fixture failed', checkpoint: { sessionId: 'ui-fixture' },
      executionBudget: { maxSteps: 24, stepsUsed: 7, maxRepairCycles: 4, repairCyclesUsed: 4, limitReached: 'repair_cycles' } });
    await finish({ status: 'incomplete', reason: 'verification_failed' });
    await page.locator('.recovery-banner').waitFor();
    assert.match(await page.locator('.recovery-banner').innerText(), /실패 복구 한도/);
    assert.match(await page.locator('.recovery-banner .run-budget').innerText(), /4\/4/);
    assert.match(await page.locator('.terminal-logs').innerText(), /Agent incomplete/);
    await page.screenshot({ path: path.join(artifactsDir, 'blackhole-recovery.png') });

    await page.locator('.recovery-banner button').click();
    await page.waitForFunction(() => window.__blackholeTestBody?.sessionId === 'ui-fixture');
    assert.equal(await page.evaluate(() => window.__blackholeTestBody.providerSessionId), 'ui-provider');
    assert.equal(await page.evaluate(() => window.__blackholeTestResumeCount), 1);
    await finish({ status: 'completed', reason: 'completed' });

    await startTurn('UI recovery regression test');
    assert.ok(await page.evaluate(() => window.__blackholeTestBody.messages.every(message => !Object.hasOwn(message, 'reasoning'))));
    assert.equal(await page.evaluate(() => JSON.stringify(window.__blackholeTestBody).includes('Reasoning-only fixture')), false);
    await send({ type: 'recovery', reason: 'retry', message: 'Recovery fixture running' });
    await page.locator('.recovery-banner').waitFor();
    await finish({ status: 'completed', reason: 'completed' });
    await page.locator('.recovery-banner').waitFor({ state: 'detached' });
    assert.match(await page.locator('.terminal-logs').innerText(), /Agent completed/);

    await startTurn('UI model retry regression test');
    const retryStatus = 'OpenCode Go / muse-spark-1.3-contributor: temporary model failure (server_error). Retrying once in 1s...';
    await send({ type: 'status', status: retryStatus, phase: 'PLAN', level: 'warning', retryAttempt: 2 });
    await page.locator('.status-detail').filter({ hasText: retryStatus }).waitFor();
    await page.locator('.status-history-item.warning').filter({ hasText: retryStatus }).waitFor();
    assert.match(await page.locator('.terminal-logs').innerText(), /Retrying once in 1s/);
    await send({ type: 'status', status: 'Model reasoning in progress...', phase: 'PLAN' });
    await page.locator('.status-detail').filter({ hasText: 'Model reasoning in progress' }).waitFor();
    await send({ type: 'chunk', text: 'Recovered model answer.' });
    await finish({ status: 'completed', reason: 'completed' });
    await page.locator('.recovery-banner').waitFor({ state: 'detached' });

    await startTurn('UI model failure diagnostics regression test');
    const modelError = 'OpenCode Go / muse-spark-1.3-contributor (responses, server_error, request: test-request): The model failed to generate a response.';
    await send({ type: 'error', error: modelError, checkpoint: { sessionId: 'go-fixture' } });
    await finish({ status: 'failed', reason: 'agent_error' });
    await page.locator('.recovery-error').filter({ hasText: 'server_error, request: test-request' }).waitFor();
    assert.match(await page.locator('.terminal-logs').innerText(), /muse-spark-1.3-contributor.*test-request/);
    await page.screenshot({ path: path.join(artifactsDir, 'blackhole-model-recovery.png') });

    await startTurn('UI checkpoint storage failure regression test');
    await send({ type: 'checkpoint', checkpoint: { sessionId: 'unrelated-latest', nextRecommendedAction: 'Different conversation' } });
    await send({ type: 'recovery', reason: 'agent_error', checkpoint: null, checkpointAvailable: false,
      message: 'Recovery checkpoint could not be saved for this run.' });
    await finish({ status: 'failed', reason: 'agent_error' });
    assert.equal(await page.locator('.recovery-banner button').isDisabled(), true);
    assert.equal(await page.locator('.recovery-checkpoint').count(), 0);
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.locator('.recovery-banner').evaluate(element => element.scrollWidth <= element.clientWidth), true);
    await page.screenshot({ path: path.join(artifactsDir, 'blackhole-checkpoint-unavailable-mobile.png') });
    await page.setViewportSize({ width: 1440, height: 900 });

    await startTurn('UI missing named checkpoint regression test');
    await send({ type: 'recovery', reason: 'agent_error', checkpoint: { sessionId: 'missing-fixture' } });
    await finish({ status: 'failed', reason: 'agent_error' });
    await page.locator('.recovery-banner button').click();
    await page.waitForFunction(() => document.querySelector('.recovery-banner button')?.disabled);
    assert.equal(await page.evaluate(() => window.__blackholeTestResumeCount), 1);

    await startTurn('UI unexpected stream EOF with a named checkpoint');
    await send({ type: 'checkpoint', checkpoint: { sessionId: 'broken-stream-fixture', providerSessionId: 'stream-provider' } });
    await send({ type: 'chunk', text: 'Partial fixture answer' });
    await page.evaluate(() => window.__blackholeTestStream.end());
    await page.locator('.chat-stop-btn').waitFor({ state: 'detached' });
    await page.locator('.recovery-message').filter({ hasText: 'Connection ended unexpectedly' }).waitFor();
    assert.equal(await page.locator('.recovery-banner button').isDisabled(), false);
    await page.locator('.recovery-banner button').click();
    await page.waitForFunction(() => window.__blackholeTestBody?.sessionId === 'broken-stream-fixture');
    assert.equal(await page.evaluate(() => window.__blackholeTestBody.providerSessionId), 'stream-provider');
    await finish({ status: 'completed', reason: 'completed' });

    await startTurn('UI unexpected stream EOF without a current checkpoint');
    await page.evaluate(() => window.__blackholeTestStream.end());
    await page.locator('.chat-stop-btn').waitFor({ state: 'detached' });
    assert.equal(await page.locator('.recovery-banner button').isDisabled(), true);
    assert.equal(await page.locator('.recovery-checkpoint').count(), 0);

    await startTurn('UI stream EOF after a checkpoint persistence failure');
    await send({ type: 'checkpoint', checkpoint: { sessionId: 'broken-stream-fixture' } });
    await send({ type: 'status', status: 'Fixture storage failed', level: 'warning', checkpointSaveFailed: true });
    await page.evaluate(() => window.__blackholeTestStream.end());
    await page.locator('.chat-stop-btn').waitFor({ state: 'detached' });
    assert.equal(await page.locator('.recovery-banner button').isDisabled(), true);

    await startTurn('UI exact step budget recovery test');
    await send({ type: 'state_change', state: 'FAIL', payload: {
      executionBudget: { maxSteps: 37, stepsUsed: 37, maxRepairCycles: 4, repairCyclesUsed: 0, limitReached: 'steps' }
    } });
    await send({ type: 'recovery', reason: 'step_limit', message: 'Fixture agent step budget exhausted', checkpoint: { sessionId: 'ui-fixture' },
      executionBudget: { maxSteps: 37, stepsUsed: 37, maxRepairCycles: 4, repairCyclesUsed: 0, limitReached: 'steps' } });
    await finish({ status: 'incomplete', reason: 'step_limit' });
    await page.locator('.recovery-message').filter({ hasText: '작업 단계 한도에 도달' }).waitFor();
    assert.match(await page.locator('.agent-status-bar .run-budget').innerText(), /37\/37/);
    assert.match(await page.locator('.recovery-banner .run-budget').innerText(), /0\/4/);
    await page.setViewportSize({ width: 390, height: 844 });
    assert.ok(await page.locator('.recovery-banner').evaluate(element => element.scrollWidth <= element.clientWidth));
    assert.ok(await page.locator('.agent-status-bar').evaluate(element => element.scrollWidth <= element.clientWidth));
    await page.screenshot({ path: path.join(artifactsDir, 'blackhole-run-budget-mobile.png') });
    await page.setViewportSize({ width: 1440, height: 900 });

    let rejectLimitSave = true;
    const limitUpdates = [];
    await page.route('**/api/models/opencode-go/output-limit', async route => {
      limitUpdates.push(route.request().postDataJSON());
      if (rejectLimitSave) return route.fulfill({ status: 503, json: { error: 'Fixture output-limit save unavailable' } });
      const current = await page.request.get(`${url}/api/config`, { headers: route.request().headers() });
      assert.equal(current.status(), 200);
      const config = await current.json();
      const patch = limitUpdates.at(-1);
      await route.fulfill({ json: { ...config,
        opencodeGoModelMaxTokens: { ...config.opencodeGoModelMaxTokens, [patch.model]: patch.maxTokens } } });
    });
    await startTurn('UI output-limit recovery test');
    await send({ type: 'error', error: 'Fixture max_output_tokens limit 4096', checkpoint: { sessionId: 'ui-fixture' },
      modelFailure: { provider: 'opencode-go', model: 'muse-spark-1.3-contributor', code: 'output_token_limit', outputTokenLimit: 4096 },
      modelRoute: { model: 'opencode-go:muse-spark-1.3-contributor', profile: 'planner', maxTokens: 4096 } });
    await finish({ status: 'failed', reason: 'output_token_limit' });
    const recoveryForm = page.locator('.output-limit-recovery');
    await recoveryForm.waitFor();
    assert.match(await recoveryForm.innerText(), /muse-spark-1.3-contributor.*4096/);
    assert.match(await recoveryForm.innerText(), /planner/);
    const limitInput = recoveryForm.getByLabel('모델 출력 토큰 한도', { exact: true });
    assert.equal(await recoveryForm.locator('button').isDisabled(), true);
    await limitInput.fill('0');
    assert.equal(await recoveryForm.locator('button').isDisabled(), true);
    await limitInput.fill('12345');
    const previousResumes = await page.evaluate(() => window.__blackholeTestResumeCount);
    await recoveryForm.locator('button').click();
    await recoveryForm.getByRole('alert').filter({ hasText: 'Fixture output-limit save unavailable' }).waitFor();
    assert.equal(await page.evaluate(() => window.__blackholeTestResumeCount), previousResumes);
    assert.deepEqual(limitUpdates, [{ model: 'muse-spark-1.3-contributor', maxTokens: 12345 }]);
    await page.setViewportSize({ width: 390, height: 844 });
    assert.ok(await page.locator('.recovery-banner').evaluate(element => element.scrollWidth <= element.clientWidth));
    await page.screenshot({ path: path.join(artifactsDir, 'blackhole-output-limit-mobile.png') });
    await page.setViewportSize({ width: 1440, height: 900 });
    rejectLimitSave = false;
    await limitInput.fill('16384');
    await recoveryForm.locator('button').click();
    await page.waitForFunction(count => window.__blackholeTestResumeCount === count + 1, previousResumes);
    assert.equal(await page.evaluate(() => window.__blackholeTestBody.sessionId), 'ui-fixture');
    assert.equal(await page.evaluate(() => window.__blackholeTestBody.providerSessionId), 'ui-provider');
    assert.deepEqual(limitUpdates.at(-1), { model: 'muse-spark-1.3-contributor', maxTokens: 16384 });
    await finish({ status: 'completed', reason: 'completed' });

    await startTurn('UI stop regression test');
    await send({ type: 'reasoning', requestId: 'stopped-reasoning', text: 'Reasoning retained after stop', model: 'fixture-model', timestamp: 103 });
    await page.locator('.chat-stop-btn').click();
    await page.locator('.chat-stop-btn').waitFor({ state: 'detached' });
    assert.match(await page.locator('.chat-messages').innerText(), /Stopped by user/);
    assert.doesNotMatch(await page.locator('.chat-messages').innerText(), /Reasoning retained after stop/);
    await page.locator('.brain-tab').filter({ hasText: /^추론 기록$/ }).click();
    await page.locator('.reasoning-log-entry pre').filter({ hasText: 'Reasoning retained after stop' }).waitFor();
    if (!await page.locator('.sidebar').isVisible()) await page.locator('.sidebar-toggle-btn').click();
    const [savedReasoning] = await Promise.all([
      page.waitForResponse(response => new URL(response.url()).pathname === '/api/chats/save'),
      page.getByRole('button', { name: '저장', exact: true }).click()
    ]);
    const savedSession = (await savedReasoning.json()).session;
    assert.ok(savedSession.messages.some(message => message.reasoning?.some(record => record.text === 'Reasoning retained after stop')));
    assert.ok(savedSession.messages.every(message => !message.content.includes('Reasoning-only fixture')));
    await page.getByRole('button', { name: '새 대화', exact: true }).click();
    await page.locator('.reasoning-log-empty').waitFor();
    await page.locator('.chat-sessions-list > button').filter({ hasText: savedSession.title }).click();
    await page.locator('.reasoning-log-entry pre').filter({ hasText: 'Reasoning retained after stop' }).waitFor();
    return { ok: true, checks: ['heartbeat', 'repeated-chunks', 'incomplete-recovery', 'recovered-completion',
      'model-retry-status', 'model-reasoning-status', 'model-failure-diagnostics', 'named-checkpoint-resume',
      'checkpoint-save-unavailable', 'missing-checkpoint-no-substitution', 'stream-eof-named-resume',
      'stream-eof-no-global-fallback', 'stream-eof-after-storage-failure', 'run-budget-progress',
      'repair-budget-recovery', 'step-budget-recovery-and-mobile-layout', 'reasoning-separate-live-view',
      'reasoning-not-in-chat-or-next-request', 'reasoning-mobile-no-overflow', 'reasoning-retained-on-stop-and-save-reload',
      'output-limit-actual-model-and-profile', 'output-limit-invalid-and-save-error-no-resume',
      'output-limit-save-exact-model-and-named-resume', 'output-limit-mobile-no-overflow', 'stop'] };
  } finally {
    await page.close();
  }
}

async function inspectGoSettings(browser, url, artifactsDir) {
  const results = [];
  for (const [name, viewport] of Object.entries(defaultBaseline.viewports)) {
    const page = await browser.newPage({ viewport: { width: viewport.width, height: viewport.height } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    let tests = 0;
    const fixtureModels = [
      { id: 'opencode-go:glm-5.3-flash', name: 'glm-5.3-flash', protocol: 'chat' },
      { id: 'opencode-go:future-model', name: 'future-model', protocol: null },
      { id: 'opencode-go:retired-model', name: 'retired-model', protocol: 'chat', availability: 'retired', availabilityReason: 'HTTP 410 fixture' }
    ];
    const bootstrap = await (await page.request.get(`${url}/api/bootstrap`)).json();
    await page.request.post(`${url}/api/config`, { headers: { 'x-blackhole-token': bootstrap.token },
      data: { activeModel: 'llamacpp:local-gguf', opencodeGoEnabled: false, opencodeGoApiKey: '',
        agentMaxSteps: 24, selfHealingMaxCycles: 4,
        maxTokens: 4096, opencodeGoModelMaxTokens: {}, opencodeGoProtocolOverrides: {}, opencodeGoModels: [], opencodeGoDefaultModel: 'glm-5.3-flash' } });
    await page.route('**/api/models/test-opencode-go', route => {
      tests++;
      return route.fulfill({ json: tests === 1
        ? { ok: false, error: 'Invalid Go key fixture' }
        : { ok: true, authenticated: true, model: 'glm-5.3-flash', protocol: 'chat', latencyMs: 123 } });
    });
    await page.route('**/api/models/opencode-go', async route => {
      await page.request.post(`${url}/api/config`, { headers: { 'x-blackhole-token': bootstrap.token },
        data: { opencodeGoModels: ['glm-5.3-flash', 'future-model'] } });
      await route.fulfill({ json: { ok: true, authenticated: false, models: fixtureModels } });
    });
    // Discovery refreshes /models too; both responses must describe the same test catalog.
    await page.route('**/api/models', async route => {
      const data = await (await route.fetch()).json();
      await route.fulfill({ json: { ...data, opencodeGo: { ...data.opencodeGo, models: fixtureModels } } });
    });
    try {
      await page.goto(url, { waitUntil: 'load' });
      await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
      await page.locator('.control-btn[title]').filter({ hasText: '설정' }).click();
      await page.locator('.settings-modal-tab').filter({ hasText: /^두뇌 설정$/ }).click();
      const steps = page.getByLabel('전체 작업 단계 한도', { exact: true });
      const repairs = page.getByLabel('자가 복구 최대 반복', { exact: true });
      assert.equal(await steps.inputValue(), '24');
      assert.equal(await repairs.inputValue(), '4');
      await steps.fill('37');
      await repairs.fill('0');
      const savedRunLimits = page.waitForResponse(response => new URL(response.url()).pathname === '/api/config' && response.request().method() === 'POST');
      await page.getByRole('button', { name: '설정 저장', exact: true }).click();
      const savedRunConfig = await (await savedRunLimits).json();
      assert.equal(savedRunConfig.agentMaxSteps, 37);
      assert.equal(savedRunConfig.selfHealingMaxCycles, 0);
      assert.equal(savedRunConfig.maxTokens, 4096);
      assert.equal(savedRunConfig.activeModel, 'llamacpp:local-gguf');
      await steps.fill('0');
      const invalidRunLimits = page.waitForResponse(response => new URL(response.url()).pathname === '/api/config' && response.request().method() === 'POST');
      await page.getByRole('button', { name: '설정 저장', exact: true }).click();
      assert.equal((await invalidRunLimits).status(), 400);
      const unchanged = await (await page.request.get(`${url}/api/config`, { headers: { 'x-blackhole-token': bootstrap.token } })).json();
      assert.equal(unchanged.agentMaxSteps, 37);
      assert.equal(unchanged.selfHealingMaxCycles, 0);
      await steps.fill('24');
      await repairs.fill('4');
      const resetRunLimits = page.waitForResponse(response => new URL(response.url()).pathname === '/api/config' && response.request().method() === 'POST');
      await page.getByRole('button', { name: '설정 저장', exact: true }).click();
      assert.equal((await resetRunLimits).status(), 200);
      await steps.scrollIntoViewIfNeeded();
      assert.ok(await page.locator('.settings-modal-content').evaluate(element => element.scrollWidth <= element.clientWidth + 1));
      await page.screenshot({ path: path.join(artifactsDir, `blackhole-run-limits-${name}.png`) });
      await page.locator('.settings-modal-tab').filter({ hasText: /^OpenCode Go$/ }).click();
      const content = page.locator('.settings-modal-content');
      const key = page.getByLabel('OpenCode Go 전용 API 키', { exact: true });
      await content.getByRole('button', { name: '모델 목록 동기화', exact: true }).click();
      await page.getByLabel('Go 모델', { exact: true }).selectOption('retired-model');
      await content.getByRole('status').filter({ hasText: 'API 제공 종료: HTTP 410 fixture' }).waitFor();
      await page.getByLabel('Go 모델', { exact: true }).selectOption('future-model');
      await page.getByLabel('모델 API 방식', { exact: true }).selectOption('');
      await content.getByRole('status').filter({ hasText: '인증 테스트로 자동 확인' }).waitFor();
      assert.equal(await content.getByRole('button', { name: '키 인증 테스트', exact: true }).isDisabled(), true);
      await key.fill('go-visual-test-key');
      assert.equal(await content.getByRole('button', { name: '키 인증 테스트', exact: true }).isEnabled(), true);
      assert.equal(await content.getByRole('button', { name: '이 모델 사용', exact: true }).isDisabled(), true);
      await page.getByLabel('모델 API 방식', { exact: true }).selectOption('messages');
      assert.equal(await content.getByRole('button', { name: '이 모델 사용', exact: true }).isEnabled(), true);
      await page.getByLabel('Go 모델', { exact: true }).selectOption('glm-5.3-flash');
      const override = page.getByLabel('이 모델의 출력 한도 따로 설정', { exact: true });
      const outputLimit = page.getByLabel('모델 출력 토큰 한도', { exact: true });
      assert.equal(await override.isChecked(), false);
      await override.check();
      await outputLimit.fill('12345');
      await page.getByLabel('Go 모델', { exact: true }).selectOption('future-model');
      assert.equal(await override.isChecked(), false);
      await override.check();
      await outputLimit.fill('32768');
      await page.getByLabel('Go 모델', { exact: true }).selectOption('glm-5.3-flash');
      assert.equal(await outputLimit.inputValue(), '12345');
      await key.fill('go-visual-test-key');
      await outputLimit.fill('0');
      await content.getByRole('button', { name: '키 인증 테스트', exact: true }).click();
      await content.getByRole('status').filter({ hasText: 'positive safe integer' }).waitFor();
      assert.equal(tests, 0);
      await outputLimit.fill('12345');
      await content.getByRole('button', { name: '키 인증 테스트', exact: true }).click();
      await content.getByRole('status').filter({ hasText: 'Invalid Go key fixture' }).waitFor();
      await content.getByRole('button', { name: '키 인증 테스트', exact: true }).click();
      await content.getByRole('status').filter({ hasText: '키 인증 및 응답 확인 완료' }).waitFor();
      assert.equal(await key.inputValue(), '********');
      assert.match(await content.innerText(), /llamacpp:local-gguf/);
      await content.getByRole('button', { name: '이 모델 사용', exact: true }).click();
      await page.waitForFunction(() => document.querySelector('.settings-modal-content')?.textContent.includes('모델: opencode-go:glm-5.3-flash'));
      const savedBudgetResponse = await page.request.get(`${url}/api/config`, { headers: { 'x-blackhole-token': bootstrap.token } });
      assert.equal(savedBudgetResponse.status(), 200);
      const savedBudget = await savedBudgetResponse.json();
      assert.deepEqual(savedBudget.opencodeGoModelMaxTokens, { 'glm-5.3-flash': 12345, 'future-model': 32768 });
      assert.equal(savedBudget.maxTokens, 4096);
      await outputLimit.scrollIntoViewIfNeeded();
      await page.screenshot({ path: path.join(artifactsDir, `blackhole-go-output-${name}.png`) });
      await override.uncheck();
      const inheritanceSaved = page.waitForResponse(response => new URL(response.url()).pathname === '/api/config' && response.request().method() === 'POST');
      await content.getByRole('button', { name: '이 모델 사용', exact: true }).click();
      await inheritanceSaved;
      const inheritedResponse = await page.request.get(`${url}/api/config`, { headers: { 'x-blackhole-token': bootstrap.token } });
      assert.equal(inheritedResponse.status(), 200);
      const inherited = await inheritedResponse.json();
      assert.deepEqual(inherited.opencodeGoModelMaxTokens, { 'future-model': 32768 });
      assert.equal(inherited.maxTokens, 4096);
      await content.evaluate(element => { element.scrollTop = 0; });
      if (name === 'mobile') {
        assert.ok((await page.locator('.settings-modal-sidebar').boundingBox()).height <= 72);
      }
      await page.screenshot({ path: path.join(artifactsDir, `blackhole-go-${name}.png`) });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      assert.ok(await content.evaluate(element => element.scrollWidth <= element.clientWidth + 1));
      await content.getByRole('button', { name: '저장된 키 삭제', exact: true }).click();
      await page.waitForFunction(() => document.querySelector('.settings-modal-content input[type=password]')?.value === '');
      assert.equal(tests, 2);
      assert.deepEqual(errors, []);
      results.push({ viewport: name, ok: true, checks: ['independent-run-limit-edit-save', 'invalid-run-limit-is-atomic', 'run-limit-no-overflow', 'separate-key', 'public-discovery', 'retired-api-status', 'unknown-api-probe-or-choice', 'per-model-output-limit-edit-save-and-inherit', 'invalid-output-limit-prevents-key-test', 'invalid-key', 'masked-key', 'no-auto-switch', 'explicit-model-switch', 'key-delete', 'no-overflow'] });
    } catch (error) {
      await page.screenshot({ path: path.join(artifactsDir, `blackhole-go-failed-${name}.png`) });
      throw new Error(`Go settings ${name}: ${error.message} (screenshots: ${artifactsDir})`);
    } finally {
      await page.unrouteAll({ behavior: 'wait' });
      await page.close();
    }
  }
  return results;
}

async function main() {
  if (!fs.existsSync(DIST_DIR) || !fs.existsSync(path.join(DIST_DIR, 'index.html'))) {
    throw new Error('frontend/dist is missing. Run the frontend build before visual checks.');
  }

  let playwright;
  try {
    playwright = await import('playwright');
  } catch {
    const report = { ok: true, skipped: true, reason: 'playwright_missing' };
    console.log(JSON.stringify(report, null, 2));
    return report;
  }

  const baseline = loadBaseline();
  const artifactsDir = path.join(os.tmpdir(), `blackhole-visual-check-${Date.now()}`);
  fs.mkdirSync(artifactsDir, { recursive: true });

  let apiServer = null;
  let browser = null;
  const targetUrl = urlArg ? urlArg.slice('--url='.length) : null;
  try {
    if (!targetUrl) {
      apiServer = await startIsolatedServer();
    }
    const url = targetUrl || apiServer.url;
    browser = await playwright.chromium.launch({ headless: true });
    const results = [];
    for (const [name, viewport] of Object.entries(baseline.viewports || defaultBaseline.viewports)) {
      results.push(await inspectViewport(browser, url, name, viewport, baseline, artifactsDir));
    }
    const streamUx = await inspectStreamUx(browser, url, artifactsDir);
    // This mutates only the isolated test configuration, never a --url target.
    const goSettings = targetUrl ? { skipped: true } : await inspectGoSettings(browser, url, artifactsDir);

    if (updateBaseline) {
      fs.writeFileSync(BASELINE_PATH, JSON.stringify(buildUpdatedBaseline(results), null, 2), 'utf8');
    }

    const ok = results.every(result => result.ok);
    const report = {
      ok,
      skipped: false,
      url,
      artifactsDir,
      baselinePath: BASELINE_PATH,
      updatedBaseline: updateBaseline,
      streamUx,
      goSettings,
      results
    };
    console.log(JSON.stringify(report, null, 2));

    if (!ok) {
      process.exitCode = 1;
    }
    return report;
  } finally {
    await browser?.close();
    await apiServer?.stop();
  }
}

main().catch(error => {
  console.error(JSON.stringify({ ok: false, error: error.message }, null, 2));
  process.exit(1);
});
