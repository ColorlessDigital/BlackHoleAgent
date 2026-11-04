import assert from 'node:assert/strict';
import test from 'node:test';
import {
  osDecryptSecrets,
  osEncryptSecrets,
  supportsOsKeychain
} from './keychain.js';

// Fake safeStorage: reversible transform (xor) standing in for DPAPI.
function makeFakeSafeStorage() {
  return {
    encryptString: (text) => Buffer.from(`enc:${text}`),
    decryptString: (buf) => String(buf.toString('utf8')).replace(/^enc:/, '')
  };
}

test('supportsOsKeychain is false under plain node', () => {
  assert.equal(supportsOsKeychain(null), false);
  assert.equal(supportsOsKeychain(), false);
});

test('os-keychain envelope round-trips with injected backend', () => {
  const fake = makeFakeSafeStorage();
  assert.equal(supportsOsKeychain(fake), true);
  const payload = JSON.stringify({ apiKeys: { openai: 'sk-x' } });
  const envelope = osEncryptSecrets(payload, fake);
  assert.equal(JSON.parse(envelope).v, 2);
  assert.equal(osDecryptSecrets(envelope, fake), payload);
});

test('os-keychain helpers fail without a backend', () => {
  assert.throws(() => osEncryptSecrets('x', null), /not available/);
  const fake = makeFakeSafeStorage();
  const envelope = osEncryptSecrets('x', fake);
  assert.throws(() => osDecryptSecrets(envelope, null), /not available/);
  assert.throws(() => osDecryptSecrets('{"v":1}', fake), /unsupported/);
});
