export type UserRole = 'admin' | 'guest' | string;
export type QuotaResetMode = 'utc_midnight' | 'rolling_24h';

export interface AuthUser {
  id: string;
  username: string;
  role: UserRole;
  dailyTokenLimit?: number | null;
  quotaResetMode?: QuotaResetMode | string;
  allowedModels?: string[];
  createdAt?: number;
}

export interface DashboardStats {
  providersCount: number;
  modelsCount: number;
  keysCount: number;
}

export interface StatusResponse {
  initialized: boolean;
}

export interface AuthSuccessResponse {
  user: AuthUser;
}

export interface MeResponse {
  user: AuthUser;
  stats: DashboardStats;
}

/* Phase 4 — Models Catalog, Monochrome Logos & 4-Source Public Benchmarks (HU-14, HU-14b, HU-14c, HU-15, HU-16) */

export interface ProviderLogoData {
  hasLogo: boolean;
  svg: string | null;
}

export type BenchmarkSourceKey = 'lmarena' | 'artificialwatch' | 'epoch' | 'opencharts';

export interface LmArenaPeerEntry {
  modelId: string;
  fullId?: string | null;
  displayName: string;
  score: number;
  ciLower?: number | null;
  ciUpper?: number | null;
  rank: number;
  isCurrent?: boolean;
}

export interface LmArenaBenchmarkBlock {
  available: boolean;
  score: number | null;
  ciLower: number | null;
  ciUpper: number | null;
  ciPlusMinus?: number | null;
  sessionsOrVotes: number | null;
  category: string;
  medianCostPerTaskUsd: number | null;
  rank: number | null;
  totalRanked: number | null;
  rankingPeers: LmArenaPeerEntry[];
  sourceUrl: string;
  license: string;
  capturedAt: string | null;
}

export interface ArtificialWatchAxis {
  axisKey: string;
  label: string;
  percentile: number; // 0..100 percentile (NEVER accuracy %)
  index?: number | null;
  sourceBoard: string;
}

export interface ArtificialWatchBenchmarkBlock {
  available: boolean;
  globalIndex: number | null;
  medianPercentile: number | null;
  axes: ArtificialWatchAxis[];
  rankingPeers?: Array<{
    modelId: string;
    fullId?: string | null;
    displayName: string;
    percentile: number;
    index?: number | null;
    rank: number;
    isCurrent?: boolean;
  }>;
  sourceUrl: string;
  license: string;
  capturedAt: string | null;
}

export interface EpochBenchmarkRun {
  benchmarkId: string;
  benchmarkName: string;
  score: number;
  unit?: string;
  stderr: number | null;
  evaluatedAt: string | null;
  harness: string;
  trainingFlop?: string | null;
  tokensUsed?: number | null;
}

export interface EpochBenchmarkBlock {
  available: boolean;
  runs: EpochBenchmarkRun[];
  sourceUrl: string;
  license: string;
  capturedAt: string | null;
}

export interface OpenChartsBenchmarkBlock {
  available: boolean;
  compositeIndex: number | null;
  grade: string | null;
  rankRange: string | null;
  rankingPeers?: Array<{
    modelId: string;
    fullId?: string | null;
    displayName: string;
    compositeIndex: number;
    grade?: string | null;
    rankRange?: string | null;
    isCurrent?: boolean;
  }>;
  methodologyUrl: string;
  sourceUrl: string;
  capturedAt: string | null;
}

export interface ModelBenchmarksData {
  fullId: string;
  canonicalModelId?: string | null;
  lmarena: LmArenaBenchmarkBlock;
  artificialwatch: ArtificialWatchBenchmarkBlock;
  epoch: EpochBenchmarkBlock;
  opencharts: OpenChartsBenchmarkBlock;
}

/* Phase 6 — Comparator (HU-21) & Playground (HU-22) */

export type ReasoningEffort = 'none' | 'low' | 'medium' | 'high';

export interface PlaygroundChatTurn {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  reasoningContent?: string;
  model?: string;
  ttftMs?: number | null;
  tokensPerSec?: number | null;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    reasoningTokens: number;
    totalTokens: number;
  };
  createdAt: number;
}

export interface PlaygroundChatRequest {
  model: string;
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
  temperature?: number;
  maxTokens?: number;
  reasoningEffort?: ReasoningEffort;
}

export interface PlaygroundChatResponse {
  content: string;
  reasoningContent?: string;
  model?: string;
  ttftMs: number | null;
  tokensPerSec: number | null;
  usage: {
    promptTokens: number;
    completionTokens: number;
    reasoningTokens: number;
    totalTokens: number;
  };
}

/* Phase 8 — Users, Invitations (HU-04, HU-05) & Encrypted Backups (HU-25, HU-25b) */

