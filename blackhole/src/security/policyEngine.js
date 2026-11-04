import { RiskLevel, maxRisk } from './riskLevels.js';
import { evaluatePathPolicy } from './pathPolicy.js';
import { evaluateCommandPolicy } from './commandPolicy.js';
import { loadMcpConfig, parseMcpToolName, resolveMcpPermission } from '../mcp/mcpConfig.js';

const MUTATING_CAPABILITIES = new Set([
  'write_file',
  'patch_file',
  'patch_lines',
  'apply_patch_transaction',
  'run_command',
  'register_gguf',
  'start_llama_cpp',
  'stop_runtime'
]);

const PATH_CAPABILITIES = new Set([
  'list_dir',
  'read_file',
  'write_file',
  'patch_file',
  'patch_lines'
]);

const WEB_CAPABILITIES = new Set([
  'web_search',
  'fetch_url',
  'inspect_url',
  'render_page',
  'crawl_site',
  'monitor_target'
]);

export function evaluateCapability(action, config = {}) {
  // P0-2: default to operator (mutating tools need approval). strictBlocking
  // disables the legacy BLOCKED->WARNING and WARNING->SAFE demotions.
  const mode = config.permissionMode || 'operator';
  const strictBlocking = config.strictBlocking === true;
  const isAutonomous = mode === 'autonomous' || mode === 'full';
  const capability = action.capability;
  let level = RiskLevel.SAFE;
  const reasons = [];
  let requiresApproval = false;

  if (PATH_CAPABILITIES.has(capability)) {
    const pathResult = evaluatePathPolicy(action.params?.path, config, capability);
    level = maxRisk(level, pathResult.level);
    if (pathResult.level === RiskLevel.BLOCKED) requiresApproval = true;
    if (pathResult.reason) reasons.push(pathResult.reason);
  }

  if (WEB_CAPABILITIES.has(capability)) {
    if (['render_page', 'crawl_site', 'monitor_target'].includes(capability)) {
      level = maxRisk(level, RiskLevel.WARNING);
      reasons.push(`Web tool may perform active page loading: ${capability}`);
    }

    if (capability === 'crawl_site' || capability === 'render_page') {
      const allowedStr = config.webAllowedDomains || '';
      const hasAllowedDomains = allowedStr.trim().length > 0;
      if (!hasAllowedDomains) {
        if (!isAutonomous && (config.webRequireAllowedDomainsForCrawl || config.webStrictScopeEnabled)) {
          level = maxRisk(level, RiskLevel.WARNING);
          requiresApproval = true;
          reasons.push('No allowed web domains are configured for this request.');
        } else {
          level = maxRisk(level, RiskLevel.WARNING);
          reasons.push('No allowed web domains are configured.');
        }
      }
    }

    if (mode === 'strict') {
      level = maxRisk(level, RiskLevel.WARNING);
      reasons.push('Strict mode requests confirmation for web tools.');
    }
  }

  if (capability === 'start_llama_cpp') {
    level = maxRisk(level, RiskLevel.WARNING);
    reasons.push('Starting llama.cpp can use sustained local CPU/GPU resources.');
    for (const targetPath of [action.params?.llamaCppServerPath, action.params?.llamaCppModelPath]) {
      if (!targetPath) continue;
      const pathResult = evaluatePathPolicy(targetPath, config, 'read_file');
      level = maxRisk(level, pathResult.level);
      if (pathResult.level === RiskLevel.BLOCKED) requiresApproval = true;
      if (pathResult.reason) reasons.push(pathResult.reason);
    }
  }

  if (capability === 'stop_runtime') {
    level = maxRisk(level, RiskLevel.WARNING);
    reasons.push('Stopping the local runtime will terminate the managed inference process.');
  }

  if (capability === 'run_command') {
    const commandResult = evaluateCommandPolicy(action.params?.command || action.params?.cmd);
    level = maxRisk(level, commandResult.level);
    if (commandResult.level === RiskLevel.BLOCKED) requiresApproval = true;
    if (commandResult.reason) reasons.push(commandResult.reason);
  }

  const mcpToolRef = parseMcpToolName(capability);
  if (mcpToolRef) {
    const mcpConfig = loadMcpConfig({ workspaceRoot: config.workspaceRoot, appConfig: config });
    const permission = resolveMcpPermission(mcpToolRef, mcpConfig);
    if (permission === 'block') {
      level = maxRisk(level, RiskLevel.WARNING);
      requiresApproval = true;
      reasons.push(`MCP tool requires explicit approval: ${mcpToolRef.serverName}/${mcpToolRef.toolName}.`);
    } else if (permission === 'ask') {
      level = maxRisk(level, RiskLevel.WARNING);
      requiresApproval = true;
      reasons.push(`MCP tool requests confirmation: ${mcpToolRef.serverName}/${mcpToolRef.toolName}.`);
    } else {
      reasons.push(`MCP tool allowed: ${mcpToolRef.serverName}/${mcpToolRef.toolName}.`);
    }
  }

  if (mode === 'strict' && MUTATING_CAPABILITIES.has(capability) && level !== RiskLevel.BLOCKED) {
    level = RiskLevel.WARNING;
    reasons.push('Strict mode requests confirmation for mutating tools.');
  }

  // P0-2: legacy behavior kept only when strictBlocking is off, so existing
  // autonomous setups keep working. With strictBlocking:true, BLOCKED stays
  // BLOCKED (executor denies outright) and WARNING always needs approval.
  if (level === RiskLevel.BLOCKED && !strictBlocking) {
    level = RiskLevel.WARNING;
    requiresApproval = true;
    reasons.push('Hard blocking is disabled; user approval is sufficient for this tool action.');
  } else if (level === RiskLevel.BLOCKED && strictBlocking) {
    requiresApproval = false;
    reasons.push('Strict blocking is enabled; this tool action is denied without approval escalation.');
  }

  if (isAutonomous && !strictBlocking && level === RiskLevel.WARNING && !requiresApproval) {
    level = RiskLevel.SAFE;
    reasons.push('Autonomous mode allows this tool action.');
  }

  return {
    level,
    reason: reasons.filter(Boolean).join(' '),
    mode,
    capability,
    requiresApproval
  };
}
