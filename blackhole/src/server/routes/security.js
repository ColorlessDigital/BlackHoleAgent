import express from 'express';
import { listPendingApprovals, respondToApproval } from '../../security/approvalGate.js';

export function createSecurityRouter() {
  const router = express.Router();

  router.get('/security/pending', (_req, res) => {
    res.json({ pending: listPendingApprovals() });
  });

  router.post('/security/respond', (req, res) => {
    const success = respondToApproval(req.body.id, req.body.decision);
    res.status(success ? 200 : 404).json({ success });
  });

  return router;
}
