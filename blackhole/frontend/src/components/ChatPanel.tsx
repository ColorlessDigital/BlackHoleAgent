import React from 'react';
import type {
  ActiveTool,
  AppConfig,
  ChatAttachment,
  ChatMessage,
  CheckpointInfo,
  ExecutionBudget,
  CollabAgent,
  CollabMessage,
  ModelCatalogEntry,
  ModelFailure,
  ModelRoute,
  StatusItem,
  TerminalLine,
  TaskItem,
  TimelineEvent,
  TranslateFn
} from '../types.ts';
import type { RecoveryInfo as ChatRecoveryInfo } from '../hooks/useChatState.ts';

const TABS = [
  { id: 'chat', labelKey: 'agentChat' },
  { id: 'reasoning', labelKey: 'reasoningLog' },
  { id: 'timeline', labelKey: 'executionTimeline' },
  { id: 'planner', labelKey: 'buildPlanner' },
  { id: 'collab', labelKey: 'collaborationSimulator' }
];

const TOOL_LABEL_KEYS: Record<string, string> = {
  web_search: 'webSearch',
  fetch_url: 'httpFetch',
  inspect_url: 'securityInspection',
  render_page: 'pageRender',
  crawl_site: 'crawlResults',
  monitor_target: 'monitorReport'
};

