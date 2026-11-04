import { useCallback, useEffect, useRef, useState } from 'react';
import type React from 'react';
import { shouldRefreshWorkspace } from './workspaceTree.ts';
import { appendReasoning, messagesWithoutReasoning } from './reasoning.ts';
import { consumeAgentEvents } from '../api/client.ts';
import type {
  ActiveTool,
  ApiClient,
  AppendTerminal,
  ChatAttachment,
  ChatMessage,
  CheckpointInfo,
  ExecutionBudget,
  ModelFailure,
  ModelRoute,
  PendingSecurityAction,
  StatusItem,
  StreamEvent,
  TaskItem,
  TerminalLine,
  TimelineEvent
} from '../types.ts';

const INITIAL_TERMINAL_LINES: TerminalLine[] = [
  { text: 'BlackHole agent core initialized.', i18nKey: 'terminalCoreInitialized', type: 'success' },
  { text: 'Local workspace and terminal bridge are ready.', i18nKey: 'terminalBridgeReady', type: 'log' }
];

const INITIAL_TASKS: TaskItem[] = [
  { id: 1, text: 'Agent core lifecycle and tool registry implemented', status: 'completed' },
  { id: 2, text: 'llama.cpp local runtime and GGUF model selection wired', status: 'completed' },
  { id: 3, text: 'Code intelligence, diagnostics, and patch transactions added', status: 'completed' },
  { id: 4, text: 'Checkpoint resume and task graph continuation enabled', status: 'completed' },
  { id: 5, text: 'E2E evaluation and release checks available', status: 'completed' },
  { id: 6, text: 'Real-model solve-rate evaluation ready for GGUF models', status: 'in-progress' },
  { id: 7, text: 'Large-repository durability and UX polish in progress', status: 'in-progress' }
];

const WEB_TOOL_NAMES = new Set([
  'web_search',
  'fetch_url',
  'inspect_url',
  'render_page',
  'crawl_site',
  'monitor_target'
]);

const MAX_STATUS_HISTORY = 8;
const STATUS_TERMINAL_THROTTLE_MS = 12000;

export interface RecoveryInfo {
  reason: string;
  message: string;
  error?: unknown;
  checkpoint?: unknown;
  checkpointAvailable?: boolean;
  executionBudget?: ExecutionBudget;
  modelFailure?: ModelFailure;
  modelRoute?: ModelRoute;
  timestamp: number;
}

export interface CompactionInfo {
  at: number;
  compacted?: boolean;
  removed?: number;
  previousTokens?: number;
  estimatedTokens?: number;
  reason?: string;
}

function classifyLogType(text: unknown): string {
  const value = String(text || '');
  if (value.startsWith('PS ') || value.startsWith('PS>') || value.startsWith('>')) return 'command';
  if (/error|failed|syntaxerror|blocked|rejected/i.test(value)) return 'error';
  if (/warn|gate|pending/i.test(value)) return 'warning';
  if (/success|approved|completed|saved/i.test(value)) return 'success';
  return 'log';
}

function isGenericStatus(text: unknown): boolean {
  return ['Waiting', 'Working'].includes(String(text || ''));
}

function statusTerminalType(data: StreamEvent): string {
  if (data.level === 'error') return 'error';
  if (data.level === 'warning' || data.recovery) return 'warning';
  return 'log';
}

// Rough client-side token estimate (mirrors the backend CJK/latin heuristic).
// Displayed with ≈ prefix; the gateway's own estimate is authoritative.
export function estimateContextTokens(list: ChatMessage[] = []): number {
  let cjk = 0;
  let other = 0;
  const text = (list || []).map(msg => String(msg?.content || '')).join('\n');
  for (const ch of text) {
    const code = ch.charCodeAt(0);
    if ((code >= 0x4e00 && code <= 0x9fff) || (code >= 0xac00 && code <= 0xd7af) || (code >= 0x3040 && code <= 0x30ff)) {
      cjk++;
    } else {
      other++;
    }
  }
  return Math.ceil(cjk / 1.5 + other / 3.5);
}

function appendAssistantChunk(
  setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>,
  assistantIndex: number,
  chunk: unknown
): void {
  const incomingText = String(chunk || '');
  if (!incomingText) return;

  setMessages(prev => {
    const next = [...prev];
    const currentContent = next[assistantIndex]?.content || '';
    next[assistantIndex] = {
      ...next[assistantIndex],
      role: 'assistant',
      content: currentContent + incomingText
    };
    return next;
  });
}

