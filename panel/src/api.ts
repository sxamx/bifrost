import type {
  ActivityGroupBy,
  ActivityMetricsData,
  ActivityRange,
  ActivitySeriesItem,
  AddProviderKeyInput,
  ArtificialWatchAxis,
  ArtificialWatchBenchmarkBlock,
  AuthSuccessResponse,
  BackupExportOptions,
  BackupImportResult,
  CreateInvitationInput,
  CreateInvitationResult,
  CreateKeyResponse,
  CreateNodeInput,
  CreateNodeResult,
  EpochBenchmarkBlock,
  EpochBenchmarkRun,
  ExitNodeItem,
  ExitNodeTestResult,
  FreeQuotaStatus,
  InvitationItem,
  KeysListResponse,
  LatencyBucketPoint,
  LatencyMetricsData,
  LmArenaBenchmarkBlock,
  LmArenaPeerEntry,
  ManagedUserItem,
  MarketplaceCatalogState,
  MeResponse,
  MetricsSummary,
  ModelBenchmarksData,
  ModelSpeedEntry,
  ModelSyncDiff,
  NodeAssignedKeyRef,
  OpenChartsBenchmarkBlock,
  PercentileTuple,
  PlaygroundChatRequest,
  PlaygroundChatResponse,
  ProviderAdaptiveQuota,
  ProviderCacheEntry,
  ProviderKeyItem,
  ProviderKeyTestResult,
  ProviderLogoData,
  ProviderManifest,
  ProviderModelItem,
  ProviderPrivacyConfig,
  ProviderRateLimitKind,
  ProviderRateLimitWindow,
  ProviderReliabilityEntry,
  ProviderSummary,
  ProvidersResponse,
  QuotaConfidence,
  QuotaResetMode,
  QuotaUnit,
  RotateNodeTokenResult,
  SpeedMetricsData,
  StatusResponse,
  SystemLogEntry,
  SystemLogsResponse,
  SystemUpdateStatus,
  UptimeDayCell,
} from './types';

export class ApiError extends Error {
  public readonly status: number;
  public readonly data: Record<string, unknown>;

  constructor(message: string, status: number, data: Record<string, unknown> = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.data = data;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  const isFormData = typeof FormData !== 'undefined' && init?.body instanceof FormData;
  if (init?.body && !isFormData && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  if (!headers.has('Accept')) {
    headers.set('Accept', 'application/json');
  }

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
    throw new ApiError(serverMsg, response.status, errObj);
  }

  return payload as T;
}

function asRecord(val: unknown): Record<string, unknown> {
  return val && typeof val === 'object' ? (val as Record<string, unknown>) : {};
}

function asNum(val: unknown, fallback = 0): number {
  return typeof val === 'number' && Number.isFinite(val) ? val : fallback;
}

function asNullableNum(val: unknown): number | null {
  return typeof val === 'number' && Number.isFinite(val) ? val : null;
}

function asStringArray(val: unknown): string[] {
  if (Array.isArray(val)) return val.map(String);
  if (typeof val === 'string' && val.trim().startsWith('[')) {
    try {
      const parsed = JSON.parse(val);
      if (Array.isArray(parsed)) return parsed.map(String);
    } catch {
      return [];
    }
  }
  return [];
}

function normalizePercentiles(raw: unknown): PercentileTuple {
  const r = asRecord(raw);
  return {
    p50: asNum(r.p50 ?? r.P50),
    p75: asNum(r.p75 ?? r.P75),
    p90: asNum(r.p90 ?? r.P90),
    p95: asNum(r.p95 ?? r.P95),
    p99: asNum(r.p99 ?? r.P99),
  };
}

function normalizeRatePct(val: unknown): number {
  if (typeof val !== 'number' || !Number.isFinite(val)) return 0;
  return Math.max(0, Math.min(100, val));
}

function build60DayWindow(rawDays: UptimeDayCell[]): UptimeDayCell[] {
  const byDate = new Map<string, UptimeDayCell>();
  for (const d of rawDays) {
    if (d.date) {
      byDate.set(d.date.slice(0, 10), d);
    }
  }

  const result: UptimeDayCell[] = [];
  const now = new Date();
  const todayUtcMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());

  for (let offset = 59; offset >= 0; offset--) {
    const dayDate = new Date(todayUtcMs - offset * 86_400_000);
    const isoDate = dayDate.toISOString().slice(0, 10);
    const found = byDate.get(isoDate);
    if (found) {
      result.push(found);
    } else {
      result.push({
        date: isoDate,
        uptimePct: null,
        totalRequests: 0,
      });
    }
  }
  return result;
}

/* Monochrome SVG Logo Sanitizer + In-Memory Cache (HU-14b) */
const logoCache = new Map<string, ProviderLogoData>();

function sanitizeMonochromeSvg(rawSvg: string): string | null {
  const trimmed = rawSvg.trim();
  if (!trimmed.includes('<svg')) return null;

  // Strip scripts, foreignObject, and inline event handlers
  let clean = trimmed
    .replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, '')
    .replace(/<foreignObject[\s\S]*?>[\s\S]*?<\/foreignObject>/gi, '')
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '');

  // Normalize hardcoded black/brand colors to currentColor so CSS `color: var(--sub)` controls it
  clean = clean
    .replace(/fill\s*=\s*["'](?!none["']|currentColor["'])[^"']+["']/gi, 'fill="currentColor"')
    .replace(
      /stroke\s*=\s*["'](?!none["']|currentColor["'])[^"']+["']/gi,
      'stroke="currentColor"'
    );

  // Ensure root <svg> defaults to fill="currentColor" if neither fill nor stroke is set
  if (!/fill\s*=/i.test(clean)) {
    clean = clean.replace(/<svg\b/i, '<svg fill="currentColor"');
  }
  return clean;
}