function ModelBar({ t, config, modelCatalog, onSelectModel, contextEstimate, contextLimit, onCompressContext, isCompressing }: {
  t: TranslateFn;
  config: AppConfig;
  modelCatalog: ModelCatalogEntry[];
  onSelectModel: (modelId: string) => void;
  contextEstimate: number;
  contextLimit?: number;
  onCompressContext: () => void;
  isCompressing: boolean;
}) {
  const limit = Number(contextLimit) || 8192;
  const pct = Math.min(100, Math.round(((Number(contextEstimate) || 0) / limit) * 100));
  const activeModel = config?.activeModel || '';
  const inCatalog = (modelCatalog || []).some(entry => entry.id === activeModel);
  const meterColor = pct >= 90 ? '#f87171' : pct >= 70 ? '#fbbf24' : 'var(--text-secondary)';
  return (
    <div className="chat-model-bar" style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', borderBottom: '1px solid rgba(255,255,255,0.06)', background: 'rgba(255,255,255,0.02)' }}>
      <span style={{ color: 'var(--text-secondary)', fontSize: 12, flexShrink: 0 }}>{t('modelPickerLabel')}</span>
      <select
        value={activeModel}
        onChange={(event) => onSelectModel?.(event.target.value)}
        title={t('modelPickerLabel')}
        style={{ flex: 1, minWidth: 0, background: 'rgba(255,255,255,0.05)', color: 'var(--text-primary)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 6, padding: '4px 6px', fontSize: 12 }}
      >
        {(modelCatalog || []).map(entry => (
          <option key={entry.id} value={entry.id} title={entry.availabilityReason}>
            {entry.label || entry.id} ({entry.provider}{entry.contextLimit ? ` · ${entry.contextLimit}` : ''})
            {entry.availability === 'unsupported' ? ` (${t('goUnsupported')})` : entry.availability === 'not_listed' ? ` (${t('goNotListed')})` : ''}
          </option>
        ))}
        {!inCatalog && activeModel && <option value={activeModel}>{activeModel}</option>}
        {(modelCatalog || []).length === 0 && !activeModel && <option value="">-</option>}
      </select>
      <span style={{ color: meterColor, fontSize: 11, flexShrink: 0 }} title={t('contextMeterGuide')}>
        ≈{Number(contextEstimate) || 0}/{limit} ({pct}%)
      </span>
      <button
        className="chat-send-btn"
        type="button"
        onClick={onCompressContext}
        disabled={isCompressing}
        title={t('compressContextGuide')}
        style={{ fontSize: 11, padding: '4px 8px', flexShrink: 0 }}
      >
        {isCompressing ? t('compressing') : t('compressContext')}
      </button>
    </div>
  );
}

function formatDate(value: unknown): string {
  if (!value) return '';
  try {
    return new Date(value as string | number).toLocaleString();
  } catch {
    return String(value);
  }
}

function formatDuration(seconds: number): string {
  const totalSeconds = Number(seconds || 0);
  if (!Number.isFinite(totalSeconds) || totalSeconds <= 0) return '0s';
  const minutes = Math.floor(totalSeconds / 60);
  const remainingSeconds = totalSeconds % 60;
  if (minutes <= 0) return `${remainingSeconds}s`;
  return `${minutes}m ${remainingSeconds}s`;
}

function formatStatusTimestamp(value: unknown): string {
  if (!value) return '';
  try {
    return new Date(value as string | number).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch {
    return '';
  }
}

function roleLabel(role: string, t: TranslateFn): string {
  if (role === 'user') return t('roleUser');
  if (role === 'tool_result') return t('roleTool');
  return t('roleAssistant');
}

function renderCodeAwareText(content: unknown): React.ReactNode {
  const text = typeof content === 'string' ? content : JSON.stringify(content, null, 2);
  const parts: Array<{ type: 'text' | 'code'; value: string; language?: string }> = [];
  const codeFence = /```([\w-]*)\n([\s\S]*?)```/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = codeFence.exec(text))) {
    if (match.index > lastIndex) {
      parts.push({ type: 'text', value: text.slice(lastIndex, match.index) });
    }
    parts.push({ type: 'code', language: match[1] || 'code', value: match[2] });
    lastIndex = codeFence.lastIndex;
  }

  if (lastIndex < text.length) {
    parts.push({ type: 'text', value: text.slice(lastIndex) });
  }

  return parts.map((part, index) => {
    if (part.type === 'code') {
      return (
        <div key={`code-${index}`} style={{ margin: '10px 0', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 8, overflow: 'hidden' }}>
          <div style={{ padding: '6px 10px', background: 'rgba(255,255,255,0.04)', color: 'var(--text-secondary)', fontSize: 11 }}>
            {part.language}
          </div>
          <pre style={{ margin: 0, padding: 12, overflowX: 'auto', whiteSpace: 'pre-wrap' }}>
            <code>{part.value}</code>
          </pre>
        </div>
      );
    }

    return part.value.split('\n\n').map((paragraph, paragraphIndex) => (
      <p key={`p-${index}-${paragraphIndex}`} style={{ whiteSpace: 'pre-wrap' }}>
        {paragraph}
      </p>
    ));
  });
}

interface ToolResultPayload {
  results?: Array<{ title?: string; url?: string; snippet?: string }>;
  query?: string;
  url?: string;
  error?: string;
  fallback?: unknown;
}

function ToolResultCard({ message, t }: { message: ChatMessage; t: TranslateFn }) {
  // tool_result messages carry the structured payload in `content`
  // (see useChatState processAgentStreamEvent).
  const result = (message.content as unknown as ToolResultPayload) || {};
  const title = t(TOOL_LABEL_KEYS[message.tool || ''] || 'roleTool');
  const resultItems = Array.isArray(result.results) ? result.results : [];

  return (
    <div className="tool-call-card">
      <div className="tool-call-header">{title}</div>
      {result.query && <div className="tool-call-param">query: {result.query}</div>}
      {result.url && <div className="tool-call-param">url: {result.url}</div>}
      {result.error && <div style={{ color: '#f87171', marginTop: 8 }}>{t('error')}: {result.error}</div>}
      {result.fallback ? <div style={{ color: '#fbbf24', marginTop: 8 }}>{t('fallback')}</div> : null}
      {resultItems.length > 0 && (
        <div style={{ display: 'grid', gap: 8, marginTop: 10 }}>
          {resultItems.slice(0, 6).map((item, index) => (
            <div key={`${item.url || item.title || index}`} style={{ padding: 8, border: '1px solid rgba(255,255,255,0.08)', borderRadius: 6 }}>
              <div style={{ color: 'var(--accent-cyan)', fontWeight: 700 }}>{item.title || item.url || `#${index + 1}`}</div>
              {item.url && <div style={{ color: 'var(--text-secondary)', fontSize: 12, wordBreak: 'break-all' }}>{item.url}</div>}
              {item.snippet && <div style={{ color: 'var(--text-primary)', fontSize: 12, marginTop: 4 }}>{item.snippet}</div>}
            </div>
          ))}
        </div>
      )}
      {resultItems.length === 0 && (
        <pre style={{ whiteSpace: 'pre-wrap', margin: '10px 0 0' }}>{JSON.stringify(result, null, 2)}</pre>
      )}
    </div>
  );
}

function ChatMessages({ messages, chatEndRef, t }: {
  messages: ChatMessage[];
  chatEndRef: React.RefObject<HTMLDivElement | null>;
  t: TranslateFn;
}) {
  return (
    <div className="chat-messages">
      {messages.length === 0 && <div style={{ color: 'var(--text-secondary)' }}>{t('noMessages')}</div>}
      {messages.map((message, index) => {
        if (message.role === 'assistant' && !message.content && message.reasoning?.length) return null;
        if (message.role === 'tool_result') {
          return <ToolResultCard key={`tool-${index}`} message={message} t={t} />;
        }
        const content = message.i18nKey ? t(message.i18nKey) : message.content;
        return (
          <div key={`${message.role}-${index}`} className={`chat-message ${message.role === 'user' ? 'user' : 'assistant'}`}>
            <div style={{ color: 'var(--text-secondary)', fontSize: 11, marginBottom: 6, fontWeight: 700 }}>
              {roleLabel(message.role, t)}
            </div>
            {renderCodeAwareText(content)}
            {message.attachments && message.attachments.length > 0 && (
              <div style={{ marginTop: 8, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {message.attachments.map((attachment, attachmentIndex) => (
                  <span key={`${attachment.name}-${attachmentIndex}`} style={{ border: '1px solid rgba(255,255,255,0.1)', borderRadius: 6, padding: '2px 6px', fontSize: 11 }}>
                    {attachment.name}
                  </span>
                ))}
              </div>
            )}
          </div>
        );
      })}
      <div ref={chatEndRef} />
    </div>
  );
}

function ChatInput({
  t,
  input,
  setInput,
  isThinking,
  attachments,
  setAttachments,
  showAttachmentMenu,
  setShowAttachmentMenu,
  handleFileAttachment,
  removeAttachment,
  attachmentMenuRef,
  handleSendMessage,
  handleStopGeneration
}: {
  t: TranslateFn;
  input: string;
  setInput: (value: string) => void;
  isThinking: boolean;
  attachments: ChatAttachment[];
  setAttachments: React.Dispatch<React.SetStateAction<ChatAttachment[]>>;
  showAttachmentMenu: boolean;
  setShowAttachmentMenu: (show: boolean) => void;
  handleFileAttachment: (e: React.ChangeEvent<HTMLInputElement>, forceType?: string | null) => void;
  removeAttachment: (index: number) => void;
  attachmentMenuRef: React.RefObject<HTMLDivElement | null>;
  handleSendMessage: (attachments: ChatAttachment[], clearAttachments: () => void) => void;
  handleStopGeneration: () => void;
}) {
  const textareaRef = React.useRef<HTMLTextAreaElement | null>(null);

  const canSend = (input && input.trim().length > 0) || attachments.length > 0;

  const send = () => {
    if (!canSend || isThinking) return;
    handleSendMessage(attachments, () => setAttachments([]));
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }
  };

  const handleInputChange = (event: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(event.target.value);
    const textarea = textareaRef.current;
    if (textarea) {
      textarea.style.height = 'auto';
      textarea.style.height = `${Math.min(textarea.scrollHeight, 160)}px`;
    }
  };

  return (
    <div className="chat-input-area">
      {attachments.length > 0 && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
          {attachments.map((attachment, index) => (
            <button
              key={`${attachment.name}-${index}`}
              onClick={() => removeAttachment(index)}
              title={t('removeAttachment')}
              type="button"
              style={{ border: '1px solid rgba(255,255,255,0.12)', borderRadius: 6, background: 'rgba(255,255,255,0.04)', color: 'var(--text-secondary)', padding: '4px 8px', cursor: 'pointer' }}
            >
              {attachment.name} x
            </button>
          ))}
        </div>
      )}

      <div className="chat-input-wrapper">
        <div style={{ position: 'relative' }} ref={attachmentMenuRef}>
          <button className="chat-send-btn" type="button" onClick={() => setShowAttachmentMenu(!showAttachmentMenu)} title={t('attach')}>
            +
          </button>
          {showAttachmentMenu && (
            <div style={{ position: 'absolute', bottom: 48, left: 0, zIndex: 5, width: 180, padding: 8, border: '1px solid rgba(255,255,255,0.12)', borderRadius: 8, background: 'var(--bg-secondary)' }}>
              <label className="btn-save-settings" style={{ display: 'block', marginBottom: 8, textAlign: 'center', cursor: 'pointer' }}>
                {t('attachText')}
                <input type="file" multiple style={{ display: 'none' }} onChange={(event) => handleFileAttachment(event, 'text')} />
              </label>
              <label className="btn-save-settings" style={{ display: 'block', textAlign: 'center', cursor: 'pointer' }}>
                {t('attachImage')}
                <input type="file" multiple accept="image/*" style={{ display: 'none' }} onChange={(event) => handleFileAttachment(event, 'image')} />
              </label>
            </div>
          )}
        </div>

        <textarea
          ref={textareaRef}
          className="chat-textarea"
          rows={1}
          value={input}
          placeholder={t('chatPlaceholder')}
          onChange={handleInputChange}
          onKeyDown={(event) => {
            // Prevent duplicate message submission during CJK (Hangul) IME composition
            if (event.nativeEvent?.isComposing || event.keyCode === 229) return;
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              send();
            }
          }}
        />
        {isThinking ? (
          <button className="chat-send-btn chat-stop-btn" type="button" onClick={handleStopGeneration} title={t('stopBtn')}>
            &#9632;
          </button>
        ) : (
          <button className="chat-send-btn" type="button" onClick={send} disabled={!canSend} title={t('send')}>
            &gt;
          </button>
        )}
      </div>
    </div>
  );
}

