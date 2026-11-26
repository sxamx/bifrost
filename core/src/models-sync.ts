import type { DatabaseSync } from 'node:sqlite';
import { normalizeLogoSlug } from './catalog/logos.js';
import {
  MIN_VALID_MODEL_TIMESTAMP_SEC,
  type ModelsDevSnapshot,
  loadModelsDevSnapshot,
  parseReleaseDateToUtcSeconds,
  resolveCanonicalAndEnrichModel,
  stripFreeAndDateSuffix,
} from './catalog/models-dev.js';
import { decryptSecret } from './crypto.js';
import { redactSecretsInText, writeSystemLog } from './db.js';
import {
  type NodeMode,
  type UpstreamTlsOptions,
  fetchViaExitNode,
} from './nodes.js';
import {
  type ProviderFreeRule,
  type ProviderManifest,
  type ProviderPrivacyConfig,
  buildProviderAuthHeaders,
} from './schema.js';

export const AUTO_SYNC_INTERVAL_SEC = 6 * 3600; // 6 hours (HU-16)
export const AUTO_SYNC_INTERVAL_MS = AUTO_SYNC_INTERVAL_SEC * 1000;

export interface FormattedModelItem {
  fullId: string;
  providerId: string;
  providerName?: string;
  providerPrivacy?: ProviderPrivacyConfig | null;
  logoSlug?: string;
  modelId: string;
  canonicalModelId: string | null;
  name: string;
  family?: string | null;
  contextLength: number | null;
  maxOutput: number | null;
  modalities: {
    input: string[];
    output: string[];
  };
  capabilities: {
    tools: boolean;
    reasoning: boolean;
    structuredOutput: boolean;
  };
  pricing?: {
    referencePromptPer1M: number | null;
    referenceCompletionPer1M: number | null;
  } | null;
  releaseDate?: string | null;
  isFree: boolean;
  firstSeenAt: number;
  upstreamCreatedAt: number | null;
  active: boolean;
  disabledByAdmin: boolean;
  hasCatalogInfo: boolean;
}

interface NormalizedCandidateModel {
  fullId: string;
  providerId: string;
  modelId: string;
  canonicalModelId: string | null;
  name: string;
  contextLength: number | null;
  maxOutput: number | null;
  modalities: {
    input: string[];
    output: string[];
  };
  capabilities: {
    tools: boolean;
    reasoning: boolean;
    structuredOutput: boolean;
  };
  upstreamCreatedAt: number | null;
}

export interface ModelSyncResult {
  addedCount: number;
  updatedCount: number;
  removedCount: number;
  retiredCount: number;
  totalActive: number;
  total: number;
  summary: string;
  reviewedAt: string | null;
  syncedAt: number;
  models: FormattedModelItem[];
}

export interface AutoSyncProviderSummary {
  providerId: string;
  status: 'synced' | 'error';
  added: number;
  updated: number;
  removedOrDeactivated: number;
  errorMessage?: string;
}

export interface AutoSyncTickResult {
  syncedAt: number;
  providersChecked: number;
  skippedStaticOrDisabled: number;
  summaries: AutoSyncProviderSummary[];
}

