import fs from 'fs';
import path from 'path';
import { setImmediate as yieldToEventLoop } from 'node:timers/promises';
import {
  analyzeAstFile,
  analyzeSemanticProject,
  hasTypeScriptAstSupport
} from './astAnalyzer.js';

const INDEXABLE_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.ts', '.jsx', '.tsx', '.py', '.json', '.html', '.css', '.md']);
const BASE_EXCLUDED_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'data',
  'resources',
  'models',
  '.gemini',
  'coverage',
  '.cache',
  '.next',
  '.turbo',
  '.venv',
  'venv',
  '__pycache__',
  'target'
]);
const BROAD_ROOT_EXCLUDED_DIRS = new Set([
  '$recycle.bin',
  'system volume information',
  'download',
  'downloads',
  'windows',
  'program files',
  'program files (x86)',
  'recovery'
]);
const MAX_INDEXED_FILES = 1200;
const BROAD_ROOT_MAX_INDEXED_FILES = 300;
const MAX_INDEXED_FILE_BYTES = 1024 * 1024;
const MAX_SCAN_DEPTH = 12;
const BROAD_ROOT_MAX_SCAN_DEPTH = 4;
const MAX_SCAN_MS = 12000;

export class ProjectContextEngine {
  constructor(workspaceRoot = '.') {
    this.workspaceRoot = path.resolve(workspaceRoot);
    this.fileMap = new Map(); // relativePath -> file metadata, symbols, imports, references, calls, outline
    this.symbolIndex = new Map(); // symbol -> [{ file, line, type }]
    this.referenceIndex = new Map(); // symbol -> [{ file, line, kind, owner }]
    this.callGraph = new Map(); // caller file#symbol -> Set(callee symbol)
    this.reverseCallGraph = new Map(); // callee symbol -> Set(caller file#symbol)
    this.importGraph = new Map(); // relativePath -> Set(relativePath)
    this.reverseImportGraph = new Map(); // imported relativePath -> Set(importer relativePath)
    this.testFileMapping = new Map(); // sourceRelativePath -> Set(testRelativePath)
    this.fileDiagnostics = new Map(); // relativePath -> parser diagnostics
    this.semanticDiagnostics = new Map(); // relativePath -> type-checker diagnostics
    this.semanticReferenceIndex = new Map(); // symbol -> semantic references
    this.renameImpactIndex = new Map(); // symbol -> affected files/references
    this.semanticStatus = {
      available: false,
      skipped: true,
      reason: 'not_scanned',
      fileCount: 0,
      diagnosticCount: 0,
      referenceCount: 0,
      definitionCount: 0
    };
    this.recentlyChangedFiles = new Set();
    this.summaryCache = new Map(); // relativePath -> summary string
    this.scanStats = {
      indexedFiles: 0,
      skippedFiles: 0,
      skippedLargeFiles: 0,
      skippedDirectories: 0,
      truncated: false,
      broadRoot: false,
      reason: ''
    };
    this.lastScanAt = 0;
  }

  async scanWorkspace(options = {}) {
    options.abortSignal?.throwIfAborted();
    if (this.pendingScan) {
      try { await waitForScan(this.pendingScan, options.abortSignal); }
      catch (error) { if (options.abortSignal?.aborted || error.name !== 'AbortError') throw error; }
      return this.scanWorkspace(options);
    }
    const pending = this.scanWorkspaceNow(options);
    this.pendingScan = pending;
    try { return await pending; }
    finally { if (this.pendingScan === pending) this.pendingScan = null; }
  }

  async scanWorkspaceNow(options = {}) {
    const { force = false, ttlMs = 15000, abortSignal } = options;
    abortSignal?.throwIfAborted();
    const now = Date.now();
    if (!force && this.lastScanAt > 0 && (now - this.lastScanAt) < ttlMs && this.fileMap.size > 0) {
      return this.getWorkspaceSummary();
    }
    try {
      const broadRoot = isBroadWorkspaceRoot(this.workspaceRoot);
      const scanState = {
        startedAt: Date.now(),
        fileLimit: broadRoot ? BROAD_ROOT_MAX_INDEXED_FILES : MAX_INDEXED_FILES,
        maxDepth: broadRoot ? BROAD_ROOT_MAX_SCAN_DEPTH : MAX_SCAN_DEPTH,
        broadRoot,
        skippedDirectories: 0,
        skippedFiles: 0,
        skippedLargeFiles: 0,
        truncated: false,
        reason: ''
      };
      const files = this.globFiles(this.workspaceRoot, [], scanState);
      this.scanStats = {
        indexedFiles: files.length,
        skippedFiles: scanState.skippedFiles,
        skippedLargeFiles: scanState.skippedLargeFiles,
        skippedDirectories: scanState.skippedDirectories,
        truncated: scanState.truncated,
        broadRoot,
        reason: scanState.reason
      };
      const seenFiles = new Set();
      let processed = 0;
      for (const file of files) {
        // Yield in bounded batches so cancellation and status events can run.
        if (processed++ % 16 === 0) await yieldToEventLoop();
        abortSignal?.throwIfAborted();
        const relativePath = path.relative(this.workspaceRoot, file).replace(/\\/g, '/');
        seenFiles.add(relativePath);
        let stats, parsed;
        try {
          stats = fs.statSync(file);
          if (stats.size > MAX_INDEXED_FILE_BYTES) {
            this.scanStats.skippedLargeFiles++;
            seenFiles.delete(relativePath);
            continue;
          }
          const existing = this.fileMap.get(relativePath);
          if (existing && existing.mtime === stats.mtimeMs && existing.size === stats.size) continue;
          parsed = this.parseFile(relativePath, fs.readFileSync(file, 'utf8'));
        } catch {
          this.scanStats.skippedFiles++;
          seenFiles.delete(relativePath);
          continue;
        }
        const isTest = this.isTestFile(relativePath);
        this.removeFileFromIndexes(relativePath);

        const meta = {
          mtime: stats.mtimeMs,
          size: stats.size,
          symbols: parsed.symbols,
          rawImports: parsed.imports,
          imports: [],
          exports: parsed.exports,
          references: parsed.references,
          calls: parsed.calls,
          outline: parsed.outline,
          parser: parsed.parser || 'structured-regex-index',
          diagnostics: parsed.diagnostics || [],
          isTest
        };
        this.fileMap.set(relativePath, meta);
        this.fileDiagnostics.set(relativePath, meta.diagnostics);

        this.addFileToIndexes(relativePath, meta);
      }

      for (const relativePath of Array.from(this.fileMap.keys())) {
        if (!seenFiles.has(relativePath)) {
          this.removeFileFromIndexes(relativePath);
          this.fileMap.delete(relativePath);
          this.importGraph.delete(relativePath);
          this.reverseImportGraph.delete(relativePath);
          this.callGraph.delete(relativePath);
          this.fileDiagnostics.delete(relativePath);
          this.semanticDiagnostics.delete(relativePath);
          this.summaryCache.delete(relativePath);
        }
      }

      this.rebuildImportGraphs();
      this.buildTestMapping();
      await yieldToEventLoop();
      abortSignal?.throwIfAborted();
      this.rebuildSemanticIndexes();
      this.lastScanAt = Date.now();
      return this.getWorkspaceSummary();
    } catch (err) {
      if (abortSignal?.aborted || err.name === 'AbortError') { this.lastScanAt = 0; throw err; }
      console.error('Failed scanning workspace in ContextEngine:', err);
    }
  }

