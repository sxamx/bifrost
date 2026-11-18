export type UserRole = 'admin' | 'guest' | string;

export interface AuthUser {
  id: string;
  username: string;
  role: UserRole;
  dailyTokenLimit?: number | null;
  quotaResetMode?: string;
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

/* Phase 3 — Exit Nodes (HU-11, HU-11b, HU-11c, HU-11d, HU-08, HU-12, HU-13) */

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

/* Phase 2 — Marketplace & Provider Schemas (HU-06, HU-06b, HU-06c, HU-07, HU-09, HU-10) */

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
  modelId: string;
  canonicalModelId?: string | null;
  name: string;
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

export type ActiveTab = 'overview' | 'keys' | 'providers' | 'nodes';
