import fs from 'fs';
import path from 'path';
import { runTerminalCommand } from '../../workspace/terminalBroker.js';

export class DiffTracker {
  constructor(workspaceRoot = '.') {
    this.workspaceRoot = path.resolve(workspaceRoot);
    this.backups = new Map(); // relativePath -> originalContent
    this.changedFiles = new Set();
    this.restoredFiles = new Set();
  }

  restoreChangedFiles(files = []) {
    if (!Array.isArray(files)) return;
    for (const file of files) {
      if (typeof file !== 'string' || !file.trim()) continue;
      const normalized = this.normalizeTrackedPath(file);
      this.changedFiles.add(normalized);
      this.restoredFiles.add(normalized);
    }
  }

  normalizeTrackedPath(inputPath) {
    const rawPath = String(inputPath || '.').replace(/\\/g, '/');
    const isWindowsAbsolute = /^[a-zA-Z]:\//.test(rawPath);
    const absolutePath = (path.isAbsolute(rawPath) || isWindowsAbsolute)
      ? path.resolve(rawPath)
      : path.resolve(this.workspaceRoot, rawPath);
    const relativePath = path.relative(this.workspaceRoot, absolutePath).replace(/\\/g, '/');

    if (relativePath && !relativePath.startsWith('..') && !path.isAbsolute(relativePath)) {
      return relativePath;
    }
    return absolutePath.replace(/\\/g, '/');
  }

  resolveTrackedPath(trackedPath) {
    const normalized = String(trackedPath || '').replace(/\\/g, '/');
    const isWindowsAbsolute = /^[a-zA-Z]:\//.test(normalized);
    if (path.isAbsolute(normalized) || isWindowsAbsolute) {
      return path.resolve(normalized);
    }
    return path.resolve(this.workspaceRoot, normalized);
  }

  /**
   * Backup a file's state before modification
   * @param {string} relativePath 
   */
  backupFile(relativePath) {
    const normPath = this.normalizeTrackedPath(relativePath);
    const fullPath = this.resolveTrackedPath(normPath);
    if (this.backups.has(normPath)) {
      // Already backed up in this session
      return;
    }
    if (fs.existsSync(fullPath)) {
      try {
        const content = fs.readFileSync(fullPath, 'utf8');
        this.backups.set(normPath, content);
      } catch (err) {
        console.error(`DiffTracker: Failed to backup ${normPath}:`, err);
      }
    } else {
      // File does not exist yet (NEW file)
      this.backups.set(normPath, null);
    }
  }

  /**
   * Track that a file has been modified
   * @param {string} relativePath 
   */
  trackChange(relativePath) {
    const normPath = this.normalizeTrackedPath(relativePath);
    this.changedFiles.add(normPath);
  }

  /**
   * Get unified diff for all changed files
   */
  async getSessionDiff() {
    const report = {
      changedFiles: Array.from(this.changedFiles),
      patches: {}
    };

    // Check if git is available and initialized
    let hasGit = false;
    try {
      const gitStatus = await runTerminalCommand('git status', { cwd: this.workspaceRoot });
      if (gitStatus.code === 0) {
        hasGit = true;
      }
    } catch (e) {
      // no git
    }

    for (const relPath of this.changedFiles) {
      const isWorkspaceRelative = !path.isAbsolute(relPath) && !/^[a-zA-Z]:\//.test(relPath);
      if (hasGit && isWorkspaceRelative) {
        try {
          const safeRelPath = relPath.replace(/"/g, '\\"');
          const gitDiff = await runTerminalCommand(`git diff -- "${safeRelPath}"`, { cwd: this.workspaceRoot });
          if (gitDiff.code === 0 && gitDiff.output.trim()) {
            report.patches[relPath] = gitDiff.output;
            continue;
          }
        } catch (e) {
          // fallback to manual diff
        }
      }

      // Manual Diff Fallback
      if (this.restoredFiles.has(relPath) && !this.backups.has(relPath)) {
        report.patches[relPath] = '[Earlier change restored from checkpoint; the original diff baseline is unavailable.]';
        continue;
      }
      const fullPath = this.resolveTrackedPath(relPath);
      const original = this.backups.has(relPath) ? this.backups.get(relPath) : null;
      let current = null;
      if (fs.existsSync(fullPath)) {
        try {
          current = fs.readFileSync(fullPath, 'utf8');
        } catch (err) {
          // ignored
        }
      }

      report.patches[relPath] = (this.restoredFiles.has(relPath) ? '[Changes since checkpoint resume]\n' : '')
        + this.generateManualDiff(relPath, original, current);
    }

    return report;
  }

  generateManualDiff(fileName, original, current) {
    if (original === null && current !== null) {
      return `--- /dev/null\n+++ b/${fileName}\n@@ -1,1 +1,${current.split('\n').length} @@\n` + current.split('\n').map(l => '+' + l).join('\n');
    }
    if (original !== null && current === null) {
      return `--- a/${fileName}\n+++ /dev/null\n@@ -1,${original.split('\n').length} +1,1 @@\n` + original.split('\n').map(l => '-' + l).join('\n');
    }
    if (original === current) {
      return `[No changes in ${fileName}]`;
    }

    const origLines = original.split('\n');
    const currLines = current.split('\n');
    
    // Very simple line-by-line diff
    let diff = `--- a/${fileName}\n+++ b/${fileName}\n`;
    
    // Check if we can do a naive line-by-line representation
    let i = 0;
    let j = 0;
    while (i < origLines.length || j < currLines.length) {
      if (i < origLines.length && j < currLines.length && origLines[i] === currLines[j]) {
        i++;
        j++;
      } else {
        // Collect mismatch chunk
        let delChunk = [];
        let addChunk = [];
        
        while (i < origLines.length && (j >= currLines.length || origLines[i] !== currLines[j])) {
          delChunk.push(origLines[i]);
          i++;
        }
        while (j < currLines.length && (i >= origLines.length || origLines[i] !== currLines[j])) {
          addChunk.push(currLines[j]);
          j++;
        }

        if (delChunk.length > 0 || addChunk.length > 0) {
          diff += `@@ chunk @@\n`;
          for (const line of delChunk) {
            diff += `-${line}\n`;
          }
          for (const line of addChunk) {
            diff += `+${line}\n`;
          }
        }
      }
    }
    return diff;
  }

  clear() {
    this.backups.clear();
    this.changedFiles.clear();
    this.restoredFiles.clear();
  }
}