export interface ManagedUserItem {
  id: string;
  username: string;
  role: 'admin' | 'guest' | string;
  dailyTokenLimit: number | null;
  quotaResetMode: QuotaResetMode;
  allowedModels: string[];
  usedTokensToday?: number;
  createdAt?: number;
}

export interface InvitationItem {
  id: string;
  dailyTokenLimit: number;
  quotaResetMode?: QuotaResetMode;
  allowedModels: string[];
  expiresAt: number;
  usedAt: number | null;
  createdAt?: number;
}

export interface CreateInvitationInput {
  dailyTokenLimit: number;
  quotaResetMode: QuotaResetMode;
  allowedModels: string[];
  expiresInHours?: number;
}

export interface CreateInvitationResult {
  invitation?: InvitationItem;
  token: string;
  inviteUrl: string;
  expiresAt?: number;
}

export interface BackupExportOptions {
  password: string;
  includeProvidersAndConfig: boolean;
  includeProviderKeys: boolean;
  includeUsersAndQuotas: boolean;
  includeNodes: boolean;
}

export interface BackupImportResult {
  ok: boolean;
  message?: string;
  restored?: {
    providers?: number;
    providerKeys?: number;
    users?: number;
    nodes?: number;
  };
}

/* Phase 5 — Quota Hero, Percentile Telemetry, 60d Uptime, Activity & System Logs */

export interface MetricsSummary {
  quotaPercentageRemaining: number | null;
  usedTokensToday: number;
  totalDailyLimit: number | null;
  nextResetAt: string | number | null;
  resetMode: 'utc_midnight' | 'rolling_24h' | string;
  providersCount: number;
  activeModelsCount: number;
  onlineNodesCount: number;
}

export interface PercentileTuple {
  p50: number;
  p75: number;
  p90: number;
  p95: number;
  p99: number;
}

export interface LatencyBucketPoint extends PercentileTuple {
  timestamp: string | number;
  label?: string;
  count?: number;
}

export interface LatencyMetricsData {
  buckets: LatencyBucketPoint[];
  overall?: PercentileTuple | null;
}

export interface ModelSpeedEntry {
  id: string;
  modelFullId: string;
  providerId: string;
  sampleCount: number;
  ttftMs: PercentileTuple;
  tokensPerSec: PercentileTuple;
}

export interface ProviderCacheEntry {
  providerId: string;
  providerName: string;
  cacheHitRate: number;
  cachedTokens: number;
  promptTokens: number;
}

export interface SpeedMetricsData {
  models: ModelSpeedEntry[];
  cacheByProvider: ProviderCacheEntry[];
}

export interface UptimeDayCell {
  date: string;
  uptimePct: number | null;
  totalRequests: number;
  errorRequests?: number;
}

export interface ProviderReliabilityEntry {
  providerId: string;
  providerName: string;
  overallUptimePct: number | null;
  days: UptimeDayCell[];
  toolErrorRate7d: number;
  structuredErrorRate7d: number;
  totalRequests7d?: number;
}

export type ActivityRange = 'today' | '7d' | '30d';
export type ActivityGroupBy = 'model' | 'provider' | 'user';

export interface ActivitySeriesItem {
  key: string;
  label: string;
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  requestsCount?: number;
}

export interface ActivityMetricsData {
  range: ActivityRange;
  groupBy: ActivityGroupBy;
  totals: {
    promptTokens: number;
    completionTokens: number;
    reasoningTokens: number;
    totalTokens: number;
  };
  items: ActivitySeriesItem[];
}

export type SystemLogLevel = 'info' | 'warn' | 'error';
export type SystemLogCategory =
  | 'failover'
  | 'stream_resume'
  | 'node'
  | 'sync'
  | 'auth'
  | 'backup'
  | 'system';

export interface SystemLogEntry {
  id: number | string;
  level: SystemLogLevel;
  category: SystemLogCategory | string;
  message: string;
  meta?: Record<string, unknown> | null;
  createdAt: number | string;
}

export interface SystemLogsResponse {
  logs: SystemLogEntry[];
  total: number;
}

/* Phase 3 — Exit Nodes */

export type NodeMode = 'tailscale' | 'public_ip';
export type NodeStatus = 'online' | 'unresponsive' | 'offline';

export interface NodeAssignedKeyRef {
  id: string;
  providerId: string;
  providerName: string;
  label: string;
  last4: string;
}

export interface ExitNodeItem {
  id: string;
  name: string;
  mode: NodeMode;
  endpoint: string;
  status: NodeStatus;
  lastSeenAt: number | null;
  lastRotatedAt: number | null;
  createdAt?: number;
  assignedKeysCount?: number;
  assignedKeys?: NodeAssignedKeyRef[];
}

