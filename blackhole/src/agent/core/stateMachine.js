import { AgentState } from './types.js';
import { ProjectContextEngine, getContextEngine } from './contextEngine.js';
import { VerificationEngine } from './verificationEngine.js';
import { DiffTracker } from './diffTracker.js';
import { ToolRegistry } from './toolRegistry.js';
import { PatchTransactionManager } from './patchTransaction.js';
import { AgentCheckpointStore } from './checkpointStore.js';
import { RepairPlanner } from './repairPlanner.js';
import { TaskGraphPlanner } from './taskGraphPlanner.js';
import { AgentMemoryStore } from './agentMemoryStore.js';
import { callLocalModel } from '../llmRouter.js';
import { resolveModelRoute } from '../modelRouting.js';
import { applySlidingContextGuard } from '../contextGuard.js';
import { COMPACTION_SYSTEM_PROMPT, compactConversation, compactionTranscriptBudget } from '../contextCompactor.js';
import {
  parseAllToolCalls,
  stripToolCallMarkup,
  detectMalformedToolCall,
  buildToolCorrectionPrompt
} from '../toolParser.js';
import { emitLog } from '../../common/eventBus.js';
import { CapabilityExecutor } from '../../capabilities/executor.js';
import { getWorkspaceRoot } from '../../workspace/workspaceManager.js';
import { buildCheckpointResumePrompt } from './checkpointResume.js';
import { randomUUID } from 'node:crypto';
import { snapshotActionFiles, compareActionFiles } from './actionJournal.js';
import { normalizeAgentRunLimits } from '../../config/agentRunLimits.js';
import { resolveDirectoryTask, observeDirectoryTask, directoryTaskVerified } from './directoryTask.js';
// P1-5: pure guards live in phaseGuards.js; methods below delegate to them.
import {
  detectPassiveRefusal as detectPassiveRefusalPure,
  goalLikelyRequiresMutation as goalLikelyRequiresMutationPure,
  shouldRetryPrematureCompletion as shouldRetryPrematurePure,
  createToolCallSignature as createToolCallSignaturePure,
  normalizeForSignature as normalizeForSignaturePure,
  applyToolBatchGuard as applyToolBatchGuardPure,
  levenshteinDistance as levenshteinDistancePure,
  getToolNameSuggestions as getToolNameSuggestionsPure
} from './phaseGuards.js';

