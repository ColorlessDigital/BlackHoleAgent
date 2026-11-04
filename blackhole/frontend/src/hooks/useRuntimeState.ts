import { useEffect, useState } from 'react';
import type {
  ActiveModelServer,
  ApiClient,
  AppConfig,
  AppendTerminal,
  LocalModelEntry,
  ModelCatalogEntry,
  OpengoTestResult,
  OpenCodeGoTestResult,
  RuntimeDiscovery,
  RuntimeStatus,
  UsageSummary,
  WebTestStatus
} from '../types.ts';

const DEFAULT_CONFIG: AppConfig = {
  activeModel: 'llamacpp:local-gguf',
  localRuntime: 'llamacpp',
  llamaCppUrl: 'http://127.0.0.1:8080',
  llamaCppServerPath: '',
  llamaCppModelPath: '',
  llamaCppGpuLayers: 999,
  llamaCppThreads: 0,
  llamaCppBatch: 512,
  llamaCppParallel: 1,
  llamaCppStartupTimeoutMs: 120000,
  llamaCppRequestTimeoutMs: 600000,
  contextLimit: 8192,
  maxTokens: 4096,
  temperature: 0.2,
  selfHealingMaxCycles: 4,
  agentMaxSteps: 24,
  agentCheckpointRetentionLimit: 20,
  agentMemoryEnabled: true,
  agentMemoryRetentionLimit: 200,
  agentModelRoutingEnabled: true,
  ideNativeActionsEnabled: true,
  ideAutocompleteMaxPrefixChars: 5000,
  ideAutocompleteMaxSuffixChars: 2000,
  ideInlineEditMaxSelectionChars: 12000,
  agentModelProfiles: {
    general: { model: '', contextLimit: 8192, maxTokens: 4096, temperature: 0.2 },
    planner: { model: '', contextLimit: 8192, maxTokens: 4096, temperature: 0.2 },
    coder: { model: '', contextLimit: 8192, maxTokens: 4096, temperature: 0.15 },
    verifier: { model: '', contextLimit: 8192, maxTokens: 2048, temperature: 0.05 },
    summarizer: { model: '', contextLimit: 8192, maxTokens: 2048, temperature: 0.1 }
  },
  permissionMode: 'operator',
  strictBlocking: false,
  opengoEnabled: false,
  opengoPreset: 'custom',
  opengoBaseUrl: '',
  opengoApiKey: '',
  opengoDefaultModel: '',
  opengoModels: [],
  opengoRequestTimeoutMs: 120000,
  opencodeGoEnabled: false,
  opencodeGoApiKey: '',
  opencodeGoDefaultModel: 'glm-5.3-flash',
  opencodeGoModels: [],
  opencodeGoProtocolOverrides: {},
  opencodeGoModelMaxTokens: {},
  opencodeGoRequestTimeoutMs: 120000,
  contextCompactionEnabled: true,
  contextCompactionThreshold: 0.9,
  apiKeys: { openai: '', anthropic: '', deepseek: '', gemini: '' },
  webSearchProvider: 'duckduckgo',
  tavilyApiKey: '',
  exaApiKey: '',
  braveApiKey: '',
  firecrawlApiKey: '',
  webRequestTimeoutMs: 10000,
  webMaxResponseBytes: 1048576,
  webCrawlerMaxDepth: 1,
  webCrawlerMaxPages: 20,
  webCrawlerDelayMs: 1000,
  webAllowedDomains: '',
  webRenderEnabled: false,
  webStrictScopeEnabled: false,
  webRequireAllowedDomainsForCrawl: false,
  webSearchMaxResults: 5,
  webEvidenceRetentionLimit: 20,
  memories: []
};

