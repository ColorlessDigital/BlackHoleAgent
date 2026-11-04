import fs from 'fs';
import path from 'path';
import { DiffTracker } from './diffTracker.js';

export class PatchTransactionManager {
  constructor(workspaceRoot = '.') {
    this.workspaceRoot = path.resolve(workspaceRoot);
  }

  review(operations = []) {
    const normalized = this.normalizeOperations(operations);
    const previews = normalized.map(operation => this.previewOperation(operation));
    return {
      ok: previews.every(preview => preview.ok),
      operationCount: previews.length,
      changedFiles: Array.from(new Set(previews.map(preview => preview.path).filter(Boolean))),
      previews
    };
  }

  apply(operations = []) {
    const review = this.review(operations);
    if (!review.ok) {
      return {
        ok: false,
        error: 'Patch transaction review failed. No files were changed.',
        review
      };
    }

    const backups = new Map();
    try {
      for (const preview of review.previews) {
        const absolutePath = this.resolvePath(preview.path);
        if (!backups.has(preview.path)) {
          backups.set(preview.path, fs.existsSync(absolutePath) ? fs.readFileSync(absolutePath, 'utf8') : null);
        }
        const parent = path.dirname(absolutePath);
        if (!fs.existsSync(parent)) {
          fs.mkdirSync(parent, { recursive: true });
        }
        fs.writeFileSync(absolutePath, preview.after, 'utf8');
      }
      return {
        ok: true,
        operationCount: review.operationCount,
        changedFiles: review.changedFiles,
        previews: review.previews
      };
    } catch (error) {
      for (const [relativePath, original] of backups.entries()) {
        const absolutePath = this.resolvePath(relativePath);
        if (original === null) {
          fs.rmSync(absolutePath, { force: true });
        } else {
          fs.writeFileSync(absolutePath, original, 'utf8');
        }
      }
      return {
        ok: false,
        error: `Patch transaction failed and was rolled back: ${error.message}`,
        changedFiles: Array.from(backups.keys())
      };
    }
  }

  previewOperation(operation) {
    const normalized = this.normalizeOperation(operation);
    const absolutePath = this.resolvePath(normalized.path);
    const before = fs.existsSync(absolutePath) ? fs.readFileSync(absolutePath, 'utf8') : null;
    let after = before;

    try {
      if (normalized.type === 'write_file') {
        after = normalized.content ?? '';
      } else if (normalized.type === 'patch_file') {
        if (before === null) {
          throw new Error('Cannot patch_file because the file does not exist.');
        }
        if (!before.includes(normalized.search)) {
          throw new Error('patch_file search text was not found.');
        }
        after = before.replace(normalized.search, normalized.replace ?? '');
      } else if (normalized.type === 'patch_lines') {
        if (before === null) {
          throw new Error('Cannot patch_lines because the file does not exist.');
        }
        const lines = before.split('\n');
        const start = Number(normalized.startLine) - 1;
        const end = Number(normalized.endLine) - 1;
        if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || end >= lines.length) {
          throw new Error(`Invalid line range: ${normalized.startLine}-${normalized.endLine}`);
        }
        lines.splice(start, end - start + 1, ...(normalized.replacement ?? '').split('\n'));
        after = lines.join('\n');
      } else {
        throw new Error(`Unsupported operation type: ${normalized.type}`);
      }

      return {
        ok: true,
        type: normalized.type,
        path: normalized.path,
        beforeSize: before?.length || 0,
        afterSize: after?.length || 0,
        diff: this.generateDiff(normalized.path, before, after),
        after
      };
    } catch (error) {
      return {
        ok: false,
        type: normalized.type,
        path: normalized.path,
        error: error.message,
        beforeSize: before?.length || 0,
        afterSize: before?.length || 0,
        diff: ''
      };
    }
  }

  normalizeOperations(operations) {
    const parsed = typeof operations === 'string' ? JSON.parse(operations) : operations;
    if (!Array.isArray(parsed)) {
      throw new Error('operations must be an array or a JSON-encoded array.');
    }
    return parsed.map(operation => this.normalizeOperation(operation));
  }

  normalizeOperation(operation) {
    if (!operation || typeof operation !== 'object' || Array.isArray(operation)) {
      throw new Error('Each patch operation must be an object.');
    }
    const params = operation.params && typeof operation.params === 'object' && !Array.isArray(operation.params)
      ? operation.params
      : {};
    const normalized = { ...params, ...operation };
    normalized.type = operation.type || operation.tool || operation.op || params.type || params.tool || params.op;
    delete normalized.params;
    if (!normalized.type) throw new Error('Patch operation is missing type.');
    if (!normalized.path) throw new Error('Patch operation is missing path.');
    normalized.path = this.toRelativePath(normalized.path);
    return normalized;
  }

  toRelativePath(targetPath) {
    const raw = String(targetPath || '').replace(/\\/g, '/');
    const isWindowsAbsolute = /^[a-zA-Z]:\//.test(raw);
    const absolutePath = (path.isAbsolute(raw) || isWindowsAbsolute)
      ? path.resolve(raw)
      : path.resolve(this.workspaceRoot, raw);
    const relativePath = path.relative(this.workspaceRoot, absolutePath).replace(/\\/g, '/');
    if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
      throw new Error(`Patch path escapes workspace: ${targetPath}`);
    }
    return relativePath;
  }

  resolvePath(relativePath) {
    return path.resolve(this.workspaceRoot, relativePath);
  }

  generateDiff(fileName, before, after) {
    const tracker = new DiffTracker(this.workspaceRoot);
    return tracker.generateManualDiff(fileName, before, after);
  }
}

