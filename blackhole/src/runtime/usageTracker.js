import fs from 'fs';
import path from 'path';
import { PROJECT_ROOT } from '../common/paths.js';

// Per-model token usage ledger. Every llmRouter call records one entry so
// users can see which models (local GGUF vs OpenGo-supplied) consume how
// much context. Stored at data/model-usage.json (BLACKHOLE_DATA_DIR aware).

const DATA_DIR = process.env.BLACKHOLE_DATA_DIR || path.join(PROJECT_ROOT, 'data');
const USAGE_PATH = path.join(DATA_DIR, 'model-usage.json');

const emptyTotals = () => ({ requests: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0 });

function blankStore() {
  return { version: 2, byModel: {}, totals: emptyTotals(), estimatedTotals: emptyTotals(),
    failedTotals: emptyTotals(), legacyTotals: emptyTotals(), updatedAt: null };
}

function migrateLegacy(entry) {
  return { ...entry, promptTokens: 0, completionTokens: 0, totalTokens: 0,
    legacyTotals: { ...emptyTotals(), requests: entry.requests || 0, promptTokens: entry.promptTokens || 0,
      completionTokens: entry.completionTokens || 0, totalTokens: entry.totalTokens || 0 } };
}

export function loadUsageStore() {
  try {
    if (!fs.existsSync(USAGE_PATH)) return blankStore();
    const parsed = JSON.parse(fs.readFileSync(USAGE_PATH, 'utf-8'));
    if (!parsed || typeof parsed !== 'object' || !parsed.byModel) return blankStore();
    if (parsed.version !== 2) {
      return { ...blankStore(), byModel: Object.fromEntries(Object.entries(parsed.byModel).map(([id, entry]) => [id, migrateLegacy(entry)])),
        totals: { ...emptyTotals(), requests: parsed.totals?.requests || 0 }, legacyTotals: { ...emptyTotals(), ...parsed.totals }, updatedAt: parsed.updatedAt };
    }
    return { ...blankStore(), ...parsed, totals: { ...emptyTotals(), ...(parsed.totals || {}) } };
  } catch {
    return blankStore();
  }
}

function saveUsageStore(store) {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    store.updatedAt = new Date().toISOString();
    fs.writeFileSync(USAGE_PATH, JSON.stringify(store, null, 2), 'utf-8');
  } catch {
    // Usage persistence must never break model calls.
  }
  return store;
}

export function recordUsage({ model = 'unknown', usageTag = 'agent', promptTokens = 0, completionTokens = 0, estimated = false, failed = false } = {}) {
  const store = loadUsageStore();
  const key = String(model || 'unknown');
  const entry = Object.hasOwn(store.byModel, key) ? store.byModel[key] : { ...emptyTotals(), tags: {}, lastUsed: null };
  const pt = Math.max(0, Number(promptTokens) || 0);
  const ct = Math.max(0, Number(completionTokens) || 0);
  entry.requests += 1;
  const addTokens = bucket => {
    bucket.promptTokens += pt;
    bucket.completionTokens += ct;
    bucket.totalTokens += pt + ct;
  };
  const bucketName = failed ? 'failedTotals' : estimated ? 'estimatedTotals' : null;
  if (bucketName) {
    entry[bucketName] = { ...emptyTotals(), ...entry[bucketName] };
    entry[bucketName].requests++;
    addTokens(entry[bucketName]);
    store[bucketName].requests++;
    addTokens(store[bucketName]);
  } else { addTokens(entry); addTokens(store.totals); }
  entry.tags = entry.tags || {};
  entry.tags[usageTag] = (entry.tags[usageTag] || 0) + 1;
  entry.lastUsed = new Date().toISOString();
  Object.defineProperty(store.byModel, key, { value: entry, enumerable: true, configurable: true, writable: true });
  store.totals.requests += 1;
  return saveUsageStore(store);
}

export function getUsageSummary() {
  return loadUsageStore();
}

export function resetUsage() {
  return saveUsageStore(blankStore());
}
