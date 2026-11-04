import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { CONFIG_DIR } from '../config/configStore.js';

const EVIDENCE_DIR = path.join(CONFIG_DIR, 'web_evidence');
const TARGETS_DIR = path.join(EVIDENCE_DIR, 'targets');

export class FileEvidenceRepository {
  static ensureDir() {
    if (!fs.existsSync(TARGETS_DIR)) {
      fs.mkdirSync(TARGETS_DIR, { recursive: true });
    }
  }

  static getFilePath(url) {
    this.ensureDir();
    const hash = crypto.createHash('md5').update(url).digest('hex');
    return path.join(TARGETS_DIR, `${hash}.jsonl`);
  }

  static getPreviousRecord(url) {
    const filePath = this.getFilePath(url);
    if (!fs.existsSync(filePath)) return null;

    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const lines = content.split('\n').filter(Boolean);
      if (lines.length === 0) return null;
      const lastLine = lines[lines.length - 1];
      return JSON.parse(lastLine);
    } catch (e) {
      console.error(`Failed to read previous record for ${url}:`, e);
      return null;
    }
  }

  static appendRecord(url, record, retentionLimit = 20) {
    const filePath = this.getFilePath(url);
    try {
      fs.appendFileSync(filePath, JSON.stringify(record) + '\n', 'utf-8');
      this.applyRetention(url, filePath, retentionLimit);
    } catch (e) {
      console.error(`Failed to append record for ${url}:`, e);
    }
  }

  static getHistory(url) {
    const filePath = this.getFilePath(url);
    if (!fs.existsSync(filePath)) return [];
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      return content.split('\n').filter(Boolean).map(line => JSON.parse(line));
    } catch (e) {
      console.error(`Failed to read history for ${url}:`, e);
      return [];
    }
  }

  static applyRetention(url, filePath, limit) {
    if (!fs.existsSync(filePath)) return;
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const lines = content.split('\n').filter(Boolean);
      if (lines.length <= limit) return;

      const keepLines = lines.slice(lines.length - limit);
      fs.writeFileSync(filePath, keepLines.join('\n') + '\n', 'utf-8');
    } catch (e) {
      console.error(`Failed to apply retention rules for ${url}:`, e);
    }
  }
}
