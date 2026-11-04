import express from 'express';
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { callLocalModel } from '../../agent/llmRouter.js';
import { loadConfig } from '../../config/configStore.js';
import { getWorkspaceRoot } from '../../workspace/workspaceManager.js';
import { installVSCodeExtension } from '../../ide/vscodeExtensionInstaller.js';
import {
  generateAutocompleteSuggestion,
  getAutocompleteMetrics,
  recordAutocompleteFeedback,
  runAutocompleteBenchmark
} from '../../ide/autocompleteEngine.js';

const VISUAL_STUDIO_PRIMARY_EXTENSIONS = new Set([
  '.sln',
  '.slnx',
  '.csproj',
  '.vbproj',
  '.fsproj',
  '.vcxproj',
  '.vcproj'
]);

const VISUAL_STUDIO_FALLBACK_FILE_EXTENSIONS = new Set([
  '.cs',
  '.cshtml',
  '.razor',
  '.vb',
  '.fs',
  '.cpp',
  '.c',
  '.h',
  '.hpp',
  '.js',
  '.jsx',
  '.ts',
  '.tsx',
  '.py',
  '.json',
  '.xml',
  '.config',
  '.md'
]);

const IDE_SEARCH_SKIP_DIRS = new Set([
  '.git',
  '.blackhole',
  '.vscode',
  '.vscode-test',
  'node_modules',
  'dist',
  'build',
  'out',
  'coverage',
  'bin',
  'obj'
]);

const IDE_FALLBACK_SKIP_FILES = new Set([
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'pnpm-lock.yaml'
]);

const VISUAL_STUDIO_FALLBACK_EXTENSION_PRIORITY = [
  '.cs',
  '.vb',
  '.fs',
  '.vcxproj',
  '.cpp',
  '.c',
  '.h',
  '.hpp',
  '.js',
  '.jsx',
  '.ts',
  '.tsx',
  '.py',
  '.json',
  '.xml',
  '.config',
  '.md'
];

