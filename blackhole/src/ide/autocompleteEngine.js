import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { performance } from 'perf_hooks';
import { callLocalModel, resolveModelRoute } from '../agent/llmRouter.js';
import { PROJECT_ROOT } from '../common/paths.js';
import { CONFIG_DIR, loadConfig } from '../config/configStore.js';
import { getWorkspaceRoot } from '../workspace/workspaceManager.js';

const CACHE_TTL_MS = 5 * 60 * 1000;
const CACHE_LIMIT = 200;
const RECENT_EVENT_LIMIT = 500;
const DEFAULT_MAX_PREFIX = 5000;
const DEFAULT_MAX_SUFFIX = 2000;
const DEFAULT_MAX_SUGGESTION = 2400;

const completionCache = new Map();

export function normalizeAutocompletePayload(raw = {}, config = loadConfig()) {
  const maxPrefixChars = clampNumber(raw.maxPrefixChars ?? config.ideAutocompleteMaxPrefixChars, 500, 20000, DEFAULT_MAX_PREFIX);
  const maxSuffixChars = clampNumber(raw.maxSuffixChars ?? config.ideAutocompleteMaxSuffixChars, 250, 12000, DEFAULT_MAX_SUFFIX);
  const workspacePath = String(raw.workspacePath || config.workspaceRoot || getWorkspaceRoot() || PROJECT_ROOT);
  const file = String(raw.file || '');
  const absolutePath = String(raw.absolutePath || resolveCandidatePath({ workspacePath, file }));
  const prefix = trimTail(String(raw.prefix || ''), maxPrefixChars);
  const suffix = trimHead(String(raw.suffix || ''), maxSuffixChars);
  const languageId = String(raw.languageId || inferLanguageId(file || absolutePath));
  const currentLine = String(raw.currentLine || inferCurrentLine(prefix));

  const documentSignals = loadDocumentSignals({
    raw,
    file,
    absolutePath,
    languageId
  });

  return {
    file,
    absolutePath,
    languageId,
    workspacePath,
    prefix,
    suffix,
    currentLine,
    imports: normalizeSignalList(raw.imports, documentSignals.imports),
    symbols: normalizeSignalList(raw.symbols, documentSignals.symbols),
    maxSuggestionChars: clampNumber(raw.maxSuggestionChars, 200, 6000, DEFAULT_MAX_SUGGESTION)
  };
}

export function buildFimPrompt(payload) {
  const imports = payload.imports?.length ? payload.imports.slice(0, 30).join('\n') : '(none detected)';
  const symbols = payload.symbols?.length ? payload.symbols.slice(0, 60).join('\n') : '(none detected)';
  const systemPrompt = [
    'You are BlackHole Autocomplete, a low-latency code completion engine.',
    'Return only the code to insert at the cursor.',
    'Do not include markdown fences, prose, file names, or code that already exists around the cursor.',
    'Prefer compact, type-correct, multi-line completions when the prefix strongly implies a block.',
    'Return an empty response when the next code is ambiguous.'
  ].join('\n');
  const userPrompt = [
    `File: ${payload.file || 'untitled'}`,
    `Language: ${payload.languageId || 'plaintext'}`,
    `Workspace: ${payload.workspacePath || ''}`,
    `Current line before cursor: ${payload.currentLine || ''}`,
    '',
    '[Current file imports]',
    imports,
    '',
    '[Current file symbols]',
    symbols,
    '',
    '[FIM]',
    '<fim_prefix>',
    payload.prefix || '',
    '<fim_suffix>',
    payload.suffix || '',
    '<fim_middle>'
  ].join('\n');
  return { systemPrompt, userPrompt };
}

