import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

test('P2-8: secrets are stored encrypted, plaintext migrated', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bh-secrets-'));
  process.env.BLACKHOLE_DATA_DIR = dir;
  const store = await import('./secretStore.js');

  const saved = store.saveSecrets({ apiKeys: { openai: 'sk-test-123' }, tavilyApiKey: 'tv-1' });
  assert.equal(saved.apiKeys.openai, 'sk-test-123');

  const encPath = path.join(dir, 'secrets.enc.json');
  assert.equal(fs.existsSync(encPath), true);
  assert.equal(fs.existsSync(path.join(dir, 'secrets.json')), false);
  const raw = fs.readFileSync(encPath, 'utf-8');
  assert.equal(raw.includes('sk-test-123'), false); // not plaintext

  const loaded = store.loadSecrets();
  assert.equal(loaded.apiKeys.openai, 'sk-test-123');
  assert.equal(loaded.tavilyApiKey, 'tv-1');

  // Legacy plaintext migration path (same CONFIG_DIR: drop enc, write plaintext)
  fs.rmSync(encPath, { force: true });
  fs.writeFileSync(path.join(dir, 'secrets.json'), JSON.stringify({ apiKeys: { openai: 'sk-legacy' } }), 'utf-8');
  const migrated = store.loadSecrets();
  assert.equal(migrated.apiKeys.openai, 'sk-legacy');
  assert.equal(fs.existsSync(encPath), true); // migrated to encrypted

  fs.rmSync(dir, { recursive: true, force: true });
});

test('P2-8: auth middleware only allows ?token on /api/events', async () => {
  const { createAuthMiddleware } = await import('../server/auth.js');
  const mw = createAuthMiddleware({ token: 'abc' });
  const run = (req) => new Promise((resolve) => {
    const res = { status: (code) => ({ json: (body) => resolve({ code, body }) }) };
    mw(req, res, () => resolve({ code: 200 }));
  });
  // header works everywhere
  assert.equal((await run({ path: '/api/chat', get: (h) => h === 'x-blackhole-token' ? 'abc' : undefined, query: {} })).code, 200);
  // query rejected on non-events
  assert.equal((await run({ path: '/api/chat', get: () => undefined, query: { token: 'abc' } })).code, 401);
  // query allowed on events (EventSource limitation)
  assert.equal((await run({ path: '/api/events', get: () => undefined, query: { token: 'abc' } })).code, 200);
});
