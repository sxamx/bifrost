import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { api, ApiError } from '../api';
import type {
  ArtificialWatchAxis,
  BenchmarkSourceKey,
  ModelBenchmarksData,
  ProviderModelItem,
} from '../types';
import { InfoTip } from './InfoTip';
import { BenchmarkSourceIcon } from './ProviderLogo';

interface ModelBenchmarksPanelProps {
  fullId: string;
  modelName: string;
  allModels: ProviderModelItem[];
  onSelectPeerModel: (targetFullId: string) => void;
}

interface TechTermProps {
  term: string;
  tip: string;
  onOpenMethodology: () => void;
}

const TechTerm: React.FC<TechTermProps> = ({ term, tip, onOpenMethodology }) => (
  <button
    type="button"
    className="term-chip"
    onClick={onOpenMethodology}
    aria-label={`${term}: ${tip}. Haz clic para abrir metodología detallada.`}
  >
    <span>{term}</span>
    <span aria-hidden="true" style={{ fontSize: '0.72rem', opacity: 0.85 }}>
      ⓘ
    </span>
    <span className="term-popup" role="tooltip">
      {tip}
    </span>
  </button>
);

function formatCapturedUtc(val: string | null | undefined): string {
  if (!val) return 'Fecha de captura no reportada';
  const num = Number(val);
  if (Number.isFinite(num) && num > 1_000_000_000) {
    const ms = num < 10_000_000_000 ? num * 1000 : num;
    return `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
  }
  const parsed = Date.parse(val);
  if (!Number.isNaN(parsed)) {
    return `${new Date(parsed).toISOString().slice(0, 10)} UTC`;
  }
  return val;
}

function resolvePeerTargetFullId(
  peerFullId: string | null | undefined,
  peerModelId: string,
  allModels: ProviderModelItem[]
): { targetFullId: string; inLocalCatalog: boolean } {
  const cleanFull = (peerFullId ?? '').trim();
  const cleanModel = peerModelId.trim();

  const exact = allModels.find(
    (m) =>
      (cleanFull && m.fullId.toLowerCase() === cleanFull.toLowerCase()) ||
      m.fullId.toLowerCase() === cleanModel.toLowerCase() ||
      (m.canonicalModelId && m.canonicalModelId.toLowerCase() === cleanModel.toLowerCase()) ||
      m.modelId.toLowerCase() === cleanModel.toLowerCase()
  );

  if (exact) {
    return { targetFullId: exact.fullId, inLocalCatalog: true };
  }

  return {
    targetFullId: cleanFull || cleanModel,
    inLocalCatalog: false,
  };
}

interface RadarChartProps {
  axes: ArtificialWatchAxis[];
}

const PercentileRadarChart: React.FC<RadarChartProps> = ({ axes }) => {
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);

  if (axes.length === 0) {
    return (
      <p className="field-hint">
        Esta captura de ArtificialWatch aún no desglosa ejes individuales para este modelo.
      </p>
    );
  }

  if (axes.length < 3) {
    return (
      <div className="horiz-err-grid">
        {axes.map((ax, idx) => (
          <div
            key={ax.axisKey || idx}
            className="horiz-err-item"
            onMouseEnter={() => setHoveredIdx(idx)}
            onMouseLeave={() => setHoveredIdx(null)}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
              <strong style={{ fontSize: '0.88rem' }}>{ax.label}</strong>
              <span className="mono" style={{ fontWeight: 700, color: 'var(--accent)' }}>
                Percentil P{Math.round(ax.percentile)}
              </span>
            </div>
            <div className="horiz-track">
              <div
                className="horiz-fill"
                style={{
                  width: `${Math.max(2, Math.min(100, ax.percentile))}%`,
                  background: 'var(--accent)',
                }}
              />
            </div>
            <span className="field-hint" style={{ fontSize: '0.78rem' }}>
              Tablero origen: <strong>{ax.sourceBoard}</strong>
              {hoveredIdx === idx && typeof ax.index === 'number'
                ? ` · Índice nativo: ${ax.index.toFixed(1)}`
                : ''}
            </span>
          </div>
        ))}
      </div>
    );
  }

  const size = 340;
  const cx = size / 2;
  const cy = size / 2;
  const maxR = 112;
  const rings = [25, 50, 75, 100];
  const count = axes.length;

  const angleFor = (i: number) => -Math.PI / 2 + (i * 2 * Math.PI) / count;

  const pointFor = (i: number, pct: number) => {
    const clamped = Math.max(0, Math.min(100, pct));
    const r = (clamped / 100) * maxR;
    const a = angleFor(i);
    return {
      x: cx + r * Math.cos(a),
      y: cy + r * Math.sin(a),
    };
  };

  const dataPolygon = axes
    .map((ax, i) => {
      const pt = pointFor(i, ax.percentile);
      return `${pt.x.toFixed(1)},${pt.y.toFixed(1)}`;
    })
    .join(' ');

  const hoveredAxis = hoveredIdx !== null ? axes[hoveredIdx] : null;

  return (
    <div className="radar-split-grid">
      <div className="svg-chart-wrap" style={{ position: 'relative' }}>
        <svg
          viewBox={`0 0 ${size} ${size}`}
          className="svg-chart"
          role="img"
          aria-label="Gráfico radar de percentiles por eje en ArtificialWatch"
        >
          {rings.map((ring) => {
            const pts = axes
              .map((_, i) => {
                const p = pointFor(i, ring);
                return `${p.x.toFixed(1)},${p.y.toFixed(1)}`;
              })
              .join(' ');
            return (
              <polygon
                key={ring}
                points={pts}
                fill="none"
                stroke="#d6e3f3"
                strokeWidth={ring === 50 ? 1.4 : 1}
                strokeDasharray={ring === 50 ? '3 3' : undefined}
              />
            );
          })}

          {axes.map((ax, i) => {
            const outer = pointFor(i, 100);
            const labelPt = pointFor(i, 122);
            const isHovered = hoveredIdx === i;
            return (
              <g key={ax.axisKey || i}>
                <line
                  x1={cx}
                  y1={cy}
                  x2={outer.x}
                  y2={outer.y}
                  stroke={isHovered ? 'var(--accent)' : '#c4d4e8'}
                  strokeWidth={isHovered ? 1.8 : 1}
                />
                <text
                  x={labelPt.x}
                  y={labelPt.y}
                  textAnchor="middle"
                  dominantBaseline="middle"
                  fill={isHovered ? 'var(--accent)' : 'var(--sub)'}
                  fontSize="10.5"
                  fontWeight={isHovered ? 800 : 600}
                  style={{ cursor: 'pointer' }}
                  onMouseEnter={() => setHoveredIdx(i)}
                  onMouseLeave={() => setHoveredIdx(null)}
                >
                  {ax.label.length > 16 ? `${ax.label.slice(0, 15)}…` : ax.label}
                </text>
              </g>
            );
          })}

          <polygon
            points={dataPolygon}
            fill="rgba(0, 87, 255, 0.14)"
            stroke="var(--accent)"
            strokeWidth="2.2"
          />

          {axes.map((ax, i) => {
            const pt = pointFor(i, ax.percentile);
            const isHovered = hoveredIdx === i;
            return (
              <g
                key={`vertex-${ax.axisKey || i}`}
                style={{ cursor: 'pointer' }}
                onMouseEnter={() => setHoveredIdx(i)}
                onMouseLeave={() => setHoveredIdx(null)}
              >
                <circle cx={pt.x} cy={pt.y} r={12} fill="transparent" />
                <circle
                  cx={pt.x}
                  cy={pt.y}
                  r={isHovered ? 6 : 4.2}
                  fill={isHovered ? 'var(--accent)' : '#ffffff'}
                  stroke="var(--accent)"
                  strokeWidth="2.2"
                />
              </g>
            );
          })}
        </svg>

        {hoveredAxis ? (
          <div
            className="floating-white-tooltip"
            style={{ top: 10, right: 10, maxWidth: 230 }}
            role="status"
          >
            <div style={{ fontWeight: 800, color: 'var(--fg)', marginBottom: 4 }}>
              {hoveredAxis.label}
            </div>
            <div style={{ fontSize: '0.8rem', color: 'var(--accent)', fontWeight: 700 }}>
              Percentil P{Math.round(hoveredAxis.percentile)} (escala 0–100)
            </div>
            {typeof hoveredAxis.index === 'number' ? (
              <div className="mono" style={{ fontSize: '0.75rem', color: 'var(--sub)' }}>
                Índice eje: {hoveredAxis.index.toFixed(1)}
              </div>
            ) : null}
            <div
              style={{
                fontSize: '0.75rem',
                color: 'var(--sub)',
                marginTop: 4,
                paddingTop: 4,
                borderTop: '1px solid var(--line)',
              }}
            >
              Tablero origen: <strong>{hoveredAxis.sourceBoard}</strong>
            </div>
          </div>
        ) : null}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <span className="field-hint" style={{ fontWeight: 700 }}>
          Desglose por capacidad (pasa el cursor para ver el tablero fuente):
        </span>
        {axes.map((ax, i) => {
          const isHovered = hoveredIdx === i;
          return (
            <div
              key={`legend-${ax.axisKey || i}`}
              onMouseEnter={() => setHoveredIdx(i)}
              onMouseLeave={() => setHoveredIdx(null)}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 10,
                padding: '8px 12px',
                borderRadius: 10,
                border: `1px solid ${isHovered ? 'var(--accent)' : 'var(--line)'}`,
                background: isHovered ? 'var(--accent-soft)' : 'var(--surface-muted)',
                cursor: 'pointer',
                transition: 'background-color 0.14s ease, border-color 0.14s ease',
              }}
            >
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                <span style={{ fontWeight: 700, fontSize: '0.85rem', color: 'var(--fg)' }}>
                  {ax.label}
                </span>
                <span style={{ fontSize: '0.75rem', color: 'var(--sub)' }}>
                  Fuente: {ax.sourceBoard}
                </span>
              </div>
              <span className="mono" style={{ fontWeight: 700, color: 'var(--accent)' }}>
                P{Math.round(ax.percentile)}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
};

export const ModelBenchmarksPanel: React.FC<ModelBenchmarksPanelProps> = ({
  fullId,
  modelName,
  allModels,
  onSelectPeerModel,
}) => {
  const [activeSource, setActiveSource] = useState<BenchmarkSourceKey>('lmarena');
  const [data, setData] = useState<ModelBenchmarksData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [methodologyModalOpen, setMethodologyModalOpen] = useState(false);

  const loadBenchmarks = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.getModelBenchmarks(fullId);
      setData(res);
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.message
          : 'No se pudieron cargar las capturas de benchmarks públicos para este modelo.'
      );
    } finally {
      setLoading(false);
    }
  }, [fullId]);

  useEffect(() => {
    void loadBenchmarks();
  }, [loadBenchmarks]);

  const lmMaxScore = useMemo(() => {
    if (!data?.lmarena.rankingPeers.length) return 1500;
    return Math.max(...data.lmarena.rankingPeers.map((p) => p.score), data.lmarena.score ?? 100, 1);
  }, [data]);

  const lmMinScore = useMemo(() => {
    if (!data?.lmarena.rankingPeers.length) return 800;
    const minVal = Math.min(...data.lmarena.rankingPeers.map((p) => p.score));
    return Math.max(0, minVal * 0.88);
  }, [data]);

  return (
    <section className="card" aria-labelledby="benchmarks-card-heading">
      <div
        className="card-header"
        style={{ alignItems: 'flex-start', flexWrap: 'wrap', gap: 14 }}
      >
        <div>
          <h2 id="benchmarks-card-heading" className="card-title">
            Benchmarks públicos verificados (4 fuentes)
            <InfoTip text="Comparativa curada de 4 fuentes públicas independientes con atribución explícita, licencias abiertas y navegación directa entre modelos pares." />
          </h2>
          <p className="field-hint" style={{ marginTop: 4 }}>
            Evaluaciones de referencia para <strong>{modelName}</strong> (
            <code className="mono">{fullId}</code>). Haz clic en cualquier modelo par del ranking
            para saltar a su ficha.
          </p>
        </div>

        <div
          className="subnav-bar"
          role="tablist"
          aria-label="Fuentes de benchmarks públicos"
          style={{ flexWrap: 'wrap' }}
        >
          <button
            type="button"
            role="tab"
            aria-selected={activeSource === 'lmarena'}
            className={`subnav-btn${activeSource === 'lmarena' ? ' active' : ''}`}
            onClick={() => setActiveSource('lmarena')}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
          >
            <BenchmarkSourceIcon source="lmarena" size={15} />
            <span>LMArena</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeSource === 'artificialwatch'}
            className={`subnav-btn${activeSource === 'artificialwatch' ? ' active' : ''}`}
            onClick={() => setActiveSource('artificialwatch')}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
          >
            <BenchmarkSourceIcon source="artificialwatch" size={15} />
            <span>ArtificialWatch</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeSource === 'epoch'}
            className={`subnav-btn${activeSource === 'epoch' ? ' active' : ''}`}
            onClick={() => setActiveSource('epoch')}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
          >
            <BenchmarkSourceIcon source="epoch" size={15} />
            <span>Epoch AI</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeSource === 'opencharts'}
            className={`subnav-btn${activeSource === 'opencharts' ? ' active' : ''}`}
            onClick={() => setActiveSource('opencharts')}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
          >
            <BenchmarkSourceIcon source="opencharts" size={15} />
            <span>OpenCharts</span>
          </button>
        </div>
      </div>

      {loading ? (
        <p className="field-hint">Cargando datos de benchmarks públicos…</p>
      ) : error ? (
        <div className="alert alert-warning" role="status">
          <div style={{ flex: 1 }}>
            <strong>Benchmarks no disponibles temporalmente:</strong> {error}
          </div>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={() => void loadBenchmarks()}
          >
            Reintentar
          </button>
        </div>
      ) : !data ? null : (
        <>
          {/* SOURCE 1: LMArena (agent/latest, CC BY 4.0) */}
          {activeSource === 'lmarena' ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 12,
                  flexWrap: 'wrap',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <span className="meta-tag verified">Tablero: {data.lmarena.category}</span>
                  <span className="field-hint">
                    Puntaje nativo de agente (<strong>no es Elo clásico ni porcentaje %</strong>)
                  </span>
                </div>
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={() => setMethodologyModalOpen(true)}
                >
                  Ver metodología detallada
                </button>
              </div>

              {!data.lmarena.available && data.lmarena.score === null ? (
                <div className="empty-state" style={{ padding: '26px 18px' }}>
                  <p className="field-hint">
                    Este modelo aún no registra partidas suficientes en el tablero{' '}
                    <code className="mono">{data.lmarena.category}</code> de LMArena.
                  </p>
                </div>
              ) : (
                <>
                  <div className="kpi-grid">
                    <div className="card" style={{ padding: '18px 20px', boxShadow: 'none' }}>
                      <span className="kpi-label">Puntaje nativo LMArena</span>
                      <div
                        className="kpi-value"
                        style={{ fontSize: '1.85rem', color: 'var(--accent)', marginTop: 4 }}
                      >
                        {data.lmarena.score !== null ? data.lmarena.score.toFixed(1) : '—'}
                      </div>
                      <div style={{ marginTop: 6 }}>
                        <TechTerm
                          term="intervalo de confianza"
                          tip="Rango estadístico (95%) dentro del cual se ubica el puntaje real tras remuestreo bootstrap de duelos."
                          onOpenMethodology={() => setMethodologyModalOpen(true)}
                        />{' '}
                        <span className="mono" style={{ fontSize: '0.8rem', color: 'var(--sub)' }}>
                          {data.lmarena.ciLower !== null && data.lmarena.ciUpper !== null
                            ? `[${data.lmarena.ciLower.toFixed(1)} – ${data.lmarena.ciUpper.toFixed(1)}]`
                            : data.lmarena.ciPlusMinus !== null &&
                                data.lmarena.ciPlusMinus !== undefined
                              ? `±${data.lmarena.ciPlusMinus.toFixed(1)}`
                              : 'Sin IC'}
                        </span>
                      </div>
                    </div>

                    <div className="card" style={{ padding: '18px 20px', boxShadow: 'none' }}>
                      <span className="kpi-label">Posición en ranking</span>
                      <div className="kpi-value" style={{ fontSize: '1.65rem', marginTop: 4 }}>
                        {data.lmarena.rank !== null
                          ? `Puesto #${data.lmarena.rank}${
                              data.lmarena.totalRanked ? ` de ${data.lmarena.totalRanked}` : ''
                            }`
                          : 'Sin puesto'}
                      </div>
                      <span className="field-hint" style={{ marginTop: 6, display: 'block' }}>
                        Sesiones / votos:{' '}
                        <strong className="mono">
                          {data.lmarena.sessionsOrVotes !== null
                            ? data.lmarena.sessionsOrVotes.toLocaleString('es-ES')
                            : '—'}
                        </strong>
                      </span>
                    </div>

                    <div className="card" style={{ padding: '18px 20px', boxShadow: 'none' }}>
                      <span className="kpi-label">Costo mediano por tarea</span>
                      <div className="kpi-value" style={{ fontSize: '1.65rem', marginTop: 4 }}>
                        {data.lmarena.medianCostPerTaskUsd !== null
                          ? `$${data.lmarena.medianCostPerTaskUsd.toFixed(3)}`
                          : 'N/D'}
                      </div>
                      <span className="field-hint" style={{ marginTop: 6, display: 'block' }}>
                        En Bifrost consumes vía ruta gratuita ($0).
                      </span>
                    </div>
                  </div>

                  {data.lmarena.rankingPeers.length > 0 ? (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                      <span className="field-hint" style={{ fontWeight: 700 }}>
                        Comparativa directa en <code className="mono">{data.lmarena.category}</code>{' '}
                        (haz clic en una fila para inspeccionar ese modelo):
                      </span>
                      <div className="bench-rank-list">
                        {data.lmarena.rankingPeers.map((peer) => {
                          const isCurrent =
                            Boolean(peer.isCurrent) ||
                            peer.fullId === fullId ||
                            peer.modelId === fullId;
                          const span = Math.max(1, lmMaxScore - lmMinScore);
                          const widthPct = Math.max(
                            8,
                            Math.min(100, ((peer.score - lmMinScore) / span) * 100)
                          );
                          const resolved = resolvePeerTargetFullId(
                            peer.fullId,
                            peer.modelId,
                            allModels
                          );

                          return (
                            <button
                              key={`${peer.rank}-${peer.modelId}`}
                              type="button"
                              className={`bench-rank-row${isCurrent ? ' current' : ''}`}
                              onClick={() => onSelectPeerModel(resolved.targetFullId)}
                              title={`Abrir ficha y benchmarks de ${peer.displayName}`}
                            >
                              <span
                                className="mono"
                                style={{
                                  fontWeight: 800,
                                  color: isCurrent ? 'var(--accent)' : 'var(--sub)',
                                }}
                              >
                                #{peer.rank}
                              </span>
                              <span
                                style={{
                                  fontWeight: isCurrent ? 800 : 600,
                                  color: 'var(--fg)',
                                  overflow: 'hidden',
                                  textOverflow: 'ellipsis',
                                  whiteSpace: 'nowrap',
                                }}
                              >
                                {peer.displayName}
                                {isCurrent ? ' (Actual)' : ''}
                              </span>
                              <div className="bench-rank-bar-cell">
                                <div className="horiz-track">
                                  <div
                                    className="horiz-fill"
                                    style={{
                                      width: `${widthPct.toFixed(1)}%`,
                                      background: isCurrent ? 'var(--accent)' : '#7f9bc0',
                                    }}
                                  />
                                </div>
                              </div>
                              <span
                                className="mono"
                                style={{
                                  textAlign: 'right',
                                  fontWeight: 700,
                                  color: isCurrent ? 'var(--accent)' : 'var(--fg)',
                                }}
                              >
                                {peer.score.toFixed(1)}
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  ) : null}
                </>
              )}

              <footer className="bench-attribution-footer">
                <BenchmarkSourceIcon source="lmarena" size={16} />
                <span>
                  Fuente:{' '}
                  <a href={data.lmarena.sourceUrl} target="_blank" rel="noopener noreferrer">
                    LMArena ({data.lmarena.category})
                  </a>
                </span>
                <span>· Licencia: {data.lmarena.license}</span>
                <span>· Captura: {formatCapturedUtc(data.lmarena.capturedAt)}</span>
              </footer>
            </div>
          ) : null}

          {/* SOURCE 2: ArtificialWatch (CC BY 4.0) */}
          {activeSource === 'artificialwatch' ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 12,
                  flexWrap: 'wrap',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <TechTerm
                    term="percentil"
                    tip="Posición relativa (0–100) frente a todos los modelos evaluados; P90 supera al 90% del catálogo, NO significa 90% de aciertos."
                    onOpenMethodology={() => setMethodologyModalOpen(true)}
                  />
                  <span className="field-hint">
                    Valores expresados estrictamente como <strong>percentiles (0–100)</strong>,
                    nunca porcentaje de exactitud (%).
                  </span>
                </div>
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={() => setMethodologyModalOpen(true)}
                >
                  Ver metodología detallada
                </button>
              </div>

              {!data.artificialwatch.available &&
              data.artificialwatch.axes.length === 0 &&
              data.artificialwatch.medianPercentile === null ? (
                <div className="empty-state" style={{ padding: '26px 18px' }}>
                  <p className="field-hint">
                    ArtificialWatch no dispone aún de perfil multi-eje para este modelo.
                  </p>
                </div>
              ) : (
                <>
                  <div className="kpi-grid">
                    <div className="card" style={{ padding: '18px 20px', boxShadow: 'none' }}>
                      <span className="kpi-label">Percentil mediano global</span>
                      <div
                        className="kpi-value"
                        style={{ fontSize: '1.85rem', color: 'var(--accent)', marginTop: 4 }}
                      >
                        {data.artificialwatch.medianPercentile !== null
                          ? `P${Math.round(data.artificialwatch.medianPercentile)}`
                          : '—'}
                      </div>
                      <span className="field-hint" style={{ marginTop: 6, display: 'block' }}>
                        Posición relativa agregada entre tableros normalizados
                      </span>
                    </div>

                    <div className="card" style={{ padding: '18px 20px', boxShadow: 'none' }}>
                      <span className="kpi-label">Índice ArtificialWatch</span>
                      <div className="kpi-value" style={{ fontSize: '1.85rem', marginTop: 4 }}>
                        {data.artificialwatch.globalIndex !== null
                          ? data.artificialwatch.globalIndex.toFixed(1)
                          : '—'}
                      </div>
                      <span className="field-hint" style={{ marginTop: 6, display: 'block' }}>
                        Ejes evaluados: <strong>{data.artificialwatch.axes.length}</strong>
                      </span>
                    </div>
                  </div>

                  <PercentileRadarChart axes={data.artificialwatch.axes} />

                  {data.artificialwatch.rankingPeers &&
                  data.artificialwatch.rankingPeers.length > 0 ? (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                      <span className="field-hint" style={{ fontWeight: 700 }}>
                        Modelos cercanos por percentil mediano (clic para abrir ficha):
                      </span>
                      <div className="bench-rank-list">
                        {data.artificialwatch.rankingPeers.map((peer) => {
                          const isCurrent =
                            Boolean(peer.isCurrent) ||
                            peer.fullId === fullId ||
                            peer.modelId === fullId;
                          const resolved = resolvePeerTargetFullId(
                            peer.fullId,
                            peer.modelId,
                            allModels
                          );
                          return (
                            <button
                              key={`aw-${peer.rank}-${peer.modelId}`}
                              type="button"
                              className={`bench-rank-row${isCurrent ? ' current' : ''}`}
                              onClick={() => onSelectPeerModel(resolved.targetFullId)}
                            >
                              <span className="mono" style={{ fontWeight: 800 }}>
                                #{peer.rank}
                              </span>
                              <span style={{ fontWeight: isCurrent ? 800 : 600 }}>
                                {peer.displayName}
                                {isCurrent ? ' (Actual)' : ''}
                              </span>
                              <div className="bench-rank-bar-cell">
                                <div className="horiz-track">
                                  <div
                                    className="horiz-fill"
                                    style={{
                                      width: `${Math.max(4, Math.min(100, peer.percentile))}%`,
                                      background: isCurrent ? 'var(--accent)' : '#7f9bc0',
                                    }}
                                  />
                                </div>
                              </div>
                              <span
                                className="mono"
                                style={{ textAlign: 'right', fontWeight: 700 }}
                              >
                                P{Math.round(peer.percentile)}
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  ) : null}
                </>
              )}

              <footer className="bench-attribution-footer">
                <BenchmarkSourceIcon source="artificialwatch" size={16} />
                <span>
                  Fuente:{' '}
                  <a
                    href={data.artificialwatch.sourceUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    ArtificialWatch
                  </a>
                </span>
                <span>· Licencia: {data.artificialwatch.license}</span>
                <span>· Captura: {formatCapturedUtc(data.artificialwatch.capturedAt)}</span>
              </footer>
            </div>
          ) : null}

          {/* SOURCE 3: Epoch AI (CC BY 4.0, own internal runs only) */}
          {activeSource === 'epoch' ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 12,
                  flexWrap: 'wrap',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <span className="meta-tag verified">
                    ✓ Solo corridas propias internas de Epoch AI
                  </span>
                  <TechTerm
                    term="stderr"
                    tip="Error estándar de la media entre muestras independientes bajo el arnés reproducible Inspect."
                    onOpenMethodology={() => setMethodologyModalOpen(true)}
                  />
                  <TechTerm
                    term="FLOP"
                    tip="Operaciones de coma flotante estimadas durante el cómputo de entrenamiento del modelo."
                    onOpenMethodology={() => setMethodologyModalOpen(true)}
                  />
                  <TechTerm
                    term="token"
                    tip="Unidad sub-léxica procesada o generada durante las corridas de razonamiento del arnés."
                    onOpenMethodology={() => setMethodologyModalOpen(true)}
                  />
                </div>
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={() => setMethodologyModalOpen(true)}
                >
                  Ver metodología detallada
                </button>
              </div>

              {!data.epoch.available || data.epoch.runs.length === 0 ? (
                <div className="empty-state" style={{ padding: '26px 18px' }}>
                  <p className="field-hint">
                    Epoch AI no registra corridas internas verificadas con Inspect para este modelo.
                    (Se excluyen autorreportes externos de terceros).
                  </p>
                </div>
              ) : (
                <div className="table-wrap">
                  <table className="bf-table">
                    <thead>
                      <tr>
                        <th>Benchmark</th>
                        <th>Puntaje</th>
                        <th>Incertidumbre (±stderr)</th>
                        <th>Arnés</th>
                        <th>Fecha corrida</th>
                        <th>Cómputo / Tokens</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.epoch.runs.map((run, idx) => (
                        <tr key={`${run.benchmarkId}-${idx}`}>
                          <td style={{ fontWeight: 700 }}>{run.benchmarkName}</td>
                          <td className="mono" style={{ fontWeight: 700, color: 'var(--accent)' }}>
                            {run.score.toFixed(1)}
                            {run.unit ? ` ${run.unit}` : ''}
                          </td>
                          <td className="mono">
                            {run.stderr !== null ? `±${run.stderr.toFixed(2)}` : '—'}
                          </td>
                          <td>
                            <code className="key-prefix-pill">{run.harness || 'Inspect'}</code>
                          </td>
                          <td className="mono" style={{ fontSize: '0.82rem' }}>
                            {run.evaluatedAt ?? '—'}
                          </td>
                          <td className="mono" style={{ fontSize: '0.8rem', color: 'var(--sub)' }}>
                            {run.trainingFlop ? `${run.trainingFlop} FLOP` : ''}
                            {run.trainingFlop && run.tokensUsed ? ' · ' : ''}
                            {typeof run.tokensUsed === 'number'
                              ? `${run.tokensUsed.toLocaleString('es-ES')} tok`
                              : !run.trainingFlop
                                ? '—'
                                : ''}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              <footer className="bench-attribution-footer">
                <BenchmarkSourceIcon source="epoch" size={16} />
                <span>
                  Fuente:{' '}
                  <a href={data.epoch.sourceUrl} target="_blank" rel="noopener noreferrer">
                    Epoch AI Benchmarking Hub
                  </a>
                </span>
                <span>· Licencia: {data.epoch.license}</span>
                <span>· Captura: {formatCapturedUtc(data.epoch.capturedAt)}</span>
              </footer>
            </div>
          ) : null}

          {/* SOURCE 4: OpenCharts */}
          {activeSource === 'opencharts' ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 12,
                  flexWrap: 'wrap',
                }}
              >
                <span className="field-hint">
                  Índice compuesto multi-benchmark, calificación por letra y banda de ranking.
                </span>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <a
                    href={data.opencharts.methodologyUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="btn btn-secondary btn-sm"
                    style={{ textDecoration: 'none' }}
                  >
                    Metodología oficial OpenCharts ↗
                  </a>
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    onClick={() => setMethodologyModalOpen(true)}
                  >
                    Notas de lectura
                  </button>
                </div>
              </div>

              {!data.opencharts.available &&
              data.opencharts.compositeIndex === null &&
              !data.opencharts.grade ? (
                <div className="empty-state" style={{ padding: '26px 18px' }}>
                  <p className="field-hint">
                    OpenCharts aún no publica calificación compuesta para este modelo.
                  </p>
                </div>
              ) : (
                <>
                  <div className="kpi-grid">
                    <div className="card" style={{ padding: '18px 20px', boxShadow: 'none' }}>
                      <span className="kpi-label">Calificación (Grade)</span>
                      <div
                        className="kpi-value"
                        style={{ fontSize: '2.1rem', color: 'var(--accent)', marginTop: 4 }}
                      >
                        {data.opencharts.grade ?? '—'}
                      </div>
                      <span className="field-hint" style={{ marginTop: 6, display: 'block' }}>
                        Escala categórica OpenCharts
                      </span>
                    </div>

                    <div className="card" style={{ padding: '18px 20px', boxShadow: 'none' }}>
                      <span className="kpi-label">Índice compuesto</span>
                      <div className="kpi-value" style={{ fontSize: '1.85rem', marginTop: 4 }}>
                        {data.opencharts.compositeIndex !== null
                          ? data.opencharts.compositeIndex.toFixed(1)
                          : '—'}
                      </div>
                      <span className="field-hint" style={{ marginTop: 6, display: 'block' }}>
                        Ponderación agregada pública
                      </span>
                    </div>

                    <div className="card" style={{ padding: '18px 20px', boxShadow: 'none' }}>
                      <span className="kpi-label">Banda de ranking</span>
                      <div className="kpi-value" style={{ fontSize: '1.65rem', marginTop: 4 }}>
                        {data.opencharts.rankRange ?? '—'}
                      </div>
                      <span className="field-hint" style={{ marginTop: 6, display: 'block' }}>
                        Rango de posición frente a pares
                      </span>
                    </div>
                  </div>

                  {data.opencharts.rankingPeers && data.opencharts.rankingPeers.length > 0 ? (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                      <span className="field-hint" style={{ fontWeight: 700 }}>
                        Pares en OpenCharts (clic para navegar al modelo):
                      </span>
                      <div className="bench-rank-list">
                        {data.opencharts.rankingPeers.map((peer, idx) => {
                          const isCurrent =
                            Boolean(peer.isCurrent) ||
                            peer.fullId === fullId ||
                            peer.modelId === fullId;
                          const resolved = resolvePeerTargetFullId(
                            peer.fullId,
                            peer.modelId,
                            allModels
                          );
                          return (
                            <button
                              key={`oc-${idx}-${peer.modelId}`}
                              type="button"
                              className={`bench-rank-row${isCurrent ? ' current' : ''}`}
                              onClick={() => onSelectPeerModel(resolved.targetFullId)}
                            >
                              <span className="mono" style={{ fontWeight: 800 }}>
                                {peer.grade || `#${idx + 1}`}
                              </span>
                              <span style={{ fontWeight: isCurrent ? 800 : 600 }}>
                                {peer.displayName}
                                {isCurrent ? ' (Actual)' : ''}
                              </span>
                              <div className="bench-rank-bar-cell">
                                <div className="horiz-track">
                                  <div
                                    className="horiz-fill"
                                    style={{
                                      width: `${Math.max(5, Math.min(100, peer.compositeIndex))}%`,
                                      background: isCurrent ? 'var(--accent)' : '#7f9bc0',
                                    }}
                                  />
                                </div>
                              </div>
                              <span
                                className="mono"
                                style={{ textAlign: 'right', fontWeight: 700 }}
                              >
                                {peer.compositeIndex.toFixed(1)}
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  ) : null}
                </>
              )}

              <footer className="bench-attribution-footer">
                <BenchmarkSourceIcon source="opencharts" size={16} />
                <span>
                  Fuente:{' '}
                  <a href={data.opencharts.sourceUrl} target="_blank" rel="noopener noreferrer">
                    OpenCharts
                  </a>
                </span>
                <span>
                  ·{' '}
                  <a
                    href={data.opencharts.methodologyUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    opencharts.com/benchmarks/methodology
                  </a>
                </span>
                <span>· Captura: {formatCapturedUtc(data.opencharts.capturedAt)}</span>
              </footer>
            </div>
          ) : null}
        </>
      )}

      {/* Extended Methodology Modal (strictly deeper than brief hover popups) */}
      {methodologyModalOpen ? (
        <div
          className="modal-backdrop"
          role="dialog"
          aria-modal="true"
          aria-labelledby="bench-methodology-modal-title"
          onClick={() => setMethodologyModalOpen(false)}
        >
          <div
            className="modal-card"
            style={{ maxWidth: 640 }}
            onClick={(e) => e.stopPropagation()}
          >
            <h2 id="bench-methodology-modal-title" className="card-title">
              Metodología extendida de lectura de benchmarks
            </h2>

            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 14,
                fontSize: '0.9rem',
                color: 'var(--sub)',
                lineHeight: 1.6,
              }}
            >
              <div>
                <strong style={{ color: 'var(--fg)' }}>
                  1. LMArena (agent/latest · Modelo Bradley-Terry e IC 95%):
                </strong>
                <p>
                  Los puntajes de LMArena provienen de comparaciones pareadas a ciegas en tareas
                  agénticas reales ajustadas mediante regresión logística Bradley-Terry con control
                  de estilo. No representan porcentaje de aciertos ni Elo secuencial clásico. El
                  corredor de confianza al 95% se estima por remuestreo bootstrap sobre miles de
                  sesiones: cuando los intervalos de dos modelos se solapan, su diferencia práctica
                  es estadísticamente marginal.
                </p>
              </div>

              <div>
                <strong style={{ color: 'var(--fg)' }}>
                  2. ArtificialWatch (Normalización por percentiles entre tableros):
                </strong>
                <p>
                  Dado que distintos benchmarks tienen escalas y techos incompatibles,
                  ArtificialWatch transforma la posición de cada modelo en cada tablero origen en un
                  percentil empírico (0–100) respecto al universo de modelos activos y calcula la
                  mediana robusta entre capacidades (código, matemáticas, razonamiento, agentes).
                  Un P85 indica superar al 85% de los modelos evaluados en ese eje.
                </p>
              </div>

              <div>
                <strong style={{ color: 'var(--fg)' }}>
                  3. Epoch AI (Arnés Inspect, ±stderr y cómputo FLOP):
                </strong>
                <p>
                  Bifrost filtra exclusivamente las corridas ejecutadas internamente por Epoch AI
                  bajo el marco abierto <code className="mono">Inspect</code> con temperatura,
                  prompts y límite de tokens controlados, descartando cifras autorreportadas en
                  blogs comerciales. El término <code className="mono">±stderr</code> cuantifica la
                  dispersión muestral por pregunta; <code className="mono">FLOP</code> estima las
                  operaciones totales de coma flotante invertidas durante el preentrenamiento.
                </p>
              </div>

              <div>
                <strong style={{ color: 'var(--fg)' }}>
                  4. OpenCharts (Calificación por letra y banda de ranking):
                </strong>
                <p>
                  OpenCharts sintetiza evaluaciones abiertas verificables en un índice compuesto
                  ponderado y asigna bandas de ranking (ej. <code className="mono">#4–#7</code>) en
                  lugar de un único ordinal rígido para reflejar la variabilidad entre sub-tareas.
                  Consulta siempre los pesos vigentes en{' '}
                  <a
                    href="https://www.opencharts.com/benchmarks/methodology"
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{ color: 'var(--accent)', fontWeight: 700 }}
                  >
                    opencharts.com/benchmarks/methodology
                  </a>
                  .
                </p>
              </div>
            </div>

            <div className="modal-actions">
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => setMethodologyModalOpen(false)}
              >
                Entendido
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
};
