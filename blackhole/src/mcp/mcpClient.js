import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { IS_WINDOWS, NODE_RUNTIME_BIN_DIR, NODE_RUNTIME_ROOT } from '../common/paths.js';
import { StdioJsonRpcPeer } from './stdioJsonRpc.js';
import { McpDiagnosticTail } from './mcpDiagnostics.js';

export class McpStdioClient {
  constructor(serverName, serverConfig = {}, globalConfig = {}) {
    this.serverName = serverName;
    this.serverConfig = serverConfig;
    this.globalConfig = globalConfig;
    this.proc = null;
    this.peer = null;
    this.initialized = false;
    this.tools = [];
    this.diagnostics = new McpDiagnosticTail({ ...process.env, ...(serverConfig.env || {}) });
    this.connecting = null;
  }

  async connect({ signal } = {}) {
    signal?.throwIfAborted();
    if (this.initialized) return this;
    if (!this.connecting) {
      this.connecting = this.startConnection().finally(() => { this.connecting = null; });
    }
    return waitForConnection(this.connecting, signal);
  }

  async startConnection() {
    if (!this.serverConfig.command) {
      throw new Error(`MCP server "${this.serverName}" is missing command.`);
    }

    const command = resolveMcpCommand(this.serverConfig.command);
    const invocation = wrapWindowsCmd(command, this.serverConfig.args || []);
    const mcpPath = buildMcpPath();
    const environment = {
      ...process.env,
      Path: mcpPath,
      PATH: mcpPath,
      ...(this.serverConfig.env || {})
    };
    const diagnostics = new McpDiagnosticTail(environment);
    this.diagnostics = diagnostics;
    const proc = spawn(invocation.command, invocation.args, {
      cwd: this.serverConfig.cwd || this.globalConfig.workspaceRoot || process.cwd(),
      env: environment,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    });
    this.proc = proc;

    proc.stderr.on('data', chunk => diagnostics.append(chunk));
    proc.stderr.on('end', () => diagnostics.end());

    const peer = new StdioJsonRpcPeer({
      input: proc.stdout,
      output: proc.stdin,
      name: `mcp:${this.serverName}`,
      framing: this.serverConfig.framing || 'auto'
    });
    this.peer = peer;
    peer.on('close', () => {
      if (this.proc === proc) this.initialized = false;
      if (!proc.killed) proc.kill();
    });
    proc.on('error', error => peer.close(error));
    proc.on('exit', (code, signal) => {
      peer.close(new Error(`MCP server "${this.serverName}" exited (${signal || code}).`));
      if (this.proc === proc) {
        this.initialized = false;
        this.peer = null;
        this.proc = null;
      }
    });

    let initialize;
    try {
      initialize = await peer.request('initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: {
          name: 'BlackHole',
          version: '1.0.0'
        }
      }, { timeoutMs: this.globalConfig.connectTimeoutMs || 15000 });
    } catch (error) {
      peer.close(error);
      throw this.diagnostics.error(error);
    }

    if (peer.closed) throw peer.closeError;
    peer.notify('notifications/initialized');
    this.initialized = true;
    this.serverInfo = initialize?.serverInfo || {};
    return this;
  }

  async listTools({ signal } = {}) {
    await this.connect({ signal });
    const peer = this.peer;
    if (!peer) throw new Error(`MCP server "${this.serverName}" transport closed.`);
    let result;
    try {
      result = await peer.request('tools/list', {}, {
        timeoutMs: this.serverConfig.timeoutMs || this.globalConfig.requestTimeoutMs || 30000,
        signal
      });
    } catch (error) {
      signal?.throwIfAborted();
      throw this.diagnostics.error(error);
    }
    this.tools = Array.isArray(result?.tools) ? result.tools : [];
    return this.tools;
  }

  async callTool(toolName, args = {}, { signal } = {}) {
    await this.connect({ signal });
    const peer = this.peer;
    if (!peer) throw new Error(`MCP server "${this.serverName}" transport closed.`);
    try {
      return await peer.request('tools/call', {
        name: toolName,
        arguments: args || {}
      }, {
        timeoutMs: this.serverConfig.timeoutMs || this.globalConfig.requestTimeoutMs || 30000,
        signal
      });
    } catch (error) {
      signal?.throwIfAborted();
      throw this.diagnostics.error(error);
    }
  }

  close() {
    const proc = this.proc;
    const stopped = !proc?.pid || proc.exitCode !== null || proc.signalCode !== null
      ? Promise.resolve()
      : new Promise(resolve => proc.once('close', resolve));
    this.peer?.close();
    try {
      this.proc?.kill();
    } catch {}
    this.proc = null;
    this.peer = null;
    this.initialized = false;
    return stopped;
  }

  getErrorTail() {
    return this.diagnostics.text();
  }
}

