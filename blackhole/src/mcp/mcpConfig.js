import fs from 'fs';
import path from 'path';
import { getWorkspaceRoot } from '../workspace/workspaceManager.js';

export const DEFAULT_MCP_CONFIG = {
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
};

export function loadMcpConfig({ workspaceRoot = getWorkspaceRoot(), appConfig = {} } = {}) {
  const root = path.resolve(workspaceRoot || appConfig.workspaceRoot || getWorkspaceRoot());
  const fileConfig = loadWorkspaceMcpConfig(root);
  const merged = mergeMcpConfig(DEFAULT_MCP_CONFIG, appConfig.mcp || {}, fileConfig.config || {});
  return normalizeMcpConfig({
    ...merged,
    workspaceRoot: root,
    configPath: fileConfig.path || ''
  });
}

export function loadWorkspaceMcpConfig(workspaceRoot = getWorkspaceRoot()) {
  const blackholeDir = path.join(path.resolve(workspaceRoot || '.'), '.blackhole');
  const jsonPath = path.join(blackholeDir, 'mcp.json');
  if (fs.existsSync(jsonPath)) {
    return {
      path: jsonPath,
      config: JSON.parse(fs.readFileSync(jsonPath, 'utf8'))
    };
  }

  for (const configName of ['config.yaml', 'config.yml']) {
    const yamlPath = path.join(blackholeDir, configName);
    if (!fs.existsSync(yamlPath)) continue;
    const parsed = parseSimpleYaml(fs.readFileSync(yamlPath, 'utf8'));
    return {
      path: yamlPath,
      config: parsed.mcp || {}
    };
  }

  return { path: '', config: {} };
}

export function resolveMcpPermission(toolRef, mcpConfig = {}) {
  const permissions = mcpConfig.permissions || {};
  const defaultPermission = normalizePermission(mcpConfig.defaultPermission || permissions['*'] || 'ask');
  const candidates = buildPermissionCandidates(toolRef);

  for (const candidate of candidates) {
    if (Object.prototype.hasOwnProperty.call(permissions, candidate)) {
      return normalizePermission(permissions[candidate]);
    }
  }

  return defaultPermission;
}

export function buildMcpToolName(serverName, toolName) {
  return `mcp__${sanitizeName(serverName)}__${sanitizeName(toolName)}`;
}

export function parseMcpToolName(capability = '') {
  const match = String(capability || '').match(/^mcp__([^_][\w.-]*)__([\s\S]+)$/);
  if (!match) return null;
  return {
    serverName: match[1],
    toolName: match[2]
  };
}

export function normalizePermission(value) {
  const text = String(value || '').trim().toLowerCase();
  if (['allow', 'allowed', 'safe', 'auto', 'autonomous'].includes(text)) return 'allow';
  if (['ask', 'prompt', 'confirm', 'warning'].includes(text)) return 'ask';
  if (['block', 'blocked', 'deny', 'denied'].includes(text)) return 'block';
  return 'ask';
}

function buildPermissionCandidates(toolRef) {
  const parsed = typeof toolRef === 'string' ? parseMcpToolName(toolRef) : toolRef;
  if (!parsed?.serverName || !parsed?.toolName) return ['*'];
  const server = parsed.serverName;
  const tool = parsed.toolName;
  return [
    `mcp__${server}__${tool}`,
    `${server}/${tool}`,
    `${server}.${tool}`,
    `${server}/*`,
    `mcp__${server}__*`,
    '*'
  ];
}

function mergeMcpConfig(...configs) {
  const result = {};
  for (const config of configs) {
    if (!config || typeof config !== 'object') continue;
    const currentServers = result.servers || {};
    const nextServers = config.servers || {};
    Object.assign(result, config);
    result.servers = mergeServers(currentServers, nextServers);
    result.permissions = {
      ...(result.permissions || {}),
      ...(config.permissions || {})
    };
  }
  return result;
}

function mergeServers(currentServers, nextServers) {
  const merged = { ...currentServers };
  for (const [serverName, serverConfig] of Object.entries(nextServers || {})) {
    merged[serverName] = {
      ...(merged[serverName] || {}),
      ...(serverConfig || {}),
      env: {
        ...((merged[serverName] || {}).env || {}),
        ...((serverConfig || {}).env || {})
      }
    };
  }
  return merged;
}

function normalizeMcpConfig(config) {
  const servers = {};
  for (const [serverName, rawServer] of Object.entries(config.servers || {})) {
    if (!rawServer || typeof rawServer !== 'object') continue;
    servers[sanitizeName(serverName)] = {
      enabled: rawServer.enabled === true || rawServer.enabled === 'true',
      command: String(rawServer.command || '').trim(),
      args: Array.isArray(rawServer.args) ? rawServer.args.map(String) : normalizeArgs(rawServer.args),
      env: normalizeEnv(rawServer.env || {}),
      cwd: rawServer.cwd ? String(rawServer.cwd) : '',
      framing: rawServer.framing === 'content-length' ? 'content-length' : 'auto',
      timeoutMs: Number(rawServer.timeoutMs || config.requestTimeoutMs || 30000)
    };
  }

  return {
    ...config,
    enabled: config.enabled !== false && config.enabled !== 'false',
    connectTimeoutMs: Number(config.connectTimeoutMs || 15000),
    requestTimeoutMs: Number(config.requestTimeoutMs || 30000),
    defaultPermission: normalizePermission(config.defaultPermission || 'ask'),
    servers,
    permissions: config.permissions || {}
  };
}

function normalizeArgs(value) {
  if (!value) return [];
  if (typeof value === 'string') {
    return value.split(/\s+/).filter(Boolean);
  }
  return [];
}

function normalizeEnv(env) {
  const normalized = {};
  for (const [key, value] of Object.entries(env || {})) {
    normalized[key] = expandEnv(String(value));
  }
  return normalized;
}

function expandEnv(value) {
  return value.replace(/\$\{([^}]+)\}/g, (_match, name) => process.env[name] || '');
}

function sanitizeName(value) {
  return String(value || '')
    .trim()
    .replace(/[^\w.-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    || 'unnamed';
}

function parseSimpleYaml(text) {
  const root = {};
  const stack = [{ indent: -1, value: root }];
  const lines = String(text || '').split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index];
    if (!raw.trim() || raw.trim().startsWith('#')) continue;
    const indent = raw.match(/^\s*/)[0].length;
    const trimmed = raw.trim();

    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) {
      stack.pop();
    }

    const parent = stack[stack.length - 1].value;
    if (trimmed.startsWith('- ')) {
      if (!Array.isArray(parent)) continue;
      parent.push(parseYamlScalar(trimmed.slice(2)));
      continue;
    }

    const separator = trimmed.indexOf(':');
    if (separator === -1) continue;
    const key = trimmed.slice(0, separator).trim().replace(/^["']|["']$/g, '');
    const valueText = trimmed.slice(separator + 1).trim();

    if (valueText) {
      parent[key] = parseYamlScalar(valueText);
      continue;
    }

    const next = lines.slice(index + 1).find(line => line.trim() && !line.trim().startsWith('#'));
    const nextTrimmed = next ? next.trim() : '';
    const child = nextTrimmed.startsWith('- ') ? [] : {};
    parent[key] = child;
    stack.push({ indent, value: child });
  }

  return root;
}

function parseYamlScalar(value) {
  const trimmed = String(value || '').trim();
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (trimmed === 'null') return null;
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return trimmed.slice(1, -1).split(',').map(item => parseYamlScalar(item.trim()));
    }
  }
  return trimmed;
}
