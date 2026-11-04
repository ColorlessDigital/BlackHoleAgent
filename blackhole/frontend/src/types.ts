// Shared frontend types. No imports — safe for every module to depend on.
//
// Wire payloads from the gateway stay loose on purpose: the backend owns
// those shapes. Domain objects owned by the UI are typed strictly.

export type Locale = 'ko' | 'en' | 'ja';
export type TranslationDict = Record<string, string>;
export type TranslateFn = (key: string, params?: Record<string, string | number>) => string;

// Loose JSON from the gateway (field set varies per endpoint).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ApiResponse = any;

export interface ApiBootstrap {
  baseUrl: string;
  token: string;
}

export interface ApiClient {
  baseUrl: string;
  token: string;
  eventsUrl: string;
  request<T = ApiResponse>(path: string, options?: RequestInit): Promise<T>;
  stream(path: string, body: unknown, onEvent: (event: StreamEvent) => void): Promise<void>;
}

export interface StreamEvent {
  type?: string;
  text?: string;
  status?: string;
  error?: string;
  tool?: string;
  state?: string;
  log?: string;
  outcome?: { status: 'completed' | 'incomplete' | 'failed' | 'stopped'; reason?: string };
  // Allow gateway-specific extras without casts at each call site.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
}

export type ChatRole = 'user' | 'assistant' | 'system' | 'tool_result';

export interface ChatAttachment {
  name: string;
  type: string;
  data?: string;
}

export interface ReasoningRecord {
  id: string;
  text: string;
  model?: string;
  phase?: string;
  step?: number;
  startedAt: number;
  updatedAt: number;
}

export interface ChatMessage {
  role: ChatRole;
  content: string;
  i18nKey?: string;
  attachments?: ChatAttachment[];
  tool?: string;
  checkpointResume?: boolean;
  sessionId?: string | number;
  providerSessionId?: string;
  reasoning?: ReasoningRecord[];
}

export interface TerminalLine {
  text: string;
  type: string;
  i18nKey?: string;
}

export type AppendTerminal = (text: string, type?: string) => void;

export interface TaskItem {
  id: number;
  text: string;
  status: string;
}

export interface ExecutionBudget {
  maxSteps: number;
  stepsUsed: number;
  maxRepairCycles: number;
  repairCyclesUsed: number;
  limitReached?: 'steps' | 'repair_cycles' | null;
}

export interface ModelFailure {
  provider?: string;
  model?: string;
  code?: string;
  outputTokenLimit?: number;
}

export interface ModelRoute {
  model?: string;
  profile?: string;
  phase?: string;
  maxTokens?: number;
}

export interface StatusItem {
  status: string;
  phase?: string;
  level?: string;
  heartbeat?: boolean;
  recovery?: boolean;
  elapsedMs?: number;
  elapsedSeconds?: number;
  executionBudget?: ExecutionBudget;
  timestamp?: number;
}

export interface TimelineEvent {
  state: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  payload?: any;
  timestamp?: number;
}

export interface ActiveTool {
  name: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  params?: any;
}

export interface PendingSecurityAction {
  id: string;
  tool: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  params?: any;
  reason: string;
}

export interface CheckpointInfo {
  sessionId?: string;
  workspaceRoot?: string;
  userGoal?: string;
  state?: string;
  timestamp?: number;
  createdAt?: number;
  nextRecommendedAction?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
}

export interface ChatSession {
  id: number | string;
  title: string;
  messages: ChatMessage[];
}

export interface FileNode {
  path: string;
  name: string;
  isDir?: boolean;
  children?: FileNode[];
  childrenLoaded?: boolean;
  nextOffset?: number | null;
  loading?: boolean;
  error?: string;
}

export interface ModelProfile {
  model?: string;
  contextLimit?: number;
  maxTokens?: number;
  temperature?: number;
}

export interface OpengoRegisteredModel {
  id: string;
  label?: string;
  contextLimit?: number | null;
  maxTokens?: number | null;
}

export interface OpengoPreset {
  id: string;
  label: string;
  baseUrl: string;
  needsKey: boolean;
}

export interface ModelCatalogEntry {
  id: string;
  name?: string;
  label?: string;
  provider?: string;
  runtime?: string;
  contextLimit?: number | null;
  maxTokens?: number | null;
  source?: string;
  protocol?: GoProtocol | null;
  defaultProtocol?: GoProtocol | null;
  availability?: 'available' | 'unsupported' | 'temporary_error' | 'request_failed' | 'retired' | 'not_listed' | 'unverified';
  availabilityReason?: string;
}

export type GoProtocol = 'chat' | 'messages' | 'responses' | 'google';

export interface GoCatalogStatus {
  fetchedAt: number | null;
  metadataFetchedAt: number | null;
  stale: boolean;
  refreshing: boolean;
  error: string | null;
}

