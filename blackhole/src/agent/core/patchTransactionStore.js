import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { PROJECT_ROOT } from '../../common/paths.js';
import { getWorkspaceRoot } from '../../workspace/workspaceManager.js';
import { PatchTransactionManager } from './patchTransaction.js';

const STORE_DIR = path.join(PROJECT_ROOT, 'data', 'patch-transactions');

export class PatchTransactionStore {
  constructor({ workspaceRoot = getWorkspaceRoot(), storeDir = STORE_DIR } = {}) {
    this.workspaceRoot = path.resolve(workspaceRoot || '.');
    this.storeDir = storeDir;
    fs.mkdirSync(this.storeDir, { recursive: true });
  }

  review(operations = []) {
    const manager = new PatchTransactionManager(this.workspaceRoot);
    const review = manager.review(operations);
    const transaction = {
      id: `diff-${Date.now()}-${randomUUID().slice(0, 8)}`,
      status: review.ok ? 'reviewed' : 'review_failed',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      workspaceRoot: this.workspaceRoot,
      operations: manager.normalizeOperations(operations),
      review: stripLargePatchPayload(review),
      rollbackFiles: {}
    };
    this.save(transaction);
    return transaction;
  }

  accept(id) {
    const transaction = this.load(id);
    if (!transaction) throw new Error(`Patch transaction not found: ${id}`);
    if (transaction.status !== 'reviewed') {
      throw new Error(`Only reviewed transactions can be accepted. Current status: ${transaction.status}`);
    }

    const manager = new PatchTransactionManager(transaction.workspaceRoot);
    const rollbackFiles = captureRollbackFiles(transaction.workspaceRoot, transaction.operations);
    const applied = manager.apply(transaction.operations);
    transaction.rollbackFiles = rollbackFiles;
    transaction.applyResult = stripLargePatchPayload(applied);
    transaction.status = applied.ok ? 'accepted' : 'apply_failed';
    transaction.updatedAt = new Date().toISOString();
    this.save(transaction);
    return transaction;
  }

  reject(id) {
    const transaction = this.load(id);
    if (!transaction) throw new Error(`Patch transaction not found: ${id}`);
    if (!['reviewed', 'review_failed'].includes(transaction.status)) {
      throw new Error(`Only pending transactions can be rejected. Current status: ${transaction.status}`);
    }
    transaction.status = 'rejected';
    transaction.updatedAt = new Date().toISOString();
    this.save(transaction);
    return transaction;
  }

  rollback(id) {
    const transaction = this.load(id);
    if (!transaction) throw new Error(`Patch transaction not found: ${id}`);
    if (transaction.status !== 'accepted') {
      throw new Error(`Only accepted transactions can be rolled back. Current status: ${transaction.status}`);
    }

    const changedFiles = [];
    for (const [relativePath, content] of Object.entries(transaction.rollbackFiles || {})) {
      const absolutePath = resolveInside(transaction.workspaceRoot, relativePath);
      if (content === null) {
        fs.rmSync(absolutePath, { force: true });
      } else {
        fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
        fs.writeFileSync(absolutePath, content, 'utf8');
      }
      changedFiles.push(relativePath);
    }

    transaction.status = 'rolled_back';
    transaction.rollbackResult = { ok: true, changedFiles };
    transaction.updatedAt = new Date().toISOString();
    this.save(transaction);
    return transaction;
  }

  list({ limit = 30 } = {}) {
    if (!fs.existsSync(this.storeDir)) return [];
    return fs.readdirSync(this.storeDir)
      .filter(file => file.endsWith('.json'))
      .map(file => {
        try {
          return JSON.parse(fs.readFileSync(path.join(this.storeDir, file), 'utf8'));
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))
      .slice(0, limit);
  }

  load(id) {
    const filePath = this.resolveTransactionPath(id);
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  }

  save(transaction) {
    fs.writeFileSync(this.resolveTransactionPath(transaction.id), JSON.stringify(transaction, null, 2), 'utf8');
    return transaction;
  }

  resolveTransactionPath(id) {
    const safeId = String(id || '').replace(/[^a-zA-Z0-9_.-]/g, '');
    if (!safeId) throw new Error('Invalid patch transaction id.');
    return path.join(this.storeDir, `${safeId}.json`);
  }
}

function captureRollbackFiles(workspaceRoot, operations = []) {
  const rollbackFiles = {};
  for (const operation of operations) {
    const relativePath = new PatchTransactionManager(workspaceRoot).toRelativePath(operation.path);
    const absolutePath = resolveInside(workspaceRoot, relativePath);
    rollbackFiles[relativePath] = fs.existsSync(absolutePath) ? fs.readFileSync(absolutePath, 'utf8') : null;
  }
  return rollbackFiles;
}

function resolveInside(workspaceRoot, relativePath) {
  const absolutePath = path.resolve(workspaceRoot, relativePath);
  const resolvedRoot = path.resolve(workspaceRoot);
  if (!absolutePath.startsWith(`${resolvedRoot}${path.sep}`) && absolutePath !== resolvedRoot) {
    throw new Error(`Path escapes workspace: ${relativePath}`);
  }
  return absolutePath;
}

function stripLargePatchPayload(payload) {
  if (!payload || typeof payload !== 'object') return payload;
  const clone = JSON.parse(JSON.stringify(payload));
  for (const preview of clone.previews || []) {
    delete preview.after;
    if (preview.diff && preview.diff.length > 20000) {
      preview.diff = `${preview.diff.slice(0, 20000)}\n[diff truncated]`;
    }
  }
  if (clone.review) clone.review = stripLargePatchPayload(clone.review);
  if (clone.applyResult) clone.applyResult = stripLargePatchPayload(clone.applyResult);
  return clone;
}
