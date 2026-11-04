import { getGoModelTokenLimit } from '../config/goModelSettings.js';

const DEFAULT_PROFILE = {
  model: null,
  contextLimit: null,
  maxTokens: null,
  temperature: null
};

const PHASE_TO_PROFILE = {
  plan: 'planner',
  act: 'coder',
  observe: 'summarizer',
  verify: 'verifier',
  repair: 'coder',
  summarize: 'summarizer',
  general: 'general'
};

export function resolveModelRoute(config = {}, { phase = 'general', task = '', estimatedTokens = 0, maxTokens: requestMaxTokens } = {}) {
  const normalizedPhase = String(phase || 'general').toLowerCase();
  const routeName = PHASE_TO_PROFILE[normalizedPhase] || 'general';
  const routingEnabled = config.agentModelRoutingEnabled !== false;
  const profiles = config.agentModelProfiles || {};
  const baseModel = config.activeModel || 'llamacpp:local-gguf';
  const baseRoute = {
    profile: 'general',
    phase: normalizedPhase,
    model: baseModel,
    runtime: config.localRuntime || 'llamacpp',
    contextLimit: Number(config.contextLimit) || 8192,
    maxTokens: Number(config.maxTokens) || 4096,
    temperature: Number(config.temperature) || 0.2,
    reason: 'base activeModel route'
  };

  if (!routingEnabled) {
    return {
      ...baseRoute,
      maxTokens: outputTokenLimit(config, baseModel, baseRoute.maxTokens, requestMaxTokens),
      reason: 'model routing disabled'
    };
  }

  const profile = {
    ...DEFAULT_PROFILE,
    ...(profiles.general || {}),
    ...(profiles[routeName] || {})
  };

  const longContextRequested = Number(estimatedTokens) > Number(config.contextLimit || 8192) * 0.75;
  // P1-4: empty profile model explicitly inherits activeModel (no silent second runtime).
  const inherited = !profile.model;
  const model = profile.model || baseModel;
  return {
    ...baseRoute,
    profile: routeName,
    model,
    inherited,
    contextLimit: numberOrFallback(profile.contextLimit, baseRoute.contextLimit),
    maxTokens: outputTokenLimit(config, model, numberOrFallback(profile.maxTokens, baseRoute.maxTokens), requestMaxTokens),
    temperature: numberOrFallback(profile.temperature, baseRoute.temperature),
    reason: [
      `phase:${normalizedPhase}`,
      task ? `task:${String(task).slice(0, 80)}` : '',
      inherited ? `inherit:${baseModel}` : `override:${model}`,
      longContextRequested ? 'long-context-warning' : ''
    ].filter(Boolean).join('; ')
  };
}

export function formatModelRouteForPrompt(route = {}) {
  if (!route.model) return '';
  return `[Model Route]\nProfile: ${route.profile || 'general'}\nModel: ${route.model}\nTemperature: ${route.temperature}\nMax tokens: ${route.maxTokens}\nReason: ${route.reason || 'not specified'}`;
}

function numberOrFallback(value, fallback) {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function outputTokenLimit(config, model, inherited, requested) {
  const configured = getGoModelTokenLimit(config, model) ?? inherited;
  const limit = Number(requested);
  return Number.isSafeInteger(limit) && limit > 0 ? Math.min(configured, limit) : configured;
}
