// OS keychain integration (no new native dependencies).
//
// When the backend runs inside Electron, `safeStorage` encrypts with the OS
// credential store (DPAPI on Windows, Keychain on macOS, libsecret on
// Linux) and its API is synchronous, so secretStore can stay sync.
// Everywhere else (plain `node`, CI, tests) this module reports
// unsupported and secretStore keeps the AES-GCM file key.
//
// Envelope v2: { v: 2, backend: 'safeStorage', data: base64 }.
// Envelope v1 (AES-GCM file key) and legacy plaintext remain readable.

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

export function getSafeStorage() {
  try {
    if (!process.versions?.electron) return null;
    // eslint-disable-next-line global-require
    const electron = require('electron');
    const safeStorage = electron?.safeStorage;
    if (!safeStorage || typeof safeStorage.encryptString !== 'function') return null;
    if (typeof safeStorage.isEncryptionAvailable === 'function' && !safeStorage.isEncryptionAvailable()) return null;
    return safeStorage;
  } catch {
    return null;
  }
}

export function supportsOsKeychain(safeStorage = getSafeStorage()) {
  return Boolean(safeStorage);
}

export function osEncryptSecrets(plainText, safeStorage = getSafeStorage()) {
  if (!safeStorage) throw new Error('OS keychain is not available in this runtime.');
  const encrypted = safeStorage.encryptString(String(plainText));
  const data = Buffer.isBuffer(encrypted) ? encrypted.toString('base64') : Buffer.from(encrypted).toString('base64');
  return JSON.stringify({ v: 2, backend: 'safeStorage', data });
}

export function osDecryptSecrets(envelopeJson, safeStorage = getSafeStorage()) {
  const envelope = JSON.parse(String(envelopeJson));
  if (envelope?.v !== 2 || envelope?.backend !== 'safeStorage') throw new Error('unsupported secrets envelope');
  if (!safeStorage) throw new Error('OS keychain is not available in this runtime.');
  const decrypted = safeStorage.decryptString(Buffer.from(envelope.data, 'base64'));
  return Buffer.isBuffer(decrypted) ? decrypted.toString('utf8') : String(decrypted);
}

export function describeSecretBackend() {
  if (supportsOsKeychain()) return 'os-keychain';
  return 'file-key';
}
