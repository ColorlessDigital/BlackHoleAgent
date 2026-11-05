import fs from 'fs';
import path from 'path';
import { IS_WINDOWS, NODE_RUNTIME_BIN_DIR } from '../../common/paths.js';
import { runTerminalCommand } from '../../workspace/terminalBroker.js';
import { analyzeAstFile } from './astAnalyzer.js';

const BEHAVIORAL_SOURCE_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.py', '.go', '.rs', '.java', '.kt', '.cs', '.c', '.cpp', '.h', '.hpp', '.rb', '.php', '.swift', '.scala', '.vue', '.svelte']);

export class VerificationEngine {
  constructor(workspaceRoot = '.', options = {}) {
    this.workspaceRoot = path.resolve(workspaceRoot);
    this.nodeExecutable = options.nodeExecutable || process.env.BLACKHOLE_NODE_PATH || this.detectNodeExecutable();
    this.runCommand = options.runCommand || runTerminalCommand;
    this.includeChildProjects = options.includeChildProjects !== false;
  }

  detectProjectInfo() {
    const info = {
      type: 'unknown',
      scripts: {},
      nodeProjects: [],
      hasNode: false,
      hasPython: false,
      hasPytest: false,
      hasRuff: false
    };

    // Node.js
    const nodeProjects = this.findNodeProjects({ includeChildren: this.includeChildProjects });
    if (nodeProjects.length > 0) {
      info.type = 'node';
      info.hasNode = true;
      info.nodeProjects = nodeProjects;
      info.scripts = nodeProjects[0].scripts || {};
    }

    // Python
    const reqPath = path.join(this.workspaceRoot, 'requirements.txt');
    const pyprojPath = path.join(this.workspaceRoot, 'pyproject.toml');
    if (fs.existsSync(reqPath) || fs.existsSync(pyprojPath) || fs.readdirSync(this.workspaceRoot).some(f => f.endsWith('.py'))) {
      info.hasPython = true;
      if (info.type === 'unknown') {
        info.type = 'python';
      }
      
      // Look for pytest / ruff references
      if (fs.existsSync(pyprojPath)) {
        const pyproj = fs.readFileSync(pyprojPath, 'utf8');
        if (pyproj.includes('pytest')) info.hasPytest = true;
        if (pyproj.includes('ruff')) info.hasRuff = true;
      }
    }

    return info;
  }

  async runVerification(action = 'test', customCommand = null, { abortSignal } = {}) {
    abortSignal?.throwIfAborted();
    const info = this.detectProjectInfo();
    const resolved = this.resolveVerificationCommand(action, customCommand, info);

    if (!resolved?.command) {
      return {
        ok: true,
        skipped: true,
        action,
        error: `No verification command resolved for action: ${action}`,
        analysis: null
      };
    }

    try {
      const result = await this.runCommand(resolved.command, {
        cwd: resolved.cwd || this.workspaceRoot,
        timeout: resolved.timeout || 120000,
        env: { NODE_TEST_CONTEXT: undefined },
        abortSignal
      });
      abortSignal?.throwIfAborted();
      const ok = result.code === 0;
      let analysis = null;

      if (!ok) {
        analysis = this.analyzeFailure(`${result.output || ''}\n${result.error || ''}`);
      }
      const environmentIssue = !ok ? this.detectEnvironmentIssue(result, resolved.command, resolved.cwd || this.workspaceRoot) : null;
      if (environmentIssue) analysis = { ...analysis, failureKind: 'environment', environmentIssue };

      return {
        ok,
        skipped: false,
        action,
        command: resolved.command,
        cwd: result.cwd || resolved.cwd || this.workspaceRoot,
        code: result.code,
        output: result.output,
        error: result.error,
        ...(environmentIssue ? { failureKind: 'environment', environmentIssue } : {}),
        analysis,
        ...(action === 'test' ? { behavioral: this.describeTestEvidence({ ...result, ok }, resolved.command) } : {})
      };
    } catch (err) {
      if (abortSignal?.aborted || err.name === 'AbortError') throw err;
      const environmentIssue = err.code === 'ENOENT' ? { code: 'command_unavailable', command: resolved.command } : null;
      return {
        ok: false,
        skipped: false,
        action,
        command: resolved.command,
        cwd: resolved.cwd || this.workspaceRoot,
        error: err.message,
        ...(environmentIssue ? { failureKind: 'environment', environmentIssue } : {}),
        analysis: { ...this.analyzeFailure(err.message), ...(environmentIssue ? { failureKind: 'environment', environmentIssue } : {}) }
      };
    }
  }

