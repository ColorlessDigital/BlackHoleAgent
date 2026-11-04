import { createRequire } from 'module';
import path from 'path';

const require = createRequire(import.meta.url);

let typescriptApi = null;
try {
  typescriptApi = require('typescript');
} catch {
  typescriptApi = null;
}

export function hasTypeScriptAstSupport() {
  return !!typescriptApi;
}

export function analyzeAstFile(relativePath, content) {
  const ext = path.extname(relativePath).toLowerCase();
  if (!isJavaScriptLikeExt(ext) || !typescriptApi) {
    return null;
  }
  return analyzeWithTypeScript(relativePath, content, ext, typescriptApi);
}

export function analyzeSemanticProject(workspaceRoot, relativeFiles = []) {
  if (!typescriptApi) {
    return null;
  }

  const ts = typescriptApi;
  const jsTsFiles = Array.from(new Set(relativeFiles
    .map(file => String(file || '').replace(/\\/g, '/'))
    .filter(file => isJavaScriptLikeExt(path.extname(file).toLowerCase()))));

  if (jsTsFiles.length === 0 || jsTsFiles.length > 1200) {
    return {
      available: jsTsFiles.length > 0,
      skipped: jsTsFiles.length > 1200,
      reason: jsTsFiles.length > 1200 ? 'too_many_files' : 'no_javascript_or_typescript_files',
      fileCount: jsTsFiles.length,
      diagnostics: new Map(),
      references: [],
      definitions: []
    };
  }

  const rootNames = jsTsFiles.map(file => path.resolve(workspaceRoot, file));
  const rootByAbsolute = new Map(rootNames.map((absolute, index) => [
    normalizePath(absolute),
    jsTsFiles[index]
  ]));
  const compilerOptions = {
    allowJs: true,
    checkJs: true,
    noEmit: true,
    strict: false,
    skipLibCheck: true,
    esModuleInterop: true,
    allowSyntheticDefaultImports: true,
    resolveJsonModule: true,
    target: ts.ScriptTarget.Latest,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.NodeJs,
    jsx: ts.JsxEmit.Preserve
  };

  let program;
  try {
    program = ts.createProgram(rootNames, compilerOptions);
  } catch (error) {
    return {
      available: true,
      skipped: true,
      reason: `program_create_failed: ${error.message}`,
      fileCount: jsTsFiles.length,
      diagnostics: new Map(),
      references: [],
      definitions: []
    };
  }

  const checker = program.getTypeChecker();
  const diagnostics = new Map();
  const references = [];
  const definitions = new Map();
  const seenReferences = new Set();

  for (const sourceFile of program.getSourceFiles()) {
    const relativePath = rootByAbsolute.get(normalizePath(sourceFile.fileName));
    if (!relativePath) continue;

    const semanticDiagnostics = [
      ...program.getSyntacticDiagnostics(sourceFile),
      ...program.getSemanticDiagnostics(sourceFile)
    ].map(diagnostic => formatDiagnostic(ts, sourceFile, diagnostic));
    diagnostics.set(relativePath, semanticDiagnostics);

    const visit = (node, owner = null) => {
      const nextOwner = ownerFromNode(ts, node, sourceFile) || owner;

      if (isSemanticDeclarationNode(ts, node)) {
        const nameNode = node.name && ts.isIdentifier(node.name) ? node.name : null;
        if (nameNode) {
          const symbol = checker.getSymbolAtLocation(nameNode);
          const definition = formatDefinition(ts, checker, sourceFile, node, nameNode, symbol);
          if (definition) {
            definitions.set(`${definition.file}#${definition.name}:${definition.line}`, definition);
          }
        }
      }

      if (ts.isIdentifier(node)) {
        const symbol = resolveAliasedSymbol(ts, checker, checker.getSymbolAtLocation(node));
        const declaration = firstWorkspaceDeclaration(symbol, rootByAbsolute);
        if (declaration) {
          const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
          const definitionPosition = declaration.sourceFile.getLineAndCharacterOfPosition(declaration.node.getStart(declaration.sourceFile));
          const reference = {
            name: node.text,
            file: relativePath,
            line: position.line + 1,
            column: position.character + 1,
            owner: nextOwner,
            kind: isDeclarationName(node, ts) ? 'declaration' : 'reference',
            definitionName: declaration.name,
            definitionFile: declaration.relativePath,
            definitionLine: definitionPosition.line + 1,
            backend: 'typescript-type-checker'
          };
          const key = `${reference.name}:${reference.file}:${reference.line}:${reference.column}:${reference.definitionFile}:${reference.definitionLine}`;
          if (!seenReferences.has(key)) {
            seenReferences.add(key);
            references.push(reference);
          }
        }
      }

      ts.forEachChild(node, child => visit(child, nextOwner));
    };

    visit(sourceFile, null);
  }

  return {
    available: true,
    skipped: false,
    reason: 'ok',
    fileCount: jsTsFiles.length,
    diagnostics,
    references,
    definitions: Array.from(definitions.values())
  };
}

