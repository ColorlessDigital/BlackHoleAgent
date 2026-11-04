import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execFileSync, spawnSync } from 'node:child_process';
import { _electron } from 'playwright';
import { extractFile } from '@electron/asar';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const expectedPackage = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
const executablePath = path.resolve(process.argv.find(arg => arg.startsWith('--exe='))?.slice(6)
  || (process.platform === 'win32'
    ? path.join(projectRoot, '..', 'windows', 'win-unpacked', 'BlackHole.exe')
    : path.join(projectRoot, 'dist', 'linux-unpacked', 'blackhole')));
const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'blackhole-packaged-smoke-'));
const workspaceRoot = path.join(dataRoot, 'workspace');
fs.mkdirSync(workspaceRoot);
fs.writeFileSync(path.join(dataRoot, 'config.json'), JSON.stringify({ workspaceRoot }));
const env = { ...process.env, BLACKHOLE_DATA_DIR: dataRoot };
delete env.ELECTRON_RUN_AS_NODE;
let electronApp;
try {
  electronApp = await _electron.launch({ executablePath, args: [`--user-data-dir=${path.join(dataRoot, 'profile')}`], env, timeout: 30000 });
  const page = await electronApp.firstWindow();
  const consoleErrors = [];
  page.on('pageerror', error => consoleErrors.push(error.message));
  await page.locator('.brain-panel').waitFor();
  const api = await page.evaluate(() => window.blackhole.getApiConfig());
  const health = await fetch(`${api.baseUrl}/api/health`).then(response => response.json());
  assert.equal(health.ok, true);
  const config = await fetch(`${api.baseUrl}/api/config`, { headers: { 'x-blackhole-token': api.token } }).then(response => response.json());
  assert.equal(path.resolve(config.workspaceRoot), workspaceRoot);
  const savedConfig = await fetch(`${api.baseUrl}/api/config`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-blackhole-token': api.token },
    body: JSON.stringify({ ...config, opengoApiKey: 'blackhole-diagnostic-placeholder', opencodeGoApiKey: 'blackhole-go-diagnostic-placeholder' })
  }).then(response => response.json());
  assert.equal(savedConfig.opengoApiKey, '********');
  assert.equal(savedConfig.opencodeGoApiKey, '********');
  assert.equal(savedConfig.activeModel, 'llamacpp:local-gguf');
  const secretEnvelope = JSON.parse(fs.readFileSync(path.join(dataRoot, 'secrets.enc.json'), 'utf8'));
  if (process.platform === 'win32') {
    assert.equal(secretEnvelope.v, 2);
    assert.equal(secretEnvelope.backend, 'safeStorage');
  } else {
    assert.ok([1, 2].includes(secretEnvelope.v));
  }
  const reread = await fetch(`${api.baseUrl}/api/config`, { headers: { 'x-blackhole-token': api.token } }).then(response => response.json());
  assert.equal(reread.opengoApiKey, '********');
  assert.equal(reread.opencodeGoApiKey, '********');
  const catalog = await fetch(`${api.baseUrl}/api/models`, { headers: { 'x-blackhole-token': api.token } }).then(response => response.json());
  assert.equal(catalog.opencodeGo.configured, true);
  assert.ok(catalog.opencodeGo.models.some(model => model.protocol === 'messages'));
  assert.ok(catalog.opencodeGo.models.some(model => model.protocol === 'responses'));
  const runtime = await electronApp.evaluate(({ app, safeStorage }) => {
    return {
      packaged: app.isPackaged,
      appPath: app.getAppPath(),
      resourcesPath: process.resourcesPath,
      keychain: safeStorage.isEncryptionAvailable() ? 'os-keychain' : 'unavailable',
      storageBackend: typeof safeStorage.getSelectedStorageBackend === 'function' ? safeStorage.getSelectedStorageBackend() : process.platform,
      electronVersion: process.versions.electron,
      nodeVersion: process.versions.node,
    };
  });
  const embeddedTypescript = path.join(dataRoot, 'packaged-typescript.cjs');
  fs.writeFileSync(embeddedTypescript, extractFile(runtime.appPath, path.join('node_modules', 'typescript', 'lib', 'typescript.js')));
  const ts = createRequire(import.meta.url)(embeddedTypescript);
  runtime.astAvailable = ts.createSourceFile('sample.ts', 'export const value: number = 1;', ts.ScriptTarget.Latest).statements.length > 0;
  runtime.typescriptVersion = ts.version;
  for (const library of ['lib.d.ts', 'lib.es5.d.ts']) {
    assert.ok(extractFile(runtime.appPath, path.join('node_modules', 'typescript', 'lib', library)).length > 0);
  }
  runtime.nodeRoot = path.join(runtime.resourcesPath, 'node-runtime');
  const serverName = process.platform === 'win32' ? 'llama-server.exe' : 'llama-server';
  runtime.llamaServer = [
    path.join(runtime.resourcesPath, 'llama.cpp', `${process.platform}-${process.arch}`, serverName),
    path.join(runtime.resourcesPath, 'llama.cpp', serverName)
  ].find(candidate => fs.existsSync(candidate));
  assert.equal(runtime.packaged, true);
  assert.equal(runtime.electronVersion, expectedPackage.devDependencies.electron);
  assert.equal(runtime.astAvailable, true);
  if (process.platform === 'win32') assert.equal(runtime.keychain, 'os-keychain');
  if (runtime.storageBackend === 'basic_text') runtime.keychain = 'basic_text (not OS protected)';
  const nodePath = path.join(runtime.nodeRoot, process.platform === 'win32' ? 'node.exe' : 'bin/node');
  assert.ok(fs.existsSync(nodePath));
  assert.ok(runtime.llamaServer);
  runtime.bundledNodeVersion = execFileSync(nodePath, ['--version'], { encoding: 'utf8', timeout: 30000, windowsHide: true }).trim();
  assert.match(runtime.bundledNodeVersion, /^v24\./);
  const serverVersion = spawnSync(runtime.llamaServer, ['--version'], { encoding: 'utf8', timeout: 30000, windowsHide: true });
  assert.equal(serverVersion.status, 0, serverVersion.error?.message || serverVersion.stderr);
  runtime.llamaVersion = `${serverVersion.stdout || ''}${serverVersion.stderr || ''}`.trim();
  assert.ok(runtime.llamaVersion);
  assert.deepEqual(consoleErrors, []);
  const artifactsDir = path.join(projectRoot, 'data', 'diagnostics');
  fs.mkdirSync(artifactsDir, { recursive: true });
  const basename = `packaged-app-${process.platform}-${new Date().toISOString().slice(0, 10)}`;
  const screenshotPath = path.join(artifactsDir, `${basename}.png`);
  await page.screenshot({ path: screenshotPath });
  await page.locator('.control-btn[title]').filter({ hasText: '설정' }).click();
  await page.locator('.settings-modal-tab').filter({ hasText: /^OpenCode Go$/ }).click();
  await page.getByLabel('OpenCode Go 전용 API 키', { exact: true }).waitFor();
  assert.ok(await page.locator('.settings-modal-content').innerText().then(text => text.includes('키 인증 테스트')));
  const goScreenshotPath = path.join(artifactsDir, `${basename}-go.png`);
  await page.screenshot({ path: goScreenshotPath });
  const report = { ok: true, executablePath, health: true, goProvider: true, runtime, screenshotPath, goScreenshotPath };
  fs.writeFileSync(path.join(artifactsDir, `${basename}.json`), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} finally {
  await electronApp?.close();
  fs.rmSync(dataRoot, { recursive: true, force: true });
}