export interface OpenCodeGoTestResult {
  ok: boolean;
  authenticated?: boolean;
  model?: string;
  protocol?: GoProtocol;
  latencyMs?: number;
  error?: string;
}

export interface AppConfig {
  activeModel?: string;
  localRuntime?: string;
  llamaCppUrl?: string;
  llamaCppServerPath?: string;
  llamaCppModelPath?: string;
  llamaCppGpuLayers?: number;
  llamaCppThreads?: number;
  llamaCppBatch?: number;
  llamaCppParallel?: number;
  llamaCppStartupTimeoutMs?: number;
  llamaCppRequestTimeoutMs?: number;
  contextLimit?: number;
  maxTokens?: number;
  temperature?: number;
  selfHealingMaxCycles?: number;
  agentMaxSteps?: number;
  agentCheckpointRetentionLimit?: number;
  agentMemoryEnabled?: boolean;
  agentMemoryRetentionLimit?: number;
  agentModelRoutingEnabled?: boolean;
  agentModelProfiles?: Record<string, ModelProfile>;
  permissionMode?: string;
  strictBlocking?: boolean;
  opengoEnabled?: boolean;
  opengoPreset?: string;
  opengoBaseUrl?: string;
  opengoApiKey?: string;
  opengoDefaultModel?: string;
  opengoModels?: OpengoRegisteredModel[];
  opengoRequestTimeoutMs?: number;
  opencodeGoEnabled?: boolean;
  opencodeGoApiKey?: string;
  opencodeGoDefaultModel?: string;
  opencodeGoModels?: string[];
  opencodeGoProtocolOverrides?: Record<string, GoProtocol>;
  opencodeGoModelMaxTokens?: Record<string, number>;
  opencodeGoRequestTimeoutMs?: number;
  contextCompactionEnabled?: boolean;
  contextCompactionThreshold?: number;
  apiKeys?: Record<string, string>;
  webSearchProvider?: string;
  webRequestTimeoutMs?: number;
  webMaxResponseBytes?: number;
  webCrawlerMaxDepth?: number;
  webCrawlerMaxPages?: number;
  webCrawlerDelayMs?: number;
  webAllowedDomains?: string;
  webRenderEnabled?: boolean;
  webStrictScopeEnabled?: boolean;
  webRequireAllowedDomainsForCrawl?: boolean;
  webSearchMaxResults?: number;
  webEvidenceRetentionLimit?: number;
  memories?: string[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
}

export interface RuntimeStatus {
  healthy?: boolean;
  baseUrl?: string;
  modelInfo?: { name: string; sizeGB: string | number; tier: string };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
}

export interface DiscoveryCandidate {
  path?: string;
  filePath?: string;
  executable?: string;
  modelPath?: string;
  name?: string;
  label?: string;
}

export interface RuntimeDiscovery {
  servers: DiscoveryCandidate[];
  models: DiscoveryCandidate[];
}

export interface LocalModelEntry {
  id?: string;
  name?: string;
  path?: string;
}

export interface IdeEntry {
  detected?: boolean;
  path?: string;
}

export interface WebTestStatus {
  testing?: boolean;
  ok?: boolean;
  provider?: string;
  error?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
}

export interface OpengoTestResult {
  ok: boolean;
  modelCount?: number;
  models?: string[];
  suggestedModel?: string;
  error?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
}

export interface ActiveModelServer {
  activeModel?: string;
  opengo?: { presets?: OpengoPreset[] };
  opencodeGo?: { models?: ModelCatalogEntry[]; configured?: boolean; catalogStatus?: GoCatalogStatus };
}

export interface UsageEntry {
  requests: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  tags?: Record<string, number>;
  lastUsed?: string | null;
}

export interface UsageSummary {
  version?: number;
  byModel: Record<string, UsageEntry>;
  totals: { requests: number; promptTokens: number; completionTokens: number; totalTokens: number };
  estimatedTotals?: { requests: number; totalTokens: number };
  failedTotals?: { requests: number; totalTokens: number };
  legacyTotals?: { requests: number; totalTokens: number };
  updatedAt?: string | null;
}

export interface CollabAgent {
  name: string;
  role: string;
}

export interface CollabMessage {
  agent?: string;
  role?: string;
  content?: string;
  text?: string;
  status?: string;
  type?: string;
}

export interface BlackholeWindowApi {
  getApiConfig?: () => Promise<ApiBootstrap>;
  selectWorkspace?: () => Promise<string | null>;
  selectLlamaServer?: () => Promise<string | null>;
  selectGgufModel?: () => Promise<string | null>;
  minimize?: () => void;
  maximize?: () => void;
  close?: () => void;
}

declare global {
  interface Window {
    blackhole?: BlackholeWindowApi;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    require?: (id: string) => any;
  }
}
