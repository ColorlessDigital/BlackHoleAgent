import { createParser } from 'eventsource-parser';

// Shared transport for llama.cpp and generic Chat Completions providers.
// A socket close is not a completion marker; partial actions are never replayed.
export async function streamChatCompletion({ url, headers, body, timeoutMs, signal, provider,
  model, onReasoning, allowIncomplete = false }, onChunk) {
  signal?.throwIfAborted();
  const requestSignal = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(timeoutMs)]);
  const context = { provider, model, protocol: 'chat', partialOutput: false, requestId: null,
    requestPhase: 'response_headers', httpStatus: null, retryable: false };
  const failure = (message, code, details = {}) => {
    const error = new Error(`${provider} / ${model}: ${message}`);
    error.modelFailure = { ...context, code, ...details };
    return error;
  };
  let reader;
  try {
    const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: requestSignal });
    context.requestId = response.headers.get('x-request-id') || response.headers.get('request-id');
    context.requestPhase = 'response_stream';
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 600);
      throw failure(`HTTP ${response.status}: ${detail}`, `http_${response.status}`, { httpStatus: response.status });
    }
    if (!response.body) throw failure('Response did not include a stream body.', 'invalid_stream_response');
    reader = response.body.getReader();
    if (!response.headers.get('content-type')?.toLowerCase().includes('text/event-stream')) {
      throw failure('Provider returned a non-streaming response.', 'invalid_stream_response');
    }
    let terminal = false;
    let complete = false;
    let hasAnswer = false;
    let usage = null;
    const count = value => value !== null && value !== undefined && Number.isFinite(Number(value)) ? Number(value) : null;
    const output = (text, callback) => {
      if (typeof text !== 'string' || !text) return;
      context.partialOutput = true;
      callback?.(text);
    };
    const parser = createParser({ maxBufferSize: 1024 * 1024, onEvent(event) {
      if (terminal) return;
      requestSignal.throwIfAborted();
      if (event.data.trim() === '[DONE]') { complete = terminal = true; return; }
      let data;
      try { data = JSON.parse(event.data); }
      catch { throw failure('Provider returned an invalid stream event.', 'invalid_stream_event'); }
      if (!data || typeof data !== 'object' || Array.isArray(data)) {
        throw failure('Provider returned an invalid stream event.', 'invalid_stream_event');
      }
      if (data.error || event.event === 'error') {
        throw failure(data.error?.message || data.message || 'Provider stream failed.',
          String(data.error?.code || data.error?.type || 'stream_error').slice(0, 80));
      }
      const choice = data.choices?.[0];
      const delta = choice?.delta || {};
      if (typeof delta.content === 'string' && delta.content.trim()) hasAnswer = true;
      output(delta.content, onChunk);
      output(delta.reasoning_content || delta.reasoning, onReasoning);
      if (choice?.finish_reason === 'length' && !allowIncomplete) {
        throw failure(`Output token limit reached before completion (limit ${body.max_tokens}). Adjust the output limit and resume from the checkpoint.`,
          'output_token_limit', { outputTokenLimit: body.max_tokens });
      }
      if (choice?.finish_reason) complete = true;
      if (data.usage) usage = { promptTokens: count(data.usage.prompt_tokens), completionTokens: count(data.usage.completion_tokens) };
    } });
    const decoder = new TextDecoder();
    while (!terminal) {
      requestSignal.throwIfAborted();
      const { done, value } = await reader.read();
      requestSignal.throwIfAborted();
      if (done) break;
      parser.feed(decoder.decode(value, { stream: true }));
    }
    if (!terminal) {
      parser.feed(decoder.decode());
      parser.reset({ consume: true });
    }
    requestSignal.throwIfAborted();
    if (!complete) throw failure('Stream disconnected before completion. Resume from the checkpoint.', 'stream_disconnected');
    if (!hasAnswer && !allowIncomplete) throw failure('Model completed without an answer.', 'empty_response');
    return { usage };
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    if (requestSignal.aborted) {
      const timeout = failure(`Request timed out after ${timeoutMs}ms. Partial output was not replayed.`, 'request_timeout', { requestTimeoutMs: timeoutMs });
      timeout.name = 'TimeoutError';
      throw timeout;
    }
    if (error.modelFailure) throw error;
    throw failure(error.message, error.code || error.cause?.code || 'provider_error');
  } finally {
    if (reader) {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
}
