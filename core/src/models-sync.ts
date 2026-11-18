import type { DatabaseSync } from 'node:sqlite';
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
  buildProviderAuthHeaders,
} from './schema.js';

export interface FormattedModelItem {
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
  isFree: boolean;
  firstSeenAt: number;
  upstreamCreatedAt: number | null;
  active: boolean;
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
  removedCount: number;
  retiredCount: number;
  totalActive: number;
  total: number;
  summary: string;
  reviewedAt: string | null;
  syncedAt: number;
  models: FormattedModelItem[];
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
    modelType === 'embedding' ||
    modelType === 'embeddings' ||
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
    if (!outputs.includes('text')) {
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
    }
  }

  return true;
}

function normalizeUpstreamApiModel(
  providerId: string,
  rawModel: Record<string, unknown>,
): NormalizedCandidateModel {
  const modelId = String(rawModel.id).trim();
  const fullId = `${providerId}/${modelId}`;
  const name =
    typeof rawModel.name === 'string' && rawModel.name.trim().length > 0
      ? rawModel.name.trim()
      : modelId;

  let canonicalModelId: string | null = null;
  if (typeof rawModel.canonical_slug === 'string' && rawModel.canonical_slug.trim()) {
    canonicalModelId = rawModel.canonical_slug.trim();
  } else if (typeof rawModel.canonicalModelId === 'string' && rawModel.canonicalModelId.trim()) {
    canonicalModelId = rawModel.canonicalModelId.trim();
  } else if (modelId.endsWith(':free')) {
    canonicalModelId = modelId.slice(0, -5);
  }

  const topProvider =
    rawModel.top_provider && typeof rawModel.top_provider === 'object'
      ? (rawModel.top_provider as Record<string, unknown>)
      : null;

  const rawContext = rawModel.context_length ?? rawModel.contextLength ?? null;
  const contextLength =
    typeof rawContext === 'number' && Number.isFinite(rawContext) && rawContext > 0
      ? Math.floor(rawContext)
      : null;

  const rawMaxOut =
    rawModel.max_output ??
    rawModel.maxOutput ??
    rawModel.max_completion_tokens ??
    topProvider?.max_completion_tokens ??
    null;
  const maxOutput =
    typeof rawMaxOut === 'number' && Number.isFinite(rawMaxOut) && rawMaxOut > 0
      ? Math.floor(rawMaxOut)
      : null;

  const arch =
    rawModel.architecture && typeof rawModel.architecture === 'object'
      ? (rawModel.architecture as Record<string, unknown>)
      : null;
  const modObj =
    rawModel.modalities && typeof rawModel.modalities === 'object'
      ? (rawModel.modalities as Record<string, unknown>)
      : null;

  const inputModalities = Array.isArray(arch?.input_modalities)
    ? arch!.input_modalities.map(String)
    : Array.isArray(modObj?.input)
      ? (modObj!.input as unknown[]).map(String)
      : ['text'];

  const outputModalities = Array.isArray(arch?.output_modalities)
    ? arch!.output_modalities.map(String)
    : Array.isArray(modObj?.output)
      ? (modObj!.output as unknown[]).map(String)
      : ['text'];

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
        supportedParams.includes('tool_choice'),
    ),
    reasoning: Boolean(
      capsObj?.reasoning ||
        supportedParams.includes('reasoning') ||
        supportedParams.includes('include_reasoning'),
    ),
    structuredOutput: Boolean(
      capsObj?.structuredOutput ||
        capsObj?.structured_output ||
        supportedParams.includes('structured_outputs') ||
        supportedParams.includes('response_format'),
    ),
  };

  const upstreamCreatedAt =
    typeof rawModel.created === 'number' && Number.isFinite(rawModel.created) && rawModel.created > 0
      ? Math.floor(rawModel.created)
      : null;

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

export function formatModelRow(row: Record<string, unknown>): FormattedModelItem {
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

  return {
    fullId: String(row.full_id),
    providerId: String(row.provider_id),
    modelId: String(row.model_id),
    canonicalModelId:
      row.canonical_model_id === null || row.canonical_model_id === undefined
        ? null
        : String(row.canonical_model_id),
    name: String(row.name),
    contextLength:
      row.context_length === null || row.context_length === undefined
        ? null
        : Number(row.context_length),
    maxOutput:
      row.max_output === null || row.max_output === undefined ? null : Number(row.max_output),
    modalities,
    capabilities,
    isFree: Number(row.is_free ?? 1) === 1,
    firstSeenAt: Number(row.first_seen_at),
    upstreamCreatedAt:
      row.upstream_created_at === null || row.upstream_created_at === undefined
        ? null
        : Number(row.upstream_created_at),
    active: Number(row.active ?? 1) === 1,
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

  let candidates: NormalizedCandidateModel[] = [];

  if (manifest.modelsSource === 'static') {
    decryptSecret(keyRows[0]!.encrypted_secret as Uint8Array, masterKey);

    candidates = (manifest.staticModels ?? []).map((sm) => ({
      fullId: `${providerId}/${sm.id}`,
      providerId,
      modelId: sm.id,
      canonicalModelId: sm.canonicalModelId ?? null,
      name: sm.name,
      contextLength: sm.contextLength ?? null,
      maxOutput: sm.maxOutput ?? null,
      modalities: { input: ['text'], output: ['text'] },
      capabilities: { tools: false, reasoning: false, structuredOutput: false },
      upstreamCreatedAt: null,
    }));
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
        if (
          typeof kRow.node_id === 'string' &&
          kRow.node_id.length > 0 &&
          kRow.node_encrypted_token
        ) {
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

      const normalized = normalizeUpstreamApiModel(providerId, rec);
      if (!seenFullIds.has(normalized.fullId)) {
        seenFullIds.add(normalized.fullId);
        candidates.push(normalized);
      }
    }
  }

  let addedCount = 0;
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
    const deactivateStmt = db.prepare(`UPDATE models SET active = 0 WHERE full_id = ?`);
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
      { providerId, addedCount, removedCount, totalActive: candidates.length },
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

    const formattedModels = activeRows.map(formatModelRow);

    return {
      addedCount,
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
