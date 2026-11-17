import type {
  AddProviderKeyInput,
  AuthSuccessResponse,
  CreateKeyResponse,
  KeysListResponse,
  MarketplaceCatalogState,
  MeResponse,
  ModelSyncDiff,
  ProviderKeyItem,
  ProviderManifest,
  ProviderModelItem,
  ProviderSummary,
  ProvidersResponse,
  StatusResponse,
} from './types';

export class ApiError extends Error {
  public readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  headers.set('Accept', 'application/json');

  const response = await fetch(path, {
    ...init,
    headers,
    credentials: 'include',
  });

  let payload: unknown = null;
  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) {
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }
  } else {
    const text = await response.text().catch(() => '');
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = { message: text };
      }
    }
  }

  if (!response.ok) {
    const errObj = (payload && typeof payload === 'object' ? payload : {}) as Record<
      string,
      unknown
    >;
    const serverMsg =
      (typeof errObj.error === 'string' && errObj.error) ||
      (typeof errObj.message === 'string' && errObj.message) ||
      `Error HTTP ${response.status}`;
    throw new ApiError(serverMsg, response.status);
  }

  return payload as T;
}

function asRecord(val: unknown): Record<string, unknown> {
  return val && typeof val === 'object' ? (val as Record<string, unknown>) : {};
}

function normalizeProviderKey(raw: unknown): ProviderKeyItem {
  const r = asRecord(raw);
  const rawStatus = typeof r.status === 'string' ? r.status : 'active';
  const status: ProviderKeyItem['status'] =
    rawStatus === 'rate_limited' || rawStatus === 'error' || rawStatus === 'no_node'
      ? rawStatus
      : 'active';

  return {
    id: String(r.id ?? ''),
    providerId: typeof r.providerId === 'string' ? r.providerId : (r.provider_id as string | undefined),
    label: String(r.label ?? r.name ?? 'Clave sin etiqueta'),
    last4: String(r.last4 ?? '••••'),
    nodeId:
      typeof r.nodeId === 'string' && r.nodeId.length > 0
        ? r.nodeId
        : typeof r.node_id === 'string' && r.node_id.length > 0
          ? r.node_id
          : null,
    forcedNode: Boolean(r.forcedNode ?? r.forced_node ?? false),
    dailyQuotaLimit:
      typeof r.dailyQuotaLimit === 'number'
        ? r.dailyQuotaLimit
        : typeof r.daily_quota_limit === 'number'
          ? r.daily_quota_limit
          : null,
    ratelimitRemaining:
      typeof r.ratelimitRemaining === 'number'
        ? r.ratelimitRemaining
        : typeof r.ratelimit_remaining === 'number'
          ? r.ratelimit_remaining
          : null,
    ratelimitResetAt:
      typeof r.ratelimitResetAt === 'number'
        ? r.ratelimitResetAt
        : typeof r.ratelimit_reset_at === 'number'
          ? r.ratelimit_reset_at
          : null,
    status,
    lastError:
      typeof r.lastError === 'string'
        ? r.lastError
        : typeof r.last_error === 'string'
          ? r.last_error
          : null,
    createdAt:
      typeof r.createdAt === 'number'
        ? r.createdAt
        : typeof r.created_at === 'number'
          ? r.created_at
          : undefined,
  };
}

