import { randomUUID, createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createParser } from 'eventsource-parser';
import { emitLog } from '../common/eventBus.js';
import { GO_PROTOCOLS, GoModelCatalog, goModelCatalog } from './goModelCatalog.js';
import { googleContents, googleFunctionCalls } from './googleToolAdapter.js';
import { NativeGoToolStream, nativeGoHistory, normalizeGoToolDefinitions } from './nativeGoTools.js';

export const OPENCODE_GO_BASE_URL = 'https://opencode.ai/inference/go/v1';
export const OPENCODE_GO_PROTOCOLS = GO_PROTOCOLS;
const API_BASES = {
  chat: 'https://opencode.ai/inference/go/openai/v1',
  responses: 'https://opencode.ai/inference/go/openai/v1',
  messages: 'https://opencode.ai/inference/go/anthropic/v1',
  google: 'https://opencode.ai/inference/go/google/v1beta'
};

export function goModelId(value) {
  return String(value || '').trim().replace(/^opencode-go[:/]/i, '');
}

export function resolveGoProtocol(model, config = {}, catalog = goModelCatalog) {
  const id = goModelId(model);
  const override = config.opencodeGoProtocolOverrides?.[id];
  return OPENCODE_GO_PROTOCOLS.includes(override) ? override : (catalog.info(id)?.protocol || null);
}

export function getGoModels(config = {}, catalog = goModelCatalog) {
  const models = catalog.ids(config.opencodeGoModels?.length ? config.opencodeGoModels : undefined);
  const selected = [config.opencodeGoDefaultModel, String(config.activeModel || '').startsWith('opencode-go:') ? config.activeModel : ''];
  return [...new Set([...models, ...selected].map(raw => goModelId(typeof raw === 'string' ? raw : raw?.id)).filter(Boolean))]
    .map(id => ({ id: `opencode-go:${id}`, name: id, label: `OpenCode Go / ${id}`,
      runtime: 'opencode-go', provider: 'opencode-go', defaultProtocol: catalog.info(id)?.protocol || null,
      protocol: resolveGoProtocol(id, config, catalog), ...catalog.availability(id),
      contextLimit: catalog.info(id)?.contextLimit || null, maxTokens: catalog.info(id)?.maxTokens || null }));
}

function tokenCount(value) {
  return Number.isFinite(Number(value)) && value !== null && value !== undefined ? Number(value) : null;
}

const RETRYABLE_CODES = new Set(['server_error', 'internal_server_error', 'model_error',
  'overloaded_error', 'rate_limit_exceeded', 'stream_disconnected', 'empty_response', 'ECONNRESET',
  'ETIMEDOUT', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT']);
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

function requestBody(protocol, { model, messages, maxTokens, temperature, fixedSampling, tools, sessionId }) {
  const common = { model, stream: true };
  const sampling = fixedSampling ? {} : { temperature };
  if (protocol === 'google') {
    const system = messages.filter(m => m.role === 'system').map(m => ({ text: m.content }));
    return { contents: googleContents(messages, model, sessionId),
      ...(tools?.length ? { tools: [{ functionDeclarations: tools.map(tool => ({ name: tool.name,
        description: tool.description, parametersJsonSchema: tool.parameters })) }],
      toolConfig: { functionCallingConfig: { mode: 'AUTO' } } } : {}),
      ...(system.length ? { systemInstruction: { parts: system } } : {}),
    generationConfig: { maxOutputTokens: maxTokens, ...sampling } };
  }
  if (protocol === 'responses') {
    return { ...common, input: nativeGoHistory(messages, { protocol, model, sessionId }),
      ...(tools?.length ? { tools: tools.map(tool => ({ type: 'function', name: tool.name, description: tool.description, parameters: tool.parameters, strict: false })), tool_choice: 'auto' } : {}),
      max_output_tokens: maxTokens, store: false };
  }
  if (protocol === 'messages') {
    return { ...common,
      system: messages.filter(m => m.role === 'system').map(m => ({ type: 'text', text: m.content })),
      messages: nativeGoHistory(messages, { protocol, model, sessionId }),
      ...(tools?.length ? { tools: tools.map(tool => ({ name: tool.name, description: tool.description, input_schema: tool.parameters })), tool_choice: { type: 'auto' } } : {}),
      max_tokens: maxTokens, ...sampling };
  }
  return { ...common, messages: nativeGoHistory(messages, { protocol, model, sessionId }),
    ...(tools?.length ? { tools: tools.map(tool => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.parameters } })), tool_choice: 'auto' } : {}),
    max_tokens: maxTokens, ...sampling, stream_options: { include_usage: true } };
}

