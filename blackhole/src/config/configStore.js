import fs from 'fs';
import path from 'path';
import { IS_LINUX, IS_PACKAGED_ASAR, PROJECT_ROOT, getDefaultLlamaServerPath, getUserConfigRoot } from '../common/paths.js';
import { loadSecrets, saveSecrets } from './secretStore.js';
import { applyWorkspaceStandardToConfig, stripWorkspaceDerivedConfig } from './workspaceConfig.js';
import { normalizeGoModelTokenLimits } from './goModelSettings.js';
import { DEFAULT_AGENT_RUN_LIMITS, normalizeAgentRunLimits } from './agentRunLimits.js';

export const CONFIG_DIR = process.env.BLACKHOLE_DATA_DIR || (
  IS_PACKAGED_ASAR
    ? getUserConfigRoot('BlackHole')
    : path.join(PROJECT_ROOT, 'data')
);
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');

export const defaultConfig = {
  activeModel: 'llamacpp:local-gguf',
  localRuntime: 'llamacpp',
  llamaCppUrl: 'http://127.0.0.1:8080',
  llamaCppServerPath: getDefaultLlamaServerPath(),
  llamaCppModelPath: '',
  llamaCppGpuLayers: 999,
  llamaCppThreads: 0,
  llamaCppBatch: 512,
  llamaCppParallel: 1,
  llamaCppStartupTimeoutMs: 120000,
  llamaCppRequestTimeoutMs: 600000,
  contextLimit: 8192,
  maxTokens: 4096,
  temperature: 0.2,
  ...DEFAULT_AGENT_RUN_LIMITS,
  agentCheckpointRetentionLimit: 20,
  agentMemoryEnabled: true,
  agentMemoryRetentionLimit: 200,
  agentModelRoutingEnabled: true,
  ideNativeActionsEnabled: true,
  ideAutocompleteMaxPrefixChars: 5000,
  ideAutocompleteMaxSuffixChars: 2000,
  ideInlineEditMaxSelectionChars: 12000,
  agentModelProfiles: {
    general: {
      model: '',
      contextLimit: 8192,
      maxTokens: 4096,
      temperature: 0.2
    },
    planner: {
      model: '',
      contextLimit: 8192,
      maxTokens: 4096,
      temperature: 0.2
    },
    coder: {
      model: '',
      contextLimit: 8192,
      maxTokens: 4096,
      temperature: 0.15
    },
    verifier: {
      model: '',
      contextLimit: 8192,
      maxTokens: 2048,
      temperature: 0.05
    },
    summarizer: {
      model: '',
      contextLimit: 8192,
      maxTokens: 2048,
      temperature: 0.1
    }
  },
  permissionMode: 'operator',
  // P0-2: true blocking mode. When true, BLOCKED stays BLOCKED (deny without
  // approval-escalation) and autonomous WARNING->SAFE demotion is disabled.
  strictBlocking: false,
  // Externally supplied models via an OpenAI-compatible gateway ("OpenGo").
  // activeModel / profile model values use the `opengo:<model-id>` prefix.
  opengoEnabled: false,
  opengoPreset: 'custom',
  opengoBaseUrl: '',
  opengoApiKey: '',
  opengoDefaultModel: '',
  opengoModels: [],
  opengoRequestTimeoutMs: 120000,
  opencodeGoEnabled: false,
  opencodeGoApiKey: '',
  opencodeGoDefaultModel: 'glm-5.3-flash',
  opencodeGoModels: [],
  opencodeGoProtocolOverrides: {},
  opencodeGoModelMaxTokens: {},
  opencodeGoRequestTimeoutMs: 120000,
  // Context compaction: summarize-away old turns when the conversation
  // approaches the context limit (manual compress + automatic guard).
  contextCompactionEnabled: true,
  contextCompactionThreshold: 0.9,
  allowedDrives: IS_LINUX ? [] : ['C', 'D'],
  workspaceRoot: PROJECT_ROOT,
  apiKeys: {
    openai: '',
    anthropic: '',
    deepseek: '',
    gemini: ''
  },
  webSearchProvider: 'duckduckgo',
  tavilyApiKey: '',
  exaApiKey: '',
  braveApiKey: '',
  firecrawlApiKey: '',
  webRequestTimeoutMs: 10000,
  webMaxResponseBytes: 1048576,
  webCrawlerMaxDepth: 1,
  webCrawlerMaxPages: 20,
  webCrawlerDelayMs: 1000,
  webAllowedDomains: '',
  webRenderEnabled: false,
  webStrictScopeEnabled: false,
  webRequireAllowedDomainsForCrawl: false,
  webSearchMaxResults: 5,
  webEvidenceRetentionLimit: 20,
  mcp: {
    enabled: true,
    defaultPermission: 'ask',
    connectTimeoutMs: 15000,
    requestTimeoutMs: 30000,
    servers: {
      context7: {
        enabled: false,
        command: 'npx',
        args: ['-y', '@upstash/context7-mcp'],
        env: {}
      },
      playwright: {
        enabled: false,
        command: 'npx',
        args: ['-y', '@playwright/mcp@latest'],
        env: {}
      },
      github: {
        enabled: false,
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-github'],
        env: {
          GITHUB_PERSONAL_ACCESS_TOKEN: '${GITHUB_TOKEN}'
        }
      }
    },
    permissions: {
      '*': 'ask'
    }
  },
  systemInstruction:
    'You are BlackHole, a local autonomous development agent. The user delegated high file, terminal, web, and runtime authority. Execute requested development work directly through the available tools. Use llama.cpp as the local inference runtime. Avoid repeating the same answer; keep final responses concise and report what was done, what changed, and how it was verified.'
};