  removeFileFromIndexes(relativePath) {
    this.fileDiagnostics.delete(relativePath);
    this.semanticDiagnostics.delete(relativePath);
    this.removeFileFromSemanticIndexes(relativePath);

    for (const [symbolName, occurrences] of this.symbolIndex.entries()) {
      const remaining = occurrences.filter(occ => occ.file !== relativePath);
      if (remaining.length === 0) {
        this.symbolIndex.delete(symbolName);
      } else if (remaining.length !== occurrences.length) {
        this.symbolIndex.set(symbolName, remaining);
      }
    }

    for (const [symbolName, occurrences] of this.referenceIndex.entries()) {
      const remaining = occurrences.filter(occ => occ.file !== relativePath);
      if (remaining.length === 0) {
        this.referenceIndex.delete(symbolName);
      } else if (remaining.length !== occurrences.length) {
        this.referenceIndex.set(symbolName, remaining);
      }
    }

    for (const callerKey of Array.from(this.callGraph.keys())) {
      if (callerKey === relativePath || callerKey.startsWith(`${relativePath}#`)) {
        this.callGraph.delete(callerKey);
      }
    }

    for (const [callee, callers] of this.reverseCallGraph.entries()) {
      for (const caller of Array.from(callers)) {
        if (caller === relativePath || caller.startsWith(`${relativePath}#`)) {
          callers.delete(caller);
        }
      }
      if (callers.size === 0) {
        this.reverseCallGraph.delete(callee);
      }
    }
  }

  addFileToIndexes(relativePath, meta) {
    for (const sym of meta.symbols || []) {
      if (!this.symbolIndex.has(sym.name)) {
        this.symbolIndex.set(sym.name, []);
      }
      this.symbolIndex.get(sym.name).push({
        file: relativePath,
        line: sym.line,
        type: sym.type,
        exported: !!sym.exported,
        owner: sym.owner
      });
    }

    for (const ref of meta.references || []) {
      if (!this.referenceIndex.has(ref.name)) {
        this.referenceIndex.set(ref.name, []);
      }
      this.referenceIndex.get(ref.name).push({
        file: relativePath,
        line: ref.line,
        kind: ref.kind || 'reference',
        owner: ref.owner || null
      });
    }

    for (const call of meta.calls || []) {
      const callerKey = call.owner ? `${relativePath}#${call.owner}` : relativePath;
      if (!this.callGraph.has(callerKey)) {
        this.callGraph.set(callerKey, new Set());
      }
      this.callGraph.get(callerKey).add(call.name);

      if (!this.reverseCallGraph.has(call.name)) {
        this.reverseCallGraph.set(call.name, new Set());
      }
      this.reverseCallGraph.get(call.name).add(callerKey);
    }
  }

  globFiles(dir, fileList = [], scanState = {}) {
    const depth = Number(scanState.depth || 0);
    if (shouldStopScan(fileList, scanState)) {
      return fileList;
    }
    if (depth > Number(scanState.maxDepth || MAX_SCAN_DEPTH)) {
      scanState.truncated = true;
      scanState.reason ||= 'max_depth';
      return fileList;
    }

    const baseName = path.basename(dir).toLowerCase();
    if (BASE_EXCLUDED_DIRS.has(baseName) || (scanState.broadRoot && BROAD_ROOT_EXCLUDED_DIRS.has(baseName))) {
      scanState.skippedDirectories = (scanState.skippedDirectories || 0) + 1;
      return fileList;
    }

    let items = [];
    try {
      items = fs.readdirSync(dir);
    } catch (e) {
      return fileList;
    }

    for (const item of sortDirectoryEntries(items)) {
      if (shouldStopScan(fileList, scanState)) {
        return fileList;
      }
      const fullPath = path.join(dir, item);
      let stat;
      try {
        stat = fs.lstatSync(fullPath);
      } catch (e) {
        continue;
      }
      if (stat.isSymbolicLink()) {
        scanState.skippedFiles = (scanState.skippedFiles || 0) + 1;
        continue;
      }

      if (stat.isDirectory()) {
        scanState.depth = depth + 1;
        this.globFiles(fullPath, fileList, scanState);
        scanState.depth = depth;
      } else {
        const ext = path.extname(item).toLowerCase();
        if (item.toLowerCase() === 'package-lock.json') {
          scanState.skippedFiles = (scanState.skippedFiles || 0) + 1;
          continue;
        }
        if (stat.size > MAX_INDEXED_FILE_BYTES) {
          scanState.skippedLargeFiles = (scanState.skippedLargeFiles || 0) + 1;
          continue;
        }
        if (INDEXABLE_EXTENSIONS.has(ext)) {
          fileList.push(fullPath);
        } else {
          scanState.skippedFiles = (scanState.skippedFiles || 0) + 1;
        }
      }
    }
    return fileList;
  }

  isTestFile(relativePath) {
    const base = path.basename(relativePath).toLowerCase();
    return (
      base.includes('test') ||
      base.includes('spec') ||
      relativePath.includes('/test/') ||
      relativePath.includes('/__tests__/')
    );
  }