export class OpenCodeGoRuntime {
  constructor(config = {}, { baseUrl, retryDelayMs = 1000, catalog } = {}) {
    this.config = config;
    this.customBaseUrl = Boolean(baseUrl);
    this.baseUrl = (baseUrl || OPENCODE_GO_BASE_URL).replace(/\/+$/, '');
    this.catalog = catalog || (baseUrl ? new GoModelCatalog({ cacheFile: null }) : goModelCatalog);
    this.apiKey = String(config.opencodeGoApiKey || '').trim();
    this.timeoutMs = Math.max(5000, Number(config.opencodeGoRequestTimeoutMs) || 120000);
    this.retryDelayMs = retryDelayMs;
  }

  isConfigured() { return Boolean(this.apiKey && this.apiKey !== '********'); }

  describe() {
    return { runtime: 'opencode-go', baseUrl: this.baseUrl, enabled: this.config.opencodeGoEnabled === true,
      configured: this.isConfigured(), hasApiKey: this.isConfigured(), models: getGoModels(this.config, this.catalog),
      catalogStatus: this.catalog.status() };
  }

  safeError(error) {
    const message = String(error?.message || error || 'Unknown error');
    return this.apiKey ? message.split(this.apiKey).join('[redacted]') : message;
  }

  modelError(error, context) {
    if (error?.modelFailure) return error;
    const message = this.safeError(error).slice(0, 600);
    const code = this.safeError(context.code || error?.code || error?.cause?.code || 'provider_error').slice(0, 80);
    const requestId = context.requestId ? this.safeError(context.requestId).slice(0, 120) : '';
    const retryable = context.httpStatus ? RETRYABLE_STATUS.has(context.httpStatus) :
      RETRYABLE_CODES.has(code) ||
      (code === 'response_failed' && message === 'The model failed to generate a response.');
    const details = { provider: 'opencode-go', model: context.model, protocol: context.protocol,
      code, httpStatus: context.httpStatus || null, requestId: requestId || null,
      retryable, partialOutput: Boolean(context.partialOutput), retryAfterMs: context.retryAfterMs || 0,
      ...(context.outputTokenLimit ? { outputTokenLimit: context.outputTokenLimit } : {}),
      ...(context.requestTimeoutMs ? { requestTimeoutMs: context.requestTimeoutMs } : {}),
      ...(context.requestPhase ? { requestPhase: context.requestPhase } : {}),
      ...(context.toolCallValidationComplete ? { toolCallValidationComplete: true, toolCallsEmitted: false } : {}) };
    if ([400, 404].includes(details.httpStatus) && /unsupported model|model[^\n]{0,100}(?:not found|not supported|does not exist)/i.test(message)) {
      details.category = 'unsupported_model';
      this.catalog.observe(context.model, 'unsupported', message);
    }
    if (details.httpStatus === 410) {
      details.category = 'retired';
      this.catalog.observe(context.model, 'retired', message);
    }
    const result = new Error(`OpenCode Go / ${details.model} (${details.protocol}, ${code}${requestId ? `, request: ${requestId}` : ''}): ${message}`);
    result.modelFailure = details;
    return result;
  }

  timeoutError(context) {
    const error = this.modelError(`Request timed out after ${this.timeoutMs}ms. Resume from the checkpoint to retry; partial output was not replayed.`,
      { ...context, code: 'request_timeout', requestTimeoutMs: this.timeoutMs });
    error.name = 'TimeoutError';
    return error;
  }