function normalizeModelBenchmarks(fullId: string, raw: unknown): ModelBenchmarksData {
  const r = asRecord(raw);
  const sources = asRecord(r.sources ?? r);

  // 1. LMArena (agent/latest, CC BY 4.0)
  const lmaRaw = asRecord(sources.lmarena ?? sources.lmArena ?? r.lmarena);
  const lmaPeersRaw = Array.isArray(lmaRaw.rankingPeers)
    ? lmaRaw.rankingPeers
    : Array.isArray(lmaRaw.peers)
      ? lmaRaw.peers
      : Array.isArray(lmaRaw.ranking)
        ? lmaRaw.ranking
        : [];
  const lmaPeers: LmArenaPeerEntry[] = lmaPeersRaw.map((p, idx) => {
    const pr = asRecord(p);
    return {
      modelId: String(pr.modelId ?? pr.model_id ?? pr.id ?? `peer-${idx}`),
      fullId: typeof pr.fullId === 'string' ? pr.fullId : (pr.full_id as string | null) ?? null,
      displayName: String(pr.displayName ?? pr.name ?? pr.modelId ?? pr.id ?? `Modelo #${idx + 1}`),
      score: asNum(pr.score ?? pr.agentScore),
      ciLower: asNullableNum(pr.ciLower ?? pr.ci_lower),
      ciUpper: asNullableNum(pr.ciUpper ?? pr.ci_upper),
      rank: asNum(pr.rank, idx + 1),
      isCurrent: Boolean(pr.isCurrent ?? pr.is_current ?? false),
    };
  });
  const lmaScore = asNullableNum(lmaRaw.score ?? lmaRaw.agentScore ?? lmaRaw.nativeScore);
  const lmarena: LmArenaBenchmarkBlock = {
    available: Boolean(lmaRaw.available ?? (lmaScore !== null || lmaPeers.length > 0)),
    score: lmaScore,
    ciLower: asNullableNum(lmaRaw.ciLower ?? lmaRaw.ci_lower),
    ciUpper: asNullableNum(lmaRaw.ciUpper ?? lmaRaw.ci_upper),
    ciPlusMinus: asNullableNum(lmaRaw.ciPlusMinus ?? lmaRaw.ci_margin ?? lmaRaw.ci),
    sessionsOrVotes: asNullableNum(lmaRaw.sessionsOrVotes ?? lmaRaw.votes ?? lmaRaw.sessions),
    category: String(lmaRaw.category ?? 'agent/latest'),
    medianCostPerTaskUsd: asNullableNum(
      lmaRaw.medianCostPerTaskUsd ?? lmaRaw.medianCost ?? lmaRaw.costPerTask
    ),
    rank: asNullableNum(lmaRaw.rank),
    totalRanked: asNullableNum(lmaRaw.totalRanked ?? lmaRaw.totalModels ?? lmaRaw.total),
    rankingPeers: lmaPeers,
    sourceUrl: String(lmaRaw.sourceUrl ?? 'https://lmarena.ai'),
    license: String(lmaRaw.license ?? 'CC BY 4.0'),
    capturedAt: typeof lmaRaw.capturedAt === 'string' ? lmaRaw.capturedAt : null,
  };

  // 2. ArtificialWatch (index & percentile only, CC BY 4.0)
  const awRaw = asRecord(
    sources.artificialwatch ?? sources.artificialWatch ?? r.artificialwatch
  );
  const awAxesRaw = Array.isArray(awRaw.axes)
    ? awRaw.axes
    : Array.isArray(awRaw.dimensions)
      ? awRaw.dimensions
      : Array.isArray(awRaw.boards)
        ? awRaw.boards
        : [];
  const awAxes: ArtificialWatchAxis[] = awAxesRaw.map((ax, idx) => {
    const ar = asRecord(ax);
    return {
      axisKey: String(ar.axisKey ?? ar.key ?? ar.id ?? `axis-${idx}`),
      label: String(ar.label ?? ar.name ?? `Eje ${idx + 1}`),
      percentile: Math.max(0, Math.min(100, asNum(ar.percentile))),
      index: asNullableNum(ar.index),
      sourceBoard: String(ar.sourceBoard ?? ar.board ?? ar.source ?? 'Tablero público'),
    };
  });
  const awIndex = asNullableNum(awRaw.globalIndex ?? awRaw.index);
  const awMedianPct = asNullableNum(awRaw.medianPercentile ?? awRaw.percentile);
  const artificialwatch: ArtificialWatchBenchmarkBlock = {
    available: Boolean(
      awRaw.available ?? (awIndex !== null || awMedianPct !== null || awAxes.length > 0)
    ),
    globalIndex: awIndex,
    medianPercentile: awMedianPct,
    axes: awAxes,
    rankingPeers: Array.isArray(awRaw.rankingPeers)
      ? awRaw.rankingPeers.map((p, idx) => {
          const pr = asRecord(p);
          return {
            modelId: String(pr.modelId ?? pr.id ?? `aw-${idx}`),
            fullId: typeof pr.fullId === 'string' ? pr.fullId : null,
            displayName: String(pr.displayName ?? pr.name ?? pr.modelId ?? `Modelo #${idx + 1}`),
            percentile: asNum(pr.percentile),
            index: asNullableNum(pr.index),
            rank: asNum(pr.rank, idx + 1),
            isCurrent: Boolean(pr.isCurrent),
          };
        })
      : undefined,
    sourceUrl: String(awRaw.sourceUrl ?? 'https://artificialwatch.com'),
    license: String(awRaw.license ?? 'CC BY 4.0'),
    capturedAt: typeof awRaw.capturedAt === 'string' ? awRaw.capturedAt : null,
  };

  // 3. Epoch AI (own internal runs only, CC BY 4.0)
  const epRaw = asRecord(sources.epoch ?? sources.epochAi ?? r.epoch);
  const epRunsRaw = Array.isArray(epRaw.runs)
    ? epRaw.runs
    : Array.isArray(epRaw.benchmarks)
      ? epRaw.benchmarks
      : [];
  const epRuns: EpochBenchmarkRun[] = epRunsRaw.map((run, idx) => {
    const rr = asRecord(run);
    return {
      benchmarkId: String(rr.benchmarkId ?? rr.id ?? `epoch-run-${idx}`),
      benchmarkName: String(rr.benchmarkName ?? rr.name ?? rr.task ?? `Evaluación #${idx + 1}`),
      score: asNum(rr.score),
      unit: typeof rr.unit === 'string' ? rr.unit : undefined,
      stderr: asNullableNum(rr.stderr ?? rr.stdErr ?? rr.standardError),
      evaluatedAt:
        typeof rr.evaluatedAt === 'string'
          ? rr.evaluatedAt
          : typeof rr.date === 'string'
            ? rr.date
            : null,
      harness: String(rr.harness ?? 'Inspect (Epoch AI internal run)'),
      trainingFlop: typeof rr.trainingFlop === 'string' ? rr.trainingFlop : null,
      tokensUsed: asNullableNum(rr.tokensUsed ?? rr.tokens),
    };
  });
  const epoch: EpochBenchmarkBlock = {
    available: Boolean(epRaw.available ?? epRuns.length > 0),
    runs: epRuns,
    sourceUrl: String(epRaw.sourceUrl ?? 'https://epoch.ai/data/ai-benchmarking-dashboard'),
    license: String(epRaw.license ?? 'CC BY 4.0'),
    capturedAt: typeof epRaw.capturedAt === 'string' ? epRaw.capturedAt : null,
  };

  // 4. OpenCharts (composite index, grade, rankRange + link)
  const ocRaw = asRecord(sources.opencharts ?? sources.openCharts ?? r.opencharts);
  const ocIndex = asNullableNum(ocRaw.compositeIndex ?? ocRaw.index ?? ocRaw.score);
  const ocGrade = typeof ocRaw.grade === 'string' ? ocRaw.grade : null;
  const ocRankRange =
    typeof ocRaw.rankRange === 'string'
      ? ocRaw.rankRange
      : typeof ocRaw.rank_range === 'string'
        ? ocRaw.rank_range
        : null;
  const opencharts: OpenChartsBenchmarkBlock = {
    available: Boolean(
      ocRaw.available ?? (ocIndex !== null || ocGrade !== null || ocRankRange !== null)
    ),
    compositeIndex: ocIndex,
    grade: ocGrade,
    rankRange: ocRankRange,
    rankingPeers: Array.isArray(ocRaw.rankingPeers)
      ? ocRaw.rankingPeers.map((p, idx) => {
          const pr = asRecord(p);
          return {
            modelId: String(pr.modelId ?? pr.id ?? `oc-${idx}`),
            fullId: typeof pr.fullId === 'string' ? pr.fullId : null,
            displayName: String(pr.displayName ?? pr.name ?? pr.modelId ?? `Modelo #${idx + 1}`),
            compositeIndex: asNum(pr.compositeIndex ?? pr.index ?? pr.score),
            grade: typeof pr.grade === 'string' ? pr.grade : null,
            rankRange: typeof pr.rankRange === 'string' ? pr.rankRange : null,
            isCurrent: Boolean(pr.isCurrent),
          };
        })
      : undefined,
    methodologyUrl: String(
      ocRaw.methodologyUrl ?? 'https://www.opencharts.com/benchmarks/methodology'
    ),
    sourceUrl: String(ocRaw.sourceUrl ?? 'https://www.opencharts.com'),
    capturedAt: typeof ocRaw.capturedAt === 'string' ? ocRaw.capturedAt : null,
  };

  return {
    fullId,
    canonicalModelId:
      typeof r.canonicalModelId === 'string' ? r.canonicalModelId : null,
    lmarena,
    artificialwatch,
    epoch,
    opencharts,
  };
}

function normalizeManagedUser(raw: unknown): ManagedUserItem {
  const r = asRecord(raw);
  const rawLimit = r.dailyTokenLimit ?? r.daily_token_limit;
  const resetRaw = r.quotaResetMode ?? r.quota_reset_mode;
  const quotaResetMode: QuotaResetMode =
    resetRaw === 'rolling_24h' ? 'rolling_24h' : 'utc_midnight';
  const rawStrict = r.enforceStrictQuota ?? r.enforce_strict_quota;
  const enforceStrictQuota =
    rawStrict === undefined || rawStrict === null ? true : Boolean(rawStrict);

  return {
    id: String(r.id ?? ''),
    username: String(r.username ?? ''),
    role: String(r.role ?? 'guest'),
    dailyTokenLimit:
      typeof rawLimit === 'number' && Number.isFinite(rawLimit) ? rawLimit : null,
    quotaResetMode,
    enforceStrictQuota,
    allowedModels: asStringArray(
      r.allowedModels ?? r.allowed_models ?? r.allowed_models_json ?? ['*']
    ),
    usedTokensToday:
      typeof r.usedTokensToday === 'number'
        ? r.usedTokensToday
        : typeof r.used_tokens_today === 'number'
          ? r.used_tokens_today
          : undefined,
    usedTokens:
      typeof r.usedTokens === 'number'
        ? r.usedTokens
        : typeof r.used_tokens === 'number'
          ? r.used_tokens
          : undefined,
    requestsCount:
      typeof r.requestsCount === 'number'
        ? r.requestsCount
        : typeof r.requests_count === 'number'
          ? r.requests_count
          : undefined,
    createdAt:
      typeof r.createdAt === 'number'
        ? r.createdAt
        : typeof r.created_at === 'number'
          ? r.created_at
          : undefined,
  };
}