  async runVerificationSuite({ includeBuild = false, changedFiles = [], contextEngine = null, abortSignal } = {}) {
    abortSignal?.throwIfAborted();
    const actions = ['syntax', 'test', 'lint'];
    if (includeBuild) actions.push('build');

    const targets = contextEngine && typeof contextEngine.getVerificationTargets === 'function'
      ? contextEngine.getVerificationTargets(changedFiles)
      : { changedFiles, impactedFiles: [], testFiles: [] };
    const verificationPlan = this.buildVerificationPlan(targets);
    targets.verificationPlan = verificationPlan;
    const affected = [...new Set([...(targets.changedFiles || changedFiles), ...(targets.impactedFiles || []), ...(targets.testFiles || [])])];
    if (affected.length) return this.runScopedVerification(actions, targets, affected, { abortSignal, includeBuild });
    const targetedTestCommand = this.buildTargetedNodeTestCommand(targets.testFiles);
    const targetedSyntaxCommand = this.buildTargetedNodeSyntaxCommand(verificationPlan.syntaxFiles);
    const targetedLintCommand = this.buildTargetedLintCommand(verificationPlan.lintFiles);

    const results = {};
    for (const action of actions) {
      const customCommand = action === 'test'
        ? targetedTestCommand
        : action === 'syntax'
          ? targetedSyntaxCommand
          : action === 'lint'
            ? targetedLintCommand
            : null;
      abortSignal?.throwIfAborted();
      results[action] = await this.runVerification(action, customCommand, { abortSignal });
      if (customCommand && results[action]) {
        results[action].targeted = true;
        results[action].targets = action === 'test'
          ? targets.testFiles
          : action === 'syntax'
            ? verificationPlan.syntaxFiles
            : verificationPlan.lintFiles;
      }
    }
    return {
      ok: Object.values(results).every(result => result.ok),
      results,
      targets
    };
  }

  detectEnvironmentIssue(result, command, cwd = this.workspaceRoot) {
    const output = `${result.output || ''}\n${result.error || ''}`;
    if ([127, 9009].includes(result.code) || /(?:is not recognized|command not found|the term .+ is not recognized|\[spawn error\].*ENOENT)/i.test(output)) {
      return { code: 'command_unavailable', command };
    }
    // Localized cmd.exe failures may return 1 rather than 9009. Resolve only a
    // literal launch token for diagnostics; never parse or execute shell syntax.
    const token = String(command).trim().match(/^(?:"([^"]+)"|([a-z0-9_./:\\-]+))(?:\s|$)/i);
    const executable = token?.[1] || token?.[2];
    const builtins = new Set(['call', 'cd', 'chdir', 'copy', 'del', 'dir', 'echo', 'exit', 'for', 'if', 'md', 'mkdir', 'move', 'rd', 'rem', 'ren', 'rmdir', 'set', 'start', 'type']);
    if ([1, -1].includes(result.code) && executable && !builtins.has(executable.toLowerCase())
      && !/assertionerror|syntaxerror|typeerror|referenceerror|cannot find module|err_module_not_found/i.test(output)
      && !this.executableExists(executable, cwd)) return { code: 'command_unavailable', command, executable };
    return null;
  }

  executableExists(executable, cwd) {
    const extensions = IS_WINDOWS && !path.extname(executable)
      ? ['', ...(process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';')] : [''];
    const directories = path.isAbsolute(executable) || /[\\/]/.test(executable) ? [cwd]
      : [...(IS_WINDOWS ? [cwd] : []), ...(process.env.PATH || process.env.Path || '').split(path.delimiter)];
    return directories.some(directory => extensions.some(extension => {
      try {
        const file = path.resolve(directory.replace(/^"|"$/g, '') || cwd, executable + extension);
        if (!fs.statSync(file).isFile()) return false;
        if (!IS_WINDOWS) fs.accessSync(file, fs.constants.X_OK);
        return true;
      } catch { return false; }
    }));
  }

