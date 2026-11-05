import { RiskLevel } from '../../security/riskLevels.js';
import {
  listDirectoryTree,
  listDirectoryPage,
  readFile,
  writeFile,
  patchFile,
  patchLines
} from '../../workspace/fileBroker.js';
import { runTerminalCommand } from '../../workspace/terminalBroker.js';
import { LlamaCppRuntime } from '../../runtime/llamaCppRuntime.js';
import { PatchTransactionManager } from './patchTransaction.js';
import { SearchService } from '../../web/SearchService.js';
import { HttpInspector } from '../../web/httpInspector.js';
import { HtmlInspector } from '../../web/htmlInspector.js';
import { RenderInspector } from '../../web/renderInspector.js';
import { Crawler } from '../../web/crawler.js';
import { EvidenceStore } from '../../web/evidenceStore.js';
import { projectSearch } from '../../rag/search.js';
import { AgentMemoryStore } from './agentMemoryStore.js';
import { previewData } from '../../common/boundedData.js';

export const ToolRegistry = {
  tools: {},

  register(tool) {
    this.tools[tool.name] = tool;
  },

  getTool(name) {
    return this.tools[name];
  },

  getAllTools() {
    return Object.values(this.tools);
  },

  validateParams(tool, params = {}) {
    const schema = tool.inputSchema || {};
    const errors = [];
    const normalized = { ...(params || {}) };
    const properties = schema.properties || {};

    if (tool.name === 'run_command' && !normalized.command && normalized.cmd) {
      normalized.command = normalized.cmd;
    }

    for (const requiredKey of schema.required || []) {
      const value = normalized[requiredKey];
      const propSchema = properties[requiredKey] || {};
      if (value === undefined || value === null || (value === '' && !propSchema.allowEmpty)) {
        errors.push(`Missing required parameter: ${requiredKey}`);
      }
    }

    for (const [key, propSchema] of Object.entries(properties)) {
      if (normalized[key] === undefined || normalized[key] === null || normalized[key] === '') {
        continue;
      }

      const type = propSchema.type;
      const value = normalized[key];
      if (type === 'number' && typeof value !== 'number') {
        const parsed = Number(value);
        if (Number.isFinite(parsed)) {
          normalized[key] = parsed;
        } else {
          errors.push(`Parameter "${key}" must be a number.`);
        }
      } else if (type === 'string' && typeof value !== 'string') {
        normalized[key] = String(value);
      } else if (type === 'boolean' && typeof value !== 'boolean') {
        if (value === 'true' || value === 'false') {
          normalized[key] = value === 'true';
        } else {
          errors.push(`Parameter "${key}" must be a boolean.`);
        }
      }
    }

    if (typeof tool.validate === 'function') {
      const customErrors = tool.validate(normalized);
      if (Array.isArray(customErrors)) {
        errors.push(...customErrors);
      }
    }

    return {
      ok: errors.length === 0,
      params: normalized,
      errors
    };
  }
};

// 1. list_dir
ToolRegistry.register({
  name: 'list_dir',
  description: 'List directories and files under the specified path.',
  riskLevel: RiskLevel.SAFE,
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Directory path to list' },
      depth: { type: 'number', description: 'Tree depth, default 4; large trees return a truncated preview' },
      offset: { type: 'number', description: 'Page offset for a single directory' },
      limit: { type: 'number', description: 'Page size; enables non-recursive paginated listing' }
    }
  },
  async execute(params, context) {
    const options = { workspaceRoot: context.config?.workspaceRoot, abortSignal: context.abortSignal };
    if (params.limit !== undefined || params.offset !== undefined) {
      return listDirectoryPage(params.path || '.', { ...options, limit: params.limit, offset: params.offset });
    }
    return listDirectoryTree(params.path || '.', params.depth ?? 4, { ...options, includeStats: true });
  },
  summarizeForModel(result) {
    if (!result) return '[No result]';
    const preview = { scanStats: result.scanStats, nextOffset: result.nextOffset, hasMore: result.hasMore,
      entries: previewData(Array.isArray(result) ? result : result.entries || result, { maxChars: 8000, maxItems: 100, maxDepth: 8 }) };
    return `[list_dir completed]\nFiles/folders found:\n${JSON.stringify(preview)}\nUse a specific subdirectory or limit/offset to continue a truncated listing.`;
  },
  summarizeForUi(result) {
    return { type: 'list_dir', data: result };
  }
});

