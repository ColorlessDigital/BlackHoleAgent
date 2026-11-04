import express from 'express';
import { PatchTransactionStore } from '../../agent/core/patchTransactionStore.js';
import { getWorkspaceRoot } from '../../workspace/workspaceManager.js';

export function createDiffRouter() {
  const router = express.Router();

  router.get('/diff/transactions', (req, res) => {
    const limit = Number(req.query.limit || 30);
    const store = new PatchTransactionStore({ workspaceRoot: getWorkspaceRoot() });
    res.json({ transactions: store.list({ limit }) });
  });

  router.post('/diff/transactions/review', (req, res) => {
    try {
      const store = new PatchTransactionStore({ workspaceRoot: getWorkspaceRoot() });
      const transaction = store.review(req.body.operations || []);
      res.json({ transaction });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  router.post('/diff/transactions/:id/accept', (req, res) => {
    try {
      const store = new PatchTransactionStore({ workspaceRoot: getWorkspaceRoot() });
      const transaction = store.accept(req.params.id);
      res.json({ transaction });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  router.post('/diff/transactions/:id/reject', (req, res) => {
    try {
      const store = new PatchTransactionStore({ workspaceRoot: getWorkspaceRoot() });
      const transaction = store.reject(req.params.id);
      res.json({ transaction });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  router.post('/diff/transactions/:id/rollback', (req, res) => {
    try {
      const store = new PatchTransactionStore({ workspaceRoot: getWorkspaceRoot() });
      const transaction = store.rollback(req.params.id);
      res.json({ transaction });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  return router;
}
