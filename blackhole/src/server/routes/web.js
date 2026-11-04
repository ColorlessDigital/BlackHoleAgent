import { Router } from 'express';
import { loadConfig } from '../../config/configStore.js';
import { SearchService } from '../../web/SearchService.js';

export function createWebRouter() {
  const router = Router();

  router.post('/web-test', async (req, res) => {
    try {
      const savedConfig = loadConfig();
      const config = {
        ...savedConfig,
        ...req.body
      };
      const result = await SearchService.search({ query: 'test connection' }, config);
      res.json({
        ok: result.ok,
        provider: result.provider || config.webSearchProvider || 'duckduckgo',
        resultCount: result.results ? result.results.length : 0,
        error: result.error || null,
        fallback: !!result._fallback
      });
    } catch (err) {
      res.json({ ok: false, error: err.message });
    }
  });

  return router;
}