function normalizeInvitation(raw: unknown): InvitationItem {
  const r = asRecord(raw);
  const resetRaw = r.quotaResetMode ?? r.quota_reset_mode;
  const rawStrict = r.enforceStrictQuota ?? r.enforce_strict_quota;
  const enforceStrictQuota =
    rawStrict === undefined || rawStrict === null ? true : Boolean(rawStrict);
  return {
    id: String(r.id ?? ''),
    dailyTokenLimit: asNum(r.dailyTokenLimit ?? r.daily_token_limit),
    quotaResetMode: resetRaw === 'rolling_24h' ? 'rolling_24h' : 'utc_midnight',
    enforceStrictQuota,
    allowedModels: asStringArray(
      r.allowedModels ?? r.allowed_models ?? r.allowed_models_json ?? ['*']
    ),
    expiresAt: asNum(r.expiresAt ?? r.expires_at),
    usedAt:
      typeof r.usedAt === 'number'
        ? r.usedAt
        : typeof r.used_at === 'number'
          ? r.used_at
          : null,
    createdAt:
      typeof r.createdAt === 'number'
        ? r.createdAt
        : typeof r.created_at === 'number'
          ? r.created_at
          : undefined,
  };
}

function normalizeExitNode(raw: unknown): ExitNodeItem {
  const r = asRecord(raw);
  const rawMode = r.mode === 'public_ip' ? 'public_ip' : 'tailscale';
  const rawStatus =
    r.status === 'online' || r.status === 'unresponsive' || r.status === 'offline'
      ? r.status
      : 'offline';

  const assignedKeysRaw = Array.isArray(r.assignedKeys)
    ? r.assignedKeys
    : Array.isArray(r.assigned_keys)
      ? r.assigned_keys
      : undefined;

  const assignedKeys: NodeAssignedKeyRef[] | undefined = assignedKeysRaw?.map((item) => {
    const k = asRecord(item);
    return {
      id: String(k.id ?? ''),
      providerId: String(k.providerId ?? k.provider_id ?? ''),
      providerName: String(
        k.providerName ?? k.provider_name ?? k.providerId ?? k.provider_id ?? ''
      ),
      label: String(k.label ?? 'Clave'),
      last4: String(k.last4 ?? '••••'),
    };
  });

  return {
    id: String(r.id ?? ''),
    name: String(r.name ?? 'Nodo'),
    mode: rawMode,
    endpoint: String(r.endpoint ?? ''),
    commit:
      typeof r.commit === 'string'
        ? r.commit
        : typeof r.last_commit === 'string'
          ? r.last_commit
          : null,
    updateAvailable:
      r.updateAvailable === null || r.update_available === null
        ? null
        : typeof r.updateAvailable === 'boolean'
          ? r.updateAvailable
          : typeof r.update_available === 'boolean'
            ? r.update_available
            : null,
    status: rawStatus,
    lastSeenAt:
      typeof r.lastSeenAt === 'number'
        ? r.lastSeenAt
        : typeof r.last_seen_at === 'number'
          ? r.last_seen_at
          : null,
    lastRotatedAt:
      typeof r.lastRotatedAt === 'number'
        ? r.lastRotatedAt
        : typeof r.last_rotated_at === 'number'
          ? r.last_rotated_at
          : null,
    createdAt:
      typeof r.createdAt === 'number'
        ? r.createdAt
        : typeof r.created_at === 'number'
          ? r.created_at
          : undefined,
    assignedKeysCount:
      typeof r.assignedKeysCount === 'number'
        ? r.assignedKeysCount
        : typeof r.assigned_keys_count === 'number'
          ? r.assigned_keys_count
          : assignedKeys?.length,
    assignedKeys,
  };
}

