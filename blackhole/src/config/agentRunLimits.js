export const DEFAULT_AGENT_RUN_LIMITS = Object.freeze({ agentMaxSteps: 24, selfHealingMaxCycles: 4 });

export function normalizeAgentRunLimits(config = {}, { strict = false, partial = false } = {}) {
  const limits = {};
  for (const [name, fallback] of Object.entries(DEFAULT_AGENT_RUN_LIMITS)) {
    if (partial && !Object.hasOwn(config, name)) continue;
    const value = config[name];
    const parsed = (typeof value === 'number' || (typeof value === 'string' && value.trim())) ? Number(value) : NaN;
    const minimum = name === 'agentMaxSteps' ? 1 : 0;
    const valid = Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= 1000;
    if (!valid && strict) throw new Error(`${name} must be an integer between ${minimum} and 1000.`);
    limits[name] = valid ? parsed : fallback;
  }
  return limits;
}
