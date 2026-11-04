import fs from 'fs';
import path from 'path';

export const DEFAULT_WORKSPACE_STANDARD = {
  version: 1,
  workspace: {
    name: '',
    agentProfile: 'default',
    codingStandard: 'default'
  },
  agent: {
    profile: 'default',
    prompts: [],
    rules: []
  },
  prCheck: {
    enabled: true,
    rules: []
  },
  models: {
    file: 'models.yaml'
  }
};

const DERIVED_CONFIG_KEYS = new Set(['workspaceStandard']);

export function loadWorkspaceStandardConfig({ workspaceRoot = '.' } = {}) {
  const root = path.resolve(workspaceRoot || '.');
  const blackholeDir = path.join(root, '.blackhole');
  const configPath = firstExisting([
    path.join(blackholeDir, 'config.yaml'),
    path.join(blackholeDir, 'config.yml')
  ]);
  const rawConfig = configPath
    ? parseSimpleYaml(fs.readFileSync(configPath, 'utf8'))
    : {};
  const config = mergeDeep(DEFAULT_WORKSPACE_STANDARD, rawConfig || {});
  const profile = String(
    config.agent?.profile
      || config.workspace?.agentProfile
      || 'default'
  );

  const modelsPath = resolveBlackholeReference(
    root,
    blackholeDir,
    config.models?.file || 'models.yaml'
  );
  const models = fs.existsSync(modelsPath)
    ? parseSimpleYaml(fs.readFileSync(modelsPath, 'utf8'))
    : {};

  const rules = loadMarkdownSet({
    root,
    blackholeDir,
    directory: path.join(blackholeDir, 'rules'),
    refs: normalizeRefList(config.agent?.rules || config.rules)
  });
  const prompts = loadMarkdownSet({
    root,
    blackholeDir,
    directory: path.join(blackholeDir, 'prompts'),
    refs: normalizeRefList(config.agent?.prompts || config.prompts)
  });

  const modelProfile = resolveModelProfile(models, profile);
  return {
    enabled: fs.existsSync(blackholeDir),
    workspaceRoot: root,
    blackholeDir,
    configPath: configPath || '',
    modelsPath: fs.existsSync(modelsPath) ? modelsPath : '',
    profile,
    config,
    models,
    modelProfile,
    rules,
    prompts,
    promptSection: buildWorkspacePromptSection({
      profile,
      workspace: config.workspace || {},
      rules,
      prompts
    })
  };
}

export function applyWorkspaceStandardToConfig(config = {}) {
  if (process.env.BLACKHOLE_DISABLE_WORKSPACE_STANDARD === '1' || config.workspaceStandardEnabled === false) {
    return {
      ...config,
      workspaceStandard: { enabled: false, profile: 'disabled', configPath: '', modelsPath: '', rules: [], prompts: [] }
    };
  }
  const standard = loadWorkspaceStandardConfig({
    workspaceRoot: config.workspaceRoot || '.'
  });
  if (!standard.enabled) {
    return {
      ...config,
      workspaceStandard: summarizeWorkspaceStandard(standard)
    };
  }

  const overlay = standard.modelProfile || {};
  const scalarOverlay = pickDefined(overlay, [
    'activeModel',
    'contextLimit',
    'maxTokens',
    'temperature',
    'selfHealingMaxCycles',
    'agentMaxSteps',
    'agentModelRoutingEnabled',
    'opengoEnabled',
    'opengoPreset',
    'opengoBaseUrl',
    'opengoDefaultModel',
    'opencodeGoEnabled',
    'opencodeGoDefaultModel',
    'opencodeGoProtocolOverrides',
    'opencodeGoRequestTimeoutMs'
  ]);
  const mergedProfiles = mergeDeep(
    config.agentModelProfiles || {},
    overlay.agentModelProfiles || {}
  );
  const basePrompt = config.systemInstruction || '';
  const systemInstruction = standard.promptSection
    ? `${basePrompt}\n\n${standard.promptSection}`.trim()
    : basePrompt;

  return {
    ...config,
    ...scalarOverlay,
    localRuntime: String(scalarOverlay.activeModel || config.activeModel || '').startsWith('opencode-go:')
      ? 'opencode-go' : config.localRuntime,
    agentModelProfiles: mergedProfiles,
    systemInstruction,
    workspaceStandard: summarizeWorkspaceStandard(standard)
  };
}

export function stripWorkspaceDerivedConfig(config = {}) {
  const clean = {};
  for (const [key, value] of Object.entries(config || {})) {
    if (DERIVED_CONFIG_KEYS.has(key)) {
      continue;
    }
    if (key === 'systemInstruction' && typeof value === 'string') {
      clean[key] = value.split(/\n\n\[Workspace Agent Profile\]/)[0].trim();
    } else {
      clean[key] = value;
    }
  }
  return clean;
}

export function summarizeWorkspaceStandard(standard = {}) {
  return {
    enabled: !!standard.enabled,
    profile: standard.profile || 'default',
    configPath: standard.configPath || '',
    modelsPath: standard.modelsPath || '',
    rules: (standard.rules || []).map(item => ({
      id: item.id,
      title: item.title,
      path: item.relativePath,
      directiveCount: item.directives.length
    })),
    prompts: (standard.prompts || []).map(item => ({
      id: item.id,
      title: item.title,
      path: item.relativePath
    }))
  };
}