function normalizeProviderModel(raw: unknown): ProviderModelItem {
  const r = asRecord(raw);
  const providerId = String(r.providerId ?? r.provider_id ?? '');
  const modelId = String(r.modelId ?? r.model_id ?? r.id ?? '');
  const fullId = String(r.fullId ?? r.full_id ?? (providerId ? `${providerId}/${modelId}` : modelId));
  const caps = asRecord(r.capabilities);
  const mods = asRecord(r.modalities);
  const modalities =
    Array.isArray(mods.input) && Array.isArray(mods.output)
      ? {
          input: mods.input.map(String),
          output: mods.output.map(String),
        }
      : undefined;

  return {
    fullId,
    providerId,
    modelId,
    canonicalModelId:
      typeof r.canonicalModelId === 'string'
        ? r.canonicalModelId
        : typeof r.canonical_model_id === 'string'
          ? r.canonical_model_id
          : null,
    name: String(r.name ?? modelId),
    contextLength:
      typeof r.contextLength === 'number'
        ? r.contextLength
        : typeof r.context_length === 'number'
          ? r.context_length
          : null,
    maxOutput:
      typeof r.maxOutput === 'number'
        ? r.maxOutput
        : typeof r.max_output === 'number'
          ? r.max_output
          : null,
    modalities,
    capabilities: {
      tools: Boolean(caps.tools),
      reasoning: Boolean(caps.reasoning),
      structuredOutput: Boolean(caps.structuredOutput ?? caps.structured_output),
    },
    isFree: r.isFree !== undefined ? Boolean(r.isFree) : Boolean(r.is_free ?? true),
    firstSeenAt:
      typeof r.firstSeenAt === 'number'
        ? r.firstSeenAt
        : typeof r.first_seen_at === 'number'
          ? r.first_seen_at
          : undefined,
    upstreamCreatedAt:
      typeof r.upstreamCreatedAt === 'number'
        ? r.upstreamCreatedAt
        : typeof r.upstream_created_at === 'number'
          ? r.upstream_created_at
          : null,
    active: r.active !== undefined ? Boolean(r.active) : true,
  };
}

function normalizeProviderSummary(raw: unknown): ProviderSummary {
  const r = asRecord(raw);
  let manifest: ProviderManifest | undefined;
  if (r.manifest && typeof r.manifest === 'object') {
    manifest = r.manifest as ProviderManifest;
  } else if (r.schema && typeof r.schema === 'object') {
    manifest = r.schema as ProviderManifest;
  } else if (typeof r.schemaJson === 'string' || typeof r.schema_json === 'string') {
    try {
      manifest = JSON.parse(String(r.schemaJson ?? r.schema_json)) as ProviderManifest;
    } catch {
      manifest = undefined;
    }
  }

  const rawKeys = Array.isArray(r.keys) ? r.keys.map(normalizeProviderKey) : undefined;
  const rawModels = Array.isArray(r.models) ? r.models.map(normalizeProviderModel) : undefined;

  const packageType =
    (r.packageType as ProviderSummary['packageType']) ??
    (r.package_type as ProviderSummary['packageType']) ??
    manifest?.packageType ??
    'official-json';

  const modelsSource =
    (r.modelsSource as ProviderSummary['modelsSource']) ??
    (r.models_source as ProviderSummary['modelsSource']) ??
    manifest?.modelsSource ??
    'api';

  const reviewedAt =
    typeof r.reviewedAt === 'string'
      ? r.reviewedAt
      : typeof r.reviewed_at === 'string'
        ? r.reviewed_at
        : manifest?.reviewedAt ?? null;

  return {
    id: String(r.id ?? manifest?.id ?? ''),
    name: String(r.name ?? manifest?.name ?? ''),
    packageType,
    modelsSource,
    category: (r.category as ProviderSummary['category']) ?? manifest?.category,
    verified: Boolean(r.verified ?? manifest?.verified ?? false),
    baseUrl: typeof r.baseUrl === 'string' ? r.baseUrl : manifest?.baseUrl,
    adapterUrl:
      typeof r.adapterUrl === 'string'
        ? r.adapterUrl
        : typeof r.adapter_url === 'string'
          ? r.adapter_url
          : null,
    enabled: r.enabled !== undefined ? Boolean(r.enabled) : true,
    reviewedAt,
    lastModelsSyncAt:
      typeof r.lastModelsSyncAt === 'number'
        ? r.lastModelsSyncAt
        : typeof r.last_models_sync_at === 'number'
          ? r.last_models_sync_at
          : null,
    createdAt:
      typeof r.createdAt === 'number'
        ? r.createdAt
        : typeof r.created_at === 'number'
          ? r.created_at
          : undefined,
    manifest,
    keys: rawKeys,
    models: rawModels,
    keysCount:
      typeof r.keysCount === 'number'
        ? r.keysCount
        : typeof r.keys_count === 'number'
          ? r.keys_count
          : rawKeys?.length,
    modelsCount:
      typeof r.modelsCount === 'number'
        ? r.modelsCount
        : typeof r.models_count === 'number'
          ? r.models_count
          : rawModels?.length,
  };
}