function TimelineEventCard({ event, index: _index }: { event: TimelineEvent; index: number }) {
  void _index;
  const [isExpanded, setIsExpanded] = React.useState(false);
  const summaryMessage = event.payload?.message || event.payload?.status || (event.payload?.tool ? `Tool: ${event.payload.tool}` : '');

  return (
    <div style={{ border: '1px solid rgba(255,255,255,0.08)', borderRadius: 8, padding: 10, background: 'rgba(255,255,255,0.02)' }}>
      <div
        onClick={() => setIsExpanded(!isExpanded)}
        style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, cursor: event.payload ? 'pointer' : 'default' }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, overflow: 'hidden' }}>
          <strong style={{ color: 'var(--accent-cyan)', fontSize: 13, flexShrink: 0 }}>{event.state}</strong>
          {summaryMessage && (
            <span style={{ color: 'var(--text-primary)', fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {summaryMessage}
            </span>
          )}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
          <span style={{ color: 'var(--text-secondary)', fontSize: 11 }}>{formatDate(event.timestamp)}</span>
          {event.payload && (
            <span style={{ color: 'var(--text-secondary)', fontSize: 11, border: '1px solid rgba(255,255,255,0.1)', borderRadius: 4, padding: '1px 5px' }}>
              {isExpanded ? '▲' : '▼'}
            </span>
          )}
        </div>
      </div>
      {isExpanded && event.payload && (
        <pre style={{ whiteSpace: 'pre-wrap', marginTop: 10, marginBottom: 0, color: 'var(--text-secondary)', fontSize: 12, maxHeight: 300, overflowY: 'auto' }}>
          {JSON.stringify(event.payload, null, 2)}
        </pre>
      )}
    </div>
  );
}

