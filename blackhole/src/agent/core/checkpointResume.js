import { previewData } from '../../common/boundedData.js';

export function buildCheckpointResumePrompt(checkpoint = {}) {
  const graph = checkpoint.taskGraph || {};
  const nextNode = Array.isArray(graph.nodes)
    ? graph.nodes.find(node => node.id === graph.nextNodeId)
    : null;

  return [
    '[Checkpoint Resume Request]',
    'Continue a prior BlackHole agent session from the last safe checkpoint.',
    '',
    `Session: ${checkpoint.sessionId || 'unknown'}`,
    `Workspace: ${checkpoint.workspaceRoot || 'unknown'}`,
    `Original goal: ${checkpoint.userGoal || '(not recorded)'}`,
    `Last state: ${checkpoint.state || 'unknown'}`,
    `Cycle count: ${checkpoint.cycleCount ?? 0}`,
    `Previous run budget: ${formatJson(checkpoint.executionBudget || {})}`,
    `Next recommended action: ${checkpoint.nextRecommendedAction || 'continue from the last safe point'}`,
    '',
    '[Progress]',
    `Completed steps: ${formatList(checkpoint.completedSteps)}`,
    `Pending steps: ${formatList(checkpoint.pendingSteps)}`,
    `Changed files: ${formatList(checkpoint.changedFiles)}`,
    '',
    '[Task Graph]',
    `Summary: ${graph.summary || '(not recorded)'}`,
    `Next node: ${nextNode ? `${nextNode.id} - ${nextNode.title || nextNode.description || 'untitled'}` : (graph.nextNodeId || '(not recorded)')}`,
    `Blocked nodes: ${formatGraphNodes(graph.nodes, 'blocked')}`,
    `In-progress nodes: ${formatGraphNodes(graph.nodes, 'in_progress')}`,
    '',
    '[Known Issues]',
    `Failed verifications: ${formatJson(checkpoint.failedVerifications || [])}`,
    `Tool failures: ${formatJson(checkpoint.toolFailures || [])}`,
    `Loop guard events: ${formatJson(checkpoint.loopGuardEvents || [])}`,
    `Interrupted action evidence (not a replay queue): ${JSON.stringify(previewData(checkpoint.actionRecoveries || [], { maxChars: 6000, maxItems: 20 }))}`,
    '',
    '[Resume Instructions]',
    '1. Re-read any changed, suspected, or next-node files before editing.',
    '2. Do not repeat completed work or identical tool-call patterns.',
    '3. Continue the next unfinished task graph node first.',
    '4. Prefer review_patch_transaction before broad multi-file edits.',
    '5. Run targeted verification before the final answer.',
    '6. Summarize what was resumed, changed, and verified.'
  ].join('\n');
}

export function summarizeCheckpointForResume(checkpoint = {}) {
  return {
    sessionId: checkpoint.sessionId,
    workspaceRoot: checkpoint.workspaceRoot,
    userGoal: checkpoint.userGoal,
    state: checkpoint.state,
    cycleCount: checkpoint.cycleCount ?? 0,
    executionBudget: checkpoint.executionBudget || null,
    nextRecommendedAction: checkpoint.nextRecommendedAction,
    changedFiles: checkpoint.changedFiles || [],
    pendingSteps: checkpoint.pendingSteps || [],
    completedSteps: checkpoint.completedSteps || [],
    pendingAction: checkpoint.pendingAction || null,
    actionRecoveries: checkpoint.actionRecoveries || [],
    taskGraph: checkpoint.taskGraph ? {
      summary: checkpoint.taskGraph.summary,
      nextNodeId: checkpoint.taskGraph.nextNodeId,
      nodeCount: Array.isArray(checkpoint.taskGraph.nodes) ? checkpoint.taskGraph.nodes.length : 0
    } : null
  };
}

function formatList(value) {
  if (!Array.isArray(value) || value.length === 0) return '(none)';
  return value.map(item => String(item)).join(' | ');
}

function formatJson(value) {
  if (!Array.isArray(value) || value.length === 0) return '(none)';
  return JSON.stringify(value, null, 2);
}

function formatGraphNodes(nodes = [], status) {
  if (!Array.isArray(nodes)) return '(none)';
  const matches = nodes
    .filter(node => node.status === status)
    .map(node => `${node.id}: ${node.title || node.description || 'untitled'}`);
  return matches.length ? matches.join(' | ') : '(none)';
}