function countDiffEntry(val: unknown): number | null {
  if (typeof val === 'number' && Number.isFinite(val)) return val;
  if (Array.isArray(val)) return val.length;
  return null;
}

function parseModelSyncDiff(raw: unknown, previousCount?: number): ModelSyncDiff {
  const r = asRecord(raw);
  const diffObj = asRecord(r.diff);

  const models = Array.isArray(r.models) ? r.models.map(normalizeProviderModel) : undefined;
  const totalModels =
    typeof r.total === 'number'
      ? r.total
      : typeof r.totalActive === 'number'
        ? r.totalActive
        : typeof r.modelsCount === 'number'
          ? r.modelsCount
          : models
            ? models.length
            : previousCount ?? 0;

  const addedCount =
    countDiffEntry(r.added) ??
    countDiffEntry(r.addedCount) ??
    countDiffEntry(r.newModels) ??
    countDiffEntry(r.newCount) ??
    countDiffEntry(diffObj.added) ??
    countDiffEntry(diffObj.addedCount) ??
    (previousCount !== undefined && models ? Math.max(0, models.length - previousCount) : 0);

  const retiredCount =
    countDiffEntry(r.retired) ??
    countDiffEntry(r.removed) ??
    countDiffEntry(r.retiredCount) ??
    countDiffEntry(r.removedCount) ??
    countDiffEntry(r.retiredModels) ??
    countDiffEntry(diffObj.retired) ??
    countDiffEntry(diffObj.removed) ??
    (previousCount !== undefined && models ? Math.max(0, previousCount - models.length) : 0);

  return {
    addedCount,
    retiredCount,
    totalModels,
    summary: typeof r.summary === 'string' && r.summary.trim().length > 0 ? r.summary : undefined,
    models,
    syncedAt: typeof r.syncedAt === 'number' ? r.syncedAt : Math.floor(Date.now() / 1000),
  };
}

