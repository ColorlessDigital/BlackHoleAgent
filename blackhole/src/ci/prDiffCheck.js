import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { PROJECT_ROOT } from '../common/paths.js';

const DEFAULT_IGNORES = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.venv',
  'venv',
  '__pycache__'
]);

export function runPrDiffChecks(options = {}) {
  const workspaceRoot = options.workspaceRoot || PROJECT_ROOT;
  const checksDir = options.checksDir || path.join(workspaceRoot, '.blackhole', 'checks');
  const detected = Array.isArray(options.changedFiles)
    ? { files: normalizeChangedFiles(options.changedFiles), mode: 'provided' }
    : detectChangedFiles(workspaceRoot, options);
  const rules = loadCheckRules(checksDir);
  const allFiles = rules.some(rule => !rule.changedOnly)
    ? listProjectFiles(workspaceRoot)
    : [];
  const findings = [];
  const requiredScripts = [];

  for (const rule of rules) {
    for (const script of rule.requireScripts) {
      requiredScripts.push({
        ruleId: rule.id,
        title: rule.title,
        level: rule.level,
        script
      });
    }

    for (const requiredFile of rule.requireFiles) {
      const requiredPath = path.join(workspaceRoot, requiredFile);
      if (!fs.existsSync(requiredPath)) {
        findings.push(createFinding(rule, {
          severity: severityForLevel(rule.level),
          message: `Required file is missing: ${requiredFile}`,
          path: requiredFile,
          directive: 'require-file'
        }));
      }
    }

    const candidates = (rule.changedOnly ? detected.files : allFiles)
      .filter(file => rule.appliesTo.some(pattern => matchGlob(file, pattern)));
    for (const file of candidates) {
      const absolutePath = path.join(workspaceRoot, file);
      if (!fs.existsSync(absolutePath) || !fs.statSync(absolutePath).isFile()) continue;
      const text = readTextFile(absolutePath);
      if (text === null) continue;

      for (const needle of rule.forbidText) {
        const line = findLineNumber(text, needle);
        if (line > 0) {
          findings.push(createFinding(rule, {
            severity: severityForLevel(rule.level),
            message: `Forbidden text found: ${needle}`,
            path: file,
            line,
            directive: 'forbid-text'
          }));
        }
      }

      for (const needle of rule.warnText) {
        const line = findLineNumber(text, needle);
        if (line > 0) {
          findings.push(createFinding(rule, {
            severity: 'warning',
            message: `Warning text found: ${needle}`,
            path: file,
            line,
            directive: 'warn-text'
          }));
        }
      }
    }
  }

  const errors = findings.filter(finding => finding.severity === 'error');
  return {
    ok: errors.length === 0,
    generatedAt: new Date().toISOString(),
    changedFiles: detected.files,
    changedFilesMode: detected.mode,
    checksDir,
    rules: rules.map(compactRule),
    requiredScripts,
    findings,
    summary: {
      rules: rules.length,
      changedFiles: detected.files.length,
      errors: errors.length,
      warnings: findings.filter(finding => finding.severity === 'warning').length,
      requiredScripts: requiredScripts.length
    }
  };
}

export function loadCheckRules(checksDir) {
  if (!fs.existsSync(checksDir)) return [];
  return fs.readdirSync(checksDir)
    .filter(file => file.endsWith('.md'))
    .sort()
    .map(file => parseCheckRule(path.join(checksDir, file)))
    .filter(Boolean);
}

export function parseCheckRule(filePath) {
  const text = fs.readFileSync(filePath, 'utf8');
  const id = path.basename(filePath, '.md');
  const title = (text.match(/^#\s+(.+)$/m)?.[1] || id).trim();
  const directives = {};
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*-\s*([a-zA-Z-]+):\s*(.+?)\s*$/);
    if (!match) continue;
    const key = match[1].toLowerCase();
    const value = match[2].trim();
    if (!directives[key]) directives[key] = [];
    directives[key].push(value);
  }

  return {
    id,
    title,
    path: filePath,
    level: normalizeLevel(lastValue(directives.level) || 'warning'),
    changedOnly: parseBoolean(lastValue(directives['changed-only']), true),
    appliesTo: splitList(directives['applies-to']).length ? splitList(directives['applies-to']) : ['**/*'],
    forbidText: splitList(directives['forbid-text']),
    warnText: splitList(directives['warn-text']),
    requireFiles: splitList(directives['require-file']),
    requireScripts: splitList(directives['require-script']),
    description: text
      .split(/\r?\n/)
      .filter(line => line.trim() && !line.trim().startsWith('- ') && !line.trim().startsWith('#'))
      .slice(0, 4)
      .join(' ')
  };
}

export function renderPrCheckMarkdown(report) {
  const status = report.ok ? 'PASS' : 'FAIL';
  const lines = [
    `### BlackHole PR Check: ${status}`,
    '',
    `Changed files: ${report.summary.changedFiles} (${report.changedFilesMode})`,
    `Rules: ${report.summary.rules} | Errors: ${report.summary.errors} | Warnings: ${report.summary.warnings}`,
    ''
  ];

  if (report.findings.length === 0) {
    lines.push('No diff-scoped findings.');
  } else {
    lines.push('| Level | Rule | File | Line | Message |');
    lines.push('| --- | --- | --- | ---: | --- |');
    for (const finding of report.findings) {
      lines.push(`| ${finding.severity} | ${escapeMarkdown(finding.ruleTitle)} | ${escapeMarkdown(finding.path || '')} | ${finding.line || ''} | ${escapeMarkdown(finding.message)} |`);
    }
  }

  if (report.requiredScripts.length) {
    lines.push('', 'Required scripts declared by rules:');
    for (const item of report.requiredScripts) {
      lines.push(`- ${item.level}: ${item.script} (${item.title})`);
    }
  }
  return `${lines.join('\n')}\n`;
}

