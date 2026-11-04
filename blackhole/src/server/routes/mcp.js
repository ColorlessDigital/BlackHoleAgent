import express from 'express';
import { loadConfig } from '../../config/configStore.js';
import { loadMcpConfig, parseMcpToolName } from '../../mcp/mcpConfig.js';
import { listRegisteredMcpTools, registerMcpProxyTools } from '../../mcp/mcpToolBridge.js';
import { mcpClientManager } from '../../mcp/mcpClient.js';
import { getWorkspaceRoot } from '../../workspace/workspaceManager.js';

export function createMcpRouter() {
  const router = express.Router();

  router.get('/mcp/config', (_req, res) => {
    const appConfig = loadConfig();
    const mcpConfig = loadMcpConfig({ workspaceRoot: getWorkspaceRoot(), appConfig });
    res.json(redactMcpConfig(mcpConfig));
  });

  router.get('/mcp/tools', async (_req, res) => {
    const appConfig = loadConfig();
    const mcpConfig = loadMcpConfig({ workspaceRoot: getWorkspaceRoot(), appConfig });
    const discovered = await mcpClientManager.listTools(mcpConfig);
    res.json({
      configPath: mcpConfig.configPath,
      registered: listRegisteredMcpTools(),
      discovered
    });
  });

  router.post('/mcp/reload', async (_req, res) => {
    await mcpClientManager.closeAll();
    const result = await registerMcpProxyTools(loadConfig());
    res.json(result);
  });

  router.post('/mcp/tools/:proxyName/call', async (req, res) => {
    const parsed = parseMcpToolName(req.params.proxyName);
    if (!parsed) {
      return res.status(400).json({ error: 'Invalid MCP proxy tool name.' });
    }

    const appConfig = loadConfig();
    const mcpConfig = loadMcpConfig({ workspaceRoot: getWorkspaceRoot(), appConfig });
    const controller = new AbortController();
    const onClose = () => {
      if (!res.writableEnded) controller.abort();
    };
    res.on('close', onClose);
    try {
      const result = await mcpClientManager.callTool(parsed.serverName, parsed.toolName, req.body || {}, mcpConfig,
        { signal: controller.signal });
      if (controller.signal.aborted) return;
      return res.json({ result });
    } catch (error) {
      if (controller.signal.aborted) return;
      return res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    } finally {
      res.off('close', onClose);
    }
  });

  return router;
}

function redactMcpConfig(config) {
  const clone = JSON.parse(JSON.stringify(config || {}));
  for (const server of Object.values(clone.servers || {})) {
    for (const key of Object.keys(server.env || {})) {
      if (/TOKEN|KEY|SECRET|PASSWORD/i.test(key) && server.env[key]) {
        server.env[key] = '********';
      }
    }
  }
  return clone;
}
