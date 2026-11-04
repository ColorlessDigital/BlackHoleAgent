import React from 'react';
import type {
  ActiveModelServer,
  AppConfig,
  DiscoveryCandidate,
  IdeEntry,
  LocalModelEntry,
  ModelCatalogEntry,
  ModelProfile,
  OpengoPreset,
  OpengoRegisteredModel,
  OpengoTestResult,
  OpenCodeGoTestResult,
  GoProtocol,
  RuntimeDiscovery,
  RuntimeStatus,
  TranslateFn,
  WebTestStatus
} from '../types.ts';

const TABS = [
  { id: 'gguf', labelKey: 'settingsGguf' },
  { id: 'opencode-go', labelKey: 'settingsOpenCodeGo' },
  { id: 'opengo', labelKey: 'settingsOpengo' },
  { id: 'workspace', labelKey: 'settingsWorkspace' },
  { id: 'brain', labelKey: 'settingsBrain' },
  { id: 'memory', labelKey: 'settingsMemory' },
  { id: 'keys', labelKey: 'settingsKeys' },
  { id: 'ide', labelKey: 'settingsIde' },
  { id: 'web', labelKey: 'settingsWeb' }
];

const PROFILE_KEYS = ['general', 'planner', 'coder', 'verifier', 'summarizer'];
const PROVIDERS = ['duckduckgo', 'tavily', 'exa', 'brave', 'firecrawl'];

function getCandidatePath(candidate: DiscoveryCandidate | LocalModelEntry | string | null | undefined): string {
  if (!candidate) return '';
  if (typeof candidate === 'string') return candidate;
  return candidate.path || ('filePath' in candidate && candidate.filePath) || ('executable' in candidate && candidate.executable) || ('modelPath' in candidate && candidate.modelPath) || candidate.name || '';
}

function getCandidateLabel(candidate: DiscoveryCandidate | LocalModelEntry | string | null | undefined): string {
  if (!candidate) return '';
  if (typeof candidate === 'string') return candidate;
  return candidate.name || ('label' in candidate && candidate.label) || getCandidatePath(candidate);
}

function Section({ title, children, description }: {
  title: string;
  children: React.ReactNode;
  description?: string;
}) {
  return (
    <div className="settings-group">
      <div className="settings-group-title">{title}</div>
      {description && <p style={{ marginTop: 0, color: 'var(--text-secondary)', fontSize: 12, lineHeight: 1.5 }}>{description}</p>}
      {children}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="settings-label" style={{ display: 'block', marginBottom: 12 }}>
      <span style={{ display: 'block', marginBottom: 6 }}>{label}</span>
      {children}
    </label>
  );
}

function TextInput({ value, onChange, placeholder = '', type = 'text', onKeyDown }: {
  value?: string | number;
  onChange: (value: string) => void;
  placeholder?: string;
  type?: string;
  onKeyDown?: (event: React.KeyboardEvent<HTMLInputElement>) => void;
}) {
  return (
    <input
      className="settings-input"
      value={value ?? ''}
      onChange={(event) => onChange?.(event.target.value)}
      onKeyDown={onKeyDown}
      placeholder={placeholder}
      type={type}
    />
  );
}

function NumberInput({ value, onChange, min, max, step = 1 }: {
  value?: string | number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
}) {
  return (
    <input
      className="settings-input"
      value={value ?? ''}
      min={min}
      max={max}
      step={step}
      onChange={(event) => onChange(Number(event.target.value))}
      type="number"
    />
  );
}

function SelectInput({ value, onChange, children, ariaLabel }: {
  value?: string | number;
  onChange: (value: string) => void;
  children: React.ReactNode;
  ariaLabel?: string;
}) {
  return (
    <select className="settings-select" aria-label={ariaLabel} value={value ?? ''} onChange={(event) => onChange(event.target.value)}>
      {children}
    </select>
  );
}

function ToggleRow({ label, checked, onChange }: {
  label: string;
  checked?: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <label style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '10px 0', color: 'var(--text-secondary)', fontSize: 13 }}>
      <input type="checkbox" checked={Boolean(checked)} onChange={(event) => onChange(event.target.checked)} />
      <span>{label}</span>
    </label>
  );
}

function StatusPill({ ok, label, detail }: { ok: boolean; label: string; detail: React.ReactNode }) {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '88px 1fr',
        gap: 8,
        alignItems: 'center',
        padding: '8px 10px',
        border: '1px solid rgba(255,255,255,0.08)',
        borderRadius: 8,
        background: 'rgba(255,255,255,0.03)',
        minWidth: 0
      }}
    >
      <span style={{ color: ok ? '#34d399' : '#fbbf24', fontSize: 12, fontWeight: 700 }}>
        {ok ? 'OK' : 'WAIT'}
      </span>
      <div style={{ minWidth: 0 }}>
        <div style={{ color: 'var(--text-primary)', fontSize: 12, fontWeight: 600 }}>{label}</div>
        <div style={{ color: 'var(--text-secondary)', fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {detail}
        </div>
      </div>
    </div>
  );
}

export interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  activeTab: string;
  setActiveTab: (tab: string) => void;
  config: AppConfig;
  setConfig: React.Dispatch<React.SetStateAction<AppConfig>>;
  localModels: LocalModelEntry[];
  localModelError: string;
  isLocalModelLoading: boolean;
  fetchLocalModels: () => void;
  runtimeStatus: RuntimeStatus | null;
  runtimeDiscovery: RuntimeDiscovery;
  isRuntimeStarting: boolean;
  isRuntimeStopping: boolean;
  handleStartLlamaRuntime: () => void;
  handleStopLlamaRuntime: () => void;
  handleSelectLlamaServerFile: () => void;
  handleSelectGgufFile: () => void;
  handleSaveSettings: () => void;
  handleAddMemory: (value: string, setInput: (value: string) => void) => void;
  handleDeleteMemory: (index: number) => void;
  newMemoryInput?: string;
  setNewMemoryInput?: (value: string) => void;
  settingsStatus: string;
  webTestStatus: WebTestStatus | null;
  locale?: string;
  handleWebTestConnection: (webConfig: AppConfig) => void;
  t: TranslateFn;
  detectInstalledIdes: () => void;
  detectedIdes: Record<string, IdeEntry> | null;
  isDetectingIdes: boolean;
  selectedLaunchIde: string;
  setSelectedLaunchIde: (ide: string) => void;
  isLaunchingIde: boolean;
  integrateAndLaunchIde: () => void;
  preflightResult: unknown;
  isPreflightLoading: boolean;
  handleRunPreflight: () => void;
  modelCatalog?: ModelCatalogEntry[];
  fetchModelCatalog?: () => void;
  handleTestOpengo?: () => void;
  opengoTest?: OpengoTestResult | null;
  isOpengoTesting?: boolean;
  activeModelServer?: ActiveModelServer | null;
  goTest?: OpenCodeGoTestResult | null;
  resetGoTest?: () => void;
  isGoTesting?: boolean;
  isGoDiscovering?: boolean;
  goDiscoveryError?: string;
  handleTestGo?: () => void;
  handleDiscoverGo?: () => void;
  handleUseGo?: () => void;
  handleClearGoKey?: () => void;
}

