import { createRuntimeForModel } from '../runtime/runtimeRouter.js';
import { recordUsage } from '../runtime/usageTracker.js';
import { estimateConversationTokens, estimateTextTokens, applySlidingContextGuard } from './contextGuard.js';
import { resolveModelRoute } from './modelRouting.js';
import { createReasoningStream } from '../runtime/reasoningStream.js';

// Single funnel for every model call (agent, collaborator, autocomplete,
// compaction). Records per-model token usage (server-reported when the
// runtime returns it, estimated otherwise) tagged by caller via
// options.usageTag. Returns the resolved route with `route.usage` attached
// (shape-compatible with previous callers).
export async function callLocalModel(config, systemPrompt, conversation, onChunk, options = {}) {
  options.abortSignal?.throwIfAborted();
  const route = resolveModelRoute(config, options);
  const toolDeclarations = String(route.model).startsWith('opencode-go:') && options.tools?.length ? JSON.stringify(options.tools) : '';
  const guarded = applySlidingContextGuard(conversation, systemPrompt + toolDeclarations, route.contextLimit, { userGoal: options.userGoal });
  if (guarded.limitExceeded) {
    const error = new Error(`Context budget exceeded: system instructions and user request need ${guarded.estimatedTokens} estimated tokens; configured context is ${route.contextLimit}. No model request was sent.`);
    error.code = 'context_budget_exceeded';
    throw error;
  }
  conversation = guarded.messages;
  const runtime = createRuntimeForModel(route.model, {
    ...config,
    activeModel: route.model
  });
  const messages = [{ role: 'system', content: systemPrompt }, ...conversation];
  const startedAt = Date.now();
  let completionChars = 0;
  const reasoning = createReasoningStream({ onContent: onChunk, onReasoning: options.onReasoning });
  const wrappedOnChunk = (chunk) => {
    if (typeof chunk === 'string') completionChars += chunk.length;
    reasoning.write(chunk);
  };
  const onReasoning = text => {
    if (typeof text !== 'string' || !text) return;
    completionChars += text.length;
    options.onReasoning?.(text);
  };
  let reported = null;
  let succeeded = false;
  try {
    const result = await runtime.chatStream(
      {
        model: route.model,
        messages,
        contextLimit: route.contextLimit,
        maxTokens: route.maxTokens,
        temperature: route.temperature,
        grammar: options.grammar,
        signal: options.abortSignal,
        sessionId: options.sessionId,
        onReasoning,
        onStatus: options.onStatus,
        allowIncomplete: options.allowIncomplete === true,
        tools: options.tools
      },
      wrappedOnChunk
    );
    reported = result?.usage || null;
    if (result?.goGoogleState) route.goGoogleState = result.goGoogleState;
    if (result?.goToolState) route.goToolState = result.goToolState;
    succeeded = true;
  } finally {
    reasoning.finish();
    const promptTokens = reported?.promptTokens ?? estimateConversationTokens(conversation, systemPrompt + toolDeclarations);
    const completionTokens = reported?.completionTokens ?? estimateTextTokens(completionCharsToText(completionChars));
    try {
      recordUsage({
        model: route.model,
        usageTag: options.usageTag || 'agent',
        promptTokens,
        completionTokens,
        estimated: !reported,
        failed: !succeeded
      });
    } catch {}
    route.usage = {
      promptTokens,
      completionTokens,
      estimated: !reported,
      latencyMs: Date.now() - startedAt
    };
  }
  return route;
}

function completionCharsToText(chars) {
  // Estimation helper: rebuild a same-length placeholder so the CJK/latin
  // heuristic in estimateTextTokens yields a comparable bucket.
  return 'x'.repeat(Math.max(0, Number(chars) || 0));
}

export { resolveModelRoute };