  findOwningProject(file) {
    const absolute = path.resolve(this.workspaceRoot, file);
    const relative = path.relative(this.workspaceRoot, absolute);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return null;
    let directory = path.dirname(absolute);
    while (true) {
      if (['package.json', 'pyproject.toml', 'requirements.txt'].some(name => fs.existsSync(path.join(directory, name)))) return directory;
      if (directory === this.workspaceRoot) return null;
      const parent = path.dirname(directory);
      if (parent === directory) return null;
      directory = parent;
    }
  }

  async runScopedVerification(actions, targets, affected, { abortSignal, includeBuild }) {
    const scopes = new Map();
    for (const file of affected) {
      const dependencyManifest = /(?:^|[\\/])requirements(?:[-.][^\\/]*)?\.txt$/i.test(file);
      if (!includeBuild && !dependencyManifest && /\.(?:md|txt|rst|adoc)$/i.test(file) && !(targets.testFiles || []).includes(file)) continue;
      const absolute = path.resolve(this.workspaceRoot, file);
      const relative = path.relative(this.workspaceRoot, absolute);
      if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) continue;
      const owner = this.findOwningProject(file);
      const root = owner || path.dirname(absolute);
      if (!scopes.has(root)) scopes.set(root, { root, project: Boolean(owner), files: [] });
      scopes.get(root).files.push(file);
    }
    targets.verificationPlan.projectScopes = [...scopes.values()].map(scope => ({ root: scope.root, files: scope.files, project: scope.project }));
    const collected = Object.fromEntries(actions.map(action => [action, []]));
    for (const scope of scopes.values()) {
      const engine = new VerificationEngine(scope.root, { nodeExecutable: this.nodeExecutable, runCommand: this.runCommand, includeChildProjects: false });
      // A changed package may run its own scripts, never a sibling package's fallback.
      const relativeFiles = scope.files.map(file => path.relative(scope.root, path.resolve(this.workspaceRoot, file)));
      let tests = (targets.testFiles || []).filter(file => scope.files.includes(file))
        .map(file => path.relative(scope.root, path.resolve(this.workspaceRoot, file)));
      const plan = engine.buildVerificationPlan({ changedFiles: relativeFiles });
      const declaredTest = scope.project && engine.resolveVerificationCommand('test', null, engine.detectProjectInfo());
      if (!declaredTest) tests = engine.discoverNodeTests(relativeFiles, tests);
      const requiresBehavior = relativeFiles.some(file => BEHAVIORAL_SOURCE_EXTENSIONS.has(path.extname(file).toLowerCase()));
      for (const action of actions) {
        abortSignal?.throwIfAborted();
        const custom = action === 'test' ? (declaredTest ? null : engine.buildTargetedNodeTestCommand(tests))
          : action === 'syntax' ? engine.buildTargetedNodeSyntaxCommand(plan.syntaxFiles)
            : action === 'lint' ? engine.buildTargetedLintCommand(plan.lintFiles) : null;
        const result = !custom && (!scope.project || action === 'syntax')
          ? { ok: true, skipped: true, action, reason: 'No applicable check for the changed files.' }
          : await engine.runVerification(action, custom, { abortSignal });
        if (action === 'test') {
          result.behavioral ||= { status: 'unverified', reason: 'no_behavioral_check' };
          if (requiresBehavior && result.ok && result.behavioral.status !== 'passed') {
            result.ok = false;
            result.failureKind = 'unverified';
            result.reason = 'behavioral_verification_unavailable';
            result.analysis = { failureKind: 'unverified', errorMessages: [
              'Behavioral verification was not performed for the changed source. Syntax/lint success is not behavioral evidence.'
            ], rawLogSnippet: result.output?.slice(-1000) || result.behavioral.reason };
          }
          result.behavioral.required = requiresBehavior;
        }
        if (custom) {
          result.targeted = true;
          result.targets = action === 'test' ? tests.map(file => path.relative(this.workspaceRoot, path.resolve(scope.root, file)).replaceAll('\\', '/'))
            : action === 'syntax' ? scope.files.filter(file => plan.syntaxFiles.includes(path.relative(scope.root, path.resolve(this.workspaceRoot, file))))
              : scope.files.filter(file => plan.lintFiles.includes(path.relative(scope.root, path.resolve(this.workspaceRoot, file))));
        }
        collected[action].push({ ...result, projectRoot: scope.root });
      }
    }
    const results = {};
    for (const action of actions) {
      const checks = collected[action];
      if (checks.length === 0) results[action] = { ok: true, skipped: true, action, reason: 'No applicable project check for the changed files.' };
      else if (checks.length === 1) results[action] = checks[0];
      else {
        const failures = checks.filter(check => !check.ok);
        const environment = failures.find(check => check.failureKind === 'environment');
        const unverified = failures.length && failures.every(check => check.failureKind === 'unverified');
        const output = failures.map(check => `[${check.projectRoot}]\n${check.output || check.error || ''}`).join('\n');
        results[action] = { ok: failures.length === 0, skipped: checks.every(check => check.skipped), action, projects: checks,
          analysis: failures.length ? this.analyzeFailure(output) : null,
          ...(environment ? { failureKind: 'environment', environmentIssue: environment.environmentIssue }
            : unverified ? { failureKind: 'unverified', reason: 'behavioral_verification_unavailable' } : {}),
          ...(action === 'test' ? { behavioral: { status: failures.length ? (unverified ? 'unverified' : 'failed') : 'passed',
            scopes: checks.map(check => ({ projectRoot: check.projectRoot, ...check.behavioral })) } } : {}) };
      }
    }
    return { ok: Object.values(results).every(result => result.ok), results, targets };
  }

  describeTestEvidence(result, command) {
    if (!result.ok) return { status: 'failed' };
    const output = `${result.output || ''}\n${result.error || ''}`.replace(/\u001b\[[0-9;]*m/g, '');
    const nodeTests = output.match(/^(?:#|\u2139) tests (\d+)\s*$/m);
    const nodeSkipped = output.match(/^(?:#|\u2139) skipped (\d+)\s*$/m);
    const pythonTests = output.match(/Ran (\d+) tests?\b/);
    const positive = output.match(/\b(\d+) (?:passing|passed)\b/);
    const pythonSkipped = output.match(/OK \(skipped=(\d+)\)/);
    const count = nodeTests ? Number(nodeTests[1]) - Number(nodeSkipped?.[1] || 0)
      : pythonTests ? Number(pythonTests[1]) - Number(pythonSkipped?.[1] || 0) : positive ? Number(positive[1]) : null;
    const zero = count === 0 || (count === null && (/no tests (?:ran|found)|collected 0 items|node:test run\(\) is being called recursively.*skipping running files|^\s*Tests:?\s+\d+ skipped\s*(?:,\s*\d+ total|\(\d+\))\s*$/im.test(output)
      || (!positive && /^\s*\d+ skipped(?:, \d+ warnings?)? in /m.test(output))));
    const noop = /^\s*echo\s+[^&|;<>]*$/i.test(command)
      || /(?:^|[\\/\s"])node(?:\.exe)?"?\s+(?:--version|-v)\s*$/i.test(command)
      || (!/[&|;<>]/.test(command) && (/(?:^|[\\/\s"])node(?:\.exe)?"?\s+(?:--check|-c)\b/i.test(command)
        || /^\s*(?:tsc|eslint|oxlint|flake8)(?:\.cmd)?(?:\s|$)/i.test(command)
        || /^\s*ruff\s+check\b|^\s*python(?:3|\.exe)?\s+-m\s+(?:py_compile|compileall)\b/i.test(command)));
    if (zero || noop) return { status: 'unverified', reason: zero ? 'zero_tests_executed' : 'non_behavioral_test_command', testsExecuted: count };
    return { status: 'passed', source: count === null ? 'project_declared_test_command' : 'test_runner_summary', testsExecuted: count };
  }

  discoverNodeTests(changedFiles, knownTests = []) {
    const tests = new Set();
    const visited = new Set();
    let entriesSeen = 0;
    const inside = file => {
      const relative = path.relative(this.workspaceRoot, file);
      return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
    };
    const add = file => {
      if (tests.size >= 200 || !inside(file) || !['.js', '.mjs', '.cjs'].includes(path.extname(file))) return;
      try {
        const stat = fs.lstatSync(file);
        if (!stat.isFile() || stat.size > 256 * 1024) return;
        const parsed = analyzeAstFile(file, fs.readFileSync(file, 'utf8'));
        if (parsed?.imports.some(name => /^(?:node:)?(?:test|assert)(?:\/strict)?$/.test(name))) {
          tests.add(path.relative(this.workspaceRoot, file).replaceAll('\\', '/'));
        }
      } catch { /* Unreadable or incompatible tests are not runnable evidence. */ }
    };
    const visit = (directory, depth = 0, testTree = false) => {
      if (!inside(directory) || visited.has(directory) || depth > 4 || entriesSeen >= 2000 || tests.size >= 200) return;
      visited.add(directory);
      let entries;
      try {
        if (fs.lstatSync(directory).isSymbolicLink()) return;
        if (directory !== this.workspaceRoot && fs.existsSync(path.join(directory, 'package.json'))) return;
        entries = fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
      } catch { return; }
      for (const entry of entries) {
        if (++entriesSeen > 2000 || tests.size >= 200) break;
        if (entry.isSymbolicLink()) continue;
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          if (['node_modules', '.git', 'dist', 'build', 'data'].includes(entry.name)) continue;
          if (testTree || /^(?:tests?|__tests__)$/.test(entry.name)) visit(file, depth + 1, true);
        } else if (testTree || /(?:^|[.-])(?:test|spec)(?:[.-].*)?\.[cm]?js$/.test(entry.name)) add(file);
      }
    };
    for (const file of knownTests) add(path.resolve(this.workspaceRoot, file));
    for (const directory of new Set([this.workspaceRoot, ...changedFiles.map(file => path.dirname(path.resolve(this.workspaceRoot, file)))])) visit(directory);
    return [...tests].sort();
  }

  buildVerificationPlan(targets = {}) {
    const changedAndImpacted = Array.from(new Set([
      ...(targets.changedFiles || []),
      ...(targets.impactedFiles || [])
    ]));
    const syntaxFiles = changedAndImpacted
      .filter(file => ['.js', '.mjs', '.cjs'].includes(path.extname(file).toLowerCase()))
      .filter(file => fs.existsSync(path.resolve(this.workspaceRoot, file)));
    const lintFiles = changedAndImpacted
      .filter(file => ['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx'].includes(path.extname(file).toLowerCase()))
      .filter(file => fs.existsSync(path.resolve(this.workspaceRoot, file)));

    return {
      strategy: changedAndImpacted.length > 0 ? 'targeted-changed-and-impacted' : 'project-default',
      changedFiles: targets.changedFiles || [],
      impactedFiles: targets.impactedFiles || [],
      testFiles: targets.testFiles || [],
      syntaxFiles,
      lintFiles
    };
  }

  buildTargetedNodeTestCommand(testFiles = []) {
    const runnableTests = Array.from(new Set(testFiles))
      .filter(file => ['.js', '.mjs', '.cjs'].includes(path.extname(file).toLowerCase()))
      .filter(file => fs.existsSync(path.resolve(this.workspaceRoot, file)));

    if (runnableTests.length === 0) {
      return null;
    }

    const args = runnableTests
      .map(file => this.quoteCommandPath(path.resolve(this.workspaceRoot, file)))
      .join(' ');
    return `${this.quoteCommandPath(this.nodeExecutable)} --test ${args}`;
  }

  buildTargetedNodeSyntaxCommand(files = []) {
    const runnableFiles = Array.from(new Set(files))
      .filter(file => ['.js', '.mjs', '.cjs'].includes(path.extname(file).toLowerCase()))
      .filter(file => fs.existsSync(path.resolve(this.workspaceRoot, file)));

    if (runnableFiles.length === 0) {
      return null;
    }

    return runnableFiles
      .map(file => `${this.quoteCommandPath(this.nodeExecutable)} --check ${this.quoteCommandPath(path.resolve(this.workspaceRoot, file))}`)
      .join(' && ');
  }

  buildTargetedLintCommand(files = []) {
    const lintFiles = Array.from(new Set(files))
      .filter(file => ['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx'].includes(path.extname(file).toLowerCase()))
      .filter(file => fs.existsSync(path.resolve(this.workspaceRoot, file)));

    if (lintFiles.length === 0) {
      return null;
    }

    const grouped = new Map();
    for (const file of lintFiles) {
      const projectDir = this.findLintProjectDir(file);
      if (!projectDir) continue;
      if (!grouped.has(projectDir)) grouped.set(projectDir, []);
      grouped.get(projectDir).push(file);
    }

    const commands = [];
    for (const [projectDir, projectFiles] of grouped.entries()) {
      const eslintBin = path.join(projectDir, 'node_modules', 'eslint', 'bin', 'eslint.js');
      if (!fs.existsSync(eslintBin)) continue;
      const args = projectFiles
        .map(file => this.quoteCommandPath(path.resolve(this.workspaceRoot, file)))
        .join(' ');
      commands.push(`${this.quoteCommandPath(this.nodeExecutable)} ${this.quoteCommandPath(eslintBin)} ${args}`);
    }

    return commands.length > 0 ? commands.join(' && ') : null;
  }

  findLintProjectDir(relativeFile) {
    const absoluteFile = path.resolve(this.workspaceRoot, relativeFile);
    let current = path.dirname(absoluteFile);
    while (current.startsWith(this.workspaceRoot)) {
      const eslintBin = path.join(current, 'node_modules', 'eslint', 'bin', 'eslint.js');
      if (fs.existsSync(eslintBin)) {
        return current;
      }
      if (current === this.workspaceRoot) break;
      current = path.dirname(current);
    }

    const frontendDir = path.join(this.workspaceRoot, 'frontend');
    if (absoluteFile.startsWith(frontendDir) && fs.existsSync(path.join(frontendDir, 'node_modules', 'eslint', 'bin', 'eslint.js'))) {
      return frontendDir;
    }
    return null;
  }

  detectNodeExecutable() {
    const processPath = process.execPath || '';
    if (path.basename(processPath).toLowerCase().startsWith('node')) {
      return processPath;
    }

    const runtimeNode = NODE_RUNTIME_BIN_DIR
      ? IS_WINDOWS ? path.join(NODE_RUNTIME_BIN_DIR, 'node.exe') : path.join(NODE_RUNTIME_BIN_DIR, 'node')
      : '';
    const candidates = [
      runtimeNode,
      IS_WINDOWS ? path.join(this.workspaceRoot, 'node.exe') : path.join(this.workspaceRoot, 'bin', 'node'),
      path.join(this.workspaceRoot, 'node-v24.21.0-win-x64', 'node.exe'),
      path.join(path.dirname(this.workspaceRoot), 'node-v24.21.0-win-x64', 'node.exe'),
      path.join(this.workspaceRoot, `node-v24.21.0-${process.platform}-${process.arch}`, 'bin', 'node'),
      path.join(path.dirname(this.workspaceRoot), `node-v24.21.0-${process.platform}-${process.arch}`, 'bin', 'node')
    ].filter(Boolean);
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
    return 'node';
  }

  findNodeProjects({ includeChildren = true } = {}) {
    const projects = [];
    const seen = new Set();
    const addProject = (projectDir) => {
      const normalized = path.resolve(projectDir);
      if (seen.has(normalized)) return;
      seen.add(normalized);
      const pkgPath = path.join(normalized, 'package.json');
      if (!fs.existsSync(pkgPath)) return;
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        projects.push({
          dir: normalized,
          relativeDir: path.relative(this.workspaceRoot, normalized).replace(/\\/g, '/') || '.',
          packageJsonPath: pkgPath,
          scripts: pkg.scripts || {}
        });
      } catch {
        // Ignore invalid package.json files during detection.
      }
    };

    addProject(this.workspaceRoot);
    if (!includeChildren || (!projects.length && !fs.existsSync(path.join(this.workspaceRoot, 'pnpm-workspace.yaml')))) return projects;

    const excludes = new Set(['node_modules', '.git', 'dist', 'build', 'data', 'resources', 'models']);
    try {
      for (const entry of fs.readdirSync(this.workspaceRoot, { withFileTypes: true })) {
        if (!entry.isDirectory() || excludes.has(entry.name)) continue;
        addProject(path.join(this.workspaceRoot, entry.name));
      }
    } catch {
      // Ignore unreadable workspace roots.
    }

    return projects;
  }

  resolveVerificationCommand(action, customCommand, info) {
    if (customCommand) {
      return { command: customCommand, cwd: this.workspaceRoot };
    }

    if (info.type === 'node') {
      if (action === 'test') {
        return this.resolveNodeScript(info, 'test', { preferRoot: true });
      }
      if (action === 'lint') {
        return this.resolveNodeScript(info, 'lint', { preferProjectName: 'frontend' });
      }
      if (action === 'build') {
        return (
          this.resolveNodeScript(info, 'build', { preferRoot: true }) ||
          this.resolveNodeScript(info, 'build:frontend', { preferRoot: true }) ||
          this.resolveNodeScript(info, 'build', { preferProjectName: 'frontend' })
        );
      }
      if (action === 'syntax') {
        return (
          this.resolveNodeScript(info, 'check:backend', { preferRoot: true }) ||
          this.resolveBackendSyntaxCommand()
        );
      }
    }

    if (info.type === 'python') {
      if (action === 'test') {
        return { command: info.hasPytest ? 'pytest' : 'python -m unittest', cwd: this.workspaceRoot };
      }
      if (action === 'lint') {
        return { command: info.hasRuff ? 'ruff check' : 'flake8', cwd: this.workspaceRoot };
      }
    }

    return null;
  }

  resolveNodeScript(info, scriptName, options = {}) {
    const projects = this.orderNodeProjects(info.nodeProjects || [], options);
    for (const project of projects) {
      const script = project.scripts?.[scriptName];
      if (!script) continue;
      return {
        command: this.commandFromNodeScript(script, project.dir),
        cwd: project.dir
      };
    }
    return null;
  }

  orderNodeProjects(projects, options = {}) {
    const copy = [...projects];
    if (options.preferRoot) {
      return copy.sort((a, b) => (a.dir === this.workspaceRoot ? -1 : b.dir === this.workspaceRoot ? 1 : 0));
    }
    if (options.preferProjectName) {
      return copy.sort((a, b) => {
        const aMatch = path.basename(a.dir).toLowerCase() === options.preferProjectName.toLowerCase();
        const bMatch = path.basename(b.dir).toLowerCase() === options.preferProjectName.toLowerCase();
        return aMatch === bMatch ? 0 : aMatch ? -1 : 1;
      });
    }
    return copy;
  }

  commandFromNodeScript(script, projectDir) {
    const trimmed = String(script || '').trim();
    const npmPrefixMatch = trimmed.match(/^npm\s+--prefix\s+([^\s]+)\s+run\s+([^\s]+)/i);
    if (npmPrefixMatch) {
      const targetDir = path.resolve(projectDir, npmPrefixMatch[1]);
      const nestedPkgPath = path.join(targetDir, 'package.json');
      if (fs.existsSync(nestedPkgPath)) {
        try {
          const nestedPkg = JSON.parse(fs.readFileSync(nestedPkgPath, 'utf8'));
          const nestedScript = nestedPkg.scripts?.[npmPrefixMatch[2]];
          if (nestedScript) {
            return this.commandFromNodeScript(nestedScript, targetDir);
          }
        } catch {
          // Fall through to original command.
        }
      }
    }

    if (/^node(\.exe)?\b/i.test(trimmed)) {
      return trimmed.replace(/^node(\.exe)?\b/i, this.quoteCommandPath(this.nodeExecutable));
    }

    const eslintMatch = trimmed.match(/^eslint(?:\.cmd)?\b(.*)$/i);
    if (eslintMatch) {
      const eslintBin = path.join(projectDir, 'node_modules', 'eslint', 'bin', 'eslint.js');
      if (fs.existsSync(eslintBin)) {
        const args = eslintMatch[1]?.trim() || '.';
        return `${this.quoteCommandPath(this.nodeExecutable)} ${this.quoteCommandPath(eslintBin)} ${args}`;
      }
    }

    const viteMatch = trimmed.match(/^vite(?:\.cmd)?\b(.*)$/i);
    if (viteMatch) {
      const viteBin = path.join(projectDir, 'node_modules', 'vite', 'bin', 'vite.js');
      if (fs.existsSync(viteBin)) {
        const args = viteMatch[1]?.trim() || 'build';
        return `${this.quoteCommandPath(this.nodeExecutable)} ${this.quoteCommandPath(viteBin)} ${args}`;
      }
    }

    return trimmed;
  }

  resolveBackendSyntaxCommand() {
    const checkPath = path.join(this.workspaceRoot, 'scripts', 'check-backend.js');
    if (!fs.existsSync(checkPath)) return null;
    return {
      command: `${this.quoteCommandPath(this.nodeExecutable)} ${this.quoteCommandPath(checkPath)}`,
      cwd: this.workspaceRoot
    };
  }

  quoteCommandPath(value) {
    const text = String(value || '');
    if (text && !/[\s"&|<>^]/.test(text)) {
      return text;
    }
    const escaped = text.replace(/"/g, '\\"');
    return `"${escaped}"`;
  }

  analyzeFailure(output) {
    const analysis = {
      suspectedFiles: [],
      errorMessages: [],
      rawLogSnippet: output ? output.slice(-1000) : ''
    };

    if (!output) return analysis;

    // Common stack trace regexes (Node and Python)
    // Node stack trace match: at FunctionName (path/to/file.js:line:col)
    // or path/to/file.js:line:col
    // Python traceback match: File "path/to/file.py", line 12, in function_name
    
    const nodeStackRegex = /(?:at\s+.*?\s+\()?([^()\s]+?\.js):(\d+):(\d+)\)?/g;
    const pythonStackRegex = /File\s+['"]([^'"]+?\.py)['"]\s*,\s*line\s*(\d+)/g;
    const generalSyntaxErrorRegex = /SyntaxError:\s*(.*)/i;
    const pyErrorRegex = /([a-zA-Z0-9_]+Error):\s*(.*)/i;

    let match;
    const seenFiles = new Set();

    // Node.js Stack extraction
    while ((match = nodeStackRegex.exec(output)) !== null) {
      const filePath = match[1].replace(/\\/g, '/');
      const line = Number(match[2]);
      // Avoid tracking core node modules
      if (!filePath.includes('node:internal') && !filePath.includes('node_modules')) {
        const fileKey = `${filePath}:${line}`;
        if (!seenFiles.has(fileKey)) {
          seenFiles.add(fileKey);
          analysis.suspectedFiles.push({ file: filePath, line, type: 'node' });
        }
      }
    }

    // Python Stack extraction
    while ((match = pythonStackRegex.exec(output)) !== null) {
      const filePath = match[1].replace(/\\/g, '/');
      const line = Number(match[2]);
      if (!filePath.includes('lib/python') && !filePath.includes('site-packages')) {
        const fileKey = `${filePath}:${line}`;
        if (!seenFiles.has(fileKey)) {
          seenFiles.add(fileKey);
          analysis.suspectedFiles.push({ file: filePath, line, type: 'python' });
        }
      }
    }

    // Message extraction
    const syntaxMatch = output.match(generalSyntaxErrorRegex);
    if (syntaxMatch) {
      analysis.errorMessages.push(`SyntaxError: ${syntaxMatch[1]}`);
    }

    const pyMatch = output.match(pyErrorRegex);
    if (pyMatch) {
      analysis.errorMessages.push(`${pyMatch[1]}: ${pyMatch[2]}`);
    }

    // Fallback search: look for lines containing "Error:" or "failed"
    if (analysis.errorMessages.length === 0) {
      const lines = output.split('\n');
      for (const line of lines) {
        if (line.includes('Error:') || line.toLowerCase().includes('failed:')) {
          analysis.errorMessages.push(line.trim());
          if (analysis.errorMessages.length >= 3) break;
        }
      }
    }

    return analysis;
  }
}