function getByDottedPath(obj: unknown, pathStr: string): unknown {
  const parts = pathStr.split('.');
  let current: unknown = obj;
  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== 'object') {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function isZeroPriceValue(val: unknown): boolean {
  if (val === 0) return true;
  if (typeof val === 'string') {
    const trimmed = val.trim();
    if (trimmed.length === 0) return false;
    const num = Number(trimmed);
    return Number.isFinite(num) && num === 0;
  }
  return false;
}

function matchesFreeRule(rawModel: Record<string, unknown>, freeRule?: ProviderFreeRule): boolean {
  const modelId = typeof rawModel.id === 'string' ? rawModel.id.trim() : '';
  if (!modelId) return false;

  const modelType = typeof rawModel.type === 'string' ? rawModel.type.toLowerCase() : '';
  if (
    modelType === 'rerank' ||
    modelType === 'moderation' ||
    modelType === 'tts' ||
    modelType === 'stt' ||
    modelType === 'audio' ||
    modelType === 'image'
  ) {
    return false;
  }

  const arch =
    rawModel.architecture && typeof rawModel.architecture === 'object'
      ? (rawModel.architecture as Record<string, unknown>)
      : null;
  if (arch && Array.isArray(arch.output_modalities) && arch.output_modalities.length > 0) {
    const outputs = arch.output_modalities.map((m) => String(m).toLowerCase());
    if (
      !outputs.includes('text') &&
      !outputs.includes('embedding') &&
      !outputs.includes('embeddings')
    ) {
      return false;
    }
  }

  if (!freeRule) {
    return true;
  }

  if (Array.isArray(freeRule.priceZeroPaths) && freeRule.priceZeroPaths.length > 0) {
    for (const dottedPath of freeRule.priceZeroPaths) {
      const val = getByDottedPath(rawModel, dottedPath);
      if (!isZeroPriceValue(val)) {
        return false;
      }
    }
  }

  if (typeof freeRule.idSuffix === 'string' && freeRule.idSuffix.length > 0) {
    if (!modelId.endsWith(freeRule.idSuffix)) {
      return false;
    }
  }

  if (typeof freeRule.requiredEndpoint === 'string' && freeRule.requiredEndpoint.length > 0) {
    const reqEp = freeRule.requiredEndpoint;
    const rawEndpoints =
      rawModel.endpoints ?? rawModel.supported_endpoints ?? rawModel.endpoint ?? undefined;

    if (typeof rawEndpoints === 'string') {
      if (rawEndpoints !== reqEp && !rawEndpoints.endsWith(reqEp)) {
        return false;
      }
    } else if (Array.isArray(rawEndpoints)) {
      const matched = rawEndpoints.some((entry) => {
        if (typeof entry === 'string') {
          return entry === reqEp || entry.endsWith(reqEp);
        }
        if (entry && typeof entry === 'object') {
          const rec = entry as Record<string, unknown>;
          const candidate = String(rec.path ?? rec.endpoint ?? rec.url ?? '');
          return candidate === reqEp || candidate.endsWith(reqEp);
        }
        return false;
      });
      if (!matched) {
        return false;
      }
    } else {
      return false;
    }
  }

  return true;
}

function mergeUniqueStrings(primary: string[], secondary?: string[] | null): string[] {
  const set = new Set<string>();
  for (const item of primary) {
    const cleaned = item.trim().toLowerCase();
    if (cleaned) set.add(cleaned);
  }
  if (secondary) {
    for (const item of secondary) {
      const cleaned = item.trim().toLowerCase();
      if (cleaned) set.add(cleaned);
    }
  }
  return set.size > 0 ? Array.from(set) : ['text'];
}

function normalizeUpstreamApiModel(
  providerId: string,
  rawModel: Record<string, unknown>,
  snapshot: ModelsDevSnapshot,
): NormalizedCandidateModel {
  const modelId = String(rawModel.id).trim();
  const fullId = `${providerId}/${modelId}`;

  const rawCanonicalSlug =
    typeof rawModel.canonical_slug === 'string' && rawModel.canonical_slug.trim()
      ? rawModel.canonical_slug.trim()
      : typeof rawModel.canonicalModelId === 'string' && rawModel.canonicalModelId.trim()
        ? rawModel.canonicalModelId.trim()
        : null;

  const enriched = resolveCanonicalAndEnrichModel(providerId, modelId, snapshot, {
    canonicalSlug: rawCanonicalSlug,
  });

  const explicitUpstreamName =
    typeof rawModel.name === 'string' && rawModel.name.trim().length > 0
      ? rawModel.name.trim()
      : null;
  const name = explicitUpstreamName ?? enriched.name ?? modelId;

  let canonicalModelId: string | null = enriched.canonicalModelId;
  if (!canonicalModelId) {
    if (rawCanonicalSlug) {
      canonicalModelId = stripFreeAndDateSuffix(rawCanonicalSlug);
    } else if (/:free$/i.test(modelId) || /-free$/i.test(modelId)) {
      canonicalModelId = stripFreeAndDateSuffix(modelId);
    }
  }

  const topProvider =
    rawModel.top_provider && typeof rawModel.top_provider === 'object'
      ? (rawModel.top_provider as Record<string, unknown>)
      : null;

  const rawContext = rawModel.context_length ?? rawModel.contextLength ?? null;
  const upstreamContextLength =
    typeof rawContext === 'number' && Number.isFinite(rawContext) && rawContext > 0
      ? Math.floor(rawContext)
      : null;
  const contextLength = upstreamContextLength ?? enriched.contextLength;

  const rawMaxOut =
    rawModel.max_output ??
    rawModel.maxOutput ??
    rawModel.max_completion_tokens ??
    topProvider?.max_completion_tokens ??
    null;
  const upstreamMaxOutput =
    typeof rawMaxOut === 'number' && Number.isFinite(rawMaxOut) && rawMaxOut > 0
      ? Math.floor(rawMaxOut)
      : null;
  const maxOutput = upstreamMaxOutput ?? enriched.maxOutput;

  const arch =
    rawModel.architecture && typeof rawModel.architecture === 'object'
      ? (rawModel.architecture as Record<string, unknown>)
      : null;
  const modObj =
    rawModel.modalities && typeof rawModel.modalities === 'object'
      ? (rawModel.modalities as Record<string, unknown>)
      : null;

  const explicitInputMods = Array.isArray(arch?.input_modalities)
    ? arch!.input_modalities.map(String)
    : Array.isArray(modObj?.input)
      ? (modObj!.input as unknown[]).map(String)
      : [];

  const explicitOutputMods = Array.isArray(arch?.output_modalities)
    ? arch!.output_modalities.map(String)
    : Array.isArray(modObj?.output)
      ? (modObj!.output as unknown[]).map(String)
      : [];

  const inputModalities =
    explicitInputMods.length > 0
      ? mergeUniqueStrings(explicitInputMods, enriched.modalities?.input)
      : (enriched.modalities?.input ?? ['text']);

  const outputModalities =
    explicitOutputMods.length > 0
      ? mergeUniqueStrings(explicitOutputMods, enriched.modalities?.output)
      : (enriched.modalities?.output ?? ['text']);

  const supportedParams = Array.isArray(rawModel.supported_parameters)
    ? rawModel.supported_parameters.map((p) => String(p).toLowerCase())
    : [];
  const capsObj =
    rawModel.capabilities && typeof rawModel.capabilities === 'object'
      ? (rawModel.capabilities as Record<string, unknown>)
      : null;

  const capabilities = {
    tools: Boolean(
      capsObj?.tools ||
        supportedParams.includes('tools') ||
        supportedParams.includes('tool_choice') ||
        enriched.capabilities?.tools,
    ),
    reasoning: Boolean(
      capsObj?.reasoning ||
        supportedParams.includes('reasoning') ||
        supportedParams.includes('include_reasoning') ||
        enriched.capabilities?.reasoning,
    ),
    structuredOutput: Boolean(
      capsObj?.structuredOutput ||
        capsObj?.structured_output ||
        supportedParams.includes('structured_outputs') ||
        supportedParams.includes('response_format') ||
        enriched.capabilities?.structuredOutput,
    ),
  };

  const rawCreated =
    typeof rawModel.created === 'number' &&
    Number.isFinite(rawModel.created) &&
    rawModel.created > 0
      ? Math.floor(rawModel.created)
      : null;
  const upstreamCreatedAt = rawCreated ?? parseReleaseDateToUtcSeconds(enriched.releaseDate);

  return {
    fullId,
    providerId,
    modelId,
    canonicalModelId,
    name,
    contextLength,
    maxOutput,
    modalities: {
      input: inputModalities.length > 0 ? inputModalities : ['text'],
      output: outputModalities.length > 0 ? outputModalities : ['text'],
    },
    capabilities,
    upstreamCreatedAt,
  };
}

export function formatModelRow(
  row: Record<string, unknown>,
  enrichmentContext?: {
    providerName?: string;
    providerPrivacy?: ProviderPrivacyConfig | null;
    modelsDevSnapshot?: ModelsDevSnapshot;
  },
): FormattedModelItem {
  let modalities = { input: ['text'], output: ['text'] };
  try {
    const parsed = JSON.parse(String(row.modalities_json ?? '{}')) as {
      input?: unknown[];
      output?: unknown[];
    };
    if (Array.isArray(parsed.input) && Array.isArray(parsed.output)) {
      modalities = {
        input: parsed.input.map(String),
        output: parsed.output.map(String),
      };
    }
  } catch {
    // Keep default modalities
  }

  let capabilities = { tools: false, reasoning: false, structuredOutput: false };
  try {
    const parsed = JSON.parse(String(row.capabilities_json ?? '{}')) as Record<string, unknown>;
    capabilities = {
      tools: Boolean(parsed.tools),
      reasoning: Boolean(parsed.reasoning),
      structuredOutput: Boolean(parsed.structuredOutput ?? parsed.structured_output),
    };
  } catch {
    // Keep default capabilities
  }

  const providerId = String(row.provider_id);
  const modelId = String(row.model_id);
  const canonicalModelId =
    row.canonical_model_id === null || row.canonical_model_id === undefined
      ? null
      : String(row.canonical_model_id);

  const rawUpstreamCreated =
    row.upstream_created_at === null || row.upstream_created_at === undefined
      ? null
      : Number(row.upstream_created_at);
  const validUpstreamCreated =
    rawUpstreamCreated !== null &&
    Number.isFinite(rawUpstreamCreated) &&
    rawUpstreamCreated >= MIN_VALID_MODEL_TIMESTAMP_SEC
      ? rawUpstreamCreated
      : null;

  const contextLength =
    row.context_length === null || row.context_length === undefined
      ? null
      : Number(row.context_length);
  const maxOutput =
    row.max_output === null || row.max_output === undefined ? null : Number(row.max_output);
  const disabledByAdmin = Number(row.disabled_by_admin ?? 0) === 1;
  const hasBaseCatalogInfo = Boolean(
    contextLength !== null ||
      maxOutput !== null ||
      capabilities.tools ||
      capabilities.reasoning ||
      capabilities.structuredOutput,
  );

  let providerPrivacy: ProviderPrivacyConfig | null = enrichmentContext?.providerPrivacy ?? null;
  if (providerPrivacy === null && typeof row.provider_schema_json === 'string') {
    try {
      const parsedManifest = JSON.parse(row.provider_schema_json) as ProviderManifest;
      providerPrivacy = parsedManifest.privacy ?? null;
    } catch {
      providerPrivacy = null;
    }
  }

  const base: FormattedModelItem = {
    fullId: String(row.full_id),
    providerId,
    providerPrivacy,
    modelId,
    canonicalModelId,
    name: String(row.name),
    contextLength,
    maxOutput,
    modalities,
    capabilities,
    isFree: Number(row.is_free ?? 1) === 1,
    firstSeenAt: Number(row.first_seen_at),
    upstreamCreatedAt: validUpstreamCreated,
    active: Number(row.active ?? 1) === 1,
    disabledByAdmin,
    hasCatalogInfo: hasBaseCatalogInfo,
  };

  if (!enrichmentContext) {
    return base;
  }

  const providerName =
    enrichmentContext.providerName ??
    (typeof row.provider_name === 'string' ? row.provider_name : undefined);
  const logoSlug = normalizeLogoSlug(providerId) ?? providerId;

  if (enrichmentContext.modelsDevSnapshot) {
    const md = resolveCanonicalAndEnrichModel(
      providerId,
      modelId,
      enrichmentContext.modelsDevSnapshot,
      { canonicalSlug: canonicalModelId },
    );
    const enrichedContextLength = base.contextLength ?? md.contextLength;
    const enrichedMaxOutput = base.maxOutput ?? md.maxOutput;
    const enrichedModalities = md.modalities
      ? {
          input: mergeUniqueStrings(base.modalities.input, md.modalities.input),
          output: mergeUniqueStrings(base.modalities.output, md.modalities.output),
        }
      : base.modalities;
    const enrichedCapabilities = md.capabilities
      ? {
          tools: base.capabilities.tools || md.capabilities.tools,
          reasoning: base.capabilities.reasoning || md.capabilities.reasoning,
          structuredOutput:
            base.capabilities.structuredOutput || md.capabilities.structuredOutput,
        }
      : base.capabilities;
    const hasCatalogInfo = Boolean(
      md.capabilities !== null ||
        enrichedContextLength !== null ||
        enrichedMaxOutput !== null ||
        md.family !== null ||
        hasBaseCatalogInfo,
    );
    return {
      ...base,
      providerName,
      logoSlug,
      canonicalModelId: base.canonicalModelId ?? md.canonicalModelId,
      contextLength: enrichedContextLength,
      maxOutput: enrichedMaxOutput,
      modalities: enrichedModalities,
      capabilities: enrichedCapabilities,
      family: md.family,
      releaseDate: md.releaseDate,
      hasCatalogInfo,
      pricing:
        md.priceUsdPerMillion.input !== null || md.priceUsdPerMillion.output !== null
          ? {
              referencePromptPer1M: md.priceUsdPerMillion.input,
              referenceCompletionPer1M: md.priceUsdPerMillion.output,
            }
          : null,
    };
  }

  return {
    ...base,
    providerName,
    logoSlug,
  };
}

export class ModelSyncHttpError extends Error {
  public readonly status: 400 | 404 | 502;

  constructor(message: string, status: 400 | 404 | 502) {
    super(message);
    this.name = 'ModelSyncHttpError';
    this.status = status;
  }
}

export async function syncProviderModels(options: {
  db: DatabaseSync;
  masterKey: Buffer;
  providerId: string;
  drainingKeys: ReadonlySet<string>;
  drainingProviders: ReadonlySet<string>;
  fetchImpl: typeof fetch;
  upstreamTls?: UpstreamTlsOptions;
  nowSec: number;
  modelsDevSnapshot?: ModelsDevSnapshot;
}): Promise<ModelSyncResult> {
  const {
    db,
    masterKey,
    providerId,
    drainingKeys,
    drainingProviders,
    fetchImpl,
    upstreamTls,
    nowSec,
  } = options;

  if (drainingProviders.has(providerId)) {
    throw new ModelSyncHttpError(`Provider "${providerId}" not found.`, 404);
  }

  const providerRow = db
    .prepare(`SELECT * FROM providers WHERE id = ?`)
    .get(providerId) as Record<string, unknown> | undefined;

  if (!providerRow) {
    throw new ModelSyncHttpError(`Provider "${providerId}" not found.`, 404);
  }

  const manifest = JSON.parse(String(providerRow.schema_json)) as ProviderManifest;

  const allKeyRows = (
    db
      .prepare(
        `SELECT pk.id, pk.label, pk.encrypted_secret, pk.status, pk.node_id,
                n.name AS node_name, n.mode AS node_mode, n.endpoint AS node_endpoint,
                n.encrypted_token AS node_encrypted_token, n.tls_fingerprint AS node_tls_fingerprint,
                n.status AS node_status
         FROM provider_keys pk
         LEFT JOIN nodes n ON n.id = pk.node_id
         WHERE pk.provider_id = ?
         ORDER BY CASE WHEN pk.status = 'active' THEN 0 ELSE 1 END, pk.created_at ASC`,
      )
      .all(providerId) as Array<Record<string, unknown>>
  ).filter((k) => !drainingKeys.has(String(k.id)));

  if (allKeyRows.length === 0) {
    throw new ModelSyncHttpError(
      `Provider "${manifest.name}" requires at least one configured API key before detecting models.`,
      400,
    );
  }

  const keyRows = allKeyRows.filter(
    (k) =>
      k.status !== 'no_node' &&
      (k.node_id === null || k.node_id === undefined || k.node_status === 'online'),
  );

  if (keyRows.length === 0) {
    throw new ModelSyncHttpError(
      `All configured keys for provider "${manifest.name}" are assigned to offline or unresponsive exit nodes.`,
      502,
    );
  }

  const snapshot =
    options.modelsDevSnapshot ??
    (await loadModelsDevSnapshot(db, { fetchFn: fetchImpl, nowSec }));

  let candidates: NormalizedCandidateModel[] = [];

  if (manifest.modelsSource === 'static') {
    decryptSecret(keyRows[0]!.encrypted_secret as Uint8Array, masterKey);

    candidates = (manifest.staticModels ?? []).map((sm) => {
      const enriched = resolveCanonicalAndEnrichModel(providerId, sm.id, snapshot, {
        canonicalSlug: sm.canonicalModelId ?? null,
      });
      return {
        fullId: `${providerId}/${sm.id}`,
        providerId,
        modelId: sm.id,
        canonicalModelId: sm.canonicalModelId ?? enriched.canonicalModelId ?? null,
        name: sm.name || enriched.name || sm.id,
        contextLength: sm.contextLength ?? enriched.contextLength ?? null,
        maxOutput: sm.maxOutput ?? enriched.maxOutput ?? null,
        modalities: enriched.modalities ?? { input: ['text'], output: ['text'] },
        capabilities: enriched.capabilities ?? {
          tools: false,
          reasoning: false,
          structuredOutput: false,
        },
        upstreamCreatedAt: parseReleaseDateToUtcSeconds(enriched.releaseDate),
      };
    });
  } else {
    const effectiveBaseUrl =
      providerRow.package_type === 'experimental-adapter' &&
      typeof providerRow.adapter_url === 'string' &&
      providerRow.adapter_url.length > 0
        ? providerRow.adapter_url
        : manifest.baseUrl;

    const endpoint = manifest.modelsEndpoint ?? '/models';
    const modelsUrl = /^https?:\/\//i.test(endpoint)
      ? endpoint
      : `${effectiveBaseUrl.replace(/\/+$/, '')}/${endpoint.replace(/^\/+/, '')}`;

    let upstreamList: unknown[] | null = null;
    let lastErrMessage = 'Unknown upstream error';

    for (const kRow of keyRows) {
      const rawSecret = decryptSecret(kRow.encrypted_secret as Uint8Array, masterKey);
      const headers = buildProviderAuthHeaders(manifest.auth, rawSecret);
      try {
        let res: Response;
        if (typeof kRow.node_id === 'string' && kRow.node_id.length > 0) {
          if (!kRow.node_encrypted_token || !kRow.node_endpoint) {
            throw new Error(
              `Assigned exit node "${kRow.node_id}" is missing tunnel credentials`,
            );
          }
          const nodeToken = decryptSecret(kRow.node_encrypted_token as Uint8Array, masterKey);
          res = await fetchViaExitNode(
            modelsUrl,
            { method: 'GET', headers },
            {
              id: kRow.node_id,
              name: String(kRow.node_name ?? kRow.node_id),
              mode: (kRow.node_mode === 'public_ip' ? 'public_ip' : 'tailscale') as NodeMode,
              endpoint: String(kRow.node_endpoint),
              rawToken: nodeToken,
              tlsFingerprint:
                kRow.node_tls_fingerprint === null || kRow.node_tls_fingerprint === undefined
                  ? null
                  : String(kRow.node_tls_fingerprint),
            },
            upstreamTls,
          );
        } else {
          res = await fetchImpl(modelsUrl, {
            method: 'GET',
            headers,
            redirect: 'error',
          });
        }

        if (!res.ok) {
          lastErrMessage = `Upstream returned HTTP ${res.status}`;
          continue;
        }
        const json = (await res.json()) as unknown;
        if (Array.isArray(json)) {
          upstreamList = json;
        } else if (json && typeof json === 'object') {
          const obj = json as Record<string, unknown>;
          if (Array.isArray(obj.data)) {
            upstreamList = obj.data;
          } else if (Array.isArray(obj.models)) {
            upstreamList = obj.models;
          }
        }
        if (upstreamList !== null) {
          break;
        }
        lastErrMessage = 'Upstream response did not contain a models array';
      } catch (err) {
        const rawMsg = err instanceof Error ? err.message : String(err);
        lastErrMessage = redactSecretsInText(rawMsg);
      }
    }

    if (upstreamList === null) {
      writeSystemLog(
        db,
        'error',
        'sync',
        `Failed to sync models for provider "${providerId}": ${lastErrMessage}`,
        { providerId },
        nowSec,
      );
      throw new ModelSyncHttpError(
        `Failed to query models from "${manifest.name}": ${lastErrMessage}`,
        502,
      );
    }

    const seenFullIds = new Set<string>();
    for (const item of upstreamList) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
      const rec = item as Record<string, unknown>;
      if (!matchesFreeRule(rec, manifest.freeRule)) continue;

      const normalized = normalizeUpstreamApiModel(providerId, rec, snapshot);
      if (!seenFullIds.has(normalized.fullId)) {
        seenFullIds.add(normalized.fullId);
        candidates.push(normalized);
      }
    }
  }

  let addedCount = 0;
  let updatedCount = 0;
  let removedCount = 0;

  db.exec('BEGIN IMMEDIATE');
  try {
    const existingRows = db
      .prepare(`SELECT full_id, active, first_seen_at FROM models WHERE provider_id = ?`)
      .all(providerId) as Array<{ full_id: string; active: number; first_seen_at: number }>;

    const existingMap = new Map(existingRows.map((r) => [r.full_id, r]));
    const incomingFullIds = new Set(candidates.map((c) => c.fullId));

    const insertStmt = db.prepare(
      `INSERT INTO models (
         full_id, provider_id, model_id, canonical_model_id, name,
         context_length, max_output, modalities_json, capabilities_json,
         is_free, first_seen_at, upstream_created_at, active
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, 1)`,
    );

    const updateStmt = db.prepare(
      `UPDATE models
       SET model_id = ?,
           canonical_model_id = ?,
           name = ?,
           context_length = ?,
           max_output = ?,
           modalities_json = ?,
           capabilities_json = ?,
           is_free = 1,
           upstream_created_at = COALESCE(?, upstream_created_at),
           active = 1
       WHERE full_id = ?`,
    );

    for (const m of candidates) {
      const modalitiesJson = JSON.stringify(m.modalities);
      const capabilitiesJson = JSON.stringify({
        tools: m.capabilities.tools,
        reasoning: m.capabilities.reasoning,
        structured_output: m.capabilities.structuredOutput,
        structuredOutput: m.capabilities.structuredOutput,
      });

      const prev = existingMap.get(m.fullId);
      if (!prev) {
        addedCount++;
        insertStmt.run(
          m.fullId,
          m.providerId,
          m.modelId,
          m.canonicalModelId,
          m.name,
          m.contextLength,
          m.maxOutput,
          modalitiesJson,
          capabilitiesJson,
          nowSec,
          m.upstreamCreatedAt,
        );
      } else {
        if (Number(prev.active) === 0) {
          addedCount++;
        } else {
          updatedCount++;
        }
        updateStmt.run(
          m.modelId,
          m.canonicalModelId,
          m.name,
          m.contextLength,
          m.maxOutput,
          modalitiesJson,
          capabilitiesJson,
          m.upstreamCreatedAt,
          m.fullId,
        );
      }
    }

    const hasUsageStmt = db.prepare(
      `SELECT 1 AS used FROM usage_logs WHERE model_full_id = ? LIMIT 1`,
    );
    const hasAccessStmt = db.prepare(
      `SELECT 1 AS assigned FROM user_model_access WHERE model_full_id = ? LIMIT 1`,
    );
    const deactivateStmt = db.prepare(
      `UPDATE models SET active = 0, is_free = 0 WHERE full_id = ?`,
    );
    const deleteUnusedStmt = db.prepare(`DELETE FROM models WHERE full_id = ?`);

    for (const [fullId, prev] of existingMap.entries()) {
      if (incomingFullIds.has(fullId)) continue;

      if (Number(prev.active) === 1) {
        removedCount++;
      }

      const hasHistory = Boolean(hasUsageStmt.get(fullId) || hasAccessStmt.get(fullId));
      if (hasHistory) {
        deactivateStmt.run(fullId);
      } else {
        deleteUnusedStmt.run(fullId);
      }
    }

    db.prepare(`UPDATE providers SET last_models_sync_at = ? WHERE id = ?`).run(
      nowSec,
      providerId,
    );

    const addedText = addedCount === 1 ? '1 nuevo' : `${addedCount} nuevos`;
    const removedText = removedCount === 1 ? '1 retirado' : `${removedCount} retirados`;
    const summary = `${addedText}, ${removedText}`;

    writeSystemLog(
      db,
      'info',
      'sync',
      `Synced models for provider "${providerId}": ${summary}`,
      {
        providerId,
        addedCount,
        updatedCount,
        removedCount,
        totalActive: candidates.length,
      },
      nowSec,
    );

    db.exec('COMMIT');

    const activeRows = db
      .prepare(
        `SELECT * FROM models
         WHERE provider_id = ? AND active = 1
         ORDER BY full_id ASC`,
      )
      .all(providerId) as Array<Record<string, unknown>>;

    const formattedModels = activeRows.map((r) => formatModelRow(r));

    return {
      addedCount,
      updatedCount,
      removedCount,
      retiredCount: removedCount,
      totalActive: formattedModels.length,
      total: formattedModels.length,
      summary,
      reviewedAt: manifest.reviewedAt ?? null,
      syncedAt: nowSec,
      models: formattedModels,
    };
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export interface RunModelsAutoSyncOptions {
  drainingKeys?: ReadonlySet<string>;
  drainingProviders?: ReadonlySet<string>;
  fetchImpl?: typeof fetch;
  fetchFn?: typeof fetch;
  upstreamTls?: UpstreamTlsOptions;
  nowSec?: number;
  modelsDevSnapshot?: ModelsDevSnapshot;
}

/**
 * HU-16: Automatic 6-hour sync tick updating ONLY enabled providers with `models_source = 'api'`,
 * skipping `models_source = 'static'` and disabled/draining providers, and logging secret-free
 * `'sync'` events in `system_logs`.
 */
export async function runModelsAutoSyncTick(
  dbOrParams:
    | DatabaseSync
    | ({
        db: DatabaseSync;
        masterKey: Buffer;
      } & RunModelsAutoSyncOptions),
  maybeMasterKey?: Buffer,
  maybeOptions?: RunModelsAutoSyncOptions,
): Promise<AutoSyncTickResult> {
  const isObjectCall =
    typeof dbOrParams === 'object' &&
    dbOrParams !== null &&
    'db' in dbOrParams &&
    'masterKey' in dbOrParams;

  const db = isObjectCall ? dbOrParams.db : (dbOrParams as DatabaseSync);
  const masterKey = isObjectCall ? dbOrParams.masterKey : maybeMasterKey!;
  const opts: RunModelsAutoSyncOptions = isObjectCall ? dbOrParams : (maybeOptions ?? {});

  const fetchImpl = opts.fetchImpl ?? opts.fetchFn ?? globalThis.fetch;
  const nowSec = opts.nowSec ?? Math.floor(Date.now() / 1000);
  const drainingKeys = opts.drainingKeys ?? new Set<string>();
  const drainingProviders = opts.drainingProviders ?? new Set<string>();

  const totalRow = db.prepare(`SELECT COUNT(*) AS count FROM providers`).get() as
    | { count: number | bigint }
    | undefined;
  const totalProviders = Number(totalRow?.count ?? 0);

  const eligibleRows = (
    db
      .prepare(
        `SELECT id, name
         FROM providers
         WHERE enabled = 1 AND models_source = 'api'
         ORDER BY id ASC`,
      )
      .all() as Array<{ id: string; name: string }>
  ).filter((p) => !drainingProviders.has(p.id));

  const skippedStaticOrDisabled = Math.max(0, totalProviders - eligibleRows.length);
  if (eligibleRows.length === 0) {
    return {
      syncedAt: nowSec,
      providersChecked: 0,
      skippedStaticOrDisabled,
      summaries: [],
    };
  }

  const snapshot =
    opts.modelsDevSnapshot ??
    (await loadModelsDevSnapshot(db, { fetchFn: fetchImpl, nowSec }));

  const summaries: AutoSyncProviderSummary[] = [];

  for (const prov of eligibleRows) {
    try {
      const res = await syncProviderModels({
        db,
        masterKey,
        providerId: prov.id,
        drainingKeys,
        drainingProviders,
        fetchImpl,
        upstreamTls: opts.upstreamTls,
        nowSec,
        modelsDevSnapshot: snapshot,
      });

      summaries.push({
        providerId: prov.id,
        status: 'synced',
        added: res.addedCount,
        updated: res.updatedCount,
        removedOrDeactivated: res.removedCount,
      });
    } catch (err) {
      const safeErr = redactSecretsInText(err instanceof Error ? err.message : String(err));
      if (!(err instanceof ModelSyncHttpError && err.status === 502)) {
        writeSystemLog(
          db,
          'warn',
          'sync',
          `Auto-sync skipped/failed for provider "${prov.id}": ${safeErr}`,
          { providerId: prov.id },
          nowSec,
        );
      }
      summaries.push({
        providerId: prov.id,
        status: 'error',
        added: 0,
        updated: 0,
        removedOrDeactivated: 0,
        errorMessage: safeErr,
      });
    }
  }

  return {
    syncedAt: nowSec,
    providersChecked: eligibleRows.length,
    skippedStaticOrDisabled,
    summaries,
  };
}

export const runAutoSyncFreeModels = runModelsAutoSyncTick;