// 2. read_file
ToolRegistry.register({
  name: 'read_file',
  description: 'Read the contents of a file.',
  riskLevel: RiskLevel.SAFE,
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path to read' },
      startLine: { type: 'number', description: 'Optional 1-based first line; use a range when earlier output was shortened.' },
      lineCount: { type: 'number', description: 'Optional number of lines, 1 to 200. Small ranges retain exact source under context pressure.' }
    },
    required: ['path']
  },
  async execute(params, context) {
    return readFile(params.path, { workspaceRoot: context.config?.workspaceRoot, startLine: params.startLine,
      lineCount: params.lineCount, abortSignal: context.abortSignal });
  },
  summarizeForModel(result) {
    if (!result) return '[No result]';
    return `[read_file completed]\nFile path: ${result.relativePath || result.path || 'unknown'}\nLines: ${result.startLine || 1}-${result.endLine ?? 'EOF'} of ${result.totalLines ?? 'unknown'}${result.hasMore ? ' (more lines available)' : ''}\nContent:\n${result.content || ''}`;
  },
  summarizeForUi(result) {
    return { type: 'read_file', path: result?.path, size: result?.content?.length };
  }
});

// 3. write_file
ToolRegistry.register({
  name: 'write_file',
  description: 'Write complete contents to a file.',
  riskLevel: RiskLevel.WARNING,
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path to write' },
      content: { type: 'string', description: 'Full file content', allowEmpty: true }
    },
    required: ['path', 'content']
  },
  async execute(params, context) {
    return writeFile(params.path, params.content, { workspaceRoot: context.config?.workspaceRoot, abortSignal: context.abortSignal });
  },
  summarizeForModel(result) {
    if (!result) return '[No result]';
    return `[write_file completed] File successfully written to: ${result.path || 'unknown'}`;
  },
  summarizeForUi(result) {
    return { type: 'write_file', path: result?.path, success: true };
  }
});

// 4. patch_file
ToolRegistry.register({
  name: 'patch_file',
  description: 'Replace search block with replace block in a file.',
  riskLevel: RiskLevel.WARNING,
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path' },
      search: { type: 'string', description: 'Block of text to find' },
      replace: { type: 'string', description: 'Block of text to replace with', allowEmpty: true }
    },
    required: ['path', 'search', 'replace']
  },
  async execute(params, context) {
    return patchFile(params.path, params.search, params.replace, { workspaceRoot: context.config?.workspaceRoot, abortSignal: context.abortSignal });
  },
  summarizeForModel(result) {
    if (!result) return '[No result]';
    return `[patch_file completed] File successfully patched: ${result.path || 'unknown'}`;
  },
  summarizeForUi(result) {
    return { type: 'patch_file', path: result?.path, success: true };
  }
});

// 5. patch_lines
ToolRegistry.register({
  name: 'patch_lines',
  description: 'Replace a specific line range with new content.',
  riskLevel: RiskLevel.WARNING,
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path' },
      startLine: { type: 'number' },
      endLine: { type: 'number' },
      replacement: { type: 'string', allowEmpty: true }
    },
    required: ['path', 'startLine', 'endLine', 'replacement']
  },
  validate(params) {
    const errors = [];
    if (params.startLine < 1) errors.push('startLine must be greater than or equal to 1.');
    if (params.endLine < params.startLine) errors.push('endLine must be greater than or equal to startLine.');
    return errors;
  },
  async execute(params, context) {
    return patchLines(params.path, params.startLine, params.endLine, params.replacement, {
      workspaceRoot: context.config?.workspaceRoot, abortSignal: context.abortSignal
    });
  },
  summarizeForModel(result, params = {}) {
    if (!result) return '[No result]';
    return `[patch_lines completed] Lines ${params.startLine}-${params.endLine} successfully replaced in: ${result.path || 'unknown'}`;
  },
  summarizeForUi(result, params = {}) {
    return { type: 'patch_lines', path: result?.path, startLine: params.startLine, endLine: params.endLine };
  }
});

