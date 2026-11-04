import express from 'express';
import { getWorkspaceRoot, setWorkspaceRoot } from '../../workspace/workspaceManager.js';
import { ragIndexer } from '../../rag/indexer.js';

export function createWorkspaceRouter(watcher) {
  const router = express.Router();

  router.get('/workspace', (_req, res) => {
    res.json({ path: getWorkspaceRoot() });
  });

  router.post('/workspace', async (req, res) => {
    const nextRoot = setWorkspaceRoot(req.body.path);
    await ragIndexer.rebuild(nextRoot);
    watcher.start(nextRoot);
    res.json({ path: nextRoot });
  });

  router.get('/rag/search', (req, res) => {
    res.json({ matches: ragIndexer.search(req.query.q || '') });
  });

  return router;
}
