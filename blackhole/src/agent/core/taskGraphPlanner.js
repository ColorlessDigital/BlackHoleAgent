import { goalLikelyRequiresMutation } from './phaseGuards.js';

function goalRequiresImplementation(goal) {
  return goalLikelyRequiresMutation(goal) || /(?:^|[.!?;]\s+|\n\s*)(?:please\s+)?(?:fix|change|update|edit|modify|create|add|remove|delete|implement|refactor|repair|restore|write|patch|build|generate)\b/i.test(String(goal || ''));
}

export function isObservationGoal(goal) {
  if (goalRequiresImplementation(goal)) return false;
  const text = String(goal || '').trim();
  return /\b(?:observation\s+only|read[- ]only)\b|읽기\s*전용|변경\s*없이|수정\s*없이|관찰\s*만/.test(text.toLowerCase())
    || /^(?:please\s+)?(?:(?:can|could|would|will)\s+you\s+(?:please\s+)?)?(?:read|inspect|review|list|show|report|check|verify|explain|describe|summari[sz]e|evaluate|analy[sz]e|tell\s+me|what|why|who|when|where|how)\b/i.test(text)
    || /(?:설명|평가|분석|조회)\s*(?:해줘|해주세요|하라|하세요)?[.!?]*$/.test(text);
}

export class TaskGraphPlanner {
  buildTaskGraph({ goal = '', planSteps = [], workspaceSummary = null } = {}) {
    const normalizedSteps = this.normalizePlanSteps(planSteps).filter(step =>
      !isObservationGoal(goal) || !['implement', 'patch'].includes(step.type));
    const steps = normalizedSteps.length > 0
      ? normalizedSteps
      : this.defaultStepsForGoal(goal, workspaceSummary);

    const nodes = steps.map((step, index) => ({
      id: `task-${index + 1}`,
      title: step.title,
      type: step.type || this.inferStepType(step.title),
      status: index === 0 ? 'ready' : 'pending',
      dependsOn: index === 0 ? [] : [`task-${index}`],
      evidence: []
    }));

    return {
      goal,
      version: 1,
      nodes,
      edges: nodes.flatMap(node => node.dependsOn.map(dependsOn => ({ from: dependsOn, to: node.id }))),
      nextNodeId: nodes[0]?.id || null,
      summary: this.summarize(nodes)
    };
  }

  updateTaskGraph(graph, event = {}) {
    if (!graph?.nodes) return graph;
    const nodes = graph.nodes.map(node => ({ ...node, evidence: [...(node.evidence || [])] }));

    const markFirst = (predicate, status, evidence) => {
      const node = nodes.find(predicate);
      if (!node) return;
      node.status = status;
      if (evidence) node.evidence.push(evidence);
    };

    if (event.toolCalls?.length) {
      markFirst(
        node => ['ready', 'in_progress'].includes(node.status),
        'in_progress',
        `Tool calls executed: ${event.toolCalls.map(call => call.tool).join(', ')}`
      );
    }

    if (event.changedFiles?.length) {
      markFirst(
        node => ['ready', 'in_progress'].includes(node.status) && ['implement', 'patch'].includes(node.type),
        'completed',
        `Changed files: ${event.changedFiles.join(', ')}`
      );
    }

    if (event.verification?.ok === true) {
      markFirst(
        node => ['ready', 'pending', 'in_progress'].includes(node.status) && node.type === 'verify',
        'completed',
        'Verification suite passed.'
      );
    } else if (event.verification?.ok === false) {
      markFirst(
        node => ['ready', 'pending', 'in_progress'].includes(node.status) && node.type === 'verify',
        'blocked',
        'Verification suite failed.'
      );
    }

    if (event.toolFailures?.length || event.loopGuard) {
      markFirst(
        node => ['ready', 'in_progress'].includes(node.status),
        'blocked',
        event.loopGuard ? 'Loop guard blocked repeated tool calls.' : 'Tool execution failed.'
      );
    }

    if (event.completed === true) {
      for (const node of nodes) {
        node.status = 'completed';
        node.evidence.push('Current request completed with its required execution evidence.');
      }
    }

    this.refreshReadyNodes(nodes);
    return {
      ...graph,
      nodes,
      nextNodeId: nodes.find(node => node.status === 'ready')?.id || null,
      summary: this.summarize(nodes)
    };
  }