// 6. run_command
ToolRegistry.register({
  name: 'run_command',
  description: 'Execute a command in the terminal workspace.',
  riskLevel: RiskLevel.WARNING,
  inputSchema: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'Command to run' },
      cwd: { type: 'string', description: 'Optional directory' }
    },
    required: ['command']
  },
  async execute(params, context) {
    return runTerminalCommand(params.command || params.cmd, {
      cwd: params.cwd,
      onOutput: context.onOutput,
      abortSignal: context.abortSignal,
      workspaceRoot: context.config?.workspaceRoot
    });
  },
  summarizeForModel(result) {
    if (!result) return '[No result]';
    return `[run_command completed]\nExit Code: ${result.code}\nOutput preview:\n${result.output || ''}\nStderr preview:\n${result.error || ''}`;
  },
  summarizeForUi(result, params = {}) {
    return { type: 'run_command', command: params.command, code: result?.code, output: result?.output };
  }
});

const patchOperationsSchema = {
  type: 'array',
  description: 'Flat file patch operations with type, path and the fields for that edit.',
  items: {
    type: 'object',
    properties: {
      type: { type: 'string', enum: ['write_file', 'patch_file', 'patch_lines'] },
      path: { type: 'string' },
      content: { type: 'string' },
      search: { type: 'string' },
      replace: { type: 'string' },
      startLine: { type: 'integer' },
      endLine: { type: 'integer' },
      replacement: { type: 'string' }
    },
    required: ['type', 'path']
  }
};

// 7. review_patch_transaction
ToolRegistry.register({
  name: 'review_patch_transaction',
  description: 'Preview a multi-file patch transaction without changing files.',
  riskLevel: RiskLevel.SAFE,
  inputSchema: {
    type: 'object',
    properties: {
      operations: patchOperationsSchema
    },
    required: ['operations']
  },
  validate(params) {
    const errors = [];
    if (!Array.isArray(params.operations) && typeof params.operations !== 'string') {
      errors.push('operations must be an array or JSON-encoded array.');
    }
    return errors;
  },
  async execute(params, context) {
    return new PatchTransactionManager(context.config.workspaceRoot || '.').review(params.operations);
  },
  summarizeForModel(result) {
    if (!result) return '[No result]';
    return `[review_patch_transaction completed]\n${JSON.stringify(stripPatchPreviewPayload(result), null, 2)}`;
  },
  summarizeForUi(result) {
    return {
      type: 'review_patch_transaction',
      ok: result?.ok,
      operationCount: result?.operationCount || 0,
      changedFiles: result?.changedFiles || []
    };
  }
});

// 8. apply_patch_transaction
ToolRegistry.register({
  name: 'apply_patch_transaction',
  description: 'Apply a reviewed multi-file patch transaction with rollback on failure.',
  riskLevel: RiskLevel.WARNING,
  inputSchema: {
    type: 'object',
    properties: {
      operations: patchOperationsSchema
    },
    required: ['operations']
  },
  validate(params) {
    const errors = [];
    if (!Array.isArray(params.operations) && typeof params.operations !== 'string') {
      errors.push('operations must be an array or JSON-encoded array.');
    }
    return errors;
  },
  async execute(params, context) {
    return new PatchTransactionManager(context.config.workspaceRoot || '.').apply(params.operations);
  },
  summarizeForModel(result) {
    if (!result) return '[No result]';
    return `[apply_patch_transaction completed]\n${JSON.stringify(stripPatchPreviewPayload(result), null, 2)}`;
  },
  summarizeForUi(result) {
    return {
      type: 'apply_patch_transaction',
      ok: result?.ok,
      operationCount: result?.operationCount || 0,
      changedFiles: result?.changedFiles || [],
      error: result?.error
    };
  }
});

// 9. project_search
ToolRegistry.register({
  name: 'project_search',
  description: 'Search for symbols or phrases using the indexer.',
  riskLevel: RiskLevel.SAFE,
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search query' }
    },
    required: ['query']
  },
  async execute(params, context) {
    // If contextEngine is passed, it can use it, otherwise fall back to projectSearch
    if (context.contextEngine) {
      return context.contextEngine.search(params.query);
    }
    return projectSearch(params.query);
  },
  summarizeForModel(result) {
    if (!result) return '[No result]';
    return `[project_search completed]\nMatches found:\n${JSON.stringify(result, null, 2)}`;
  },
  summarizeForUi(result, params = {}) {
    return { type: 'project_search', query: params.query, matchesCount: Array.isArray(result) ? result.length : 0 };
  }
});