function analyzeWithTypeScript(relativePath, content, ext, ts) {
  const sourceKind = getScriptKind(ext, ts);
  const sourceFile = ts.createSourceFile(
    relativePath,
    content,
    ts.ScriptTarget.Latest,
    true,
    sourceKind
  );

  const symbols = [];
  const imports = [];
  const exports = [];
  const references = [];
  const calls = [];
  const outline = [];
  const declarationNames = new Set();

  const lineOf = (node) => sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
  const textOf = (node) => node?.getText(sourceFile) || '';

  const addSymbol = (symbol) => {
    if (!symbol?.name) return;
    const normalized = {
      name: symbol.name,
      line: symbol.line,
      type: symbol.type,
      exported: !!symbol.exported,
      owner: symbol.owner || null
    };
    if (symbols.some(item => item.name === normalized.name && item.line === normalized.line && item.type === normalized.type)) {
      return;
    }
    symbols.push(normalized);
    outline.push(normalized);
    declarationNames.add(normalized.name);
    references.push({
      name: normalized.name,
      line: normalized.line,
      kind: 'declaration',
      owner: normalized.owner
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
    if (!exports.some(item => item.name === normalized.name && item.line === normalized.line && item.type === normalized.type)) {
      exports.push(normalized);
    }
  };

  const hasModifier = (node, kind) => Array.isArray(node.modifiers) && node.modifiers.some(mod => mod.kind === kind);
  const isExported = (node) => hasModifier(node, ts.SyntaxKind.ExportKeyword);
  const isDefaultExport = (node) => hasModifier(node, ts.SyntaxKind.DefaultKeyword);
  const exportedName = (node, localName) => isDefaultExport(node) ? 'default' : localName;

  const visit = (node, owner = null) => {
    const line = lineOf(node);
    let nextOwner = owner;

    if (ts.isImportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) {
      imports.push(node.moduleSpecifier.text);
    } else if (ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) {
        imports.push(node.moduleSpecifier.text);
      }
      if (node.exportClause && ts.isNamedExports(node.exportClause)) {
        for (const element of node.exportClause.elements) {
          addExport({
            name: element.name.text,
            localName: element.propertyName?.text || element.name.text,
            line: lineOf(element),
            type: 'named'
          });
        }
      }
    } else if (ts.isClassDeclaration(node) && node.name) {
      addSymbol({ name: node.name.text, line, type: 'class', exported: isExported(node), owner });
      if (isExported(node)) {
        addExport({ name: exportedName(node, node.name.text), localName: node.name.text, line, type: 'class' });
      }
      nextOwner = node.name.text;
    } else if (ts.isFunctionDeclaration(node) && node.name) {
      addSymbol({ name: node.name.text, line, type: 'function', exported: isExported(node), owner });
      if (isExported(node)) {
        addExport({ name: exportedName(node, node.name.text), localName: node.name.text, line, type: 'function' });
      }
      nextOwner = node.name.text;
    } else if (ts.isMethodDeclaration(node) && node.name) {
      const name = propertyNameText(node.name, sourceFile);
      if (name) {
        addSymbol({ name, line, type: 'method', exported: false, owner });
        nextOwner = name;
      }
    } else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      const parentStatement = findAncestor(node, candidate => ts.isVariableStatement(candidate));
      const exported = parentStatement ? isExported(parentStatement) : false;
      const initializer = node.initializer;
      const isFunctionLike = initializer && (
        ts.isArrowFunction(initializer) ||
        ts.isFunctionExpression(initializer)
      );
      addSymbol({
        name: node.name.text,
        line,
        type: isFunctionLike ? 'function' : 'variable',
        exported,
        owner
      });
      if (exported) {
        addExport({ name: node.name.text, line, type: isFunctionLike ? 'function' : 'variable' });
      }
      if (isFunctionLike) {
        nextOwner = node.name.text;
      }
    } else if (ts.isCallExpression(node)) {
      const callee = callName(node.expression, sourceFile);
      if (callee) {
        calls.push({ name: callee, line, owner });
      }
      if (isRequireCall(node, ts) || isDynamicImportCall(node, ts)) {
        const [firstArg] = node.arguments || [];
        if (firstArg && ts.isStringLiteralLike(firstArg)) {
          imports.push(firstArg.text);
        }
      }
    } else if (ts.isBinaryExpression(node)) {
      const left = textOf(node.left);
      if (left === 'module.exports') {
        addExport({ name: 'default', localName: textOf(node.right), line, type: 'commonjs' });
      } else if (left.startsWith('exports.')) {
        addExport({ name: left.slice('exports.'.length), line, type: 'commonjs' });
      }
    }

    if (ts.isIdentifier(node) && !declarationNames.has(node.text) && !isDeclarationName(node, ts)) {
      references.push({
        name: node.text,
        line,
        kind: 'reference',
        owner
      });
    }

    ts.forEachChild(node, child => visit(child, nextOwner));
  };

  visit(sourceFile, null);

  const diagnostics = (sourceFile.parseDiagnostics || []).map(diagnostic => {
    const position = diagnostic.start !== undefined
      ? sourceFile.getLineAndCharacterOfPosition(diagnostic.start)
      : { line: 0, character: 0 };
    return {
      line: position.line + 1,
      column: position.character + 1,
      message: ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
      code: diagnostic.code,
      category: ts.DiagnosticCategory[diagnostic.category] || String(diagnostic.category)
    };
  });

  return {
    parser: 'typescript-compiler-api',
    symbols: dedupeByKey(symbols, item => `${item.name}:${item.line}:${item.type}:${item.owner || ''}`),
    imports: Array.from(new Set(imports.filter(Boolean))),
    exports: dedupeByKey(exports, item => `${item.name}:${item.line}:${item.type}`),
    references: dedupeByKey(references, item => `${item.name}:${item.line}:${item.kind}:${item.owner || ''}`),
    calls: dedupeByKey(calls, item => `${item.name}:${item.line}:${item.owner || ''}`),
    outline: dedupeByKey(outline, item => `${item.name}:${item.line}:${item.type}:${item.owner || ''}`),
    diagnostics
  };
}