  async listModels() {
    if (!this.customBaseUrl) {
      await this.catalog.refresh({ force: true });
      return getGoModels(this.config, this.catalog);
    }
    // This endpoint is public: success is discovery, NOT key authentication.
    const response = await fetch(`${this.baseUrl}/models`, { headers: { 'User-Agent': 'BlackHole/1.0.0' },
      signal: AbortSignal.timeout(10000), redirect: 'error' });
    if (!response.ok) throw new Error(`OpenCode Go model discovery HTTP ${response.status}`);
    const data = await response.json();
    if (!Array.isArray(data.data)) throw new Error('OpenCode Go returned an invalid model catalog');
    this.catalog.snapshot.ids = data.data.map(m => m?.id).filter(id => typeof id === 'string' && id.trim());
    return getGoModels(this.config, this.catalog);
  }

  async testConnection() {
    const startedAt = Date.now();
    const model = goModelId(this.config.opencodeGoDefaultModel);
    const known = resolveGoProtocol(model, this.config, this.catalog);
    const protocols = known ? [known] : OPENCODE_GO_PROTOCOLS;
    const signal = AbortSignal.timeout(this.timeoutMs);
    const sessionId = `connection-test-${randomUUID()}`;
    const attempts = [];
    let lastError;
    for (const protocol of protocols) {
      // Unknown models are verified against the four documented APIs, never
      // guessed by name. Wrong-adapter failures must not poison the real catalog.
      const candidate = known ? this : new OpenCodeGoRuntime({ ...this.config,
        opencodeGoProtocolOverrides: { ...this.config.opencodeGoProtocolOverrides, [model]: protocol } },
      { ...(this.customBaseUrl ? { baseUrl: this.baseUrl } : {}), catalog: new GoModelCatalog({ cacheFile: null }), retryDelayMs: this.retryDelayMs });
      try {
        let text = '';
        const result = await candidate.chatStream({ model, messages: [{ role: 'user', content: 'Reply with OK.' }],
          maxTokens: 64, temperature: 0, allowIncomplete: true, sessionId, signal }, chunk => { text += chunk; });
        if (!text.trim() && !result.usage) throw new Error('OpenCode Go completed without text or usage information.');
        if (!known) { this.catalog.observeProtocol(model, protocol); this.catalog.observe(model, 'available'); }
        return { ok: true, authenticated: !model.endsWith('-free'), model, protocol,
          latencyMs: Date.now() - startedAt, usage: result.usage, protocolAttempts: [...attempts, { protocol, ok: true }] };
      } catch (error) {
        lastError = error;
        attempts.push({ protocol, ok: false, error: this.safeError(error), httpStatus: error.modelFailure?.httpStatus || null });
        if (known || signal.aborted || !this.isConfigured() || error.modelFailure?.partialOutput || [401, 402, 429].includes(error.modelFailure?.httpStatus)) break;
      }
    }
    return { ok: false, authenticated: false, model, latencyMs: Date.now() - startedAt, error: this.safeError(lastError),
      modelFailure: lastError?.modelFailure || null, protocolAttempts: attempts };
  }

