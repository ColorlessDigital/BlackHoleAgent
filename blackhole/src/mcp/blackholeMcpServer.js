#!/usr/bin/env node
import { StdioJsonRpcPeer } from './stdioJsonRpc.js';

const peer = new StdioJsonRpcPeer({
  input: process.stdin,
  output: process.stdout,
  name: 'blackhole-mcp-server'
});

let toolsPromise;
const getTools = () => toolsPromise ||= import('../agent/core/toolRegistry.js');
let executorPromise;
const getExecutor = () => executorPromise ||= Promise.all([
  import('../capabilities/executor.js'), import('../config/configStore.js')
]).then(([{ CapabilityExecutor }, { loadConfig }]) => new CapabilityExecutor({ getConfig: loadConfig }));

const activeRequests = new Map();
peer.on('close', () => {
  for (const controller of activeRequests.values()) {
    controller.abort(new DOMException('MCP transport closed.', 'AbortError'));
  }
  activeRequests.clear();
});

peer.on('request', async (message) => {
  if (message.method === 'notifications/cancelled') {
    if (message.id === undefined) activeRequests.get(message.params?.requestId)
      ?.abort(new DOMException('MCP caller cancelled the request.', 'AbortError'));
    return;
  }
  if (message.id === undefined) return;
  const controller = new AbortController();
  if (message.method !== 'initialize') activeRequests.set(message.id, controller);
  const respond = result => {
    if (!controller.signal.aborted && !peer.closed) peer.respond(message.id, result);
  };
  try {
    if (message.method === 'initialize') {
      respond({
        protocolVersion: '2025-06-18',
        capabilities: {
          tools: {
            listChanged: false
          }
        },
        serverInfo: {
          name: 'blackhole',
          version: '1.0.0'
        }
      });
      return;
    }

    if (message.method === 'ping') {
      respond({});
      return;
    }

    if (message.method === 'tools/list') {
      const { ToolRegistry } = await getTools();
      respond({
        tools: ToolRegistry.getAllTools()
          .filter(tool => !String(tool.name || '').startsWith('mcp__'))
          .map(tool => ({
            name: tool.name,
            title: tool.name,
            description: tool.description || '',
            inputSchema: normalizeInputSchema(tool.inputSchema)
          }))
      });
      return;
    }

    if (message.method === 'tools/call') {
      const name = message.params?.name;
      const args = message.params?.arguments || {};
      const executor = await getExecutor();
      controller.signal.throwIfAborted();
      const result = await executor.execute(name, args, { actor: 'mcp-client', abortSignal: controller.signal });
      respond(formatToolResult(result));
      return;
    }

    peer.respondError(message.id, -32601, `Unsupported MCP method: ${message.method}`);
  } catch (error) {
    if (!controller.signal.aborted && !peer.closed) {
      peer.respondError(message.id, -32000, error instanceof Error ? error.message : String(error));
    }
  } finally {
    if (activeRequests.get(message.id) === controller) activeRequests.delete(message.id);
  }
});

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

function formatToolResult(result) {
  const text = typeof result === 'string'
    ? result
    : JSON.stringify(result, null, 2);
  return {
    content: [
      {
        type: 'text',
        text
      }
    ],
    structuredContent: result && typeof result === 'object' ? result : { result },
    isError: !!(result && typeof result === 'object' && result.ok === false)
  };
}
