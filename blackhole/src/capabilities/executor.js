import { RiskLevel } from '../security/riskLevels.js';
import { evaluateCapability } from '../security/policyEngine.js';
import { requestApproval } from '../security/approvalGate.js';
import { writeAudit } from '../security/auditLog.js';
import { loadConfig } from '../config/configStore.js';
import { ToolRegistry } from '../agent/core/toolRegistry.js';

export class CapabilityExecutor {
  constructor({ getConfig = loadConfig } = {}) {
    this.getConfig = getConfig;
  }

  async execute(capability, params = {}, options = {}) {
    options.abortSignal?.throwIfAborted();
    const config = this.getConfig();
    const tool = ToolRegistry.getTool(capability);
    if (!tool) {
      return {
        ok: false,
        params,
        error: `Unsupported capability: ${capability}`,
        validation: { ok: false, errors: [`Tool "${capability}" is not registered.`] }
      };
    }

    const validation = ToolRegistry.validateParams(tool, params);
    if (!validation.ok) {
      writeAudit({ phase: 'validation_failed', capability, params, validation });
      return {
        ok: false,
        params: validation.params,
        validation,
        error: `Invalid parameters for ${capability}: ${validation.errors.join('; ')}`
      };
    }

    const normalizedParams = validation.params;
    const action = {
      id: `action-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      actor: options.actor || 'ai',
      capability,
      params: normalizedParams
    };
    let policy = evaluateCapability(action, config);

    writeAudit({ phase: 'policy', action, policy });

    // P0-2: with strictBlocking:true, BLOCKED is a hard deny (no approval path).
    if (policy.level === RiskLevel.BLOCKED) {
      if (config.strictBlocking === true) {
        writeAudit({ phase: 'blocked', action, policy });
        return {
          ok: false,
          blocked: true,
          policy,
          params: normalizedParams,
          error: `Blocked by security policy and strict blocking is enabled: ${policy.reason || capability}`
        };
      }
      policy = {
        ...policy,
        level: RiskLevel.WARNING,
        requiresApproval: true,
        reason: [policy.reason, 'Hard blocking is disabled; requesting user approval instead.'].filter(Boolean).join(' ')
      };
      writeAudit({ phase: 'approval_redirect', action, policy });
    }

    if (policy.level === RiskLevel.WARNING) {
      const approved = await requestApproval(action, policy, { abortSignal: options.abortSignal });
      if (!approved) {
        writeAudit({ phase: 'rejected', action, policy });
        return { ok: false, rejected: true, policy, error: 'The requested tool action was rejected.' };
      }
    }

    let result;
    try {
      options.abortSignal?.throwIfAborted();
      await options.onBeforeExecute?.({ capability, params: normalizedParams });
      result = await this.runCapability(capability, normalizedParams, options, tool);
    } catch (err) {
      writeAudit({ phase: 'failed', action, policy, error: err.message });
      return { ok: false, policy, params: normalizedParams, error: err.message };
    }

    writeAudit({ phase: result?.ok === false ? 'failed' : 'executed', action, policy, result: summarizeResult(result) });

    if (result?.ok === false) {
      return { ok: false, policy, result, params: normalizedParams,
        error: result.error || result.message || `Tool ${capability} reported a failure.` };
    }

    if (capability === 'start_llama_cpp' && !result) {
      return { ok: false, policy, error: 'Failed to start the llama.cpp server. Check the model path and runtime path.' };
    }

    if (capability === 'run_command' && result?.code !== 0) {
      return {
        ok: false,
        policy,
        result,
        params: normalizedParams,
        error: result?.aborted ? 'Command stopped by user.' : `Command exited with code ${result?.code ?? 'unknown'}.`
      };
    }

    return { ok: true, policy, result, params: normalizedParams };
  }

  async runCapability(capability, params, options, resolvedTool = null) {
    options.abortSignal?.throwIfAborted();
    const config = this.getConfig();
    const tool = resolvedTool || ToolRegistry.getTool(capability);
    if (tool) {
      return tool.execute(params, {
        config,
        onOutput: options.onOutput,
        contextEngine: options.contextEngine,
        memoryStore: options.memoryStore,
        abortSignal: options.abortSignal
      });
    }
    throw new Error(`Unsupported capability: ${capability}`);
  }
}

function summarizeResult(result) {
  if (typeof result === 'string') return result.slice(0, 500);
  if (!result || typeof result !== 'object') return result;
  return {
    ...result,
    content: result.content ? `[content ${result.content.length} chars]` : undefined,
    output: result.output ? `[output ${result.output.length} chars]` : undefined
  };
}
