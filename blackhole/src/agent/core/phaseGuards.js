// P1-5: pure phase-guard helpers extracted from AgentStateMachine.
// No imports from stateMachine.js — safe to unit-test in isolation.

export function detectPassiveRefusal(text) {
  if (!text || typeof text !== 'string') return false;
  return /(명령 프롬프트|터미널.*환경.*제공되지|직접 실행해|직접 입력하세요|직접 확인해|권한이 없|실행할 수 없|open (a|the) terminal|run this command yourself|i don't have access to terminal)/i.test(text);
}

// P1-5: fixed dead code after early return in stateMachine.goalLikelyRequiresMutation.
export function goalLikelyRequiresMutation(userGoal) {
  const goal = String(userGoal || '').trim().toLowerCase();
  const mentionsChange = /\b(fix|change|update|edit|modify|create|add|remove|delete|implement|refactor|repair|write|patch|build|generate)\b/.test(goal)
    || /(수정|개선|추가|삭제|제거|구현|생성|작성|고쳐|바꿔|만들|보완|개발|작업|진행|적용)/.test(goal);

  // Completion evidence depends on a requested action, not a word mentioned
  // in a question. This does not affect tool permissions or prompt contents.
  const explicitRequest = /(?:^(?:please\s+)?|\b(?:can|could|would|will)\s+you\s+(?:please\s+)?|\b(?:and(?:\s+then)?|then|also)\s+)(?:fix|change|update|edit|modify|create|add|remove|delete|implement|refactor|repair|write|patch|build|generate)\b/.test(goal)
    || /(?:^(?:please\s+)?|\b(?:and(?:\s+then)?|then|also)\s+)(?:make|apply|perform)\s+(?:(?:the|a|an|requested|necessary)\s+)*(?:changes|edits|fixes|patch(?:es)?)\b/.test(goal)
    || /(?:(?:수정|개선|추가|삭제|제거|구현|생성|작성|보완|개발|작업|진행|적용)\s*(?:해|하)\s*|(?:고쳐|바꿔|만들어)\s*)(?:줘|주세요|주십시오|주시|주실|줄\s*수)/.test(goal)
    || /(?:수정|개선|추가|삭제|제거|구현|생성|작성|보완|개발|작업|진행|적용)(?:\s*(?:하라|해라|하세요|하십시오))?[.!?]*$/.test(goal);
  if (explicitRequest) return true;
  if (!mentionsChange) return false;
  const informationRequest = /^(?:please\s+)?(?:(?:can|could|would|will)\s+you\s+)?(?:explain|describe|tell\s+me|what|why|who|when|where|how|read|inspect|review|list|show|report|check|verify)\b/.test(goal)
    || /\b(?:observation\s+only|read[- ]only)\b/.test(goal)
    || /(?:읽기\s*전용|변경\s*없이|수정\s*없이|(?:읽기|조회|관찰)\s*만)/.test(goal)
    || /(누가|누구|어떻게|왜|언제|무엇|무슨|어떤|방법|(?:설명|평가|분석)\s*(?:해|하))/.test(goal);
  return !informationRequest;
}

export function shouldRetryPrematureCompletion({ cycleCount, maxCycles, changedFileCount, userGoal, hasToolResult }) {
  if (cycleCount >= maxCycles) return false;
  if (changedFileCount > 0) return false;
  if (!goalLikelyRequiresMutation(userGoal)) return false;
  return Boolean(hasToolResult);
}

export function normalizeForSignature(value) {
  if (Array.isArray(value)) return value.map(normalizeForSignature);
  if (value && typeof value === 'object') {
    return Object.keys(value).sort().reduce((acc, key) => {
      acc[key] = normalizeForSignature(value[key]);
      return acc;
    }, {});
  }
  return value;
}

export function createToolCallSignature(toolCalls = []) {
  return JSON.stringify(toolCalls.map(toolCall => ({
    tool: toolCall.tool,
    params: normalizeForSignature(toolCall.params || {})
  })));
}

export function applyToolBatchGuard(toolCalls = [], { goalRequiresMutation, maxTotal = 8, maxRunCommands = 1, getMutationPaths }) {
  const hasMutation = toolCalls.some(toolCall => getMutationPaths(toolCall).length > 0);
  if (!goalRequiresMutation || hasMutation) return { trimmed: false, toolCalls };

  const maxT = Math.max(1, Number(maxTotal));
  const maxRun = Math.max(0, Number(maxRunCommands));
  const kept = [];
  const skipped = [];
  let runCommandCount = 0;
  for (const toolCall of toolCalls) {
    const isRunCommand = toolCall.tool === 'run_command';
    if ((isRunCommand && runCommandCount >= maxRun) || kept.length >= maxT) {
      skipped.push(toolCall);
      continue;
    }
    if (isRunCommand) runCommandCount++;
    kept.push(toolCall);
  }
  if (skipped.length === 0) return { trimmed: false, toolCalls };
  const effectiveCalls = kept.length > 0 ? kept : [toolCalls[0]];
  return {
    trimmed: true,
    reason: 'excessive_non_mutating_tool_batch_for_edit_task',
    originalCount: toolCalls.length,
    keptCount: effectiveCalls.length,
    skippedCount: toolCalls.length - effectiveCalls.length,
    maxTotal: maxT,
    maxRunCommands: maxRun,
    skippedTools: skipped.map(call => call.tool).filter(Boolean).slice(0, 12),
    toolCalls: effectiveCalls
  };
}

export function levenshteinDistance(a, b) {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const matrix = Array.from({ length: rows }, () => Array(cols).fill(0));
  for (let i = 0; i < rows; i++) matrix[i][0] = i;
  for (let j = 0; j < cols; j++) matrix[0][j] = j;
  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(matrix[i - 1][j] + 1, matrix[i][j - 1] + 1, matrix[i - 1][j - 1] + cost);
    }
  }
  return matrix[a.length][b.length];
}

export function getToolNameSuggestions(name, availableNames = []) {
  const query = String(name || '').toLowerCase();
  if (!query) return [];
  return availableNames
    .filter(toolName => {
      const lowerName = toolName.toLowerCase();
      return lowerName.includes(query) || query.includes(lowerName) || levenshteinDistance(lowerName, query) <= 3;
    })
    .slice(0, 5);
}
