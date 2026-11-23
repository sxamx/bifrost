import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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

function tierColor(pct: number): string {
  if (pct >= 68) return 'var(--ok)';
  if (pct >= 42) return 'var(--warn)';
  return 'var(--err)';
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
  const [radarMode, setRadarMode] = useState<'percentile' | 'index'>('percentile');

  if (axes.length === 0) {
    return (
      <p className="field-hint">
        Esta captura de ArtificialWatch aún no desglosa ejes individuales para este modelo.
      </p>
    );
  }

  const hasIndexValues = axes.some((a) => typeof a.index === 'number');
  const maxIndex = Math.max(
    100,
    ...axes.map((a) => (typeof a.index === 'number' ? a.index : a.percentile))
  );

  const getValueForMode = (ax: ArtificialWatchAxis): number => {
    if (radarMode === 'index' && typeof ax.index === 'number') {
      return Math.max(8, Math.min(100, (ax.index / maxIndex) * 100));
    }
    return Math.max(8, Math.min(100, ax.percentile));
  };

  const getSubLabel = (ax: ArtificialWatchAxis): string => {
    if (radarMode === 'index' && typeof ax.index === 'number') {
      return `Idx: ${ax.index.toFixed(1)}`;
    }
    return `Top ${Math.max(1, 100 - Math.round(ax.percentile))}% · P${Math.round(ax.percentile)}`;
  };

  if (axes.length < 3) {
    return (
      <div className="arena-grid">
        {axes.map((ax, idx) => {
          const pct = Math.max(0, Math.min(100, ax.percentile));
          const col = tierColor(pct);
          return (
            <div
              key={ax.axisKey || idx}
              className={`arena-card${hoveredIdx === idx ? ' active' : ''}`}
              onMouseEnter={() => setHoveredIdx(idx)}
              onMouseLeave={() => setHoveredIdx(null)}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                <strong style={{ fontSize: '0.86rem' }}>{ax.label}</strong>
                <span className="mono" style={{ fontWeight: 600, color: col }}>
                  P{Math.round(ax.percentile)}
                </span>
              </div>
              <div className="horiz-track">
                <div
                  className="horiz-fill"
                  style={{
                    width: `${Math.max(4, pct)}%`,
                    background: col,
                  }}
                />
              </div>
              <span className="field-hint" style={{ fontSize: '0.75rem' }}>
                Tablero: <strong>{ax.sourceBoard}</strong>
                {typeof ax.index === 'number' ? ` · Índice: ${ax.index.toFixed(1)}` : ''}
              </span>
            </div>
          );
        })}
      </div>
    );
  }

  const svgW = 500;
  const svgH = 310;
  const cx = svgW / 2;
  const cy = svgH / 2;
  const maxR = 86;
  const rings = [25, 50, 75, 100];
  const count = axes.length;

  const angleFor = (i: number) => -Math.PI / 2 + (i * 2 * Math.PI) / count;

  const pointFor = (i: number, pct: number, clamp = true) => {
    const val = clamp ? Math.max(0, Math.min(100, pct)) : Math.max(0, pct);
    const r = (val / 100) * maxR;
    const a = angleFor(i);
    return {
      x: cx + r * Math.cos(a),
      y: cy + r * Math.sin(a),
    };
  };

  const dataPolygon = axes
    .map((ax, i) => {
      const pt = pointFor(i, getValueForMode(ax));
      return `${pt.x.toFixed(1)},${pt.y.toFixed(1)}`;
    })
    .join(' ');

  const hoveredAxis = hoveredIdx !== null ? axes[hoveredIdx] : null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {/* Design Arena style Radar Stage with Elo/Rank (Percentil/Índice) toggle */}
      <div className="radar-stage">
        <div className="radar-head">
          <span style={{ fontSize: '13px', fontWeight: 600, color: 'var(--fg)' }}>
            Category performance
          </span>
          {hasIndexValues ? (
            <div className="pill-tabs" role="group" aria-label="Escala del radar">
              <button
                type="button"
                className={`pill-tab${radarMode === 'percentile' ? ' active' : ''}`}
                onClick={() => setRadarMode('percentile')}
              >
                Percentil (P)
              </button>
              <button
                type="button"
                className={`pill-tab${radarMode === 'index' ? ' active' : ''}`}
                onClick={() => setRadarMode('index')}
              >
                Índice
              </button>
            </div>
          ) : null}
        </div>

        <div
          className="svg-chart-wrap"
          style={{ maxWidth: 520, margin: '0 auto', position: 'relative' }}
        >
          <svg
            viewBox={`0 0 ${svgW} ${svgH}`}
            className="svg-chart"
            style={{ overflow: 'visible' }}
            role="img"
            aria-label="Gráfico radar de capacidades por categoría"
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
                  stroke="var(--line-strong)"
                  strokeOpacity={0.55}
                  strokeWidth={1}
                />
              );
            })}

            {axes.map((ax, i) => {
              const outer = pointFor(i, 100);
              const labelPt = pointFor(i, 126, false);
              const isHovered = hoveredIdx === i;
              const cosA = Math.cos(angleFor(i));
              const anchor = Math.abs(cosA) < 0.2 ? 'middle' : cosA > 0 ? 'start' : 'end';

              return (
                <g
                  key={ax.axisKey || i}
                  style={{ cursor: 'pointer' }}
                  onMouseEnter={() => setHoveredIdx(i)}
                  onMouseLeave={() => setHoveredIdx(null)}
                >
                  <line
                    x1={cx}
                    y1={cy}
                    x2={outer.x}
                    y2={outer.y}
                    stroke="var(--line-strong)"
                    strokeOpacity={0.42}
                    strokeWidth={1}
                  />
                  <text
                    x={labelPt.x}
                    y={labelPt.y - 4}
                    textAnchor={anchor}
                    fill={isHovered ? 'var(--accent)' : 'var(--fg)'}
                    fontSize="11"
                    fontWeight={600}
                  >
                    {ax.label.length > 18 ? `${ax.label.slice(0, 17)}…` : ax.label}
                  </text>
                  <text
                    x={labelPt.x}
                    y={labelPt.y + 9}
                    textAnchor={anchor}
                    fill="var(--fg-3)"
                    fontSize="10"
                    fontFamily="var(--font-mono)"
                  >
                    {getSubLabel(ax)}
                  </text>
                </g>
              );
            })}

            <polygon
              points={dataPolygon}
              fill="var(--radar-fill)"
              stroke="var(--radar-stroke)"
              strokeWidth="2"
              strokeLinejoin="round"
              style={{ transition: 'all 0.32s cubic-bezier(0.16, 1, 0.3, 1)' }}
            />

            {axes.map((ax, i) => {
              const pt = pointFor(i, getValueForMode(ax));
              const isHovered = hoveredIdx === i;
              return (
                <g
                  key={`vertex-${ax.axisKey || i}`}
                  style={{ cursor: 'pointer' }}
                  onMouseEnter={() => setHoveredIdx(i)}
                  onMouseLeave={() => setHoveredIdx(null)}
                >
                  <circle cx={pt.x} cy={pt.y} r={14} fill="transparent" />
                  <circle
                    cx={pt.x}
                    cy={pt.y}
                    r={isHovered ? 10 : 4}
                    fill="var(--radar-stroke)"
                    fillOpacity={isHovered ? 0.22 : 0}
                    style={{ transition: 'all 0.24s cubic-bezier(0.16, 1, 0.3, 1)' }}
                  />
                  <circle
                    cx={pt.x}
                    cy={pt.y}
                    r={isHovered ? 5 : 3.6}
                    fill="var(--panel)"
                    stroke="var(--radar-stroke)"
                    strokeWidth={isHovered ? 2.4 : 2}
                    style={{ transition: 'all 0.24s cubic-bezier(0.16, 1, 0.3, 1)' }}
                  />
                </g>
              );
            })}
          </svg>

          {hoveredAxis ? (
            <div
              className="floating-white-tooltip"
              style={{ position: 'absolute', top: 6, right: 6, maxWidth: 230 }}
              role="status"
            >
              <div
                style={{
                  fontWeight: 600,
                  color: 'var(--tooltip-fg)',
                  marginBottom: 4,
                  paddingBottom: 4,
                  borderBottom: '1px solid var(--tooltip-line)',
                }}
              >
                {hoveredAxis.label}
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 14 }}>
                <span style={{ color: 'var(--tooltip-sub)' }}>Percentil</span>
                <strong className="mono">P{Math.round(hoveredAxis.percentile)}</strong>
              </div>
              {typeof hoveredAxis.index === 'number' ? (
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 14 }}>
                  <span style={{ color: 'var(--tooltip-sub)' }}>Índice nativo</span>
                  <strong className="mono">{hoveredAxis.index.toFixed(1)}</strong>
                </div>
              ) : null}
              <div
                style={{
                  fontSize: '0.72rem',
                  color: 'var(--tooltip-sub)',
                  marginTop: 5,
                  paddingTop: 4,
                  borderTop: '1px solid var(--tooltip-line)',
                }}
              >
                Fuente: <strong>{hoveredAxis.sourceBoard}</strong>
              </div>
            </div>
          ) : null}
        </div>
      </div>

      {/* Synchronized Arena Cards Grid (Design Arena layout from screenshots 162852.png / 162855.png) */}
      <div
        style={{
          fontSize: '10.5px',
          fontWeight: 600,
          textTransform: 'uppercase',
          letterSpacing: '0.07em',
          color: 'var(--fg-3)',
        }}
      >
        CAPABILITY ARENA · PASA EL CURSOR PARA CONECTAR CON EL RADAR
      </div>
      <div className="arena-grid">
        {axes.map((ax, i) => {
          const isHovered = hoveredIdx === i;
          const pct = Math.max(0, Math.min(100, ax.percentile));
          const topRankPct = Math.max(1, 100 - Math.round(pct));
          const col = tierColor(pct);
          const badgeBg =
            pct >= 68 ? 'var(--ok-soft)' : pct >= 42 ? 'var(--warn-soft)' : 'var(--err-soft)';

          return (
            <div
              key={`arena-card-${ax.axisKey || i}`}
              className={`arena-card${isHovered ? ' active' : ''}`}
              onMouseEnter={() => setHoveredIdx(i)}
              onMouseLeave={() => setHoveredIdx(null)}
            >
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                }}
              >
                <svg
                  width="15"
                  height="15"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="var(--fg-3)"
                  strokeWidth="1.8"
                  aria-hidden="true"
                >
                  <path d="M5 18c-2-3-2-8 1-12 2 2 3 5 2 9" />
                  <path d="M19 18c2-3 2-8-1-12-2 2-3 5-2 9" />
                  <path d="M8 20h8" />
                </svg>
                <span
                  className="mono"
                  style={{
                    fontSize: '10.5px',
                    fontWeight: 600,
                    padding: '2px 7px',
                    borderRadius: 999,
                    background: badgeBg,
                    color: col,
                  }}
                >
                  Top {topRankPct}%
                </span>
              </div>

              <div style={{ fontSize: '12.5px', fontWeight: 600, color: 'var(--fg)' }}>
                {ax.label}
              </div>

              <div
                className="font-display num"
                style={{ fontSize: '18px', fontWeight: 700, color: 'var(--fg)' }}
              >
                P{Math.round(pct)}{' '}
                <span style={{ fontSize: '11.5px', fontWeight: 500, color: 'var(--fg-3)' }}>
                  {typeof ax.index === 'number' ? `· ${ax.index.toFixed(1)} idx` : 'percentil'}
                </span>
              </div>

              <div className="horiz-track" style={{ height: 4 }}>
                <div
                  className="horiz-fill"
                  style={{ width: `${Math.max(4, pct)}%`, background: col }}
                />
              </div>

              <div className="mono" style={{ fontSize: '11px', color: 'var(--sub)' }}>
                Tablero: {ax.sourceBoard}
              </div>
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
  const benchReqIdRef = useRef(0);

  useEffect(() => {
    if (!methodologyModalOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMethodologyModalOpen(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [methodologyModalOpen]);

  const loadBenchmarks = useCallback(async () => {
    const reqId = ++benchReqIdRef.current;
    setLoading(true);
    setError(null);
    try {
      const res = await api.getModelBenchmarks(fullId);
      if (reqId !== benchReqIdRef.current) return;
      setData(res);
    } catch (err) {
      if (reqId !== benchReqIdRef.current) return;
      setError(
        err instanceof ApiError
          ? err.message
          : 'No se pudieron cargar las capturas de benchmarks públicos para este modelo.'
      );
    } finally {
      if (reqId === benchReqIdRef.current) setLoading(false);
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
          <p className="field-hint" style={{ marginTop: 3 }}>
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
          >
            <BenchmarkSourceIcon source="lmarena" size={14} />
            <span>LMArena</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeSource === 'artificialwatch'}
            className={`subnav-btn${activeSource === 'artificialwatch' ? ' active' : ''}`}
            onClick={() => setActiveSource('artificialwatch')}
          >
            <BenchmarkSourceIcon source="artificialwatch" size={14} />
            <span>ArtificialWatch</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeSource === 'epoch'}
            className={`subnav-btn${activeSource === 'epoch' ? ' active' : ''}`}
            onClick={() => setActiveSource('epoch')}
          >
            <BenchmarkSourceIcon source="epoch" size={14} />
            <span>Epoch AI</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeSource === 'opencharts'}
            className={`subnav-btn${activeSource === 'opencharts' ? ' active' : ''}`}
            onClick={() => setActiveSource('opencharts')}
          >
            <BenchmarkSourceIcon source="opencharts" size={14} />
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
          {/* SOURCE 1: LMArena */}
          {activeSource === 'lmarena' ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
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
                <div className="empty-state" style={{ padding: '24px 18px' }}>
                  <p className="field-hint">
                    Este modelo aún no registra partidas suficientes en el tablero{' '}
                    <code className="mono">{data.lmarena.category}</code> de LMArena.
                  </p>
                </div>
              ) : (
                <>
                  <div className="kpi-grid">
                    <div className="card" style={{ padding: '14px 16px' }}>
                      <span className="kpi-label">Puntaje nativo LMArena</span>
                      <div
                        className="kpi-value"
                        style={{ color: 'var(--accent)', marginTop: 4 }}
                      >
                        {data.lmarena.score !== null ? data.lmarena.score.toFixed(1) : '—'}
                      </div>
                      <div style={{ marginTop: 6 }}>
                        <TechTerm
                          term="IC 95%"
                          tip="Rango estadístico (95%) dentro del cual se ubica el puntaje real tras remuestreo bootstrap de duelos."
                          onOpenMethodology={() => setMethodologyModalOpen(true)}
                        />{' '}
                        <span className="mono" style={{ fontSize: '0.78rem', color: 'var(--sub)' }}>
                          {data.lmarena.ciLower !== null && data.lmarena.ciUpper !== null
                            ? `[${data.lmarena.ciLower.toFixed(1)} – ${data.lmarena.ciUpper.toFixed(1)}]`
                            : data.lmarena.ciPlusMinus !== null &&
                                data.lmarena.ciPlusMinus !== undefined
                              ? `±${data.lmarena.ciPlusMinus.toFixed(1)}`
                              : 'Sin IC'}
                        </span>
                      </div>
                    </div>

                    <div className="card" style={{ padding: '14px 16px' }}>
                      <span className="kpi-label">Posición en ranking</span>
                      <div className="kpi-value" style={{ marginTop: 4 }}>
                        {data.lmarena.rank !== null
                          ? `#${data.lmarena.rank}${
                              data.lmarena.totalRanked ? ` / ${data.lmarena.totalRanked}` : ''
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

                    <div className="card" style={{ padding: '14px 16px' }}>
                      <span className="kpi-label">Costo mediano por tarea</span>
                      <div className="kpi-value" style={{ marginTop: 4 }}>
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
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                      <span className="field-hint" style={{ fontWeight: 600 }}>
                        Comparativa directa en <code className="mono">{data.lmarena.category}</code>{' '}
                        (clic en una fila para inspeccionar ese modelo):
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
                                  fontWeight: 600,
                                  color: isCurrent ? 'var(--accent)' : 'var(--sub)',
                                }}
                              >
                                #{peer.rank}
                              </span>
                              <span
                                style={{
                                  fontWeight: isCurrent ? 600 : 500,
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
                                      background: isCurrent
                                        ? 'var(--accent)'
                                        : tierColor(widthPct),
                                    }}
                                  />
                                </div>
                              </div>
                              <span
                                className="mono"
                                style={{
                                  textAlign: 'right',
                                  fontWeight: 600,
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
                <BenchmarkSourceIcon source="lmarena" size={15} />
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

          {/* SOURCE 2: ArtificialWatch (Radar + Arena Cards) */}
          {activeSource === 'artificialwatch' ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
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
                    Valores expresados como <strong>percentiles (0–100)</strong> e índices por
                    categoría.
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
                <div className="empty-state" style={{ padding: '24px 18px' }}>
                  <p className="field-hint">
                    ArtificialWatch no dispone aún de perfil multi-eje para este modelo.
                  </p>
                </div>
              ) : (
                <>
                  <div className="kpi-grid">
                    <div className="card" style={{ padding: '14px 16px' }}>
                      <span className="kpi-label">Percentil mediano global</span>
                      <div
                        className="kpi-value"
                        style={{ color: 'var(--accent)', marginTop: 4 }}
                      >
                        {data.artificialwatch.medianPercentile !== null
                          ? `P${Math.round(data.artificialwatch.medianPercentile)}`
                          : '—'}
                      </div>
                      <span className="field-hint" style={{ marginTop: 6, display: 'block' }}>
                        Posición relativa agregada entre tableros normalizados
                      </span>
                    </div>

                    <div className="card" style={{ padding: '14px 16px' }}>
                      <span className="kpi-label">Índice ArtificialWatch</span>
                      <div className="kpi-value" style={{ marginTop: 4 }}>
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
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                      <span className="field-hint" style={{ fontWeight: 600 }}>
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
                          const pct = Math.max(4, Math.min(100, peer.percentile));
                          return (
                            <button
                              key={`aw-${peer.rank}-${peer.modelId}`}
                              type="button"
                              className={`bench-rank-row${isCurrent ? ' current' : ''}`}
                              onClick={() => onSelectPeerModel(resolved.targetFullId)}
                            >
                              <span className="mono" style={{ fontWeight: 600 }}>
                                #{peer.rank}
                              </span>
                              <span style={{ fontWeight: isCurrent ? 600 : 500 }}>
                                {peer.displayName}
                                {isCurrent ? ' (Actual)' : ''}
                              </span>
                              <div className="bench-rank-bar-cell">
                                <div className="horiz-track">
                                  <div
                                    className="horiz-fill"
                                    style={{
                                      width: `${pct}%`,
                                      background: isCurrent ? 'var(--accent)' : tierColor(pct),
                                    }}
                                  />
                                </div>
                              </div>
                              <span
                                className="mono"
                                style={{ textAlign: 'right', fontWeight: 600 }}
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
                <BenchmarkSourceIcon source="artificialwatch" size={15} />
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

          {/* SOURCE 3: Epoch AI (Vals AI / Horizontal Progress Bar Cards + Table) */}
          {activeSource === 'epoch' ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
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
                <div className="empty-state" style={{ padding: '24px 18px' }}>
                  <p className="field-hint">
                    Epoch AI no registra corridas internas verificadas con Inspect para este modelo.
                  </p>
                </div>
              ) : (
                <>
                  {/* Vals AI style horizontal benchmark bars (from screenshots 162905.png / 162908.png) */}
                  <div className="dual-cards-grid">
                    {data.epoch.runs.map((run, idx) => {
                      const pct = Math.max(2, Math.min(100, run.score));
                      const col = tierColor(pct);
                      return (
                        <div key={`vals-bar-${run.benchmarkId}-${idx}`} className="horiz-err-item">
                          <div
                            style={{
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'space-between',
                              gap: 10,
                            }}
                          >
                            <strong style={{ fontSize: '12.5px', color: 'var(--fg)' }}>
                              {run.benchmarkName}
                            </strong>
                            <span
                              className="meta-tag mono"
                              title="Arnés de evaluación reproducible de Epoch AI"
                            >
                              Arnés: {run.harness || 'Inspect'}
                            </span>
                          </div>
                          <span className="field-hint" style={{ fontSize: '11px' }}>
                            Updated {run.evaluatedAt ?? 'reciente'}
                            {run.stderr !== null ? ` · ±${run.stderr.toFixed(2)} stderr` : ''}
                          </span>
                          <div
                            style={{
                              display: 'grid',
                              gridTemplateColumns: '1fr 64px',
                              alignItems: 'center',
                              gap: 12,
                              marginTop: 4,
                            }}
                          >
                            <div className="horiz-track">
                              <div
                                className="horiz-fill"
                                style={{ width: `${pct}%`, background: col }}
                              />
                            </div>
                            <span
                              className="mono"
                              style={{
                                textAlign: 'right',
                                fontWeight: 600,
                                fontSize: '12px',
                                color: 'var(--fg)',
                              }}
                            >
                              {run.score.toFixed(1)}
                              {run.unit ? run.unit : '%'}
                            </span>
                          </div>
                        </div>
                      );
                    })}
                  </div>

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
                            <td style={{ fontWeight: 600 }}>{run.benchmarkName}</td>
                            <td className="mono" style={{ fontWeight: 600, color: 'var(--accent)' }}>
                              {run.score.toFixed(1)}
                              {run.unit ? ` ${run.unit}` : ''}
                            </td>
                            <td className="mono">
                              {run.stderr !== null ? `±${run.stderr.toFixed(2)}` : '—'}
                            </td>
                            <td>
                              <code className="key-prefix-pill">{run.harness || 'Inspect'}</code>
                            </td>
                            <td className="mono" style={{ fontSize: '0.8rem' }}>
                              {run.evaluatedAt ?? '—'}
                            </td>
                            <td className="mono" style={{ fontSize: '0.78rem', color: 'var(--sub)' }}>
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
                </>
              )}

              <footer className="bench-attribution-footer">
                <BenchmarkSourceIcon source="epoch" size={15} />
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
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
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
                <div className="empty-state" style={{ padding: '24px 18px' }}>
                  <p className="field-hint">
                    OpenCharts aún no publica calificación compuesta para este modelo.
                  </p>
                </div>
              ) : (
                <>
                  <div className="kpi-grid">
                    <div className="card" style={{ padding: '14px 16px' }}>
                      <span className="kpi-label">Calificación (Grade)</span>
                      <div
                        className="kpi-value"
                        style={{ color: 'var(--accent)', marginTop: 4 }}
                      >
                        {data.opencharts.grade ?? '—'}
                      </div>
                      <span className="field-hint" style={{ marginTop: 6, display: 'block' }}>
                        Escala categórica OpenCharts
                      </span>
                    </div>

                    <div className="card" style={{ padding: '14px 16px' }}>
                      <span className="kpi-label">Índice compuesto</span>
                      <div className="kpi-value" style={{ marginTop: 4 }}>
                        {data.opencharts.compositeIndex !== null
                          ? data.opencharts.compositeIndex.toFixed(1)
                          : '—'}
                      </div>
                      <span className="field-hint" style={{ marginTop: 6, display: 'block' }}>
                        Ponderación agregada pública
                      </span>
                    </div>

                    <div className="card" style={{ padding: '14px 16px' }}>
                      <span className="kpi-label">Banda de ranking</span>
                      <div className="kpi-value" style={{ marginTop: 4 }}>
                        {data.opencharts.rankRange ?? '—'}
                      </div>
                      <span className="field-hint" style={{ marginTop: 6, display: 'block' }}>
                        Rango de posición frente a pares
                      </span>
                    </div>
                  </div>

                  {data.opencharts.rankingPeers && data.opencharts.rankingPeers.length > 0 ? (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                      <span className="field-hint" style={{ fontWeight: 600 }}>
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
                          const pct = Math.max(5, Math.min(100, peer.compositeIndex));
                          return (
                            <button
                              key={`oc-${idx}-${peer.modelId}`}
                              type="button"
                              className={`bench-rank-row${isCurrent ? ' current' : ''}`}
                              onClick={() => onSelectPeerModel(resolved.targetFullId)}
                            >
                              <span className="mono" style={{ fontWeight: 600 }}>
                                {peer.grade || `#${idx + 1}`}
                              </span>
                              <span style={{ fontWeight: isCurrent ? 600 : 500 }}>
                                {peer.displayName}
                                {isCurrent ? ' (Actual)' : ''}
                              </span>
                              <div className="bench-rank-bar-cell">
                                <div className="horiz-track">
                                  <div
                                    className="horiz-fill"
                                    style={{
                                      width: `${pct}%`,
                                      background: isCurrent ? 'var(--accent)' : tierColor(pct),
                                    }}
                                  />
                                </div>
                              </div>
                              <span
                                className="mono"
                                style={{ textAlign: 'right', fontWeight: 600 }}
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
                <BenchmarkSourceIcon source="opencharts" size={15} />
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

      {/* Extended Methodology Modal */}
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
                fontSize: '0.88rem',
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
                  de estilo. No representan porcentaje de aciertos ni Elo secuencial clásico.
                </p>
              </div>

              <div>
                <strong style={{ color: 'var(--fg)' }}>
                  2. ArtificialWatch (Normalización por percentiles entre tableros):
                </strong>
                <p>
                  ArtificialWatch transforma la posición de cada modelo en cada tablero origen en un
                  percentil empírico (0–100) respecto al universo de modelos activos y calcula la
                  mediana robusta entre capacidades. Un P85 indica superar al 85% de los modelos
                  evaluados en ese eje.
                </p>
              </div>

              <div>
                <strong style={{ color: 'var(--fg)' }}>
                  3. Epoch AI (Arnés Inspect, ±stderr y cómputo FLOP):
                </strong>
                <p>
                  Bifrost filtra exclusivamente las corridas ejecutadas internamente por Epoch AI
                  bajo el marco abierto <code className="mono">Inspect</code> con temperatura,
                  prompts y límite de tokens controlados.
                </p>
              </div>

              <div>
                <strong style={{ color: 'var(--fg)' }}>
                  4. OpenCharts (Calificación por letra y banda de ranking):
                </strong>
                <p>
                  OpenCharts sintetiza evaluaciones abiertas verificables en un índice compuesto
                  ponderado y asigna bandas de ranking (ej. <code className="mono">#4–#7</code>).
                  Consulta siempre los pesos vigentes en{' '}
                  <a
                    href="https://www.opencharts.com/benchmarks/methodology"
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{ color: 'var(--accent)', fontWeight: 600 }}
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
