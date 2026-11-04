import fs from 'fs';
import path from 'path';
import { PROJECT_ROOT } from '../common/paths.js';
import { previewData } from '../common/boundedData.js';

const AUDIT_DIR = process.env.BLACKHOLE_DATA_DIR || path.join(PROJECT_ROOT, 'data');
const AUDIT_PATH = path.join(AUDIT_DIR, 'audit.log');
// P2-8: 10MB per file, keep current + 5 rotated (audit.1.log .. audit.5.log).
const MAX_AUDIT_BYTES = Number(process.env.BLACKHOLE_AUDIT_MAX_BYTES) || 10 * 1024 * 1024;
const MAX_ROTATED = 5;

function rotateIfNeeded(nextBytes) {
  try {
    if (!fs.existsSync(AUDIT_PATH)) return;
    const stat = fs.statSync(AUDIT_PATH);
    if (stat.size + nextBytes <= MAX_AUDIT_BYTES) return;
    for (let i = MAX_ROTATED; i >= 1; i--) {
      const src = i === 1 ? AUDIT_PATH : path.join(AUDIT_DIR, `audit.${i - 1}.log`);
      const dst = path.join(AUDIT_DIR, `audit.${i}.log`);
      if (fs.existsSync(src)) {
        if (i === MAX_ROTATED && fs.existsSync(dst)) fs.rmSync(dst, { force: true });
        fs.renameSync(src, dst);
      }
    }
  } catch {
    // Rotation failure must never block auditing; append will retry next call.
  }
}

export function writeAudit(entry) {
  try {
    if (!fs.existsSync(AUDIT_DIR)) fs.mkdirSync(AUDIT_DIR, { recursive: true });
    const timestamp = new Date().toISOString();
    let record = JSON.stringify({ timestamp, ...previewData(entry, { maxChars: 8000, maxItems: 30 }) });
    const maxEntryBytes = Math.min(64 * 1024, MAX_AUDIT_BYTES);
    if (Buffer.byteLength(record) + 1 > maxEntryBytes) {
      record = JSON.stringify({ timestamp, phase: entry.phase, action: entry.action ? {
        id: entry.action.id, actor: entry.action.actor, capability: entry.action.capability
      } : undefined, preview: record.slice(0, Math.max(0, Math.floor((maxEntryBytes - 512) / 6))), truncated: true });
    }
    const line = `${record}\n`;
    rotateIfNeeded(Buffer.byteLength(line));
    fs.appendFileSync(AUDIT_PATH, line, 'utf-8');
  } catch {
    // Audit failure must never grant or deny an action by itself.
  }
}
