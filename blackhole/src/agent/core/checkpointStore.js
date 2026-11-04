import fs from 'fs';
import path from 'path';
import { randomUUID } from 'node:crypto';
import { CONFIG_DIR } from '../../config/configStore.js';

export class AgentCheckpointStore {
  constructor({ dir = path.join(CONFIG_DIR, 'agent_sessions'), retentionLimit = 20 } = {}) {
    this.dir = dir;
    this.retentionLimit = Math.max(1, Math.floor(Number(retentionLimit) || 20));
  }

  save(checkpoint) {
    const savedAt = new Date().toISOString();
    const sessionId = sanitizeSessionId(checkpoint.sessionId || `agent-${Date.now()}-${randomUUID()}`);
    if (!sessionId || sessionId.toLowerCase() === 'latest') throw new Error('Invalid checkpoint session ID.');
    const payload = {
      ...checkpoint,
      sessionId,
      savedAt
    };
    const text = JSON.stringify(payload, null, 2);
    fs.mkdirSync(this.dir, { recursive: true });

    const filePath = path.join(this.dir, `${sessionId}.json`);
    const latestPath = path.join(this.dir, 'latest.json');
    writeSnapshot(filePath, text);
    writeSnapshot(latestPath, text);
    this.prune();

    return {
      sessionId,
      savedAt,
      path: filePath,
      latestPath
    };
  }

  loadLatest() {
    const latestPath = path.join(this.dir, 'latest.json');
    const latest = readSnapshot(latestPath);
    // A completed session snapshot can be newer if publishing latest.json failed.
    for (const entry of this.list()) {
      if (latest && entry.savedAt < (Date.parse(latest.savedAt || '') || 0)) break;
      const snapshot = this.load(entry.sessionId);
      if (snapshot) return snapshot;
    }
    return latest;
  }

  load(sessionId) {
    const safeId = sanitizeSessionId(sessionId);
    if (!safeId) return null;
    if (safeId.toLowerCase() === 'latest') return this.loadLatest();
    const filePath = path.join(this.dir, `${safeId}.json`);
    return readSnapshot(filePath, safeId);
  }

  list() {
    if (!fs.existsSync(this.dir)) return [];
    return fs.readdirSync(this.dir)
      .filter(file => file.endsWith('.json') && file !== 'latest.json')
      .map(file => {
        const fullPath = path.join(this.dir, file);
        try {
          const parsed = readSnapshot(fullPath, file.slice(0, -5));
          if (!parsed) return null;
          const modifiedAt = fs.statSync(fullPath).mtimeMs;
          return { file, path: fullPath, modifiedAt,
            savedAt: Date.parse(parsed.savedAt || '') || modifiedAt,
            sessionId: parsed.sessionId,
            state: parsed.state,
            userGoal: parsed.userGoal,
            cycleCount: parsed.cycleCount,
            changedFileCount: Array.isArray(parsed.changedFiles) ? parsed.changedFiles.length : 0,
            nextRecommendedAction: parsed.nextRecommendedAction
          };
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .sort((a, b) => b.savedAt - a.savedAt || b.modifiedAt - a.modifiedAt);
  }

  prune() {
    const entries = this.list();
    for (const entry of entries.slice(this.retentionLimit)) {
      try {
        fs.rmSync(entry.path, { force: true });
      } catch {
        // Best-effort cleanup only.
      }
    }
  }
}

function sanitizeSessionId(sessionId) {
  const value = String(sessionId || '').trim().replace(/\.json$/i, '');
  if (!value || value.length > 180 || !/^[a-zA-Z0-9_.-]+$/.test(value) || /^[.]+$/.test(value)) {
    return '';
  }
  return value;
}

function readSnapshot(filePath, expectedId) {
  try {
    const value = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!value || Array.isArray(value) || typeof value !== 'object' ||
      typeof value.sessionId !== 'string' || !sanitizeSessionId(value.sessionId) || (expectedId && value.sessionId !== expectedId) ||
      typeof value.state !== 'string' || typeof value.userGoal !== 'string' ||
      (value.workspaceRoot !== undefined && typeof value.workspaceRoot !== 'string')) return null;
    return value;
  } catch {
    return null;
  }
}

function writeSnapshot(filePath, text) {
  const temporary = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporary, text, { encoding: 'utf8', flag: 'wx', mode: 0o600, flush: true });
    fs.renameSync(temporary, filePath);
  } finally {
    try { fs.rmSync(temporary, { force: true }); } catch {}
  }
}