function getScriptKind(ext, ts) {
  if (ext === '.tsx') return ts.ScriptKind.TSX;
  if (ext === '.jsx') return ts.ScriptKind.JSX;
  if (ext === '.ts' || ext === '.mts' || ext === '.cts') return ts.ScriptKind.TS;
  if (ext === '.json') return ts.ScriptKind.JSON;
  return ts.ScriptKind.JS;
}

function isJavaScriptLikeExt(ext) {
  return ['.js', '.mjs', '.cjs', '.ts', '.jsx', '.tsx'].includes(ext);
}

function propertyNameText(name, sourceFile) {
  if (!name) return '';
  if (name.text) return name.text;
  return name.getText(sourceFile);
}

function callName(expression, sourceFile) {
  if (!expression) return '';
  if (expression.text) return expression.text;
  if (expression.name?.text) return expression.name.text;
  return expression.getText(sourceFile).split('.').pop();
}

function isRequireCall(node, ts) {
  return ts.isIdentifier(node.expression) && node.expression.text === 'require';
}

function isDynamicImportCall(node, ts) {
  return node.expression.kind === ts.SyntaxKind.ImportKeyword;
}

function isDeclarationName(node, ts) {
  const parent = node.parent;
  if (!parent) return false;
  return (
    (ts.isClassDeclaration(parent) && parent.name === node) ||
    (ts.isFunctionDeclaration(parent) && parent.name === node) ||
    (ts.isMethodDeclaration(parent) && parent.name === node) ||
    (ts.isVariableDeclaration(parent) && parent.name === node) ||
    (ts.isImportSpecifier(parent) && parent.name === node) ||
    (ts.isImportClause(parent) && parent.name === node)
  );
}