export function renderPrCheckSarif(report) {
  return {
    version: '2.1.0',
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    runs: [
      {
        tool: {
          driver: {
            name: 'BlackHole PR Check',
            informationUri: 'https://github.com/continuedev/continue',
            rules: report.rules.map(rule => ({
              id: rule.id,
              name: rule.title,
              shortDescription: { text: rule.title },
              properties: { level: rule.level }
            }))
          }
        },
        results: report.findings.map(finding => ({
          ruleId: finding.ruleId,
          level: finding.severity === 'error' ? 'error' : 'warning',
          message: { text: finding.message },
          locations: [
            {
              physicalLocation: {
                artifactLocation: { uri: finding.path || '' },
                region: { startLine: finding.line || 1 }
              }
            }
          ]
        }))
      }
    ]
  };
}

export function detectChangedFiles(workspaceRoot, options = {}) {
  const baseRef = options.baseRef || process.env.GITHUB_BASE_REF || 'origin/main';
  const commands = [
    ['diff', '--name-only', '--diff-filter=ACMRTUXB', `${baseRef}...HEAD`],
    ['diff', '--name-only', '--diff-filter=ACMRTUXB', 'HEAD'],
    ['diff', '--name-only', '--diff-filter=ACMRTUXB']
  ];
  const inside = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], {
    cwd: workspaceRoot,
    encoding: 'utf8'
  });
  if (inside.status !== 0) {
    return { files: [], mode: 'no-git-worktree' };
  }

  for (const command of commands) {
    const result = spawnSync('git', command, {
      cwd: workspaceRoot,
      encoding: 'utf8',
      maxBuffer: 1024 * 1024 * 5
    });
    if (result.status === 0) {
      return {
        files: normalizeChangedFiles(result.stdout.split(/\r?\n/)),
        mode: `git ${command.join(' ')}`
      };
    }
  }
  return { files: [], mode: 'git-diff-unavailable' };
}

function compactRule(rule) {
  return {
    id: rule.id,
    title: rule.title,
    level: rule.level,
    changedOnly: rule.changedOnly,
    appliesTo: rule.appliesTo,
    directives: {
      forbidText: rule.forbidText.length,
      warnText: rule.warnText.length,
      requireFiles: rule.requireFiles.length,
      requireScripts: rule.requireScripts.length
    }
  };
}

function createFinding(rule, partial) {
  return {
    ruleId: rule.id,
    ruleTitle: rule.title,
    level: rule.level,
    severity: partial.severity,
    path: partial.path || '',
    line: partial.line || 0,
    directive: partial.directive || '',
    message: partial.message
  };
}

function listProjectFiles(root) {
  const files = [];
  const stack = [root];
  while (stack.length) {
    const current = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (DEFAULT_IGNORES.has(entry.name)) continue;
        stack.push(fullPath);
      } else if (entry.isFile()) {
        files.push(path.relative(root, fullPath).replace(/\\/g, '/'));
      }
    }
  }
  return files;
}

function readTextFile(filePath) {
  try {
    const buffer = fs.readFileSync(filePath);
    if (buffer.includes(0)) return null;
    return buffer.toString('utf8');
  } catch {
    return null;
  }
}

function findLineNumber(text, needle) {
  const index = text.indexOf(needle);
  if (index < 0) return 0;
  return text.slice(0, index).split(/\r?\n/).length;
}

function matchGlob(filePath, pattern) {
  const normalizedFile = filePath.replace(/\\/g, '/');
  const normalizedPattern = String(pattern || '**/*').replace(/\\/g, '/');
  if (normalizedPattern === '**/*' || normalizedPattern === '*') return true;
  const regex = new RegExp(`^${globToRegex(normalizedPattern)}$`);
  return regex.test(normalizedFile);
}

function globToRegex(pattern) {
  let regex = '';
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    const next = pattern[index + 1];
    const afterNext = pattern[index + 2];
    if (char === '*' && next === '*') {
      if (afterNext === '/') {
        regex += '(?:.*/)?';
        index += 2;
      } else {
        regex += '.*';
        index += 1;
      }
    } else if (char === '*') {
      regex += '[^/]*';
    } else if (char === '?') {
      regex += '.';
    } else {
      regex += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return regex;
}

function normalizeChangedFiles(files) {
  return Array.from(new Set((files || [])
    .map(file => String(file || '').trim().replace(/\\/g, '/'))
    .filter(Boolean)));
}

function splitList(values = []) {
  return values.flatMap(value => String(value || '')
    .split(',')
    .map(item => item.trim())
    .filter(Boolean));
}

function lastValue(values = []) {
  return values[values.length - 1];
}

function normalizeLevel(value) {
  const level = String(value || '').toLowerCase();
  return level === 'must-pass' ? 'must-pass' : 'warning';
}

function parseBoolean(value, fallback) {
  if (value === undefined) return fallback;
  return !/^(false|no|0)$/i.test(String(value).trim());
}

function severityForLevel(level) {
  return level === 'must-pass' ? 'error' : 'warning';
}

function escapeMarkdown(value) {
  return String(value || '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
}
