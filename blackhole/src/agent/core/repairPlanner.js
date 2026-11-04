import path from 'path';

export class RepairPlanner {
  constructor({ contextEngine = null } = {}) {
    this.contextEngine = contextEngine;
  }

  buildRepairPlan(failures = [], { changedFiles = [], contextEngine = null } = {}) {
    const activeContext = contextEngine || this.contextEngine;
    const normalizedFailures = Array.isArray(failures) ? failures : [];
    const environmentOnly = normalizedFailures.length > 0 && normalizedFailures.every(failure => failure.failureKind === 'environment' || failure.analysis?.failureKind === 'environment');
    const categories = this.classifyFailures(normalizedFailures);
    const suspectedFiles = environmentOnly ? [] : this.collectSuspectedFiles(normalizedFailures, activeContext);
    const recommendedFiles = environmentOnly ? [] : this.buildRecommendedFileList({
      suspectedFiles,
      changedFiles,
      contextEngine: activeContext
    });
    const strategySteps = environmentOnly
      ? ['Restore the declared verification toolchain, then rerun the same checks without altering source files.']
      : this.buildStrategySteps(categories, recommendedFiles);

    return {
      summary: this.buildSummary(categories, suspectedFiles, recommendedFiles),
      categories,
      suspectedFiles,
      recommendedFiles,
      strategySteps,
      toolSequence: environmentOnly ? [] : this.buildToolSequence(recommendedFiles),
      environmentOnly
    };
  }

  formatRepairPrompt(plan) {
    if (plan?.environmentOnly) {
      return `[Verification Environment]\n${plan.summary}\nRestore the declared verification tools and rerun the unchanged checks. No source-file patch is indicated by this environment failure.`;
    }
    if (!plan) {
      return '[Repair Planner]\nNo repair plan was available. Inspect the verification failures, read suspected files, patch minimally, and rerun verification.';
    }

    const categories = plan.categories
      .map(category => `- ${category.id}: ${category.reason}`)
      .join('\n') || '- unknown: Verification failed without a clear category.';
    const files = plan.recommendedFiles
      .map(file => `- ${file.file}${file.line ? `:${file.line}` : ''} (${file.reason})`)
      .join('\n') || '- No specific file was identified. Use project_search and verification logs first.';
    const steps = plan.strategySteps
      .map((step, index) => `${index + 1}. ${step}`)
      .join('\n');
    const tools = plan.toolSequence
      .map((tool, index) => `${index + 1}. ${tool}`)
      .join('\n');

    return `[Repair Planner]
Summary: ${plan.summary}

Failure categories:
${categories}

Recommended file read order:
${files}

Repair strategy:
${steps}

Suggested tool sequence:
${tools}

Use JSON tool calls first, for example:
{"tool_calls":[{"tool":"read_file","params":{"path":"src/example.js"}}]}

Do not repeat the same failed patch blindly. Read the suspected file or nearby related file first, patch the smallest valid block, then allow verification to rerun.`;
  }

  classifyFailures(failures) {
    const categories = new Map();
    for (const failure of failures) {
      const text = this.failureText(failure);
      const type = String(failure?.type || '').toLowerCase();
      const category = failure.failureKind === 'environment' || failure.analysis?.failureKind === 'environment'
        ? { id: 'verification-environment', label: 'Verification environment unavailable', confidence: 1,
          reason: 'The verification command could not run. Source-file patches do not restore missing execution tools.' }
        : this.classifyFailure(type, text);
      const existing = categories.get(category.id);
      if (existing) {
        existing.count += 1;
        existing.failureTypes.add(type || 'unknown');
      } else {
        categories.set(category.id, {
          ...category,
          count: 1,
          failureTypes: new Set([type || 'unknown'])
        });
      }
    }

    return Array.from(categories.values()).map(category => ({
      ...category,
      failureTypes: Array.from(category.failureTypes)
    }));
  }