// 10. inspect_code_context
ToolRegistry.register({
  name: 'inspect_code_context',
  description: 'Inspect structured code intelligence: workspace summary, file outline, symbol references, call graph, diagnostics, semantic diagnostics, rename impact, or verification targets.',
  riskLevel: RiskLevel.SAFE,
  inputSchema: {
    type: 'object',
    properties: {
      mode: { type: 'string', description: 'summary, outline, references, call_graph, diagnostics, semantic_diagnostics, rename_impact, or verification_targets' },
      query: { type: 'string', description: 'Symbol or file query for references/call_graph/rename_impact' },
      path: { type: 'string', description: 'File path for outline' },
      direction: { type: 'string', description: 'Call graph direction: in, out, or both' },
      limit: { type: 'number', description: 'Maximum results to return' },
      changedFiles: { type: 'string', description: 'Comma-separated file paths for verification target analysis' }
    }
  },
  validate(params) {
    const errors = [];
    normalizeInspectCodeContextParams(params);
    const mode = String(params.mode || 'summary').trim();
    const validModes = new Set(['summary', 'outline', 'references', 'call_graph', 'diagnostics', 'semantic_diagnostics', 'rename_impact', 'verification_targets']);
    if (!validModes.has(mode)) {
      errors.push(`mode must be one of: ${Array.from(validModes).join(', ')}.`);
    }
    if (mode === 'outline' && !params.path) {
      errors.push('path is required when mode is outline.');
    }
    if (['references', 'call_graph'].includes(mode) && !params.query) {
      errors.push('query is required when mode is references or call_graph.');
    }
    if (mode === 'rename_impact' && !params.query) {
      errors.push('query is required when mode is rename_impact.');
    }
    if (params.direction && !['in', 'out', 'both'].includes(String(params.direction))) {
      errors.push('direction must be in, out, or both.');
    }
    return errors;
  },
  async execute(params, context) {
    normalizeInspectCodeContextParams(params);
    const contextEngine = context.contextEngine;
    if (!contextEngine) {
      return { mode: params.mode || 'summary', error: 'Context engine is not available for this tool call.' };
    }

    const mode = String(params.mode || 'summary').trim();
    const limit = Number.isFinite(params.limit) ? params.limit : 30;

    if (mode === 'outline') {
      return {
        mode,
        path: params.path,
        outline: contextEngine.getFileOutline(params.path).slice(0, limit)
      };
    }

    if (mode === 'references') {
      return {
        mode,
        query: params.query,
        references: contextEngine.getSymbolReferences(params.query, { limit })
      };
    }

    if (mode === 'call_graph') {
      return {
        mode,
        query: params.query,
        direction: params.direction || 'both',
        graph: contextEngine.getCallGraphFor(params.query, {
          direction: params.direction || 'both',
          limit
        })
      };
    }

    if (mode === 'diagnostics') {
      return {
        mode,
        path: params.path,
        diagnostics: contextEngine.getFileDiagnostics(params.path || '', { limit })
      };
    }

    if (mode === 'semantic_diagnostics') {
      return {
        mode,
        path: params.path,
        diagnostics: contextEngine.getSemanticDiagnostics(params.path || '', { limit }),
        semanticStatus: contextEngine.semanticStatus
      };
    }

    if (mode === 'rename_impact') {
      return {
        mode,
        query: params.query,
        impact: contextEngine.getRenameImpact(params.query, { limit })
      };
    }

    if (mode === 'verification_targets') {
      const changedFiles = String(params.changedFiles || '')
        .split(',')
        .map(file => file.trim())
        .filter(Boolean);
      return {
        mode,
        changedFiles,
        targets: contextEngine.getVerificationTargets(changedFiles)
      };
    }

    return {
      mode: 'summary',
      summary: contextEngine.getCodeIntelligenceSummary({ limit })
    };
  },
  summarizeForModel(result) {
    if (!result) return '[No result]';
    return `[inspect_code_context completed]\n${JSON.stringify(result, null, 2)}`;
  },
  summarizeForUi(result, params = {}) {
    const mode = result?.mode || params.mode || 'summary';
    const graphCount = (result?.graph?.outgoing?.length || 0) + (result?.graph?.incoming?.length || 0);
    const renameCount = result?.impact?.references?.length || 0;
    return {
      type: 'inspect_code_context',
      mode,
      query: params.query,
      path: params.path,
      count:
        result?.outline?.length ||
        result?.references?.length ||
        result?.diagnostics?.length ||
        renameCount ||
        graphCount ||
        result?.summary?.indexedFiles ||
        0
    };
  }
});

