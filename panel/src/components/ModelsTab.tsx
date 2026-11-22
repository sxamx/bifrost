import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { api, ApiError } from '../api';
import { copyTextToClipboard } from '../clipboard';
import type {
  ActivitySeriesItem,
  ModelSpeedEntry,
  ProviderCacheEntry,
  ProviderModelItem,
  ProviderReliabilityEntry,
} from '../types';
import { InfoTip } from './InfoTip';
import { ModelBenchmarksPanel } from './ModelBenchmarksPanel';
import { ProviderLogo } from './ProviderLogo';

const MODEL_PCT_KEYS = [
  { key: 'p50' as const, label: 'P50', latCol: 'var(--c-lat-50)', tpCol: 'var(--c-tp-50)' },
  { key: 'p75' as const, label: 'P75', latCol: 'var(--c-lat-75)', tpCol: 'var(--c-tp-75)' },
  { key: 'p90' as const, label: 'P90', latCol: 'var(--c-lat-90)', tpCol: 'var(--c-tp-90)' },
  { key: 'p95' as const, label: 'P95', latCol: 'var(--c-lat-95)', tpCol: 'var(--c-tp-95)' },
  { key: 'p99' as const, label: 'P99', latCol: 'var(--c-lat-99)', tpCol: 'var(--c-tp-99)' },
];

interface ModelTelemetryBlockProps {
  model: ProviderModelItem;
}

