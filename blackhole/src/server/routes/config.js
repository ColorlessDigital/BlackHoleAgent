import express from 'express';
import { loadConfig, saveConfig } from '../../config/configStore.js';
import { redactSecrets } from '../../config/secretStore.js';
import { getModelCatalog, listLocalModels } from '../../runtime/runtimeRouter.js';
import { OpenaiCompatRuntime } from '../../runtime/openaiCompatRuntime.js';
import { OpenCodeGoRuntime } from '../../runtime/openCodeGoRuntime.js';
import { goModelCatalog } from '../../runtime/goModelCatalog.js';
import { normalizeGoModelTokenLimits } from '../../config/goModelSettings.js';
import { normalizeAgentRunLimits } from '../../config/agentRunLimits.js';

export function createConfigRouter() {
  const router = express.Router();

  router.get('/config', (_req, res) => {
    res.json(redactSecrets(loadConfig()));
  });

  router.post('/config', (req, res) => {
    let patch = req.body || {};
    try {
      patch = { ...patch, ...normalizeAgentRunLimits(patch, { strict: true, partial: true }) };
      if (Object.hasOwn(patch, 'opencodeGoModelMaxTokens')) {
        patch = { ...patch, opencodeGoModelMaxTokens: normalizeGoModelTokenLimits(patch.opencodeGoModelMaxTokens, { strict: true }) };
      }
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }
    res.json(redactSecrets(saveConfig(patch)));
  });

  // Unified model catalog for the model picker (local + OpenGo).
  // `models` keeps the legacy local-only shape; `catalog` is the full list.
  router.get('/models', async (_req, res) => {
    const config = loadConfig();
    if (config.opencodeGoEnabled) await goModelCatalog.refresh();
    res.json({
      models: await listLocalModels(config),
      catalog: await getModelCatalog(config),
      activeModel: config.activeModel,
      opengo: new OpenaiCompatRuntime(config).describe(),
      opencodeGo: new OpenCodeGoRuntime(config).describe()
    });
  });

  router.post('/models/test-opengo', async (_req, res) => {
    const result = await new OpenaiCompatRuntime(loadConfig()).testConnection();
    res.json(result);
  });

  router.get('/models/opencode-go', async (_req, res) => {
    const runtime = new OpenCodeGoRuntime(loadConfig());
    try {
      const models = await runtime.listModels();
      res.json({ ok: true, models, authenticated: false, catalogStatus: runtime.catalog.status() });
    } catch (error) {
      res.status(502).json({ ok: false, error: runtime.safeError(error) });
    }
  });

  router.post('/models/test-opencode-go', async (req, res) => {
    const config = loadConfig();
    const model = typeof req.body?.model === 'string' ? req.body.model.trim() : '';
    res.json(await new OpenCodeGoRuntime(model ? { ...config, opencodeGoDefaultModel: model } : config).testConnection());
  });

  router.post('/models/opencode-go/output-limit', (req, res) => {
    try {
      const model = typeof req.body?.model === 'string' ? req.body.model.trim() : '';
      if (!model || (model.includes(':') && !model.startsWith('opencode-go:'))) {
        return res.status(400).json({ error: 'An OpenCode Go model ID is required.' });
      }
      const limit = normalizeGoModelTokenLimits({ [model]: req.body?.maxTokens }, { strict: true });
      const config = loadConfig();
      const saved = saveConfig({ opencodeGoModelMaxTokens: { ...config.opencodeGoModelMaxTokens, ...limit } });
      res.json(redactSecrets(saved));
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  return router;
}
