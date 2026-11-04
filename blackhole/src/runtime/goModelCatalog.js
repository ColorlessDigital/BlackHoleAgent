import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { CONFIG_DIR } from '../config/configStore.js';

export const GO_PROTOCOLS = ['chat', 'messages', 'responses', 'google'];
export const GO_CATALOG_URL = 'https://opencode.ai/inference/go/v1/models';
export const GO_METADATA_URL = 'https://models.dev/api.json';
const TTL = 60 * 60 * 1000;
const OBSERVATION_STATUSES = new Set(['available', 'unsupported', 'temporary_error', 'request_failed', 'retired']);
const SDK_PROTOCOLS = new Map([
  ['@ai-sdk/openai-compatible', 'chat'], ['@ai-sdk/openai', 'responses'],
  ['@ai-sdk/anthropic', 'messages'], ['@ai-sdk/google', 'google']
]);
const validId = id => typeof id === 'string' && Boolean(id.trim()) && id.length <= 200;
const positiveNumber = value => Number.isFinite(value) && value > 0 ? value : null;

function cachedMetadata(raw) {
  return Object.fromEntries(Object.entries(raw || {}).slice(0, 500)
    .filter(([id, model]) => validId(id) && GO_PROTOCOLS.includes(model?.protocol))
    .map(([id, model]) => [id, { protocol: model.protocol,
      ...(typeof model.temperature === 'boolean' ? { temperature: model.temperature } : {}),
      contextLimit: positiveNumber(model.contextLimit), maxTokens: positiveNumber(model.maxTokens) }]));
}

// Offline fallback: official Go endpoints and models.dev, checked 2026-10-27.
// Legacy IDs stay explicit; an unknown name never implies an API protocol.
export const GO_FALLBACK_MODELS = new Map([
  ['chat', ['glm-5.3-flash', 'glm-5.3', 'glm-5.2', 'kimi-k3.1-pro', 'kimi-k3',
    'kimi-k2.7-code', 'kimi-k2.6', 'longcat-2.0', 'deepseek-v4.1-flash',
    'deepseek-v4-pro', 'deepseek-v4-flash', 'deepseek-v4-flash-vision-exp',
    'mimo-v2.6-flash', 'mimo-v2.6-pro', 'mimo-v2.5', 'mimo-v2.5-pro',
    'minimax-m3.1-flash', 'hy4-preview', 'hy3', 'step-5-preview',
    'beam-free', 'iceman-contributor-free', 'space-bunny-free', 'longcat-2.5-preview-free']],
  ['messages', ['minimax-m3', 'minimax-m2.7', 'qwen3.8-max', 'qwen3.8-flash', 'qwen3.7-plus', 'claude-haiku-5-5']],
  ['responses', ['grok-4.7', 'grok-4.6', 'gpt-6-luna', 'gpt-5.6-luna',
    'muse-spark-1.3-contributor', 'muse-spark-1.2-contributor']],
  ['google', ['gemini-4-argon', 'gemini-4-argon-contributor']]
].flatMap(([protocol, ids]) => ids.map(id => [id, { protocol }])));
for (const id of ['kimi-k2.6', 'kimi-k2.7-code', 'kimi-k3', 'kimi-k3.1-pro',
  'claude-haiku-5-5', 'gemini-4-argon', 'gemini-4-argon-contributor', 'gpt-6-luna', 'gpt-5.6-luna', 'longcat-2.5-preview-free']) {
  GO_FALLBACK_MODELS.get(id).temperature = false;
}

export function normalizeGoMetadata(raw) {
  const entries = [];
  if (!raw || typeof raw.models !== 'object' || !raw.models) return {};
  for (const [id, model] of Object.entries(raw.models).slice(0, 500)) {
    if (!model || typeof model !== 'object' || !validId(id)) continue;
    const protocol = SDK_PROTOCOLS.get(model.provider?.npm || raw.npm);
    if (!protocol) continue;
    // Metadata selects a supported adapter, never an arbitrary authenticated URL.
    entries.push([id, { protocol, ...(typeof model.temperature === 'boolean' ? { temperature: model.temperature } : {}),
      contextLimit: positiveNumber(model.limit?.context), maxTokens: positiveNumber(model.limit?.output) }]);
  }
  return Object.fromEntries(entries);
}

export class GoModelCatalog {
  constructor({ cacheFile = path.join(CONFIG_DIR, 'go-model-catalog.json'),
    catalogUrl = GO_CATALOG_URL, metadataUrl = GO_METADATA_URL, ttlMs = TTL,
    fetchImpl = (...args) => fetch(...args), now = Date.now } = {}) {
    Object.assign(this, { cacheFile, catalogUrl, metadataUrl, ttlMs, fetchImpl, now });
    this.snapshot = { fetchedAt: 0, metadataFetchedAt: 0, ids: null, metadata: {}, observations: {}, probedProtocols: {} };
    this.pending = null;
    this.lastAttemptAt = null;
    this.lastError = '';
    try {
      if (cacheFile) {
        const saved = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
        if (saved.version === 1) {
          this.snapshot.fetchedAt = Number(saved.fetchedAt) || 0;
          this.snapshot.metadataFetchedAt = Number(saved.metadataFetchedAt) || 0;
          this.snapshot.ids = Array.isArray(saved.ids) ? [...new Set(saved.ids.filter(validId))].slice(0, 500) : null;
          this.snapshot.metadata = cachedMetadata(saved.metadata);
          this.snapshot.probedProtocols = cachedMetadata(saved.probedProtocols);
          this.snapshot.observations = Object.fromEntries(Object.entries(saved.observations || {}).slice(0, 500)
            .filter(([id, entry]) => validId(id) && OBSERVATION_STATUSES.has(entry?.status) && typeof entry.reason === 'string')
            .map(([id, entry]) => [id, { status: entry.status, reason: entry.reason.slice(0, 300), at: Number(entry.at) || 0 }]));
        }
      }
    } catch { /* Missing or invalid cache falls back to the bundled table. */ }
  }