  classifyFailure(type, text) {
    const lower = `${type}\n${text}`.toLowerCase();
    if (/syntaxerror|unexpected token|unterminated|missing \)|parsing error/.test(lower)) {
      return {
        id: 'syntax',
        label: 'Syntax or parse error',
        confidence: 0.95,
        reason: 'The log points to malformed source syntax or parser failure.'
      };
    }
    if (/err_module_not_found|cannot find module|module not found|no such file|enoent|resolve/.test(lower)) {
      return {
        id: 'module-resolution',
        label: 'Import or module resolution error',
        confidence: 0.9,
        reason: 'The failure is likely caused by a missing file, wrong import path, or missing export.'
      };
    }
    if (/referenceerror|is not defined|cannot access .* before initialization/.test(lower)) {
      return {
        id: 'runtime-reference',
        label: 'Runtime reference error',
        confidence: 0.88,
        reason: 'A symbol is referenced before being declared, imported, or initialized.'
      };
    }
    if (/typeerror|cannot read properties|is not a function|undefined/.test(lower)) {
      return {
        id: 'runtime-type',
        label: 'Runtime type error',
        confidence: 0.82,
        reason: 'The runtime value shape does not match how the code uses it.'
      };
    }
    if (/assertionerror|expected values|not strictly equal|actual:|expected:|test failed/.test(lower)) {
      return {
        id: 'assertion',
        label: 'Test assertion mismatch',
        confidence: 0.8,
        reason: 'Tests ran but observed behavior differs from expected behavior.'
      };
    }
    if (/eslint|no-unused-vars|no-undef|lint|prettier/.test(lower)) {
      return {
        id: 'lint',
        label: 'Lint or style rule failure',
        confidence: 0.8,
        reason: 'A static analysis rule failed and should be repaired without changing runtime behavior unnecessarily.'
      };
    }
    if (/timeout|timed out|exceeded|buffer|killed/.test(lower)) {
      return {
        id: 'timeout',
        label: 'Timeout or resource exhaustion',
        confidence: 0.75,
        reason: 'The command failed because execution took too long or produced too much output.'
      };
    }
    return {
      id: type || 'unknown',
      label: 'Unclassified verification failure',
      confidence: 0.45,
      reason: 'The log does not match a known repair pattern; inspect the raw failure and changed files first.'
    };
  }

  collectSuspectedFiles(failures, contextEngine) {
    const files = new Map();
    for (const failure of failures) {
      const suspected = failure?.analysis?.suspectedFiles || [];
      for (const item of suspected) {
        const normalized = this.normalizeFilePath(item.file, contextEngine);
        if (!normalized) continue;
        const key = `${normalized}:${item.line || ''}`;
        if (!files.has(key)) {
          files.set(key, {
            file: normalized,
            line: item.line || null,
            source: failure.type || 'verification',
            reason: `${failure.type || 'verification'} failure log`
          });
        }
      }

      // Fallback: extract stack trace frames directly from raw failure text
      const rawText = this.failureText(failure);
      const stackFrameRegex = /(?:at\s+(?:.*?\s+\()?(?:file:\/\/\/)?|(?:\s|^))([a-zA-Z0-9_\-./\\]+\.(?:[jt]sx?|mjs|cjs|py)):(\d+)(?::(\d+))?/gi;
      let match;
      while ((match = stackFrameRegex.exec(rawText)) !== null) {
        const candidatePath = match[1];
        const lineNumber = parseInt(match[2], 10);
        // Ignore node_modules or system internal paths
        if (candidatePath.includes('node_modules') || candidatePath.includes('node:internal')) continue;
        const normalized = this.normalizeFilePath(candidatePath, contextEngine);
        if (!normalized) continue;
        const key = `${normalized}:${lineNumber}`;
        if (!files.has(key)) {
          files.set(key, {
            file: normalized,
            line: lineNumber,
            source: 'stack-trace',
            reason: `Extracted from error stack frame line ${lineNumber}`
          });
        }
      }
    }
    return Array.from(files.values());
  }

  buildRecommendedFileList({ suspectedFiles, changedFiles, contextEngine }) {
    const recommended = new Map();
    const add = (file, reason, line = null, priority = 5) => {
      const normalized = this.normalizeFilePath(file, contextEngine);
      if (!normalized) return;
      const existing = recommended.get(normalized);
      if (!existing || priority < existing.priority) {
        recommended.set(normalized, { file: normalized, line, reason, priority });
      }
    };

    for (const suspected of suspectedFiles) {
      add(suspected.file, suspected.reason, suspected.line, 1);
    }

    for (const changed of changedFiles || []) {
      add(changed, 'changed during the current agent session', null, 2);
    }

    if (contextEngine && typeof contextEngine.getVerificationTargets === 'function') {
      const targets = contextEngine.getVerificationTargets(changedFiles || []);
      for (const impacted of targets.impactedFiles || []) {
        add(impacted, 'impacted by changed-file import graph', null, 3);
      }
      for (const testFile of targets.testFiles || []) {
        add(testFile, 'targeted verification test file', null, 4);
      }
    }

    return Array.from(recommended.values())
      .sort((a, b) => a.priority - b.priority || a.file.localeCompare(b.file))
      .slice(0, 20)
      .map(({ priority, ...item }) => item);
  }

  buildStrategySteps(categories, recommendedFiles) {
    const categoryIds = new Set(categories.map(category => category.id));
    const steps = [];
    const firstFile = recommendedFiles[0]?.file;

    if (firstFile) {
      steps.push(`Read ${firstFile}${recommendedFiles[0].line ? ` around line ${recommendedFiles[0].line}` : ''} before editing.`);
    } else {
      steps.push('Use project_search to find the failing symbol or error message before editing.');
    }

    if (categoryIds.has('syntax')) {
      steps.push('For syntax failures, inspect the exact line and its surrounding block, then patch only the malformed statement or delimiter.');
    }
    if (categoryIds.has('module-resolution')) {
      steps.push('For module resolution failures, verify export names, check relative path depth (../ vs ./), and ensure required files exist on disk.');
    }
    if (categoryIds.has('runtime-reference')) {
      steps.push('For undefined references, search the symbol, verify imports/exports, and prefer adding the missing import over duplicating code.');
    }
    if (categoryIds.has('runtime-type')) {
      steps.push('For type/runtime shape failures, trace value producer and consumer; consider optional chaining (?.) or nullish coalescing (??) guards where appropriate.');
    }
    if (categoryIds.has('assertion')) {
      steps.push('For assertion failures, read the test expectation and implementation side-by-side; inspect exact return formats, types, and edge-case branches.');
    }
    if (categoryIds.has('lint')) {
      steps.push('For lint failures, make behavior-preserving edits unless the lint finding exposes a real runtime bug.');
    }
    if (categoryIds.has('timeout')) {
      steps.push('For timeout failures, narrow the command or test target and avoid broad rewrites until the slow path is identified.');
    }

    steps.push('Patch the smallest coherent block, then let the verification phase rerun targeted checks.');
    return steps;
  }

  buildToolSequence(recommendedFiles) {
    const tools = [];
    if (recommendedFiles.length > 0) {
      for (const file of recommendedFiles.slice(0, 3)) {
        tools.push(`read_file ${file.file}`);
      }
    } else {
      tools.push('project_search <failing symbol or error message>');
    }
    tools.push('patch_file or patch_lines for the minimal fix');
    tools.push('verification reruns automatically after mutation');
    return tools;
  }

  buildSummary(categories, suspectedFiles, recommendedFiles) {
    const categoryText = categories.map(category => category.label).join(', ') || 'Unknown verification failure';
    return `${categoryText}. Suspected locations: ${suspectedFiles.length}. Recommended files: ${recommendedFiles.length}.`;
  }

  failureText(failure) {
    const analysis = failure?.analysis || {};
    return [
      failure?.type || '',
      ...(analysis.errorMessages || []),
      analysis.rawLogSnippet || ''
    ].filter(Boolean).join('\n');
  }

  normalizeFilePath(file, contextEngine) {
    const raw = String(file || '').replace(/\\/g, '/').trim();
    if (!raw) return '';

    const workspaceRoot = contextEngine?.workspaceRoot;
    if (workspaceRoot) {
      const normalizedRoot = workspaceRoot.replace(/\\/g, '/');
      if (raw.startsWith(normalizedRoot)) {
        return path.relative(workspaceRoot, raw).replace(/\\/g, '/');
      }
    }

    return raw.replace(/^[a-zA-Z]:\//, match => match.toUpperCase());
  }
}

