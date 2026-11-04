import { loadConfig } from '../config/configStore.js';
import { LlamaCppRuntime } from './llamaCppRuntime.js';
import { OpenaiCompatRuntime, resolveOpengoBaseUrl } from './openaiCompatRuntime.js';
import { OpenCodeGoRuntime, getGoModels } from './openCodeGoRuntime.js';

// Model routing: `llamacpp:*` (local GGUF) and `opengo:*` (externally
// supplied models via an OpenAI-compatible gateway, legacy alias
// `openai-compat:`). Anything else fails fast with an actionable message.
export function getRuntimeKind(model = '') {
  const name = String(model || '').trim().toLowerCase();
  if (!name || name.startsWith('llamacpp:') || name.startsWith('local-') || name === 'local-gguf') {
    return 'llamacpp';
  }
  if (name.startsWith('opengo:') || name.startsWith('openai-compat:')) {
    return 'opengo';
  }
  if (name.startsWith('opencode-go:')) return 'opencode-go';
  return 'unsupported';
}

export function createRuntimeForModel(model, config = loadConfig()) {
  const kind = getRuntimeKind(model);
  if (kind === 'llamacpp') return new LlamaCppRuntime(config);
  if (kind === 'opencode-go') {
    const runtime = new OpenCodeGoRuntime(config);
    if (!config.opencodeGoEnabled || !runtime.isConfigured()) {
      throw new Error('Enable OpenCode Go and enter its separate API key in Settings > OpenCode Go.');
    }
    return runtime;
  }
  if (kind === 'opengo') {
    const runtime = new OpenaiCompatRuntime(config);
    if (!runtime.isConfigured()) {
      throw new Error(
        `OpenGo 공급자가 설정되지 않았습니다 (model "${model}"). ` +
        `설정 → OpenGo 외부 모델에서 baseUrl을 입력하고 연결 테스트를 실행하세요.`
      );
    }
    return runtime;
  }
  throw new Error(
    `Unsupported model runtime for "${model}". Use "llamacpp:*" (local GGUF) or ` +
    `"opengo:*" (externally supplied models), "opencode-go:*" (OpenCode Go), or leave profile model empty to inherit activeModel.`
  );
}

export async function listLocalModels(config = loadConfig()) {
  try {
    return await new LlamaCppRuntime(config).listModels();
  } catch {
    return [];
  }
}

export async function listOpengoModels(config = loadConfig()) {
  try {
    // Preset default endpoint counts: key-only setup still discovers models.
    if (!config.opengoEnabled || !resolveOpengoBaseUrl(config)) return [];
    return await new OpenaiCompatRuntime(config).listModels();
  } catch {
    return [];
  }
}

function normalizeCatalogEntry(raw, provider) {
  if (!raw) return null;
  const id = String(raw.id || '').trim();
  if (!id) return null;
  return {
    id,
    name: String(raw.name || raw.label || id),
    label: String(raw.label || raw.name || id),
    provider,
    runtime: provider,
    contextLimit: Number(raw.contextLimit) || null,
    maxTokens: Number(raw.maxTokens) || null,
    source: raw.source || 'discovered'
  };
}

// Unified model catalog for the model picker: local GGUF slot + discovered
// local models + manually registered OpenGo models + discovered OpenGo models.
export async function getModelCatalog(config = loadConfig()) {
  const catalog = [];
  const seen = new Set();
  const push = (entry) => {
    if (!entry || seen.has(entry.id)) return;
    seen.add(entry.id);
    catalog.push(entry);
  };

  push({
    id: 'llamacpp:local-gguf',
    name: 'local-gguf',
    label: 'Local GGUF (llama.cpp)',
    provider: 'llamacpp',
    runtime: 'llamacpp',
    contextLimit: Number(config.contextLimit) || 8192,
    maxTokens: Number(config.maxTokens) || 4096,
    source: 'slot'
  });

  for (const m of await listLocalModels(config)) {
    push({ ...normalizeCatalogEntry(m, 'llamacpp'), source: 'discovered' });
  }

  for (const m of (config.opengoModels || [])) {
    const entry = normalizeCatalogEntry(
      {
        id: String(m.id || '').startsWith('opengo:') ? m.id : `opengo:${m.id || ''}`,
        name: m.id,
        label: m.label,
        contextLimit: m.contextLimit,
        maxTokens: m.maxTokens
      },
      'opengo'
    );
    if (entry) push({ ...entry, source: 'registered' });
  }

  if (config.opengoEnabled) {
    for (const m of await listOpengoModels(config)) {
      push({ ...normalizeCatalogEntry(m, 'opengo'), source: 'discovered' });
    }
  }

  // The API refreshes Go metadata on a TTL; routing itself stays cache-only.
  if (config.opencodeGoEnabled) {
    const entries = getGoModels(config);
    const selected = String(config.activeModel || '');
    if (selected.startsWith('opencode-go:') && !entries.some(m => m.id === selected)) {
      entries.push({ id: selected, name: selected.slice('opencode-go:'.length), provider: 'opencode-go' });
    }
    for (const entry of entries) {
      if (entry.protocol || entry.id === selected) push({ ...normalizeCatalogEntry(entry, 'opencode-go'),
        protocol: entry.protocol, availability: entry.availability, availabilityReason: entry.availabilityReason });
    }
  }

  return catalog;
}