export function createIdeRouter() {
  const router = express.Router();

  router.get('/ide/detect', async (_req, res) => {
    const results = {
      vscode: { detected: false, path: '' },
      visualstudio: { detected: false, path: '' }
    };

    try {
      const possibleVSCodePaths = buildVSCodeCandidates();
      const pathDirs = (process.env.Path || process.env.PATH || '').split(path.delimiter).filter(Boolean);
      for (const dir of pathDirs) {
        const names = process.platform === 'win32' ? ['code.cmd', 'code.exe'] : ['code', 'codium'];
        for (const name of names) {
          const candidate = path.join(dir, name);
          if (fs.existsSync(candidate)) {
            results.vscode.detected = true;
            results.vscode.path = candidate;
            break;
          }
        }
        if (results.vscode.detected) break;
      }

      if (!results.vscode.detected) {
        for (const candidatePath of possibleVSCodePaths) {
          if (fs.existsSync(candidatePath)) {
            results.vscode.detected = true;
            results.vscode.path = candidatePath;
            break;
          }
        }
      }

      if (process.platform === 'win32') {
        const vswherePath = 'C:\\Program Files (x86)\\Microsoft Visual Studio\\Installer\\vswhere.exe';
        if (fs.existsSync(vswherePath)) {
          await new Promise((resolve) => {
            const proc = spawn(vswherePath, ['-latest', '-property', 'productPath'], { windowsHide: true });
            let out = '';
            proc.stdout.on('data', data => { out += data.toString(); });
            proc.on('close', code => {
              if (code === 0 && out.trim() && fs.existsSync(out.trim())) {
                results.visualstudio.detected = true;
                results.visualstudio.path = out.trim();
              }
              resolve();
            });
            proc.on('error', () => resolve());
          });
        }

        if (!results.visualstudio.detected) {
          const vsYears = ['2022', '2019', '2017'];
          const vsEditions = ['Community', 'Professional', 'Enterprise'];
          for (const year of vsYears) {
            for (const edition of vsEditions) {
              const fallbackPath = `C:\\Program Files\\Microsoft Visual Studio\\${year}\\${edition}\\Common7\\IDE\\devenv.exe`;
              if (fs.existsSync(fallbackPath)) {
                results.visualstudio.detected = true;
                results.visualstudio.path = fallbackPath;
                break;
              }
            }
            if (results.visualstudio.detected) break;
          }
        }
      } else {
        results.visualstudio = {
          detected: false,
          path: '',
          unsupported: true
        };
      }

      res.json({ success: true, ides: results });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  router.post('/ide/autocomplete', async (req, res) => {
    const result = await generateAutocompleteSuggestion(req.body || {});
    return res.json(result);
  });

  router.post('/ide/autocomplete/feedback', (req, res) => {
    const metrics = recordAutocompleteFeedback(req.body || {});
    return res.json({ ok: true, metrics });
  });

  router.get('/ide/autocomplete/metrics', (_req, res) => {
    return res.json({ ok: true, metrics: getAutocompleteMetrics() });
  });

  router.post('/ide/autocomplete/benchmark', async (req, res) => {
    const result = await runAutocompleteBenchmark(req.body || {});
    return res.json(result);
  });

  router.post('/ide/inline-edit', async (req, res) => {
    const payload = normalizeInlineEditPayload(req.body || {});
    if (!payload.selection.trim()) {
      return res.status(400).json({ ok: false, error: 'Selected code is required.' });
    }
    if (!payload.instruction.trim()) {
      return res.status(400).json({ ok: false, error: 'Edit instruction is required.' });
    }

    try {
      const result = await generateIdeText({
        systemPrompt: [
          'You are BlackHole IDE inline edit.',
          'Return only the replacement code for the selected range.',
          'Do not include markdown fences, explanations, diff markers, file paths, or unchanged surrounding code outside the selection.',
          'Preserve the existing language, indentation style, and public behavior unless the instruction explicitly changes it.'
        ].join('\n'),
        userPrompt: [
          `File: ${payload.file || 'untitled'}`,
          `Language: ${payload.languageId || 'plaintext'}`,
          `Lines: ${payload.startLine || '?'}-${payload.endLine || '?'}`,
          `Instruction: ${payload.instruction}`,
          '',
          '[Selected code]',
          payload.selection
        ].join('\n'),
        maxTokens: 1600,
        temperature: 0.08,
        task: 'ide inline edit'
      });

      const replacement = stripCodeFences(result.text).replace(/\r\n/g, '\n');
      return res.json({ ok: true, replacement, route: result.route });
    } catch (error) {
      return res.json({
        ok: false,
        replacement: '',
        error: error instanceof Error ? error.message : String(error)
      });
    }
  });

  router.post('/ide/integrate-launch', async (req, res) => {
    const { ideType, exePath } = req.body;
    if (!ideType || !exePath) {
      return res.status(400).json({ error: 'IDE type and executable path are required.' });
    }

    const workspaceRoot = getWorkspaceRoot();

    try {
      if (ideType === 'vscode') {
        const extensionInstall = await installVSCodeExtension({ ideExecutablePath: exePath });
        const launch = await launchDetached(exePath, [workspaceRoot]);
        return res.json({
          success: true,
          message: 'VS Code extension installed and workspace launched.',
          extensionPath: extensionInstall.targetDir,
          extensionInstall,
          workspaceRoot,
          launch
        });
      }

      if (ideType === 'visualstudio') {
        const launchPlan = buildVisualStudioLaunchPlan(workspaceRoot);
        const launch = await launchDetached(exePath, launchPlan.args);
        return res.json({
          success: true,
          message: launchPlan.message,
          workspaceRoot,
          launchPlan,
          launch
        });
      }

      return res.status(400).json({ error: 'Unsupported IDE type.' });
    } catch (error) {
      return res.status(500).json({ error: error.message });
    }
  });

  return router;
}

async function generateIdeText({ systemPrompt, userPrompt, maxTokens, temperature, task }) {
  const config = loadConfig();
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
  const route = await callLocalModel(
    scopedConfig,
    systemPrompt,
    [{ role: 'user', content: userPrompt }],
    chunk => { text += chunk || ''; },
    { phase: 'act', task, estimatedTokens: estimateTokens(systemPrompt) + estimateTokens(userPrompt), usageTag: 'inline-edit' }
  );
  return { text: text.trim(), route };
}

function normalizeInlineEditPayload(raw) {
  return {
    file: String(raw.file || ''),
    languageId: String(raw.languageId || ''),
    instruction: String(raw.instruction || ''),
    selection: trimHead(String(raw.selection || ''), 12000),
    startLine: Number(raw.startLine || 0),
    endLine: Number(raw.endLine || 0)
  };
}

function stripCodeFences(text) {
  const trimmed = String(text || '').trim();
  const fenced = trimmed.match(/^```[a-zA-Z0-9_-]*\s*\n([\s\S]*?)\n```$/);
  return fenced ? fenced[1].trimEnd() : trimmed;
}

function trimTail(text, maxChars) {
  if (text.length <= maxChars) return text;
  return text.slice(text.length - maxChars);
}

function trimHead(text, maxChars) {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars);
}

function estimateTokens(text) {
  return Math.ceil(String(text || '').length / 4);
}

function launchDetached(exePath, args) {
  console.log(`[IDE LINK] Launch: "${exePath}" ${args.map(arg => `"${arg}"`).join(' ')}`);
  if (!fs.existsSync(exePath)) {
    throw new Error(`IDE executable was not found: ${exePath}`);
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    const proc = spawn(exePath, args, {
      detached: true,
      stdio: 'ignore',
      shell: false,
      windowsHide: process.platform === 'win32'
    });

    const finish = (fn) => {
      if (settled) return;
      settled = true;
      fn();
    };

    proc.once('error', error => finish(() => reject(error)));
    setTimeout(() => finish(() => {
      proc.unref();
      resolve({ pid: proc.pid, args });
    }), 250);
  });
}

function buildVisualStudioLaunchPlan(workspaceRoot) {
  const solutionOrProject = findFirstWorkspaceFile(workspaceRoot, VISUAL_STUDIO_PRIMARY_EXTENSIONS, 5);
  if (solutionOrProject) {
    return {
      mode: 'solution_or_project',
      target: solutionOrProject,
      args: [solutionOrProject],
      message: `Visual Studio launched with ${path.basename(solutionOrProject)}.`
    };
  }

  const editableFile = findFirstWorkspaceFile(workspaceRoot, VISUAL_STUDIO_FALLBACK_FILE_EXTENSIONS, 4, {
    skipFiles: IDE_FALLBACK_SKIP_FILES,
    extensionPriority: VISUAL_STUDIO_FALLBACK_EXTENSION_PRIORITY
  });
  if (editableFile) {
    return {
      mode: 'edit_file',
      target: editableFile,
      args: ['/Edit', editableFile],
      message: `Visual Studio launched in file edit mode for ${path.basename(editableFile)}. Add a .sln or project file for full workspace integration.`
    };
  }

  return {
    mode: 'empty_launch',
    target: '',
    args: [],
    message: 'Visual Studio launched. No solution, project, or editable source file was found in the current workspace.'
  };
}

function findFirstWorkspaceFile(rootDir, extensions, maxDepth, options = {}) {
  if (!rootDir || !fs.existsSync(rootDir)) return '';

  const skipFiles = options.skipFiles || new Set();
  const extensionPriority = Array.isArray(options.extensionPriority)
    ? options.extensionPriority
    : [];
  const priorityMap = new Map(extensionPriority.map((ext, index) => [ext, index]));
  const queue = [{ dir: rootDir, depth: 0 }];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || current.depth > maxDepth) continue;

    let entries = [];
    try {
      entries = fs.readdirSync(current.dir, { withFileTypes: true });
    } catch {
      continue;
    }

    const files = [];
    const dirs = [];
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!IDE_SEARCH_SKIP_DIRS.has(entry.name)) {
          dirs.push(entry);
        }
      } else if (entry.isFile()) {
        files.push(entry);
      }
    }

    files.sort((left, right) => {
      const leftExt = path.extname(left.name).toLowerCase();
      const rightExt = path.extname(right.name).toLowerCase();
      const leftPriority = priorityMap.has(leftExt) ? priorityMap.get(leftExt) : Number.MAX_SAFE_INTEGER;
      const rightPriority = priorityMap.has(rightExt) ? priorityMap.get(rightExt) : Number.MAX_SAFE_INTEGER;
      if (leftPriority !== rightPriority) return leftPriority - rightPriority;
      return left.name.localeCompare(right.name);
    });
    for (const file of files) {
      if (skipFiles.has(file.name)) continue;
      const ext = path.extname(file.name).toLowerCase();
      if (extensions.has(ext)) {
        return path.join(current.dir, file.name);
      }
    }

    dirs.sort((left, right) => left.name.localeCompare(right.name));
    for (const dir of dirs) {
      queue.push({ dir: path.join(current.dir, dir.name), depth: current.depth + 1 });
    }
  }

  return '';
}

function buildVSCodeCandidates() {
  if (process.platform === 'win32') {
    const userProfile = process.env.USERPROFILE || 'C:\\Users\\Default';
    return [
      path.join(userProfile, 'AppData', 'Local', 'Programs', 'Microsoft VS Code', 'Code.exe'),
      'C:\\Program Files\\Microsoft VS Code\\Code.exe',
      'C:\\Program Files (x86)\\Microsoft VS Code\\Code.exe'
    ];
  }
  return [
    '/usr/bin/code',
    '/usr/local/bin/code',
    '/snap/bin/code',
    '/usr/bin/codium',
    '/usr/local/bin/codium'
  ];
}
