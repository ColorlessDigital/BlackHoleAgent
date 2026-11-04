import express from 'express';
import { AgentCheckpointStore } from '../../agent/core/checkpointStore.js';
import {
  buildCheckpointResumePrompt,
  summarizeCheckpointForResume
} from '../../agent/core/checkpointResume.js';

export function createAgentRouter() {
  const router = express.Router();
  const checkpointStore = new AgentCheckpointStore();

  router.get('/agent/checkpoints', (_req, res) => {
    res.json({
      checkpoints: checkpointStore.list().map(entry => ({
        ...entry,
        savedAt: new Date(entry.savedAt).toISOString()
      }))
    });
  });

  router.get('/agent/checkpoints/latest', (_req, res) => {
    const checkpoint = checkpointStore.loadLatest();
    if (!checkpoint) {
      return res.status(404).json({ error: 'No agent checkpoint found.' });
    }
    return res.json({ checkpoint });
  });

  router.post('/agent/checkpoints/latest/resume-prompt', (_req, res) => {
    const checkpoint = checkpointStore.loadLatest();
    if (!checkpoint) {
      return res.status(404).json({ error: 'No agent checkpoint found.' });
    }
    return res.json({
      checkpoint: summarizeCheckpointForResume(checkpoint),
      prompt: buildCheckpointResumePrompt(checkpoint)
    });
  });

  router.get('/agent/checkpoints/:sessionId', (req, res) => {
    const checkpoint = checkpointStore.load(req.params.sessionId);
    if (!checkpoint) {
      return res.status(404).json({ error: 'Agent checkpoint not found.' });
    }
    return res.json({ checkpoint });
  });

  router.post('/agent/checkpoints/:sessionId/resume-prompt', (req, res) => {
    const checkpoint = checkpointStore.load(req.params.sessionId);
    if (!checkpoint) {
      return res.status(404).json({ error: 'Agent checkpoint not found.' });
    }
    return res.json({
      checkpoint: summarizeCheckpointForResume(checkpoint),
      prompt: buildCheckpointResumePrompt(checkpoint)
    });
  });

  return router;
}