export class McpClientManager {
  constructor() {
    this.clients = new Map();
  }

  async getClient(serverName, mcpConfig = {}, { signal } = {}) {
    signal?.throwIfAborted();
    const serverConfig = mcpConfig.servers?.[serverName];
    if (!serverConfig) {
      throw new Error(`MCP server is not configured: ${serverName}`);
    }
    if (!serverConfig.enabled) {
      throw new Error(`MCP server is disabled: ${serverName}`);
    }

    const cacheKey = `${mcpConfig.workspaceRoot || ''}:${serverName}`;
    const cached = this.clients.get(cacheKey);
    const client = cached || new McpStdioClient(serverName, serverConfig, mcpConfig);
    this.clients.set(cacheKey, client);
    try {
      await client.connect({ signal });
      return client;
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      client.close();
      if (this.clients.get(cacheKey) === client) this.clients.delete(cacheKey);
      const tail = client.getErrorTail();
      throw client.diagnostics.error(tail ? `${error.message}\n${tail}` : error);
    }
  }

  async listTools(mcpConfig = {}, { signal } = {}) {
    signal?.throwIfAborted();
    const entries = [];
    if (mcpConfig.enabled === false) return entries;

    for (const [serverName, serverConfig] of Object.entries(mcpConfig.servers || {})) {
      if (!serverConfig.enabled) continue;
      try {
        const client = await this.getClient(serverName, mcpConfig, { signal });
        const tools = await client.listTools({ signal });
        for (const tool of tools) {
          entries.push({
            serverName,
            tool
          });
        }
      } catch (error) {
        signal?.throwIfAborted();
        entries.push({
          serverName,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }

    return entries;
  }

  async callTool(serverName, toolName, args = {}, mcpConfig = {}, { signal } = {}) {
    const client = await this.getClient(serverName, mcpConfig, { signal });
    return client.callTool(toolName, args, { signal });
  }

  closeAll() {
    const stopped = [];
    for (const client of this.clients.values()) {
      stopped.push(client.close());
    }
    this.clients.clear();
    return Promise.all(stopped);
  }
}

export const mcpClientManager = new McpClientManager();

function waitForConnection(connection, signal) {
  if (!signal) return connection;
  // A cancelled consumer stops waiting without cancelling another consumer's handshake.
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
    connection.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

function resolveMcpCommand(command) {
  const raw = String(command || '').trim();
  const lower = raw.toLowerCase();
  const runtimeCommand = IS_WINDOWS
    ? {
        node: path.join(NODE_RUNTIME_BIN_DIR, 'node.exe'),
        npm: path.join(NODE_RUNTIME_BIN_DIR, 'npm.cmd'),
        npx: path.join(NODE_RUNTIME_BIN_DIR, 'npx.cmd')
      }[lower]
    : {
        node: path.join(NODE_RUNTIME_BIN_DIR, 'node'),
        npm: path.join(NODE_RUNTIME_BIN_DIR, 'npm'),
        npx: path.join(NODE_RUNTIME_BIN_DIR, 'npx')
      }[lower];
  return runtimeCommand && fs.existsSync(runtimeCommand) ? runtimeCommand : raw;
}

function buildMcpPath() {
  const current = process.env.Path || process.env.PATH || '';
  const runtimePath = fs.existsSync(NODE_RUNTIME_BIN_DIR)
    ? NODE_RUNTIME_BIN_DIR
    : NODE_RUNTIME_ROOT;
  return runtimePath && fs.existsSync(runtimePath)
    ? `${runtimePath}${path.delimiter}${current}`
    : current;
}

function wrapWindowsCmd(command, args) {
  if (IS_WINDOWS && command.toLowerCase().endsWith('.cmd')) {
    return {
      command: process.env.ComSpec || process.env.COMSPEC || 'C:\\Windows\\System32\\cmd.exe',
      args: ['/d', '/s', '/c', command, ...args]
    };
  }
  return { command, args };
}
