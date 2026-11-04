import fs from 'fs';
import path from 'path';
import { emitLog } from '../common/eventBus.js';
import { getWorkspaceRoot } from '../workspace/workspaceManager.js';

export class WorkspaceWatcher {
  constructor(indexer) {
    this.indexer = indexer;
    this.watcher = null;
    this.timers = new Map();
  }

  start(root = getWorkspaceRoot()) {
    this.stop();
    if (isBroadWorkspaceRoot(root)) {
      emitLog(`Workspace watcher skipped for broad root: ${root}`, 'warning');
      return;
    }
    try {
      this.watcher = fs.watch(root, { recursive: true }, (_event, filename) => {
        if (!filename) return;
        const normalized = filename.replace(/\\/g, '/');
        if (/node_modules|\.git|dist|build|data|\.cache/.test(normalized)) return;
        const absolute = path.join(root, filename);
        clearTimeout(this.timers.get(absolute));
        this.timers.set(
          absolute,
          setTimeout(async () => {
            this.timers.delete(absolute);
            await this.indexer.updateFile(absolute, root);
          }, 300)
        );
      });
      emitLog(`Workspace watcher 시작: ${root}`, 'success');
    } catch (error) {
      emitLog(`Workspace watcher 시작 실패: ${error.message}`, 'error');
    }
  }

  stop() {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }
}

function isBroadWorkspaceRoot(root) {
  const resolved = path.resolve(root || '.');
  const parsed = path.parse(resolved);
  return resolved === parsed.root;
}