  async chatStream({ model, messages = [], maxTokens = 4096, temperature = 0.2, signal, sessionId, onReasoning, onStatus, allowIncomplete = false, tools }, onChunk) {
    signal?.throwIfAborted();
    if (!this.isConfigured()) throw new Error('OpenCode Go API key is missing. Open Settings > OpenCode Go.');
    const id = goModelId(model || this.config.opencodeGoDefaultModel);
    if (!id) throw new Error('Select an OpenCode Go model in Settings.');
    tools = normalizeGoToolDefinitions(tools);
    const protocol = resolveGoProtocol(id, this.config, this.catalog);
    if (!protocol) throw new Error(`Select the API type for OpenCode Go model "${id}" in Settings.`);
    const resource = protocol === 'chat' ? 'chat/completions' : protocol === 'google'
      ? `models/${encodeURIComponent(id)}:streamGenerateContent?alt=sse` : protocol;
    const url = `${this.customBaseUrl ? this.baseUrl : API_BASES[protocol]}/${resource}`;
    const deadlineAt = performance.now() + this.timeoutMs;
    const requestSignal = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(this.timeoutMs)]);
    // Hash only the explicit conversation ID, not prompt content. This also
    // keeps arbitrary user/session strings valid as HTTP header values.
    const conversationId = createHash('sha256').update(String(sessionId || randomUUID())).digest('hex');
    const headers = { 'Content-Type': 'application/json', Accept: 'text/event-stream',
      Authorization: `Bearer ${this.apiKey}`, 'User-Agent': 'BlackHole/1.0.0', 'x-opencode-session': conversationId };
    if (protocol === 'messages') {
      headers['x-api-key'] = this.apiKey;
      headers['anthropic-version'] = '2023-06-01';
    }
    const finishTimeout = (error, attempt) => {
      const timeout = error?.modelFailure?.code === 'request_timeout' ? error
        : this.timeoutError({ model: id, protocol, ...error?.modelFailure });
      timeout.modelFailure.attempts = attempt;
      this.catalog.observe(id, 'temporary_error', this.safeError(timeout));
      emitLog(timeout.message, 'error', timeout.modelFailure);
      return timeout;
    };
    // Only an inference request is retried, never an agent turn or executed
    // tool. Both attempts share the original deadline and conversation ID.
    for (let attempt = 1; attempt <= 2; attempt++) {
      if (requestSignal.aborted) {
        if (signal?.aborted) throw signal.reason;
        throw finishTimeout(null, attempt - 1);
      }
      try {
        const result = await this.streamAttempt({ id, protocol, url, requestSignal, headers,
          messages, maxTokens, temperature, onReasoning, allowIncomplete, tools, sessionId: conversationId, callerSignal: signal }, onChunk);
        this.catalog.observe(id, 'available');
        return result;
      } catch (error) {
        if (signal?.aborted) throw signal.reason;
        if (requestSignal.aborted) throw finishTimeout(error, attempt);
        const failure = error.modelFailure;
        if (failure) failure.attempts = attempt;
        const willRetry = attempt < 2 && failure?.retryable && !failure.partialOutput;
        emitLog(error.message, willRetry ? 'warning' : 'error', failure || {});
        if (!willRetry) {
          if (failure && !['unsupported_model', 'retired'].includes(failure.category)) {
            this.catalog.observe(id, failure.retryable ? 'temporary_error' : 'request_failed', this.safeError(error));
          }
          throw error;
        }
        const retryDelayMs = Math.max(this.retryDelayMs, failure.retryAfterMs);
        const remainingMs = Math.max(0, deadlineAt - performance.now());
        if (retryDelayMs >= remainingMs) {
          Object.assign(failure, { retryDeferred: true, requestPhase: 'retry_delay', requestTimeoutMs: this.timeoutMs });
          const status = `OpenCode Go / ${id}: retry deferred for ${Math.ceil(retryDelayMs / 1000)}s; the backoff exceeds the remaining request time. No automatic retry was sent.`;
          this.catalog.observe(id, 'temporary_error', this.safeError(error));
          emitLog(status, 'warning', failure);
          onStatus?.({ status, level: 'warning', modelFailure: { ...failure }, retryDeferred: true });
          signal?.throwIfAborted();
          throw error;
        }
        const status = `OpenCode Go / ${id}: temporary model failure (${failure.code}). Retrying once in ${retryDelayMs / 1000}s...`;
        emitLog(status, 'warning', failure);
        onStatus?.({ status, level: 'warning', modelFailure: { ...failure }, retryAttempt: attempt + 1 });
        try {
          await delay(retryDelayMs, undefined, { signal: requestSignal });
        } catch (error) {
          if (signal?.aborted) throw signal.reason;
          if (requestSignal.aborted) throw finishTimeout({ modelFailure: { ...failure, requestPhase: 'retry_delay' } }, attempt);
          throw error;
        }
      }
    }
  }

  async streamAttempt({ id, protocol, url, requestSignal, headers, messages, maxTokens,
    temperature, onReasoning, allowIncomplete, tools, sessionId, callerSignal }, onChunk) {
    emitLog(`[OpenCode Go] ${id} via ${protocol}`, 'info');
    let reader;
    const context = { model: id, protocol, partialOutput: false, requestPhase: 'response_headers' };
    const outputLimitError = reason => this.modelError(
      `OpenCode Go output token limit reached before completion (${reason}; limit ${maxTokens}). Increase this model's output limit and resume from the checkpoint.`,
      { ...context, code: 'output_token_limit', outputTokenLimit: maxTokens });
    const output = (text, callback) => {
      if (!text) return;
      context.partialOutput = true;
      callback?.(text);
    };
    try {
      const response = await fetch(url, { method: 'POST', headers,
        body: JSON.stringify(requestBody(protocol, { model: id, messages, maxTokens, temperature,
          fixedSampling: this.catalog.info(id)?.temperature === false, tools, sessionId })),
        signal: requestSignal, redirect: 'error' });
      context.requestPhase = 'response_stream';
      context.requestId = response.headers.get('x-request-id') || response.headers.get('request-id');
      const retryAfter = response.headers.get('retry-after');
      if (retryAfter) {
        const seconds = Number(retryAfter);
        const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retryAfter) - Date.now();
        context.retryAfterMs = Number.isFinite(ms) ? Math.max(0, ms) : 0;
      }
      if (!response.ok) {
        const detail = (await response.text()).slice(0, 600);
        let parsed;
        try { parsed = JSON.parse(detail); } catch {}
        throw this.modelError(`HTTP ${response.status}: ${parsed?.error?.message || detail}`,
          { ...context, httpStatus: response.status, code: parsed?.error?.code || `http_${response.status}` });
      }
      if (!response.body || !response.headers.get('content-type')?.includes('text/event-stream')) {
        throw new Error('OpenCode Go returned a non-streaming response');
      }
      reader = response.body.getReader();
      const decoder = new TextDecoder();
      let complete = false;
      let terminal = false;
      let usage = null;
      const googleParts = [];
      const nativeTools = new NativeGoToolStream();
      let nativeText = '';
      const answer = text => { if (text) nativeText += text; output(text, onChunk); };
      const parser = createParser({ maxBufferSize: 1024 * 1024, onEvent: event => {
        if (terminal) return;
        requestSignal.throwIfAborted();
        if (event.data === '[DONE]') { if (protocol === 'chat') complete = terminal = true; return; }
        let data;
        try { data = JSON.parse(event.data); }
        catch { throw new Error('OpenCode Go returned an invalid stream event'); }
        const type = data.type || event.event;
        if (data.error || type === 'error' || type === 'response.failed') {
          const failure = data.error || data.response?.error;
          throw this.modelError(failure?.message || data.message || 'OpenCode Go stream failed',
            { ...context, ...(protocol === 'google' && Number.isInteger(failure?.code) ? { httpStatus: failure.code } : {}),
              code: failure?.status || failure?.code || failure?.type || (type === 'response.failed' ? 'response_failed' : 'stream_error') });
        }
        if (nativeTools.collect(protocol, data, type)) context.partialOutput = true;
        if (protocol === 'chat') {
          const choice = data.choices?.[0];
          const delta = choice?.delta;
          answer(delta?.content);
          output(delta?.reasoning_content || delta?.reasoning, onReasoning);
          if (choice?.finish_reason === 'length' && !allowIncomplete) throw outputLimitError('length');
          if (choice?.finish_reason) complete = true;
          if (data.usage) usage = { promptTokens: tokenCount(data.usage.prompt_tokens), completionTokens: tokenCount(data.usage.completion_tokens) };
        } else if (protocol === 'messages') {
          if (type === 'message_start' && data.message?.usage) {
            const u = data.message.usage;
            usage = { promptTokens: (tokenCount(u.input_tokens) ?? 0) + (tokenCount(u.cache_read_input_tokens) ?? 0) +
              (tokenCount(u.cache_creation_input_tokens) ?? 0), completionTokens: tokenCount(u.output_tokens) };
          }
          if (type === 'content_block_start' && data.content_block?.type === 'text') answer(data.content_block.text);
          if (type === 'content_block_delta') {
            if (data.delta?.type === 'text_delta') answer(data.delta.text);
            if (data.delta?.type === 'thinking_delta') output(data.delta.thinking, onReasoning);
          }
          if (type === 'message_delta' && data.delta?.stop_reason === 'max_tokens' && !allowIncomplete) throw outputLimitError('max_tokens');
          if (type === 'message_delta' && data.usage) usage = { ...usage, completionTokens: tokenCount(data.usage.output_tokens) };
          if (type === 'message_stop') complete = terminal = true;
        } else if (protocol === 'google') {
          const candidate = data.candidates?.[0];
          for (const part of candidate?.content?.parts || []) {
            googleParts.push(part);
            if (part.functionCall) context.partialOutput = true;
            if (part.thought) output(part.text, onReasoning);
            else answer(part.text);
          }
          const u = data.usageMetadata;
          if (u) usage = { promptTokens: tokenCount(u.promptTokenCount),
            completionTokens: (tokenCount(u.candidatesTokenCount) ?? 0) + (tokenCount(u.thoughtsTokenCount) ?? 0) };
          if (candidate?.finishReason) {
            if (candidate.finishReason !== 'STOP' && !(allowIncomplete && candidate.finishReason === 'MAX_TOKENS')) {
              if (candidate.finishReason === 'MAX_TOKENS') throw outputLimitError('MAX_TOKENS');
              if (candidate.finishReason === 'MALFORMED_FUNCTION_CALL') context.toolCallValidationComplete = true;
              throw this.modelError(`OpenCode Go response incomplete: ${candidate.finishReason}`,
                { ...context, code: candidate.finishReason === 'MALFORMED_FUNCTION_CALL' ? 'malformed_tool_call' : 'response_incomplete' });
            }
            complete = terminal = true;
          }
        } else {
          if (type === 'response.output_text.delta') answer(data.delta);
          if (type === 'response.reasoning_summary_text.delta' || type === 'response.reasoning_text.delta') output(data.delta, onReasoning);
          if (type === 'response.incomplete' && !(allowIncomplete && data.response?.incomplete_details?.reason === 'max_output_tokens')) {
            if (data.response?.incomplete_details?.reason === 'max_output_tokens') throw outputLimitError('max_output_tokens');
            throw new Error(`OpenCode Go response incomplete: ${data.response?.incomplete_details?.reason || 'unknown'}`);
          }
          if (type === 'response.completed' || (type === 'response.incomplete' && allowIncomplete)) {
            complete = terminal = true;
            const u = data.response?.usage;
            if (u) usage = { promptTokens: tokenCount(u.input_tokens), completionTokens: tokenCount(u.output_tokens) };
          }
        }
      } });
      while (true) {
        requestSignal.throwIfAborted();
        const { done, value } = await reader.read();
        if (done) break;
        parser.feed(decoder.decode(value, { stream: true }));
        if (terminal) break;
      }
      parser.feed(decoder.decode());
      parser.reset({ consume: true });
      requestSignal.throwIfAborted();
      if (!complete) throw this.modelError('OpenCode Go stream disconnected before completion. Retry the request.',
        { ...context, code: 'stream_disconnected' });
      const requireOutput = calls => {
        if (!allowIncomplete && !nativeText.trim() && !calls.length) {
          throw this.modelError('Model completed without an answer or a tool call.', { ...context, code: 'empty_response' });
        }
      };
      if (protocol === 'google') {
        let calls;
        try { calls = googleFunctionCalls(googleParts, tools); }
        catch (error) { error.code = 'malformed_tool_call'; context.toolCallValidationComplete = true; throw error; }
        requireOutput(calls);
        if (calls.length) output(`\n${JSON.stringify({ tool_calls: calls })}`, onChunk);
        return { usage, ...(googleParts.length ? { goGoogleState: { model: id, sessionId, parts: googleParts } } : {}) };
      }
      let calls;
      try { calls = nativeTools.finish(tools); }
      catch (error) { context.toolCallValidationComplete = true; throw error; }
      requireOutput(calls);
      if (calls.length) output(`\n${JSON.stringify({ tool_calls: calls.map(call => ({ tool: call.name, params: call.params })) })}`, onChunk);
      return { usage, ...(calls.length ? { goToolState: { protocol, model: id, sessionId, calls, text: nativeText } } : {}) };
    } catch (error) {
      if (callerSignal?.aborted) throw callerSignal.reason;
      if (requestSignal.aborted) throw this.timeoutError(context);
      throw this.modelError(error, context);
    } finally {
      if (reader) {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
    }
  }
}