export function loadConfig() {
  return applyWorkspaceStandardToConfig(loadBaseConfig());
}

function loadBaseConfig() {
  try {
    const secrets = loadSecrets();
    if (!fs.existsSync(CONFIG_PATH)) {
      return normalizeConfig({
        ...defaultConfig,
        ...secrets,
        apiKeys: { ...defaultConfig.apiKeys, ...secrets.apiKeys }
      });
    }
    const loaded = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
    return normalizeConfig({
      ...defaultConfig,
      ...loaded,
      ...secrets,
      apiKeys: {
        ...defaultConfig.apiKeys,
        ...(loaded.apiKeys || {}),
        ...secrets.apiKeys
      }
    });
  } catch {
    const secrets = loadSecrets();
    return normalizeConfig({
      ...defaultConfig,
      ...secrets,
      apiKeys: { ...defaultConfig.apiKeys, ...secrets.apiKeys }
    });
  }
}

export function saveConfig(nextConfig) {
  const nextPersistedConfig = stripWorkspaceDerivedConfig(nextConfig || {});
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }

  // 1. Load current secrets
  const currentSecrets = loadSecrets();

  // 2. Extract secrets from nextConfig
  const apiKeys = {};
  if (nextPersistedConfig.apiKeys) {
    for (const key of Object.keys(nextPersistedConfig.apiKeys)) {
      const val = nextPersistedConfig.apiKeys[key];
      if (val === '********') {
        apiKeys[key] = currentSecrets.apiKeys[key] || '';
      } else {
        apiKeys[key] = val || '';
      }
    }
  }

  const rootSecrets = {};
  const rootKeys = ['tavilyApiKey', 'exaApiKey', 'braveApiKey', 'firecrawlApiKey', 'opengoApiKey', 'opencodeGoApiKey'];
  for (const rk of rootKeys) {
    if (rk in nextPersistedConfig) {
      const val = nextPersistedConfig[rk];
      if (val === '********') {
        rootSecrets[rk] = currentSecrets[rk] || '';
      } else {
        rootSecrets[rk] = val || '';
      }
    }
  }

  // Save secrets to secrets.json
  const updatedSecrets = saveSecrets({
    apiKeys: { ...currentSecrets.apiKeys, ...apiKeys },
    ...rootSecrets
  });

  // 3. Merge config and write to config.json without secrets
  const currentConfig = loadBaseConfig();
  const merged = {
    ...currentConfig,
    ...nextPersistedConfig,
    apiKeys: { ...currentConfig.apiKeys, ...(nextPersistedConfig.apiKeys || {}) }
  };

  const cleanConfig = {
    ...merged,
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

  const normalized = normalizeConfig(cleanConfig);
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(normalized, null, 2), 'utf-8');

  // Return full config with secrets for caller/backend use
  return applyWorkspaceStandardToConfig({
    ...normalized,
    ...updatedSecrets,
    apiKeys: {
      ...normalized.apiKeys,
      ...updatedSecrets.apiKeys
    }
  });
}