export default function useRuntimeState(
  client: ApiClient | null,
  appendTerminal: AppendTerminal | undefined
) {
  const [runtimeStatus, setRuntimeStatus] = useState<RuntimeStatus | null>(null);
  const [runtimeDiscovery, setRuntimeDiscovery] = useState<RuntimeDiscovery>({ servers: [], models: [] });
  const [isRuntimeStarting, setIsRuntimeStarting] = useState(false);
  const [isRuntimeStopping, setIsRuntimeStopping] = useState(false);
  const [preflightResult, setPreflightResult] = useState<unknown>(null);
  const [isPreflightLoading, setIsPreflightLoading] = useState(false);
  const [config, setConfig] = useState<AppConfig>(DEFAULT_CONFIG);
  const [settingsStatus, setSettingsStatus] = useState('');
  const [webTestStatus, setWebTestStatus] = useState<WebTestStatus | null>(null);
  const [localModels, setLocalModels] = useState<LocalModelEntry[]>([]);
  const [localModelError, setLocalModelError] = useState('');
  const [isLocalModelLoading, setIsLocalModelLoading] = useState(false);
  const [newMemoryInput, setNewMemoryInput] = useState('');
  const [modelCatalog, setModelCatalog] = useState<ModelCatalogEntry[]>([]);
  const [activeModelServer, setActiveModelServer] = useState<ActiveModelServer | null>(null);
  const [opengoTest, setOpengoTest] = useState<OpengoTestResult | null>(null);
  const [isOpengoTesting, setIsOpengoTesting] = useState(false);
  const [goTest, setGoTest] = useState<OpenCodeGoTestResult | null>(null);
  const [isGoTesting, setIsGoTesting] = useState(false);
  const [isGoDiscovering, setIsGoDiscovering] = useState(false);
  const [goDiscoveryError, setGoDiscoveryError] = useState('');
  const [usageSummary, setUsageSummary] = useState<UsageSummary | null>(null);

  useEffect(() => {
    if (!client || !config.opencodeGoEnabled) return;
    let disposed = false;
    let pending = false;
    const refresh = async () => {
      if (pending) return;
      pending = true;
      try {
        const data = await client.request('/models');
        if (!disposed) {
          setModelCatalog(data.catalog || []);
          setActiveModelServer({ activeModel: data.activeModel, opengo: data.opengo || null, opencodeGo: data.opencodeGo || null });
        }
      } catch { /* Keep the last usable catalog while offline. */ }
      finally { pending = false; }
    };
    void refresh();
    const timer = window.setInterval(refresh, 60000);
    return () => { disposed = true; window.clearInterval(timer); };
  }, [client, config.opencodeGoEnabled]);

  async function fetchConfig(): Promise<void> {
    if (!client) return;
    try {
      const data = await client.request('/config');
      setConfig({ ...DEFAULT_CONFIG, ...data });
    } catch (error) {
      appendTerminal?.(`Failed to load config: ${(error as Error).message}`, 'error');
    }
  }

  async function handleSaveSettings(): Promise<void> {
    if (!client) return;
    try {
      setSettingsStatus('Saving settings...');
      const data = await client.request('/config', {
        method: 'POST',
        body: JSON.stringify(config)
      });
      setConfig({ ...DEFAULT_CONFIG, ...data });
      setSettingsStatus('Settings saved.');
      appendTerminal?.('System configuration updated.', 'success');
      setTimeout(() => setSettingsStatus(''), 3000);
      fetchModelCatalog();
    } catch (error) {
      setSettingsStatus(`Save failed: ${(error as Error).message}`);
      appendTerminal?.(`Settings save failed: ${(error as Error).message}`, 'error');
    }
  }

  async function fetchLlamaRuntimeStatus(): Promise<void> {
    if (!client) return;
    try {
      setRuntimeStatus(await client.request('/runtime/status'));
    } catch (error) {
      console.error('Failed to fetch llama runtime status:', error);
    }
  }

  async function fetchRuntimeDiscover(): Promise<void> {
    if (!client) return;
    try {
      setRuntimeDiscovery(await client.request('/runtime/discover'));
    } catch (error) {
      console.error('Failed to discover runtime systems:', error);
    }
  }

  async function handleRunPreflight(): Promise<unknown> {
    if (!client) return null;
    setIsPreflightLoading(true);
    setPreflightResult(null);
    appendTerminal?.('Running llama.cpp preflight check...', 'log');

    try {
      const data = await client.request('/runtime/preflight', {
        method: 'POST',
        body: JSON.stringify({
          llamaCppServerPath: config.llamaCppServerPath,
          llamaCppModelPath: config.llamaCppModelPath,
          llamaCppUrl: config.llamaCppUrl
        })
      });
      setPreflightResult(data);
      appendTerminal?.(
        data.ok ? `Preflight passed: ${data.type || 'READY'}` : `Preflight failed: ${data.error || 'unknown error'}`,
        data.ok ? 'success' : 'error'
      );
      return data;
    } catch (error) {
      const result = { ok: false, error: `Preflight request failed: ${(error as Error).message}` };
      setPreflightResult(result);
      appendTerminal?.(result.error, 'error');
      return result;
    } finally {
      setIsPreflightLoading(false);
    }
  }

  async function handleStartLlamaRuntime(): Promise<void> {
    if (!client) return;
    setIsRuntimeStarting(true);
    try {
      const preflight = await handleRunPreflight() as { ok?: boolean; type?: string } | null;
      if (preflight && !preflight.ok) return;
      if (preflight?.type === 'ALREADY_RUNNING') {
        appendTerminal?.('llama.cpp server is already running.', 'success');
        await fetchLlamaRuntimeStatus();
        return;
      }

      appendTerminal?.('Starting local llama.cpp server...', 'log');
      const data = await client.request('/runtime/start', {
        method: 'POST',
        body: JSON.stringify({
          llamaCppServerPath: config.llamaCppServerPath,
          llamaCppModelPath: config.llamaCppModelPath
        })
      });
      if (data.ok) {
        appendTerminal?.('Local llama.cpp server started.', 'success');
        await fetchLlamaRuntimeStatus();
      } else {
        appendTerminal?.(`Runtime start failed: ${data.error || 'unknown error'}`, 'error');
      }
    } catch (error) {
      appendTerminal?.(`Runtime start failed: ${(error as Error).message}`, 'error');
    } finally {
      setIsRuntimeStarting(false);
    }
  }

  async function handleStopLlamaRuntime(): Promise<void> {
    if (!client) return;
    setIsRuntimeStopping(true);
    try {
      appendTerminal?.('Stopping local llama.cpp server...', 'warning');
      const data = await client.request('/runtime/stop', { method: 'POST' });
      if (data.ok) {
        appendTerminal?.('Local llama.cpp server stopped.', 'success');
        await fetchLlamaRuntimeStatus();
      } else {
        appendTerminal?.(`Runtime stop failed: ${data.error || 'unknown error'}`, 'error');
      }
    } catch (error) {
      appendTerminal?.(`Runtime stop failed: ${(error as Error).message}`, 'error');
    } finally {
      setIsRuntimeStopping(false);
    }
  }

  async function fetchLocalModels(): Promise<void> {
    if (!client) return;
    setIsLocalModelLoading(true);
    setLocalModelError('');
    try {
      const data = await client.request('/models');
      setLocalModels((data.models || []) as LocalModelEntry[]);
      appendTerminal?.(
        (data.models || []).length > 0
          ? `Local GGUF models found: ${(data.models || []).map((model: LocalModelEntry) => model.name).join(', ')}`
          : 'No local GGUF models found.',
        (data.models || []).length > 0 ? 'success' : 'warning'
      );
    } catch (error) {
      setLocalModelError((error as Error).message || 'Connection error');
      appendTerminal?.(`Local model discovery failed: ${(error as Error).message}`, 'error');
    } finally {
      setIsLocalModelLoading(false);
    }
  }

  async function handleSelectLlamaServerFile(): Promise<void> {
    if (!client) return;
    try {
      let selectedPath: string | null = null;
      if (window.blackhole?.selectLlamaServer) {
        selectedPath = await window.blackhole.selectLlamaServer();
      } else {
        const data = await client.request('/dialog/select-llama-server');
        if (!data.canceled) selectedPath = data.filePath;
      }
      if (selectedPath) {
        setConfig(prev => ({ ...prev, llamaCppServerPath: selectedPath as string }));
        appendTerminal?.(`Selected llama-server: ${selectedPath}`, 'success');
      }
    } catch (error) {
      appendTerminal?.(`llama-server selection failed: ${(error as Error).message}`, 'error');
    }
  }

  async function handleSelectGgufFile(setGgufNick?: (name: string) => void): Promise<void> {
    if (!client) return;
    try {
      let selectedPath: string | null = null;
      if (window.blackhole?.selectGgufModel) {
        selectedPath = await window.blackhole.selectGgufModel();
      } else {
        const data = await client.request('/dialog/select-gguf');
        if (!data.canceled) {
          selectedPath = data.filePath;
          if (setGgufNick) setGgufNick(data.suggestedName);
        }
      }
      if (selectedPath) {
        setConfig(prev => ({ ...prev, llamaCppModelPath: selectedPath as string }));
        appendTerminal?.(`Selected GGUF model: ${selectedPath}`, 'success');
      }
    } catch (error) {
      appendTerminal?.(`Model selection failed: ${(error as Error).message}`, 'error');
    }
  }

  function handleAddMemory(inputVal: unknown, setInputVal?: (value: string) => void): void {
    const targetInput = typeof inputVal === 'string' ? inputVal : newMemoryInput;
    const value = (targetInput || '').trim();
    if (!value) return;
    setConfig(prev => ({ ...prev, memories: [...(prev.memories || []), value] }));
    if (typeof setInputVal === 'function') {
      setInputVal('');
    } else {
      setNewMemoryInput('');
    }
    appendTerminal?.('Memory item added. Save settings to persist it.', 'log');
  }

  function handleDeleteMemory(index: number): void {
    setConfig(prev => ({
      ...prev,
      memories: (prev.memories || []).filter((_, itemIndex) => itemIndex !== index)
    }));
    appendTerminal?.('Memory item removed. Save settings to persist the change.', 'warning');
  }

  async function handleWebTestConnection(webConfigParams: unknown): Promise<void> {
    if (!client) return;
    setWebTestStatus({ testing: true });
    try {
      const data = await client.request('/web-test', {
        method: 'POST',
        body: JSON.stringify(webConfigParams)
      });
      setWebTestStatus({
        testing: false,
        ok: data.ok,
        provider: data.provider,
        error: data.error,
        fallback: data.fallback
      });
    } catch (error) {
      setWebTestStatus({
        testing: false,
        ok: false,
        error: (error as Error).message
      });
    }
  }

  async function fetchModelCatalog(): Promise<ModelCatalogEntry[]> {
    if (!client) return [];
    try {
      const data = await client.request('/models');
      setModelCatalog((data.catalog || []) as ModelCatalogEntry[]);
      setActiveModelServer({ activeModel: data.activeModel, opengo: data.opengo || null, opencodeGo: data.opencodeGo || null });
      return (data.catalog || []) as ModelCatalogEntry[];
    } catch (error) {
      console.error('Failed to fetch model catalog:', error);
      return [];
    }
  }

  async function handleSelectModel(modelId: string): Promise<void> {
    if (!client || !modelId) return;
    const next = { ...config, activeModel: modelId };
    setConfig(next);
    try {
      const data = await client.request('/config', { method: 'POST', body: JSON.stringify(next) });
      setConfig({ ...DEFAULT_CONFIG, ...data });
      await fetchModelCatalog();
      appendTerminal?.(`모델 변경: ${modelId}`, 'success');
    } catch (error) {
      appendTerminal?.(`모델 변경 실패: ${(error as Error).message}`, 'error');
    }
  }

  async function handleTestOpengo(): Promise<OpengoTestResult | null> {
    if (!client) return null;
    setIsOpengoTesting(true);
    setOpengoTest(null);
    try {
      // Save first so the test uses the edited preset/baseUrl/key.
      let savedConfig = config;
      try {
        const saved = await client.request('/config', { method: 'POST', body: JSON.stringify(config) });
        savedConfig = { ...DEFAULT_CONFIG, ...saved };
        setConfig(savedConfig);
      } catch {}
      const data = await client.request('/models/test-opengo', { method: 'POST' }) as OpengoTestResult;
      setOpengoTest(data);
      if (!data.ok) {
        appendTerminal?.(`OpenGo 연결 실패: ${data.error}`, 'error');
        return data;
      }
      appendTerminal?.(`OpenGo 연결 성공: ${data.modelCount}개 모델`, 'success');
      await fetchModelCatalog();
      // Key-only flow: no opengo model selected yet → auto-select the
      // gateway's first model so the picker works immediately.
      if (data.suggestedModel && !String(savedConfig.activeModel || '').startsWith('opengo:')) {
        try {
          const switched = await client.request('/config', {
            method: 'POST',
            body: JSON.stringify({ ...savedConfig, activeModel: data.suggestedModel })
          });
          setConfig({ ...DEFAULT_CONFIG, ...switched });
          await fetchModelCatalog();
          appendTerminal?.(`모델 자동 선택: ${data.suggestedModel}`, 'success');
        } catch (error) {
          appendTerminal?.(`모델 자동 선택 실패: ${(error as Error).message}`, 'error');
        }
      }
      return data;
    } catch (error) {
      const result: OpengoTestResult = { ok: false, error: (error as Error).message };
      setOpengoTest(result);
      return result;
    } finally {
      setIsOpengoTesting(false);
    }
  }

  async function fetchUsage(): Promise<UsageSummary | null> {
    if (!client) return null;
    try {
      const data = await client.request('/reports/usage');
      setUsageSummary((data.usage || null) as UsageSummary | null);
      return (data.usage || null) as UsageSummary | null;
    } catch (error) {
      console.error('Failed to fetch usage:', error);
      return null;
    }
  }

  async function handleDiscoverGo(): Promise<void> {
    if (!client) return;
    setIsGoDiscovering(true);
    setGoDiscoveryError('');
    try {
      const data = await client.request('/models/opencode-go');
      if (!data.ok) throw new Error(data.error || 'Model discovery failed');
      setActiveModelServer(prev => ({ ...prev, opencodeGo: { ...prev?.opencodeGo, models: data.models, catalogStatus: data.catalogStatus } }));
      if (data.catalogStatus?.error) setGoDiscoveryError(data.catalogStatus.error);
      await fetchModelCatalog();
      appendTerminal?.(`OpenCode Go 모델 목록 조회: ${data.models.length}`, 'success');
    } catch (error) {
      setGoDiscoveryError((error as Error).message);
    } finally {
      setIsGoDiscovering(false);
    }
  }

  async function handleTestGo(): Promise<void> {
    if (!client) return;
    setIsGoTesting(true);
    setGoTest(null);
    try {
      // A failed save must stop the test; otherwise it would test an old key.
      const saved = await client.request('/config', { method: 'POST', body: JSON.stringify(config) });
      setConfig({ ...DEFAULT_CONFIG, ...saved });
      const result = await client.request('/models/test-opencode-go', { method: 'POST' }) as OpenCodeGoTestResult;
      setGoTest(result);
      appendTerminal?.(result.ok ? `OpenCode Go ${result.authenticated ? '인증 및 응답 확인' : '응답 확인 (키 인증 미확인)'}: ${result.model}` : `OpenCode Go 연결 실패: ${result.error}`, result.ok ? 'success' : 'error');
      await fetchModelCatalog();
    } catch (error) {
      setGoTest({ ok: false, error: (error as Error).message });
    } finally {
      setIsGoTesting(false);
    }
  }

  async function handleUseGo(): Promise<void> {
    if (!client || !config.opencodeGoDefaultModel) return;
    setIsGoTesting(true);
    setGoTest(null);
    try {
      const next = { ...config, opencodeGoEnabled: true, activeModel: `opencode-go:${config.opencodeGoDefaultModel}` };
      const saved = await client.request('/config', { method: 'POST', body: JSON.stringify(next) });
      setConfig({ ...DEFAULT_CONFIG, ...saved });
      await fetchModelCatalog();
      appendTerminal?.(`모델 변경: ${saved.activeModel}`, 'success');
    } catch (error) {
      setGoTest({ ok: false, error: (error as Error).message });
    } finally {
      setIsGoTesting(false);
    }
  }

  async function handleClearGoKey(): Promise<void> {
    if (!client) return;
    setIsGoTesting(true);
    setGoTest(null);
    try {
      const saved = await client.request('/config', { method: 'POST', body: JSON.stringify({ opencodeGoApiKey: '' }) });
      setConfig(prev => ({ ...prev, opencodeGoApiKey: saved.opencodeGoApiKey }));
      await fetchModelCatalog();
    } catch (error) {
      setGoTest({ ok: false, error: (error as Error).message });
    } finally {
      setIsGoTesting(false);
    }
  }

  async function handleResetUsage(): Promise<void> {
    if (!client) return;
    try {
      const data = await client.request('/reports/usage', { method: 'DELETE' });
      setUsageSummary((data.usage || null) as UsageSummary | null);
      appendTerminal?.('모델 사용량 기록을 초기화했습니다.', 'warning');
    } catch (error) {
      appendTerminal?.(`사용량 초기화 실패: ${(error as Error).message}`, 'error');
    }
  }

  return {
    runtimeStatus, setRuntimeStatus,
    runtimeDiscovery, setRuntimeDiscovery,
    isRuntimeStarting, setIsRuntimeStarting,
    isRuntimeStopping, setIsRuntimeStopping,
    config, setConfig,
    settingsStatus, setSettingsStatus,
    webTestStatus, setWebTestStatus,
    localModels, setLocalModels,
    localModelError, setLocalModelError,
    isLocalModelLoading, setIsLocalModelLoading,
    preflightResult, setPreflightResult,
    isPreflightLoading, setIsPreflightLoading,
    newMemoryInput, setNewMemoryInput,
    modelCatalog, setModelCatalog,
    activeModelServer,
    opengoTest, setOpengoTest,
    isOpengoTesting, setIsOpengoTesting,
    goTest, setGoTest, isGoTesting, isGoDiscovering, goDiscoveryError,
    handleTestGo, handleDiscoverGo, handleUseGo, handleClearGoKey,
    usageSummary, setUsageSummary,
    fetchConfig, handleSaveSettings, fetchLlamaRuntimeStatus, fetchRuntimeDiscover,
    handleStartLlamaRuntime, handleStopLlamaRuntime, fetchLocalModels,
    handleSelectLlamaServerFile, handleSelectGgufFile, handleAddMemory, handleDeleteMemory,
    handleRunPreflight, handleWebTestConnection,
    fetchModelCatalog, handleSelectModel, handleTestOpengo, fetchUsage, handleResetUsage
  };
}