  parseFile(relativePath, content) {
    const astAnalysis = analyzeAstFile(relativePath, content);
    if (astAnalysis) {
      return astAnalysis;
    }

    const symbols = [];
    const imports = [];
    const exports = [];
    const references = [];
    const calls = [];
    const outline = [];
    const ext = path.extname(relativePath).toLowerCase();
    const lines = content.split('\n');
    const keywords = this.getLanguageKeywords(ext);

    const addSymbol = (symbol) => {
      if (!symbol?.name) return;
      if (symbols.some(sym => sym.name === symbol.name && sym.line === symbol.line && sym.type === symbol.type)) {
        return;
      }
      symbols.push(symbol);
      outline.push({
        name: symbol.name,
        line: symbol.line,
        type: symbol.type,
        exported: !!symbol.exported,
        owner: symbol.owner || null
      });
      references.push({
        name: symbol.name,
        line: symbol.line,
        kind: 'declaration',
        owner: symbol.owner || null
      });
    };

    const addExport = (exportInfo) => {
      if (!exportInfo?.name) return;
      const normalized = {
        name: exportInfo.name,
        localName: exportInfo.localName || exportInfo.name,
        line: exportInfo.line,
        type: exportInfo.type || 'export'
      };
      if (!exports.some(exp => exp.name === normalized.name && exp.line === normalized.line)) {
        exports.push(normalized);
      }
    };

    const addLineReferencesAndCalls = (line, lineNumber, owner, declarations = []) => {
      const cleanLine = this.stripInlineNoise(line);
      const declarationNames = new Set(declarations.map(symbol => symbol.name));
      const seenReferences = new Set();

      for (const identifier of this.extractIdentifiers(cleanLine, keywords)) {
        const kind = declarationNames.has(identifier.name) ? 'declaration' : 'reference';
        const key = `${identifier.name}:${lineNumber}:${kind}:${owner || ''}`;
        if (seenReferences.has(key)) continue;
        seenReferences.add(key);
        if (kind === 'declaration') continue;
        references.push({
          name: identifier.name,
          line: lineNumber,
          kind,
          owner: owner || null
        });
      }

      for (const call of this.extractCalls(cleanLine, keywords)) {
        if (declarationNames.has(call.name)) continue;
        calls.push({
          name: call.name,
          line: lineNumber,
          owner: owner || null
        });
      }
    };

    if (this.isJavaScriptLikeExt(ext)) {
      let braceDepth = 0;
      const ownerStack = [];

      lines.forEach((line, idx) => {
        const lineNumber = idx + 1;
        const currentOwner = ownerStack.length > 0 ? ownerStack[ownerStack.length - 1].name : null;
        const lineSymbols = [];
        const importFromRegex = /\b(?:import|export)\s+(?:[\s\S]*?\s+from\s*)?['"]([^'"]+)['"]/g;
        const requireRegex = /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g;
        const dynamicImportRegex = /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g;
        let importMatch;

        while ((importMatch = importFromRegex.exec(line)) !== null) {
          imports.push(importMatch[1]);
        }
        while ((importMatch = requireRegex.exec(line)) !== null) {
          imports.push(importMatch[1]);
        }
        while ((importMatch = dynamicImportRegex.exec(line)) !== null) {
          imports.push(importMatch[1]);
        }

        const exportListMatch = line.match(/\bexport\s*\{([^}]+)\}/);
        if (exportListMatch) {
          for (const item of exportListMatch[1].split(',')) {
            const parts = item.trim().split(/\s+as\s+/i).map(part => part.trim()).filter(Boolean);
            const localName = parts[0];
            const exportedName = parts[1] || parts[0];
            if (exportedName) {
              addExport({ name: exportedName, localName, line: lineNumber, type: 'named' });
            }
          }
        }

        const moduleExportMatch = line.match(/\bmodule\.exports\s*=\s*([a-zA-Z_$][\w$]*)/);
        if (moduleExportMatch) {
          addExport({ name: 'default', localName: moduleExportMatch[1], line: lineNumber, type: 'commonjs' });
        }

        const namedCommonJsExportMatch = line.match(/\bexports\.([a-zA-Z_$][\w$]*)\s*=/);
        if (namedCommonJsExportMatch) {
          addExport({ name: namedCommonJsExportMatch[1], line: lineNumber, type: 'commonjs' });
        }

        const isExportedLine = /\bexport\b/.test(line);
        const isDefaultExport = /\bexport\s+default\b/.test(line);

        const classMatch = line.match(/\b(?:export\s+default\s+|export\s+)?class\s+([a-zA-Z_$][\w$]*)/);
        if (classMatch) {
          const symbol = { name: classMatch[1], line: lineNumber, type: 'class', exported: isExportedLine, owner: currentOwner };
          addSymbol(symbol);
          lineSymbols.push(symbol);
          if (isExportedLine) {
            addExport({ name: isDefaultExport ? 'default' : classMatch[1], localName: classMatch[1], line: lineNumber, type: 'class' });
          }
        }

        const funcMatch = line.match(/\b(?:export\s+default\s+|export\s+)?(?:async\s+)?function\s+([a-zA-Z_$][\w$]*)/);
        if (funcMatch) {
          const symbol = { name: funcMatch[1], line: lineNumber, type: 'function', exported: isExportedLine, owner: currentOwner };
          addSymbol(symbol);
          lineSymbols.push(symbol);
          if (isExportedLine) {
            addExport({ name: isDefaultExport ? 'default' : funcMatch[1], localName: funcMatch[1], line: lineNumber, type: 'function' });
          }
        }

        const arrowMatch = line.match(/\b(?:export\s+)?(?:const|let|var)\s+([a-zA-Z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[a-zA-Z_$][\w$]*)\s*=>/);
        if (arrowMatch) {
          const symbol = { name: arrowMatch[1], line: lineNumber, type: 'function', exported: isExportedLine, owner: currentOwner };
          addSymbol(symbol);
          lineSymbols.push(symbol);
          if (isExportedLine) {
            addExport({ name: arrowMatch[1], line: lineNumber, type: 'function' });
          }
        }

        const functionExprMatch = line.match(/\b(?:export\s+)?(?:const|let|var)\s+([a-zA-Z_$][\w$]*)\s*=\s*(?:async\s*)?function\b/);
        if (functionExprMatch) {
          const symbol = { name: functionExprMatch[1], line: lineNumber, type: 'function', exported: isExportedLine, owner: currentOwner };
          addSymbol(symbol);
          lineSymbols.push(symbol);
          if (isExportedLine) {
            addExport({ name: functionExprMatch[1], line: lineNumber, type: 'function' });
          }
        }

        const constMatch = line.match(/\b(?:export\s+)?(?:const|let|var)\s+([a-zA-Z_$][\w$]*)\s*=/);
        if (constMatch && !symbols.some(sym => sym.name === constMatch[1] && sym.line === lineNumber)) {
          const symbol = { name: constMatch[1], line: lineNumber, type: 'variable', exported: isExportedLine, owner: currentOwner };
          addSymbol(symbol);
          lineSymbols.push(symbol);
          if (isExportedLine) {
            addExport({ name: constMatch[1], line: lineNumber, type: 'variable' });
          }
        }

        const methodMatch = line.match(/^\s*([a-zA-Z_$][\w$]*)\s*\([^)]*\)\s*\{/);
        if (methodMatch && !['if', 'for', 'while', 'switch', 'catch'].includes(methodMatch[1])) {
          const symbol = { name: methodMatch[1], line: lineNumber, type: 'method', owner: currentOwner };
          addSymbol(symbol);
          lineSymbols.push(symbol);
        }

        const lineOwner = lineSymbols[0]?.name || currentOwner;
        addLineReferencesAndCalls(line, lineNumber, lineOwner, lineSymbols);

        const cleanLine = this.stripInlineNoise(line);
        const openBraces = (cleanLine.match(/\{/g) || []).length;
        const closeBraces = (cleanLine.match(/\}/g) || []).length;
        const primaryScopeSymbol = lineSymbols.find(symbol => ['class', 'function', 'method'].includes(symbol.type));
        if (primaryScopeSymbol && openBraces > closeBraces) {
          ownerStack.push({
            name: primaryScopeSymbol.name,
            depth: braceDepth + openBraces - closeBraces
          });
        }
        braceDepth += openBraces - closeBraces;
        while (ownerStack.length > 0 && braceDepth < ownerStack[ownerStack.length - 1].depth) {
          ownerStack.pop();
        }
      });
    } else if (ext === '.py') {
      const ownerStack = [];

      lines.forEach((line, idx) => {
        const lineNumber = idx + 1;
        const trimmed = line.trim();
        const indent = line.match(/^\s*/)?.[0].length || 0;
        if (trimmed) {
          while (ownerStack.length > 0 && indent <= ownerStack[ownerStack.length - 1].indent) {
            ownerStack.pop();
          }
        }
        const currentOwner = ownerStack.length > 0 ? ownerStack[ownerStack.length - 1].name : null;
        const lineSymbols = [];

        const importMatch = line.match(/^\s*(?:import\s+([a-zA-Z0-9_.,\s]+)|from\s+([a-zA-Z0-9_.]+)\s+import)/);
        if (importMatch) {
          const importText = importMatch[1] || importMatch[2];
          for (const item of importText.split(',')) {
            const cleaned = item.trim().split(/\s+as\s+/i)[0];
            if (cleaned) imports.push(cleaned);
          }
        }

        const allMatch = line.match(/^\s*__all__\s*=\s*\[([^\]]+)\]/);
        if (allMatch) {
          for (const item of allMatch[1].split(',')) {
            const exportedName = item.trim().replace(/^['"]|['"]$/g, '');
            if (exportedName) {
              addExport({ name: exportedName, line: lineNumber, type: 'python-all' });
            }
          }
        }

        const classMatch = line.match(/^\s*class\s+([a-zA-Z_$][\w$]*)/);
        if (classMatch) {
          const symbol = { name: classMatch[1], line: lineNumber, type: 'class', exported: !classMatch[1].startsWith('_'), owner: currentOwner };
          addSymbol(symbol);
          lineSymbols.push(symbol);
          if (!classMatch[1].startsWith('_')) {
            addExport({ name: classMatch[1], line: lineNumber, type: 'class' });
          }
        }

        const defMatch = line.match(/^\s*(?:async\s+)?def\s+([a-zA-Z_$][\w$]*)/);
        if (defMatch) {
          const symbol = { name: defMatch[1], line: lineNumber, type: 'function', exported: !defMatch[1].startsWith('_'), owner: currentOwner };
          addSymbol(symbol);
          lineSymbols.push(symbol);
          if (!defMatch[1].startsWith('_')) {
            addExport({ name: defMatch[1], line: lineNumber, type: 'function' });
          }
        }

        const lineOwner = lineSymbols[0]?.name || currentOwner;
        addLineReferencesAndCalls(line, lineNumber, lineOwner, lineSymbols);

        const primaryScopeSymbol = lineSymbols.find(symbol => ['class', 'function'].includes(symbol.type));
        if (primaryScopeSymbol) {
          ownerStack.push({
            name: primaryScopeSymbol.name,
            indent
          });
        }
      });
    }

    return {
      parser: ext === '.py' ? 'python-structured-index' : 'structured-regex-index',
      symbols,
      imports: Array.from(new Set(imports.filter(Boolean))),
      exports: this.dedupeByKey(exports, item => `${item.name}:${item.line}:${item.type}`),
      references: this.dedupeByKey(references, item => `${item.name}:${item.line}:${item.kind}:${item.owner || ''}`),
      calls: this.dedupeByKey(calls, item => `${item.name}:${item.line}:${item.owner || ''}`),
      outline,
      diagnostics: []
    };
  }

  isJavaScriptLikeExt(ext) {
    return ['.js', '.mjs', '.cjs', '.ts', '.jsx', '.tsx'].includes(ext);
  }

  stripInlineNoise(line) {
    return String(line || '')
      .replace(/(['"`])(?:\\.|(?!\1).)*\1/g, '')
      .replace(/\/\/.*$/g, '')
      .replace(/#.*$/g, '');
  }

  getLanguageKeywords(ext) {
    const common = [
      'as', 'async', 'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'default',
      'delete', 'do', 'else', 'export', 'extends', 'false', 'finally', 'for', 'from', 'function',
      'if', 'import', 'in', 'instanceof', 'let', 'new', 'null', 'return', 'static', 'super',
      'switch', 'this', 'throw', 'true', 'try', 'typeof', 'undefined', 'var', 'void', 'while',
      'with', 'yield', 'require', 'console', 'module', 'exports'
    ];
    const python = [
      'and', 'as', 'assert', 'async', 'await', 'break', 'class', 'continue', 'def', 'del', 'elif',
      'else', 'except', 'false', 'finally', 'for', 'from', 'global', 'if', 'import', 'in', 'is',
      'lambda', 'none', 'nonlocal', 'not', 'or', 'pass', 'raise', 'return', 'self', 'true',
      'try', 'while', 'with', 'yield'
    ];
    return new Set(ext === '.py' ? python : common);
  }

  extractIdentifiers(line, keywords) {
    const identifiers = [];
    const identifierRegex = /\b([a-zA-Z_$][\w$]*)\b/g;
    let match;
    while ((match = identifierRegex.exec(line)) !== null) {
      const name = match[1];
      const previousChar = line[match.index - 1] || '';
      if (previousChar === '.' || keywords.has(name.toLowerCase())) continue;
      identifiers.push({ name, index: match.index });
    }
    return identifiers;
  }

  extractCalls(line, keywords) {
    const calls = [];
    const callRegex = /(?:^|[^\w$.:])([a-zA-Z_$][\w$]*)\s*\(/g;
    let match;
    while ((match = callRegex.exec(line)) !== null) {
      const name = match[1];
      if (keywords.has(name.toLowerCase())) continue;
      calls.push({ name });
    }
    return calls;
  }

  dedupeByKey(items, keyBuilder) {
    const seen = new Set();
    const deduped = [];
    for (const item of items) {
      const key = keyBuilder(item);
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(item);
    }
    return deduped;
  }

  rebuildImportGraphs() {
    this.importGraph.clear();
    this.reverseImportGraph.clear();

    for (const [relativePath, meta] of this.fileMap.entries()) {
      const resolvedImports = new Set();
      const rawImports = meta.rawImports || meta.imports || [];

      for (const specifier of rawImports) {
        const resolved = this.resolveImportPath(relativePath, specifier);
        if (!resolved || resolved === relativePath) continue;

        resolvedImports.add(resolved);
        if (!this.reverseImportGraph.has(resolved)) {
          this.reverseImportGraph.set(resolved, new Set());
        }
        this.reverseImportGraph.get(resolved).add(relativePath);
      }

      meta.imports = Array.from(resolvedImports);
      this.importGraph.set(relativePath, resolvedImports);
    }
  }

  resolveImportPath(fromRelativePath, specifier) {
    const rawSpecifier = String(specifier || '').trim().replace(/\\/g, '/');
    if (!rawSpecifier) return null;

    let candidateBase = null;
    if (rawSpecifier.startsWith('.')) {
      candidateBase = path.posix.normalize(path.posix.join(path.posix.dirname(fromRelativePath), rawSpecifier));
    } else if (rawSpecifier.startsWith('@/')) {
      candidateBase = rawSpecifier.slice(2);
    } else if (!rawSpecifier.startsWith('@')) {
      candidateBase = rawSpecifier.replace(/\./g, '/');
    }

    if (!candidateBase || candidateBase.startsWith('..')) return null;
    return this.resolveFileCandidate(candidateBase);
  }

  resolveFileCandidate(candidateBase) {
    const normalizedBase = candidateBase.replace(/^\/+/, '').replace(/\\/g, '/');
    const extensions = ['', '.js', '.mjs', '.cjs', '.ts', '.jsx', '.tsx', '.py', '.json'];
    const candidates = [];

    for (const ext of extensions) {
      candidates.push(`${normalizedBase}${ext}`);
    }
    for (const ext of extensions.filter(Boolean)) {
      candidates.push(`${normalizedBase}/index${ext}`);
    }

    return candidates.find(candidate => this.fileMap.has(candidate)) || null;
  }

  buildTestMapping() {
    this.testFileMapping.clear();
    const sourceFiles = [];
    const testFiles = [];

    for (const [relPath, meta] of this.fileMap.entries()) {
      if (meta.isTest) {
        testFiles.push(relPath);
      } else {
        sourceFiles.push(relPath);
      }
    }

    for (const src of sourceFiles) {
      const srcName = path.basename(src, path.extname(src)).toLowerCase();
      const associatedTests = new Set();

      for (const test of testFiles) {
        const testName = path.basename(test, path.extname(test)).toLowerCase();
        if (
          testName.includes(srcName) ||
          test.includes(srcName) ||
          (src.includes('src/') && test.includes(src.replace('src/', 'test/')))
        ) {
          associatedTests.add(test);
        }
      }

      for (const impacted of this.getImpactedFiles(src, 3)) {
        if (this.fileMap.get(impacted)?.isTest) {
          associatedTests.add(impacted);
        }
      }

      if (associatedTests.size > 0) {
        this.testFileMapping.set(src, associatedTests);
      }
    }

    for (const test of testFiles) {
      const imports = this.importGraph.get(test) || new Set();
      for (const imported of imports) {
        if (this.fileMap.get(imported)?.isTest) continue;
        if (!this.testFileMapping.has(imported)) {
          this.testFileMapping.set(imported, new Set());
        }
        this.testFileMapping.get(imported).add(test);
      }
    }
  }

  rebuildSemanticIndexes() {
    this.semanticDiagnostics.clear();
    this.semanticReferenceIndex.clear();
    this.renameImpactIndex.clear();

    const semantic = analyzeSemanticProject(this.workspaceRoot, Array.from(this.fileMap.keys()));
    if (!semantic) {
      this.semanticStatus = {
        available: false,
        skipped: true,
        reason: 'typescript_unavailable',
        fileCount: 0,
        diagnosticCount: 0,
        referenceCount: 0,
        definitionCount: 0
      };
      return;
    }

    this.semanticDiagnostics = semantic.diagnostics || new Map();

    for (const reference of semantic.references || []) {
      const keys = Array.from(new Set([
        reference.name,
        reference.definitionName
      ].filter(Boolean)));

      for (const key of keys) {
        if (!this.semanticReferenceIndex.has(key)) {
          this.semanticReferenceIndex.set(key, []);
        }
        this.semanticReferenceIndex.get(key).push(reference);

        if (!this.renameImpactIndex.has(key)) {
          this.renameImpactIndex.set(key, {
            symbol: key,
            affectedFiles: new Set(),
            references: []
          });
        }
        const impact = this.renameImpactIndex.get(key);
        impact.affectedFiles.add(reference.file);
        if (reference.definitionFile) {
          impact.affectedFiles.add(reference.definitionFile);
        }
        impact.references.push(reference);
      }
    }

    let diagnosticCount = 0;
    for (const entries of this.semanticDiagnostics.values()) {
      diagnosticCount += (entries || []).length;
    }

    this.semanticStatus = {
      available: !!semantic.available,
      skipped: !!semantic.skipped,
      reason: semantic.reason || 'unknown',
      fileCount: semantic.fileCount || 0,
      diagnosticCount,
      referenceCount: (semantic.references || []).length,
      definitionCount: (semantic.definitions || []).length
    };
  }

  removeFileFromSemanticIndexes(relativePath) {
    if (!this.semanticReferenceIndex || !this.renameImpactIndex) return;

    for (const [symbolName, references] of this.semanticReferenceIndex.entries()) {
      const remaining = references.filter(ref => ref.file !== relativePath && ref.definitionFile !== relativePath);
      if (remaining.length === 0) {
        this.semanticReferenceIndex.delete(symbolName);
      } else if (remaining.length !== references.length) {
        this.semanticReferenceIndex.set(symbolName, remaining);
      }
    }

    for (const [symbolName, impact] of this.renameImpactIndex.entries()) {
      const remainingReferences = (impact.references || []).filter(ref => ref.file !== relativePath && ref.definitionFile !== relativePath);
      if (remainingReferences.length === 0) {
        this.renameImpactIndex.delete(symbolName);
        continue;
      }
      this.renameImpactIndex.set(symbolName, {
        symbol: symbolName,
        references: remainingReferences,
        affectedFiles: new Set(remainingReferences.flatMap(ref => [ref.file, ref.definitionFile].filter(Boolean)))
      });
    }
  }

  trackFileChange(relativePath) {
    const rawPath = String(relativePath || '').replace(/\\/g, '/');
    const isWindowsAbsolute = /^[a-zA-Z]:\//.test(rawPath);
    const absolutePath = (path.isAbsolute(rawPath) || isWindowsAbsolute)
      ? path.resolve(rawPath)
      : path.resolve(this.workspaceRoot, rawPath);
    const normalized = path.relative(this.workspaceRoot, absolutePath).replace(/\\/g, '/');
    this.recentlyChangedFiles.add(normalized);
  }

  getRecentlyChangedFiles() {
    return Array.from(this.recentlyChangedFiles);
  }

  getTestFilesFor(sourceRelativePath) {
    const normalized = sourceRelativePath.replace(/\\/g, '/');
    if (this.fileMap.get(normalized)?.isTest) {
      return [normalized];
    }
    const tests = this.testFileMapping.get(normalized);
    return tests ? Array.from(tests) : [];
  }

  getImpactedFiles(relativePath, maxDepth = 2) {
    const normalized = String(relativePath || '').replace(/\\/g, '/');
    const impacted = new Set();
    const queue = [{ file: normalized, depth: 0 }];

    while (queue.length > 0) {
      const current = queue.shift();
      if (current.depth >= maxDepth) continue;

      const importers = this.reverseImportGraph.get(current.file) || new Set();
      for (const importer of importers) {
        if (impacted.has(importer)) continue;
        impacted.add(importer);
        queue.push({ file: importer, depth: current.depth + 1 });
      }
    }

    return Array.from(impacted);
  }

  getVerificationTargets(changedFiles = []) {
    const changed = Array.from(new Set((changedFiles.length > 0 ? changedFiles : this.getRecentlyChangedFiles())
      .map(file => String(file || '').replace(/\\/g, '/'))
      .filter(Boolean)));
    const impacted = new Set();
    const tests = new Set();

    for (const file of changed) {
      for (const impactedFile of this.getImpactedFiles(file, 3)) {
        impacted.add(impactedFile);
      }
      for (const test of this.getTestFilesFor(file)) {
        tests.add(test);
      }
      if (this.fileMap.get(file)?.isTest) {
        tests.add(file);
      }
    }

    for (const impactedFile of impacted) {
      if (this.fileMap.get(impactedFile)?.isTest) {
        tests.add(impactedFile);
      }
      for (const test of this.getTestFilesFor(impactedFile)) {
        tests.add(test);
      }
    }

    return {
      changedFiles: changed,
      impactedFiles: Array.from(impacted),
      testFiles: Array.from(tests)
    };
  }

  getFileOutline(relativePath) {
    const normalized = String(relativePath || '').replace(/\\/g, '/');
    return this.fileMap.get(normalized)?.outline || [];
  }

  getSymbolReferences(symbolName, { limit = 80 } = {}) {
    const query = String(symbolName || '').trim();
    if (!query) return [];

    const semanticExact = this.semanticReferenceIndex.get(query) || [];
    const exact = this.referenceIndex.get(query) || [];
    const combinedExact = this.dedupeByKey(
      [
        ...semanticExact,
        ...exact.map(reference => ({ name: query, ...reference, backend: reference.backend || 'structured-index' }))
      ],
      item => `${item.name}:${item.file}:${item.line}:${item.column || 0}:${item.kind || ''}:${item.backend || ''}`
    );
    if (combinedExact.length > 0) {
      return combinedExact.slice(0, limit);
    }

    const lowerQuery = query.toLowerCase();
    const fuzzy = [];
    for (const [name, references] of this.semanticReferenceIndex.entries()) {
      if (!name.toLowerCase().includes(lowerQuery)) continue;
      for (const reference of references) {
        fuzzy.push({ name, ...reference });
      }
    }
    for (const [name, references] of this.referenceIndex.entries()) {
      if (!name.toLowerCase().includes(lowerQuery)) continue;
      for (const reference of references) {
        fuzzy.push({ name, ...reference, backend: reference.backend || 'structured-index' });
      }
    }
    return this.dedupeByKey(
      fuzzy,
      item => `${item.name}:${item.file}:${item.line}:${item.column || 0}:${item.kind || ''}:${item.backend || ''}`
    ).slice(0, limit);
  }

  getCallGraphFor(symbolOrFile, { direction = 'both', limit = 80 } = {}) {
    const query = String(symbolOrFile || '').replace(/\\/g, '/').trim();
    if (!query) {
      return { query, outgoing: [], incoming: [] };
    }

    const callerMatches = Array.from(this.callGraph.keys()).filter(key => (
      key === query ||
      key.endsWith(`#${query}`) ||
      key.startsWith(`${query}#`)
    ));

    const outgoing = [];
    if (direction === 'out' || direction === 'both') {
      for (const caller of callerMatches) {
        const callees = this.callGraph.get(caller) || new Set();
        for (const callee of callees) {
          outgoing.push({ caller, callee });
        }
      }
    }

    const incoming = [];
    if (direction === 'in' || direction === 'both') {
      const exactCallers = this.reverseCallGraph.get(query) || new Set();
      for (const caller of exactCallers) {
        incoming.push({ caller, callee: query });
      }

      const lowerQuery = query.toLowerCase();
      for (const [callee, callers] of this.reverseCallGraph.entries()) {
        if (callee === query || !callee.toLowerCase().includes(lowerQuery)) continue;
        for (const caller of callers) {
          incoming.push({ caller, callee });
        }
      }
    }

    return {
      query,
      outgoing: outgoing.slice(0, limit),
      incoming: incoming.slice(0, limit)
    };
  }

  getFileDiagnostics(relativePath = '', { limit = 80 } = {}) {
    const normalized = String(relativePath || '').replace(/\\/g, '/');
    if (normalized) {
      return [
        ...(this.fileDiagnostics.get(normalized) || []),
        ...(this.semanticDiagnostics.get(normalized) || [])
      ].slice(0, limit);
    }

    const diagnostics = [];
    for (const [file, entries] of this.fileDiagnostics.entries()) {
      for (const diagnostic of entries || []) {
        diagnostics.push({ file, ...diagnostic });
      }
    }
    for (const [file, entries] of this.semanticDiagnostics.entries()) {
      for (const diagnostic of entries || []) {
        diagnostics.push({ file, ...diagnostic });
      }
    }
    return diagnostics.slice(0, limit);
  }

  getSemanticDiagnostics(relativePath = '', { limit = 80 } = {}) {
    const normalized = String(relativePath || '').replace(/\\/g, '/');
    if (normalized) {
      return (this.semanticDiagnostics.get(normalized) || []).slice(0, limit);
    }

    const diagnostics = [];
    for (const [file, entries] of this.semanticDiagnostics.entries()) {
      for (const diagnostic of entries || []) {
        diagnostics.push({ file, ...diagnostic });
      }
    }
    return diagnostics.slice(0, limit);
  }

  getRenameImpact(symbolName, { limit = 120 } = {}) {
    const query = String(symbolName || '').trim();
    if (!query) {
      return { query, affectedFiles: [], references: [], confidence: 'none' };
    }

    const exact = this.renameImpactIndex.get(query);
    const lowerQuery = query.toLowerCase();
    const impacts = [];

    if (exact) {
      impacts.push(exact);
    } else {
      for (const [name, impact] of this.renameImpactIndex.entries()) {
        if (name.toLowerCase().includes(lowerQuery)) {
          impacts.push(impact);
        }
      }
    }

    const affectedFiles = new Set();
    const references = [];
    for (const impact of impacts) {
      for (const file of impact.affectedFiles || []) {
        affectedFiles.add(file);
      }
      for (const reference of impact.references || []) {
        references.push(reference);
      }
    }

    if (references.length === 0) {
      const fallbackReferences = this.getSymbolReferences(query, { limit });
      for (const reference of fallbackReferences) {
        if (reference.file) affectedFiles.add(reference.file);
        references.push(reference);
      }
      return {
        query,
        affectedFiles: Array.from(affectedFiles).slice(0, limit),
        references: references.slice(0, limit),
        confidence: fallbackReferences.length > 0 ? 'textual-fallback' : 'none',
        semanticStatus: this.semanticStatus
      };
    }

    return {
      query,
      affectedFiles: Array.from(affectedFiles).slice(0, limit),
      references: this.dedupeByKey(
        references,
        item => `${item.name}:${item.file}:${item.line}:${item.column || 0}:${item.definitionFile || ''}:${item.definitionLine || ''}`
      ).slice(0, limit),
      confidence: 'semantic',
      semanticStatus: this.semanticStatus
    };
  }

  getCodeIntelligenceSummary({ limit = 10 } = {}) {
    const exportedSymbols = [];
    const parsers = {};
    let diagnosticCount = 0;
    let semanticDiagnosticCount = 0;
    for (const [file, meta] of this.fileMap.entries()) {
      parsers[meta.parser || 'unknown'] = (parsers[meta.parser || 'unknown'] || 0) + 1;
      diagnosticCount += (meta.diagnostics || []).length;
      semanticDiagnosticCount += (this.semanticDiagnostics.get(file) || []).length;
      for (const exported of meta.exports || []) {
        exportedSymbols.push({
          name: exported.name,
          localName: exported.localName,
          file,
          line: exported.line,
          type: exported.type
        });
      }
    }

    const topCallers = Array.from(this.callGraph.entries())
      .map(([caller, callees]) => ({ caller, callCount: callees.size, callees: Array.from(callees).slice(0, 6) }))
      .sort((a, b) => b.callCount - a.callCount)
      .slice(0, limit);

    return {
      mode: hasTypeScriptAstSupport() ? 'typescript-ast-with-structured-fallback' : 'structured-regex-index',
      astBackendAvailable: hasTypeScriptAstSupport(),
      semanticBackendAvailable: !!this.semanticStatus.available,
      semanticSkipped: !!this.semanticStatus.skipped,
      semanticReason: this.semanticStatus.reason,
      lspReady: !!this.semanticStatus.available && !this.semanticStatus.skipped,
      parsers,
      indexedFiles: this.fileMap.size,
      symbolCount: this.symbolIndex.size,
      referenceCount: Array.from(this.referenceIndex.values()).reduce((total, refs) => total + refs.length, 0),
      semanticReferenceCount: this.semanticStatus.referenceCount,
      callEdgeCount: Array.from(this.callGraph.values()).reduce((total, callees) => total + callees.size, 0),
      diagnosticCount,
      semanticDiagnosticCount,
      exportedSymbols: exportedSymbols.slice(0, limit),
      topCallers
    };
  }

  getWorkspaceSummary({ fileLimit = 20, symbolLimit = 30 } = {}) {
    const files = Array.from(this.fileMap.entries());
    const testFiles = files.filter(([, meta]) => meta.isTest).map(([file]) => file);
    const sourceFiles = files.filter(([, meta]) => !meta.isTest).map(([file]) => file);
    const symbols = [];

    for (const [name, occurrences] of this.symbolIndex.entries()) {
      for (const occurrence of occurrences) {
        symbols.push({
          name,
          file: occurrence.file,
          line: occurrence.line,
          type: occurrence.type
        });
      }
    }

    return {
      workspaceRoot: this.workspaceRoot,
      fileCount: files.length,
      sourceFileCount: sourceFiles.length,
      testFileCount: testFiles.length,
      importEdgeCount: Array.from(this.importGraph.values()).reduce((total, imports) => total + imports.size, 0),
      referenceCount: Array.from(this.referenceIndex.values()).reduce((total, refs) => total + refs.length, 0),
      callEdgeCount: Array.from(this.callGraph.values()).reduce((total, callees) => total + callees.size, 0),
      sampleSourceFiles: sourceFiles.slice(0, fileLimit),
      sampleTestFiles: testFiles.slice(0, fileLimit),
      recentlyChangedFiles: this.getRecentlyChangedFiles(),
      recentlyImpactedFiles: this.getVerificationTargets(this.getRecentlyChangedFiles()).impactedFiles.slice(0, fileLimit),
      symbols: symbols.slice(0, symbolLimit),
      codeIntelligence: this.getCodeIntelligenceSummary({ limit: Math.min(10, symbolLimit) }),
      scanStats: this.scanStats
    };
  }

  search(query) {
    const results = [];
    const lowerQuery = query.toLowerCase();

    // 1. Symbol Search
    for (const [symName, occs] of this.symbolIndex.entries()) {
      if (symName.toLowerCase().includes(lowerQuery)) {
        for (const occ of occs) {
          results.push({
            type: 'symbol',
            name: symName,
            file: occ.file,
            line: occ.line,
            symbolType: occ.type,
            score: symName.toLowerCase() === lowerQuery ? 1.0 : 0.8
          });
        }
      }
    }

    // 2. Reference Search
    for (const [refName, refs] of this.referenceIndex.entries()) {
      if (refName.toLowerCase().includes(lowerQuery)) {
        for (const ref of refs.slice(0, 8)) {
          results.push({
            type: 'reference',
            name: refName,
            file: ref.file,
            line: ref.line,
            referenceKind: ref.kind,
            owner: ref.owner,
            score: refName.toLowerCase() === lowerQuery ? 0.75 : 0.55
          });
        }
      }
    }

    // 3. File Map Search
    for (const [relPath, meta] of this.fileMap.entries()) {
      if (relPath.toLowerCase().includes(lowerQuery)) {
        results.push({
          type: 'file',
          name: path.basename(relPath),
          file: relPath,
          line: 1,
          score: 0.9
        });
      }
    }

    // Sort by score
    results.sort((a, b) => b.score - a.score);
    return results.slice(0, 30);
  }
}

function isBroadWorkspaceRoot(root) {
  const resolved = path.resolve(root || '.');
  const parsed = path.parse(resolved);
  return resolved === parsed.root;
}

function shouldStopScan(fileList, scanState = {}) {
  const limit = Number(scanState.fileLimit || MAX_INDEXED_FILES);
  if (fileList.length >= limit) {
    scanState.truncated = true;
    scanState.reason ||= 'file_limit';
    return true;
  }

  const startedAt = Number(scanState.startedAt || Date.now());
  if (Date.now() - startedAt > MAX_SCAN_MS) {
    scanState.truncated = true;
    scanState.reason ||= 'time_limit';
    return true;
  }

  return false;
}

function sortDirectoryEntries(items = []) {
  return [...items].sort((a, b) => {
    const aName = String(a || '').toLowerCase();
    const bName = String(b || '').toLowerCase();
    const aPriority = getEntryPriority(aName);
    const bPriority = getEntryPriority(bName);
    if (aPriority !== bPriority) return aPriority - bPriority;
    return aName.localeCompare(bName);
  });
}

function getEntryPriority(name) {
  if (name === 'src') return 0;
  if (name === 'frontend') return 1;
  if (name === 'lib') return 2;
  if (name === 'app') return 3;
  if (name === 'test' || name === 'tests' || name === '__tests__') return 4;
  if (name === 'package.json' || name === 'pyproject.toml' || name === 'requirements.txt') return 5;
  return 10;
}

const MAX_CACHED_WORKSPACES = 4;
const contextEngineCache = new Map();
const contextEngineReferences = new Map();
let contextEngineEvictions = 0;
const contextEngineFinalizer = new FinalizationRegistry(({ key, reference }) => {
  if (contextEngineReferences.get(key) === reference) contextEngineReferences.delete(key);
});

async function waitForScan(pending, signal) {
  signal?.throwIfAborted();
  if (!signal) return pending;
  let abort;
  const cancelled = new Promise((_, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
  });
  try { return await Promise.race([pending, cancelled]); }
  finally { signal.removeEventListener('abort', abort); }
}

export function getContextEngine(workspaceRoot = '.') {
  const resolved = path.resolve(workspaceRoot);
  const key = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  let engine = contextEngineCache.get(key) || contextEngineReferences.get(key)?.deref();
  if (!engine) {
    const previous = contextEngineReferences.get(key);
    if (previous) contextEngineFinalizer.unregister(previous);
    engine = new ProjectContextEngine(resolved);
    const reference = new WeakRef(engine);
    contextEngineReferences.set(key, reference);
    contextEngineFinalizer.register(engine, { key, reference }, reference);
  }
  // Drop only the cache's ownership. Callers and pending scans keep their engine
  // intact, and the weak lookup preserves sharing while any caller still uses it.
  contextEngineCache.delete(key);
  contextEngineCache.set(key, engine);
  while (contextEngineCache.size > MAX_CACHED_WORKSPACES) {
    contextEngineCache.delete(contextEngineCache.keys().next().value);
    contextEngineEvictions++;
  }
  return engine;
}

export function getContextEngineCacheStats() {
  return {
    maxRetainedWorkspaces: MAX_CACHED_WORKSPACES,
    retainedWorkspaces: contextEngineCache.size,
    trackedWorkspaces: contextEngineReferences.size,
    evictions: contextEngineEvictions
  };
}

export function clearAllContextEngineCaches() {
  contextEngineCache.clear();
  for (const reference of contextEngineReferences.values()) contextEngineFinalizer.unregister(reference);
  contextEngineReferences.clear();
  contextEngineEvictions = 0;
}