function normalizeInspectCodeContextParams(params = {}) {
  const modeAliases = {
    file_outline: 'outline',
    file_summary: 'summary',
    symbol_reference: 'references',
    symbol_references: 'references',
    reference: 'references',
    refs: 'references',
    callgraph: 'call_graph',
    call_graphs: 'call_graph',
    semantic: 'semantic_diagnostics',
    semantic_diagnostic: 'semantic_diagnostics',
    rename: 'rename_impact',
    verification: 'verification_targets',
    verification_target: 'verification_targets'
  };
  const directionAliases = {
    forward: 'out',
    forwards: 'out',
    outgoing: 'out',
    backward: 'in',
    backwards: 'in',
    incoming: 'in',
    bidirectional: 'both',
    all: 'both'
  };
  const rawMode = String(params.mode || '').trim().toLowerCase();
  const normalizedMode = rawMode.replace(/[\s-]+/g, '_');
  if (modeAliases[normalizedMode]) params.mode = modeAliases[normalizedMode];
  else if (normalizedMode) params.mode = normalizedMode;
  if (params.mode === 'call_graph' && !params.query && params.path) {
    params.query = params.path;
  }
  const rawDirection = String(params.direction || '').trim().toLowerCase();
  if (directionAliases[rawDirection]) params.direction = directionAliases[rawDirection];
}

// 11. search_project_memory
ToolRegistry.register({
  name: 'search_project_memory',
  description: 'Search durable project memory for prior decisions, fixes, and handoff notes.',
  riskLevel: RiskLevel.SAFE,
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Memory search query' },
      limit: { type: 'number', description: 'Maximum memory entries to return' }
    },
    required: ['query']
  },
  async execute(params, context) {
    const memoryStore = getMemoryStore(context);
    return {
      query: params.query,
      results: memoryStore.search(params.query, { limit: params.limit || 8 })
    };
  },
  summarizeForModel(result) {
    if (!result) return '[No result]';
    return `[search_project_memory completed]\n${JSON.stringify(result, null, 2)}`;
  },
  summarizeForUi(result, params = {}) {
    return {
      type: 'search_project_memory',
      query: params.query,
      matchesCount: result?.results?.length || 0
    };
  }
});

// 12. record_project_memory
ToolRegistry.register({
  name: 'record_project_memory',
  description: 'Record a durable project memory note for future agent runs.',
  riskLevel: RiskLevel.SAFE,
  inputSchema: {
    type: 'object',
    properties: {
      summary: { type: 'string', description: 'Concise durable memory summary' },
      type: { type: 'string', description: 'Memory type, for example decision, fix, run_summary, or handoff' },
      tags: { type: 'array', description: 'Optional tags' },
      source: { type: 'string', description: 'Optional source label' }
    },
    required: ['summary']
  },
  validate(params) {
    const errors = [];
    if (String(params.summary || '').trim().length < 8) {
      errors.push('summary must contain at least 8 non-whitespace characters.');
    }
    return errors;
  },
  async execute(params, context) {
    const memoryStore = getMemoryStore(context);
    const tags = Array.isArray(params.tags)
      ? params.tags
      : String(params.tags || '').split(',').map(tag => tag.trim()).filter(Boolean);
    const entry = memoryStore.append({
      summary: params.summary,
      type: params.type || 'note',
      tags,
      source: params.source || 'agent_tool'
    });
    return { recorded: true, entry };
  },
  summarizeForModel(result) {
    if (!result?.entry) return '[record_project_memory completed] No entry returned.';
    return `[record_project_memory completed]\nRecorded memory ${result.entry.id}: ${result.entry.summary}`;
  },
  summarizeForUi(result) {
    return {
      type: 'record_project_memory',
      recorded: !!result?.recorded,
      id: result?.entry?.id,
      memoryType: result?.entry?.type
    };
  }
});