export interface CreateNodeInput {
  name: string;
  mode: NodeMode;
  endpoint: string;
}

export interface CreateNodeResult {
  node: ExitNodeItem;
  rawToken: string;
  installCommand: string;
}

export interface RotateNodeTokenResult {
  ok: boolean;
  lastRotatedAt: number;
  graceSeconds?: number;
  rawToken?: string;
}

/* Phase 2 & Phase 7 — Marketplace & Provider Schemas (HU-06, HU-23) */

export type ProviderPackageType = 'official-json' | 'experimental-adapter';
export type ProviderModelsSource = 'api' | 'static';
export type ProviderCategory = 'aggregator' | 'official-api' | 'experimental-adapter';
export type ProviderKeyStatus = 'active' | 'rate_limited' | 'error' | 'no_node';

export interface ProviderStaticModelDef {
  id: string;
  name: string;
  canonicalModelId?: string;
  contextLength?: number;
  maxOutput?: number;
}

export interface ProviderManifest {
  schemaVersion?: string;
  id: string;
  name: string;
  description?: string;
  category?: ProviderCategory;
  packageType: ProviderPackageType;
  verified?: boolean;
  approved?: boolean;
  publishedAt?: string;
  baseUrl: string;
  auth: {
    type: 'bearer' | 'header' | 'none';
    header: string;
    prefix?: string;
    extraHeaders?: Record<string, string>;
  };
  modelsSource: ProviderModelsSource;
  modelsEndpoint?: string;
  freeRule?: {
    priceZeroPaths?: string[];
    requiredEndpoint?: string;
    idSuffix?: string;
  };
  staticModels?: ProviderStaticModelDef[];
  reviewedAt?: string;
  adapter?: {
    defaultPort: number;
    healthPath?: string;
    accountLabel?: string;
  };
}

export interface MarketplaceCatalogState {
  manifests: ProviderManifest[];
  offline: boolean;
  notice?: string;
}

export interface ProviderKeyItem {
  id: string;
  providerId?: string;
  label: string;
  last4: string;
  nodeId: string | null;
  forcedNode?: boolean;
  dailyQuotaLimit?: number | null;
  ratelimitRemaining?: number | null;
  ratelimitResetAt?: number | null;
  status: ProviderKeyStatus;
  lastError?: string | null;
  createdAt?: number;
}

export interface ProviderModelItem {
  fullId: string;
  providerId: string;
  providerName?: string;
  logoSlug?: string;
  modelId: string;
  canonicalModelId?: string | null;
  name: string;
  family?: string | null;
  contextLength?: number | null;
  maxOutput?: number | null;
  modalities?: {
    input: string[];
    output: string[];
  };
  capabilities?: {
    tools: boolean;
    reasoning: boolean;
    structuredOutput: boolean;
  };
  pricing?: {
    prompt?: number;
    completion?: number;
    referencePromptPer1M?: number | null;
    referenceCompletionPer1M?: number | null;
  } | null;
  releaseDate?: string | null;
  upstreamCreatedAt?: number | null;
  isFree?: boolean;
  firstSeenAt?: number;
  active?: boolean;
}

export interface ProviderSummary {
  id: string;
  name: string;
  packageType?: ProviderPackageType;
  modelsSource?: ProviderModelsSource;
  category?: ProviderCategory;
  verified?: boolean;
  publishedAt?: string | null;
  baseUrl?: string;
  adapterUrl?: string | null;
  enabled?: boolean;
  reviewedAt?: string | null;
  lastModelsSyncAt?: number | null;
  createdAt?: number;
  manifest?: ProviderManifest;
  keys?: ProviderKeyItem[];
  models?: ProviderModelItem[];
  keysCount?: number;
  modelsCount?: number;
}

export interface ProvidersResponse {
  providers: ProviderSummary[];
}

export interface AddProviderKeyInput {
  label: string;
  secret: string;
  dailyQuotaLimit?: number;
  nodeId?: string | null;
}

export interface ModelSyncDiff {
  addedCount: number;
  retiredCount: number;
  totalModels: number;
  models?: ProviderModelItem[];
  syncedAt?: number;
}

/* Phase 1 — Internal API Keys (HU-03b) */

export interface InternalApiKey {
  id: string;
  name: string;
  keyPrefix: string;
  createdAt: number;
  lastUsedAt: number | null;
}

export interface KeysListResponse {
  keys: InternalApiKey[];
}

export interface CreateKeyResponse {
  key: InternalApiKey;
  rawKey: string;
}

export type ActiveTab =
  | 'overview'
  | 'models'
  | 'compare'
  | 'playground'
  | 'metrics'
  | 'keys'
  | 'providers'
  | 'nodes'
  | 'users'
  | 'logs'
  | 'backups';
