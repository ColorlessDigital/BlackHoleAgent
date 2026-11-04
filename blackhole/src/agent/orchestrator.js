import { loadConfig } from '../config/configStore.js';
import { AgentStateMachine } from './core/stateMachine.js';
import { registerMcpProxyTools } from '../mcp/mcpToolBridge.js';
import { emitLog } from '../common/eventBus.js';

export async function runAgentSession({ messages, send, resumeCheckpoint = null, abortSignal = null, providerSessionId = null }) {
  const loadedConfig = loadConfig();
  const config = resumeCheckpoint?.workspaceRoot
    ? { ...loadedConfig, workspaceRoot: resumeCheckpoint.workspaceRoot }
    : loadedConfig;
  const stateMachine = new AgentStateMachine({ send, messages, config, resumeCheckpoint, abortSignal, providerSessionId });
  stateMachine.saveCheckpoint('Initialize agent session');
  const discoveryStartedAt = Date.now();
  if (!abortSignal?.aborted) send({ type: 'status', status: 'Discovering configured MCP tools...' });
  const discoveryHeartbeat = setInterval(() => {
    if (abortSignal?.aborted) return;
    const elapsedSeconds = Math.round((Date.now() - discoveryStartedAt) / 1000);
    send({ type: 'status', status: `Connecting MCP tools... ${elapsedSeconds}s`, heartbeat: true, elapsedSeconds });
  }, 15000);
  discoveryHeartbeat.unref?.();
  try {
    const mcp = await registerMcpProxyTools(config, { signal: abortSignal });
    if (mcp.enabled && (mcp.registered.length > 0 || mcp.errors.length > 0)) {
      send({
        type: 'status',
        status: `MCP tools: ${mcp.registered.length} registered${mcp.errors.length ? `, ${mcp.errors.length} failed` : ''}`
      });
    }
  } catch (error) {
    if (!abortSignal?.aborted) {
      emitLog(`[MCP] Tool registration failed: ${error.message}`, 'warning');
      send({ type: 'status', status: `MCP tool registration skipped: ${error.message}` });
    }
  } finally {
    clearInterval(discoveryHeartbeat);
  }
  try {
    await stateMachine.run();
  } catch (error) {
    send({ type: 'error', error: error.message });
    send({ type: 'end' });
  }
}