const ModelTelemetryBlock: React.FC<ModelTelemetryBlockProps> = ({ model }) => {
  const [loading, setLoading] = useState(true);
  const [speedEntry, setSpeedEntry] = useState<ModelSpeedEntry | null>(null);
  const [cacheEntry, setCacheEntry] = useState<ProviderCacheEntry | null>(null);
  const [uptimeEntry, setUptimeEntry] = useState<ProviderReliabilityEntry | null>(null);
  const [activityEntry, setActivityEntry] = useState<ActivitySeriesItem | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    Promise.allSettled([
      api.getMetricsSpeed(),
      api.getMetricsUptime(),
      api.getMetricsActivity('7d', 'model'),
    ]).then(([spdRes, upRes, actRes]) => {
      if (cancelled) return;
      const fullLow = model.fullId.toLowerCase();
      const shortLow = model.modelId.toLowerCase();
      const provLow = model.providerId.toLowerCase();

      if (spdRes.status === 'fulfilled') {
        const mMatch =
          spdRes.value.models.find(
            (x) =>
              x.modelFullId.toLowerCase() === fullLow ||
              x.modelFullId.toLowerCase().includes(shortLow)
          ) ?? null;
        setSpeedEntry(mMatch);
        const cMatch =
          spdRes.value.cacheByProvider.find((c) => c.providerId.toLowerCase() === provLow) ?? null;
        setCacheEntry(cMatch);
      }
      if (upRes.status === 'fulfilled') {
        const uMatch =
          upRes.value.find((u) => u.providerId.toLowerCase() === provLow) ?? null;
        setUptimeEntry(uMatch);
      }
      if (actRes.status === 'fulfilled') {
        const aMatch =
          actRes.value.items.find(
            (a) =>
              a.key.toLowerCase() === fullLow ||
              a.label.toLowerCase().includes(shortLow.split(':')[0])
          ) ?? null;
        setActivityEntry(aMatch);
      }
      setLoading(false);
    });

    return () => {
      cancelled = true;
    };
  }, [model.fullId, model.modelId, model.providerId]);

  const hasAny = Boolean(speedEntry || cacheEntry || uptimeEntry || activityEntry);

  return (
    <section className="card" aria-labelledby="model-metrics-heading">
      <div className="card-header">
        <h2 id="model-metrics-heading" className="card-title">
          Rendimiento y Telemetría del modelo
          <InfoTip text="Métricas reales del enrutador Bifrost: percentiles P50–P99 de velocidad y TTFT de este modelo, más disponibilidad 60d, caché de su proveedor y volumen de tokens en 7 días." />
        </h2>
        {speedEntry ? (
          <span className="meta-tag">
            {speedEntry.sampleCount.toLocaleString('es-ES')} muestras reales
          </span>
        ) : null}
      </div>

      {loading ? (
        <p className="field-hint">Consultando telemetría de este modelo en core/…</p>
      ) : !hasAny ? (
        <p className="field-hint">
          Aún no hay tráfico registrado para <code className="mono">{model.fullId}</code>. Cuando
          hagas peticiones verás aquí sus percentiles P50–P99, caché y consumo de tokens.
        </p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div className="dual-cards-grid">
            {/* Throughput P50-P99 */}
            <div className="perf-card" style={{ background: 'var(--bg)' }}>
              <div className="perf-head">
                <span className="perf-title">Throughput</span>
                <span className="perf-sub">tok/s (P50–P99)</span>
              </div>
              {speedEntry ? (
                <div className="p-legend" style={{ borderTop: 'none', paddingTop: 0 }}>
                  {MODEL_PCT_KEYS.map((s) => (
                    <div key={`tp-${s.key}`} className="p-row">
                      <span className="p-left">
                        <i className="p-dot" style={{ background: s.tpCol }} />
                        {s.label}
                      </span>
                      <span className="p-right">
                        <strong>{speedEntry.tokensPerSec[s.key].toFixed(1)} tok/s</strong>
                      </span>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="field-hint">Sin muestras de velocidad aún para este modelo.</p>
              )}
            </div>

            {/* Latency TTFT P50-P99 */}
            <div className="perf-card" style={{ background: 'var(--bg)' }}>
              <div className="perf-head">
                <span className="perf-title">Latencia (TTFT)</span>
                <span className="perf-sub">primer token (ms)</span>
              </div>
              {speedEntry ? (
                <div className="p-legend" style={{ borderTop: 'none', paddingTop: 0 }}>
                  {MODEL_PCT_KEYS.map((s) => (
                    <div key={`ttft-${s.key}`} className="p-row">
                      <span className="p-left">
                        <i className="p-dot" style={{ background: s.latCol }} />
                        {s.label}
                      </span>
                      <span className="p-right">
                        <strong>{Math.round(speedEntry.ttftMs[s.key])} ms</strong>
                      </span>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="field-hint">Sin muestras de latencia TTFT aún para este modelo.</p>
              )}
            </div>
          </div>

          {/* Provider Uptime 60d + Cache Hit + 7d Token Activity */}
          <div className="kpi-grid">
            {uptimeEntry ? (
              <div className="horiz-err-item">
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span className="field-hint">Uptime proveedor (60d)</span>
                  <strong className="mono" style={{ color: 'var(--ok)' }}>
                    {uptimeEntry.overallUptimePct !== null
                      ? `${uptimeEntry.overallUptimePct.toFixed(2)}%`
                      : '—'}
                  </strong>
                </div>
                <div className="uptime-strip" style={{ height: 18 }}>
                  {uptimeEntry.days.slice(-30).map((d, idx) => {
                    const cls =
                      d.uptimePct === null
                        ? 'notraffic'
                        : d.uptimePct >= 99
                          ? 'ok'
                          : d.uptimePct >= 95
                            ? 'partial'
                            : 'err';
                    return (
                      <span
                        key={`mu-${idx}`}
                        className={`uptime-bar ${cls}`}
                        title={`${d.date}: ${d.uptimePct === null ? 'Sin tráfico' : `${d.uptimePct.toFixed(2)}%`}`}
                      />
                    );
                  })}
                </div>
                <span className="field-hint" style={{ fontSize: '11px' }}>
                  Tools err 7d: <strong className="mono">{uptimeEntry.toolErrorRate7d.toFixed(1)}%</strong> · JSON err:{' '}
                  <strong className="mono">{uptimeEntry.structuredErrorRate7d.toFixed(1)}%</strong>
                </span>
              </div>
            ) : null}

            {cacheEntry ? (
              <div className="horiz-err-item">
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span className="field-hint">Cache hit rate ({cacheEntry.providerName})</span>
                  <strong className="mono" style={{ color: 'var(--c-cache-hit)' }}>
                    {cacheEntry.cacheHitRate.toFixed(1)}%
                  </strong>
                </div>
                <div className="horiz-track">
                  <div
                    className="horiz-fill"
                    style={{
                      width: `${Math.min(100, Math.max(0, cacheEntry.cacheHitRate))}%`,
                      background: 'var(--c-cache-hit)',
                    }}
                  />
                </div>
                <span className="field-hint" style={{ fontSize: '11px' }}>
                  {cacheEntry.cachedTokens.toLocaleString('es-ES')} cached /{' '}
                  {cacheEntry.promptTokens.toLocaleString('es-ES')} prompt
                </span>
              </div>
            ) : null}

            {activityEntry ? (
              <div className="horiz-err-item">
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span className="field-hint">Consumo del modelo (7d)</span>
                  <strong className="mono">
                    {activityEntry.totalTokens.toLocaleString('es-ES')} tok
                  </strong>
                </div>
                <span className="field-hint" style={{ fontSize: '11px' }}>
                  Prompt: <strong className="mono">{activityEntry.promptTokens.toLocaleString('es-ES')}</strong> · Comp:{' '}
                  <strong className="mono">{activityEntry.completionTokens.toLocaleString('es-ES')}</strong>
                  {activityEntry.reasoningTokens > 0 ? (
                    <>
                      {' '}· Reas: <strong className="mono">{activityEntry.reasoningTokens.toLocaleString('es-ES')}</strong>
                    </>
                  ) : null}
                </span>
              </div>
            ) : null}
          </div>
        </div>
      )}
    </section>
  );
};

interface ModelsTabProps {
  isAdmin?: boolean;
  initialModelFullId?: string | null;
  onInitialModelConsumed?: () => void;
  onNavigateCompare?: () => void;
  onNavigatePlayground?: () => void;
}

type CapabilityFilter = 'all' | 'tools' | 'reasoning' | 'structured' | 'multimodal';
type VisibilityFilter = 'all' | 'active' | 'disabled';

function formatContextTokens(val: number | null | undefined): string {
  if (!val || val <= 0) return '—';
  if (val >= 1_000_000) {
    const m = val / 1_000_000;
    return `${Number.isInteger(m) ? m : m.toFixed(1)}M tok`;
  }
  if (val >= 1_000) {
    return `${Math.round(val / 1_000)}k tok`;
  }
  return `${val} tok`;
}

function formatFirstSeenUtc(ts: number | undefined): string {
  if (!ts || !Number.isFinite(ts)) return 'Sin registro UTC';
  const ms = ts < 10_000_000_000 ? ts * 1000 : ts;
  return `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

function formatReleaseDate(model: ProviderModelItem): string {
  if (model.releaseDate && model.releaseDate.trim()) {
    const clean = model.releaseDate.trim();
    const yearMatch = /^(\d{4})/.exec(clean);
    if (!yearMatch || Number(yearMatch[1]) >= 2018) {
      return clean;
    }
    return 'No reportada';
  }
  if (model.upstreamCreatedAt && Number.isFinite(model.upstreamCreatedAt)) {
    const ms =
      model.upstreamCreatedAt < 10_000_000_000
        ? model.upstreamCreatedAt * 1000
        : model.upstreamCreatedAt;
    const d = new Date(ms);
    if (d.getUTCFullYear() >= 2018) {
      return d.toISOString().slice(0, 10);
    }
  }
  return 'No reportada';
}

function formatPrivacyPill(
  privacy: ProviderModelItem['providerPrivacy']
): { label: string; cls: string; tip: string } | null {
  if (!privacy) return null;
  if (privacy.retention === 'zero' && privacy.training === 'never') {
    return {
      label: 'ZDR estricto',
      cls: 'meta-tag verified',
      tip: privacy.note || 'Sin retención de prompts y sin entrenamiento.',
    };
  }
  if (privacy.retention === 'retained' || privacy.training === 'allowed') {
    return {
      label: 'Sin ZDR',
      cls: 'status-badge error',
      tip: privacy.note || 'Este proveedor puede retener prompts o entrenar con ellos.',
    };
  }
  if (privacy.retention === 'variable') {
    return {
      label: 'ZDR variable',
      cls: 'status-badge rate_limited',
      tip: privacy.note || 'Depende del proveedor upstream enrutado.',
    };
  }
  return {
    label: 'Retención temporal',
    cls: 'meta-tag',
    tip: privacy.note || 'Retención temporal limitada.',
  };
}

function formatReferencePricing(model: ProviderModelItem): string {
  const refIn = model.pricing?.referencePromptPer1M;
  const refOut = model.pricing?.referenceCompletionPer1M;
  if (typeof refIn === 'number' || typeof refOut === 'number') {
    const inTxt = typeof refIn === 'number' ? `$${refIn.toFixed(2)}` : '—';
    const outTxt = typeof refOut === 'number' ? `$${refOut.toFixed(2)}` : '—';
    return `$0 / 1M · Ref. models.dev: ${inTxt} in / ${outTxt} out`;
  }
  return '$0 / 1M (Ruta gratuita)';
}

export const ModelsTab: React.FC<ModelsTabProps> = ({
  isAdmin = false,
  initialModelFullId,
  onInitialModelConsumed,
  onNavigateCompare,
  onNavigatePlayground,
}) => {
  const [models, setModels] = useState<ProviderModelItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [searchQuery, setSearchQuery] = useState('');
  const [providerFilter, setProviderFilter] = useState<string>('all');
  const [capFilter, setCapFilter] = useState<CapabilityFilter>('all');
  const [visibilityFilter, setVisibilityFilter] = useState<VisibilityFilter>('all');
  const [togglingModelId, setTogglingModelId] = useState<string | null>(null);

  const [selectedFullId, setSelectedFullId] = useState<string | null>(null);
  const [detailModel, setDetailModel] = useState<ProviderModelItem | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const [copiedId, setCopiedId] = useState<string | null>(null);

  const loadModels = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const fetched = await api.getModels();
      setModels(fetched);
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.message
          : 'No se pudo obtener el catálogo de modelos activos.'
      );
    } finally {
      setLoading(false);
    }
  }, []);

  const handleToggleModelVisibility = useCallback(
    async (model: ProviderModelItem, e?: React.MouseEvent) => {
      e?.stopPropagation();
      if (!isAdmin) return;
      setTogglingModelId(model.fullId);
      setError(null);
      try {
        const nextDisabled = !model.disabledByAdmin;
        await api.setModelVisibility(model.fullId, nextDisabled);
        setModels((prev) =>
          prev.map((m) =>
            m.fullId === model.fullId ? { ...m, disabledByAdmin: nextDisabled } : m
          )
        );
        setDetailModel((prev) =>
          prev && prev.fullId === model.fullId
            ? { ...prev, disabledByAdmin: nextDisabled }
            : prev
        );
      } catch (err) {
        setError(
          err instanceof ApiError
            ? err.message
            : 'No se pudo actualizar la visibilidad del modelo.'
        );
      } finally {
        setTogglingModelId(null);
      }
    },
    [isAdmin]
  );

  useEffect(() => {
    void loadModels();
  }, [loadModels]);

  const handleCopyModelId = useCallback((fullId: string, e?: React.MouseEvent) => {
    e?.stopPropagation();
    void copyTextToClipboard(fullId).then((ok) => {
      if (!ok) return;
      setCopiedId(fullId);
      window.setTimeout(() => {
        setCopiedId((prev) => (prev === fullId ? null : prev));
      }, 1800);
    });
  }, []);

  const openModelDetail = useCallback(
    async (targetFullId: string) => {
      setSelectedFullId(targetFullId);
      const localMatch =
        models.find((m) => m.fullId.toLowerCase() === targetFullId.toLowerCase()) ?? null;
      setDetailModel(localMatch);
      setDetailLoading(true);

      try {
        const fetchedDetail = await api.getModelDetail(targetFullId);
        setDetailModel((prev) => ({
          ...(prev ?? {}),
          ...fetchedDetail,
          fullId: fetchedDetail.fullId || targetFullId,
        }));
      } catch {
        if (!localMatch) {
          const parts = targetFullId.split('/');
          const providerId = parts.length > 1 ? parts[0] : 'referencia';
          const modelId = parts.length > 1 ? parts.slice(1).join('/') : targetFullId;
          setDetailModel({
            fullId: targetFullId,
            providerId,
            providerName: providerId,
            logoSlug: providerId,
            modelId,
            name: modelId,
            modalities: { input: ['text'], output: ['text'] },
            capabilities: { tools: false, reasoning: false, structuredOutput: false },
            isFree: true,
          });
        }
      } finally {
        setDetailLoading(false);
      }
    },
    [models]
  );

  useEffect(() => {
    if (!initialModelFullId || loading) return;
    const raw = initialModelFullId.trim();
    if (!raw) return;
    const q = raw.toLowerCase();
    const matched =
      models.find((m) => m.fullId.toLowerCase() === q) ??
      models.find((m) => m.modelId.toLowerCase() === q) ??
      models.find(
        (m) =>
          m.fullId.toLowerCase().includes(q) ||
          m.name.toLowerCase().includes(q) ||
          q.includes(m.modelId.toLowerCase().split(':')[0])
      );
    void openModelDetail(matched ? matched.fullId : raw);
    onInitialModelConsumed?.();
  }, [initialModelFullId, loading, models, openModelDetail, onInitialModelConsumed]);

  const providerOptions = useMemo(() => {
    const map = new Map<string, string>();
    for (const m of models) {
      if (!map.has(m.providerId)) {
        map.set(m.providerId, m.providerName || m.providerId);
      }
    }
    return Array.from(map.entries());
  }, [models]);

  const filteredModels = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return models.filter((m) => {
      if (visibilityFilter === 'active' && m.disabledByAdmin) return false;
      if (visibilityFilter === 'disabled' && !m.disabledByAdmin) return false;
      if (!isAdmin && m.disabledByAdmin) return false;
      if (providerFilter !== 'all' && m.providerId !== providerFilter) {
        return false;
      }
      if (capFilter === 'tools' && !m.capabilities?.tools) return false;
      if (capFilter === 'reasoning' && !m.capabilities?.reasoning) return false;
      if (capFilter === 'structured' && !m.capabilities?.structuredOutput) return false;
      if (capFilter === 'multimodal') {
        const inputs = m.modalities?.input ?? ['text'];
        const outputs = m.modalities?.output ?? ['text'];
        const nonText = [...inputs, ...outputs].some((mod) => mod !== 'text');
        if (!nonText) return false;
      }
      if (!q) return true;
      return (
        m.fullId.toLowerCase().includes(q) ||
        m.name.toLowerCase().includes(q) ||
        (m.providerName ?? '').toLowerCase().includes(q) ||
        (m.family ?? '').toLowerCase().includes(q)
      );
    }).sort((a, b) => Number(Boolean(a.disabledByAdmin)) - Number(Boolean(b.disabledByAdmin)));
  }, [models, providerFilter, capFilter, visibilityFilter, isAdmin, searchQuery]);

  /* DETAIL VIEW (HU-14, HU-14b, HU-14c, HU-15, HU-16) */
  if (selectedFullId && detailModel) {
    const inputMods = detailModel.modalities?.input?.join(', ') || 'text';
    const outputMods = detailModel.modalities?.output?.join(', ') || 'text';

    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 22 }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 12,
            flexWrap: 'wrap',
          }}
        >
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={() => {
              setSelectedFullId(null);
              setDetailModel(null);
            }}
          >
            ← Volver al catálogo de modelos
          </button>

          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            {onNavigateCompare ? (
              <button type="button" className="btn btn-secondary btn-sm" onClick={onNavigateCompare}>
                Abrir Comparador
              </button>
            ) : null}
            {onNavigatePlayground ? (
              <button
                type="button"
                className="btn btn-primary btn-sm"
                onClick={onNavigatePlayground}
              >
                Probar en Playground →
              </button>
            ) : null}
          </div>
        </div>

        {/* Model Header & Copyable provider/model ID (HU-15 + HU-14b + HU-16) */}
        <section className="card">
          <div
            style={{
              display: 'flex',
              alignItems: 'flex-start',
              justifyContent: 'space-between',
              gap: 18,
              flexWrap: 'wrap',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
              <ProviderLogo
                slug={detailModel.logoSlug || detailModel.providerId}
                name={detailModel.providerName || detailModel.providerId}
                size={52}
              />
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <span className="meta-tag">
                    {detailModel.providerName || detailModel.providerId}
                  </span>
                  {detailModel.firstSeenAt ? (
                    <span
                      className="meta-tag"
                      title="Fecha UTC en la que Bifrost detectó este modelo por primera vez"
                    >
                      Primera detección: {formatFirstSeenUtc(detailModel.firstSeenAt)}
                    </span>
                  ) : null}
                  {detailLoading ? (
                    <span className="field-hint" style={{ fontSize: '0.78rem' }}>
                      Sincronizando ficha…
                    </span>
                  ) : null}
                </div>
                <h1 className="page-title" style={{ marginTop: 6, fontSize: '1.45rem' }}>
                  {detailModel.name}
                </h1>
              </div>
            </div>

            {/* Prominent Copyable provider/model ID Box (HU-15) */}
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                padding: '10px 14px',
                borderRadius: 14,
                background: 'var(--surface-muted)',
                border: '1.5px solid var(--accent-border)',
                flexWrap: 'wrap',
              }}
            >
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                <span style={{ fontSize: '0.72rem', fontWeight: 700, color: 'var(--sub)' }}>
                  ID PARA TU SDK OPENAI (<code className="mono">model</code>)
                </span>
                <code
                  className="mono"
                  style={{ fontSize: '0.92rem', fontWeight: 700, color: 'var(--fg)' }}
                >
                  {detailModel.fullId}
                </code>
              </div>
              <button
                type="button"
                className="btn btn-primary btn-sm"
                onClick={(e) => handleCopyModelId(detailModel.fullId, e)}
              >
                {copiedId === detailModel.fullId ? '✓ Copiado' : 'Copiar ID'}
              </button>
            </div>
          </div>

          <div
            className="kpi-grid-5"
            style={{ marginTop: 18, paddingTop: 16, borderTop: '1px solid var(--line)' }}
          >
            <div>
              <span className="kpi-label">Ventana de contexto</span>
              <div className="mono" style={{ fontWeight: 700, fontSize: '1.05rem', marginTop: 4 }}>
                {formatContextTokens(detailModel.contextLength)}
              </div>
            </div>
            <div>
              <span className="kpi-label">Salida máxima</span>
              <div className="mono" style={{ fontWeight: 700, fontSize: '1.05rem', marginTop: 4 }}>
                {formatContextTokens(detailModel.maxOutput)}
              </div>
            </div>
            <div>
              <span className="kpi-label">Modalidades (E / S)</span>
              <div className="mono" style={{ fontWeight: 700, fontSize: '0.92rem', marginTop: 4 }}>
                {inputMods} → {outputMods}
              </div>
            </div>
            <div>
              <span className="kpi-label">Costo de ruta / Referencia</span>
              <div style={{ fontWeight: 700, fontSize: '0.9rem', color: 'var(--ok)', marginTop: 4 }}>
                {formatReferencePricing(detailModel)}
              </div>
            </div>
            <div>
              <span className="kpi-label">Fecha de lanzamiento</span>
              <div className="mono" style={{ fontWeight: 700, fontSize: '0.92rem', marginTop: 4 }}>
                {formatReleaseDate(detailModel)}
              </div>
            </div>
          </div>

          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 16 }}>
            {detailModel.capabilities?.tools ? (
              <span className="meta-tag verified">✓ Function Calling / Tools</span>
            ) : null}
            {detailModel.capabilities?.reasoning ? (
              <span className="meta-tag verified">✓ Reasoning / Pensamiento</span>
            ) : null}
            {detailModel.capabilities?.structuredOutput ? (
              <span className="meta-tag verified">✓ JSON / Structured Output</span>
            ) : null}
            {detailModel.canonicalModelId ? (
              <span className="meta-tag">
                Canónico: <code className="mono">{detailModel.canonicalModelId}</code>
              </span>
            ) : null}
          </div>
        </section>

        {/* Per-Model Real Telemetry (Speed P50-P99, TTFT, Cache, Uptime 60d, 7d Tokens) */}
        <ModelTelemetryBlock model={detailModel} />

        {/* 4-Source Public Benchmarks (HU-14c) */}
        <ModelBenchmarksPanel
          fullId={detailModel.fullId}
          modelName={detailModel.name}
          allModels={models}
          onSelectPeerModel={(targetId) => void openModelDetail(targetId)}
        />
      </div>
    );
  }

  /* CATALOG LIST VIEW */
  return (
    <>
      <header className="page-header">
        <div>
          <h1 className="page-title">
            Catálogo de modelos activos
            <InfoTip text="Modelos gratuitos detectados en tus proveedores activos. Copia el identificador exacto provider/model para usarlo en cualquier cliente compatible con OpenAI." />
          </h1>
          <p className="page-subtitle">
            Explora ventanas de contexto, modalidades, fecha de primera detección UTC y benchmarks
            públicos verificados de cada modelo permitido en tu cuenta.
          </p>
        </div>

        <button
          type="button"
          className="btn btn-secondary btn-sm"
          onClick={() => void loadModels()}
          disabled={loading}
        >
          {loading ? 'Actualizando…' : 'Actualizar catálogo'}
        </button>
      </header>

      {error ? (
        <div className="alert alert-error" role="alert">
          <span>{error}</span>
        </div>
      ) : null}

      <section className="card" style={{ padding: '16px 20px', marginBottom: 20 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
            <input
              type="search"
              className="input"
              style={{ flex: '1 1 240px', minWidth: 0, maxWidth: 420 }}
              placeholder="Buscar por nombre, provider/model o familia…"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />

            <select
              className="input"
              style={{ flex: '0 1 240px', minWidth: 190 }}
              aria-label="Filtrar por proveedor"
              value={providerFilter}
              onChange={(e) => setProviderFilter(e.target.value)}
            >
              <option value="all">Todos los proveedores ({providerOptions.length})</option>
              {providerOptions.map(([id, label]) => (
                <option key={id} value={id}>
                  {label}
                </option>
              ))}
            </select>
          </div>

          <div
            style={{
              display: 'flex',
              gap: 10,
              flexWrap: 'wrap',
              alignItems: 'center',
              justifyContent: 'space-between',
            }}
          >
            {isAdmin ? (
              <div className="subnav-bar" role="group" aria-label="Filtro por estado de visibilidad">
                {(
                  [
                    ['all', 'Todos'],
                    ['active', 'Activos'],
                    ['disabled', 'Deshabilitados'],
                  ] as const
                ).map(([key, label]) => (
                  <button
                    key={`vis-${key}`}
                    type="button"
                    className={`subnav-btn${visibilityFilter === key ? ' active' : ''}`}
                    onClick={() => setVisibilityFilter(key)}
                  >
                    {label}
                  </button>
                ))}
              </div>
            ) : null}

            <div className="subnav-bar" role="group" aria-label="Filtro por capacidad">
            {(
              [
                ['all', 'Todos'],
                ['tools', 'Tools'],
                ['reasoning', 'Reasoning'],
                ['structured', 'JSON Schema'],
                ['multimodal', 'Multimodal'],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                type="button"
                className={`subnav-btn${capFilter === key ? ' active' : ''}`}
                onClick={() => setCapFilter(key)}
              >
                {label}
              </button>
            ))}
            </div>
          </div>
        </div>
      </section>

      {loading && models.length === 0 ? (
        <section className="card">
          <p className="field-hint">Cargando modelos activos del router…</p>
        </section>
      ) : filteredModels.length === 0 ? (
        <section className="card">
          <div className="empty-state">
            <h2 className="card-title">
              {models.length === 0
                ? 'Aún no hay modelos sincronizados en Bifrost'
                : 'Ningún modelo coincide con los filtros actuales'}
            </h2>
            <p className="field-hint" style={{ maxWidth: 480 }}>
              {models.length === 0
                ? 'Cuando el administrador instale un proveedor, guarde una clave y sincronice su catálogo, los modelos gratuitos aparecerán aquí.'
                : 'Prueba limpiando la búsqueda o seleccionando «Todos» en los filtros superiores.'}
            </p>
            {models.length > 0 ? (
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={() => {
                  setSearchQuery('');
                  setProviderFilter('all');
                  setCapFilter('all');
                }}
              >
                Limpiar filtros
              </button>
            ) : null}
          </div>
        </section>
      ) : (
        <div className="models-catalog-grid">
          {filteredModels.map((model) => {
            const inputMods = model.modalities?.input?.join(', ') || 'text';
            const outputMods = model.modalities?.output?.join(', ') || 'text';

            return (
              <article key={model.fullId} className="model-catalog-card">
                <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: 10,
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
                      <ProviderLogo
                        slug={model.logoSlug || model.providerId}
                        name={model.providerName || model.providerId}
                        size={38}
                      />
                      <div style={{ minWidth: 0 }}>
                        <div
                          style={{
                            fontSize: '0.76rem',
                            fontWeight: 700,
                            color: 'var(--sub)',
                            textTransform: 'uppercase',
                            letterSpacing: '0.03em',
                            display: 'flex',
                            alignItems: 'center',
                            gap: 6,
                            flexWrap: 'wrap',
                          }}
                        >
                          <span>{model.providerName || model.providerId}</span>
                          {model.hasCatalogInfo ? (
                            <span className="meta-tag accent" style={{ textTransform: 'none' }}>
                              Catálogo
                            </span>
                          ) : null}
                          {(() => {
                            const p = formatPrivacyPill(model.providerPrivacy);
                            return p ? (
                              <span
                                className={p.cls}
                                style={{ textTransform: 'none', display: 'inline-flex', alignItems: 'center', gap: 4 }}
                                title={p.tip}
                              >
                                {p.label}
                              </span>
                            ) : null;
                          })()}
                          {model.disabledByAdmin ? (
                            <span className="status-badge offline" style={{ textTransform: 'none' }}>
                              Deshabilitado
                            </span>
                          ) : null}
                        </div>
                        <h3
                          style={{
                            fontSize: '1.02rem',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                            cursor: 'pointer',
                            opacity: model.disabledByAdmin ? 0.58 : 1,
                          }}
                          onClick={() => void openModelDetail(model.fullId)}
                        >
                          {model.name}
                        </h3>
                      </div>
                    </div>

                    {isAdmin ? (
                      <button
                        type="button"
                        className="btn btn-secondary btn-sm"
                        disabled={togglingModelId === model.fullId}
                        onClick={(e) => void handleToggleModelVisibility(model, e)}
                      >
                        {togglingModelId === model.fullId
                          ? '…'
                          : model.disabledByAdmin
                            ? 'Habilitar'
                            : 'Deshabilitar'}
                      </button>
                    ) : null}
                  </div>

                  {/* Copyable provider/model ID on every card (HU-15) */}
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: 8,
                      padding: '7px 10px',
                      borderRadius: 10,
                      background: 'var(--surface-muted)',
                      border: '1px solid var(--line)',
                    }}
                  >
                    <code
                      className="mono"
                      style={{
                        fontSize: '0.8rem',
                        fontWeight: 600,
                        color: 'var(--fg)',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                      title={model.fullId}
                    >
                      {model.fullId}
                    </code>
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm"
                      style={{ padding: '4px 9px', fontSize: '0.75rem', flexShrink: 0 }}
                      onClick={(e) => handleCopyModelId(model.fullId, e)}
                    >
                      {copiedId === model.fullId ? '✓ Copiado' : 'Copiar'}
                    </button>
                  </div>

                  <div className="compare-spec-list" style={{ gap: 7 }}>
                    <div className="compare-spec-row" style={{ paddingBottom: 6 }}>
                      <span className="compare-spec-label">Contexto / Salida</span>
                      <span className="mono" style={{ fontWeight: 700, fontSize: '0.82rem' }}>
                        {formatContextTokens(model.contextLength)} /{' '}
                        {formatContextTokens(model.maxOutput)}
                      </span>
                    </div>
                    <div className="compare-spec-row" style={{ paddingBottom: 6 }}>
                      <span className="compare-spec-label">Modalidades</span>
                      <span className="mono" style={{ fontSize: '0.8rem' }}>
                        {inputMods} → {outputMods}
                      </span>
                    </div>
                    <div className="compare-spec-row" style={{ paddingBottom: 6 }}>
                      <span className="compare-spec-label">Precio ruta</span>
                      <span style={{ fontWeight: 700, fontSize: '0.8rem', color: 'var(--ok)' }}>
                        {formatReferencePricing(model)}
                      </span>
                    </div>
                    <div className="compare-spec-row" style={{ paddingBottom: 6 }}>
                      <span className="compare-spec-label">Lanzamiento</span>
                      <span className="mono" style={{ fontSize: '0.8rem' }}>
                        {formatReleaseDate(model)}
                      </span>
                    </div>
                  </div>

                  {/* First-seen UTC badge (HU-16) & capability tags */}
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    {model.firstSeenAt ? (
                      <span
                        className="meta-tag"
                        style={{ fontSize: '0.72rem' }}
                        title="Primera vez visto por Bifrost (UTC)"
                      >
                        1.ª vez: {formatFirstSeenUtc(model.firstSeenAt)}
                      </span>
                    ) : null}
                    {model.capabilities?.tools ? <span className="meta-tag">Tools</span> : null}
                    {model.capabilities?.reasoning ? (
                      <span className="meta-tag">Reasoning</span>
                    ) : null}
                    {model.capabilities?.structuredOutput ? (
                      <span className="meta-tag">JSON</span>
                    ) : null}
                  </div>
                </div>

                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'flex-end',
                    paddingTop: 10,
                    borderTop: '1px solid var(--line)',
                  }}
                >
                  <button
                    type="button"
                    className="btn btn-primary btn-sm"
                    onClick={() => void openModelDetail(model.fullId)}
                  >
                    Ver ficha y benchmarks →
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </>
  );
};