export const api = {
  getStatus(): Promise<StatusResponse> {
    return request<StatusResponse>('/api/status', { method: 'GET' });
  },

  setupAdmin(username: string, password: string): Promise<AuthSuccessResponse> {
    return request<AuthSuccessResponse>('/api/setup', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    });
  },

  login(username: string, password: string): Promise<AuthSuccessResponse> {
    return request<AuthSuccessResponse>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    });
  },

  logout(): Promise<{ ok: boolean }> {
    return request<{ ok: boolean }>('/api/auth/logout', {
      method: 'POST',
    });
  },

  getMe(): Promise<MeResponse> {
    return request<MeResponse>('/api/auth/me', { method: 'GET' });
  },

  /* Providers & Marketplace (Phase 2: HU-06, HU-06b, HU-06c, HU-07, HU-09, HU-10) */

  async getMarketplace(): Promise<MarketplaceCatalogState> {
    try {
      const raw = await request<unknown>('/api/marketplace', { method: 'GET' });
      const r = asRecord(raw);
      const list = Array.isArray(raw)
        ? raw
        : Array.isArray(r.manifests)
          ? r.manifests
          : Array.isArray(r.providers)
            ? r.providers
            : Array.isArray(r.items)
              ? r.items
              : Array.isArray(r.catalog)
                ? r.catalog
                : [];
      const offline = Boolean(r.offline ?? r.unreachable ?? false);
      const notice =
        typeof r.notice === 'string'
          ? r.notice
          : typeof r.warning === 'string'
            ? r.warning
            : typeof r.error === 'string'
              ? r.error
              : undefined;

      return {
        manifests: list as ProviderManifest[],
        offline,
        notice,
      };
    } catch (err) {
      // HU-06: Handle offline or unreachable marketplace gracefully without crashing
      if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
        throw err;
      }
      return {
        manifests: [],
        offline: true,
        notice:
          err instanceof Error
            ? err.message
            : 'No se pudo consultar el catálogo remoto bifrost-providers.',
      };
    }
  },

  async installFromMarketplace(
    manifest: ProviderManifest,
    adapterUrl?: string
  ): Promise<ProviderSummary> {
    const body: Record<string, unknown> = {
      id: manifest.id,
      providerId: manifest.id,
      manifest,
    };
    if (adapterUrl && adapterUrl.trim().length > 0) {
      body.adapterUrl = adapterUrl.trim();
    }
    const raw = await request<unknown>('/api/marketplace/install', {
      method: 'POST',
      body: JSON.stringify(body),
    });
    const r = asRecord(raw);
    return normalizeProviderSummary(r.provider ?? raw);
  },

  async installLocalManifest(
    manifest: ProviderManifest,
    adapterUrl?: string
  ): Promise<ProviderSummary> {
    const payload: Record<string, unknown> = { manifest };
    if (adapterUrl && adapterUrl.trim().length > 0) {
      payload.adapterUrl = adapterUrl.trim();
    }
    const raw = await request<unknown>('/api/providers', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    const r = asRecord(raw);
    return normalizeProviderSummary(r.provider ?? raw);
  },

  async getProviders(): Promise<ProvidersResponse> {
    const raw = await request<unknown>('/api/providers', { method: 'GET' });
    const r = asRecord(raw);
    const list = Array.isArray(r.providers) ? r.providers : Array.isArray(raw) ? raw : [];
    return {
      providers: list.map(normalizeProviderSummary),
    };
  },

  async getProviderKeys(providerId: string): Promise<ProviderKeyItem[]> {
    const raw = await request<unknown>(
      `/api/providers/${encodeURIComponent(providerId)}/keys`,
      { method: 'GET' }
    );
    const r = asRecord(raw);
    const list = Array.isArray(r.keys) ? r.keys : Array.isArray(raw) ? raw : [];
    return list.map(normalizeProviderKey);
  },

  async addProviderKey(
    providerId: string,
    input: AddProviderKeyInput
  ): Promise<ProviderKeyItem> {
    const payload: Record<string, unknown> = {
      label: input.label.trim(),
      secret: input.secret,
    };
    if (typeof input.dailyQuotaLimit === 'number' && input.dailyQuotaLimit > 0) {
      payload.dailyQuotaLimit = input.dailyQuotaLimit;
    }
    if (input.nodeId) {
      payload.nodeId = input.nodeId;
    }
    const raw = await request<unknown>(
      `/api/providers/${encodeURIComponent(providerId)}/keys`,
      {
        method: 'POST',
        body: JSON.stringify(payload),
      }
    );
    const r = asRecord(raw);
    return normalizeProviderKey(r.key ?? raw);
  },

  deleteProviderKey(providerId: string, keyId: string): Promise<{ ok: boolean }> {
    return request<{ ok: boolean }>(
      `/api/providers/${encodeURIComponent(providerId)}/keys/${encodeURIComponent(keyId)}`,
      { method: 'DELETE' }
    );
  },

  deleteProvider(providerId: string): Promise<{ ok: boolean }> {
    return request<{ ok: boolean }>(`/api/providers/${encodeURIComponent(providerId)}`, {
      method: 'DELETE',
    });
  },

  async detectProviderModels(
    providerId: string,
    previousCount?: number
  ): Promise<ModelSyncDiff> {
    const raw = await request<unknown>(
      `/api/providers/${encodeURIComponent(providerId)}/detect-models`,
      { method: 'POST' }
    );
    return parseModelSyncDiff(raw, previousCount);
  },

  async reloadProviderModels(
    providerId: string,
    previousCount?: number
  ): Promise<ModelSyncDiff> {
    const raw = await request<unknown>(
      `/api/providers/${encodeURIComponent(providerId)}/reload-models`,
      { method: 'POST' }
    );
    return parseModelSyncDiff(raw, previousCount);
  },

  async getModels(): Promise<ProviderModelItem[]> {
    const raw = await request<unknown>('/api/models', { method: 'GET' });
    const r = asRecord(raw);
    const list = Array.isArray(r.models) ? r.models : Array.isArray(raw) ? raw : [];
    return list.map(normalizeProviderModel);
  },

  /* Internal API Keys (Phase 1: HU-03b) */

  getKeys(): Promise<KeysListResponse> {
    return request<KeysListResponse>('/api/keys', { method: 'GET' });
  },

  createKey(name: string): Promise<CreateKeyResponse> {
    return request<CreateKeyResponse>('/api/keys', {
      method: 'POST',
      body: JSON.stringify({ name }),
    });
  },

  revokeKey(id: string): Promise<{ ok: boolean }> {
    return request<{ ok: boolean }>(`/api/keys/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
  },
};