export default function SettingsModal({
  isOpen,
  onClose,
  activeTab,
  setActiveTab,
  config,
  setConfig,
  localModels,
  localModelError,
  isLocalModelLoading,
  fetchLocalModels,
  runtimeStatus,
  runtimeDiscovery,
  isRuntimeStarting,
  isRuntimeStopping,
  handleStartLlamaRuntime,
  handleStopLlamaRuntime,
  handleSelectLlamaServerFile,
  handleSelectGgufFile,
  handleSaveSettings,
  handleAddMemory,
  handleDeleteMemory,
  newMemoryInput: propNewMemoryInput,
  setNewMemoryInput: propSetNewMemoryInput,
  settingsStatus,
  webTestStatus,
  handleWebTestConnection,
  t,
  detectInstalledIdes,
  detectedIdes,
  isDetectingIdes,
  selectedLaunchIde,
  setSelectedLaunchIde,
  isLaunchingIde,
  integrateAndLaunchIde,
  preflightResult,
  isPreflightLoading,
  handleRunPreflight,
  modelCatalog = [],
  fetchModelCatalog = () => {},
  handleTestOpengo = () => {},
  opengoTest = null,
  isOpengoTesting = false,
  activeModelServer = null,
  goTest = null, resetGoTest = () => {}, isGoTesting = false, isGoDiscovering = false,
  goDiscoveryError = '', handleTestGo = () => {}, handleDiscoverGo = () => {},
  handleUseGo = () => {}, handleClearGoKey = () => {}
}: SettingsModalProps) {
  const [newOpengoModel, setNewOpengoModel] = React.useState({ id: '', label: '', contextLimit: '' as string | number, maxTokens: '' as string | number });
  const [localMemoryInput, setLocalMemoryInput] = React.useState('');
  const memoryInput = typeof propNewMemoryInput === 'string' ? propNewMemoryInput : localMemoryInput;
  const setMemoryInput: (value: string) => void = typeof propSetNewMemoryInput === 'function' ? propSetNewMemoryInput : setLocalMemoryInput;

  if (!isOpen) return null;

  const updateConfig = (key: string, value: unknown) => setConfig(prev => ({ ...prev, [key]: value }));
  const updateApiKey = (key: string, value: string) => setConfig(prev => ({
    ...prev,
    apiKeys: { ...(prev.apiKeys || {}), [key]: value }
  }));
  const updateProfile = (profileName: string, key: string, value: string | number) => setConfig(prev => {
    const current: ModelProfile = (prev.agentModelProfiles || {})[profileName] || {};
    return {
      ...prev,
      agentModelProfiles: {
        ...(prev.agentModelProfiles || {}),
        [profileName]: { ...current, [key]: value } as ModelProfile
      }
    };
  });

  const workspaceStandard = config.workspaceStandard || {};
  const discoveredServers = runtimeDiscovery?.servers || [];
  const discoveredModels = runtimeDiscovery?.models || [];
  const localModelOptions = (localModels || []).map(model => ({
    value: model.id || model.name || model.path || '',
    label: model.name || model.id || model.path || ''
  })).filter(model => model.value);
  const isRuntimeHealthy = Boolean(runtimeStatus?.healthy);
  const ideEntries = Object.entries(detectedIdes || {});

  const renderWorkspaceTab = () => (
    <Section title={t('workspaceStandardTitle')} description={t('workspaceStandardGuide')}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        <StatusPill ok={Boolean(workspaceStandard.profile)} label={t('workspaceProfile')} detail={workspaceStandard.profile || 'default'} />
        <StatusPill ok={Boolean(workspaceStandard.configPath)} label={t('workspaceConfigYaml')} detail={workspaceStandard.configPath || t('missing')} />
        <StatusPill ok={Boolean(workspaceStandard.modelsPath)} label={t('workspaceModelsYaml')} detail={workspaceStandard.modelsPath || t('missing')} />
        <StatusPill ok={(workspaceStandard.rules || []).length > 0} label={t('workspaceRulesLoaded')} detail={`${(workspaceStandard.rules || []).length} ${t('loaded')}`} />
        <StatusPill ok={(workspaceStandard.prompts || []).length > 0} label={t('workspacePromptsLoaded')} detail={`${(workspaceStandard.prompts || []).length} ${t('loaded')}`} />
        <StatusPill ok={(workspaceStandard.checks || []).length > 0} label={t('checksLoaded')} detail={`${(workspaceStandard.checks || []).length} ${t('loaded')}`} />
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginTop: 14 }}>
        <ListBlock title={t('workspaceRulesLoaded')} items={workspaceStandard.rules || []} />
        <ListBlock title={t('workspacePromptsLoaded')} items={workspaceStandard.prompts || []} />
      </div>
    </Section>
  );

  const renderGgufTab = () => (
    <>
      <Section title={t('ggufRuntimeTitle')} description={t('ggufRuntimeGuide')}>
        <Field label={t('llamaServerPath')}>
          <div style={{ display: 'flex', gap: 8 }}>
            <TextInput value={config.llamaCppServerPath} onChange={(value) => updateConfig('llamaCppServerPath', value)} placeholder="D:\\BlackHole\\resources\\llama.cpp\\llama-server.exe" />
            <button className="btn-save-settings" type="button" onClick={handleSelectLlamaServerFile}>{t('browse')}</button>
          </div>
        </Field>
        {discoveredServers.length > 0 && (
          <Field label={t('detectedServerSelect')}>
            <SelectInput value="" onChange={(value) => value && updateConfig('llamaCppServerPath', value)}>
              <option value="">-</option>
              {discoveredServers.map((server, index) => {
                const path = getCandidatePath(server);
                return <option key={`${path}-${index}`} value={path}>{getCandidateLabel(server)}</option>;
              })}
            </SelectInput>
          </Field>
        )}

        <Field label={t('ggufModelPath')}>
          <div style={{ display: 'flex', gap: 8 }}>
            <TextInput value={config.llamaCppModelPath} onChange={(value) => updateConfig('llamaCppModelPath', value)} placeholder="D:\\models\\model.gguf" />
            <button className="btn-save-settings" type="button" onClick={handleSelectGgufFile}>{t('browse')}</button>
          </div>
        </Field>
        {discoveredModels.length > 0 && (
          <Field label={t('detectedModelSelect')}>
            <SelectInput value="" onChange={(value) => value && updateConfig('llamaCppModelPath', value)}>
              <option value="">-</option>
              {discoveredModels.map((model, index) => {
                const path = getCandidatePath(model);
                return <option key={`${path}-${index}`} value={path}>{getCandidateLabel(model)}</option>;
              })}
            </SelectInput>
          </Field>
        )}

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 10 }}>
          <Field label={t('gpuOffloadLayers')}>
            <NumberInput value={config.llamaCppGpuLayers} min={0} onChange={(value) => updateConfig('llamaCppGpuLayers', value)} />
          </Field>
          <Field label={t('cpuThreads')}>
            <NumberInput value={config.llamaCppThreads} min={0} onChange={(value) => updateConfig('llamaCppThreads', value)} />
          </Field>
          <Field label={t('batchSize')}>
            <NumberInput value={config.llamaCppBatch} min={1} onChange={(value) => updateConfig('llamaCppBatch', value)} />
          </Field>
          <Field label={t('parallelSlots')}>
            <NumberInput value={config.llamaCppParallel} min={1} onChange={(value) => updateConfig('llamaCppParallel', value)} />
          </Field>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 10, marginTop: 10 }}>
          <Field label={t('startupTimeoutMs')}>
            <NumberInput value={config.llamaCppStartupTimeoutMs} min={15000} step={1000} onChange={(value) => updateConfig('llamaCppStartupTimeoutMs', value)} />
          </Field>
          <Field label={t('requestTimeoutMs')}>
            <NumberInput value={config.llamaCppRequestTimeoutMs} min={15000} step={1000} onChange={(value) => updateConfig('llamaCppRequestTimeoutMs', value)} />
          </Field>
        </div>

        <Field label={t('llamaCppUrl')}>
          <TextInput value={config.llamaCppUrl} onChange={(value) => updateConfig('llamaCppUrl', value)} placeholder="http://127.0.0.1:8080" />
        </Field>
      </Section>

      <Section title={t('preflightTitle')}>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 12 }}>
          <button className="btn-save-settings" type="button" onClick={handleRunPreflight} disabled={isPreflightLoading}>
            {isPreflightLoading ? t('preflightChecking') : t('preflightRun')}
          </button>
          <button className="btn-save-settings" type="button" onClick={handleStartLlamaRuntime} disabled={isRuntimeStarting || isRuntimeHealthy}>
            {isRuntimeStarting ? t('preflightChecking') : t('startRuntime')}
          </button>
          <button className="btn-save-settings" type="button" onClick={handleStopLlamaRuntime} disabled={isRuntimeStopping || !isRuntimeHealthy}>
            {isRuntimeStopping ? t('preflightChecking') : t('stopRuntime')}
          </button>
        </div>
        <StatusPill
          ok={isRuntimeHealthy}
          label={t('runtimeActions')}
          detail={isRuntimeHealthy ? `${t('runtimeRunning')} - ${runtimeStatus?.baseUrl || config.llamaCppUrl}` : t('runtimeStopped')}
        />
        {runtimeStatus?.modelInfo && (
          <div style={{ marginTop: 10 }}>
            <StatusPill
              ok={runtimeStatus.modelInfo.tier !== 'huge'}
              label={t('selectedModel')}
              detail={`${runtimeStatus.modelInfo.name} - ${runtimeStatus.modelInfo.sizeGB}GB - ${runtimeStatus.modelInfo.tier}`}
            />
          </div>
        )}
        {preflightResult ? (
          <pre style={{ marginTop: 12, padding: 12, whiteSpace: 'pre-wrap', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 8, color: (preflightResult as { ok?: boolean }).ok ? '#34d399' : '#f87171' }}>
            {JSON.stringify(preflightResult, null, 2)}
          </pre>
        ) : null}
      </Section>
    </>
  );

  const renderBrainTab = () => (
    <>
      <Section title={t('settingsBrain')}>
        <Field label={t('activeModel')}>
          <div style={{ display: 'flex', gap: 8 }}>
            <TextInput value={config.activeModel} onChange={(value) => updateConfig('activeModel', value)} />
            <button className="btn-save-settings" type="button" onClick={fetchLocalModels} disabled={isLocalModelLoading}>
              {isLocalModelLoading ? t('testing') : t('syncModels')}
            </button>
          </div>
        </Field>
        {localModelOptions.length > 0 && (
          <Field label={t('localRuntimeModels')}>
            <SelectInput value="" onChange={(value) => value && updateConfig('activeModel', value)}>
              <option value="">-</option>
              {localModelOptions.map(model => <option key={model.value} value={model.value}>{model.label}</option>)}
            </SelectInput>
          </Field>
        )}
        {localModelError && <div style={{ color: '#f87171', fontSize: 12 }}>{localModelError}</div>}

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 140px), 1fr))', gap: 10 }}>
          <Field label={t('agentMaxSteps')}>
            <NumberInput value={config.agentMaxSteps ?? 24} min={1} max={1000} onChange={(value) => updateConfig('agentMaxSteps', value)} />
          </Field>
          <Field label={t('selfHealingMaxCycles')}>
            <NumberInput value={config.selfHealingMaxCycles} min={0} max={1000} onChange={(value) => updateConfig('selfHealingMaxCycles', value)} />
          </Field>
          <Field label={t('contextLimit')}>
            <NumberInput value={config.contextLimit} min={1024} onChange={(value) => updateConfig('contextLimit', value)} />
          </Field>
          <Field label={t('maxTokens')}>
            <NumberInput value={config.maxTokens} min={256} onChange={(value) => updateConfig('maxTokens', value)} />
          </Field>
          <Field label={t('temperature')}>
            <NumberInput value={config.temperature} min={0} max={2} step={0.01} onChange={(value) => updateConfig('temperature', value)} />
          </Field>
        </div>

        <Field label={t('permissionMode')}>
          <SelectInput value={config.permissionMode || 'operator'} onChange={(value) => updateConfig('permissionMode', value)}>
            <option value="operator">operator (recommended)</option>
            <option value="autonomous">autonomous</option>
            <option value="strict">strict</option>
            <option value="full">full</option>
          </SelectInput>
        </Field>
        <Field label="Strict blocking (deny BLOCKED without approval)">
          <SelectInput value={config.strictBlocking ? 'on' : 'off'} onChange={(value) => updateConfig('strictBlocking', value === 'on')}>
            <option value="off">off (approval escalation)</option>
            <option value="on">on (hard deny)</option>
          </SelectInput>
        </Field>

        <ToggleRow label={t('compactionEnable')} checked={config.contextCompactionEnabled !== false} onChange={(value) => updateConfig('contextCompactionEnabled', value)} />
        <Field label={t('compactionThreshold')}>
          <NumberInput value={config.contextCompactionThreshold ?? 0.9} min={0.5} max={0.98} step={0.05} onChange={(value) => updateConfig('contextCompactionThreshold', value)} />
        </Field>
      </Section>

      <Section title={t('modelRoutingProfiles')} description={t('modelRoutingGuide')}>
        {PROFILE_KEYS.map(profileName => {
          const profile: ModelProfile = config.agentModelProfiles?.[profileName] || {};
          return (
            <div key={profileName} style={{ padding: 12, border: '1px solid rgba(255,255,255,0.08)', borderRadius: 8, marginBottom: 10 }}>
              <div style={{ color: 'var(--accent-cyan)', fontWeight: 700, marginBottom: 10 }}>{t(`profile${profileName[0].toUpperCase()}${profileName.slice(1)}`)}</div>
              <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr 1fr', gap: 8 }}>
                <TextInput value={profile.model || ''} onChange={(value) => updateProfile(profileName, 'model', value)} placeholder={t('inheritActiveModel')} />
                <NumberInput value={profile.contextLimit ?? config.contextLimit} min={1024} onChange={(value) => updateProfile(profileName, 'contextLimit', value)} />
                <NumberInput value={profile.maxTokens ?? config.maxTokens} min={256} onChange={(value) => updateProfile(profileName, 'maxTokens', value)} />
                <NumberInput value={profile.temperature ?? config.temperature} min={0} max={2} step={0.01} onChange={(value) => updateProfile(profileName, 'temperature', value)} />
              </div>
            </div>
          );
        })}
      </Section>
    </>
  );

  const onAddMemorySubmit = () => {
    const val = (memoryInput || '').trim();
    if (!val) return;
    handleAddMemory?.(val, setMemoryInput);
  };

  const renderMemoryTab = () => (
    <Section title={t('memoryTitle')}>
      <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
        <TextInput
          value={memoryInput}
          onChange={setMemoryInput}
          placeholder={t('memoryPlaceholder')}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              onAddMemorySubmit();
            }
          }}
        />
        <button
          className="btn-save-settings"
          type="button"
          onClick={onAddMemorySubmit}
          disabled={!memoryInput || !memoryInput.trim()}
        >
          {t('addMemory')}
        </button>
      </div>
      {(config.memories || []).length === 0 ? (
        <div style={{ color: 'var(--text-secondary)', fontSize: 12 }}>{t('noMemory')}</div>
      ) : (
        (config.memories || []).map((memory, index) => (
          <div key={`${memory}-${index}`} style={{ display: 'flex', gap: 8, alignItems: 'center', padding: 10, border: '1px solid rgba(255,255,255,0.08)', borderRadius: 8, marginBottom: 8 }}>
            <div style={{ flex: 1, color: 'var(--text-primary)', fontSize: 13 }}>{memory}</div>
            <button className="btn-save-settings" type="button" onClick={() => handleDeleteMemory(index)}>
              {t('remove')}
            </button>
          </div>
        ))
      )}
    </Section>
  );

  const renderKeysTab = () => (
    <Section title={t('settingsKeys')} description={t('apiKeysGuide')}>
      {['anthropic', 'openai', 'deepseek', 'gemini'].map(provider => (
        <Field key={provider} label={`${provider} ${t('apiKey')}`}>
          <TextInput value={config.apiKeys?.[provider] || ''} onChange={(value) => updateApiKey(provider, value)} type="password" />
        </Field>
      ))}
      {['tavilyApiKey', 'exaApiKey', 'braveApiKey', 'firecrawlApiKey'].map(key => (
        <Field key={key} label={key}>
          <TextInput value={config[key] as string || ''} onChange={(value) => updateConfig(key, value)} type="password" />
        </Field>
      ))}
    </Section>
  );

  const renderIdeTab = () => (
    <Section title={t('settingsIde')} description={t('ideBridgeGuide')}>
      <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
        <button className="btn-save-settings" type="button" onClick={detectInstalledIdes} disabled={isDetectingIdes}>
          {isDetectingIdes ? t('detecting') : t('detectIdes')}
        </button>
        <button className="btn-save-settings" type="button" onClick={integrateAndLaunchIde} disabled={isLaunchingIde || !detectedIdes}>
          {isLaunchingIde ? t('testing') : t('integrateIde')}
        </button>
      </div>
      {ideEntries.length === 0 ? (
        <div style={{ color: 'var(--text-secondary)', fontSize: 12 }}>{t('noIdeDetected')}</div>
      ) : (
        <>
          <Field label={t('launchIde')}>
            <SelectInput value={selectedLaunchIde} onChange={setSelectedLaunchIde}>
              {ideEntries.map(([name, info]) => (
                <option key={name} value={name}>{name.toUpperCase()} - {info.detected ? t('ready') : t('missing')}</option>
              ))}
            </SelectInput>
          </Field>
          <div style={{ display: 'grid', gap: 8 }}>
            {ideEntries.map(([name, info]) => (
              <StatusPill key={name} ok={Boolean(info.detected)} label={name.toUpperCase()} detail={info.path || t('missing')} />
            ))}
          </div>
        </>
      )}
    </Section>
  );

  const renderWebTab = () => (
    <Section title={t('settingsWeb')}>
      <Field label={t('webProvider')}>
        <SelectInput value={config.webSearchProvider || 'duckduckgo'} onChange={(value) => updateConfig('webSearchProvider', value)}>
          {PROVIDERS.map(provider => <option key={provider} value={provider}>{provider}</option>)}
        </SelectInput>
      </Field>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 10 }}>
        <Field label={t('searchLimit')}>
          <NumberInput value={config.webSearchMaxResults} min={1} max={20} onChange={(value) => updateConfig('webSearchMaxResults', value)} />
        </Field>
        <Field label={t('crawlDepth')}>
          <NumberInput value={config.webCrawlerMaxDepth} min={0} max={5} onChange={(value) => updateConfig('webCrawlerMaxDepth', value)} />
        </Field>
        <Field label={t('timeoutMs')}>
          <NumberInput value={config.webRequestTimeoutMs} min={1000} onChange={(value) => updateConfig('webRequestTimeoutMs', value)} />
        </Field>
        <Field label={t('maxPages')}>
          <NumberInput value={config.webCrawlerMaxPages} min={1} max={20} onChange={(value) => updateConfig('webCrawlerMaxPages', value)} />
        </Field>
      </div>

      <Field label={t('allowedDomains')}>
        <textarea
          className="settings-input"
          value={config.webAllowedDomains || ''}
          onChange={(event) => updateConfig('webAllowedDomains', event.target.value)}
          rows={3}
          placeholder="example.com, docs.example.com"
        />
      </Field>

      <ToggleRow label={t('enableHttpInspect')} checked={config.webRenderEnabled} onChange={(value) => updateConfig('webRenderEnabled', value)} />
      <ToggleRow label={t('strictUrlScope')} checked={config.webStrictScopeEnabled} onChange={(value) => updateConfig('webStrictScopeEnabled', value)} />
      <ToggleRow label={t('enableSecurityMonitor')} checked={config.webRequireAllowedDomainsForCrawl} onChange={(value) => updateConfig('webRequireAllowedDomainsForCrawl', value)} />

      <button className="btn-save-settings" type="button" onClick={() => handleWebTestConnection(config)} disabled={webTestStatus?.testing}>
        {webTestStatus?.testing ? t('testing') : t('testConnection')}
      </button>
      {webTestStatus && !webTestStatus.testing && (
        <div style={{ marginTop: 10, color: webTestStatus.ok ? '#34d399' : '#f87171', fontSize: 12 }}>
          {webTestStatus.ok ? t('testPassed') : `${t('testFailed')}: ${webTestStatus.error || ''}`}
        </div>
      )}
    </Section>
  );

  const opengoRegistered: OpengoRegisteredModel[] = Array.isArray(config.opengoModels) ? config.opengoModels : [];
  const opengoDiscovered = (modelCatalog || []).filter(entry => entry.provider === 'opengo' && entry.source === 'discovered');

  const addOpengoModel = () => {
    const id = (newOpengoModel.id || '').trim();
    if (!id) return;
    updateConfig('opengoModels', [
      ...opengoRegistered,
      {
        id,
        label: (newOpengoModel.label || '').trim() || id,
        contextLimit: newOpengoModel.contextLimit === '' ? null : Number(newOpengoModel.contextLimit),
        maxTokens: newOpengoModel.maxTokens === '' ? null : Number(newOpengoModel.maxTokens)
      }
    ]);
    setNewOpengoModel({ id: '', label: '', contextLimit: '', maxTokens: '' });
  };

  const removeOpengoModel = (id: string) => {
    updateConfig('opengoModels', opengoRegistered.filter(entry => entry.id !== id));
  };

  const FALLBACK_PRESETS: OpengoPreset[] = [{ id: 'custom', label: '직접 입력', baseUrl: '', needsKey: true }];
  const opengoPresets: OpengoPreset[] = activeModelServer?.opengo?.presets?.length
    ? activeModelServer.opengo.presets
    : FALLBACK_PRESETS;

  const handleOpengoPreset = (presetId: string) => {
    const preset = opengoPresets.find(entry => entry.id === presetId);
    setConfig(prev => ({
      ...prev,
      opengoPreset: presetId,
      // Key-only flow: fill the default endpoint unless the user typed one.
      opengoBaseUrl: (prev.opengoBaseUrl || '').trim() ? prev.opengoBaseUrl : (preset?.baseUrl || '')
    }));
  };

  const renderOpengoTab = () => (
    <>
      <Section title={t('settingsOpengo')} description={t('opengoGuide')}>
        <ToggleRow label={t('opengoEnable')} checked={Boolean(config.opengoEnabled)} onChange={(value) => updateConfig('opengoEnabled', value)} />
        <Field label={t('opengoPreset')}>
          <SelectInput value={config.opengoPreset || 'custom'} onChange={handleOpengoPreset}>
            {opengoPresets.map(preset => <option key={preset.id} value={preset.id}>{preset.label}</option>)}
          </SelectInput>
        </Field>
        <Field label={t('opengoBaseUrl')}>
          <TextInput value={config.opengoBaseUrl || ''} onChange={(value) => updateConfig('opengoBaseUrl', value)} placeholder="프리셋 선택 시 자동 입력" />
        </Field>
        <Field label={t('opengoApiKey')}>
          <TextInput value={config.opengoApiKey || ''} onChange={(value) => updateConfig('opengoApiKey', value)} type="password" />
        </Field>
        <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 10 }}>
          <Field label={t('opengoDefaultModel')}>
            <TextInput value={config.opengoDefaultModel || ''} onChange={(value) => updateConfig('opengoDefaultModel', value)} placeholder="supplied-model-id" />
          </Field>
          <Field label={t('timeoutMs')}>
            <NumberInput value={config.opengoRequestTimeoutMs ?? 120000} min={5000} step={1000} onChange={(value) => updateConfig('opengoRequestTimeoutMs', value)} />
          </Field>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn-save-settings" type="button" onClick={handleTestOpengo} disabled={isOpengoTesting}>
            {isOpengoTesting ? t('testing') : t('testConnection')}
          </button>
          <button className="btn-save-settings" type="button" onClick={fetchModelCatalog}>
            {t('syncModels')}
          </button>
        </div>
        {opengoTest && (
          <div style={{ marginTop: 10, color: opengoTest.ok ? '#34d399' : '#f87171', fontSize: 12 }}>
            {opengoTest.ok
              ? `${t('testPassed')}: ${opengoTest.modelCount} models (${(opengoTest.models || []).slice(0, 5).join(', ')})`
              : `${t('testFailed')}: ${opengoTest.error || ''}`}
          </div>
        )}
      </Section>

      <Section title={t('opengoModels')}>
        {opengoRegistered.length === 0 && (
          <div style={{ color: 'var(--text-secondary)', fontSize: 12, marginBottom: 8 }}>{t('opengoNoModels')}</div>
        )}
        {opengoRegistered.map(entry => {
          const id = entry.id;
          return (
            <div key={id} style={{ display: 'grid', gridTemplateColumns: '2fr 2fr 1fr 1fr auto', gap: 8, alignItems: 'center', marginBottom: 8 }}>
              <span style={{ color: 'var(--text-primary)', fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis' }}>{id}</span>
              <span style={{ color: 'var(--text-secondary)', fontSize: 12 }}>{entry.label || id}</span>
              <span style={{ color: 'var(--text-secondary)', fontSize: 12 }}>{entry.contextLimit || '-'}</span>
              <span style={{ color: 'var(--text-secondary)', fontSize: 12 }}>{entry.maxTokens || '-'}</span>
              <button className="btn-save-settings" type="button" onClick={() => removeOpengoModel(id)}>{t('remove')}</button>
            </div>
          );
        })}
        <div style={{ display: 'grid', gridTemplateColumns: '2fr 2fr 1fr 1fr auto', gap: 8, marginTop: 8 }}>
          <TextInput value={newOpengoModel.id} onChange={(value) => setNewOpengoModel(prev => ({ ...prev, id: value }))} placeholder="model-id" />
          <TextInput value={newOpengoModel.label} onChange={(value) => setNewOpengoModel(prev => ({ ...prev, label: value }))} placeholder={t('opengoModelLabel')} />
          <NumberInput value={newOpengoModel.contextLimit} min={1024} onChange={(value) => setNewOpengoModel(prev => ({ ...prev, contextLimit: value }))} />
          <NumberInput value={newOpengoModel.maxTokens} min={256} onChange={(value) => setNewOpengoModel(prev => ({ ...prev, maxTokens: value }))} />
          <button className="btn-save-settings" type="button" onClick={addOpengoModel}>{t('addModel')}</button>
        </div>
      </Section>

      {opengoDiscovered.length > 0 && (
        <Section title={t('opengoDiscovered')}>
          {opengoDiscovered.map(entry => (
            <div key={entry.id} style={{ color: 'var(--text-secondary)', fontSize: 12, marginBottom: 4 }}>
              {entry.name} ({entry.id})
            </div>
          ))}
        </Section>
      )}
    </>
  );

  const goModels = activeModelServer?.opencodeGo?.models || [];
  const goModel = config.opencodeGoDefaultModel || '';
  const goProtocol = config.opencodeGoProtocolOverrides?.[goModel];
  const goOutputLimits = config.opencodeGoModelMaxTokens || {};
  const goHasOutputLimit = Object.hasOwn(goOutputLimits, goModel);
  const goEntry = goModels.find(m => m.name === goModel);
  const goKnownProtocol = goEntry?.defaultProtocol !== undefined ? goEntry.defaultProtocol : goEntry?.protocol;
  const goBusy = isGoTesting || isGoDiscovering;
  const goCatalogStatus = activeModelServer?.opencodeGo?.catalogStatus;
  const goAvailability = (status: string | undefined) => t(status === 'available' ? 'goAvailable'
    : status === 'unsupported' ? 'goUnsupported' : status === 'temporary_error' ? 'goTemporaryError'
    : status === 'request_failed' ? 'goRequestFailed' : status === 'retired' ? 'goRetired' : status === 'not_listed' ? 'goNotListed' : 'goUnverified');
  const goHasWarning = (status: string | undefined) => ['unsupported', 'temporary_error', 'request_failed', 'retired', 'not_listed'].includes(status || '');
  const updateGo = (key: string, value: unknown) => { resetGoTest(); updateConfig(key, value); };
  const renderGoTab = () => (
    <Section title="OpenCode Go">
      <fieldset disabled={goBusy} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
      <ToggleRow label={t('goEnable')} checked={config.opencodeGoEnabled} onChange={value => updateGo('opencodeGoEnabled', value)} />
      <Field label={t('goApiKey')}>
        <TextInput value={config.opencodeGoApiKey || ''} type="password" onChange={value => updateGo('opencodeGoApiKey', value)} />
      </Field>
      <div className="go-settings-actions">
        <a href="https://opencode.ai/auth" target="_blank" rel="noreferrer">{t('goConsole')}</a>
        <button type="button" className="btn-save-settings" disabled={goBusy || !config.opencodeGoApiKey} onClick={handleClearGoKey}>{t('goClearKey')}</button>
      </div>
      <Field label={t('goModel')}>
        <SelectInput ariaLabel={t('goModel')} value={goModel} onChange={value => updateGo('opencodeGoDefaultModel', value)}>
          {!goModel && <option value="">{t('goSelectModel')}</option>}
          {goModel && !goModels.some(m => m.name === goModel) && <option value={goModel}>{goModel}</option>}
          {goModels.map(model => <option value={model.name} key={model.id}>{model.name}{goHasWarning(model.availability) ? ` (${goAvailability(model.availability)})` : ''}</option>)}
        </SelectInput>
      </Field>
      <Field label={t('goApiType')}>
        <SelectInput ariaLabel={t('goApiType')} value={goProtocol || ''} onChange={value => {
          const overrides = { ...(config.opencodeGoProtocolOverrides || {}) };
          if (value) overrides[goModel] = value as GoProtocol;
          else delete overrides[goModel];
          updateGo('opencodeGoProtocolOverrides', overrides);
        }}>
          <option value="">{t('goAutoApi')}{goKnownProtocol ? ` (${goKnownProtocol})` : ''}</option>
          <option value="chat">Chat Completions</option>
          <option value="messages">Messages</option>
          <option value="responses">Responses</option>
          <option value="google">Google GenerateContent</option>
        </SelectInput>
      </Field>
      {goModel && !goProtocol && !goKnownProtocol && <p role="status" className="go-settings-warning">{t('goUnknownApi')}</p>}
      {goEntry && <p role="status" className={goHasWarning(goEntry.availability) ? 'go-settings-warning' : 'go-settings-note'}>
        {goAvailability(goEntry.availability)}{goEntry.availabilityReason ? `: ${goEntry.availabilityReason}` : ''}
      </p>}
      <ToggleRow label={t('goCustomOutputLimit')} checked={goHasOutputLimit} onChange={enabled => {
        if (!goModel) return;
        if (enabled) {
          updateGo('opencodeGoModelMaxTokens', { ...goOutputLimits, [goModel]: config.maxTokens || 4096 });
          return;
        }
        const limits = { ...goOutputLimits };
        delete limits[goModel];
        updateGo('opencodeGoModelMaxTokens', limits);
      }} />
      {goHasOutputLimit && <Field label={t('goModelOutputLimit')}>
        <NumberInput value={goOutputLimits[goModel]} min={1} onChange={value =>
          updateGo('opencodeGoModelMaxTokens', { ...goOutputLimits, [goModel]: value })} />
      </Field>}
      <Field label={t('requestTimeoutMs')}>
        <NumberInput value={config.opencodeGoRequestTimeoutMs ?? 120000} min={5000} max={3600000} step={1000} onChange={value => updateGo('opencodeGoRequestTimeoutMs', value)} />
      </Field>
      <div className="go-settings-actions">
        <button type="button" className="btn-save-settings" onClick={handleDiscoverGo} disabled={goBusy}>{isGoDiscovering ? t('goDiscovering') : t('syncModels')}</button>
        <button type="button" className="btn-save-settings" onClick={handleTestGo} disabled={goBusy || !config.opencodeGoApiKey || !goModel}>{isGoTesting ? t('testing') : t('goTestKey')}</button>
        <button type="button" className="btn-save-settings" onClick={handleUseGo} disabled={goBusy || !config.opencodeGoApiKey || !goModel || !(goProtocol || goKnownProtocol)}>{t('goUseModel')}</button>
      </div>
      </fieldset>
      <p className="go-settings-note">{t('goTestUsage')}</p>
      {goCatalogStatus && <p className="go-settings-note">
        {t('goCatalogUpdated')}: {goCatalogStatus.fetchedAt ? new Date(goCatalogStatus.fetchedAt).toLocaleString() : '-'}
        {goCatalogStatus.stale ? ` (${t('goCachedCatalog')})` : ''}
      </p>}
      {goCatalogStatus?.error && !goDiscoveryError && <p role="status" className="go-settings-warning">{t('goCachedCatalog')}: {goCatalogStatus.error}</p>}
      {goDiscoveryError && <p role="alert" className="go-settings-error">{goDiscoveryError}</p>}
      {goTest && <p role="status" className={goTest.ok ? 'go-settings-success' : 'go-settings-error'}>
        {goTest.ok ? `${t(goTest.authenticated ? 'goAuthenticated' : 'goResponseOnly')}: ${goTest.model} (${goTest.protocol}, ${goTest.latencyMs} ms)` : `${t('testFailed')}: ${goTest.error || ''}`}
      </p>}
      <p className="go-settings-note">{t('goActiveModel')}: {config.activeModel}</p>
    </Section>
  );

  const renderActiveTab = () => {
    switch (activeTab) {
      case 'opencode-go':
        return renderGoTab();
      case 'opengo':
        return renderOpengoTab();
      case 'workspace':
        return renderWorkspaceTab();
      case 'brain':
        return renderBrainTab();
      case 'memory':
        return renderMemoryTab();
      case 'keys':
        return renderKeysTab();
      case 'ide':
        return renderIdeTab();
      case 'web':
        return renderWebTab();
      case 'gguf':
      default:
        return renderGgufTab();
    }
  };

  return (
    <div className="settings-modal-overlay" onClick={onClose}>
      <div className="settings-modal-container" onClick={(event) => event.stopPropagation()}>
        <div className="settings-modal-header">
          <span className="settings-modal-title">{t('settingsTitle')}</span>
          <button className="settings-modal-close" onClick={onClose} type="button">x</button>
        </div>
        <div className="settings-modal-body">
          <div className="settings-modal-sidebar">
            {TABS.map(tab => (
              <button
                key={tab.id}
                className={`settings-modal-tab ${activeTab === tab.id ? 'active' : ''}`}
                onClick={() => setActiveTab(tab.id)}
                type="button"
              >
                {t(tab.labelKey)}
              </button>
            ))}
          </div>

          <div className="settings-modal-content">
            {renderActiveTab()}
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 18 }}>
              <button className="btn-save-settings" style={{ flex: 1 }} onClick={handleSaveSettings} type="button" disabled={activeTab === 'opencode-go' && goBusy}>
                {t('saveSettings')}
              </button>
              {settingsStatus && <span style={{ color: 'var(--accent-cyan)', fontSize: 12 }}>{settingsStatus}</span>}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function ListBlock({ title, items }: {
  title: string;
  // Workspace-standard entries ({ path, name }) — backend-owned shape.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  items: any[];
}) {
  return (
    <div style={{ border: '1px solid rgba(255,255,255,0.08)', borderRadius: 8, padding: 10, minHeight: 90 }}>
      <div style={{ color: 'var(--accent-violet)', fontWeight: 700, fontSize: 12, marginBottom: 8 }}>{title}</div>
      {items.length === 0 ? (
        <div style={{ color: 'var(--text-secondary)', fontSize: 12 }}>-</div>
      ) : (
        items.map((item, index) => (
          <div key={`${item.path || item}-${index}`} style={{ color: 'var(--text-secondary)', fontSize: 12, marginBottom: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {item.path || item.name || String(item)}
          </div>
        ))
      )}
    </div>
  );
}
