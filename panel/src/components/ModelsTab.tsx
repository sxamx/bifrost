import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { api, ApiError } from '../api';
import type { ProviderModelItem } from '../types';
import { InfoTip } from './InfoTip';
import { ModelBenchmarksPanel } from './ModelBenchmarksPanel';
import { ProviderLogo } from './ProviderLogo';

interface ModelsTabProps {
  onNavigateCompare?: () => void;
  onNavigatePlayground?: () => void;
}

type CapabilityFilter = 'all' | 'tools' | 'reasoning' | 'structured' | 'multimodal';

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
    return model.releaseDate.trim();
  }
  if (model.upstreamCreatedAt && Number.isFinite(model.upstreamCreatedAt)) {
    const ms =
      model.upstreamCreatedAt < 10_000_000_000
        ? model.upstreamCreatedAt * 1000
        : model.upstreamCreatedAt;
    return new Date(ms).toISOString().slice(0, 10);
  }
  return 'No reportada';
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
  onNavigateCompare,
  onNavigatePlayground,
}) => {
  const [models, setModels] = useState<ProviderModelItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [searchQuery, setSearchQuery] = useState('');
  const [providerFilter, setProviderFilter] = useState<string>('all');
  const [capFilter, setCapFilter] = useState<CapabilityFilter>('all');

  const [selectedFullId, setSelectedFullId] = useState<string | null>(null);
  const [detailModel, setDetailModel] = useState<ProviderModelItem | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const [copiedId, setCopiedId] = useState<string | null>(null);

  const loadModels = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const fetched = await api.getModels();
      setModels(fetched.filter((m) => m.active !== false));
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

  useEffect(() => {
    void loadModels();
  }, [loadModels]);

  const handleCopyModelId = useCallback((fullId: string, e?: React.MouseEvent) => {
    e?.stopPropagation();
    void navigator.clipboard.writeText(fullId);
    setCopiedId(fullId);
    window.setTimeout(() => {
      setCopiedId((prev) => (prev === fullId ? null : prev));
    }, 1800);
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
    });
  }, [models, providerFilter, capFilter, searchQuery]);

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
            className="kpi-grid"
            style={{ marginTop: 22, paddingTop: 18, borderTop: '1px solid var(--line)' }}
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

      <section className="card" style={{ padding: '18px 22px', marginBottom: 20 }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 14,
            flexWrap: 'wrap',
          }}
        >
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', flex: 1 }}>
            <input
              type="search"
              className="input"
              style={{ maxWidth: 340 }}
              placeholder="Buscar por nombre, provider/model o familia…"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />

            <select
              className="input"
              style={{ maxWidth: 230 }}
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
                          }}
                        >
                          {model.providerName || model.providerId}
                        </div>
                        <h3
                          style={{
                            fontSize: '1.02rem',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                            cursor: 'pointer',
                          }}
                          onClick={() => void openModelDetail(model.fullId)}
                        >
                          {model.name}
                        </h3>
                      </div>
                    </div>
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
                    borderTop: '1px solid #e6eef8',
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