function normalizeProviderKey(raw: unknown): ProviderKeyItem {
  const r = asRecord(raw);
  const rawStatus = typeof r.status === 'string' ? r.status : 'active';
  const status: ProviderKeyItem['status'] =
    rawStatus === 'rate_limited' ||
    rawStatus === 'error' ||
    rawStatus === 'no_node' ||
    rawStatus === 'disabled'
      ? rawStatus
      : 'active';

  return {
    id: String(r.id ?? ''),
    providerId:
      typeof r.providerId === 'string'
        ? r.providerId
        : (r.provider_id as string | undefined),
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

function normalizeProviderPrivacy(raw: unknown): ProviderPrivacyConfig | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const retention = r.retention;
  const training = r.training;
  if (
    (retention !== 'zero' &&
      retention !== 'transient' &&
      retention !== 'retained' &&
      retention !== 'variable') ||
    (training !== 'never' &&
      training !== 'opt_out' &&
      training !== 'allowed' &&
      training !== 'unknown')
  ) {
    return null;
  }
  const result: ProviderPrivacyConfig = { retention, training };
  if (
    typeof r.retentionDays === 'number' &&
    Number.isInteger(r.retentionDays) &&
    r.retentionDays >= 0
  ) {
    result.retentionDays = r.retentionDays;
  }
  if (typeof r.policyUrl === 'string' && r.policyUrl.trim().length > 0) {
    result.policyUrl = r.policyUrl;
  }
  if (typeof r.note === 'string' && r.note.length > 0) {
    result.note = r.note;
  }
  return result;
}

function normalizeRateLimitKind(raw: unknown): ProviderRateLimitKind | null {
  return raw === 'none' || raw === 'requests' || raw === 'tokens' || raw === 'concurrency'
    ? raw
    : null;
}

function normalizeRateLimitWindow(raw: unknown): ProviderRateLimitWindow {
  return raw === 'hour' || raw === 'week' ? raw : 'day';
}

function defaultWindowSeconds(win: ProviderRateLimitWindow): number {
  if (win === 'hour') return 3600;
  if (win === 'week') return 604800;
  return 86400;
}

function defaultWindowLabel(win: ProviderRateLimitWindow): string {
  if (win === 'hour') return '1h';
  if (win === 'week') return '7d';
  return '24h';
}

function normalizeQuotaUnit(
  raw: unknown,
  rateLimitKind: ProviderRateLimitKind | null
): QuotaUnit {
  if (raw === 'tokens' || raw === 'requests' || raw === 'none') {
    return raw;
  }
  if (rateLimitKind === 'none' || rateLimitKind === 'concurrency') return 'none';
  if (rateLimitKind === 'requests') return 'requests';
  return 'tokens';
}

function normalizeRateLimitWindows(raw: unknown): ProviderRateLimitWindow[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<ProviderRateLimitWindow>();
  const out: ProviderRateLimitWindow[] = [];
  for (const item of raw) {
    if (item === 'hour' || item === 'day' || item === 'week') {
      if (!seen.has(item)) {
        seen.add(item);
        out.push(item);
      }
    }
  }
  return out;
}

function normalizeQuotaConfidence(raw: unknown): QuotaConfidence {
  return raw === 'header_exact' || raw === 'configured' || raw === 'inferred'
    ? raw
    : 'inferred';
}

function normalizeProviderAdaptiveQuota(raw: unknown): ProviderAdaptiveQuota {
  const r = asRecord(raw);
  const rateLimitKind = normalizeRateLimitKind(r.rateLimitKind ?? r.rate_limit_kind);
  const activeWindow = normalizeRateLimitWindow(r.activeWindow ?? r.active_window);
  const windowSeconds = asNum(
    r.windowSeconds ?? r.window_seconds,
    defaultWindowSeconds(activeWindow)
  );
  const rawWindowLabel = r.windowLabel ?? r.window_label;
  const windowLabel =
    typeof rawWindowLabel === 'string' && rawWindowLabel.trim().length > 0
      ? rawWindowLabel
      : defaultWindowLabel(activeWindow);

  return {
    providerId: String(r.providerId ?? r.provider_id ?? ''),
    providerName: String(r.providerName ?? r.provider_name ?? r.providerId ?? ''),
    rateLimitKind,
    unit: normalizeQuotaUnit(r.unit, rateLimitKind),
    usableKeysCount: asNum(r.usableKeysCount ?? r.usable_keys_count, 0),
    supportedWindows: normalizeRateLimitWindows(r.supportedWindows ?? r.supported_windows),
    activeWindow,
    windowSeconds,
    windowLabel,
    confidence: normalizeQuotaConfidence(r.confidence),
    configuredLimit: asNullableNum(r.configuredLimit ?? r.configured_limit),
    inferredLimit: asNullableNum(r.inferredLimit ?? r.inferred_limit),
    effectiveLimit: asNullableNum(r.effectiveLimit ?? r.effective_limit),
    usedInWindow: asNum(r.usedInWindow ?? r.used_in_window),
    remainingInWindow: asNullableNum(r.remainingInWindow ?? r.remaining_in_window),
    headerRemaining: asNullableNum(r.headerRemaining ?? r.header_remaining),
    earliestResetAt:
      typeof r.earliestResetAt === 'string'
        ? r.earliestResetAt
        : typeof r.earliest_reset_at === 'string'
          ? r.earliest_reset_at
          : null,
    recent429Count7d: asNum(r.recent429Count7d ?? r.recent_429_count_7d),
    adaptiveAdjusted: Boolean(r.adaptiveAdjusted ?? r.adaptive_adjusted ?? false),
  };
}

function normalizeProviderModel(raw: unknown): ProviderModelItem {
  const r = asRecord(raw);
  const providerId = String(r.providerId ?? r.provider_id ?? '');
  const modelId = String(r.modelId ?? r.model_id ?? r.id ?? '');
  const fullId = String(
    r.fullId ?? r.full_id ?? (providerId ? `${providerId}/${modelId}` : modelId)
  );

  let capsObj = asRecord(r.capabilities);
  if (typeof r.capabilities_json === 'string') {
    try {
      capsObj = asRecord(JSON.parse(r.capabilities_json));
    } catch {
      capsObj = {};
    }
  }

  let modObj = asRecord(r.modalities);
  if (typeof r.modalities_json === 'string') {
    try {
      modObj = asRecord(JSON.parse(r.modalities_json));
    } catch {
      modObj = {};
    }
  }

  const inputMods = asStringArray(modObj.input);
  const outputMods = asStringArray(modObj.output);
  const pricingObj = r.pricing && typeof r.pricing === 'object' ? asRecord(r.pricing) : null;

  return {
    fullId,
    providerId,
    providerName:
      typeof r.providerName === 'string'
        ? r.providerName
        : typeof r.provider_name === 'string'
          ? r.provider_name
          : undefined,
    providerPrivacy: normalizeProviderPrivacy(r.providerPrivacy ?? r.provider_privacy),
    logoSlug:
      typeof r.logoSlug === 'string'
        ? r.logoSlug
        : typeof r.logo_slug === 'string'
          ? r.logo_slug
          : providerId || undefined,
    modelId,
    canonicalModelId:
      typeof r.canonicalModelId === 'string'
        ? r.canonicalModelId
        : typeof r.canonical_model_id === 'string'
          ? r.canonical_model_id
          : null,
    name: String(r.name ?? modelId),
    family: typeof r.family === 'string' ? r.family : null,
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
    modalities: {
      input: inputMods.length > 0 ? inputMods : ['text'],
      output: outputMods.length > 0 ? outputMods : ['text'],
    },
    capabilities: {
      tools: Boolean(capsObj.tools),
      reasoning: Boolean(capsObj.reasoning),
      structuredOutput: Boolean(capsObj.structuredOutput ?? capsObj.structured_output),
    },
    pricing: pricingObj
      ? {
          prompt: asNullableNum(pricingObj.prompt) ?? undefined,
          completion: asNullableNum(pricingObj.completion) ?? undefined,
          referencePromptPer1M: asNullableNum(
            pricingObj.referencePromptPer1M ??
              pricingObj.reference_prompt ??
              pricingObj.modelsDevPrompt
          ),
          referenceCompletionPer1M: asNullableNum(
            pricingObj.referenceCompletionPer1M ??
              pricingObj.reference_completion ??
              pricingObj.modelsDevCompletion
          ),
        }
      : null,
    releaseDate:
      typeof r.releaseDate === 'string'
        ? r.releaseDate
        : typeof r.release_date === 'string'
          ? r.release_date
          : null,
    upstreamCreatedAt: asNullableNum(r.upstreamCreatedAt ?? r.upstream_created_at),
    isFree: r.isFree !== undefined ? Boolean(r.isFree) : Boolean(r.is_free ?? true),
    firstSeenAt:
      typeof r.firstSeenAt === 'number'
        ? r.firstSeenAt
        : typeof r.first_seen_at === 'number'
          ? r.first_seen_at
          : undefined,
    active: r.active !== undefined ? Boolean(r.active) : true,
    disabledByAdmin: Boolean(r.disabledByAdmin ?? r.disabled_by_admin ?? false),
    hasCatalogInfo:
      r.hasCatalogInfo !== undefined
        ? Boolean(r.hasCatalogInfo)
        : r.has_catalog_info !== undefined
          ? Boolean(r.has_catalog_info)
          : undefined,
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

  const publishedAt =
    typeof r.publishedAt === 'string'
      ? r.publishedAt
      : typeof r.published_at === 'string'
        ? r.published_at
        : manifest?.publishedAt ?? null;

  return {
    id: String(r.id ?? manifest?.id ?? ''),
    name: String(r.name ?? manifest?.name ?? ''),
    packageType,
    modelsSource,
    category: (r.category as ProviderSummary['category']) ?? manifest?.category,
    verified: Boolean(r.verified ?? manifest?.verified ?? false),
    publishedAt,
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
    models,
    syncedAt: typeof r.syncedAt === 'number' ? r.syncedAt : Math.floor(Date.now() / 1000),
  };
}

async function fileToBase64(file: File): Promise<string> {
  const buf = await file.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
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

  /* Phase 4 — Provider Monochrome SVG Logos & 4-Source Model Benchmarks (HU-14, HU-14b, HU-14c) */

  async getProviderLogo(slug: string): Promise<ProviderLogoData> {
    const cleanSlug = slug.trim().toLowerCase();
    if (!cleanSlug) return { hasLogo: false, svg: null };

    const cached = logoCache.get(cleanSlug);
    if (cached) return cached;

    try {
      const res = await fetch(`/api/logos/${encodeURIComponent(cleanSlug)}`, {
        method: 'GET',
        credentials: 'include',
        headers: {
          Accept: 'image/svg+xml, application/json',
        },
      });

      if (!res.ok) {
        const fallback: ProviderLogoData = { hasLogo: false, svg: null };
        logoCache.set(cleanSlug, fallback);
        return fallback;
      }

      const ct = res.headers.get('content-type') ?? '';
      if (ct.includes('image/svg+xml')) {
        const svgText = await res.text();
        const cleanSvg = sanitizeMonochromeSvg(svgText);
        const out: ProviderLogoData = { hasLogo: Boolean(cleanSvg), svg: cleanSvg };
        logoCache.set(cleanSlug, out);
        return out;
      }

      const json = (await res.json()) as Record<string, unknown>;
      const rawSvg = typeof json.svg === 'string' ? json.svg : null;
      const cleanSvg = rawSvg ? sanitizeMonochromeSvg(rawSvg) : null;
      const out: ProviderLogoData = {
        hasLogo: Boolean(json.hasLogo !== false && cleanSvg),
        svg: cleanSvg,
      };
      logoCache.set(cleanSlug, out);
      return out;
    } catch {
      const fallback: ProviderLogoData = { hasLogo: false, svg: null };
      logoCache.set(cleanSlug, fallback);
      return fallback;
    }
  },

  async getModelDetail(fullId: string): Promise<ProviderModelItem> {
    const raw = await request<unknown>(`/api/models/${encodeURIComponent(fullId)}`, {
      method: 'GET',
    });
    const r = asRecord(raw);
    return normalizeProviderModel(r.model ?? raw);
  },

  async getModelBenchmarks(fullId: string): Promise<ModelBenchmarksData> {
    const raw = await request<unknown>(
      `/api/models/${encodeURIComponent(fullId)}/benchmarks`,
      { method: 'GET' }
    );
    return normalizeModelBenchmarks(fullId, raw);
  },

  /* Phase 6 — Playground Chat (HU-22) */

  async sendPlaygroundChat(
    input: PlaygroundChatRequest,
    onDelta?: (partialText: string) => void
  ): Promise<PlaygroundChatResponse> {
    const startedMs = performance.now();
    let firstTokenMs: number | null = null;

    const payload: Record<string, unknown> = {
      model: input.model,
      messages: input.messages,
      temperature: input.temperature,
      max_tokens: input.maxTokens,
      maxTokens: input.maxTokens,
    };
    if (input.reasoningEffort && input.reasoningEffort !== 'none') {
      payload.reasoning_effort = input.reasoningEffort;
      payload.reasoningEffort = input.reasoningEffort;
    }

    const response = await fetch('/api/playground/chat', {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      let errMsg = `Error HTTP ${response.status}`;
      try {
        const errJson = (await response.json()) as Record<string, unknown>;
        errMsg = String(errJson.error ?? errJson.message ?? errMsg);
      } catch {
        // Keep HTTP status fallback
      }
      throw new ApiError(errMsg, response.status);
    }

    const contentType = response.headers.get('content-type') ?? '';

    if (contentType.includes('text/event-stream') && response.body) {
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let contentAcc = '';
      let reasoningAcc = '';
      let serverTtft: number | null = null;
      let serverTps: number | null = null;
      let promptTokens = 0;
      let completionTokens = 0;
      let reasoningTokens = 0;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const rawLine of lines) {
          const line = rawLine.trim();
          if (!line.startsWith('data:')) continue;
          const dataStr = line.slice(5).trim();
          if (!dataStr || dataStr === '[DONE]') continue;

          try {
            const evt = JSON.parse(dataStr) as Record<string, unknown>;
            if (typeof evt.ttftMs === 'number' || typeof evt.ttft_ms === 'number') {
              serverTtft = asNum(evt.ttftMs ?? evt.ttft_ms);
            }
            if (
              typeof evt.tokensPerSec === 'number' ||
              typeof evt.tokens_per_sec === 'number'
            ) {
              serverTps = asNum(evt.tokensPerSec ?? evt.tokens_per_sec);
            }
            if (evt.usage && typeof evt.usage === 'object') {
              const u = asRecord(evt.usage);
              promptTokens = asNum(u.prompt_tokens ?? u.promptTokens, promptTokens);
              completionTokens = asNum(
                u.completion_tokens ?? u.completionTokens,
                completionTokens
              );
              const details = asRecord(u.completion_tokens_details);
              reasoningTokens = asNum(
                u.reasoning_tokens ?? u.reasoningTokens ?? details.reasoning_tokens,
                reasoningTokens
              );
            }

            const choices = Array.isArray(evt.choices) ? evt.choices : [];
            if (choices.length > 0) {
              const delta = asRecord(asRecord(choices[0]).delta);
              const deltaText = typeof delta.content === 'string' ? delta.content : '';
              const deltaReasoning =
                typeof delta.reasoning_content === 'string'
                  ? delta.reasoning_content
                  : typeof delta.reasoning === 'string'
                    ? delta.reasoning
                    : '';
              if (deltaText || deltaReasoning) {
                if (firstTokenMs === null) {
                  firstTokenMs = Math.round(performance.now() - startedMs);
                }
                contentAcc += deltaText;
                reasoningAcc += deltaReasoning;
                onDelta?.(contentAcc);
              }
            } else if (typeof evt.delta === 'string') {
              if (firstTokenMs === null) {
                firstTokenMs = Math.round(performance.now() - startedMs);
              }
              contentAcc += evt.delta;
              onDelta?.(contentAcc);
            }
          } catch {
            // Ignore malformed SSE comment/chunk
          }
        }
      }

      const elapsedSec = Math.max(0.05, (performance.now() - startedMs) / 1000);
      const estimatedTokens =
        completionTokens > 0 ? completionTokens : Math.max(1, Math.round(contentAcc.length / 4));

      return {
        content: contentAcc,
        reasoningContent: reasoningAcc || undefined,
        model: input.model,
        ttftMs: serverTtft ?? firstTokenMs,
        tokensPerSec: serverTps ?? Number((estimatedTokens / elapsedSec).toFixed(1)),
        usage: {
          promptTokens,
          completionTokens: completionTokens || estimatedTokens,
          reasoningTokens,
          totalTokens: promptTokens + (completionTokens || estimatedTokens) + reasoningTokens,
        },
      };
    }

    const raw = (await response.json()) as unknown;
    const elapsedMs = Math.round(performance.now() - startedMs);
    const r = asRecord(raw);
    const choices = Array.isArray(r.choices) ? r.choices : [];
    const firstMsg =
      choices.length > 0 ? asRecord(asRecord(choices[0]).message) : asRecord(r.message);

    const content = String(r.content ?? firstMsg.content ?? r.reply ?? r.text ?? '');
    const reasoningContent =
      typeof r.reasoningContent === 'string'
        ? r.reasoningContent
        : typeof r.reasoning_content === 'string'
          ? r.reasoning_content
          : typeof firstMsg.reasoning_content === 'string'
            ? firstMsg.reasoning_content
            : undefined;

    const u = asRecord(r.usage);
    const details = asRecord(u.completion_tokens_details);
    const promptTokens = asNum(u.promptTokens ?? u.prompt_tokens ?? r.promptTokens);
    const completionTokens = asNum(
      u.completionTokens ?? u.completion_tokens ?? r.completionTokens
    );
    const reasoningTokens = asNum(
      u.reasoningTokens ??
        u.reasoning_tokens ??
        details.reasoning_tokens ??
        r.reasoningTokens
    );

    const rawTtft = r.ttftMs ?? r.ttft_ms;
    const rawTps = r.tokensPerSec ?? r.tokens_per_sec;

    return {
      content,
      reasoningContent,
      model: typeof r.model === 'string' ? r.model : input.model,
      ttftMs:
        typeof rawTtft === 'number' && Number.isFinite(rawTtft) ? rawTtft : elapsedMs,
      tokensPerSec:
        typeof rawTps === 'number' && Number.isFinite(rawTps)
          ? rawTps
          : completionTokens > 0 && elapsedMs > 0
            ? Number(((completionTokens / elapsedMs) * 1000).toFixed(1))
            : null,
      usage: {
        promptTokens,
        completionTokens,
        reasoningTokens,
        totalTokens: asNum(
          u.totalTokens ?? u.total_tokens,
          promptTokens + completionTokens + reasoningTokens
        ),
      },
    };
  },

  /* Phase 8 — Users & Single-Use Invitations (HU-04, HU-05) */

  async getUsers(): Promise<ManagedUserItem[]> {
    const raw = await request<unknown>('/api/users', { method: 'GET' });
    const r = asRecord(raw);
    const list = Array.isArray(r.users) ? r.users : Array.isArray(raw) ? raw : [];
    return list.map(normalizeManagedUser);
  },

  async updateUserQuotaAndModels(
    userId: string,
    input: {
      dailyTokenLimit: number | null;
      quotaResetMode: QuotaResetMode;
      enforceStrictQuota?: boolean;
      allowedModels: string[];
    }
  ): Promise<ManagedUserItem> {
    const raw = await request<unknown>(`/api/users/${encodeURIComponent(userId)}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    });
    const r = asRecord(raw);
    return normalizeManagedUser(r.user ?? raw);
  },

  deleteUser(userId: string): Promise<{ ok: boolean }> {
    return request<{ ok: boolean }>(`/api/users/${encodeURIComponent(userId)}`, {
      method: 'DELETE',
    });
  },

  async getInvitations(): Promise<InvitationItem[]> {
    try {
      const raw = await request<unknown>('/api/invitations', { method: 'GET' });
      const r = asRecord(raw);
      const list = Array.isArray(r.invitations) ? r.invitations : Array.isArray(raw) ? raw : [];
      return list.map(normalizeInvitation);
    } catch {
      return [];
    }
  },

  async createInvitation(input: CreateInvitationInput): Promise<CreateInvitationResult> {
    const raw = await request<unknown>('/api/invitations', {
      method: 'POST',
      body: JSON.stringify({
        dailyTokenLimit: input.dailyTokenLimit,
        quotaResetMode: input.quotaResetMode,
        ...(input.enforceStrictQuota !== undefined
          ? { enforceStrictQuota: input.enforceStrictQuota }
          : {}),
        allowedModels: input.allowedModels,
        expiresInHours: input.expiresInHours ?? 48,
      }),
    });
    const r = asRecord(raw);
    const token = String(r.token ?? r.rawToken ?? r.inviteToken ?? '');
    const inviteUrl =
      typeof r.inviteUrl === 'string' && r.inviteUrl.startsWith('http')
        ? r.inviteUrl
        : `${window.location.origin}/?invite=${encodeURIComponent(token)}`;

    return {
      invitation: r.invitation ? normalizeInvitation(r.invitation) : undefined,
      token,
      inviteUrl,
      expiresAt: typeof r.expiresAt === 'number' ? r.expiresAt : undefined,
    };
  },

  deleteInvitation(invitationId: string): Promise<{ ok: boolean }> {
    return request<{ ok: boolean }>(`/api/invitations/${encodeURIComponent(invitationId)}`, {
      method: 'DELETE',
    });
  },

  acceptInvitation(
    token: string,
    username: string,
    password: string
  ): Promise<AuthSuccessResponse> {
    return request<AuthSuccessResponse>(
      `/api/invitations/${encodeURIComponent(token)}/accept`,
      {
        method: 'POST',
        body: JSON.stringify({ username, password }),
      }
    );
  },

  /* Phase 8 — Encrypted Backups .bifrost.enc (HU-25, HU-25b) */

  async exportBackup(options: BackupExportOptions): Promise<Blob> {
    const response = await fetch('/api/backup/export', {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(options),
    });

    if (!response.ok) {
      let msg = `Error HTTP ${response.status} al exportar respaldo.`;
      try {
        const errJson = (await response.json()) as Record<string, unknown>;
        msg = String(errJson.error ?? errJson.message ?? msg);
      } catch {
        // Ignore JSON parse error
      }
      throw new ApiError(msg, response.status);
    }

    return response.blob();
  },

  async importBackup(file: File, password: string): Promise<BackupImportResult> {
    const formData = new FormData();
    formData.append('file', file);
    formData.append('password', password);

    try {
      const raw = await request<unknown>('/api/backup/import', {
        method: 'POST',
        body: formData,
      });
      const r = asRecord(raw);
      return {
        ok: r.ok !== undefined ? Boolean(r.ok) : true,
        message: typeof r.message === 'string' ? r.message : undefined,
        restored: r.restored as BackupImportResult['restored'],
      };
    } catch (err) {
      if (err instanceof ApiError && (err.status === 415 || err.status === 400)) {
        const errLower = err.message.toLowerCase();
        const isAuthOrDecryptFailure =
          errLower.includes('contraseña') ||
          errLower.includes('password') ||
          errLower.includes('corrupt') ||
          errLower.includes('cifrad') ||
          errLower.includes('decrypt') ||
          errLower.includes('bifrost1') ||
          errLower.includes('tag') ||
          errLower.includes('inválid');
        if (isAuthOrDecryptFailure) {
          throw err;
        }

        const dataBase64 = await fileToBase64(file);
        const rawJson = await request<unknown>('/api/backup/import', {
          method: 'POST',
          body: JSON.stringify({
            password,
            fileBase64: dataBase64,
            data: dataBase64,
          }),
        });
        const rJson = asRecord(rawJson);
        return {
          ok: rJson.ok !== undefined ? Boolean(rJson.ok) : true,
          message: typeof rJson.message === 'string' ? rJson.message : undefined,
          restored: rJson.restored as BackupImportResult['restored'],
        };
      }
      throw err;
    }
  },

  /* Phase 5 — Telemetry, Quota Summary, Percentiles, Uptime & Logs */

  async getMetricsSummary(): Promise<MetricsSummary> {
    const raw = await request<unknown>('/api/metrics/summary', { method: 'GET' });
    const r = asRecord(raw);
    const totalLimitRaw = r.totalDailyLimit ?? r.total_daily_limit ?? r.dailyLimit ?? null;
    const totalDailyLimit =
      typeof totalLimitRaw === 'number' && totalLimitRaw > 0 ? totalLimitRaw : null;
    const usedTokensToday = asNum(r.usedTokensToday ?? r.used_tokens_today ?? r.usedToday);

    let quotaPct: number | null = null;
    const rawPct = r.quotaPercentageRemaining ?? r.quota_percentage_remaining;
    if (typeof rawPct === 'number' && Number.isFinite(rawPct)) {
      quotaPct = Math.max(0, Math.min(100, rawPct));
    } else if (totalDailyLimit !== null && totalDailyLimit > 0) {
      quotaPct = Math.max(
        0,
        Math.min(100, Math.round(((totalDailyLimit - usedTokensToday) / totalDailyLimit) * 100))
      );
    }

    const quotaToday = asRecord(r.quotaToday);
    const activeWindow = normalizeRateLimitWindow(
      r.activeWindow ?? quotaToday.activeWindow
    );
    const windowSeconds = asNum(
      r.windowSeconds ?? r.window_seconds ?? quotaToday.windowSeconds,
      defaultWindowSeconds(activeWindow)
    );
    const rawSummaryWindowLabel =
      r.windowLabel ?? r.window_label ?? quotaToday.windowLabel;
    const windowLabel =
      typeof rawSummaryWindowLabel === 'string' && rawSummaryWindowLabel.trim().length > 0
        ? rawSummaryWindowLabel
        : defaultWindowLabel(activeWindow);
    const quotaConfidence = normalizeQuotaConfidence(
      r.quotaConfidence ?? quotaToday.confidence
    );
    const effectiveLimit = asNullableNum(
      r.effectiveLimit ?? quotaToday.effectiveLimit ?? totalDailyLimit
    );
    const adaptiveAdjusted = Boolean(
      r.adaptiveAdjusted ?? quotaToday.adaptiveAdjusted ?? false
    );
    const providerQuotas = Array.isArray(r.providerQuotas)
      ? r.providerQuotas.map(normalizeProviderAdaptiveQuota)
      : undefined;

    return {
      quotaPercentageRemaining: quotaPct,
      usedTokensToday,
      totalDailyLimit,
      nextResetAt:
        (r.nextResetAt as string | number | null) ??
        (r.next_reset_at as string | number | null) ??
        null,
      resetMode: String(r.resetMode ?? r.reset_mode ?? 'utc_midnight'),
      providersCount: asNum(r.providersCount ?? r.providers_count),
      activeModelsCount: asNum(r.activeModelsCount ?? r.active_models_count ?? r.modelsCount),
      onlineNodesCount: asNum(r.onlineNodesCount ?? r.online_nodes_count),
      activeWindow,
      windowSeconds,
      windowLabel,
      quotaConfidence,
      effectiveLimit,
      adaptiveAdjusted,
      providerQuotas,
    };
  },

  async getFreeQuota(): Promise<FreeQuotaStatus> {
    const raw = await request<unknown>('/api/metrics/free-quota', { method: 'GET' });
    const r = asRecord(raw);
    const providers = Array.isArray(r.providers)
      ? r.providers.map(normalizeProviderAdaptiveQuota)
      : [];
    const activeWindow = normalizeRateLimitWindow(r.activeWindow ?? r.active_window);
    const windowSeconds = asNum(
      r.windowSeconds ?? r.window_seconds,
      defaultWindowSeconds(activeWindow)
    );
    const rawWindowLabel = r.windowLabel ?? r.window_label;
    const windowLabel =
      typeof rawWindowLabel === 'string' && rawWindowLabel.trim().length > 0
        ? rawWindowLabel
        : defaultWindowLabel(activeWindow);

    return {
      activeWindow,
      windowSeconds,
      windowLabel,
      confidence: normalizeQuotaConfidence(r.confidence),
      configuredLimit: asNullableNum(r.configuredLimit ?? r.configured_limit),
      effectiveLimit: asNullableNum(r.effectiveLimit ?? r.effective_limit),
      usedInWindow: asNum(r.usedInWindow ?? r.used_in_window),
      remainingInWindow: asNullableNum(r.remainingInWindow ?? r.remaining_in_window),
      quotaPercentageRemaining: asNullableNum(
        r.quotaPercentageRemaining ?? r.quota_percentage_remaining
      ),
      adaptiveAdjusted: Boolean(r.adaptiveAdjusted ?? r.adaptive_adjusted ?? false),
      providers,
    };
  },

  async getMetricsLatency(range = '24h'): Promise<LatencyMetricsData> {
    const raw = await request<unknown>(
      `/api/metrics/latency?range=${encodeURIComponent(range)}`,
      { method: 'GET' }
    );
    const r = asRecord(raw);
    const rawList = Array.isArray(r.buckets)
      ? r.buckets
      : Array.isArray(r.series)
        ? r.series
        : Array.isArray(r.points)
          ? r.points
          : Array.isArray(raw)
            ? raw
            : [];

    const buckets: LatencyBucketPoint[] = rawList.map((item) => {
      const b = asRecord(item);
      const pct = normalizePercentiles(b.percentiles ?? b);
      return {
        timestamp: (b.timestamp ?? b.bucket ?? b.time ?? b.date ?? '') as string | number,
        label: typeof b.label === 'string' ? b.label : undefined,
        count:
          typeof b.count === 'number'
            ? b.count
            : typeof b.samples === 'number'
              ? b.samples
              : undefined,
        ...pct,
      };
    });

    const overall = r.overall ? normalizePercentiles(r.overall) : null;
    return { buckets, overall };
  },

  async getMetricsSpeed(): Promise<SpeedMetricsData> {
    const raw = await request<unknown>('/api/metrics/speed', { method: 'GET' });
    const r = asRecord(raw);
    const rawModels = Array.isArray(r.models)
      ? r.models
      : Array.isArray(r.items)
        ? r.items
        : [];
    const rawCache = Array.isArray(r.cacheByProvider)
      ? r.cacheByProvider
      : Array.isArray(r.cache)
        ? r.cache
        : Array.isArray(r.providers)
          ? r.providers
          : [];

    const models: ModelSpeedEntry[] = rawModels.map((item, idx) => {
      const m = asRecord(item);
      const modelFullId = String(
        m.modelFullId ?? m.model_full_id ?? m.fullId ?? m.model ?? `model-${idx}`
      );
      const providerId = String(
        m.providerId ??
          m.provider_id ??
          (modelFullId.includes('/') ? modelFullId.split('/')[0] : '')
      );
      return {
        id: `${modelFullId}-${idx}`,
        modelFullId,
        providerId,
        sampleCount: asNum(m.sampleCount ?? m.samples ?? m.count),
        ttftMs: normalizePercentiles(m.ttftMs ?? m.ttft_ms ?? m.ttft),
        tokensPerSec: normalizePercentiles(
          m.tokensPerSec ?? m.tokens_per_sec ?? m.tps ?? m.speed
        ),
      };
    });

    const cacheByProvider: ProviderCacheEntry[] = rawCache.map((item) => {
      const c = asRecord(item);
      const cachedTokens = asNum(c.cachedTokens ?? c.cached_tokens);
      const promptTokens = asNum(c.promptTokens ?? c.prompt_tokens);
      const rawHitRate = c.cacheHitRate ?? c.cache_hit_rate ?? c.hitRate;
      const hitRate =
        typeof rawHitRate === 'number'
          ? normalizeRatePct(rawHitRate)
          : promptTokens > 0
            ? Math.min(100, (cachedTokens / promptTokens) * 100)
            : 0;
      const pid = String(c.providerId ?? c.provider_id ?? c.id ?? '');
      return {
        providerId: pid,
        providerName: String(c.providerName ?? c.provider_name ?? c.name ?? pid),
        cacheHitRate: hitRate,
        cachedTokens,
        promptTokens,
      };
    });

    return { models, cacheByProvider };
  },

  async getMetricsUptime(): Promise<ProviderReliabilityEntry[]> {
    const raw = await request<unknown>('/api/metrics/uptime', { method: 'GET' });
    const r = asRecord(raw);
    const rawProviders = Array.isArray(r.providers)
      ? r.providers
      : Array.isArray(r.items)
        ? r.items
        : Array.isArray(raw)
          ? raw
          : [];

    return rawProviders.map((item) => {
      const p = asRecord(item);
      const pid = String(p.providerId ?? p.provider_id ?? p.id ?? '');
      const rawDaysList = Array.isArray(p.days)
        ? p.days
        : Array.isArray(p.history)
          ? p.history
          : [];

      const parsedDays: UptimeDayCell[] = rawDaysList.map((cell) => {
        const d = asRecord(cell);
        const totalReq = asNum(d.totalRequests ?? d.total_requests ?? d.requests ?? d.count);
        const rawUptime = d.uptimePct ?? d.uptime_pct ?? d.uptime;
        const uptimePct =
          totalReq === 0 || rawUptime === null || rawUptime === undefined
            ? null
            : typeof rawUptime === 'number' && Number.isFinite(rawUptime)
              ? Math.max(0, Math.min(100, rawUptime))
              : null;

        return {
          date: String(d.date ?? d.day ?? ''),
          uptimePct,
          totalRequests: totalReq,
          errorRequests:
            typeof d.errorRequests === 'number'
              ? d.errorRequests
              : typeof d.errors === 'number'
                ? d.errors
                : undefined,
        };
      });

      const days60 = build60DayWindow(parsedDays);
      const daysWithTraffic = days60.filter((d) => d.uptimePct !== null);
      const overallRaw = p.overallUptimePct ?? p.overall_uptime_pct ?? p.uptimePct;
      const overallUptimePct =
        typeof overallRaw === 'number' && Number.isFinite(overallRaw)
          ? overallRaw
          : daysWithTraffic.length > 0
            ? daysWithTraffic.reduce((acc, d) => acc + (d.uptimePct ?? 0), 0) /
              daysWithTraffic.length
            : null;

      return {
        providerId: pid,
        providerName: String(p.providerName ?? p.provider_name ?? p.name ?? pid),
        overallUptimePct,
        days: days60,
        toolErrorRate7d: normalizeRatePct(
          p.toolErrorRate ?? p.toolErrorRate7d ?? p.tool_error_rate ?? 0
        ),
        structuredErrorRate7d: normalizeRatePct(
          p.structuredErrorRate ??
            p.structuredErrorRate7d ??
            p.structured_error_rate ??
            0
        ),
        totalRequests7d:
          typeof p.totalRequests7d === 'number' ? p.totalRequests7d : undefined,
      };
    });
  },

  async getMetricsActivity(
    range: ActivityRange,
    groupBy: ActivityGroupBy
  ): Promise<ActivityMetricsData> {
    const params = new URLSearchParams({ range, groupBy });
    const raw = await request<unknown>(`/api/metrics/activity?${params.toString()}`, {
      method: 'GET',
    });
    const r = asRecord(raw);
    const rawItems = Array.isArray(r.items)
      ? r.items
      : Array.isArray(r.groups)
        ? r.groups
        : Array.isArray(r.series)
          ? r.series
          : Array.isArray(r.buckets)
            ? r.buckets
            : [];

    const items: ActivitySeriesItem[] = rawItems.map((entry, idx) => {
      const it = asRecord(entry);
      const promptTokens = asNum(it.promptTokens ?? it.prompt_tokens ?? it.prompt);
      const completionTokens = asNum(
        it.completionTokens ?? it.completion_tokens ?? it.completion
      );
      const reasoningTokens = asNum(
        it.reasoningTokens ?? it.reasoning_tokens ?? it.reasoning
      );
      const totalTokens = asNum(
        it.totalTokens ?? it.total_tokens ?? it.total,
        promptTokens + completionTokens + reasoningTokens
      );
      const key = String(
        it.key ?? it.id ?? it.model ?? it.provider ?? it.user ?? it.bucket ?? `item-${idx}`
      );
      return {
        key,
        label: String(it.label ?? it.name ?? key),
        promptTokens,
        completionTokens,
        reasoningTokens,
        totalTokens,
        requestsCount:
          typeof it.requestsCount === 'number'
            ? it.requestsCount
            : typeof it.requests === 'number'
              ? it.requests
              : undefined,
      };
    });

    const t = asRecord(r.totals);
    const sumPrompt = items.reduce((s, i) => s + i.promptTokens, 0);
    const sumCompletion = items.reduce((s, i) => s + i.completionTokens, 0);
    const sumReasoning = items.reduce((s, i) => s + i.reasoningTokens, 0);

    const promptTokens = asNum(t.promptTokens ?? t.prompt_tokens ?? t.prompt, sumPrompt);
    const completionTokens = asNum(
      t.completionTokens ?? t.completion_tokens ?? t.completion,
      sumCompletion
    );
    const reasoningTokens = asNum(
      t.reasoningTokens ?? t.reasoning_tokens ?? t.reasoning,
      sumReasoning
    );

    return {
      range,
      groupBy,
      totals: {
        promptTokens,
        completionTokens,
        reasoningTokens,
        totalTokens: asNum(
          t.totalTokens ?? t.total_tokens ?? t.total,
          promptTokens + completionTokens + reasoningTokens
        ),
      },
      items,
    };
  },

  async getSystemLogs(filters: {
    level?: string;
    category?: string;
    q?: string;
    limit?: number;
    offset?: number;
  }): Promise<SystemLogsResponse> {
    const params = new URLSearchParams();
    if (filters.level) params.set('level', filters.level);
    if (filters.category) params.set('category', filters.category);
    if (filters.q && filters.q.trim().length > 0) params.set('q', filters.q.trim());
    if (filters.limit) params.set('limit', String(filters.limit));
    if (filters.offset) params.set('offset', String(filters.offset));

    const qs = params.toString();
    const raw = await request<unknown>(`/api/logs${qs ? `?${qs}` : ''}`, {
      method: 'GET',
    });
    const r = asRecord(raw);
    const rawLogs = Array.isArray(r.logs)
      ? r.logs
      : Array.isArray(r.items)
        ? r.items
        : Array.isArray(raw)
          ? raw
          : [];

    const logs: SystemLogEntry[] = rawLogs.map((entry, idx) => {
      const l = asRecord(entry);
      let meta: Record<string, unknown> | null = null;
      if (l.meta && typeof l.meta === 'object') {
        meta = l.meta as Record<string, unknown>;
      } else if (typeof l.metaJson === 'string' || typeof l.meta_json === 'string') {
        try {
          meta = JSON.parse(String(l.metaJson ?? l.meta_json)) as Record<string, unknown>;
        } catch {
          meta = null;
        }
      }

      const rawLevel = l.level;
      const level: SystemLogEntry['level'] =
        rawLevel === 'warn' || rawLevel === 'error' ? rawLevel : 'info';

      return {
        id: (l.id as number | string) ?? idx,
        level,
        category: String(l.category ?? 'system'),
        message: String(l.message ?? ''),
        meta,
        createdAt: (l.createdAt ?? l.created_at ?? Math.floor(Date.now() / 1000)) as
          | number
          | string,
      };
    });

    return {
      logs,
      total: asNum(r.total, logs.length),
    };
  },

  /* Exit Nodes (Phase 3) */

  async getNodes(): Promise<ExitNodeItem[]> {
    const raw = await request<unknown>('/api/nodes', { method: 'GET' });
    const r = asRecord(raw);
    const list = Array.isArray(r.nodes) ? r.nodes : Array.isArray(raw) ? raw : [];
    return list.map(normalizeExitNode);
  },

  async createNode(input: CreateNodeInput): Promise<CreateNodeResult> {
    const raw = await request<unknown>('/api/nodes', {
      method: 'POST',
      body: JSON.stringify({
        name: input.name.trim(),
        mode: input.mode,
        endpoint: input.endpoint.trim(),
      }),
    });
    const r = asRecord(raw);
    const node = normalizeExitNode(r.node ?? raw);
    const rawToken = String(r.rawToken ?? r.nodeToken ?? r.token ?? r.node_token ?? '');
    const defaultScriptUrl = `${window.location.origin}/install-node.sh`;
    const installCommand =
      typeof r.installCommand === 'string' && r.installCommand.length > 0
        ? r.installCommand
        : typeof r.install_command === 'string' && r.install_command.length > 0
          ? r.install_command
          : `curl -fsSL ${defaultScriptUrl} | sudo bash -s -- --mode ${node.mode} --endpoint "${node.endpoint}" --token "${rawToken}"`;

    return {
      node,
      rawToken,
      installCommand,
    };
  },

  async rotateNodeToken(nodeId: string): Promise<RotateNodeTokenResult> {
    const raw = await request<unknown>(
      `/api/nodes/${encodeURIComponent(nodeId)}/rotate`,
      { method: 'POST' }
    );
    const r = asRecord(raw);
    return {
      ok: r.ok !== undefined ? Boolean(r.ok) : true,
      lastRotatedAt:
        typeof r.lastRotatedAt === 'number'
          ? r.lastRotatedAt
          : typeof r.last_rotated_at === 'number'
            ? r.last_rotated_at
            : Math.floor(Date.now() / 1000),
      graceSeconds:
        typeof r.graceSeconds === 'number'
          ? r.graceSeconds
          : typeof r.grace_seconds === 'number'
            ? r.grace_seconds
            : 300,
      rawToken:
        typeof r.rawToken === 'string'
          ? r.rawToken
          : typeof r.nodeToken === 'string'
            ? r.nodeToken
            : typeof r.token === 'string'
              ? r.token
              : undefined,
    };
  },

  deleteNode(nodeId: string): Promise<{ ok: boolean }> {
    return request<{ ok: boolean }>(`/api/nodes/${encodeURIComponent(nodeId)}`, {
      method: 'DELETE',
    });
  },

  testNode(nodeId: string): Promise<ExitNodeTestResult> {
    return request<ExitNodeTestResult>(`/api/nodes/${encodeURIComponent(nodeId)}/test`, {
      method: 'POST',
    });
  },

  async assignKeyNode(
    providerId: string,
    keyId: string,
    nodeId: string | null,
    confirmForce?: boolean
  ): Promise<ProviderKeyItem> {
    const raw = await request<unknown>(
      `/api/providers/${encodeURIComponent(providerId)}/keys/${encodeURIComponent(keyId)}/node`,
      {
        method: 'PATCH',
        body: JSON.stringify({
          nodeId,
          confirmForce: Boolean(confirmForce),
        }),
      }
    );
    const r = asRecord(raw);
    return normalizeProviderKey(r.key ?? raw);
  },

  /* Providers & Marketplace (Phase 2 & Phase 7 HU-23) */

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

      // HU-23: Only expose approved packages from marketplace catalog
      const approvedManifests = (list as ProviderManifest[])
        .filter((m) => m.approved !== false)
        .map((m) => ({
          ...m,
          privacy: normalizeProviderPrivacy(m.privacy),
          rateLimitKind: normalizeRateLimitKind(m.rateLimitKind),
          rateLimitWindows: normalizeRateLimitWindows(m.rateLimitWindows),
        }));

      return {
        manifests: approvedManifests,
        offline,
        notice,
      };
    } catch (err) {
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
    const body: Record<string, unknown> = {
      manifest,
      ...manifest,
    };
    if (adapterUrl && adapterUrl.trim().length > 0) {
      body.adapterUrl = adapterUrl.trim();
    }
    try {
      const raw = await request<unknown>('/api/marketplace/install', {
        method: 'POST',
        body: JSON.stringify({ manifest, adapterUrl: body.adapterUrl }),
      });
      const r = asRecord(raw);
      return normalizeProviderSummary(r.provider ?? raw);
    } catch (err) {
      if (err instanceof ApiError && (err.status === 404 || err.status === 400)) {
        const rawFallback = await request<unknown>('/api/providers', {
          method: 'POST',
          body: JSON.stringify(body),
        });
        const rFallback = asRecord(rawFallback);
        return normalizeProviderSummary(rFallback.provider ?? rawFallback);
      }
      throw err;
    }
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
      status: input.status ?? (input.enabled === true ? 'active' : 'disabled'),
    };
    if (typeof input.dailyQuotaLimit === 'number' && input.dailyQuotaLimit > 0) {
      payload.dailyQuotaLimit = input.dailyQuotaLimit;
    }
    if (input.nodeId !== undefined) {
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

  async toggleProviderKey(
    providerId: string,
    keyId: string,
    enabled: boolean
  ): Promise<ProviderKeyItem> {
    const raw = await request<unknown>(
      `/api/providers/${encodeURIComponent(providerId)}/keys/${encodeURIComponent(keyId)}/toggle`,
      {
        method: 'PATCH',
        body: JSON.stringify({ enabled }),
      }
    );
    const r = asRecord(raw);
    return normalizeProviderKey(r.key ?? raw);
  },

  testProviderKey(providerId: string, keyId: string): Promise<ProviderKeyTestResult> {
    return request<ProviderKeyTestResult>(
      `/api/providers/${encodeURIComponent(providerId)}/keys/${encodeURIComponent(keyId)}/test`,
      { method: 'POST' }
    );
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

  setModelVisibility(
    fullId: string,
    disabled: boolean
  ): Promise<{ ok: boolean; fullId: string; disabledByAdmin: boolean }> {
    return request<{ ok: boolean; fullId: string; disabledByAdmin: boolean }>(
      '/api/models/visibility',
      {
        method: 'POST',
        body: JSON.stringify({ fullId, disabled }),
      }
    );
  },

  /* Internal API Keys (Phase 1: HU-03b) */

  getKeys(): Promise<KeysListResponse> {
    return request<KeysListResponse>('/api/keys', { method: 'GET' });
  },

  createKey(
    name: string,
    options?: { expiresInDays?: number | null; expiresAt?: number | null }
  ): Promise<CreateKeyResponse> {
    const body: Record<string, unknown> = { name };
    if (options?.expiresInDays !== undefined) {
      body.expiresInDays = options.expiresInDays;
    }
    if (options?.expiresAt !== undefined) {
      body.expiresAt = options.expiresAt;
    }
    return request<CreateKeyResponse>('/api/keys', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  },

  revokeKey(id: string): Promise<{ ok: boolean }> {
    return request<{ ok: boolean }>(`/api/keys/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
  },

  /* System Update Status (HU-41 Capa 1) */

  getHealth(): Promise<{ ok: boolean; version?: string; buildCommit?: string | null }> {
    return request<{ ok: boolean; version?: string; buildCommit?: string | null }>(
      '/api/health',
      { method: 'GET' }
    );
  },

  getUpdateStatus(refresh?: boolean): Promise<SystemUpdateStatus> {
    const query = refresh ? '?refresh=1' : '';
    return request<SystemUpdateStatus>(`/api/system/update-status${query}`, {
      method: 'GET',
    });
  },

  triggerSystemUpdate(): Promise<{
    ok: boolean;
    upToDate?: boolean;
    mode: 'watchtower' | 'native';
    message: string;
    restarting: boolean;
  }> {
    return request<{
      ok: boolean;
      upToDate?: boolean;
      mode: 'watchtower' | 'native';
      message: string;
      restarting: boolean;
    }>('/api/system/update', {
      method: 'POST',
    });
  },

  updateNode(nodeId: string): Promise<{
    ok: boolean;
    upToDate?: boolean;
    message: string;
    restarting: boolean;
  }> {
    return request<{
      ok: boolean;
      upToDate?: boolean;
      message: string;
      restarting: boolean;
    }>(`/api/nodes/${encodeURIComponent(nodeId)}/update`, {
      method: 'POST',
    });
  },
};
