import fs from 'fs';
import path from 'path';
import { Worker } from 'worker_threads';
import { fileURLToPath } from 'url';
import { emitLog } from '../common/eventBus.js';
import { getWorkspaceRoot } from '../workspace/workspaceManager.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const TEXT_EXTENSIONS = /\.(js|jsx|ts|tsx|json|css|html|md|txt|bat|cmd|ps1|py|go|c|cpp|h|java|cs|yml|yaml|ini|conf)$/i;

export class RagIndexer {
  constructor() {
    this.cache = [];
    this.rebuilding = false;
  }

  async rebuild(root = getWorkspaceRoot()) {
    if (this.rebuilding) return this.cache;
    this.rebuilding = true;
    emitLog(`RAG worker rebuild 시작: ${root}`, 'info');
    const workerPath = path.join(__dirname, 'worker.js');
    return new Promise((resolve) => {
      const worker = new Worker(workerPath, { workerData: { root } });
      worker.on('message', (message) => {
        this.rebuilding = false;
        if (message.ok) {
          this.cache = message.entries;
          emitLog(`RAG 인덱스 완료: ${this.cache.length}개 파일`, 'success');
        } else {
          emitLog(`RAG 인덱스 실패: ${message.error}`, 'error');
        }
        resolve(this.cache);
      });
      worker.on('error', (error) => {
        this.rebuilding = false;
        emitLog(`RAG worker 오류: ${error.message}`, 'error');
        resolve(this.cache);
      });
    });
  }

  async updateFile(absolutePath, root = getWorkspaceRoot()) {
    const relative = path.relative(root, absolutePath).replace(/\\/g, '/');
    if (!fs.existsSync(absolutePath)) {
      this.cache = this.cache.filter((item) => item.absolute !== absolutePath);
      return;
    }
    const stat = fs.statSync(absolutePath);
    if (stat.isDirectory() || stat.size >= 1024 * 1024 || !TEXT_EXTENSIONS.test(absolutePath)) return;
    const content = await fs.promises.readFile(absolutePath, 'utf-8');
    this.cache = this.cache.filter((item) => item.absolute !== absolutePath);
    this.cache.push({
      file: relative,
      absolute: absolutePath,
      content,
      mtimeMs: stat.mtimeMs
    });
  }

  search(query) {
    const terms = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
    if (terms.length === 0) return [];
    const matches = [];
    const SYMBOL_PATTERN = /\b(class|function|const|let|var|def|struct|interface|enum|export)\b/i;

    for (const item of this.cache) {
      const lowerFile = item.file.toLowerCase();
      const lowerContent = (item.content || '').toLowerCase();
      const hasAnyMatch = terms.some(term => lowerFile.includes(term) || lowerContent.includes(term));
      if (!hasAnyMatch) continue;

      let score = 0;
      const lines = [];

      // 1. Filename weight (+50 per term match)
      terms.forEach((term) => {
        if (lowerFile.includes(term)) {
          score += 50;
        }
      });

      // 2. Exact filename / path match bonus
      const basename = path.basename(item.file).toLowerCase();
      terms.forEach((term) => {
        if (basename === term) {
          score += 100;
        } else if (basename.startsWith(term)) {
          score += 40;
        }
      });

      // 3. Recency weight (+50 for modified in last 1 hour, +20 for last 24 hours)
      if (item.mtimeMs) {
        const ageHours = (Date.now() - item.mtimeMs) / (1000 * 60 * 60);
        if (ageHours <= 1) {
          score += 50;
        } else if (ageHours <= 24) {
          score += 20;
        }
      }

      // 4. Line match weight (split on demand to save memory)
      const contentLines = item.lines || (item.content ? item.content.split('\n') : []);
      contentLines.forEach((line, index) => {
        const lowerLine = line.toLowerCase();
        const matchedTerms = terms.filter((term) => lowerLine.includes(term));
        
        if (matchedTerms.length > 0) {
          const isSymbolDef = SYMBOL_PATTERN.test(line);
          let weight = isSymbolDef ? 30 : 10;
          
          if (isSymbolDef) {
            matchedTerms.forEach((term) => {
              const symRegex = new RegExp(`\\b[a-zA-Z0-9_-]*${term}[a-zA-Z0-9_-]*\\b`, 'i');
              if (symRegex.test(line)) {
                weight += 20;
              }
            });
          }
          
          score += matchedTerms.length * weight;
          lines.push({ line: index + 1, text: line });
        }
      });

      if (score > 0) {
        matches.push({ file: item.file, score, lines: lines.slice(0, 15) });
      }
    }
    return matches.sort((a, b) => b.score - a.score).slice(0, 8);
  }
}

export const ragIndexer = new RagIndexer();
