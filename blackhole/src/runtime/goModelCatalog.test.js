import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GoModelCatalog, GO_CATALOG_URL, GO_METADATA_URL, normalizeGoMetadata } from './goModelCatalog.js';
import { getGoModels, resolveGoProtocol } from './openCodeGoRuntime.js';

const metadata = { 'opencode-go': { npm: '@ai-sdk/openai-compatible', models: {
  future: { provider: { npm: '@ai-sdk/google', api: 'https://untrusted.invalid' }, temperature: false, limit: { context: 10000, output: 3000 } },
  'future-chat': {}, unknown: { provider: { npm: '@unknown/sdk' } }
} } };

test('confirmed retirement survives cache reload, expires and can recover', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'blackhole-go-retired-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let now = 1000;
  const options = { cacheFile: path.join(root, 'catalog.json'), ttlMs: 100, now: () => now };
  const catalog = new GoModelCatalog(options);
  catalog.observe('legacy', 'retired', 'HTTP 410');
  const restored = new GoModelCatalog(options);
  assert.equal(restored.availability('legacy').availability, 'retired');
  now += 101;
  assert.equal(restored.availability('legacy').availability, 'unverified');
  restored.observe('legacy', 'available');
  assert.equal(new GoModelCatalog(options).availability('legacy').availability, 'available');
});

test('Go metadata uses only Go-specific SDK adapters, not names or authenticated URLs', () => {
  const result = normalizeGoMetadata(metadata['opencode-go']);
  assert.equal(result.future.protocol, 'google');
  assert.equal(result.future.temperature, false);
  assert.equal(result.future.contextLimit, 10000);
  assert.equal(result['future-chat'].protocol, 'chat');
  assert.equal(Object.hasOwn(result, 'unknown'), false);
  assert.equal(Object.hasOwn(result.future, 'api'), false);
});

test('Go refresh is single-flight, public, TTL-cached and never switches a selected model', async () => {
  let now = 100000, calls = 0;
  const catalog = new GoModelCatalog({ cacheFile: null, now: () => now, fetchImpl: async (url, init) => {
    calls++;
    assert.equal(init.headers.Authorization, undefined);
    assert.equal(init.headers['x-api-key'], undefined);
    assert.equal(init.redirect, 'error');
    return Response.json(url === GO_CATALOG_URL ? { data: [{ id: 'future' }, { id: 'unknown' }] } : metadata);
  } });
  await Promise.all([catalog.refresh(), catalog.refresh(), catalog.refresh()]);
  assert.equal(calls, 2);
  assert.equal(catalog.status().refreshing, false);
  assert.equal(catalog.status().stale, false);
  assert.equal(resolveGoProtocol('future', {}, catalog), 'google');
  assert.equal(resolveGoProtocol('unknown', {}, catalog), null);
  const config = { activeModel: 'opencode-go:retired', opencodeGoDefaultModel: 'glm-5.3-flash' };
  const entries = getGoModels(config, catalog);
  assert.equal(entries.find(m => m.name === 'retired').availability, 'not_listed');
  assert.equal(config.activeModel, 'opencode-go:retired');
  await catalog.refresh();
  assert.equal(calls, 2);
  now += 3600001;
  await catalog.refresh();
  assert.equal(calls, 4);
});

test('Go cache survives offline refresh without touching user config or secrets', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'blackhole-go-catalog-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cacheFile = path.join(root, 'go-model-catalog.json');
  let offline = false, now = 100000, calls = 0;
  const options = { cacheFile, now: () => now, fetchImpl: async url => {
    calls++;
    if (offline) throw new Error('Offline');
    return Response.json(url === GO_METADATA_URL ? metadata : { data: [{ id: 'future' }] });
  } };
  const catalog = new GoModelCatalog(options);
  await catalog.refresh();
  catalog.observe('future', 'unsupported', 'Unsupported model future');
  catalog.observeProtocol('legacy-id', 'messages');
  const cached = new GoModelCatalog(options);
  assert.equal(cached.info('future').protocol, 'google');
  assert.equal(cached.info('legacy-id').protocol, 'messages');
  assert.equal(cached.availability('future').availability, 'unsupported');
  assert.deepEqual(fs.readdirSync(root), ['go-model-catalog.json']);
  assert.ok(!fs.readFileSync(cacheFile, 'utf8').includes('apiKey'));
  offline = true;
  now += 3600001;
  const status = await cached.refresh();
  assert.match(status.error, /Offline/);
  assert.deepEqual(cached.ids(), ['future']);
  assert.equal(cached.info('future').protocol, 'google');
  assert.equal(cached.availability('future').availability, 'unverified');
  const count = calls;
  await cached.refresh();
  assert.equal(calls, count);
  now += 60001;
  await cached.refresh();
  assert.equal(calls, count + 2);
});

test('Go metadata failure retains protocol cache and retries independently of a fresh listing', async () => {
  let now = 100000, badMetadata = false, calls = 0;
  const catalog = new GoModelCatalog({ cacheFile: null, now: () => now, fetchImpl: async url => {
    calls++;
    return Response.json(url === GO_CATALOG_URL ? { data: [] } : badMetadata ? {} : metadata);
  } });
  await catalog.refresh();
  badMetadata = true;
  now += 3600001;
  assert.match((await catalog.refresh()).error, /metadata/);
  assert.deepEqual(catalog.ids(), []);
  assert.equal(catalog.info('future').protocol, 'google');
  now += 60001;
  await catalog.refresh();
  assert.equal(calls, 6);
});

test('Go observed failures expire, explicit successful retests recover and prototype IDs stay ordinary keys', () => {
  let now = 100000;
  const catalog = new GoModelCatalog({ cacheFile: null, now: () => now });
  assert.equal(catalog.info('__proto__'), null);
  catalog.observe('__proto__', 'unsupported', 'Unsupported model');
  assert.equal(catalog.availability('__proto__').availability, 'unsupported');
  assert.equal(catalog.availability('constructor').availability, 'unverified');
  now += 3600001;
  assert.equal(catalog.availability('__proto__').availability, 'unverified');
  catalog.observe('__proto__', 'available');
  assert.equal(catalog.availability('__proto__').availability, 'available');
  catalog.observe('glm-5.3-flash', 'unauthorized');
  assert.equal(catalog.availability('glm-5.3-flash').availability, 'unverified');
});

test('Go recent failures replace stale success, persist separately from unsupported and expire', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'blackhole-go-status-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let now = 100000;
  const options = { cacheFile: path.join(root, 'catalog.json'), now: () => now };
  const catalog = new GoModelCatalog(options);
  catalog.observe('glm-5.3-flash', 'available');
  catalog.observe('glm-5.3-flash', 'temporary_error', 'HTTP 503');
  const restored = new GoModelCatalog(options);
  assert.equal(restored.availability('glm-5.3-flash').availability, 'temporary_error');
  assert.equal(restored.availability('glm-5.3-flash').availabilityReason, 'HTTP 503');
  now += 3600001;
  assert.equal(restored.availability('glm-5.3-flash').availability, 'unverified');
  restored.observe('glm-5.3-flash', 'request_failed', 'HTTP 401');
  assert.equal(new GoModelCatalog(options).availability('glm-5.3-flash').availability, 'request_failed');
  restored.observe('glm-5.3-flash', 'available');
  assert.equal(restored.availability('glm-5.3-flash').availability, 'available');
});