function TimelineTab({
  t,
  agentTimeline,
  checkpoints,
  latestCheckpoint,
  checkpointStatus,
  fetchAgentCheckpoints,
  handleLoadLatestCheckpoint,
  handleResumeLatestCheckpoint
}: {
  t: TranslateFn;
  agentTimeline: TimelineEvent[];
  checkpoints: CheckpointInfo[];
  latestCheckpoint: CheckpointInfo | null;
  checkpointStatus: string;
  fetchAgentCheckpoints: () => void;
  handleLoadLatestCheckpoint: () => void;
  handleResumeLatestCheckpoint: () => void;
}) {
  const stats = agentTimeline.reduce((acc, event) => {
    acc.total += 1;
    if (String(event.state || '').includes('tool')) acc.tools += 1;
    if (String(event.state || '').includes('fail') || String(event.state || '').includes('error')) acc.failures += 1;
    if (String(event.state || '').includes('verify')) acc.verifications += 1;
    if (String(event.state || '').includes('route')) acc.routes += 1;
    if (String(event.state || '').includes('memory')) acc.memory += 1;
    return acc;
  }, { total: 0, tools: 0, failures: 0, verifications: 0, routes: 0, memory: 0 });

  return (
    <div className="planner-container">
      <div className="plan-section">
        <div className="plan-title">{t('executionTimeline')}</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 8, marginBottom: 12 }}>
          <Metric label={t('timelineTotal')} value={stats.total} />
          <Metric label={t('timelineTools')} value={stats.tools} />
          <Metric label={t('timelineFailures')} value={stats.failures} />
          <Metric label={t('timelineVerifications')} value={stats.verifications} />
          <Metric label={t('timelineRoutes')} value={stats.routes} />
          <Metric label={t('timelineMemory')} value={stats.memory} />
        </div>
        {agentTimeline.length === 0 ? (
          <div style={{ color: 'var(--text-secondary)', fontSize: 13 }}>{t('noTimelineEvents')}</div>
        ) : (
          <div style={{ display: 'grid', gap: 8 }}>
            {agentTimeline.map((event, index) => (
              <TimelineEventCard key={`${event.timestamp}-${index}`} event={event} index={index} />
            ))}
          </div>
        )}
      </div>

      <div className="plan-section">
        <div className="plan-title">{t('checkpoints')}</div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
          <button className="btn-save-settings" type="button" onClick={fetchAgentCheckpoints}>{t('refresh')}</button>
          <button className="btn-save-settings" type="button" onClick={handleLoadLatestCheckpoint}>{t('loadLatest')}</button>
          <button className="btn-save-settings" type="button" onClick={handleResumeLatestCheckpoint} disabled={!latestCheckpoint}>{t('resumeLatest')}</button>
          <span style={{ color: 'var(--text-secondary)', fontSize: 12, alignSelf: 'center' }}>{checkpointStatus}</span>
        </div>
        {latestCheckpoint && (
          <div style={{ border: '1px solid rgba(255,255,255,0.08)', borderRadius: 8, padding: 10, marginBottom: 10 }}>
            <strong style={{ color: 'var(--accent-violet)' }}>{t('checkpointLatest')}</strong>
            <div style={{ color: 'var(--text-secondary)', fontSize: 12 }}>{t('state')}: {latestCheckpoint.state || '-'}</div>
            <div style={{ color: 'var(--text-secondary)', fontSize: 12 }}>{t('savedAt')}: {formatDate(latestCheckpoint.timestamp || latestCheckpoint.createdAt)}</div>
          </div>
        )}
        {checkpoints.length === 0 ? (
          <div style={{ color: 'var(--text-secondary)', fontSize: 13 }}>{t('noCheckpoints')}</div>
        ) : (
          checkpoints.slice(0, 8).map((checkpoint, index) => (
            <div key={`${checkpoint.sessionId || index}-${checkpoint.timestamp || index}`} style={{ color: 'var(--text-secondary)', fontSize: 12, padding: '4px 0' }}>
              {checkpoint.sessionId || `#${index + 1}`} - {checkpoint.state || '-'}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function ReasoningLogTab({ messages, t }: { messages: ChatMessage[]; t: TranslateFn }) {
  const records = messages.flatMap(message => message.reasoning || []);
  const viewport = React.useRef<HTMLDivElement>(null);
  const pinned = React.useRef(true);
  const lastText = records.at(-1)?.text;
  React.useEffect(() => {
    if (pinned.current && viewport.current) viewport.current.scrollTop = viewport.current.scrollHeight;
  }, [records.length, lastText]);
  return (
    <div className="reasoning-log" ref={viewport} onScroll={event => {
      const element = event.currentTarget;
      pinned.current = element.scrollHeight - element.scrollTop - element.clientHeight < 40;
    }}>
      <div className="reasoning-log-title">{t('reasoningLog')} <span>{records.length}</span></div>
      {!records.length && <div className="reasoning-log-empty">{t('noReasoningRecords')}</div>}
      {records.map((record, index) => (
        <section key={`${record.id}-${index}`} className="reasoning-log-entry">
          <header>
            <span>{record.model || t('roleAssistant')}</span>
            {record.phase && <span>{record.phase}</span>}
            {record.step !== undefined && <span>{t('agentStepsUsed')}: {record.step}</span>}
            <time>{formatDate(record.startedAt)}</time>
          </header>
          <pre>{record.text}</pre>
        </section>
      ))}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div style={{ padding: 10, border: '1px solid rgba(255,255,255,0.08)', borderRadius: 8, background: 'rgba(255,255,255,0.03)' }}>
      <div style={{ color: 'var(--text-secondary)', fontSize: 11 }}>{label}</div>
      <div style={{ color: 'var(--text-primary)', fontSize: 18, fontWeight: 800 }}>{value}</div>
    </div>
  );
}

function RunBudgetLabel({ budget, t }: { budget?: ExecutionBudget; t: TranslateFn }) {
  if (!budget || ![budget.stepsUsed, budget.maxSteps, budget.repairCyclesUsed, budget.maxRepairCycles].every(Number.isSafeInteger)) return null;
  return (
    <span className="run-budget" style={{ display: 'inline-flex', gap: 8, flexWrap: 'wrap', fontSize: 12 }}>
      <span>{t('agentStepsUsed')}: {budget.stepsUsed}/{budget.maxSteps}</span>
      <span>{t('agentRepairsUsed')}: {budget.repairCyclesUsed}/{budget.maxRepairCycles}</span>
    </span>
  );
}

function OutputLimitRecovery({ failure, route, onResume, disabled, t }: {
  failure: ModelFailure;
  route?: ModelRoute;
  onResume?: (model: string, maxTokens: number) => Promise<void>;
  disabled: boolean;
  t: TranslateFn;
}) {
  const [value, setValue] = React.useState(String(failure.outputTokenLimit || ''));
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState('');
  const limit = Number(value);
  const valid = Number.isSafeInteger(limit) && limit > Number(failure.outputTokenLimit || 0);
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!valid || !onResume || busy || disabled || !failure.model) return;
    setBusy(true);
    setError('');
    try { await onResume(failure.model, limit); }
    catch (cause) { setError((cause as Error).message); }
    finally { setBusy(false); }
  };
  return (
    <form className="output-limit-recovery" onSubmit={submit}>
      <div>{t('outputLimitReached', { model: failure.model || '', limit: failure.outputTokenLimit || 0 })}</div>
      {route?.profile && <div>{t('outputLimitProfile', { profile: route.profile })}</div>}
      <label>
        <span>{t('goModelOutputLimit')}</span>
        <input type="number" min={1} step={1} value={value} disabled={disabled || busy}
          onChange={event => setValue(event.target.value)} />
      </label>
      <button type="submit" className="btn-save-settings" disabled={disabled || busy || !valid || !onResume}>
        {t(busy ? 'outputLimitSaving' : 'outputLimitSaveResume')}
      </button>
      {error && <div role="alert" className="recovery-error">{error}</div>}
    </form>
  );
}

function RecoveryBanner({ recoveryInfo, latestCheckpoint, handleResumeLatestCheckpoint, handleResumeWithOutputLimit, isThinking, t }: {
  recoveryInfo: ChatRecoveryInfo | null;
  latestCheckpoint: CheckpointInfo | null;
  handleResumeLatestCheckpoint: () => void;
  handleResumeWithOutputLimit?: (model: string, maxTokens: number) => Promise<void>;
  isThinking: boolean;
  t: TranslateFn;
}) {
  if (!recoveryInfo) return null;

  const unavailable = recoveryInfo.checkpointAvailable === false;
  const checkpoint = unavailable ? null : (recoveryInfo.checkpoint as CheckpointInfo | undefined) || latestCheckpoint;
  const checkpointLabel = checkpoint?.nextRecommendedAction || checkpoint?.sessionId || t('recoveryCheckpoint');
  const failure = recoveryInfo.modelFailure;
  const outputLimited = failure?.provider === 'opencode-go' && failure.code === 'output_token_limit' && failure.model;

  return (
    <div className="recovery-banner">
      <div style={{ minWidth: 0 }}>
        <div className="recovery-title">{t(unavailable ? 'recoveryUnavailable' : 'recoveryReady')}</div>
        <div className="recovery-message">{recoveryInfo.message || t('recoveryHint')}</div>
        {recoveryInfo.executionBudget?.limitReached && <div className="recovery-message">
          {t(recoveryInfo.executionBudget.limitReached === 'steps' ? 'agentStepLimitReached' : 'agentRepairLimitReached')}
        </div>}
        <RunBudgetLabel budget={recoveryInfo.executionBudget} t={t} />
        {recoveryInfo.error ? <div className="recovery-error">{t('recoveryError')}: {String(recoveryInfo.error)}</div> : null}
        {checkpoint && <div className="recovery-checkpoint">{t('recoveryCheckpoint')}: {checkpointLabel}</div>}
        {outputLimited && <OutputLimitRecovery key={`${failure.model}:${failure.outputTokenLimit}`}
          failure={failure} route={recoveryInfo.modelRoute} onResume={handleResumeWithOutputLimit}
          disabled={!checkpoint || isThinking} t={t} />}
      </div>
      <button className="btn-save-settings" type="button" onClick={handleResumeLatestCheckpoint} disabled={!checkpoint || isThinking}>
        {t('resumeLatest')}
      </button>
    </div>
  );
}

function StatusHistoryStrip({ statusHistory, t }: { statusHistory: StatusItem[]; t: TranslateFn }) {
  if (!statusHistory.length) return null;
  const recent = statusHistory.slice(-5).reverse();

  return (
    <div className="status-history-strip">
      <span className="status-history-label">{t('recentStatus')}</span>
      {recent.map((item, index) => (
        <span
          key={`${item.timestamp}-${index}`}
          className={`status-history-item ${item.level === 'error' ? 'error' : item.recovery || item.level === 'warning' ? 'warning' : ''}`}
          title={item.status}
        >
          {item.phase && <strong>{item.phase}</strong>}
          <span>{item.status}</span>
          <em>{formatStatusTimestamp(item.timestamp)}</em>
        </span>
      ))}
    </div>
  );
}

function PlannerTab({ t, tasks, toggleTaskStatus, newTaskInput, setNewTaskInput, handleAddTask }: {
  t: TranslateFn;
  tasks: TaskItem[];
  toggleTaskStatus: (id: number) => void;
  newTaskInput: string;
  setNewTaskInput: (value: string) => void;
  handleAddTask: () => void;
}) {
  return (
    <div className="planner-container">
      <div className="plan-section">
        <div className="plan-title">{t('taskChecklist')}</div>
        {tasks.length === 0 ? (
          <div style={{ color: 'var(--text-secondary)' }}>{t('noTasks')}</div>
        ) : (
          tasks.map(task => (
            <button
              key={task.id}
              className="task-item"
              type="button"
              onClick={() => toggleTaskStatus(task.id)}
              style={{ width: '100%', textAlign: 'left', background: 'transparent', border: 'none', color: 'var(--text-primary)', cursor: 'pointer' }}
            >
              <span className={`task-checkbox ${task.status === 'completed' ? 'checked' : ''}`} />
              <span style={{ flex: 1 }}>{task.text}</span>
              <span style={{ color: 'var(--text-secondary)', fontSize: 11 }}>{task.status}</span>
            </button>
          ))
        )}
        <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
          <input
            className="settings-input"
            value={newTaskInput}
            placeholder={t('addTaskPlaceholder')}
            onChange={(event) => setNewTaskInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') handleAddTask();
            }}
          />
          <button className="btn-save-settings" type="button" onClick={handleAddTask}>{t('addBtn')}</button>
        </div>
      </div>
    </div>
  );
}

function CollaborationTab({
  t,
  collabTopic,
  setCollabTopic,
  collabAgents,
  setCollabAgents,
  collabMessages,
  isCollaborating,
  activeCollabAgent,
  handleStartCollaboration,
  handleStopCollaboration
}: {
  t: TranslateFn;
  collabTopic: string;
  setCollabTopic: (value: string) => void;
  collabAgents: CollabAgent[];
  setCollabAgents: React.Dispatch<React.SetStateAction<CollabAgent[]>>;
  collabMessages: CollabMessage[];
  isCollaborating: boolean;
  activeCollabAgent: string;
  handleStartCollaboration: () => void;
  handleStopCollaboration: () => void;
}) {
  const updateAgent = (index: number, key: 'name' | 'role', value: string) => {
    setCollabAgents(prev => prev.map((agent, agentIndex) => (
      agentIndex === index ? { ...agent, [key]: value } : agent
    )));
  };

  const addAgent = () => setCollabAgents(prev => [...prev, { name: `Agent ${prev.length + 1}`, role: 'reviewer' }]);
  const removeAgent = (index: number) => setCollabAgents(prev => prev.filter((_, agentIndex) => agentIndex !== index));

  return (
    <div className="planner-container collaborator-container">
      <div className="plan-section">
        <div className="plan-title">{t('collaborationTopic')}</div>
        <textarea
          className="settings-input"
          value={collabTopic}
          placeholder={t('collaborationTopicPlaceholder')}
          rows={4}
          onChange={(event) => setCollabTopic(event.target.value)}
        />
      </div>

      <div className="plan-section">
        <div className="plan-title">{t('participatingAgents')}</div>
        {collabAgents.map((agent, index) => (
          <div key={`${agent.name}-${index}`} style={{ display: 'grid', gridTemplateColumns: '1fr 1fr auto', gap: 8, marginBottom: 8 }}>
            <input className="settings-input" value={agent.name || ''} placeholder={t('agentName')} onChange={(event) => updateAgent(index, 'name', event.target.value)} />
            <input className="settings-input" value={agent.role || ''} placeholder={t('agentRole')} onChange={(event) => updateAgent(index, 'role', event.target.value)} />
            <button className="btn-save-settings" type="button" onClick={() => removeAgent(index)}>{t('remove')}</button>
          </div>
        ))}
        <button className="btn-save-settings" type="button" onClick={addAgent}>{t('addAgent')}</button>
      </div>

      <div className="plan-section">
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12 }}>
          {isCollaborating ? (
            <button className="btn-save-settings" type="button" onClick={handleStopCollaboration}>{t('stopCollaboration')}</button>
          ) : (
            <button className="btn-save-settings" type="button" onClick={handleStartCollaboration}>{t('startCollaboration')}</button>
          )}
          <span style={{ color: 'var(--text-secondary)', fontSize: 12 }}>
            {isCollaborating ? `${t('collaborationInProgress')}: ${activeCollabAgent || '-'}` : t('collaborationCompleted')}
          </span>
        </div>
        <div className="chat-messages" style={{ minHeight: 160, maxHeight: 420 }}>
          {collabMessages.length === 0 ? (
            <div style={{ color: 'var(--text-secondary)', fontSize: 13, padding: '24px 0', textAlign: 'center' }}>
              {t('noTimelineEvents')}
            </div>
          ) : (
            collabMessages.map((message, index) => (
              <div key={`${message.agent || message.role}-${index}`} className="chat-message assistant" style={{ maxWidth: '100%' }}>
                <strong style={{ color: 'var(--accent-cyan)' }}>{message.agent || message.role || 'Agent'}</strong>
                <div>{message.content || message.text}</div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

export interface ChatPanelProps {
  activeBrainTab: string;
  setActiveBrainTab: (tab: string) => void;
  locale?: string;
  t: TranslateFn;
  isThinking: boolean;
  statusMessage: string;
  elapsedSeconds?: number;
  lastSignalAgeSeconds?: number;
  statusHistory?: StatusItem[];
  recoveryInfo?: ChatRecoveryInfo | null;
  handleResumeWithOutputLimit?: (model: string, maxTokens: number) => Promise<void>;
  handleStopGeneration: () => void;
  messages: ChatMessage[];
  activeTool: ActiveTool | null;
  attachments: ChatAttachment[];
  setAttachments: React.Dispatch<React.SetStateAction<ChatAttachment[]>>;
  showAttachmentMenu: boolean;
  setShowAttachmentMenu: (show: boolean) => void;
  handleFileAttachment: (e: React.ChangeEvent<HTMLInputElement>, forceType?: string | null) => void;
  removeAttachment: (index: number) => void;
  attachmentMenuRef: React.RefObject<HTMLDivElement | null>;
  input: string;
  setInput: (value: string) => void;
  handleSendMessage: (attachments: ChatAttachment[], clearAttachments: () => void) => void;
  tasks: TaskItem[];
  toggleTaskStatus: (id: number) => void;
  newTaskInput: string;
  setNewTaskInput: (value: string) => void;
  handleAddTask: () => void;
  collabTopic: string;
  setCollabTopic: (value: string) => void;
  collabAgents: CollabAgent[];
  setCollabAgents: React.Dispatch<React.SetStateAction<CollabAgent[]>>;
  collabMessages: CollabMessage[];
  setCollabMessages?: React.Dispatch<React.SetStateAction<CollabMessage[]>>;
  isCollaborating: boolean;
  activeCollabAgent: string;
  handleStartCollaboration: () => void;
  handleStopCollaboration: () => void;
  chatEndRef: React.RefObject<HTMLDivElement | null>;
  terminalLines?: TerminalLine[];
  agentTimeline?: TimelineEvent[];
  checkpoints?: CheckpointInfo[];
  latestCheckpoint?: CheckpointInfo | null;
  checkpointStatus?: string;
  fetchAgentCheckpoints?: () => void;
  handleLoadLatestCheckpoint?: () => void;
  handleResumeLatestCheckpoint?: () => void;
  config?: AppConfig;
  modelCatalog?: ModelCatalogEntry[];
  handleSelectModel?: (modelId: string) => void;
  contextEstimate?: number;
  handleCompressContext?: (contextLimit?: number) => void;
  isCompressing?: boolean;
}

export default function ChatPanel({
  activeBrainTab,
  setActiveBrainTab,
  t,
  isThinking,
  statusMessage,
  elapsedSeconds = 0,
  lastSignalAgeSeconds = 0,
  statusHistory = [],
  recoveryInfo = null,
  handleResumeWithOutputLimit,
  handleStopGeneration,
  messages,
  activeTool,
  attachments,
  setAttachments,
  showAttachmentMenu,
  setShowAttachmentMenu,
  handleFileAttachment,
  removeAttachment,
  attachmentMenuRef,
  input,
  setInput,
  handleSendMessage,
  tasks,
  toggleTaskStatus,
  newTaskInput,
  setNewTaskInput,
  handleAddTask,
  collabTopic,
  setCollabTopic,
  collabAgents,
  setCollabAgents,
  collabMessages,
  isCollaborating,
  activeCollabAgent,
  handleStartCollaboration,
  handleStopCollaboration,
  chatEndRef,
  agentTimeline = [],
  checkpoints = [],
  latestCheckpoint = null,
  checkpointStatus = 'idle',
  fetchAgentCheckpoints = () => {},
  handleLoadLatestCheckpoint = () => {},
  handleResumeLatestCheckpoint = () => {},
  config = {},
  modelCatalog = [],
  handleSelectModel = () => {},
  contextEstimate = 0,
  handleCompressContext = () => {},
  isCompressing = false
}: ChatPanelProps) {
  const hasDetailedStatus = !['Waiting', 'Working'].includes(statusMessage);
  const showSignalWarning = isThinking && lastSignalAgeSeconds >= 25;
  const executionBudget = [...agentTimeline].reverse().find(event => event.payload?.executionBudget)?.payload.executionBudget as ExecutionBudget | undefined;

  return (
    <div className="brain-panel">
      <div className="brain-tabs">
        {TABS.map(tab => (
          <button
            key={tab.id}
            className={`brain-tab ${activeBrainTab === tab.id ? 'active' : ''}`}
            type="button"
            onClick={() => setActiveBrainTab(tab.id)}
          >
            {t(tab.labelKey)}
          </button>
        ))}
      </div>

      <ModelBar
        t={t}
        config={config}
        modelCatalog={modelCatalog}
        onSelectModel={handleSelectModel}
        contextEstimate={contextEstimate}
        contextLimit={config?.contextLimit}
        onCompressContext={() => handleCompressContext(config?.contextLimit)}
        isCompressing={isCompressing}
      />

      <div className={`agent-status-bar ${showSignalWarning ? 'warning' : ''}`}>
        {isThinking && <span className="pulse-dot" />}
        <span className="status-primary">{isThinking ? t('statusThinking') : t('statusWaiting')}</span>
        {hasDetailedStatus && <span className="status-detail">{statusMessage}</span>}
        <div className="status-meta-group">
          <RunBudgetLabel budget={executionBudget} t={t} />
          {isThinking && <span className="status-pill">{t('elapsed')}: {formatDuration(elapsedSeconds)}</span>}
          {isThinking && <span className={`status-pill ${showSignalWarning ? 'warning' : ''}`}>{t('lastSignal')}: {formatDuration(lastSignalAgeSeconds)}</span>}
          {activeTool && <span className="status-pill active-tool">{activeTool.name}</span>}
        </div>
      </div>

      {showSignalWarning && (
        <div className="status-notice">
          {t('statusNoRecentSignal')}
        </div>
      )}

      <RecoveryBanner
        recoveryInfo={recoveryInfo}
        handleResumeWithOutputLimit={handleResumeWithOutputLimit}
        isThinking={isThinking}
        latestCheckpoint={latestCheckpoint}
        handleResumeLatestCheckpoint={handleResumeLatestCheckpoint}
        t={t}
      />

      <StatusHistoryStrip statusHistory={statusHistory} t={t} />

      {activeBrainTab === 'reasoning' && <ReasoningLogTab messages={messages} t={t} />}

      {activeBrainTab === 'timeline' && (
        <TimelineTab
          t={t}
          agentTimeline={agentTimeline}
          checkpoints={checkpoints}
          latestCheckpoint={latestCheckpoint}
          checkpointStatus={checkpointStatus}
          fetchAgentCheckpoints={fetchAgentCheckpoints}
          handleLoadLatestCheckpoint={handleLoadLatestCheckpoint}
          handleResumeLatestCheckpoint={handleResumeLatestCheckpoint}
        />
      )}

      {activeBrainTab === 'planner' && (
        <PlannerTab
          t={t}
          tasks={tasks}
          toggleTaskStatus={toggleTaskStatus}
          newTaskInput={newTaskInput}
          setNewTaskInput={setNewTaskInput}
          handleAddTask={handleAddTask}
        />
      )}

      {activeBrainTab === 'collab' && (
        <CollaborationTab
          t={t}
          collabTopic={collabTopic}
          setCollabTopic={setCollabTopic}
          collabAgents={collabAgents}
          setCollabAgents={setCollabAgents}
          collabMessages={collabMessages}
          isCollaborating={isCollaborating}
          activeCollabAgent={activeCollabAgent}
          handleStartCollaboration={handleStartCollaboration}
          handleStopCollaboration={handleStopCollaboration}
        />
      )}

      {activeBrainTab === 'chat' && (
        <div className="chat-container">
          <ChatMessages messages={messages} chatEndRef={chatEndRef} t={t} />
          <ChatInput
            t={t}
            input={input}
            setInput={setInput}
            isThinking={isThinking}
            attachments={attachments}
            setAttachments={setAttachments}
            showAttachmentMenu={showAttachmentMenu}
            setShowAttachmentMenu={setShowAttachmentMenu}
            handleFileAttachment={handleFileAttachment}
            removeAttachment={removeAttachment}
            attachmentMenuRef={attachmentMenuRef}
            handleSendMessage={handleSendMessage}
            handleStopGeneration={handleStopGeneration}
          />
        </div>
      )}
    </div>
  );
}