  resumeTaskGraph(graph) {
    if (!graph?.nodes?.length) return graph;
    if (isObservationGoal(graph.goal) && graph.nodes.some(node => ['implement', 'patch'].includes(node.type))) {
      return { ...this.buildTaskGraph({ goal: graph.goal }), migratedFrom: 'observation_graph_with_implementation_steps' };
    }
    const nodes = graph.nodes.map(node => ({
      ...node,
      evidence: [...(node.evidence || [])]
    }));
    const byId = new Map(nodes.map(node => [node.id, node]));

    for (const node of nodes) {
      if (node.status === 'in_progress' || node.status === 'blocked') {
        const dependenciesDone = (node.dependsOn || []).every(depId => byId.get(depId)?.status === 'completed');
        node.status = dependenciesDone ? 'ready' : 'pending';
        node.evidence.push('Resumed from checkpoint.');
      }
    }

    const hasReady = nodes.some(node => node.status === 'ready');
    if (!hasReady) {
      const firstIncomplete = nodes.find(node => node.status !== 'completed');
      if (firstIncomplete) {
        const dependenciesDone = (firstIncomplete.dependsOn || []).every(depId => byId.get(depId)?.status === 'completed');
        if (dependenciesDone) firstIncomplete.status = 'ready';
      }
    }

    this.refreshReadyNodes(nodes);
    return {
      ...graph,
      nodes,
      nextNodeId: nodes.find(node => node.status === 'ready')?.id || null,
      summary: this.summarize(nodes)
    };
  }

  deriveStepLists(graph) {
    if (!graph?.nodes?.length) {
      return { completedSteps: [], pendingSteps: [] };
    }
    return {
      completedSteps: graph.nodes
        .filter(node => node.status === 'completed')
        .map(node => node.title),
      pendingSteps: graph.nodes
        .filter(node => node.status !== 'completed')
        .map(node => node.title)
    };
  }

  formatTaskGraphForPrompt(graph) {
    if (!graph?.nodes?.length) return '';
    const lines = graph.nodes.map(node => (
      `- [${node.status}] ${node.id} (${node.type}): ${node.title}` +
      (node.dependsOn?.length ? ` depends_on=${node.dependsOn.join(',')}` : '')
    ));
    return `[Task Graph]\n${graph.summary}\n${lines.join('\n')}`;
  }

  normalizePlanSteps(planSteps = []) {
    return planSteps
      .map(step => String(step || '').replace(/^[-*\d.\s]+/, '').trim())
      .filter(Boolean)
      .map(title => ({ title, type: this.inferStepType(title) }));
  }

  defaultStepsForGoal(goal, workspaceSummary) {
    const hasCode = (workspaceSummary?.sourceFileCount || 0) > 0;
    if (isObservationGoal(goal)) {
      return [
        { title: `Inspect the requested information: ${String(goal).slice(0, 160)}`, type: 'analyze' },
        { title: 'Answer the current request using the observed evidence', type: 'summarize' }
      ];
    }
    return [
      { title: hasCode ? 'Inspect relevant project structure and symbols' : 'Inspect workspace structure', type: 'analyze' },
      { title: `Implement the requested change: ${String(goal || 'user goal').slice(0, 120)}`, type: 'implement' },
      { title: 'Run targeted verification for changed and impacted files', type: 'verify' },
      { title: 'Summarize changes and remaining risks', type: 'summarize' }
    ];
  }

  inferStepType(title) {
    const lower = String(title || '').toLowerCase();
    if (/inspect|analy[sz]e|read|search|context|understand|scan/.test(lower)) return 'analyze';
    if (/test|verify|lint|build|check/.test(lower)) return 'verify';
    if (/fix|implement|patch|write|change|update|modify|add|remove/.test(lower)) return 'implement';
    if (/summar|report|explain|document/.test(lower)) return 'summarize';
    return 'task';
  }

  refreshReadyNodes(nodes) {
    const byId = new Map(nodes.map(node => [node.id, node]));
    for (const node of nodes) {
      if (node.status !== 'pending') continue;
      const dependenciesDone = (node.dependsOn || []).every(depId => byId.get(depId)?.status === 'completed');
      if (dependenciesDone) {
        node.status = 'ready';
      }
    }
  }

  summarize(nodes) {
    const counts = nodes.reduce((acc, node) => {
      acc[node.status] = (acc[node.status] || 0) + 1;
      return acc;
    }, {});
    return `Tasks: ${nodes.length}, ready: ${counts.ready || 0}, in_progress: ${counts.in_progress || 0}, completed: ${counts.completed || 0}, blocked: ${counts.blocked || 0}, pending: ${counts.pending || 0}`;
  }
}