// 9. web_search
ToolRegistry.register({
  name: 'web_search',
  description: 'Perform web search using tavily, brave, firecrawl, exa, or duckduckgo.',
  riskLevel: RiskLevel.SAFE,
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string' },
      provider: { type: 'string' }
    },
    required: ['query']
  },
  async execute(params, context) {
    return SearchService.search(params, context.config, { abortSignal: context.abortSignal });
  },
  summarizeForModel(result) {
    if (!result) return '[No result]';
    const data = result.result || result;
    const results = data.results || [];
    if (results.length === 0) return `[web_search completed: No results found]`;
    let out = `[web_search completed. Results found: ${results.length}]\n`;
    results.forEach((r, idx) => {
      out += `Result ${idx + 1}:\n- Title: ${r.title}\n- URL: ${r.url}\n- Snippet: ${r.snippet}\n`;
    });
    return out;
  },
  summarizeForUi(result, params = {}) {
    return { type: 'web_search', query: params.query, results: result?.results || result?.result?.results || [] };
  }
});

// 9. fetch_url
ToolRegistry.register({
  name: 'fetch_url',
  description: 'Fetch HTTP raw information of a website.',
  riskLevel: RiskLevel.SAFE,
  inputSchema: {
    type: 'object',
    properties: {
      url: { type: 'string' }
    },
    required: ['url']
  },
  async execute(params, context) {
    return HttpInspector.fetch(params, context.config, { abortSignal: context.abortSignal });
  },
  summarizeForModel(result) {
    if (!result) return '[No result]';
    const data = result.result || result;
    const status = data.http?.status || 'unknown';
    const bodyPreview = data.textPreview || data.body || '';
    return `[fetch_url completed. Status: ${status}]\nSource URL: ${data.finalUrl || data.url}\nRetrieved: ${data.timestamp || ''}\nPage text:\n${bodyPreview}`;
  },
  summarizeForUi(result, params = {}) {
    return { type: 'fetch_url', url: params.url, status: result?.http?.status };
  }
});

// 10. inspect_url
ToolRegistry.register({
  name: 'inspect_url',
  description: 'Deep security inspection on HTML elements and TLS details.',
  riskLevel: RiskLevel.SAFE,
  inputSchema: {
    type: 'object',
    properties: {
      url: { type: 'string' }
    },
    required: ['url']
  },
  async execute(params, context) {
    return HtmlInspector.inspect(params, context.config, { abortSignal: context.abortSignal });
  },
  summarizeForModel(result) {
    if (!result) return '[No result]';
    const data = result.result || result;
    const findings = data.findings || [];
    const secHeaders = data.securityHeaders || {};
    const findingsStr = findings.map(f => `- [${f.severity}] ${f.title}: ${f.evidence}`).join('\n');
    return `[inspect_url completed. Security Findings: ${findings.length}]\n${findingsStr || 'No findings.'}\nSecurity Headers status:\n${JSON.stringify(secHeaders, null, 2)}`;
  },
  summarizeForUi(result, params = {}) {
    return { type: 'inspect_url', url: params.url, findings: result?.findings || result?.result?.findings || [] };
  }
});

// 11. render_page
ToolRegistry.register({
  name: 'render_page',
  description: 'Render a webpage using dynamic browser elements.',
  riskLevel: RiskLevel.WARNING,
  inputSchema: {
    type: 'object',
    properties: {
      url: { type: 'string' }
    },
    required: ['url']
  },
  async execute(params, context) {
    return RenderInspector.render(params, context.config, { abortSignal: context.abortSignal });
  },
  summarizeForModel(result) {
    if (!result) return '[No result]';
    const data = result.result || result;
    const title = data.title || 'no title';
    const logs = data.consoleErrors || [];
    return `[render_page completed. Title: "${title}"]\nPreview content:\n${data.contentPreview || ''}\nConsole Errors:\n${logs.join('\n') || 'None'}`;
  },
  summarizeForUi(result, params = {}) {
    return { type: 'render_page', url: params.url, title: result?.title || result?.result?.title };
  }
});