export default function useChatState(
  client: ApiClient | null,
  fetchFiles: (() => void) | undefined
) {
  const [messages, setMessages] = useState<ChatMessage[]>([{ role: 'assistant', content: '', i18nKey: 'welcomeMessage' }]);
  const [input, setInput] = useState('');
  const [isThinking, setIsThinking] = useState(false);
  const [statusMessage, setStatusMessage] = useState('Waiting');
  const [runStartedAt, setRunStartedAt] = useState<number | null>(null);
  const [lastSignalAt, setLastSignalAt] = useState<number | null>(null);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [lastSignalAgeSeconds, setLastSignalAgeSeconds] = useState(0);
  const [statusHistory, setStatusHistory] = useState<StatusItem[]>([]);
  const [recoveryInfo, setRecoveryInfo] = useState<RecoveryInfo | null>(null);
  const [activeTool, setActiveTool] = useState<ActiveTool | null>(null);
  const [agentTimeline, setAgentTimeline] = useState<TimelineEvent[]>([]);
  const [checkpoints, setCheckpoints] = useState<CheckpointInfo[]>([]);
  const [latestCheckpoint, setLatestCheckpoint] = useState<CheckpointInfo | null>(null);
  const [checkpointStatus, setCheckpointStatus] = useState('idle');
  const [terminalLines, setTerminalLines] = useState<TerminalLine[]>(INITIAL_TERMINAL_LINES);
  const [pendingSecurityAction, setPendingSecurityAction] = useState<PendingSecurityAction | null>(null);
  const [tasks, setTasks] = useState<TaskItem[]>(INITIAL_TASKS);
  const [newTaskInput, setNewTaskInput] = useState('');

  const activeAbortRef = useRef<AbortController | null>(null);
  const chatEndRef = useRef<HTMLDivElement | null>(null);
  const terminalEndRef = useRef<HTMLDivElement | null>(null);
  const lastStatusTerminalRef = useRef({ text: '', at: 0 });

  const appendTerminal: AppendTerminal = useCallback((text, type = 'log') => {
    setTerminalLines(prev => [...prev, { text, type }]);
  }, []);

  async function fetchAgentCheckpoints(): Promise<CheckpointInfo[]> {
    if (!client) return [];
    setCheckpointStatus('loading');
    try {
      const data = await client.request('/agent/checkpoints');
      const list = (data.checkpoints || []) as CheckpointInfo[];
      setCheckpoints(list);
      if (list[0]) setLatestCheckpoint(prev => prev || list[0]);
      setCheckpointStatus(list.length > 0 ? 'ready' : 'empty');
      return list;
    } catch (error) {
      setCheckpointStatus('error');
      appendTerminal(`Checkpoint list load failed: ${(error as Error).message}`, 'warning');
      return [];
    }
  }

  async function handleLoadLatestCheckpoint(): Promise<CheckpointInfo | null> {
    if (!client) return null;
    setCheckpointStatus('loading');
    try {
      const data = await client.request('/agent/checkpoints/latest');
      const checkpoint = (data.checkpoint || null) as CheckpointInfo | null;
      setLatestCheckpoint(checkpoint);
      setCheckpointStatus(checkpoint ? 'ready' : 'empty');
      if (checkpoint) {
        appendTerminal(`[Checkpoint Loaded] ${checkpoint.sessionId || 'latest'}`, 'success');
      }
      return checkpoint;
    } catch (error) {
      setCheckpointStatus('empty');
      appendTerminal(`Checkpoint load skipped: ${(error as Error).message}`, 'warning');
      return null;
    }
  }

  function buildCheckpointResumePrompt(checkpoint: CheckpointInfo): string {
    return [
      'Resume the previous BlackHole agent checkpoint.',
      `Session: ${checkpoint.sessionId || 'unknown'}`,
      `Workspace: ${checkpoint.workspaceRoot || 'unknown'}`,
      `Goal: ${checkpoint.userGoal || '(not recorded)'}`,
      `State: ${checkpoint.state || 'unknown'}`,
      `Cycle: ${checkpoint.cycleCount ?? 0}`,
      `Completed steps: ${(checkpoint.completedSteps || []).join(' | ') || '(none)'}`,
      `Pending steps: ${(checkpoint.pendingSteps || []).join(' | ') || '(none)'}`,
      `Changed files: ${(checkpoint.changedFiles || []).join(' | ') || '(none)'}`,
      `Failed verifications: ${JSON.stringify(checkpoint.failedVerifications || [])}`,
      `Next recommended action: ${checkpoint.nextRecommendedAction || 'continue from the last safe point'}`,
      '',
      'Continue from this checkpoint. Re-read necessary files, avoid repeating completed work, and run verification before the final summary.'
    ].join('\n');
  }

  async function handleResumeLatestCheckpoint(): Promise<void> {
    if (!client || isThinking) return;
    let checkpoint: CheckpointInfo | null;
    const reference = recoveryInfo?.checkpoint as CheckpointInfo | undefined;
    if (reference?.sessionId) {
      try {
        const data = await client.request(`/agent/checkpoints/${encodeURIComponent(reference.sessionId)}`);
        checkpoint = data.checkpoint as CheckpointInfo | null;
        if (!checkpoint || checkpoint.sessionId !== reference.sessionId) throw new Error('Requested checkpoint was not found.');
      } catch (error) {
        const message = (error as Error).message;
        appendTerminal(`Checkpoint resume skipped: ${message}`, 'error');
        setRecoveryInfo(previous => previous ? { ...previous, checkpointAvailable: false, error: message } : previous);
        return;
      }
    } else {
      checkpoint = await handleLoadLatestCheckpoint() || latestCheckpoint;
    }
    if (!checkpoint) return;

    const prompt = buildCheckpointResumePrompt(checkpoint);
    const userMessage: ChatMessage = {
      role: 'user',
      content: prompt,
      checkpointResume: true,
      providerSessionId: checkpoint.providerSessionId,
      sessionId: checkpoint.sessionId || 'latest'
    };

    await startAgentTurn({
      messagesForTurn: [...messages, userMessage],
      visibleUserMessage: userMessage,
      endpoint: '/api/chat/resume-checkpoint',
      terminalLabel: `[Checkpoint Resume Started] ${checkpoint.sessionId || 'latest'}`
    });
  }

  function processAgentStreamEvent(data: StreamEvent, assistantIndex: number): void {
    const receivedAt = Date.now();
    setLastSignalAt(receivedAt);

    if (data.type === 'chunk') {
      appendAssistantChunk(setMessages, assistantIndex, data.text);
      return;
    }

    if (data.type === 'reasoning') {
      setMessages(previous => appendReasoning(previous, assistantIndex, data));
      return;
    }

    if (data.type === 'status') {
      const statusText = data.status || 'Working';
      const timestamp = data.timestamp || receivedAt;
      setStatusMessage(statusText);

      if (!isGenericStatus(statusText)) {
        const statusItem: StatusItem = {
          status: statusText,
          phase: data.phase,
          level: data.level,
          heartbeat: Boolean(data.heartbeat),
          recovery: Boolean(data.recovery),
          elapsedMs: data.elapsedMs,
          elapsedSeconds: data.elapsedSeconds,
          executionBudget: data.executionBudget,
          timestamp
        };
        setStatusHistory(prev => [...prev, statusItem].slice(-MAX_STATUS_HISTORY));
        setAgentTimeline(prev => [
          ...prev,
          {
            state: data.recovery ? 'RECOVERY_STATUS' : (data.phase || 'STATUS'),
            payload: statusItem,
            timestamp
          }
        ]);

        const last = lastStatusTerminalRef.current;
        const shouldAppendStatus = !data.heartbeat ||
          last.text !== statusText ||
          receivedAt - last.at >= STATUS_TERMINAL_THROTTLE_MS;
        if (shouldAppendStatus) {
          lastStatusTerminalRef.current = { text: statusText, at: receivedAt };
          appendTerminal(`[Status] ${statusText}`, statusTerminalType(data));
        }
      }
      return;
    }

    if (data.type === 'tool_start') {
      setActiveTool({ name: data.tool || '', params: data.params });
      appendTerminal(`[Tool Start] ${data.tool}`, 'command');
      return;
    }

    if (data.type === 'tool_end') {
      const toolName = data.tool || activeTool?.name || '';
      setActiveTool(null);
      if (shouldRefreshWorkspace(toolName, data.result?.ok !== false)) fetchFiles?.();
      appendTerminal(`[Tool End] ${toolName}`, data.result?.ok === false ? 'error' : 'log');

      if (WEB_TOOL_NAMES.has(toolName)) {
        setMessages(prev => [
          ...prev,
          { role: 'tool_result', tool: toolName, content: data.result as unknown as string }
        ]);
      }
      return;
    }

    if (data.type === 'terminal_log') {
      appendTerminal(data.log || '', classifyLogType(data.log));
      return;
    }

    if (data.type === 'state_change') {
      setAgentTimeline(prev => [
        ...prev,
        {
          state: data.state || '',
          payload: data.payload,
          timestamp: data.timestamp || Date.now()
        }
      ]);
      return;
    }

    if (data.type === 'checkpoint') {
      setLatestCheckpoint(prev => ({ ...(prev || {}), ...(data.checkpoint || {}) }));
      fetchAgentCheckpoints();
      appendTerminal(`[Checkpoint Saved] ${data.checkpoint?.nextRecommendedAction || 'Agent state saved'}`, 'success');
      return;
    }

    if (data.type === 'recovery') {
      const recovery: RecoveryInfo = {
        reason: data.reason || 'recovery',
        message: data.message || 'Recovery information is available.',
        error: data.error,
        checkpoint: data.checkpoint,
        checkpointAvailable: data.checkpointAvailable,
        executionBudget: data.executionBudget,
        modelFailure: data.modelFailure,
        modelRoute: data.modelRoute,
        timestamp: data.timestamp || receivedAt
      };
      setRecoveryInfo(recovery);
      setAgentTimeline(prev => [
        ...prev,
        {
          state: 'RECOVERY',
          payload: recovery,
          timestamp: recovery.timestamp
        }
      ]);
      appendTerminal(`[Recovery] ${recovery.message}`, data.error ? 'error' : 'warning');
      return;
    }

    if (data.type === 'security_gate') {
      setPendingSecurityAction({
        id: data.id || '',
        tool: data.tool || '',
        params: data.params,
        reason: data.reason || ''
      });
      return;
    }

    if (data.type === 'error') {
      appendTerminal(`[Agent Error] ${data.error}`, 'error');
      setRecoveryInfo(prev => prev || {
        reason: 'agent_error',
        message: 'Agent stopped after an error.',
        error: data.error,
        modelFailure: data.modelFailure,
        modelRoute: data.modelRoute,
        checkpoint: data.checkpoint,
        checkpointAvailable: data.checkpoint === null ? false : undefined,
        timestamp: receivedAt
      });
      setMessages(prev => {
        const next = [...prev];
        const currentContent = next[assistantIndex]?.content || '';
        const errorText = `\n\n[Agent Error] ${data.error || 'Unknown error'}`;
        if (currentContent.includes(errorText.trim())) return prev;
        next[assistantIndex] = {
          ...next[assistantIndex],
          role: 'assistant',
          content: `${currentContent}${errorText}`
        };
        return next;
      });
      return;
    }

    if (data.type === 'end') {
      if (data.outcome?.status === 'completed') setRecoveryInfo(null);
      if (data.outcome) {
        appendTerminal(`[Agent ${data.outcome.status}] ${data.outcome.reason || ''}`,
          data.outcome.status === 'completed' ? 'success' : 'warning');
      }
      setStatusMessage('Waiting');
    }
  }

  async function consumeAgentStream(response: Response, assistantIndex: number,
    progress: { checkpoint: CheckpointInfo | null; unavailable: boolean }, controller: AbortController): Promise<void> {
    await consumeAgentEvents(response, event => {
      if (event.checkpoint?.sessionId) {
        progress.checkpoint = event.checkpoint as CheckpointInfo;
        progress.unavailable = false;
      }
      if (event.checkpointSaveFailed || event.checkpointAvailable === false || event.checkpoint === null) progress.unavailable = true;
      if (activeAbortRef.current === controller) processAgentStreamEvent(event, assistantIndex);
    });
  }

  async function startAgentTurn({ messagesForTurn, visibleUserMessage, endpoint = '/api/chat', terminalLabel }: {
    messagesForTurn: ChatMessage[];
    visibleUserMessage: ChatMessage;
    endpoint?: string;
    terminalLabel?: string;
  }): Promise<void> {
    if (!client || isThinking) return;

    const providerSessionId = visibleUserMessage.providerSessionId || messages.find(msg => msg.providerSessionId)?.providerSessionId || crypto.randomUUID();
    const visibleMessages = [...messages, { ...visibleUserMessage, providerSessionId }];
    const assistantIndex = visibleMessages.length;
    setMessages([...visibleMessages, { role: 'assistant', content: '' }]);
    setInput('');
    setAgentTimeline([]);
    setStatusHistory([]);
    setRecoveryInfo(null);
    lastStatusTerminalRef.current = { text: '', at: 0 };
    setIsThinking(true);
    const startedAt = Date.now();
    setRunStartedAt(startedAt);
    setLastSignalAt(startedAt);
    setElapsedSeconds(0);
    setLastSignalAgeSeconds(0);
    setStatusMessage('Working');
    if (terminalLabel) appendTerminal(terminalLabel, 'command');

    const controller = new AbortController();
    activeAbortRef.current = controller;
    const progress = { checkpoint: null as CheckpointInfo | null, unavailable: false };

    try {
      const response = await fetch(`${client.baseUrl}${endpoint}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-blackhole-token': client.token
        },
        body: JSON.stringify({
          sessionId: visibleUserMessage.sessionId,
          providerSessionId,
          messages: messagesWithoutReasoning(messagesForTurn.filter(msg => msg.role !== 'tool_result'))
        }),
        signal: controller.signal
      });

      if (!response.ok) {
        const errorPayload = await response.json().catch(() => null) as { error?: string } | null;
        throw new Error(errorPayload?.error || `Agent request failed (${response.status})`);
      }

      await consumeAgentStream(response, assistantIndex, progress, controller);
    } catch (error) {
      if (activeAbortRef.current === controller) {
        setRecoveryInfo({
          reason: controller.signal.aborted ? 'user_stop' : 'stream_disconnected',
          message: controller.signal.aborted
            ? 'Execution stopped. Review the recorded action state before resuming.'
            : 'Connection ended unexpectedly. Review the recorded action state before resuming.',
          error: controller.signal.aborted ? undefined : (error as Error).message,
          checkpoint: progress.checkpoint,
          checkpointAvailable: Boolean(progress.checkpoint) && !progress.unavailable,
          timestamp: Date.now()
        });
      }
      if ((error as Error).name === 'AbortError') {
        appendTerminal('Agent response stopped by user.', 'warning');
        setMessages(prev => {
          const next = [...prev];
          next[assistantIndex] = {
            ...next[assistantIndex],
            role: 'assistant',
            content: `${next[assistantIndex]?.content || ''}\n\n[Stopped by user]`
          };
          return next;
        });
      } else {
        appendTerminal(`Agent stream failed: ${(error as Error).message}`, 'error');
        setMessages(prev => {
          const next = [...prev];
          next[assistantIndex] = {
            ...next[assistantIndex],
            role: 'assistant',
            content: `${next[assistantIndex]?.content || ''}\n\n[Error] ${(error as Error).message}`
          };
          return next;
        });
      }
    } finally {
      if (activeAbortRef.current === controller) {
        setIsThinking(false);
        setStatusMessage('Waiting');
        setActiveTool(null);
        setRunStartedAt(null);
        setLastSignalAt(null);
        setElapsedSeconds(0);
        setLastSignalAgeSeconds(0);
        activeAbortRef.current = null;
      }
    }
  }

  async function handleSendMessage(
    attachments: ChatAttachment[] = [],
    clearAttachments: () => void = () => {}
  ): Promise<void> {
    if (!client || isThinking) return;
    if (!input.trim() && attachments.length === 0) return;

    const userMessage: ChatMessage = {
      role: 'user',
      content: input,
      attachments
    };
    const messagesForTurn = [...messages, userMessage];
    clearAttachments?.();

    await startAgentTurn({
      messagesForTurn,
      visibleUserMessage: userMessage,
      endpoint: '/api/chat'
    });
  }

  function handleStopGeneration(): void {
    if (activeAbortRef.current) {
      activeAbortRef.current.abort();
    }
  }

  const [isCompressing, setIsCompressing] = useState(false);
  const [lastCompaction, setLastCompaction] = useState<CompactionInfo | null>(null);
  const contextEstimate = estimateContextTokens(messages);

  async function handleCompressContext(contextLimit?: number): Promise<void> {
    if (!client || isThinking || isCompressing) return;
    const anchor = messages.find(msg => msg.i18nKey);
    const compressible = messages.filter(msg =>
      (msg.role === 'user' || msg.role === 'assistant') &&
      typeof msg.content === 'string' && msg.content.trim() && !msg.i18nKey
    );
    if (compressible.length < 8) {
      appendTerminal('압축할 대화가 충분하지 않습니다 (8턴 이상 필요).', 'warning');
      return;
    }
    setIsCompressing(true);
    try {
      const data = await client.request('/chat/compress', {
        method: 'POST',
        body: JSON.stringify({ messages: messagesWithoutReasoning(compressible), contextLimit, providerSessionId: messages.find(msg => msg.providerSessionId)?.providerSessionId })
      });
      if (data.compacted) {
        const archivedReasoning = messages.flatMap(message => message.reasoning || []);
        setMessages([...(anchor ? [anchor] : []), ...(data.messages as ChatMessage[]),
          ...(archivedReasoning.length ? [{ role: 'assistant' as const, content: '', reasoning: archivedReasoning }] : [])]);
        setLastCompaction({
          at: Date.now(),
          removed: data.removed,
          previousTokens: data.previousTokens,
          estimatedTokens: data.estimatedTokens
        });
        appendTerminal(`컨텍스트 압축 완료: ${data.removed + 1}턴 요약 (${data.previousTokens} → ${data.estimatedTokens} 토큰).`, 'success');
      } else {
        setLastCompaction({ at: Date.now(), compacted: false, reason: data.reason || data.error || '' });
        appendTerminal(`압축 불필요/불가: ${data.reason || data.error || '토큰 여유 있음'}`, 'log');
      }
    } catch (error) {
      appendTerminal(`압축 실패: ${(error as Error).message}`, 'error');
    } finally {
      setIsCompressing(false);
    }
  }

  async function handleRespondSecurity(id: string, decision: string): Promise<void> {
    if (!client) return;
    try {
      const data = await client.request('/security/respond', {
        method: 'POST',
        body: JSON.stringify({ id, decision })
      });
      if (data.success) {
        setPendingSecurityAction(previous => previous?.id === id ? null : previous);
        appendTerminal(`Tool decision submitted: ${decision.toUpperCase()}`, 'success');
      } else {
        appendTerminal('Tool decision was not accepted by the gateway.', 'error');
      }
    } catch (error) {
      appendTerminal(`Tool response failed: ${(error as Error).message}`, 'error');
    }
  }

  function toggleTaskStatus(id: number): void {
    setTasks(prev => prev.map(task => {
      if (task.id !== id) return task;
      const nextStatus = task.status === 'pending'
        ? 'in-progress'
        : task.status === 'in-progress'
          ? 'completed'
          : 'pending';
      return { ...task, status: nextStatus };
    }));
  }

  function handleAddTask(): void {
    if (!newTaskInput.trim()) return;
    setTasks(prev => [...prev, { id: Date.now(), text: newTaskInput.trim(), status: 'pending' }]);
    setNewTaskInput('');
  }

  const lastChatContent = messages.at(-1)?.content;
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length, lastChatContent, isThinking]);

  useEffect(() => {
    terminalEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [terminalLines]);

  useEffect(() => {
    if (!isThinking || !runStartedAt) {
      setElapsedSeconds(0);
      setLastSignalAgeSeconds(0);
      return undefined;
    }

    const updateTimers = () => {
      const now = Date.now();
      setElapsedSeconds(Math.max(0, Math.floor((now - runStartedAt) / 1000)));
      setLastSignalAgeSeconds(lastSignalAt ? Math.max(0, Math.floor((now - lastSignalAt) / 1000)) : 0);
    };

    updateTimers();
    const interval = window.setInterval(updateTimers, 1000);
    return () => window.clearInterval(interval);
  }, [isThinking, runStartedAt, lastSignalAt]);

  return {
    messages, setMessages,
    input, setInput,
    isThinking, setIsThinking,
    statusMessage, setStatusMessage,
    runStartedAt, lastSignalAt, elapsedSeconds, lastSignalAgeSeconds,
    statusHistory, recoveryInfo,
    activeTool, setActiveTool,
    agentTimeline, setAgentTimeline,
    checkpoints, setCheckpoints,
    latestCheckpoint, setLatestCheckpoint,
    checkpointStatus, setCheckpointStatus,
    fetchAgentCheckpoints, handleLoadLatestCheckpoint, handleResumeLatestCheckpoint,
    terminalLines, setTerminalLines, appendTerminal,
    pendingSecurityAction, setPendingSecurityAction, handleRespondSecurity,
    tasks, setTasks, toggleTaskStatus, newTaskInput, setNewTaskInput, handleAddTask,
    handleSendMessage, handleStopGeneration,
    isCompressing, lastCompaction, contextEstimate, handleCompressContext,
    chatEndRef, terminalEndRef, activeAbortRef
  };
}