export class AgentStateMachine {
  constructor({ send, messages = [], config, resumeCheckpoint = null, abortSignal = null, providerSessionId = null }) {
    this.send = send;
    this.messages = Array.isArray(messages) ? messages : [];
    this.resumeCheckpoint = resumeCheckpoint || null;
    this.abortSignal = abortSignal || null;
    this.workspaceRoot = this.resumeCheckpoint?.workspaceRoot || config.workspaceRoot || getWorkspaceRoot();
    this.config = { ...config, workspaceRoot: this.workspaceRoot };

    // Core engines
    this.contextEngine = getContextEngine(this.workspaceRoot);
    this.verificationEngine = new VerificationEngine(this.workspaceRoot);
    this.diffTracker = new DiffTracker(this.workspaceRoot);
    this.diffTracker.restoreChangedFiles(this.resumeCheckpoint?.changedFiles);
    this.patchTransactionManager = new PatchTransactionManager(this.workspaceRoot);
    this.checkpointStore = new AgentCheckpointStore({
      retentionLimit: this.config.agentCheckpointRetentionLimit || 20
    });
    this.repairPlanner = new RepairPlanner({ contextEngine: this.contextEngine });
    this.taskGraphPlanner = new TaskGraphPlanner();
    this.memoryStore = new AgentMemoryStore({
      workspaceRoot: this.workspaceRoot,
      memoryPath: this.config.agentMemoryPath,
      retentionLimit: this.config.agentMemoryRetentionLimit || 200
    });
    this.executor = new CapabilityExecutor({ getConfig: () => this.config });

    this.state = AgentState.PLAN;
    this.cycleCount = 0;
    this.runLimits = normalizeAgentRunLimits(this.config);
    this.stepCount = 0;
    this.repairCycleCount = 0;
    this.budgetLimit = null;
    this.resumeContextPrompt = this.resumeCheckpoint
      ? buildCheckpointResumePrompt(this.resumeCheckpoint)
      : '';
    
    // Active session conversation history
    this.activeConversation = this.buildInitialConversation(this.messages);
    this.visibleAssistantSent = false;
    this.lastVisibleAssistantText = '';
    this.toolExecutionSummary = [];
    this.toolCallSignatureCounts = new Map();
    this.loopGuardMaxRepeats = Number(this.config.agentLoopGuardMaxRepeats || 2);
    this.lastModelRoute = null;
    this.runStartedAt = null;
    this.lastStatusAt = null;
    this.runOutcome = null;
    this.lastSavedCheckpoint = null;
    this.lastAnnouncedCheckpoint = null;
    this.malformedRetryCount = 0;
    this.passiveRefusalRetried = false;

    // Initialize Checkpoint
    const latestMessage = this.messages[this.messages.length - 1];
    const sessionId = this.resumeCheckpoint?.sessionId || `agent-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const initialTaskGraph = this.resumeCheckpoint?.taskGraph
      ? this.taskGraphPlanner.resumeTaskGraph(this.resumeCheckpoint.taskGraph)
      : null;
    const resumedStepLists = this.taskGraphPlanner.deriveStepLists(initialTaskGraph);
    this.checkpoint = {
      ...(this.resumeCheckpoint || {}),
      sessionId,
      providerSessionId: this.resumeCheckpoint?.providerSessionId || providerSessionId || sessionId,
      userGoal: this.resumeCheckpoint?.userGoal || latestMessage?.content || '',
      workspaceRoot: this.workspaceRoot,
      state: this.state,
      planSteps: this.resumeCheckpoint?.planSteps || [],
      currentStepIndex: 0,
      completedSteps: resumedStepLists.completedSteps.length
        ? resumedStepLists.completedSteps
        : (this.resumeCheckpoint?.completedSteps || []),
      pendingSteps: resumedStepLists.pendingSteps.length
        ? resumedStepLists.pendingSteps
        : (this.resumeCheckpoint?.pendingSteps || []),
      changedFiles: this.resumeCheckpoint?.changedFiles || [],
      failedVerifications: this.resumeCheckpoint?.failedVerifications || [],
      repairPlan: this.resumeCheckpoint?.repairPlan || null,
      toolFailures: this.resumeCheckpoint?.toolFailures || [],
      loopGuardEvents: this.resumeCheckpoint?.loopGuardEvents || [],
      memoryEvents: this.resumeCheckpoint?.memoryEvents || [],
      taskGraph: initialTaskGraph,
      nextRecommendedAction: this.resumeCheckpoint?.nextRecommendedAction || 'Create initial plan',
      cycleCount: 0,
      resumedFrom: this.resumeCheckpoint ? {
        sessionId: this.resumeCheckpoint.sessionId,
        savedAt: this.resumeCheckpoint.savedAt,
        state: this.resumeCheckpoint.state,
        cycleCount: this.resumeCheckpoint.cycleCount || 0,
        nextRecommendedAction: this.resumeCheckpoint.nextRecommendedAction,
        executionBudget: this.resumeCheckpoint.executionBudget || null
      } : null
    };
    this.directoryTask = resolveDirectoryTask(this.checkpoint.userGoal, this.workspaceRoot);
  }

  checkAborted() {
    if (this.abortSignal?.aborted) {
      const err = new Error('Agent session aborted by client');
      err.name = 'AbortError';
      throw err;
    }
  }

  isLocalSlmModel() {
    const model = String(this.config.activeModel || '').toLowerCase();
    const runtime = String(this.config.localRuntime || '').toLowerCase();
    return runtime === 'llamacpp' || model.includes('local-gguf') || model.startsWith('llamacpp:');
  }

  detectPassiveRefusal(text) {
    return detectPassiveRefusalPure(text);
  }

  buildInitialConversation(messages = []) {
    if (!this.resumeCheckpoint) {
      return [...messages];
    }
    const resumeMessage = {
      role: 'user',
      content: `[Checkpoint Resume Context]\n${this.resumeContextPrompt}`
    };
    if (messages.length === 0) {
      return [resumeMessage];
    }
    return [...messages, resumeMessage];
  }

  /**
   * Send structured timeline state changes to the UI
   */
  sendStateChange(state, payload = {}) {
    this.state = state;
    this.send({
      type: 'state_change',
      state,
      payload: { executionBudget: this.getExecutionBudget(), ...payload },
      timestamp: Date.now()
    });
  }

  sendStatus(status, payload = {}) {
    const timestamp = Date.now();
    this.lastStatusAt = timestamp;
    this.send({
      type: 'status',
      status,
      phase: payload.phase || this.state,
      elapsedMs: this.runStartedAt ? timestamp - this.runStartedAt : undefined,
      timestamp,
      executionBudget: this.getExecutionBudget(),
      ...payload
    });
  }

  sendRecovery(payload = {}) {
    const unavailable = Object.hasOwn(payload, 'checkpoint') && payload.checkpoint === null;
    this.send({
      type: 'recovery',
      executionBudget: this.getExecutionBudget(),
      phase: this.state,
      timestamp: Date.now(),
      ...payload,
      ...(unavailable ? { checkpointAvailable: false,
        message: 'Recovery checkpoint could not be saved for this run. Earlier checkpoints may not include the latest work.' } : {})
    });
  }

  /**
   * Save a checkpoint of the current session state
   */
  saveCheckpoint(nextAction = '', { notify = true } = {}) {
    this.checkpoint.state = this.state;
    this.checkpoint.cycleCount = this.cycleCount;
    this.checkpoint.changedFiles = Array.from(this.diffTracker.changedFiles);
    this.checkpoint.executionBudget = this.getExecutionBudget();
    if (this.directoryTask) this.checkpoint.directoryTask = this.directoryTask;
    this.checkpoint.nextRecommendedAction = nextAction;

    try {
      const saved = this.checkpointStore.save(this.checkpoint);
      const checkpointPayload = {
        sessionId: saved.sessionId,
        path: saved.path,
        savedAt: saved.savedAt,
        providerSessionId: this.checkpoint.providerSessionId,
        workspaceRoot: this.workspaceRoot,
        executionBudget: this.getExecutionBudget(),
        nextRecommendedAction: nextAction
      };
      this.lastSavedCheckpoint = checkpointPayload;
      if (notify || !this.lastAnnouncedCheckpoint) {
        this.send({ type: 'checkpoint', checkpoint: checkpointPayload });
        this.lastAnnouncedCheckpoint = checkpointPayload;
        emitLog(`[Checkpoint Saved] State: ${this.state}, Cycle: ${this.cycleCount}, Pending: ${this.checkpoint.pendingSteps.length}`, 'info');
      }
      return checkpointPayload;
    } catch (error) {
      this.lastAnnouncedCheckpoint = null;
      emitLog(`[Checkpoint Save Failed] ${error.message}`, 'warning');
      this.sendStatus('Checkpoint could not be saved. Restart recovery is not guaranteed.', {
        level: 'warning', checkpointSaveFailed: true, error: error.message
      });
      return null;
    }
  }

  getExecutionBudget() {
    return { maxSteps: this.runLimits.agentMaxSteps, stepsUsed: this.stepCount,
      maxRepairCycles: this.runLimits.selfHealingMaxCycles, repairCyclesUsed: this.repairCycleCount,
      limitReached: this.budgetLimit };
  }

  beginRepairCycle() {
    if (this.repairCycleCount >= this.runLimits.selfHealingMaxCycles) {
      this.budgetLimit = 'repair_cycles';
      this.sendStatus('Repair budget exhausted. Review the checkpoint before resuming.', {
        level: 'warning', budgetExhausted: true
      });
      return false;
    }
    if (this.stepCount >= this.runLimits.agentMaxSteps) return false;
    this.repairCycleCount++;
    return true;
  }

  async executeJournaledTool(toolCall) {
    const action = { id: randomUUID(), tool: toolCall.tool, requestedAt: new Date().toISOString(),
      phase: 'requested', files: [] };
    this.checkpoint.pendingAction = action;
    this.saveCheckpoint('Review pending action after interruption', { notify: false });
    let paths = [];
    let result;
    try {
      result = await this.executor.execute(toolCall.tool, toolCall.params, {
        actor: 'ai', contextEngine: this.contextEngine, memoryStore: this.memoryStore,
        abortSignal: this.abortSignal, onOutput: text => this.send({ type: 'terminal_log', log: text }),
        onBeforeExecute: async ({ capability, params }) => {
          paths = [...new Set(this.getMutationPaths({ tool: capability, params })
            .map(file => this.diffTracker.normalizeTrackedPath(file)))];
          action.files = await snapshotActionFiles(paths, this.workspaceRoot, { signal: this.abortSignal });
          for (const file of paths) this.diffTracker.backupFile(file);
          action.phase = 'executing';
          action.authorizedAt = new Date().toISOString();
          this.saveCheckpoint('Inspect the pending action before repeating it', { notify: false });
        }
      });
    } catch (error) {
      result = { ok: false, error: error.message };
    }
    const observations = this.abortSignal?.aborted ? []
      : compareActionFiles(action.files, await snapshotActionFiles(paths, this.workspaceRoot, { signal: this.abortSignal }));
    if (!this.abortSignal?.aborted && result?.ok === true && action.phase === 'executing'
      && this.directoryTask && ['run_command', 'list_dir'].includes(toolCall.tool)) {
      this.directoryTask = await observeDirectoryTask(this.directoryTask, this.workspaceRoot, { signal: this.abortSignal });
    }
    return { action, paths, result, observations };
  }

  finishJournaledTool(execution) {
    if (!execution) return;
    const interrupted = this.abortSignal?.aborted && execution.result?.ok !== true;
    this.checkpoint.pendingAction = interrupted ? { ...execution.action, interruptedAt: new Date().toISOString() } : null;
    this.checkpoint.recentActions = [...(this.checkpoint.recentActions || []), {
      id: execution.action.id, tool: execution.action.tool, requestedAt: execution.action.requestedAt,
      finishedAt: new Date().toISOString(), outcome: interrupted ? 'interrupted'
        : !execution.result || execution.result.ok === false ? 'failed' : 'completed', paths: execution.paths
    }].slice(-20);
    this.saveCheckpoint(interrupted ? 'Inspect interrupted action before resuming' : 'Continue after recorded action', { notify: false });
  }

  async recoverPendingAction() {
    const pending = this.checkpoint.pendingAction;
    if (!pending || typeof pending.tool !== 'string') return;
    const files = Array.isArray(pending.files) ? pending.files.filter(file => typeof file?.path === 'string') : [];
    this.sendStatus(`Checking an interrupted action: ${pending.tool}`, { level: 'warning' });
    const observations = compareActionFiles(files, await snapshotActionFiles(files.map(file => file.path),
      this.workspaceRoot, { signal: this.abortSignal, automatic: true }));
    this.diffTracker.restoreChangedFiles(observations.filter(file => file.state === 'changed').map(file => file.path));
    const recovery = { id: pending.id, tool: pending.tool, phase: pending.phase,
      requestedAt: pending.requestedAt, recoveredAt: new Date().toISOString(), outcome: 'unknown',
      automaticallyReplayed: false, files, observations };
    this.checkpoint.actionRecoveries = [...(this.checkpoint.actionRecoveries || []), recovery].slice(-20);
    this.checkpoint.pendingAction = null;
    this.resumeContextPrompt = buildCheckpointResumePrompt(this.checkpoint);
    this.activeConversation = this.buildInitialConversation(this.messages);
    this.sendStateChange(AgentState.OBSERVE, { message: 'Interrupted action outcome is unconfirmed. Inspect current state before repeating it.',
      actionRecovery: recovery });
    this.saveCheckpoint('Inspect recovered action evidence and continue remaining work');
  }

  /**
   * Abstracted model calling interface to support future hybrid model routing
   */
  async callModel(systemPrompt, conversation, onChunk, options = {}) {
    this.checkAborted();
    const phase = options.phase || this.state;
    const task = options.task || this.checkpoint.userGoal;
    const route = resolveModelRoute(this.config, {
      phase,
      task,
      estimatedTokens: this.estimateTokens(systemPrompt, conversation)
    });
    this.lastModelRoute = route;
    this.sendStateChange(this.state, {
      message: 'Model route selected',
      modelRoute: this.formatModelRouteForUi(route)
    });
    this.sendStatus('Model request started. Waiting for first tokens...', {
      phase: this.state,
      modelRoute: this.formatModelRouteForUi(route)
    });
    const startedAt = Date.now();
    const reasoningRequestId = randomUUID();
    let modelProgress = 'waiting';
    const noteProgress = (kind) => {
      if (this.abortSignal?.aborted || modelProgress === kind) return;
      modelProgress = kind;
      this.sendStatus(kind === 'reasoning' ? 'Model reasoning in progress...' : 'Receiving model output...', {
        phase: this.state,
        modelRoute: this.formatModelRouteForUi(route)
      });
    };
    const heartbeat = setInterval(() => {
      const elapsedSeconds = Math.round((Date.now() - startedAt) / 1000);
      const progress = modelProgress === 'reasoning' ? 'Model reasoning in progress' :
        modelProgress === 'receiving' ? 'Receiving model output' : 'Model is still working';
      this.sendStatus(`${progress}... ${elapsedSeconds}s`, {
        phase: this.state,
        heartbeat: true,
        elapsedSeconds,
        modelRoute: this.formatModelRouteForUi(route)
      });
    }, 15000);
    heartbeat.unref?.();

    const safeChunk = (chunk) => {
      if (this.abortSignal?.aborted) return;
      noteProgress('receiving');
      onChunk?.(chunk);
    };

    try {
      const result = await callLocalModel(this.config, systemPrompt, conversation, safeChunk, {
        phase,
        task,
        estimatedTokens: this.estimateTokens(systemPrompt, conversation),
        usageTag: options.usageTag || 'agent',
        abortSignal: this.abortSignal,
        sessionId: this.checkpoint.providerSessionId,
        userGoal: this.checkpoint.userGoal,
        tools: options.tools,
        onReasoning: text => {
          if (this.abortSignal?.aborted || typeof text !== 'string' || !text) return;
          noteProgress('reasoning');
          this.send({ type: 'reasoning', text, requestId: reasoningRequestId,
            model: route.model, phase, step: this.stepCount, timestamp: Date.now() });
        },
        onStatus: (status) => {
          if (this.abortSignal?.aborted) return;
          modelProgress = 'waiting';
          this.sendStatus(status.status, { ...status, phase: this.state,
            modelRoute: this.formatModelRouteForUi(route) });
        }
      });
      this.checkAborted();
      return result;
    } finally {
      clearInterval(heartbeat);
    }
  }

  // Summarization-based context compaction for long runs. Only triggers past
  // the configured threshold on conversations long enough to compact, so
  // short sessions and unit tests never take this path.
  async maybeCompactContext(systemPrompt, messages) {
    try {
      if (this.config.contextCompactionEnabled === false) return { messages, compacted: false };
      const limit = resolveModelRoute(this.config, { phase: 'plan' }).contextLimit;
      const threshold = this.config.contextCompactionThreshold ?? 0.9;
      let summary = '';
      const result = await compactConversation({
        messages,
        systemPrompt,
        limitTokens: limit,
        transcriptLimitTokens: compactionTranscriptBudget(resolveModelRoute(this.config, { phase: 'summarize' }).contextLimit),
        threshold,
        abortSignal: this.abortSignal,
        userGoal: this.checkpoint.userGoal,
        summarize: async (transcript) => {
          this.checkAborted();
          this.sendStatus('Compressing conversation context...', { phase: 'CONTEXT' });
          await this.callModel(
            COMPACTION_SYSTEM_PROMPT,
            [{ role: 'user', content: transcript }],
            (chunk) => { summary += chunk || ''; },
            { phase: 'summarize', task: 'context-compaction', usageTag: 'compaction' }
          );
          return summary;
        }
      });
      if (result.compacted) {
        this.activeConversation = result.messages;
        this.sendStateChange(AgentState.PLAN, {
          message: `Context compacted: ${result.removed + 1} turns summarized (${result.previousTokens} → ${result.estimatedTokens} tokens).`
        });
        this.sendStatus('Context compacted via summarization. Continuing with summary...', { level: 'info' });
        this.saveCheckpoint('Context compaction');
      }
      return result;
    } catch (err) {
      if (this.abortSignal?.aborted || err.name === 'AbortError') throw err;
      emitLog(`Context compaction skipped: ${err.message}`, 'warning');
      return { messages, compacted: false, reason: err.message };
    }
  }

  async run() {
    this.runStartedAt = Date.now();
    let runCompleted = false;
    let pendingFailure = this.resumeCheckpoint?.failedVerifications?.length ? 'verification_failed'
      : this.resumeCheckpoint?.toolFailures?.length ? 'tool_failure' : null;
    let terminalReason = 'step_limit';

    try {
      this.checkAborted();
      if (!this.lastSavedCheckpoint) this.saveCheckpoint('Initialize agent session');
      // 0. Initialize Context Engine
      this.sendStatus('Indexing workspace context...', {
        phase: 'CONTEXT',
        workspaceRoot: this.workspaceRoot
      });
      await this.contextEngine.scanWorkspace({ abortSignal: this.abortSignal });
      this.checkAborted();
      const workspaceSummary = this.contextEngine.getWorkspaceSummary();
      this.sendStatus(`Workspace context ready: ${workspaceSummary.fileCount} files indexed.`, {
        phase: 'CONTEXT',
        workspaceRoot: this.workspaceRoot,
        fileCount: workspaceSummary.fileCount,
        scanStats: workspaceSummary.scanStats
      });

      await this.recoverPendingAction();
      if (this.resumeCheckpoint && (this.diffTracker.changedFiles.size > 0 || this.checkpoint.failedVerifications.length > 0)) {
        this.sendStateChange(AgentState.VERIFY, { message: 'Rechecking files restored from checkpoint...' });
        this.sendStatus('Rechecking earlier changes before resuming...');
        const verification = await this.verificationEngine.runVerificationSuite({
          changedFiles: Array.from(this.diffTracker.changedFiles), contextEngine: this.contextEngine,
          abortSignal: this.abortSignal
        });
        this.checkAborted();
        this.checkpoint.failedVerifications = Object.entries(verification.results)
          .filter(([, result]) => !result.ok).map(([type, result]) => ({ type, analysis: result.analysis,
            failureKind: result.failureKind, environmentIssue: result.environmentIssue }));
        pendingFailure = verification.ok ? null : this.checkpoint.failedVerifications.some(failure => failure.failureKind === 'environment')
          ? 'verification_environment' : 'verification_failed';
        this.updateTaskGraph({ changedFiles: Array.from(this.diffTracker.changedFiles), verification });
        this.resumeContextPrompt = buildCheckpointResumePrompt(this.checkpoint);
        this.activeConversation = this.buildInitialConversation(this.messages);
        this.sendStateChange(AgentState.VERIFY, {
          message: 'Checkpoint files rechecked', resumed: true,
          results: Object.fromEntries(Object.entries(verification.results).map(([type, result]) => [type, this.formatVerificationReport(result)])),
          targets: verification.targets
        });
        this.saveCheckpoint(verification.ok ? 'Continue after checking restored changes' : 'Repair restored changes that failed verification');
      }

      if (this.directoryTask) {
        this.directoryTask = await observeDirectoryTask(this.directoryTask, this.workspaceRoot, { signal: this.abortSignal, automatic: true });
        if (!pendingFailure && directoryTaskVerified(this.directoryTask)) {
          runCompleted = true;
          terminalReason = 'completed';
        }
      }

      while (!runCompleted && pendingFailure !== 'verification_environment' && this.stepCount < this.runLimits.agentMaxSteps) {
        this.checkAborted();
        this.stepCount++;
        // --- 1. PLAN Phase ---
        this.sendStateChange(AgentState.PLAN, {
          message: 'Planning next steps...',
          recentlyChanged: this.contextEngine.getRecentlyChangedFiles(),
          memory: this.buildMemoryUiSnapshot()
        });

        // Insert project context state hints for the LLM
        const systemPromptWithContext = this.buildSystemPrompt();

        let assistantOutput = '';
        /*
        this.send({ type: 'status', status: '인공지능 에이전트 계획 수립 및 추론 중...' });
        
        */
        this.sendStatus('Planning agent steps and preparing tool calls...');

        const compacted = await this.maybeCompactContext(systemPromptWithContext, this.activeConversation);
        const guarded = applySlidingContextGuard(
          compacted.messages || this.activeConversation,
          systemPromptWithContext,
          resolveModelRoute(this.config, { phase: 'plan' }).contextLimit,
          { userGoal: this.checkpoint.userGoal }
        );
        if (guarded.removed > 0 || guarded.compacted > 0) {
          const detail = [
            guarded.compacted > 0 ? `compacted ${guarded.compacted} long tool results` : '',
            guarded.removed > 0 ? `trimmed ${guarded.removed} old messages` : ''
          ].filter(Boolean).join(' and ');
          this.sendStateChange(AgentState.PLAN, {
            message: `Context guard ${detail} (estimated: ${guarded.estimatedTokens} tokens).`
          });
        }

        const planMessages = guarded.messages;
        this.activeConversation = planMessages;

        let modelResult;
        try {
          modelResult = await this.callModel(systemPromptWithContext, planMessages, (chunk) => {
            assistantOutput += chunk;
          }, { tools: ToolRegistry.getAllTools().map(tool => ({ name: tool.name, description: tool.description, parameters: tool.inputSchema })) });
        } catch (error) {
          const failure = error.modelFailure;
          if (failure?.code !== 'malformed_tool_call' || !failure.toolCallValidationComplete ||
            failure.toolCallsEmitted !== false || this.malformedRetryCount >= 2) throw error;
          this.malformedRetryCount++;
          this.sendStateChange(AgentState.REPAIR, { message: 'Completed native tool call was invalid. Requesting format correction.', modelFailure: failure });
          this.sendStatus('No action was executed. Correcting the native tool-call format.', { level: 'warning', formatCorrection: true, modelFailure: failure });
          this.activeConversation.push({ role: 'user', content: buildToolCorrectionPrompt({ native: true, reason: error.message }) });
          this.saveCheckpoint('Correct invalid native tool-call format before execution');
          continue;
        }

        if (!assistantOutput.trim()) {
          const error = new Error('Model completed without an answer or a tool call.');
          error.code = 'empty_model_response';
          throw error;
        }
        this.activeConversation.push({ role: 'assistant', content: assistantOutput,
          ...(modelResult?.goGoogleState ? { goGoogleState: modelResult.goGoogleState } : {}),
          ...(modelResult?.goToolState ? { goToolState: modelResult.goToolState } : {}) });

        // Update plan checkpoint if LLM formulated steps
        const stepMatch = assistantOutput.match(/Plan:\s*([\s\S]*?)(?=\n\n|\n<|$)/i);
        if (stepMatch) {
          this.checkpoint.planSteps = stepMatch[1]
            .split('\n')
            .map(s => s.trim())
            .filter(s => s.length > 0);
          this.checkpoint.pendingSteps = [...this.checkpoint.planSteps];
        }
        this.ensureTaskGraph();

        // --- 2. ACT Phase ---
        let toolCalls = parseAllToolCalls(assistantOutput);
        if (toolCalls.length === 0) {
          const malformed = detectMalformedToolCall(assistantOutput);
          if (malformed && this.malformedRetryCount < 2) {
            this.malformedRetryCount++;
            this.sendStateChange(AgentState.REPAIR, {
              message: `Incomplete tool call detected (${malformed.reason}). Requesting self-correction...`,
              malformed
            });
            this.activeConversation.push({
              role: 'user',
              content: buildToolCorrectionPrompt(malformed)
            });
            this.saveCheckpoint('Self-correction after malformed tool call');
            this.cycleCount++;
            continue;
          }

          if (this.detectPassiveRefusal(assistantOutput) && !this.passiveRefusalRetried) {
            this.passiveRefusalRetried = true;
            this.sendStateChange(AgentState.REPAIR, {
              message: 'Detected passive refusal. Enforcing autonomous tool execution...'
            });
            this.activeConversation.push({
              role: 'user',
              content: '[System Directive] You have full authority to execute terminal and file tools. NEVER tell the user to run commands, open a terminal, or check cmd manually. Execute <run_command> or the appropriate tool yourself directly now.'
            });
            this.saveCheckpoint('Retry after passive refusal');
            this.cycleCount++;
            continue;
          }

          if (this.shouldRetryPrematureCompletion()) {
            this.sendStateChange(AgentState.REPAIR, {
              message: 'No code changes were applied after observation-only tool calls. Retrying with an edit-focused instruction.',
              prematureCompletion: true
            });
            this.activeConversation.push({
              role: 'user',
              content: this.buildPrematureCompletionPrompt()
            });
            this.saveCheckpoint('Retry after premature observation-only completion');
            this.cycleCount++;
            continue;
          }
          // If no tool calls, it means the agent believes it finished. Let's move to SUMMARIZE.
          const missingChanges = this.goalLikelyRequiresMutation() && this.diffTracker.changedFiles.size === 0;
          const missingDirectory = this.directoryTask && !directoryTaskVerified(this.directoryTask);
          runCompleted = !pendingFailure && !missingChanges && !missingDirectory && !malformed;
          terminalReason = pendingFailure || (malformed ? 'malformed_tool_call' : missingDirectory ? 'directory_not_verified' : missingChanges ? 'no_changes_applied' : 'completed');
          if (!missingDirectory) this.streamVisibleAssistantOutput(assistantOutput);
          break;
        }

        const batchGuard = this.applyToolBatchGuard(toolCalls);
        if (batchGuard.trimmed) {
          toolCalls = batchGuard.toolCalls;
          this.checkpoint.toolBatchGuardEvents = [
            ...(this.checkpoint.toolBatchGuardEvents || []),
            batchGuard
          ];
          this.sendStateChange(AgentState.REPAIR, {
            message: 'Tool batch guard trimmed excessive non-mutating calls before execution.',
            toolBatchGuard: batchGuard
          });
          this.activeConversation.push({
            role: 'user',
            content: this.buildToolBatchGuardPrompt(batchGuard)
          });
        }

        const loopGuard = this.evaluateToolCallLoop(toolCalls);
        if (loopGuard.blocked) {
          pendingFailure = 'loop_guard';
          this.updateTaskGraph({ loopGuard });
          if (!this.beginRepairCycle()) break;
          this.prepareLoopGuardRetry(loopGuard);
          this.cycleCount++;
          continue;
        }

        this.sendStateChange(AgentState.ACT, {
          message: `Executing tool calls... (${toolCalls.length} actions)`,
          toolCalls: toolCalls.map(tc => ({ tool: tc.tool, params: tc.params }))
        });

        let hasMutations = false;
        const toolFailures = [];
        const inheritedToolFailures = this.checkpoint.toolFailures || [];
        const successfulTools = new Set();
        const failureSequence = new Map();
        const successfulMutationSequence = new Map();
        let toolSequence = 0;

        // --- 3. OBSERVE Phase ---
        /*
        this.send({ type: 'status', status: `자율 계획 집행 중... (수행할 작업: ${toolCalls.length}개)` });

        */
        this.sendStatus(`Executing ${toolCalls.length} planned action(s)...`, {
          toolCount: toolCalls.length
        });

        for (const toolCall of toolCalls) {
          this.checkAborted();
          toolSequence++;
          const tool = ToolRegistry.getTool(toolCall.tool);
          if (!tool) {
            toolFailures.push({
              tool: toolCall.tool,
              params: toolCall.params,
              reason: 'unregistered_tool',
              error: `Tool "${toolCall.tool}" is not registered in ToolRegistry.`,
              suggestions: this.getToolNameSuggestions(toolCall.tool)
            });
            continue;
          }

          let mutationPaths = this.getMutationPaths(toolCall);
          let isMutationTool = mutationPaths.length > 0;

          this.send({ type: 'tool_start', tool: toolCall.tool, params: toolCall.params });
          this.sendStateChange(AgentState.OBSERVE, {
            message: `Observing execution of: ${toolCall.tool}`,
            tool: toolCall.tool,
            params: toolCall.params
          });

          let result;
          let journaled;
          const toolStartedAt = Date.now();
          const toolHeartbeat = setInterval(() => {
            if (this.abortSignal?.aborted) return;
            const elapsedSeconds = Math.round((Date.now() - toolStartedAt) / 1000);
            this.sendStatus(`Action still running: ${toolCall.tool}... ${elapsedSeconds}s`, {
              phase: AgentState.OBSERVE, tool: toolCall.tool, heartbeat: true, elapsedSeconds
            });
          }, 15000);
          toolHeartbeat.unref?.();
          try {
            journaled = await this.executeJournaledTool(toolCall);
            result = journaled.result;
            mutationPaths = journaled.paths;
            isMutationTool = mutationPaths.length > 0;
          } catch (err) {
            result = { ok: false, error: err.message };
          } finally {
            clearInterval(toolHeartbeat);
          }

          const isSuccess = result && result.ok !== false;
          this.toolExecutionSummary.push({
            tool: toolCall.tool,
            success: isSuccess,
            mutated: Boolean((isSuccess && isMutationTool) || journaled?.observations.some(file => file.state === 'changed')),
            error: isSuccess ? '' : (result?.error || 'Tool execution failed')
          });

          if (!isSuccess) {
            toolFailures.push({
              tool: toolCall.tool,
              params: toolCall.params,
              reason: result?.validation ? 'validation_failed' : (result?.blocked ? 'blocked' : result?.rejected ? 'rejected' : 'execution_failed'),
              error: result?.error || 'Tool execution failed without an error message.',
              output: String(result?.result?.output || '').slice(-6000),
              validation: result?.validation,
              policy: result?.policy
            });
            failureSequence.set(toolFailures.at(-1), toolSequence);
          } else {
            successfulTools.add(toolCall.tool);
            if (isMutationTool) {
              for (const mutationPath of mutationPaths) {
                this.diffTracker.trackChange(mutationPath);
                this.contextEngine.trackFileChange(mutationPath);
                successfulMutationSequence.set(this.diffTracker.normalizeTrackedPath(mutationPath), toolSequence);
              }
              hasMutations = true;
            }
          }

          for (const file of journaled?.observations || []) {
            if (file.state !== 'changed') continue;
            this.diffTracker.trackChange(file.path);
            this.contextEngine.trackFileChange(file.path);
            hasMutations = true;
          }
          if (!isSuccess && journaled?.observations.some(file => file.state === 'changed')) {
            this.sendStatus('A failed action changed files. Rechecking the observed effects.', {
              level: 'warning', tool: toolCall.tool, observedEffects: journaled.observations
            });
          }
          this.checkpoint.toolFailures = [
            ...inheritedToolFailures.filter(failure => !successfulTools.has(failure.tool)), ...toolFailures
          ];
          this.finishJournaledTool(journaled);

          this.send({ type: 'tool_end', tool: toolCall.tool, result });
          this.checkAborted();

          // Prevent raw payload context pollution by using summarizeForModel
          const resultPayload = result?.result !== undefined ? result.result : result;
          const summaryParams = result?.params || toolCall.params;
          const formattedModelSummary = isSuccess
            ? this.safeSummarizeToolResult(
                tool,
                'summarizeForModel',
                resultPayload,
                summaryParams
              )
            : this.formatToolFailureForModel(toolCall, result);
          const uiSummary = isSuccess
            ? this.safeSummarizeToolResult(
                tool,
                'summarizeForUi',
                resultPayload,
                summaryParams
              )
            : {
                type: toolCall.tool,
                success: false,
                error: result?.error,
                validation: result?.validation
              };

          this.activeConversation.push({
            role: 'user',
            content: `[Tool Result (Tool: ${toolCall.tool})]\n${formattedModelSummary}`
          });

          this.sendStateChange(AgentState.OBSERVE, {
            message: `Completed execution of: ${toolCall.tool}`,
            tool: toolCall.tool,
            success: isSuccess,
            uiPayload: uiSummary
          });
          if (isSuccess && directoryTaskVerified(this.directoryTask) && !toolFailures.length && !inheritedToolFailures.length) {
            this.sendStatus('Requested directory verified. No additional file edits are needed.', { directoryTask: this.directoryTask });
            break;
          }
        }

        let unresolvedToolFailures = [
          ...inheritedToolFailures.filter(failure => !successfulTools.has(failure.tool)),
          ...toolFailures
        ];
        this.checkpoint.toolFailures = unresolvedToolFailures;

        // --- 4. VERIFY Phase ---
        if (hasMutations) {
          this.sendStateChange(AgentState.VERIFY, { message: 'Verifying codebase integrity...' });
          /*
          this.send({ type: 'status', status: '코드 변경 감지: 프로젝트 회귀 및 무결성 검증 중...' });

          */
          this.sendStatus('Code changes detected. Running verification...');

          // Run available verification checks. Missing optional checks are reported as skipped.
          const verificationSuite = await this.verificationEngine.runVerificationSuite({
            changedFiles: Array.from(this.diffTracker.changedFiles),
            contextEngine: this.contextEngine,
            abortSignal: this.abortSignal
          });
          this.checkAborted();
          this.updateTaskGraph({
            toolCalls,
            changedFiles: Array.from(this.diffTracker.changedFiles),
            verification: verificationSuite
          });
          const syntaxVerify = verificationSuite.results.syntax;
          const testVerify = verificationSuite.results.test;
          const lintVerify = verificationSuite.results.lint;

          const verificationReport = {
            syntax: this.formatVerificationReport(syntaxVerify),
            test: this.formatVerificationReport(testVerify),
            lint: this.formatVerificationReport(lintVerify)
          };

          this.sendStateChange(AgentState.VERIFY, {
            message: 'Verification complete',
            results: verificationReport,
            targets: verificationSuite.targets
          });

          if (!syntaxVerify.ok || !testVerify.ok || !lintVerify.ok) {
            pendingFailure = 'verification_failed';
            const failures = [];
            for (const [type, result] of Object.entries(verificationSuite.results)) {
              if (!result.ok) failures.push({ type, analysis: result.analysis, failureKind: result.failureKind, environmentIssue: result.environmentIssue });
            }

            const repairPlan = this.repairPlanner.buildRepairPlan(failures, {
              changedFiles: Array.from(this.diffTracker.changedFiles),
              contextEngine: this.contextEngine
            });
            this.checkpoint.failedVerifications = failures;
            this.checkpoint.repairPlan = repairPlan;
            if (failures.some(failure => failure.failureKind === 'environment')) {
              pendingFailure = 'verification_environment';
              this.sendStatus('Verification tooling is unavailable. Source-file repair will not be attempted.', {
                level: 'warning', recovery: true, failures
              });
              break;
            }
            if (!this.beginRepairCycle()) break;

            // --- 5. REPAIR Phase ---
            this.sendStateChange(AgentState.REPAIR, {
              message: 'Verification failed. Initiating Self-Healing repair loops...',
              failures,
              repairPlan
            });
            /*
            this.send({ type: 'status', status: '⚠️ 작업 검증 실패: 자율 치유(Self-Healing) 작동 중...' });

            */
            this.sendStatus('Verification failed. Starting self-healing repair...', {
              level: 'warning',
              recovery: true,
              failures,
              repairPlan
            });

            const repairHint = this.buildRepairContextHint(failures, repairPlan);
            this.activeConversation.push({
              role: 'user',
              content: repairHint
            });

            const checkpoint = this.saveCheckpoint('Initiate self-healing repair');
            this.sendRecovery({
              reason: 'verification_failed',
              message: 'Verification failed. A repair checkpoint was saved and self-healing will continue.',
              failures,
              repairPlan,
              checkpoint
            });
            this.cycleCount++;
            continue;
          }
          this.checkpoint.failedVerifications = [];
          unresolvedToolFailures = this.resolveVerifiedPatchPreviews(
            unresolvedToolFailures, successfulMutationSequence, failureSequence
          );
          this.checkpoint.toolFailures = unresolvedToolFailures;
          pendingFailure = unresolvedToolFailures.length ? 'tool_failure' : null;
        }

        if (unresolvedToolFailures.length > 0) {
          pendingFailure = 'tool_failure';
          this.updateTaskGraph({ toolCalls, toolFailures: unresolvedToolFailures });
          if (toolFailures.length > 0 && !this.beginRepairCycle()) break;
          this.prepareToolFailureRetry(unresolvedToolFailures);
          this.cycleCount++;
          continue;
        }

        if (directoryTaskVerified(this.directoryTask) && !pendingFailure) {
          runCompleted = true;
          terminalReason = 'completed';
          break;
        }

        if (!hasMutations) {
          if (pendingFailure !== 'verification_failed') {
            pendingFailure = null;
            this.checkpoint.toolFailures = [];
          }
          this.updateTaskGraph({ toolCalls });
          this.sendStateChange(AgentState.OBSERVE, {
            message: 'Observation-only tools completed. Continuing with observed context...',
            observationOnly: true,
            toolCalls: toolCalls.map(tc => ({ tool: tc.tool, params: tc.params }))
          });

          if (this.goalLikelyRequiresMutation() && this.diffTracker.changedFiles.size === 0) {
            this.sendStateChange(AgentState.REPAIR, {
              message: 'Observation-only tools completed for an edit task. Redirecting the next cycle toward a concrete mutation.',
              observationOnlyEditRedirect: true,
              toolCalls: toolCalls.map(tc => ({ tool: tc.tool, params: tc.params }))
            });
            this.activeConversation.push({
              role: 'user',
              content: this.buildObservationOnlyEditPrompt(toolCalls)
            });
            this.saveCheckpoint('Force edit after observation-only tool calls');
            this.cycleCount++;
            continue;
          }

          this.saveCheckpoint('Continue after observation-only tool calls');
          this.cycleCount++;
          continue;
        }

        // If everything succeeded, save checkpoint and end the loop
        this.updateTaskGraph({
          toolCalls,
          changedFiles: Array.from(this.diffTracker.changedFiles)
        });
        runCompleted = true;
        terminalReason = 'completed';
        break;
      }

      this.checkAborted();
      if (!runCompleted && !this.budgetLimit && this.stepCount >= this.runLimits.agentMaxSteps && terminalReason === 'step_limit') {
        this.budgetLimit = 'steps';
        this.sendStatus('Agent step budget exhausted. Review the checkpoint before resuming.', {
          level: 'warning', budgetExhausted: true
        });
      }
      this.runOutcome = {
        status: runCompleted ? 'completed' : 'incomplete',
        reason: runCompleted ? 'completed' : (pendingFailure || terminalReason),
        executionBudget: this.getExecutionBudget()
      };
      this.checkpoint.outcome = this.runOutcome;
      if (runCompleted) {
        this.saveCheckpoint('Completed successfully');
      } else {
        this.sendStateChange(AgentState.FAIL, {
          message: 'Agent stopped before completing the requested work.',
          outcome: this.runOutcome
        });
        const checkpoint = this.saveCheckpoint('Review remaining work and resume');
        this.sendRecovery({
          reason: this.runOutcome.reason,
          message: 'Work is incomplete. Review the execution log and resume from the checkpoint.',
          executionBudget: this.getExecutionBudget(),
          checkpoint
        });
      }

      // --- 6. SUMMARIZE Phase ---
      this.sendStateChange(AgentState.SUMMARIZE, { message: 'Generating final summary...' });
      /*
      this.send({ type: 'status', status: '자율 작업 완료 및 최종 요약 정리 중...' });

      */
      this.sendStatus(runCompleted
        ? 'Agent work complete. Preparing final summary...'
        : 'Agent work is incomplete. Preparing recovery summary...', {
        level: runCompleted ? 'info' : 'warning',
        outcome: this.runOutcome
      });

      const sessionDiff = await this.diffTracker.getSessionDiff();
      const memoryEntry = this.recordSessionMemory(sessionDiff);
      this.sendStateChange(AgentState.SUMMARIZE, {
        message: 'Final changes summary',
        diffs: sessionDiff,
        memory: memoryEntry ? {
          recorded: true,
          id: memoryEntry.id,
          type: memoryEntry.type,
          summary: memoryEntry.summary
        } : {
          recorded: false,
          reason: this.config.agentMemoryEnabled === false ? 'disabled' : 'not available'
        }
      });

      const fallbackSummary = this.buildFallbackFinalSummary(sessionDiff);
      if (!runCompleted || !this.visibleAssistantSent || this.shouldAppendFallbackFinalSummary()) {
        this.streamVisibleAssistantOutput(fallbackSummary);
      }

      this.send({ type: 'end', outcome: this.runOutcome });
    } catch (err) {
      if (err.name === 'AbortError' || this.abortSignal?.aborted) {
        this.runOutcome = { status: 'stopped', reason: 'user_stop', executionBudget: this.getExecutionBudget() };
        this.checkpoint.outcome = this.runOutcome;
        this.sendStateChange(AgentState.STOPPED, { message: 'Agent execution was stopped by user.' });
        this.saveCheckpoint('Resume after user stop');
        this.sendStatus('Agent execution stopped by user.');
        this.send({ type: 'end', outcome: this.runOutcome });
        return;
      }
      const outputLimited = err.modelFailure?.code === 'output_token_limit';
      const failureDetails = err.modelFailure ? { modelFailure: err.modelFailure,
        modelRoute: this.formatModelRouteForUi(this.lastModelRoute || {}) } : {};
      this.runOutcome = { status: 'failed', reason: outputLimited ? 'output_token_limit' : 'agent_error', error: err.message,
        executionBudget: this.getExecutionBudget(),
        ...failureDetails };
      this.checkpoint.outcome = this.runOutcome;
      this.sendStateChange(AgentState.FAIL, { message: err.message, outcome: this.runOutcome });
      const checkpoint = this.saveCheckpoint(outputLimited
        ? `Adjust the output limit for ${err.modelFailure.model} and resume this checkpoint`
        : 'Recover after agent error');
      this.sendStatus(checkpoint
        ? 'Agent stopped after an error. Recovery checkpoint is available.'
        : 'Agent stopped after an error. Recovery checkpoint could not be saved.', {
        level: 'error',
        recovery: true,
        error: err.message,
        checkpoint
      });
      this.sendRecovery({
        reason: outputLimited ? 'output_token_limit' : 'agent_error',
        message: outputLimited
          ? 'The model reached its output limit. Adjust this model limit before resuming; completed actions are saved.'
          : 'Agent stopped after an error. Resume from the latest checkpoint after reviewing the log.',
        error: err.message,
        ...failureDetails,
        checkpoint
      });
      this.send({ type: 'error', error: err.message, ...failureDetails, checkpoint });
      this.send({ type: 'end', outcome: this.runOutcome });
    }
  }

  streamVisibleAssistantOutput(rawText) {
    const text = this.prepareVisibleAssistantText(rawText);
    if (!text) return false;

    const normalized = text.replace(/\s+/g, ' ').trim();
    if (!normalized || normalized === this.lastVisibleAssistantText) {
      return false;
    }

    this.send({ type: 'chunk', text });
    this.visibleAssistantSent = true;
    this.lastVisibleAssistantText = normalized;
    return true;
  }

  shouldAppendFallbackFinalSummary() {
    if (!Array.isArray(this.toolExecutionSummary) || this.toolExecutionSummary.length === 0) {
      return false;
    }

    const normalized = String(this.lastVisibleAssistantText || '').replace(/\s+/g, ' ').trim();
    if (!normalized) return true;
    if (normalized.length < 48) return true;

    return /^(done|complete|completed|task finished|work completed|the task is complete|blackhole task finished|작업 완료|완료|끝났습니다|처리했습니다)[.!。\s]*$/i.test(normalized);
  }

  shouldRetryPrematureCompletion() {
    if (this.directoryTask) return false;
    // P1-5: pure helper + dead-code fix (old goalLikelyRequiresMutation had
    // unreachable code after its first return).
    const hasToolResult = this.activeConversation.some(message =>
      typeof message.content === 'string' && message.content.startsWith('[Tool Result')
    );
    return shouldRetryPrematurePure({
      cycleCount: this.stepCount,
      maxCycles: this.runLimits.agentMaxSteps,
      changedFileCount: this.diffTracker.changedFiles.size,
      userGoal: this.checkpoint.userGoal,
      hasToolResult
    });
  }

  goalLikelyRequiresMutation() {
    return !this.directoryTask && goalLikelyRequiresMutationPure(this.checkpoint.userGoal);
  }

  buildPrematureCompletionPrompt() {
    return [
      '[Premature Completion Guard]',
      'The user goal appears to require a code change, but no files have been changed yet.',
      'Use the observed file context to apply a minimal edit with review_patch_transaction/apply_patch_transaction, write_file, patch_file, or patch_lines.',
      'After editing, let verification run. Do not provide a final answer until a mutation has been attempted or you can cite a concrete reason why no code change is needed.'
    ].join('\n');
  }

  buildObservationOnlyEditPrompt(toolCalls = []) {
    const observedTools = toolCalls.map(call => call.tool).filter(Boolean).join(', ') || 'non-mutating tools';
    return [
      '[Observation-Only Edit Redirect]',
      `The last cycle only used non-mutating tools (${observedTools}), but the user goal requires a code change.`,
      'Use the tool results already in the conversation. Do not keep searching or inspecting unless a required file is still unknown.',
      'On the next response, call a mutation tool: review_patch_transaction followed by apply_patch_transaction, patch_lines, patch_file, or write_file.',
      'For a small single-file fix, prefer patch_lines or a patch transaction with the exact current file text from read_file.',
      'Do not provide a final answer until a file mutation has been attempted or you can cite a specific file-level reason why no edit is needed.'
    ].join('\n');
  }

  prepareVisibleAssistantText(rawText) {
    const withoutToolBlocks = stripToolCallMarkup(rawText);

    const lines = withoutToolBlocks.split('\n');
    const deduped = [];
    let previous = '';
    for (const line of lines) {
      const normalized = line.replace(/\s+/g, ' ').trim().toLowerCase();
      if (normalized && normalized === previous) continue;
      deduped.push(line);
      previous = normalized;
    }
    return deduped.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  formatToolExecutionSummary() {
    const events = Array.isArray(this.toolExecutionSummary) ? this.toolExecutionSummary : [];
    if (events.length === 0) {
      return 'Tool summary: no tool executions were recorded.';
    }

    const succeeded = events.filter(event => event.success).length;
    const mutated = events.filter(event => event.mutated).length;
    const failed = events.filter(event => !event.success);
    const toolNames = Array.from(new Set(events.map(event => event.tool))).slice(0, 8).join(', ');

    const lines = [
      'Tool summary:',
      `- Executed: ${events.length}`,
      `- Succeeded: ${succeeded}`,
      `- Mutating tools: ${mutated}`,
      `- Tools: ${toolNames || 'none'}`
    ];

    if (failed.length > 0) {
      lines.push(`- Failed: ${failed.length} (${failed.slice(0, 3).map(event => event.tool).join(', ')})`);
    }

    return lines.join('\n');
  }

  buildFallbackFinalSummary(sessionDiff = {}) {
    const finalChangedFiles = Array.isArray(sessionDiff.changedFiles) ? sessionDiff.changedFiles : [];
    const toolSummary = this.formatToolExecutionSummary();
    if (this.runOutcome?.status === 'incomplete') {
      return [
        'Work remains incomplete.',
        `Reason: ${this.runOutcome.reason}`,
        ...(this.directoryTask ? this.directoryTask.evidence.map(entry => `Directory: ${entry.path} (${entry.status})`) : []),
        finalChangedFiles.length ? `Changed files:\n${finalChangedFiles.slice(0, 12).map(file => `- ${file}`).join('\n')}` : 'No workspace file changes were applied.',
        '',
        toolSummary,
        '',
        'Review the execution timeline and resume from the saved checkpoint.'
      ].join('\n');
    }
    if (finalChangedFiles.length === 0) {
      return [
        'Requested work completed.',
        ...(directoryTaskVerified(this.directoryTask) ? ['Verified directories:', ...this.directoryTask.paths.map(target => `- ${target}`)] : []),
        'No workspace file changes were detected in this run.',
        '',
        toolSummary,
        '',
        'Detailed tool activity and verification results are recorded in the execution timeline.'
      ].join('\n');
    }

    const finalFileLines = finalChangedFiles.slice(0, 12).map(file => `- ${file}`).join('\n');
    const finalMoreText = finalChangedFiles.length > 12 ? `\n- ...and ${finalChangedFiles.length - 12} more` : '';
    return [
      'Work completed.',
      '',
      'Changed files:',
      `${finalFileLines}${finalMoreText}`,
      '',
      toolSummary,
      '',
      'Verification details are available in the execution timeline.'
    ].join('\n');

  }

  buildSystemPrompt() {
    const basePrompt = this.config.systemInstruction || '';
    const now = new Date();
    const systemEnvSection = `[System Environment & Authority]
- Current Local Time: ${now.toLocaleString('ko-KR')} (${Intl.DateTimeFormat().resolvedOptions().timeZone})
- Operating System: ${process.platform === 'win32' ? 'Windows' : process.platform}
- Workspace Root: ${this.workspaceRoot}
- Zero-Passivity Rule: You have FULL authority to run terminal commands, files, and system tools. NEVER tell the user to open cmd/terminal, run commands, or check things themselves. When any information is needed (system time, installed software, git status, file contents, processes, network, errors), you MUST execute the appropriate tool (<run_command>, <read_file>, <list_dir>, etc.) directly yourself.`;

    const toolPrompt = this.buildToolPrompt();
    const recentlyChanged = this.contextEngine.getRecentlyChangedFiles();
    const contextSection = recentlyChanged.length > 0
      ? `\n\n[Context Hints: Recently Modified Files]\n${recentlyChanged.join('\n')}`
      : '';
    const workspaceSummary = this.contextEngine.getWorkspaceSummary();
    const workspaceSection = `\n\n[Workspace Summary]\n${JSON.stringify(workspaceSummary, null, 2)}`;
    const taskGraphSection = this.checkpoint.taskGraph
      ? `\n\n${this.taskGraphPlanner.formatTaskGraphForPrompt(this.checkpoint.taskGraph)}`
      : '';
    const memorySection = this.buildMemoryPromptSection();
    const resumeSection = this.resumeContextPrompt
      ? `\n\n[Resume Checkpoint]\n${this.resumeContextPrompt}`
      : '';

    return `${systemEnvSection}\n\n${basePrompt}\n\n${toolPrompt}${workspaceSection}${memorySection}${taskGraphSection}${resumeSection}${contextSection}`;
  }

  buildToolPrompt() {
    const isSlm = this.isLocalSlmModel();
    const phase = this.state || 'PLAN';

    // Prioritize tools by current phase
    const allTools = ToolRegistry.getAllTools();
    const prioritizedTools = [...allTools].sort((a, b) => {
      const isObsPhase = phase === AgentState.PLAN || phase === AgentState.OBSERVE;
      const isMutationPhase = phase === AgentState.ACT || phase === AgentState.REPAIR;
      
      const obsTools = new Set(['read_file', 'list_dir', 'project_search', 'inspect_code_context']);
      const mutTools = new Set(['patch_file', 'patch_lines', 'write_file', 'run_command']);

      if (isObsPhase) {
        if (obsTools.has(a.name) && !obsTools.has(b.name)) return -1;
        if (!obsTools.has(a.name) && obsTools.has(b.name)) return 1;
      } else if (isMutationPhase) {
        if (mutTools.has(a.name) && !mutTools.has(b.name)) return -1;
        if (!mutTools.has(a.name) && mutTools.has(b.name)) return 1;
      }
      return 0;
    });

    const toolLines = prioritizedTools.map((tool, index) => {
      const props = tool.inputSchema?.properties || {};
      const required = new Set(tool.inputSchema?.required || []);
      const attrs = Object.entries(props).map(([name, schema]) => {
        const marker = required.has(name) ? 'required' : 'optional';
        return `${name}:${schema.type || 'any'}:${marker}`;
      }).join(', ') || 'no parameters';
      return `${index + 1}. ${tool.name} (${attrs}) - ${tool.description}`;
    }).join('\n');

    const slmExemplar = isSlm ? `
[Standard XML Tool Format (Recommended for local model)]
- Read a file: <read_file path="src/index.js" />
- List directory: <list_dir path="." />
- Modify lines: <patch_lines path="src/index.js" startLine="10" endLine="15">new code</patch_lines>
- Write full file: <write_file path="src/index.js">file content</write_file>
- Run command: <run_command command="powershell Get-Date" />

[Autonomous Action Patterns]
Pattern 1 (System / Time / Environment Inspection):
User: 지금 몇 시야? 또는 시스템 환경 확인해줘.
Assistant:
시스템 상태를 확인하기 위해 터미널 명령을 직접 실행합니다.
<run_command command="powershell Get-Date" />

Pattern 2 (Inspect Code & Edit):
User: Check what's in package.json
Assistant:
I will read package.json to check the dependencies.
<read_file path="package.json" />
` : '';

    return `
Available tools can be called with XML tags or JSON tool calls.
${slmExemplar}
Preferred format:
{"tool_calls":[{"tool":"read_file","params":{"path":"src/index.js"}}]}
Or XML format:
<read_file path="src/index.js" />

Use exact tool names below and include required parameters. For write_file, put full file contents in params.content. For patch_file, params.search must exactly match the current file text copied from the latest read_file result, including whitespace and line breaks; if exact matching is uncertain, use patch_lines or write_file instead. For patch_lines, use params.startLine, params.endLine, and params.replacement. For multi-file edits, prefer review_patch_transaction first, then apply_patch_transaction with the same operations.

${toolLines}

Autonomous action rule: When the user asks any question requiring system inspection, time, installed packages, git status, or environment information, NEVER advise the user to run commands in cmd/terminal. You must call <run_command> directly and report the result.

Autonomous edit rule: when the user asks to implement, fix, change, create, refactor, translate, optimize, or continue development work, do not stop at advice or a plan. Inspect the workspace, edit the relevant files directly through the available file or patch tools, then let verification run and summarize the concrete result. If no code change is appropriate, state the concrete file-level reason.

Important: Prefer project_search/search_project_memory/inspect_code_context/read_file before editing. Use inspect_code_context for file outlines, symbol references, semantic diagnostics, rename impact, call graphs, and verification targets before broad multi-file edits. Use project memory for durable project decisions, recurring fixes, and handoff notes. After observation-only tools, use the returned context to make progress; do not repeat the exact same tool call unless the target changed. After editing, allow the verification phase to run.
`;
  }

  buildMemoryPromptSection() {
    if (this.config.agentMemoryEnabled === false || !this.memoryStore) {
      return '';
    }

    try {
      const section = this.memoryStore.buildPromptSection(this.checkpoint.userGoal, 8);
      return section ? `\n\n${section}` : '';
    } catch (error) {
      emitLog(`[Project Memory Read Failed] ${error.message}`, 'warning');
      return '';
    }
  }

  buildMemoryUiSnapshot() {
    if (this.config.agentMemoryEnabled === false || !this.memoryStore) {
      return { enabled: false, hits: [] };
    }

    try {
      const hits = this.memoryStore.search(this.checkpoint.userGoal, { limit: 3 }).map(entry => ({
        id: entry.id,
        type: entry.type,
        summary: entry.summary,
        score: entry.score
      }));
      return {
        enabled: true,
        hits
      };
    } catch {
      return { enabled: true, hits: [], error: 'memory search failed' };
    }
  }

  recordSessionMemory(sessionDiff = {}) {
    if (this.config.agentMemoryEnabled === false || !this.memoryStore) {
      return null;
    }

    try {
      const entry = this.memoryStore.recordRun({
        goal: this.checkpoint.userGoal,
        changedFiles: Array.isArray(sessionDiff.changedFiles) ? sessionDiff.changedFiles : [],
        verification: this.checkpoint.failedVerifications?.length ? 'failed then repaired or stopped' : 'no failed verification recorded',
        toolFailures: this.checkpoint.toolFailures || [],
        loopGuardEvents: this.checkpoint.loopGuardEvents || [],
        taskGraph: this.checkpoint.taskGraph,
        status: this.runOutcome?.status || 'incomplete'
      });
      this.checkpoint.memoryEvents = [
        ...(this.checkpoint.memoryEvents || []),
        { id: entry.id, type: entry.type, timestamp: entry.timestamp }
      ];
      return entry;
    } catch (error) {
      emitLog(`[Project Memory Write Failed] ${error.message}`, 'warning');
      return null;
    }
  }

  estimateTokens(systemPrompt = '', conversation = []) {
    const textLength = String(systemPrompt || '').length +
      conversation.reduce((total, message) => total + String(message?.content || '').length, 0);
    return Math.ceil(textLength / 4);
  }

  formatModelRouteForUi(route = {}) {
    return {
      profile: route.profile,
      phase: route.phase,
      model: route.model,
      runtime: route.runtime,
      contextLimit: route.contextLimit,
      maxTokens: route.maxTokens,
      temperature: route.temperature,
      reason: route.reason
    };
  }

  buildRepairContextHint(failures, repairPlan = null) {
    if (repairPlan) {
      return this.repairPlanner.formatRepairPrompt(repairPlan);
    }

    let hint = `[Verification Failure Detected]\nWe detected test/lint script failures on the workspace. Please review the failures below and write tools (e.g. read_file, patch_file) to repair them.\n\n`;
    for (const fail of failures) {
      hint += `### Failure Type: ${fail.type.toUpperCase()}\n`;
      if (fail.analysis) {
        if (fail.analysis.errorMessages.length > 0) {
          hint += `Error messages:\n${fail.analysis.errorMessages.join('\n')}\n`;
        }
        if (fail.analysis.suspectedFiles.length > 0) {
          hint += `Suspected Files & lines:\n`;
          fail.analysis.suspectedFiles.forEach(sf => {
            hint += `- ${sf.file} (Line: ${sf.line})\n`;
          });
        }
      }
    }
    return hint;
  }

  ensureTaskGraph() {
    if (this.checkpoint.taskGraph) return this.checkpoint.taskGraph;
    this.checkpoint.taskGraph = this.taskGraphPlanner.buildTaskGraph({
      goal: this.checkpoint.userGoal,
      planSteps: this.checkpoint.planSteps,
      workspaceSummary: this.contextEngine.getWorkspaceSummary()
    });
    this.sendStateChange(AgentState.PLAN, {
      message: 'Task graph initialized',
      taskGraph: this.checkpoint.taskGraph
    });
    return this.checkpoint.taskGraph;
  }

  updateTaskGraph(event = {}) {
    this.ensureTaskGraph();
    this.checkpoint.taskGraph = this.taskGraphPlanner.updateTaskGraph(this.checkpoint.taskGraph, event);
    this.sendStateChange(AgentState.PLAN, {
      message: 'Task graph updated',
      taskGraph: this.checkpoint.taskGraph
    });
    return this.checkpoint.taskGraph;
  }

  applyToolBatchGuard(toolCalls = []) {
    // P1-5: delegate to pure helper (behavior unchanged).
    return applyToolBatchGuardPure(toolCalls, {
      goalRequiresMutation: this.goalLikelyRequiresMutation(),
      maxTotal: this.config.agentMaxNonMutatingToolCallsBeforeEdit || 8,
      maxRunCommands: this.config.agentMaxRunCommandsBeforeEdit ?? 1,
      getMutationPaths: (tc) => this.getMutationPaths(tc)
    });
  }

  buildToolBatchGuardPrompt(batchGuard = {}) {
    const skippedTools = Array.isArray(batchGuard.skippedTools) && batchGuard.skippedTools.length
      ? batchGuard.skippedTools.join(', ')
      : 'non-mutating tools';
    return [
      '[Tool Batch Guard]',
      `The previous response requested ${batchGuard.originalCount || 0} non-mutating tool calls for an edit task, so BlackHole will execute only ${batchGuard.keptCount || 0} and skip the rest (${skippedTools}).`,
      'Use the tool results already available after this turn. Do not keep issuing run_command, project_search, or inspect_code_context calls when the target file is known.',
      'On the next response, apply a minimal mutation with patch_lines, patch_file, write_file, or a patch transaction.',
      'Run commands only after a file mutation has been attempted, unless you can state that no edit is required.'
    ].join('\n');
  }

  evaluateToolCallLoop(toolCalls = []) {
    const signature = this.createToolCallSignature(toolCalls);
    const previousCount = this.toolCallSignatureCounts.get(signature) || 0;
    const repeatCount = previousCount + 1;
    this.toolCallSignatureCounts.set(signature, repeatCount);

    if (repeatCount <= this.loopGuardMaxRepeats) {
      return { blocked: false, signature, repeatCount };
    }

    return {
      blocked: true,
      reason: 'repeated_identical_tool_calls',
      signature,
      repeatCount,
      maxRepeats: this.loopGuardMaxRepeats,
      toolCalls: toolCalls.map(tc => ({ tool: tc.tool, params: tc.params })),
      recommendation: 'Use the previous tool results already in context. Change strategy, inspect a different target, patch a file, run verification, or provide a final answer.'
    };
  }

  prepareLoopGuardRetry(loopGuard) {
    this.checkpoint.loopGuardEvents = [
      ...(this.checkpoint.loopGuardEvents || []),
      {
        reason: loopGuard.reason,
        repeatCount: loopGuard.repeatCount,
        toolCalls: loopGuard.toolCalls
      }
    ];

    this.sendStateChange(AgentState.REPAIR, {
      message: 'Loop guard detected repeated tool calls. Requesting a different strategy...',
      loopGuard
    });
    this.sendStatus('Repeated tool call pattern detected. Asking the agent to change strategy...', {
      level: 'warning',
      recovery: true,
      loopGuard
    });

    this.activeConversation.push({
      role: 'user',
      content: this.buildLoopGuardHint(loopGuard)
    });

    const checkpoint = this.saveCheckpoint('Change strategy after repeated tool calls');
    this.sendRecovery({
      reason: 'loop_guard',
      message: 'Repeated tool calls were detected. A checkpoint was saved before changing strategy.',
      loopGuard,
      checkpoint
    });
  }

  buildLoopGuardHint(loopGuard) {
    return `[Loop Guard Triggered]
The same tool-call pattern has been produced ${loopGuard.repeatCount} times. The latest repeated calls were not executed again to avoid a no-progress loop.

Repeated calls:
${JSON.stringify(loopGuard.toolCalls || [], null, 2)}

Recommendation:
${loopGuard.recommendation}

Use a different JSON tool call, inspect a different file/symbol, apply a minimal patch if enough context is available, run verification, or provide the final answer if the task is complete.`;
  }

  createToolCallSignature(toolCalls = []) {
    return createToolCallSignaturePure(toolCalls);
  }

  normalizeForSignature(value) {
    return normalizeForSignaturePure(value);
  }

  getMutationPaths(toolCall) {
    if (!toolCall || !['write_file', 'patch_file', 'patch_lines', 'apply_patch_transaction'].includes(toolCall.tool)) {
      return [];
    }
    if (toolCall.tool !== 'apply_patch_transaction') {
      return toolCall.params?.path ? [toolCall.params.path] : [];
    }
    try {
      return this.patchTransactionManager.normalizeOperations(toolCall.params?.operations)
        .map(operation => operation.path);
    } catch {
      return [];
    }
  }

  resolveVerifiedPatchPreviews(failures, successfulMutationSequence, failureSequence = new Map()) {
    const resolved = [];
    const remaining = failures.filter(failure => {
      if (failure.tool !== 'review_patch_transaction' ||
          !['execution_failed', 'validation_failed'].includes(failure.reason)) return true;
      let operations;
      try {
        operations = this.patchTransactionManager.normalizeOperations(failure.params?.operations);
      } catch {
        return true;
      }
      if (!operations.length || operations.some(operation =>
        !['write_file', 'patch_file', 'patch_lines'].includes(operation.type))) return true;
      const targets = [...new Set(operations.map(operation => this.diffTracker.normalizeTrackedPath(operation.path)))];
      // A verified edit must follow the failed preview, and cover every intended file.
      const failedAt = failureSequence.get(failure) || 0;
      if (!targets.every(target => (successfulMutationSequence.get(target) || 0) > failedAt)) return true;
      resolved.push({ ...failure, resolution: 'superseded_by_verified_edit', targets, resolvedAt: new Date().toISOString() });
      return false;
    });
    if (resolved.length) {
      this.checkpoint.resolvedToolFailures = [...(this.checkpoint.resolvedToolFailures || []), ...resolved].slice(-50);
      this.sendStatus('Failed patch preview superseded by verified file edits.', {
        recovery: true, resolvedToolFailures: resolved
      });
    }
    return remaining;
  }

  prepareToolFailureRetry(toolFailures) {
    this.checkpoint.toolFailures = toolFailures;
    this.sendStateChange(AgentState.REPAIR, {
      message: 'Tool execution failed. Requesting corrected tool calls...',
      toolFailures
    });
    this.sendStatus('Tool call failed. Preparing corrected retry context...', {
      level: 'warning',
      recovery: true,
      toolFailures
    });

    this.activeConversation.push({
      role: 'user',
      content: this.buildToolFailureHint(toolFailures)
    });

    const checkpoint = this.saveCheckpoint('Repair failed tool calls');
    this.sendRecovery({
      reason: 'tool_failure',
      message: 'Tool call failed. A repair checkpoint was saved and the agent will retry with corrected context.',
      toolFailures,
      checkpoint
    });
  }

  buildToolFailureHint(toolFailures = []) {
    const failures = toolFailures.map((failure, index) => {
      const tool = ToolRegistry.getTool(failure.tool);
      const schema = tool?.inputSchema ? JSON.stringify(tool.inputSchema, null, 2) : 'Tool is not registered.';
      const suggestions = failure.suggestions?.length ? `\nSuggested tool names: ${failure.suggestions.join(', ')}` : '';
      const validationErrors = failure.validation?.errors?.length
        ? `\nValidation errors:\n${failure.validation.errors.map(error => `- ${error}`).join('\n')}`
        : '';
      return `### Failed Tool ${index + 1}: ${failure.tool}
Reason: ${failure.reason}
Error: ${failure.error || 'unknown error'}
${failure.output ? `Output:\n${failure.output}\n` : ''}
Params:
${JSON.stringify(failure.params || {}, null, 2)}${validationErrors}${suggestions}
Schema:
${schema}`;
    }).join('\n\n');

    const availableTools = ToolRegistry.getAllTools()
      .map(tool => `- ${tool.name}: ${tool.description}`)
      .join('\n');

    return `[Tool Call Failure Detected]
The previous tool call did not complete successfully. Correct the tool call and retry using valid JSON. Do not claim completion until the required tool work succeeds.

${failures}

Preferred retry format:
{"tool_calls":[{"tool":"read_file","params":{"path":"src/example.js"}}]}

Available tools:
${availableTools}`;
  }

  formatToolFailureForModel(toolCall, result) {
    return `[tool failed]
Tool: ${toolCall.tool}
Params:
${JSON.stringify(toolCall.params || {}, null, 2)}
Error: ${result?.error || 'unknown error'}
Output:
${String(result?.result?.output || '').slice(-6000)}
Validation:
${JSON.stringify(result?.validation || null, null, 2)}`;
  }

  getToolNameSuggestions(name) {
    // P1-5: pure helper; ToolRegistry names injected for testability.
    return getToolNameSuggestionsPure(name, ToolRegistry.getAllTools().map(tool => tool.name));
  }

  levenshteinDistance(a, b) {
    return levenshteinDistancePure(a, b);
  }

  formatVerificationReport(result) {
    return {
      ok: result.ok,
      skipped: !!result.skipped,
      command: result.command,
      cwd: result.cwd,
      code: result.code,
      targeted: !!result.targeted,
      targets: result.targets || [],
      error: result.error,
      analysis: result.analysis
    };
  }

  safeSummarizeToolResult(tool, methodName, result, params) {
    try {
      if (typeof tool[methodName] === 'function') {
        return tool[methodName](result, params);
      }
    } catch (error) {
      emitLog(`[Tool Summary Failed] ${tool.name}.${methodName}: ${error.message}`, 'warning');
    }

    if (methodName === 'summarizeForUi') {
      return { type: tool.name, summaryUnavailable: true };
    }
    if (typeof result === 'string') {
      return result.slice(0, 2000);
    }
    try {
      return JSON.stringify(result, null, 2).slice(0, 2000);
    } catch {
      return `[${tool.name} completed, but result summary could not be serialized]`;
    }
  }
}