function normalizeConfig(config) {
  const active = config.activeModel || 'llamacpp:local-gguf';
  const nextActive = active.startsWith('ollama:') ? 'llamacpp:local-gguf' : active;
  // P0-2: new installs default to operator (mutating tools need approval).
  // Legacy 'guard' maps to operator; explicit 'autonomous' is still honored
  // for backward compatibility.
  const permissionMode = !config.permissionMode || config.permissionMode === 'guard'
    ? 'operator'
    : config.permissionMode;
  const strictBlocking = config.strictBlocking === true;
  const opengoEnabled = config.opengoEnabled === true;
  const knownPresets = new Set(['openai', 'ollama', 'vllm', 'llama-server', 'custom']);
  const opengoPreset = knownPresets.has(config.opengoPreset) ? config.opengoPreset : 'custom';
  const opengoBaseUrl = String(config.opengoBaseUrl || '').trim().replace(/\/+$/, '');
  const opengoDefaultModel = String(config.opengoDefaultModel || '').trim();
  const opengoModels = normalizeOpengoModels(config.opengoModels);
  const opengoRequestTimeoutMs = normalizeOptionalNumber(config.opengoRequestTimeoutMs, 120000);
  const contextCompactionEnabled = config.contextCompactionEnabled !== false;
  const contextCompactionThreshold = Math.min(0.98, Math.max(0.5, Number(config.contextCompactionThreshold) || 0.9));
  const systemInstruction = looksCorruptedText(config.systemInstruction)
    ? defaultConfig.systemInstruction
    : (config.systemInstruction || defaultConfig.systemInstruction);
  return {
    ...config,
    ...normalizeAgentRunLimits(config),
    localRuntime: nextActive.startsWith('opencode-go:') ? 'opencode-go' : (nextActive.startsWith('opengo:') ? 'opengo' : 'llamacpp'),
    activeModel: nextActive,
    permissionMode,
    strictBlocking,
    opengoEnabled,
    opengoPreset,
    opengoBaseUrl,
    opengoDefaultModel,
    opengoModels,
    opengoRequestTimeoutMs,
    opencodeGoEnabled: config.opencodeGoEnabled === true,
    opencodeGoDefaultModel: String(config.opencodeGoDefaultModel || '').trim().replace(/^opencode-go[:/]/i, ''),
    opencodeGoModels: Array.isArray(config.opencodeGoModels)
      ? [...new Set(config.opencodeGoModels.filter(id => typeof id === 'string').map(id => id.trim().replace(/^opencode-go[:/]/i, '')).filter(Boolean))].slice(0, 200)
      : [],
    opencodeGoProtocolOverrides: Object.fromEntries(Object.entries(config.opencodeGoProtocolOverrides || {})
      .filter(([id, protocol]) => id.trim() && ['chat', 'messages', 'responses', 'google'].includes(protocol)).slice(0, 200)),
    opencodeGoModelMaxTokens: normalizeGoModelTokenLimits(config.opencodeGoModelMaxTokens),
    opencodeGoRequestTimeoutMs: Math.min(3600000, Math.max(5000, normalizeOptionalNumber(config.opencodeGoRequestTimeoutMs, 120000))),
    contextCompactionEnabled,
    contextCompactionThreshold,
    systemInstruction,
    agentModelProfiles: normalizeModelProfiles(config.agentModelProfiles)
  };
}

function normalizeOpengoModels(models) {
  if (!Array.isArray(models)) return [];
  const out = [];
  const seen = new Set();
  for (const raw of models) {
    if (!raw) continue;
    const id = typeof raw === 'string' ? raw.trim() : String(raw.id || '').trim();
    if (!id || seen.has(id.toLowerCase())) continue;
    seen.add(id.toLowerCase());
    if (typeof raw === 'string') {
      out.push({ id, label: id, contextLimit: null, maxTokens: null });
      continue;
    }
    out.push({
      id,
      label: String(raw.label || id),
      contextLimit: raw.contextLimit === null || raw.contextLimit === undefined || raw.contextLimit === ''
        ? null
        : (Number(raw.contextLimit) || null),
      maxTokens: raw.maxTokens === null || raw.maxTokens === undefined || raw.maxTokens === ''
        ? null
        : (Number(raw.maxTokens) || null)
    });
  }
  return out.slice(0, 100);
}

function normalizeModelProfiles(profiles = {}) {
  const normalized = {};
  for (const [profileName, defaults] of Object.entries(defaultConfig.agentModelProfiles)) {
    const profile = profiles?.[profileName] || {};
    normalized[profileName] = {
      ...defaults,
      ...profile,
      model: typeof profile.model === 'string' ? profile.model.trim() : (profile.model || ''),
      contextLimit: normalizeOptionalNumber(profile.contextLimit, defaults.contextLimit),
      maxTokens: normalizeOptionalNumber(profile.maxTokens, defaults.maxTokens),
      temperature: normalizeOptionalNumber(profile.temperature, defaults.temperature)
    };
  }
  return normalized;
}

function normalizeOptionalNumber(value, fallback) {
  if (value === '' || value === undefined || value === null) {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function looksCorruptedText(value) {
  if (!value || typeof value !== 'string') return false;
  return value.includes('\uFFFD') || /\?[가-힣]/.test(value) || /[가-힣]\?/.test(value);
}
