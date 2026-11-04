import express from 'express';
import path from 'path';
import { createSession, createAuthMiddleware, createCorsMiddleware } from './auth.js';
import { PROJECT_ROOT } from '../common/paths.js';
import { eventBus } from '../common/eventBus.js';
import { createConfigRouter } from './routes/config.js';
import { createFilesRouter } from './routes/files.js';
import { createTerminalRouter } from './routes/terminal.js';
import { createChatRouter } from './routes/chat.js';
import { createSecurityRouter } from './routes/security.js';
import { createWorkspaceRouter } from './routes/workspace.js';
import { createRuntimeRouter } from './routes/runtime.js';
import { createDialogRouter } from './routes/dialog.js';
import { createIdeRouter } from './routes/ide.js';
import { createWebRouter } from './routes/web.js';
import { createAgentRouter } from './routes/agent.js';
import { createDiffRouter } from './routes/diff.js';
import { createReportsRouter } from './routes/reports.js';
import { createMcpRouter } from './routes/mcp.js';
import { ragIndexer } from '../rag/indexer.js';
import { WorkspaceWatcher } from '../rag/watcher.js';
import { getWorkspaceRoot } from '../workspace/workspaceManager.js';

export async function startApiServer({ port = 3003 } = {}) {
  const app = express();
  const session = createSession();
  const watcher = new WorkspaceWatcher(ragIndexer);
  let actualPort = port;
  const allowedOrigins = new Set([
    'http://127.0.0.1:5173',
    'http://localhost:5173',
    `http://127.0.0.1:${port}`,
    `http://localhost:${port}`
  ]);

  app.use(createCorsMiddleware(allowedOrigins));
  app.use(express.json({ limit: '2mb' }));

  app.get('/api/health', (_req, res) => res.json({ ok: true }));
  app.get('/api/bootstrap', (_req, res) => {
    res.json({ baseUrl: `http://127.0.0.1:${actualPort}`, token: session.token });
  });

  app.use('/api', createAuthMiddleware(session));

  app.get('/api/events', (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive'
    });
    res.flushHeaders();
    const write = (type, payload) => {
      if (!res.destroyed && !res.writableEnded) res.write(`event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`);
    };
    const onLog = (payload) => write('log', payload);
    const onApproval = (payload) => write('approval', payload);
    const onApprovalResolved = (payload) => write('approval_resolved', payload);
    eventBus.on('log', onLog);
    eventBus.on('approval:pending', onApproval);
    eventBus.on('approval:resolved', onApprovalResolved);
    res.on('close', () => {
      eventBus.off('log', onLog);
      eventBus.off('approval:pending', onApproval);
      eventBus.off('approval:resolved', onApprovalResolved);
    });
  });

  app.use('/api', createConfigRouter());
  app.use('/api', createFilesRouter());
  app.use('/api', createTerminalRouter());
  app.use('/api', createChatRouter());
  app.use('/api', createSecurityRouter());
  app.use('/api', createWorkspaceRouter(watcher));
  app.use('/api', createRuntimeRouter());
  app.use('/api', createDialogRouter());
  app.use('/api', createIdeRouter());
  app.use('/api', createWebRouter());
  app.use('/api', createAgentRouter());
  app.use('/api', createDiffRouter());
  app.use('/api', createReportsRouter());
  app.use('/api', createMcpRouter());

  const staticPath = path.join(PROJECT_ROOT, 'frontend', 'dist');
  app.use(express.static(staticPath));
  app.get('*', (_req, res) => res.sendFile(path.join(staticPath, 'index.html')));

  const server = await listenWithFallback(app, port);
  actualPort = server.address().port;
  allowedOrigins.add(`http://127.0.0.1:${actualPort}`);
  allowedOrigins.add(`http://localhost:${actualPort}`);

  // Background indexing so window opens immediately without blocking startup
  ragIndexer.rebuild(getWorkspaceRoot())
    .then(() => watcher.start(getWorkspaceRoot()))
    .catch((err) => console.error('[RAG] Background rebuild failed:', err));

  return {
    port: actualPort,
    baseUrl: `http://127.0.0.1:${actualPort}`,
    token: session.token
  };
}

async function listenWithFallback(app, preferredPort, maxAttempts = 20) {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const candidatePort = preferredPort + attempt;
    try {
      return await listenOnce(app, candidatePort);
    } catch (error) {
      if (error.code !== 'EADDRINUSE' || attempt === maxAttempts - 1) {
        throw error;
      }
    }
  }
  throw new Error(`No available local API port near ${preferredPort}.`);
}

function listenOnce(app, port) {
  return new Promise((resolve, reject) => {
    const server = app.listen(port, '127.0.0.1');
    server.once('listening', () => resolve(server));
    server.once('error', reject);
  });
}