export async function generateAutocompleteSuggestion(raw = {}, options = {}) {
  const config = options.config || loadConfig();
  const payload = normalizeAutocompletePayload(raw, config);
  if (!payload.prefix && !payload.suffix) {
    return { ok: true, id: crypto.randomUUID(), suggestion: '', reason: 'empty editor context' };
  }

  pruneCompletionCache();
  const started = performance.now();
  const cacheKey = createAutocompleteCacheKey(payload, config);
  const cached = completionCache.get(cacheKey);
  if (cached && Date.now() - cached.createdAt <= CACHE_TTL_MS) {
    const id = crypto.randomUUID();
    const latencyMs = Math.round(performance.now() - started);
    recordAutocompleteOffer({
      id,
      payload,
      suggestion: cached.suggestion,
      route: cached.route,
      latencyMs,
      cacheHit: true,
      duplicateRemoved: cached.duplicateRemoved,
      metricsPath: options.metricsPath
    });
    return {
      ok: true,
      id,
      suggestion: cached.suggestion,
      route: cached.route,
      cacheHit: true,
      duplicateRemoved: cached.duplicateRemoved,
      latencyMs,
      engine: 'blackhole-autocomplete-v1',
      promptKind: 'fim'
    };
  }

  const { systemPrompt, userPrompt } = buildFimPrompt(payload);
  try {
    const callModel = options.callModel || callAutocompleteModel;
    const result = await callModel({
      config,
      payload,
      systemPrompt,
      userPrompt,
      maxTokens: clampNumber(raw.maxTokens, 64, 1024, 384),
      temperature: Number.isFinite(Number(raw.temperature)) ? Number(raw.temperature) : 0.03
    });
    const normalized = normalizeModelCompletion(result.text || '');
    const deduped = dedupeCompletion(normalized, payload);
    const suggestion = clampSuggestion(deduped.text, payload.maxSuggestionChars);
    const latencyMs = Math.round(performance.now() - started);
    const route = result.route || { model: config.activeModel || 'unknown' };

    rememberCompletion(cacheKey, {
      suggestion,
      route,
      duplicateRemoved: deduped.duplicateRemoved,
      createdAt: Date.now()
    });

    const id = crypto.randomUUID();
    recordAutocompleteOffer({
      id,
      payload,
      suggestion,
      route,
      latencyMs,
      cacheHit: false,
      duplicateRemoved: deduped.duplicateRemoved,
      metricsPath: options.metricsPath
    });

    return {
      ok: true,
      id,
      suggestion,
      route,
      cacheHit: false,
      duplicateRemoved: deduped.duplicateRemoved,
      latencyMs,
      engine: 'blackhole-autocomplete-v1',
      promptKind: 'fim'
    };
  } catch (error) {
    return {
      ok: false,
      id: crypto.randomUUID(),
      suggestion: '',
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

export function recordAutocompleteFeedback(raw = {}, options = {}) {
  const id = String(raw.id || '');
  const accepted = raw.accepted === true;
  const metricsPath = options.metricsPath;
  const metrics = readAutocompleteMetrics(metricsPath);
  const event = id ? metrics.recent.find(item => item.id === id) : null;
  if (event?.feedbackRecorded) {
    return decorateAutocompleteMetrics(metrics);
  }

  if (accepted) {
    metrics.totals.accepted += 1;
  } else {
    metrics.totals.rejected += 1;
  }

  const model = event?.model || String(raw.model || 'unknown');
  const modelStats = ensureModelStats(metrics, model);
  if (accepted) modelStats.accepted += 1;
  else modelStats.rejected += 1;

  if (event) {
    event.feedbackRecorded = true;
    event.accepted = accepted;
    event.feedbackAt = new Date().toISOString();
    event.insertedChars = raw.insertedText ? String(raw.insertedText).length : 0;
  } else {
    metrics.totals.unknownFeedback += 1;
    metrics.recent.unshift({
      id: id || crypto.randomUUID(),
      type: 'feedback',
      accepted,
      model,
      createdAt: new Date().toISOString(),
      feedbackRecorded: true
    });
  }

  trimRecent(metrics);
  writeAutocompleteMetrics(metrics, metricsPath);
  return decorateAutocompleteMetrics(metrics);
}

export function getAutocompleteMetrics(options = {}) {
  return decorateAutocompleteMetrics(readAutocompleteMetrics(options.metricsPath));
}

export async function runAutocompleteBenchmark(options = {}) {
  const cases = options.cases || readBenchmarkCases(options.casesPath);
  const modelLabel = options.modelLabel || (options.realModel ? 'real-local-model' : 'deterministic-baseline');
  const maxCases = Number(options.maxCases || cases.length || 0);
  const selectedCases = cases.slice(0, maxCases || cases.length);
  const startedAt = new Date().toISOString();
  const started = performance.now();
  const records = [];

  for (const testCase of selectedCases) {
    const caseStarted = performance.now();
    const result = await generateAutocompleteSuggestion(
      {
        ...testCase.input,
        file: testCase.file || testCase.input?.file,
        languageId: testCase.languageId || testCase.input?.languageId
      },
      {
        config: options.config,
        metricsPath: options.metricsPath,
        callModel: options.realModel
          ? options.callModel
          : async () => ({
            text: testCase.modelOutput || testCase.expected || '',
            route: { model: modelLabel, profile: 'autocomplete-benchmark' }
          })
      }
    );
    const expected = String(testCase.expected || testCase.expectedFragment || '');
    const passed = !!result.ok && (!expected || String(result.suggestion || '').includes(expected));
    records.push({
      id: testCase.id,
      type: testCase.type || 'completion',
      languageId: testCase.languageId || testCase.input?.languageId || '',
      passed,
      expected,
      suggestionPreview: String(result.suggestion || '').slice(0, 240),
      latencyMs: Math.round(performance.now() - caseStarted),
      cacheHit: result.cacheHit === true,
      duplicateRemoved: result.duplicateRemoved === true,
      error: result.error || ''
    });
  }

  const passed = records.filter(record => record.passed).length;
  const total = records.length;
  return {
    ok: records.every(record => record.passed),
    kind: 'autocomplete-benchmark',
    model: modelLabel,
    startedAt,
    durationMs: Math.round(performance.now() - started),
    total,
    passed,
    failed: total - passed,
    passAt1: total ? passed / total : 0,
    averageLatencyMs: total
      ? Math.round(records.reduce((sum, record) => sum + record.latencyMs, 0) / total)
      : 0,
    cacheHitRate: total
      ? records.filter(record => record.cacheHit).length / total
      : 0,
    duplicateRemovalRate: total
      ? records.filter(record => record.duplicateRemoved).length / total
      : 0,
    records
  };
}

export function createAutocompleteCacheKey(payload, config = {}) {
  const hash = crypto.createHash('sha256');
  const route = resolveModelRoute(config, { phase: 'act' });
  hash.update(JSON.stringify({
    model: route.model,
    maxTokens: route.maxTokens,
    file: payload.file,
    languageId: payload.languageId,
    prefix: trimTail(payload.prefix || '', 1200),
    suffix: trimHead(payload.suffix || '', 800),
    imports: payload.imports?.slice(0, 20) || [],
    symbols: payload.symbols?.slice(0, 40) || []
  }));
  return hash.digest('hex');
}

export function extractImportsAndSymbols(text = '', languageId = '') {
  const imports = [];
  const symbols = [];
  const source = String(text || '').slice(0, 300000);
  const lines = source.split(/\r?\n/);
  const language = String(languageId || '').toLowerCase();

  for (const line of lines.slice(0, 500)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (/^(import\s+.+|export\s+.+\s+from\s+['"].+['"];?|const\s+\w+\s*=\s*require\()/.test(trimmed)) {
      imports.push(trimmed.slice(0, 220));
    } else if (/^(from\s+\S+\s+import\s+.+|import\s+\S+)/.test(trimmed)) {
      imports.push(trimmed.slice(0, 220));
    }
  }

  const symbolPatterns = language.includes('python') || /\.py$/i.test(language)
    ? [
      /\b(?:async\s+def|def)\s+([A-Za-z_][\w]*)\s*\(/g,
      /\bclass\s+([A-Za-z_][\w]*)\s*[:(]/g
    ]
    : [
      /\b(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/g,
      /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/g,
      /\b(?:class|interface|type|enum)\s+([A-Za-z_$][\w$]*)\b/g,
      /\b(?:public|private|protected)?\s*(?:async\s+)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*[{;]/g
    ];

  for (const pattern of symbolPatterns) {
    let match;
    while ((match = pattern.exec(source)) && symbols.length < 120) {
      symbols.push(match[1]);
    }
  }

  return {
    imports: uniqueStrings(imports, 40),
    symbols: uniqueStrings(symbols, 120)
  };
}

export function dedupeCompletion(text = '', payload = {}) {
  let value = normalizeModelCompletion(text);
  let duplicateRemoved = false;
  const before = value;

  value = removeLeadingFimEcho(value);
  value = removePrefixOverlap(value, payload.prefix || '');
  value = removeSuffixOverlap(value, payload.suffix || '');
  value = collapseRepeatedBlocks(value);

  if (payload.suffix && String(payload.suffix).trimStart().startsWith(value.trim()) && value.trim().length > 0) {
    value = '';
  }

  if (value !== before) duplicateRemoved = true;
  return { text: value, duplicateRemoved };
}

function callAutocompleteModel({ config, systemPrompt, userPrompt, maxTokens, temperature }) {
  const scopedConfig = {
    ...config,
    agentModelProfiles: {
      ...(config.agentModelProfiles || {}),
      coder: {
        ...((config.agentModelProfiles || {}).coder || {}),
        maxTokens,
        temperature
      }
    }
  };
  let text = '';
  return callLocalModel(
    scopedConfig,
    systemPrompt,
    [{ role: 'user', content: userPrompt }],
    chunk => { text += chunk || ''; },
    {
      phase: 'act',
      task: 'ide autocomplete',
      maxTokens,
      allowIncomplete: true,
      estimatedTokens: estimateTokens(systemPrompt) + estimateTokens(userPrompt),
      usageTag: 'autocomplete'
    }
  ).then(route => ({ text: text.trim(), route }));
}

function normalizeModelCompletion(text) {
  const raw = stripCodeFences(String(text || '').replace(/\r\n/g, '\n'));
  return raw
    .replace(/<\/?fim_(?:prefix|suffix|middle)>/gi, '')
    .replace(/<\|fim_(?:prefix|suffix|middle)\|>/gi, '')
    .trimEnd();
}

function stripCodeFences(text) {
  const trimmed = String(text || '').trim();
  const fenced = trimmed.match(/^```[a-zA-Z0-9_-]*\s*\n([\s\S]*?)\n```$/);
  return fenced ? fenced[1].trimEnd() : trimmed;
}

function removeLeadingFimEcho(text) {
  const markerIndex = text.lastIndexOf('<fim_middle>');
  if (markerIndex >= 0) {
    return text.slice(markerIndex + '<fim_middle>'.length).trimStart();
  }
  return text;
}

function removePrefixOverlap(text, prefix) {
  if (!text || !prefix) return text;
  const max = Math.min(text.length, prefix.length, 500);
  for (let size = max; size > 0; size -= 1) {
    if (prefix.endsWith(text.slice(0, size))) {
      return text.slice(size);
    }
  }
  return text;
}

function removeSuffixOverlap(text, suffix) {
  if (!text || !suffix) return text;
  const max = Math.min(text.length, suffix.length, 500);
  for (let size = max; size > 0; size -= 1) {
    if (suffix.startsWith(text.slice(text.length - size))) {
      return text.slice(0, text.length - size);
    }
  }
  return text;
}

function collapseRepeatedBlocks(text) {
  const lines = String(text || '').split('\n');
  const collapsed = [];
  for (const line of lines) {
    if (line.trim() && collapsed[collapsed.length - 1]?.trim() === line.trim()) continue;
    collapsed.push(line);
  }
  let value = collapsed.join('\n');
  const half = Math.floor(value.length / 2);
  if (half > 20 && value.length % 2 === 0 && value.slice(0, half) === value.slice(half)) {
    value = value.slice(0, half);
  }
  return value;
}

function clampSuggestion(text, maxChars) {
  let value = String(text || '').slice(0, maxChars);
  if (value.length >= maxChars && value.includes('\n')) {
    value = value.slice(0, value.lastIndexOf('\n'));
  }
  return value.replace(/\n{4,}$/g, '\n\n').trimEnd();
}

function recordAutocompleteOffer({ id, payload, suggestion, route, latencyMs, cacheHit, duplicateRemoved, metricsPath }) {
  const metrics = readAutocompleteMetrics(metricsPath);
  const model = route?.model || 'unknown';
  metrics.totals.offered += 1;
  if (cacheHit) metrics.totals.cacheHits += 1;
  if (duplicateRemoved) metrics.totals.duplicateSuggestionsRemoved += 1;
  if (!String(suggestion || '').trim()) metrics.totals.emptySuggestions += 1;

  const modelStats = ensureModelStats(metrics, model);
  modelStats.offered += 1;
  modelStats.totalLatencyMs += Number(latencyMs || 0);
  modelStats.averageLatencyMs = Math.round(modelStats.totalLatencyMs / Math.max(1, modelStats.offered));
  if (cacheHit) modelStats.cacheHits += 1;
  if (duplicateRemoved) modelStats.duplicateSuggestionsRemoved += 1;
  if (!String(suggestion || '').trim()) modelStats.emptySuggestions += 1;

  metrics.recent.unshift({
    id,
    type: 'offer',
    model,
    file: payload.file || path.basename(payload.absolutePath || ''),
    languageId: payload.languageId,
    suggestionChars: String(suggestion || '').length,
    suggestionLines: String(suggestion || '').split('\n').length,
    latencyMs,
    cacheHit,
    duplicateRemoved,
    createdAt: new Date().toISOString(),
    feedbackRecorded: false
  });
  trimRecent(metrics);
  writeAutocompleteMetrics(metrics, metricsPath);
}

function readAutocompleteMetrics(metricsPath) {
  const targetPath = getMetricsPath(metricsPath);
  try {
    const loaded = JSON.parse(fs.readFileSync(targetPath, 'utf8'));
    return normalizeMetrics(loaded);
  } catch {
    return normalizeMetrics({});
  }
}

function writeAutocompleteMetrics(metrics, metricsPath) {
  const targetPath = getMetricsPath(metricsPath);
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  const payload = normalizeMetrics(metrics);
  payload.updatedAt = new Date().toISOString();
  fs.writeFileSync(targetPath, JSON.stringify(payload, null, 2));
}

function getMetricsPath(metricsPath) {
  return metricsPath || process.env.BLACKHOLE_AUTOCOMPLETE_METRICS_PATH || path.join(CONFIG_DIR, 'autocomplete-metrics.json');
}

function normalizeMetrics(metrics) {
  return {
    version: 1,
    updatedAt: metrics.updatedAt || '',
    totals: {
      offered: Number(metrics.totals?.offered || 0),
      accepted: Number(metrics.totals?.accepted || 0),
      rejected: Number(metrics.totals?.rejected || 0),
      unknownFeedback: Number(metrics.totals?.unknownFeedback || 0),
      cacheHits: Number(metrics.totals?.cacheHits || 0),
      duplicateSuggestionsRemoved: Number(metrics.totals?.duplicateSuggestionsRemoved || 0),
      emptySuggestions: Number(metrics.totals?.emptySuggestions || 0)
    },
    byModel: metrics.byModel && typeof metrics.byModel === 'object' ? metrics.byModel : {},
    recent: Array.isArray(metrics.recent) ? metrics.recent.slice(0, RECENT_EVENT_LIMIT) : []
  };
}

function decorateAutocompleteMetrics(metrics) {
  const totalFeedback = metrics.totals.accepted + metrics.totals.rejected;
  const decorated = normalizeMetrics(metrics);
  decorated.acceptanceRate = totalFeedback ? decorated.totals.accepted / totalFeedback : 0;
  decorated.cacheHitRate = decorated.totals.offered ? decorated.totals.cacheHits / decorated.totals.offered : 0;
  decorated.duplicateRemovalRate = decorated.totals.offered
    ? decorated.totals.duplicateSuggestionsRemoved / decorated.totals.offered
    : 0;
  for (const [model, stats] of Object.entries(decorated.byModel)) {
    const feedback = Number(stats.accepted || 0) + Number(stats.rejected || 0);
    decorated.byModel[model] = {
      ...stats,
      acceptanceRate: feedback ? Number(stats.accepted || 0) / feedback : 0,
      cacheHitRate: stats.offered ? Number(stats.cacheHits || 0) / Number(stats.offered || 1) : 0
    };
  }
  return decorated;
}

function ensureModelStats(metrics, model) {
  const key = String(model || 'unknown');
  if (!metrics.byModel[key]) {
    metrics.byModel[key] = {
      offered: 0,
      accepted: 0,
      rejected: 0,
      cacheHits: 0,
      duplicateSuggestionsRemoved: 0,
      emptySuggestions: 0,
      totalLatencyMs: 0,
      averageLatencyMs: 0
    };
  }
  return metrics.byModel[key];
}

function trimRecent(metrics) {
  metrics.recent = metrics.recent.slice(0, RECENT_EVENT_LIMIT);
}

function rememberCompletion(key, value) {
  completionCache.set(key, value);
  while (completionCache.size > CACHE_LIMIT) {
    const firstKey = completionCache.keys().next().value;
    completionCache.delete(firstKey);
  }
}

function pruneCompletionCache() {
  const now = Date.now();
  for (const [key, value] of completionCache.entries()) {
    if (now - value.createdAt > CACHE_TTL_MS) {
      completionCache.delete(key);
    }
  }
}

function loadDocumentSignals({ raw, file, absolutePath, languageId }) {
  if (raw.documentText) {
    return extractImportsAndSymbols(String(raw.documentText), languageId);
  }
  const candidatePath = absolutePath || resolveCandidatePath({ workspacePath: raw.workspacePath, file });
  try {
    if (candidatePath && fs.existsSync(candidatePath) && fs.statSync(candidatePath).isFile()) {
      const text = fs.readFileSync(candidatePath, 'utf8');
      return extractImportsAndSymbols(text, languageId);
    }
  } catch {
    // Editor-provided prefix/suffix is enough when the backing file cannot be read.
  }
  return { imports: [], symbols: [] };
}

function resolveCandidatePath({ workspacePath, file }) {
  if (!file) return '';
  if (path.isAbsolute(file)) return path.resolve(file);
  if (workspacePath) return path.resolve(workspacePath, file);
  return path.resolve(getWorkspaceRoot() || PROJECT_ROOT, file);
}

function normalizeSignalList(value, fallback = []) {
  const source = Array.isArray(value)
    ? value
    : String(value || '').split(/\r?\n/);
  const normalized = source
    .map(item => String(item || '').trim())
    .filter(Boolean);
  return uniqueStrings(normalized.length ? normalized : fallback, 120);
}

function uniqueStrings(values, limit) {
  return Array.from(new Set((values || []).map(value => String(value || '').trim()).filter(Boolean))).slice(0, limit);
}

function inferCurrentLine(prefix) {
  return String(prefix || '').split('\n').pop() || '';
}

function inferLanguageId(file) {
  const ext = path.extname(String(file || '')).toLowerCase();
  const map = {
    '.js': 'javascript',
    '.jsx': 'javascriptreact',
    '.ts': 'typescript',
    '.tsx': 'typescriptreact',
    '.py': 'python',
    '.json': 'json',
    '.md': 'markdown',
    '.css': 'css',
    '.html': 'html'
  };
  return map[ext] || 'plaintext';
}

function trimTail(text, maxChars) {
  if (text.length <= maxChars) return text;
  return text.slice(text.length - maxChars);
}

function trimHead(text, maxChars) {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars);
}

function clampNumber(value, min, max, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function estimateTokens(text) {
  return Math.ceil(String(text || '').length / 4);
}

function readBenchmarkCases(casesPath) {
  const targetPath = casesPath || path.join(PROJECT_ROOT, 'benchmarks', 'autocomplete', 'autocomplete-cases.json');
  try {
    const loaded = JSON.parse(fs.readFileSync(targetPath, 'utf8'));
    return Array.isArray(loaded.cases) ? loaded.cases : [];
  } catch {
    return [];
  }
}