// 12. crawl_site
ToolRegistry.register({
  name: 'crawl_site',
  description: 'Crawl pages recursively on a target domain with limit checks.',
  riskLevel: RiskLevel.WARNING,
  inputSchema: {
    type: 'object',
    properties: {
      url: { type: 'string' },
      depth: { type: 'number' },
      limit: { type: 'number' }
    },
    required: ['url']
  },
  validate(params) {
    const errors = [];
    if (params.depth !== undefined && params.depth < 0) errors.push('depth must be greater than or equal to 0.');
    if (params.limit !== undefined && params.limit < 1) errors.push('limit must be greater than or equal to 1.');
    return errors;
  },
  async execute(params, context) {
    return Crawler.crawl(params, context.config, { abortSignal: context.abortSignal });
  },
  summarizeForModel(result) {
    if (!result) return '[No result]';
    const data = result.result || result;
    const pages = data.results || [];
    let out = `[crawl_site completed. Pages crawled: ${pages.length}]\n`;
    pages.slice(0, 10).forEach((p, idx) => {
      out += `- Page ${idx + 1}: ${p.url} (status: ${p.status}, findings: ${p.findings?.length || 0})\n`;
    });
    return out;
  },
  summarizeForUi(result, params = {}) {
    return { type: 'crawl_site', url: params.url, resultsCount: (result?.results || result?.result?.results || []).length };
  }
});

// 13. monitor_target
ToolRegistry.register({
  name: 'monitor_target',
  description: 'Monitor changes on target urls and analyze visual/structure drift.',
  riskLevel: RiskLevel.WARNING,
  inputSchema: {
    type: 'object',
    properties: {
      url: { type: 'string' }
    },
    required: ['url']
  },
  async execute(params, context) {
    return EvidenceStore.monitor(params, context.config, { abortSignal: context.abortSignal });
  },
  summarizeForModel(result) {
    if (!result) return '[No result]';
    const data = result.result || result;
    const diffs = data.diffs || {};
    const details = diffs.details || [];
    return `[monitor_target completed. Changed: ${!!diffs.changed}]\nChanges:\n${details.join('\n') || 'No changes detected.'}`;
  },
  summarizeForUi(result, params = {}) {
    return { type: 'monitor_target', url: params.url, changed: result?.diffs?.changed || result?.result?.diffs?.changed };
  }
});

// 14. start_llama_cpp
ToolRegistry.register({
  name: 'start_llama_cpp',
  description: 'Start the local llama.cpp server.',
  riskLevel: RiskLevel.WARNING,
  inputSchema: {
    type: 'object',
    properties: {
      llamaCppServerPath: { type: 'string' },
      llamaCppModelPath: { type: 'string' }
    }
  },
  async execute(params, context) {
    return new LlamaCppRuntime(context.config).startServer(params);
  },
  summarizeForModel(result) {
    return `[start_llama_cpp completed] Local runtime server started.`;
  },
  summarizeForUi(result) {
    return { type: 'start_llama_cpp', success: true };
  }
});

// 15. stop_runtime
ToolRegistry.register({
  name: 'stop_runtime',
  description: 'Stop the local runtime inference server.',
  riskLevel: RiskLevel.WARNING,
  inputSchema: {},
  async execute(params, context) {
    return new LlamaCppRuntime(context.config).stopServer();
  },
  summarizeForModel(result) {
    return `[stop_runtime completed] Runtime server stopped.`;
  },
  summarizeForUi(result) {
    return { type: 'stop_runtime', success: true };
  }
});

function stripPatchPreviewPayload(result) {
  if (!result || typeof result !== 'object') return result;
  return {
    ...result,
    previews: (result.previews || []).map(preview => ({
      ok: preview.ok,
      type: preview.type,
      path: preview.path,
      error: preview.error,
      beforeSize: preview.beforeSize,
      afterSize: preview.afterSize,
      diff: preview.diff
    }))
  };
}

function getMemoryStore(context = {}) {
  if (context.memoryStore) {
    return context.memoryStore;
  }
  return new AgentMemoryStore({
    workspaceRoot: context.config?.workspaceRoot || '.',
    memoryPath: context.config?.agentMemoryPath,
    retentionLimit: context.config?.agentMemoryRetentionLimit || 200
  });
}
