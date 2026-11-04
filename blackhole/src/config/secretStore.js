import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { IS_PACKAGED_ASAR, PROJECT_ROOT, getUserConfigRoot } from '../common/paths.js';
import { getSafeStorage, osDecryptSecrets, osEncryptSecrets } from './keychain.js';

export const CONFIG_DIR = process.env.BLACKHOLE_DATA_DIR || (
  IS_PACKAGED_ASAR
    ? getUserConfigRoot('BlackHole')
    : path.join(PROJECT_ROOT, 'data')
);
const SECRETS_PATH = path.join(CONFIG_DIR, 'secrets.json'); // legacy plaintext (migrated on read)
const SECRETS_ENC_PATH = path.join(CONFIG_DIR, 'secrets.enc.json'); // P2-8 AES-256-GCM
const KEY_PATH = path.join(CONFIG_DIR, '.blackhole-key.bin');

// File-level AES-256-GCM fallback. Threat model: protects against casual disk
// read / backup leak / shoulder-surf of secrets.json. It does NOT protect
// against code running as the same OS user — when Electron safeStorage is
// available the OS keychain backend (envelope v2) is used instead and no key
// file is created. Key file is created 0600 when the fallback is used.
function loadOrCreateKey() {
  if (fs.existsSync(KEY_PATH)) return fs.readFileSync(KEY_PATH);
  const key = crypto.randomBytes(32);
  if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(KEY_PATH, key, { mode: 0o600 });
  try { fs.chmodSync(KEY_PATH, 0o600); } catch {}
  return key;
}

function encryptSecrets(plainText) {
  const key = loadOrCreateKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
  return JSON.stringify({
    v: 1,
    alg: 'aes-256-gcm',
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: ciphertext.toString('base64')
  });
}

function decryptSecrets(encJson) {
  const key = fs.readFileSync(KEY_PATH);
  const enc = JSON.parse(encJson);
  if (enc.v !== 1 || enc.alg !== 'aes-256-gcm') throw new Error('unsupported secrets envelope');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(enc.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(enc.tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(enc.data, 'base64')), decipher.final()]).toString('utf8');
}

export const defaultSecrets = {
  apiKeys: {
    openai: '',
    anthropic: '',
    deepseek: '',
    gemini: ''
  },
  tavilyApiKey: '',
  exaApiKey: '',
  braveApiKey: '',
  firecrawlApiKey: '',
  opengoApiKey: '',
  opencodeGoApiKey: ''
};

function normalizeSecrets(loaded) {
  return {
    ...defaultSecrets,
    ...loaded,
    apiKeys: { ...defaultSecrets.apiKeys, ...(loaded.apiKeys || {}) }
  };
}

function readEncryptedSecrets() {
  const raw = fs.readFileSync(SECRETS_ENC_PATH, 'utf-8');
  // Envelope v2 (OS keychain) first, then v1 (AES file key).
  try {
    const envelope = JSON.parse(raw);
    if (envelope?.v === 2) {
      const safeStorage = getSafeStorage();
      if (safeStorage) return normalizeSecrets(JSON.parse(osDecryptSecrets(raw, safeStorage)));
      throw new Error('os-keychain envelope without available backend');
    }
  } catch (err) {
    if (err?.message === 'os-keychain envelope without available backend') throw err;
    // Not a v2 envelope — try v1 below.
  }
  return normalizeSecrets(JSON.parse(decryptSecrets(raw)));
}

function writeEncryptedSecrets(payload) {
  const text = JSON.stringify(payload);
  const safeStorage = getSafeStorage();
  if (safeStorage) {
    fs.writeFileSync(SECRETS_ENC_PATH, osEncryptSecrets(text, safeStorage), 'utf-8');
    return 'os-keychain';
  }
  fs.writeFileSync(SECRETS_ENC_PATH, encryptSecrets(text), 'utf-8');
  return 'file-key';
}

export function loadSecrets() {
  try {
    // Prefer encrypted store; migrate legacy plaintext once readable.
    if (fs.existsSync(SECRETS_ENC_PATH)) {
      try {
        return readEncryptedSecrets();
      } catch {
        // Fall through to plaintext (key rotation / corruption case).
      }
    }
    if (!fs.existsSync(SECRETS_PATH)) return { ...defaultSecrets };
    const loaded = JSON.parse(fs.readFileSync(SECRETS_PATH, 'utf-8'));
    const normalized = normalizeSecrets(loaded);
    // Best-effort migration to encrypted store (keeps plaintext until write succeeds).
    try {
      writeEncryptedSecrets(normalized);
    } catch {}
    return normalized;
  } catch {
    return { ...defaultSecrets };
  }
}

export function saveSecrets(secrets) {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }
  const merged = {
    ...loadSecrets(),
    ...secrets,
    apiKeys: { ...loadSecrets().apiKeys, ...(secrets.apiKeys || {}) }
  };
  // Write encrypted only; remove legacy plaintext when migration succeeds.
  writeEncryptedSecrets(merged);
  try {
    if (fs.existsSync(SECRETS_PATH)) fs.rmSync(SECRETS_PATH, { force: true });
  } catch {}
  return merged;
}

export function redactSecrets(value) {
  if (!value || typeof value !== 'object') return value;
  const cloned = structuredClone(value);
  if (cloned.apiKeys) {
    for (const key of Object.keys(cloned.apiKeys)) {
      if (cloned.apiKeys[key]) cloned.apiKeys[key] = '********';
    }
  }
  const rootKeys = ['tavilyApiKey', 'exaApiKey', 'braveApiKey', 'firecrawlApiKey', 'opengoApiKey', 'opencodeGoApiKey'];
  for (const rk of rootKeys) {
    if (cloned[rk]) cloned[rk] = '********';
  }
  return cloned;
}
