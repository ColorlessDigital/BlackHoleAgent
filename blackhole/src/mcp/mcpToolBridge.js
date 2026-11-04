import { ToolRegistry } from '../agent/core/toolRegistry.js';
import { RiskLevel } from '../security/riskLevels.js';
import { buildMcpToolName, loadMcpConfig } from './mcpConfig.js';
import { mcpClientManager } from './mcpClient.js';

const registeredMcpTools = new Map();

export async function registerMcpProxyTools(appConfig = {}, { signal } = {}) {
  signal?.throwIfAborted();
  const mcpConfig = loadMcpConfig({
    workspaceRoot: appConfig.workspaceRoot,
    appConfig
  });

  if (!mcpConfig.enabled) {
    return { ok: true, enabled: false, registered: [], errors: [] };
  }

  const discovered = await mcpClientManager.listTools(mcpConfig, { signal });
  const registered = [];
  const errors = [];

  for (const entry of discovered) {
    if (entry.error) {
      errors.push({ serverName: entry.serverName, error: entry.error });
      continue;
    }
    const tool = entry.tool || {};
    const proxyName = buildMcpToolName(entry.serverName, tool.name);
    registerOneMcpTool({
      proxyName,
      serverName: entry.serverName,
      mcpTool: tool
    });
    registered.push({
      name: proxyName,
      serverName: entry.serverName,
      toolName: tool.name,
      description: tool.description || ''
    });
  }

  return {
    ok: errors.length === 0,
    enabled: true,
    configPath: mcpConfig.configPath,
    registered,
    errors
  };
}

export function listRegisteredMcpTools() {
  return Array.from(registeredMcpTools.values());
}

function registerOneMcpTool({ proxyName, serverName, mcpTool }) {
  registeredMcpTools.set(proxyName, {
    name: proxyName,
    serverName,
    toolName: mcpTool.name,
    description: mcpTool.description || '',
    inputSchema: normalizeInputSchema(mcpTool.inputSchema)
  });

  ToolRegistry.register({
    name: proxyName,
    description: `[MCP:${serverName}] ${mcpTool.description || mcpTool.title || mcpTool.name}`,
    riskLevel: RiskLevel.WARNING,
    inputSchema: normalizeInputSchema(mcpTool.inputSchema),
    async execute(params, context = {}) {
      const mcpConfig = loadMcpConfig({
        workspaceRoot: context.config?.workspaceRoot,
        appConfig: context.config || {}
      });
      const result = await mcpClientManager.callTool(serverName, mcpTool.name, params || {}, mcpConfig,
        { signal: context.abortSignal });
      if (!result?.isError) return result;
      const error = (result.content || []).filter(item => item?.type === 'text')
        .map(item => item.text || '').join('\n').slice(0, 6000);
      return { ...result, ok: false, error: error || `MCP tool ${serverName}/${mcpTool.name} failed.` };
    },
    summarizeForModel(result) {
      return summarizeMcpResult(serverName, mcpTool.name, result);
    },
    summarizeForUi(result) {
      return {
        type: 'mcp_tool',
        serverName,
        toolName: mcpTool.name,
        result
      };
    }
  });
}

function normalizeInputSchema(schema) {
  if (!schema || typeof schema !== 'object') {
    return { type: 'object', properties: {} };
  }
  return {
    type: schema.type || 'object',
    properties: schema.properties || {},
    required: Array.isArray(schema.required) ? schema.required : []
  };
}

function summarizeMcpResult(serverName, toolName, result) {
  const parts = [`[mcp tool ${result?.isError || result?.ok === false ? 'failed' : 'completed'}] ${serverName}/${toolName}`];
  if (Array.isArray(result?.content)) {
    const text = result.content
      .map(item => {
        if (item?.type === 'text') return item.text || '';
        if (item?.type === 'resource_link') return `${item.name || item.uri}: ${item.uri}`;
        if (item?.type === 'image') return `[image ${item.mimeType || ''}]`;
        return JSON.stringify(item);
      })
      .filter(Boolean)
      .join('\n');
    if (text) parts.push(text);
  }
  if (result?.structuredContent) {
    parts.push(JSON.stringify(result.structuredContent, null, 2));
  }
  if (result?.isError) {
    parts.push('[MCP result marked as error]');
  }
  if (parts.length === 1) {
    parts.push(JSON.stringify(result, null, 2));
  }
  return parts.join('\n').slice(0, 12000);
}
