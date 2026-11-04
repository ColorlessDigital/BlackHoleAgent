import { emitLog } from '../common/eventBus.js';

// OpenGo / generic OpenAI-compatible model provider.
//
// Any gateway that speaks `POST {baseUrl}/v1/chat/completions` (OpenAI,
// Ollama, vLLM, llama-server, corporate proxies) works here. Model ids in
// BlackHole are prefixed: `opengo:<model-id>` (legacy alias `openai-compat:`).
// Chat interface mirrors LlamaCppRuntime.chatStream so llmRouter can use
// either runtime interchangeably. Returns server-reported token usage when
// available (nulls otherwise; llmRouter falls back to estimation).

const DEFAULT_TIMEOUT_MS = 120000;

// Provider presets: pick one and only an API key is needed (baseUrl fills
// itself; models are auto-discovered by the connection test). `custom` keeps
// the previous manual baseUrl flow.
export const OPENGO_PRESETS = [
  { id: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', needsKey: true },
  { id: 'ollama', label: 'Ollama (local)', baseUrl: 'http://127.0.0.1:11434', needsKey: false },
  { id: 'vllm', label: 'vLLM (local)', baseUrl: 'http://127.0.0.1:8000/v1', needsKey: false },
  { id: 'llama-server', label: 'llama-server (local)', baseUrl: 'http://127.0.0.1:8080', needsKey: false },
  { id: 'custom', label: '직접 입력', baseUrl: '', needsKey: true }
];

export function getOpengoPreset(presetId) {
  return OPENGO_PRESETS.find((p) => p.id === presetId) || OPENGO_PRESETS[OPENGO_PRESETS.length - 1];
}

// Effective endpoint: explicit baseUrl wins, otherwise the preset default.
export function resolveOpengoBaseUrl(config = {}) {
  const explicit = String(config.opengoBaseUrl || '').trim().replace(/\/+$/, '');
  if (explicit) return explicit;
  return getOpengoPreset(config.opengoPreset).baseUrl;
}

export function resolveOpengoEndpoint(baseUrl, resource) {
  const url = new URL(baseUrl);
  const basePath = url.pathname.replace(/\/+$/, '');
  url.pathname = `${basePath.endsWith('/v1') ? basePath : `${basePath}/v1`}/${resource}`;
  return url.toString();
}

function stripPrefix(model = '') {
  return String(model || '').replace(/^(opengo|openai-compat):/, '');
}

export class OpenaiCompatRuntime {
  constructor(config = {}) {
    this.config = config;
    this.baseUrl = resolveOpengoBaseUrl(config);
    this.preset = getOpengoPreset(config.opengoPreset);
    this.apiKey = config.opengoApiKey || '';
    this.timeoutMs = Number(config.opengoRequestTimeoutMs) || DEFAULT_TIMEOUT_MS;
  }

  isConfigured() {
    return this.baseUrl.length > 0;
  }

  authHeaders() {
    return this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {};
  }

  describe() {
    return {
      runtime: 'opengo',
      baseUrl: this.baseUrl,
      preset: this.preset.id,
      presets: OPENGO_PRESETS,
      configured: this.isConfigured(),
      hasApiKey: Boolean(this.apiKey)
    };
  }

  async listModels() {
    if (!this.baseUrl) return [];
    try {
      const response = await fetch(resolveOpengoEndpoint(this.baseUrl, 'models'), {
        headers: { ...this.authHeaders() },
        signal: AbortSignal.timeout(10000)
      });
      if (!response.ok) return [];
      const data = await response.json();
      return (data.data || []).map((model) => ({
        id: `opengo:${model.id}`,
        name: model.id,
        runtime: 'opengo'
      }));
    } catch {
      return [];
    }
  }

  async testConnection() {
    if (!this.baseUrl) {
      return { ok: false, error: 'OpenGo 연결 주소가 없습니다. 프리셋을 선택하거나 baseUrl을 입력하세요.' };
    }
    if (this.preset.needsKey && !this.apiKey) {
      return { ok: false, error: `API 키가 필요합니다 (${this.preset.label}). 설정에 키를 붙여넣고 다시 시도하세요.` };
    }
    try {
      const started = Date.now();
      const response = await fetch(resolveOpengoEndpoint(this.baseUrl, 'models'), {
        headers: { ...this.authHeaders() },
        signal: AbortSignal.timeout(10000)
      });
      if (!response.ok) {
        const body = await response.text().catch(() => '');
        return { ok: false, error: `OpenGo 연결 실패: HTTP ${response.status} ${body.slice(0, 200)}` };
      }
      const data = await response.json();
      const models = (data.data || []).map((m) => m.id).filter(Boolean);
      return {
        ok: true,
        baseUrl: this.baseUrl,
        preset: this.preset.id,
        modelCount: models.length,
        models: models.slice(0, 50),
        suggestedModel: models.length > 0 ? `opengo:${models[0]}` : '',
        latencyMs: Date.now() - started
      };
    } catch (err) {
      return { ok: false, error: `OpenGo 연결 실패: ${err.message}` };
    }
  }

  async chatStream({ model, messages, maxTokens, temperature, signal, onReasoning }, onChunk) {
    signal?.throwIfAborted();
    if (!this.baseUrl) {
      throw new Error('OpenGo 공급자가 설정되지 않았습니다. 설정 → OpenGo 외부 모델에서 프리셋 선택 또는 baseUrl 입력 후 연결 테스트를 실행하세요.');
    }
    const modelName = stripPrefix(model) || String(this.config.opengoDefaultModel || '');
    if (!modelName) {
      throw new Error('OpenGo 모델이 지정되지 않았습니다. 모델 선택기에서 opengo: 모델을 선택하세요.');
    }
    const requestBody = {
      model: modelName,
      messages,
      stream: true,
      max_tokens: maxTokens,
      temperature,
      stream_options: { include_usage: true }
    };
    emitLog(`OpenGo chat: model=${modelName} via ${this.baseUrl}`, 'info');
    const timeoutSignal = AbortSignal.timeout(this.timeoutMs);
    const response = await fetch(resolveOpengoEndpoint(this.baseUrl, 'chat/completions'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...this.authHeaders() },
      signal: signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal,
      body: JSON.stringify(requestBody)
    });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`OpenGo 호출 실패: HTTP ${response.status} ${body.slice(0, 300)}`);
    }
    if (!response.body) throw new Error('OpenGo response did not include a stream body.');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let usage = null;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const payload = line.slice(6).trim();
        if (!payload || payload === '[DONE]') continue;
        try {
          const data = JSON.parse(payload);
          if (data.usage) {
            usage = {
              promptTokens: Number(data.usage.prompt_tokens) || null,
              completionTokens: Number(data.usage.completion_tokens) || null
            };
          }
          const delta = data.choices?.[0]?.delta || {};
          const reasoning = delta.reasoning_content || delta.reasoning;
          if (typeof reasoning === 'string' && reasoning) onReasoning?.(reasoning);
          if (typeof delta.content === 'string' && delta.content) onChunk(delta.content);
        } catch {
          // Ignore partial frames.
        }
      }
    }
    return { usage };
  }
}
