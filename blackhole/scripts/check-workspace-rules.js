import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadWorkspaceStandardConfig } from '../src/config/workspaceConfig.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const workspaceArg = readArg('--workspace');
const workspaceRoot = path.resolve(workspaceArg || PROJECT_ROOT);
const standard = loadWorkspaceStandardConfig({ workspaceRoot });
const findings = [];
const notes = [];

if (!standard.enabled) {
  findings.push({
    rule: 'workspace-standard',
    type: 'missing-config',
    severity: 'error',
    message: 'Missing .blackhole directory.'
  });
} else {
  if (!standard.configPath) {
    findings.push({
      rule: 'workspace-standard',
      type: 'missing-config',
      severity: 'error',
      message: 'Missing .blackhole/config.yaml or .blackhole/config.yml.'
    });
  }
  if (!standard.modelsPath) {
    findings.push({
      rule: 'workspace-standard',
      type: 'missing-models',
      severity: 'error',
      message: 'Missing .blackhole/models.yaml.'
    });
  }
  if (standard.rules.length === 0) {
    findings.push({
      rule: 'workspace-standard',
      type: 'missing-rules',
      severity: 'error',
      message: 'Missing .blackhole/rules/*.md coding standard rules.'
    });
  }
  if (standard.prompts.length === 0) {
    findings.push({
      rule: 'workspace-standard',
      type: 'missing-prompts',
      severity: 'error',
      message: 'Missing .blackhole/prompts/*.md prompt files.'
    });
  }
}

const packageJson = readJson(path.join(workspaceRoot, 'package.json'), {});
const projectFiles = listProjectFiles(workspaceRoot);

for (const rule of standard.rules || []) {
  if (!rule.content.trim()) {
    findings.push({
      rule: rule.relativePath,
      type: 'empty-rule',
      severity: 'error',
      message: 'Rule file is empty.'
    });
    continue;
  }
  if (rule.directives.length === 0) {
    notes.push(`${rule.relativePath}: no machine-readable directives; prompt-only rule.`);
  }
  for (const directive of rule.directives) {
    evaluateDirective({ directive, rule, workspaceRoot, projectFiles, packageJson, config: standard.config });
  }
}

const payload = {
  ok: findings.length === 0,
  workspaceRoot,
  profile: standard.profile,
  configPath: standard.configPath,
  modelsPath: standard.modelsPath,
  rulesChecked: standard.rules?.length || 0,
  promptsChecked: standard.prompts?.length || 0,
  notes,
  findings
};

console.log(JSON.stringify(payload, null, 2));
if (!payload.ok) process.exitCode = 1;

function evaluateDirective({ directive, rule, workspaceRoot, projectFiles, packageJson, config }) {
  if (directive.type === 'require-file') {
    const target = path.resolve(workspaceRoot, directive.value);
    if (!isInside(workspaceRoot, target) || !fs.existsSync(target)) {
      findings.push({
        rule: rule.relativePath,
        type: directive.type,
        severity: 'error',
        value: directive.value,
        message: `Required file is missing: ${directive.value}`
      });
    }
    return;
  }

  if (directive.type === 'require-script') {
    const scripts = packageJson.scripts || {};
    if (!Object.prototype.hasOwnProperty.call(scripts, directive.value)) {
      findings.push({
        rule: rule.relativePath,
        type: directive.type,
        severity: 'error',
        value: directive.value,
        message: `Required package.json script is missing: ${directive.value}`
      });
    }
    return;
  }

  if (directive.type === 'require-config') {
    if (readPath(config, directive.value) === undefined) {
      findings.push({
        rule: rule.relativePath,
        type: directive.type,
        severity: 'error',
        value: directive.value,
        message: `Required .blackhole/config.yaml path is missing: ${directive.value}`
      });
    }
    return;
  }

  if (directive.type === 'forbid-path') {
    const matcher = globToRegExp(directive.value);
    const matches = projectFiles.filter(file => matcher.test(file));
    for (const file of matches) {
      findings.push({
        rule: rule.relativePath,
        type: directive.type,
        severity: 'error',
        value: directive.value,
        file,
        message: `Forbidden path matched: ${file}`
      });
    }
    return;
  }

  if (directive.type === 'forbid-text') {
    for (const file of projectFiles) {
      if (!isTextLike(file)) continue;
      const absolute = path.join(workspaceRoot, file);
      let content = '';
      try {
        content = fs.readFileSync(absolute, 'utf8');
      } catch {
        continue;
      }
      if (content.includes(directive.value)) {
        findings.push({
          rule: rule.relativePath,
          type: directive.type,
          severity: 'error',
          value: directive.value,
          file,
          message: `Forbidden text found in ${file}: ${directive.value}`
        });
      }
    }
  }
}

function listProjectFiles(root) {
  const files = [];
  const ignored = new Set([
    '.git',
    'node_modules',
    'dist',
    'data',
    '.blackhole',
    'docs',
    'models',
    'resources',
    'benchmarks',
    '.vscode-test'
  ]);
  walk(root, '');
  return files.sort((a, b) => a.localeCompare(b));

  function walk(current, relative) {
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (ignored.has(entry.name)) continue;
      const absolute = path.join(current, entry.name);
      const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(absolute, childRelative);
      } else if (entry.isFile()) {
        files.push(childRelative.replace(/\\/g, '/'));
      }
    }
  }
}

function isTextLike(file) {
  return /\.(js|jsx|ts|tsx|json|md|yaml|yml|css|html|cjs|mjs|ps1|bat|txt)$/i.test(file);
}

function isInside(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return !relative.startsWith('..') && !path.isAbsolute(relative);
}

function globToRegExp(glob) {
  let source = String(glob || '')
    .replace(/\\/g, '/')
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '<<<DOUBLE_STAR>>>')
    .replace(/\*/g, '[^/]*')
    .replace(/<<<DOUBLE_STAR>>>/g, '.*');
  source = `^${source}$`;
  return new RegExp(source);
}

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function readPath(object, dottedPath) {
  return String(dottedPath || '').split('.').reduce((current, key) => {
    if (current === undefined || current === null) return undefined;
    return current[key];
  }, object);
}

function readArg(name) {
  const exact = args.find(arg => arg.startsWith(`${name}=`));
  if (exact) return exact.slice(name.length + 1);
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : '';
}
