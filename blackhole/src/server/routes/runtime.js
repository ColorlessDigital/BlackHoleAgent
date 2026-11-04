import express from 'express';
import { loadConfig, saveConfig } from '../../config/configStore.js';
import { CapabilityExecutor } from '../../capabilities/executor.js';
import {
  LlamaCppRuntime,
  discoverGgufModels,
  discoverLlamaCppCandidates
} from '../../runtime/llamaCppRuntime.js';

export function createRuntimeRouter() {
  const router = express.Router();
  const executor = new CapabilityExecutor({ getConfig: loadConfig });

  router.get('/runtime/status', async (_req, res) => {
    res.json(await new LlamaCppRuntime(loadConfig()).status());
  });

  router.get('/runtime/discover', (_req, res) => {
    res.json({
      servers: discoverLlamaCppCandidates(),
      models: discoverGgufModels()
    });
  });

  router.post('/runtime/configure', (req, res) => {
    const saved = saveConfig({
      activeModel: 'llamacpp:local-gguf',
      localRuntime: 'llamacpp',
      llamaCppServerPath: req.body.llamaCppServerPath,
      llamaCppModelPath: req.body.llamaCppModelPath,
      llamaCppUrl: req.body.llamaCppUrl,
      llamaCppGpuLayers: req.body.llamaCppGpuLayers,
      llamaCppThreads: req.body.llamaCppThreads,
      llamaCppBatch: req.body.llamaCppBatch,
      llamaCppParallel: req.body.llamaCppParallel,
      contextLimit: req.body.contextLimit,
      maxTokens: req.body.maxTokens,
      temperature: req.body.temperature
    });
    res.json(saved);
  });

  router.post('/runtime/preflight', async (req, res) => {
    const check = await new LlamaCppRuntime(loadConfig()).preflightCheck(req.body || {});
    res.json(check);
  });

  router.post('/runtime/start', async (req, res) => {
    const result = await executor.execute('start_llama_cpp', req.body || {}, { actor: 'ui' });
    res.status(result.ok ? 200 : 400).json(result);
  });

  router.post('/runtime/stop', async (_req, res) => {
    const result = await executor.execute('stop_runtime', {}, { actor: 'ui' });
    res.status(result.ok ? 200 : 400).json(result);
  });

  return router;
}
