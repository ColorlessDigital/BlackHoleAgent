const TOOL_BLOCK_TAGS = [
  'write_file',
  'patch_file',
  'patch_lines'
];

const TOOL_INLINE_TAGS = [
  'list_dir',
  'read_file',
  'run_command',
  'project_search',
  'inspect_code_context',
  'web_search',
  'fetch_url',
  'inspect_url',
  'render_page',
  'crawl_site',
  'monitor_target',
  'start_llama_cpp',
  'stop_runtime'
];

const RESERVED_TOOL_KEYS = new Set([
  'tool',
  'tool_name',
  'name',
  'params',
  'parameters',
  'arguments',
  'args',
  'input',
  'function'
]);

export function parseAllToolCalls(content) {
  return collectToolCalls(content).map(match => ({
    tool: match.tool,
    params: match.params
  }));
}

export function parseToolCall(content) {
  const all = parseAllToolCalls(content);
  return all.length > 0 ? all[0] : null;
}

export function stripToolCallMarkup(content) {
  const source = String(content || '');
  const matches = collectToolCalls(source);
  if (matches.length === 0) return source.trim();

  let stripped = source;
  const ranges = matches
    .filter(match => Number.isInteger(match.index) && Number.isInteger(match.end) && match.end > match.index)
    .sort((a, b) => b.index - a.index);

  for (const range of ranges) {
    stripped = `${stripped.slice(0, range.index)}${stripped.slice(range.end)}`;
  }

  return stripped.trim();
}

function collectToolCalls(content) {
  if (!content) return [];
  const source = String(content);
  const matches = [];

  collectXmlMatches(source, matches);
  collectJsonMatches(source, matches);

  if (matches.length === 0) return [];

  matches.sort((a, b) => a.index - b.index);
  const seen = new Set();
  return matches.filter(match => {
    const signature = `${match.index}:${match.end}:${match.tool}:${stableStringify(match.params)}`;
    if (seen.has(signature)) return false;
    seen.add(signature);
    return true;
  });
}

