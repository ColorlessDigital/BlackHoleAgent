import express from 'express';
import { CapabilityExecutor } from '../../capabilities/executor.js';
import { loadConfig } from '../../config/configStore.js';

export function createFilesRouter() {
  const router = express.Router();
  const executor = new CapabilityExecutor({ getConfig: loadConfig });

  router.get('/files', async (req, res) => {
    const controller = new AbortController();
    res.on('close', () => { if (!res.writableEnded) controller.abort(); });
    const result = await executor.execute('list_dir', { path: typeof req.query.path === 'string' ? req.query.path : '.',
      offset: Number(req.query.offset) || 0, limit: Math.min(1000, Math.max(1, Number(req.query.limit) || 200)) },
    { actor: 'ui', abortSignal: controller.signal });
    if (result.ok) {
      res.json(result.result);
    } else {
      res.status(400).json({ error: result.error });
    }
  });

  router.post('/files/read', async (req, res) => {
    const result = await executor.execute('read_file', { path: req.body.filePath || req.body.path }, { actor: 'ui' });
    if (result.ok) {
      res.json(result.result);
    } else {
      res.status(400).json({ error: result.error });
    }
  });

  router.post('/files/write', async (req, res) => {
    const result = await executor.execute(
      'write_file',
      { path: req.body.filePath || req.body.path, content: req.body.content },
      { actor: 'ui' }
    );
    if (result.ok) {
      res.json(result.result);
    } else {
      res.status(400).json({ error: result.error });
    }
  });

  router.post('/files/patch', async (req, res) => {
    const result = await executor.execute(
      'patch_file',
      { path: req.body.filePath || req.body.path, search: req.body.search, replace: req.body.replace },
      { actor: 'ui' }
    );
    if (result.ok) {
      res.json(result.result);
    } else {
      res.status(400).json({ error: result.error });
    }
  });

  return router;
}