function findAncestor(node, predicate) {
  let current = node.parent;
  while (current) {
    if (predicate(current)) return current;
    current = current.parent;
  }
  return null;
}

function dedupeByKey(items, keyBuilder) {
  const seen = new Set();
  const result = [];
  for (const item of items) {
    const key = keyBuilder(item);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}

function normalizePath(filePath) {
  return path.resolve(filePath).toLowerCase().replace(/\\/g, '/');
}

function formatDiagnostic(ts, sourceFile, diagnostic) {
  const position = diagnostic.start !== undefined
    ? sourceFile.getLineAndCharacterOfPosition(diagnostic.start)
    : { line: 0, character: 0 };
  return {
    line: position.line + 1,
    column: position.character + 1,
    message: ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
    code: diagnostic.code,
    category: ts.DiagnosticCategory[diagnostic.category] || String(diagnostic.category),
    backend: diagnostic.source || 'typescript-semantic'
  };
}

function ownerFromNode(ts, node, sourceFile) {
  if (
    (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isMethodDeclaration(node)) &&
    node.name
  ) {
    return propertyNameText(node.name, sourceFile);
  }
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
    if (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer)) {
      return node.name.text;
    }
  }
  return null;
}

function isSemanticDeclarationNode(ts, node) {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isClassDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isVariableDeclaration(node) ||
    ts.isInterfaceDeclaration?.(node) ||
    ts.isTypeAliasDeclaration?.(node) ||
    ts.isEnumDeclaration?.(node)
  );
}

function formatDefinition(ts, checker, sourceFile, node, nameNode, symbol) {
  if (!nameNode?.text) return null;
  const position = sourceFile.getLineAndCharacterOfPosition(nameNode.getStart(sourceFile));
  let typeText = '';
  let signature = '';
  try {
    const type = checker.getTypeAtLocation(nameNode);
    typeText = checker.typeToString(type);
    const callSignatures = type.getCallSignatures?.() || [];
    if (callSignatures.length > 0) {
      signature = checker.signatureToString(callSignatures[0]);
    }
  } catch {
    typeText = '';
  }

  return {
    name: nameNode.text,
    file: sourceFile.fileName.replace(/\\/g, '/'),
    line: position.line + 1,
    column: position.character + 1,
    syntaxKind: ts.SyntaxKind[node.kind] || String(node.kind),
    type: typeText,
    signature,
    exported: !!(symbol?.flags && (symbol.flags & ts.SymbolFlags.ExportValue))
  };
}

function resolveAliasedSymbol(ts, checker, symbol) {
  if (!symbol) return null;
  try {
    if (symbol.flags & ts.SymbolFlags.Alias) {
      return checker.getAliasedSymbol(symbol);
    }
  } catch {
    return symbol;
  }
  return symbol;
}

function firstWorkspaceDeclaration(symbol, rootByAbsolute) {
  const declarations = symbol?.declarations || [];
  for (const declaration of declarations) {
    const sourceFile = declaration.getSourceFile?.();
    if (!sourceFile) continue;
    const relativePath = rootByAbsolute.get(normalizePath(sourceFile.fileName));
    if (!relativePath) continue;
    const nameNode = declaration.name && declaration.name.text ? declaration.name : null;
    return {
      node: nameNode || declaration,
      sourceFile,
      relativePath,
      name: nameNode?.text || symbol.getName?.() || ''
    };
  }
  return null;
}