export function parseRuleDirectives(content = '') {
  const directives = [];
  const lines = String(content || '').split(/\r?\n/);
  const pattern = /^\s*[-*]\s*(require-file|forbid-path|forbid-text|require-script|require-config)\s*:\s*(.+?)\s*$/i;
  for (const line of lines) {
    const match = line.match(pattern);
    if (!match) continue;
    directives.push({
      type: match[1].toLowerCase(),
      value: stripQuotes(match[2].trim())
    });
  }
  return directives;
}

export function parseSimpleYaml(text) {
  const root = {};
  const stack = [{ indent: -1, value: root }];
  const lines = String(text || '').split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index];
    if (!raw.trim() || raw.trim().startsWith('#')) continue;
    const indent = raw.match(/^\s*/)[0].length;
    const trimmed = raw.trim();

    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) {
      stack.pop();
    }

    const parent = stack[stack.length - 1].value;
    if (trimmed.startsWith('- ')) {
      if (!Array.isArray(parent)) continue;
      parent.push(parseYamlScalar(trimmed.slice(2)));
      continue;
    }

    const separator = trimmed.indexOf(':');
    if (separator === -1) continue;
    const key = stripQuotes(trimmed.slice(0, separator).trim());
    const valueText = trimmed.slice(separator + 1).trim();

    if (valueText) {
      parent[key] = parseYamlScalar(valueText);
      continue;
    }

    const next = lines.slice(index + 1).find(line => line.trim() && !line.trim().startsWith('#'));
    const child = next?.trim().startsWith('- ') ? [] : {};
    parent[key] = child;
    stack.push({ indent, value: child });
  }

  return root;
}

function loadMarkdownSet({ root, blackholeDir, directory, refs }) {
  const paths = refs.length > 0
    ? refs.map(ref => resolveBlackholeReference(root, blackholeDir, ref))
    : listMarkdownFiles(directory);

  return paths
    .filter(filePath => fs.existsSync(filePath) && fs.statSync(filePath).isFile())
    .map(filePath => {
      const content = fs.readFileSync(filePath, 'utf8');
      const relativePath = path.relative(blackholeDir, filePath).replace(/\\/g, '/');
      return {
        id: path.basename(filePath, path.extname(filePath)),
        title: inferMarkdownTitle(content, path.basename(filePath)),
        path: filePath,
        relativePath,
        content,
        directives: parseRuleDirectives(content)
      };
    });
}

function buildWorkspacePromptSection({ profile, workspace, rules, prompts }) {
  const sections = [];
  sections.push(`[Workspace Agent Profile]\nProfile: ${profile}\nWorkspace: ${workspace.name || 'unnamed'}\nCoding standard: ${workspace.codingStandard || 'default'}`);

  if (prompts.length > 0) {
    sections.push(`[Workspace Prompts]\n${prompts.map(item => formatMarkdownBlock(item)).join('\n\n')}`);
  }
  if (rules.length > 0) {
    sections.push(`[Workspace Coding Rules]\n${rules.map(item => formatMarkdownBlock(item)).join('\n\n')}`);
  }

  return sections.join('\n\n');
}

function formatMarkdownBlock(item) {
  return `### ${item.title} (${item.relativePath})\n${item.content.trim()}`;
}

function resolveModelProfile(models, profile) {
  const profiles = models?.profiles || {};
  return profiles[profile] || profiles.default || {};
}

function normalizeRefList(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  if (typeof value === 'string') {
    return value.split(',').map(item => item.trim()).filter(Boolean);
  }
  return [];
}

function resolveBlackholeReference(root, blackholeDir, ref) {
  const value = String(ref || '').trim();
  if (!value) return blackholeDir;
  if (path.isAbsolute(value)) return path.normalize(value);
  if (value.startsWith('.blackhole/')) return path.join(root, value);
  if (value.startsWith('.blackhole\\')) return path.join(root, value);
  return path.join(blackholeDir, value);
}

function listMarkdownFiles(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory)
    .filter(file => file.toLowerCase().endsWith('.md'))
    .sort((a, b) => a.localeCompare(b))
    .map(file => path.join(directory, file));
}

function inferMarkdownTitle(content, fallback) {
  const heading = String(content || '').split(/\r?\n/).find(line => line.startsWith('# '));
  return heading ? heading.replace(/^#\s+/, '').trim() : fallback;
}

function firstExisting(paths) {
  return paths.find(filePath => fs.existsSync(filePath)) || '';
}

function parseYamlScalar(value) {
  const trimmed = String(value || '').trim();
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (trimmed === 'null') return null;
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    try {
      return JSON.parse(trimmed.replace(/'/g, '"'));
    } catch {
      return trimmed.slice(1, -1).split(',').map(item => parseYamlScalar(item.trim()));
    }
  }
  return trimmed;
}

function stripQuotes(value) {
  const text = String(value || '');
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
    return text.slice(1, -1);
  }
  return text;
}

function mergeDeep(...objects) {
  const result = {};
  for (const object of objects) {
    if (!object || typeof object !== 'object' || Array.isArray(object)) continue;
    for (const [key, value] of Object.entries(object)) {
      if (isPlainObject(value) && isPlainObject(result[key])) {
        result[key] = mergeDeep(result[key], value);
      } else if (isPlainObject(value)) {
        result[key] = mergeDeep(value);
      } else {
        result[key] = value;
      }
    }
  }
  return result;
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function pickDefined(source, keys) {
  const result = {};
  for (const key of keys) {
    if (source[key] !== undefined && source[key] !== null && source[key] !== '') {
      result[key] = source[key];
    }
  }
  return result;
}


