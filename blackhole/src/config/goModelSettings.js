function tokenLimit(value) {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function modelId(value) {
  return String(value).trim().replace(/^opencode-go[:/]/i, '');
}

export function normalizeGoModelTokenLimits(value = {}, { strict = false } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    if (strict) throw new Error('Go model output limits must be an object.');
    return {};
  }
  const entries = Object.entries(value);
  if (strict && entries.length > 200) throw new Error('Too many Go model output limits (maximum 200 models).');
  const limits = [];
  for (const [rawId, rawLimit] of entries.slice(0, 200)) {
    const id = modelId(rawId);
    const limit = tokenLimit(rawLimit);
    if (!id || id.length > 200 || limit === null) {
      if (strict) throw new Error('Each Go model output limit must have a model ID and a positive safe integer.');
      continue;
    }
    limits.push([id, limit]);
  }
  return Object.fromEntries(limits);
}

export function getGoModelTokenLimit(config, model) {
  if (!/^opencode-go[:/]/i.test(String(model))) return null;
  const limits = config.opencodeGoModelMaxTokens;
  const id = modelId(model);
  return limits && Object.hasOwn(limits, id) ? tokenLimit(limits[id]) : null;
}