function collectXmlMatches(source, matches) {
  function collectMatches(regex, toolName, paramBuilder) {
    let match;
    const gRegex = new RegExp(regex.source, regex.flags.includes('g') ? regex.flags : `${regex.flags}g`);
    while ((match = gRegex.exec(source)) !== null) {
      const params = paramBuilder(match);
      if (params) {
        matches.push({
          tool: toolName,
          index: match.index,
          end: gRegex.lastIndex,
          params
        });
      }
    }
  }

  collectMatches(
    /<list_dir\s+[^>]*path=["']([^"']+)["'][^>]*\/?>/i,
    'list_dir',
    (m) => {
      const params = { path: m[1] };
      for (const name of ['depth', 'limit', 'offset']) {
        const value = m[0].match(new RegExp(`\\b${name}=["'](\\d+)["']`, 'i'));
        if (value) params[name] = Number(value[1]);
      }
      return params;
    }
  );

  collectMatches(
    /<read_file\s+[^>]*path=["']([^"']+)["'][^>]*\/?>/i,
    'read_file',
    (m) => {
      const params = { path: m[1] };
      for (const name of ['startLine', 'lineCount']) {
        const value = m[0].match(new RegExp(`\\b${name}=["']([^"']*)["']`, 'i'));
        if (value) params[name] = Number(value[1]);
      }
      return params;
    }
  );

  collectMatches(
    /<run_command\s+[^>]*(?:cmd|command)=["']([^"']+)["'][^>]*\/?>/i,
    'run_command',
    (m) => {
      const cwdMatch = m[0].match(/cwd=["']([^"']+)["']/i);
      const params = { command: m[1] };
      if (cwdMatch) params.cwd = cwdMatch[1];
      return params;
    }
  );

  collectMatches(
    /<project_search\s+[^>]*query=["']([^"']+)["'][^>]*\/?>/i,
    'project_search',
    (m) => ({ query: m[1] })
  );

  collectMatches(
    /<inspect_code_context\s+([^>]*)\/?>/i,
    'inspect_code_context',
    (m) => {
      const params = {};
      for (const key of ['mode', 'query', 'path', 'direction', 'changedFiles']) {
        const attrMatch = m[0].match(new RegExp(`${key}=["']([^"']+)["']`, 'i'));
        if (attrMatch) params[key] = attrMatch[1];
      }
      const limitMatch = m[0].match(/limit=["'](\d+)["']/i);
      if (limitMatch) params.limit = Number(limitMatch[1]);
      return params;
    }
  );

  collectMatches(
    /<web_search\s+[^>]*query=["']([^"']+)["'][^>]*\/?>/i,
    'web_search',
    (m) => {
      const providerMatch = m[0].match(/provider=["']([^"']+)["']/i);
      return {
        query: m[1],
        provider: providerMatch ? providerMatch[1] : undefined
      };
    }
  );

  collectMatches(
    /<fetch_url\s+[^>]*url=["']([^"']+)["'][^>]*\/?>/i,
    'fetch_url',
    (m) => ({ url: m[1] })
  );

  collectMatches(
    /<inspect_url\s+[^>]*url=["']([^"']+)["'][^>]*\/?>/i,
    'inspect_url',
    (m) => ({ url: m[1] })
  );

  collectMatches(
    /<render_page\s+[^>]*url=["']([^"']+)["'][^>]*\/?>/i,
    'render_page',
    (m) => ({ url: m[1] })
  );

  collectMatches(
    /<crawl_site\s+[^>]*url=["']([^"']+)["'][^>]*\/?>/i,
    'crawl_site',
    (m) => {
      const depthMatch = m[0].match(/depth=["'](\d+)["']/i);
      const limitMatch = m[0].match(/limit=["'](\d+)["']/i);
      return {
        url: m[1],
        depth: depthMatch ? Number(depthMatch[1]) : 1,
        limit: limitMatch ? Number(limitMatch[1]) : 20
      };
    }
  );

  collectMatches(
    /<monitor_target\s+[^>]*url=["']([^"']+)["'][^>]*\/?>/i,
    'monitor_target',
    (m) => ({ url: m[1] })
  );

  collectMatches(
    /<write_file\s+[^>]*path=["']([^"']+)["'][^>]*>([\s\S]*?)<\/write_file>/i,
    'write_file',
    (m) => ({ path: m[1], content: m[2] })
  );

  collectMatches(
    /<patch_file\s+[^>]*path=["']([^"']+)["'][^>]*>([\s\S]*?)<\/patch_file>/i,
    'patch_file',
    (m) => {
      const search = m[2].match(/<search>([\s\S]*?)<\/search>/i);
      const replace = m[2].match(/<replace>([\s\S]*?)<\/replace>/i);
      return (search && replace) ? { path: m[1], search: search[1], replace: replace[1] } : null;
    }
  );

  collectMatches(
    /<patch_lines\s+[^>]*path=["']([^"']+)["']\s+[^>]*startLine=["'](\d+)["']\s+[^>]*endLine=["'](\d+)["'][^>]*>([\s\S]*?)<\/patch_lines>/i,
    'patch_lines',
    (m) => ({
      path: m[1],
      startLine: Number(m[2]),
      endLine: Number(m[3]),
      replacement: m[4]
    })
  );

  collectMatches(
    /<start_llama_cpp\s+([^>]*)\/?>/i,
    'start_llama_cpp',
    (m) => {
      const serverMatch = m[0].match(/llamaCppServerPath=["']([^"']+)["']/i);
      const modelMatch = m[0].match(/llamaCppModelPath=["']([^"']+)["']/i);
      return {
        ...(serverMatch ? { llamaCppServerPath: serverMatch[1] } : {}),
        ...(modelMatch ? { llamaCppModelPath: modelMatch[1] } : {})
      };
    }
  );

  collectMatches(
    /<stop_runtime\s*\/?>/i,
    'stop_runtime',
    () => ({})
  );
}

function collectJsonMatches(source, matches) {
  const fencedCandidates = getJsonFenceCandidates(source);
  for (const candidate of fencedCandidates) {
    appendJsonToolCalls(candidate.text, candidate.index, candidate.end, matches);
  }

  for (const candidate of getBalancedJsonCandidates(source)) {
    if (fencedCandidates.some(fenced => candidate.index >= fenced.index && candidate.end <= fenced.end)) {
      continue;
    }
    appendJsonToolCalls(candidate.text, candidate.index, candidate.end, matches);
  }
}

function getJsonFenceCandidates(source) {
  const candidates = [];
  const fenceRegex = /```(?:json|tool|tools|tool_calls)?\s*\n?([\s\S]*?)```/gi;
  let match;
  while ((match = fenceRegex.exec(source)) !== null) {
    const body = match[1].trim();
    if (!body) continue;
    const bodyOffset = match[0].indexOf(match[1]);
    candidates.push({
      text: body,
      index: match.index + Math.max(bodyOffset, 0),
      end: match.index + match[0].lastIndexOf(match[1]) + match[1].length
    });
  }
  return candidates;
}

function getBalancedJsonCandidates(source) {
  const candidates = [];
  for (let i = 0; i < source.length; i++) {
    const startChar = source[i];
    if (startChar !== '{' && startChar !== '[') continue;

    const end = findBalancedJsonEnd(source, i);
    if (end === -1) continue;

    candidates.push({
      text: source.slice(i, end + 1),
      index: i,
      end: end + 1
    });
    i = end;
  }
  return candidates;
}

function findBalancedJsonEnd(source, startIndex) {
  const opener = source[startIndex];
  const closer = opener === '{' ? '}' : ']';
  const stack = [closer];
  let inString = false;
  let escape = false;

  for (let i = startIndex + 1; i < source.length; i++) {
    const ch = source[i];

    if (inString) {
      if (escape) {
        escape = false;
      } else if (ch === '\\') {
        escape = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }

    if (ch === '{') {
      stack.push('}');
    } else if (ch === '[') {
      stack.push(']');
    } else if (ch === '}' || ch === ']') {
      if (stack.pop() !== ch) return -1;
      if (stack.length === 0) return i;
    }
  }

  return -1;
}

function tryParseJsonResilient(text) {
  if (!text || typeof text !== 'string') return null;
  const raw = text.trim();
  try {
    return JSON.parse(raw);
  } catch {
    // Attempt resilient repairs
  }

  try {
    // 1. Strip JS comments (// ... and /* ... */)
    let cleaned = raw.replace(/\/\*[\s\S]*?\*\/|([^:]|^)\/\/.*$/gm, '$1');
    // 2. Remove trailing commas before } or ]
    cleaned = cleaned.replace(/,(\s*[}\]])/g, '$1');
    // 3. Replace single-quoted property keys or string values with double quotes if safe
    cleaned = cleaned.replace(/'([^'\\]*(?:\\.[^'\\]*)*)'/g, '"$1"');
    // 4. Quote unquoted keys (e.g. { tool: "read_file" } -> { "tool": "read_file" })
    cleaned = cleaned.replace(/([{\s,])([a-zA-Z0-9_]+)\s*:/g, '$1"$2":');

    return JSON.parse(cleaned);
  } catch {
    return null;
  }
}

function appendJsonToolCalls(jsonText, index, end, matches) {
  const parsed = tryParseJsonResilient(jsonText);
  if (!parsed) return;

  const calls = normalizeJsonToolCalls(parsed);
  for (const call of calls) {
    matches.push({
      ...call,
      index,
      end
    });
  }
}

function normalizeJsonToolCalls(value) {
  if (!value) return [];

  if (Array.isArray(value)) {
    return value.flatMap(item => normalizeJsonToolCalls(item));
  }

  if (typeof value !== 'object') return [];

  const collections = [value.tool_calls, value.tools, value.calls].filter(Array.isArray);
  if (collections.length > 0) {
    return collections.flatMap(collection => collection.flatMap(item => normalizeJsonToolCalls(item)));
  }

  if (value.function && typeof value.function === 'object') {
    const functionName = value.function.name || value.name;
    const functionArgs = value.function.arguments ?? value.arguments ?? value.params;
    return normalizeOneToolCall(functionName, functionArgs, value);
  }

  const toolName = value.tool || value.tool_name || value.name;
  const params = value.params ?? value.parameters ?? value.arguments ?? value.args ?? value.input;
  return normalizeOneToolCall(toolName, params, value);
}

function normalizeOneToolCall(toolName, paramsValue, sourceObject = {}) {
  const tool = typeof toolName === 'string' ? toolName.trim() : '';
  if (!tool) return [];

  let params = normalizeParams(paramsValue);
  if (isPlainEmptyObject(params)) {
    const rest = {};
    for (const [key, value] of Object.entries(sourceObject)) {
      if (!RESERVED_TOOL_KEYS.has(key)) {
        rest[key] = value;
      }
    }
    if (Object.keys(rest).length > 0) {
      params = rest;
    }
  }

  return [{ tool, params }];
}

function normalizeParams(value) {
  if (value === undefined || value === null) return {};
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return {};
    try {
      const parsed = JSON.parse(trimmed);
      return normalizeParams(parsed);
    } catch {
      return { arguments: value };
    }
  }
  if (typeof value === 'object') return value;
  return { value };
}

function isPlainEmptyObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0;
}

function stableStringify(value) {
  try {
    return JSON.stringify(value, Object.keys(value || {}).sort());
  } catch {
    return String(value);
  }
}

const KNOWN_TOOLS = new Set([
  'list_dir', 'read_file', 'write_file', 'patch_file', 'patch_lines',
  'run_command', 'project_search', 'inspect_code_context', 'web_search',
  'fetch_url', 'inspect_url', 'render_page', 'crawl_site', 'monitor_target'
]);

export function detectMalformedToolCall(content) {
  if (!content || typeof content !== 'string') return null;
  const parsed = parseAllToolCalls(content);
  if (parsed.length > 0) return null;

  for (const tool of KNOWN_TOOLS) {
    const openingTagRegex = new RegExp(`(?:<|&lt;)${tool}\\b`, 'i');
    if (openingTagRegex.test(content)) {
      return {
        tool,
        type: 'unclosed_or_malformed_xml',
        reason: `Detected intent to call "${tool}" in XML, but tag was unclosed or malformed.`
      };
    }
  }

  const jsonIntentRegex = /"tool"\s*:\s*"([a-zA-Z0-9_-]+)"|"tool_name"\s*:\s*"([a-zA-Z0-9_-]+)"/i;
  const jsonMatch = content.match(jsonIntentRegex);
  if (jsonMatch) {
    const intendedTool = jsonMatch[1] || jsonMatch[2];
    return {
      tool: intendedTool,
      type: 'malformed_json_tool_call',
      reason: `Detected JSON tool call intent for "${intendedTool}", but JSON formatting was broken.`
    };
  }

  return null;
}

export function buildToolCorrectionPrompt(malformedInfo) {
  if (!malformedInfo) return '';
  if (malformedInfo.native) {
    return `[System Correction Notice]
Your completed response contained invalid native function-call data (${malformedInfo.reason}).
No tool from that response was executed. Return the corrected native function call using the provided tool declarations.
The function name must exactly match a declared name; put all parameters in its JSON argument object, not in the name. Do not include XML markup in native function names.`;
  }
  const tool = malformedInfo.tool || 'the tool';
  const examples = {
    write_file: '<write_file path="path/to/file.js">content</write_file>',
    read_file: '<read_file path="path/to/file.js" />',
    list_dir: '<list_dir path="." />',
    patch_file: '<patch_file path="path/to/file.js"><search>old code</search><replace>new code</replace></patch_file>',
    patch_lines: '<patch_lines path="path/to/file.js" startLine="1" endLine="2">replacement code</patch_lines>',
    run_command: '<run_command command="echo example" />'
  };
  const exampleSnippet = examples[tool] || `<${tool} />`;

  return `[System Correction Notice]
Your previous response appeared to call "${tool}", but the format was incomplete or invalid (${malformedInfo.reason}).
Output ONLY the corrected tool call directly now.
Example:
${exampleSnippet}`;
}