  info(id) {
    return Object.hasOwn(this.snapshot.metadata, id) ? this.snapshot.metadata[id]
      : Object.hasOwn(this.snapshot.probedProtocols, id) ? this.snapshot.probedProtocols[id] : GO_FALLBACK_MODELS.get(id) || null;
  }

  ids(fallback = [...GO_FALLBACK_MODELS.keys()]) { return this.snapshot.ids ?? fallback; }

  availability(id) {
    const observation = Object.hasOwn(this.snapshot.observations, id) ? this.snapshot.observations[id] : null;
    if (observation && this.now() - observation.at < this.ttlMs) return { availability: observation.status, availabilityReason: observation.reason };
    if (this.snapshot.ids && !this.snapshot.ids.includes(id)) return { availability: 'not_listed', availabilityReason: '' };
    return { availability: 'unverified', availabilityReason: '' };
  }

  status() {
    return { fetchedAt: this.snapshot.fetchedAt || null, metadataFetchedAt: this.snapshot.metadataFetchedAt || null,
      stale: !this.snapshot.fetchedAt || !this.snapshot.metadataFetchedAt ||
        this.now() - Math.min(this.snapshot.fetchedAt, this.snapshot.metadataFetchedAt) >= this.ttlMs,
      refreshing: Boolean(this.pending), error: this.lastError || null };
  }

  observe(id, status, reason = '') {
    if (!validId(id) || !OBSERVATION_STATUSES.has(status)) return;
    this.snapshot.observations = Object.fromEntries([...Object.entries(this.snapshot.observations)
      .filter(([key]) => key !== id), [id, { status, reason: String(reason).slice(0, 300), at: this.now() }]].slice(-500));
    this.persist();
  }

  observeProtocol(id, protocol) {
    if (!validId(id) || !GO_PROTOCOLS.includes(protocol)) return;
    this.snapshot.probedProtocols = Object.fromEntries([...Object.entries(this.snapshot.probedProtocols)
      .filter(([key]) => key !== id), [id, { protocol }]].slice(-500));
    this.persist();
  }

  persist() {
    if (!this.cacheFile) return;
    const temporary = `${this.cacheFile}.${randomUUID()}.tmp`;
    try {
      fs.mkdirSync(path.dirname(this.cacheFile), { recursive: true });
      fs.writeFileSync(temporary, JSON.stringify({ version: 1, ...this.snapshot }, null, 2));
      fs.renameSync(temporary, this.cacheFile);
    } catch {
      try { fs.unlinkSync(temporary); } catch {}
    }
  }

  async refresh({ force = false } = {}) {
    if (this.pending) return this.pending;
    if (!force && ((!this.status().stale && this.now() - this.snapshot.metadataFetchedAt < this.ttlMs)
      || (this.lastAttemptAt !== null && this.now() - this.lastAttemptAt < 60000))) return this.status();
    this.lastAttemptAt = this.now();
    this.pending = this.fetchSnapshot().finally(() => { this.pending = null; }).then(() => this.status());
    return this.pending;
  }

  async fetchSnapshot() {
    const errors = [];
    for (const [kind, url] of [['catalog', this.catalogUrl], ['metadata', this.metadataUrl]]) {
      try {
        const response = await this.fetchImpl(url, { headers: { 'User-Agent': 'BlackHole/1.0.0' },
          signal: AbortSignal.timeout(5000), redirect: 'error' });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        if (kind === 'catalog') {
          if (!Array.isArray(data.data)) throw new Error('Invalid model catalog');
          const ids = [...new Set(data.data.map(model => model?.id).filter(validId))].slice(0, 500);
          if (data.data.length && !ids.length) throw new Error('Invalid model IDs');
          this.snapshot.ids = ids;
          this.snapshot.fetchedAt = this.now();
        } else {
          const metadata = normalizeGoMetadata(data['opencode-go']);
          if (!Object.keys(metadata).length) throw new Error('Invalid model metadata');
          this.snapshot.metadata = metadata;
          this.snapshot.metadataFetchedAt = this.now();
        }
      } catch (error) { errors.push(`${kind}: ${String(error.message).slice(0, 200)}`); }
    }
    this.lastError = errors.join('; ');
    this.persist();
    return this.status();
  }
}

export const goModelCatalog = new GoModelCatalog();
