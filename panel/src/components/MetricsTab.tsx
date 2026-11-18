import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import type {
  ActivityGroupBy,
  ActivityMetricsData,
  ActivityRange,
  LatencyBucketPoint,
  LatencyMetricsData,
  ModelSpeedEntry,
  ProviderReliabilityEntry,
  SpeedMetricsData,
  UptimeDayCell,
} from '../types';
import { InfoTip } from './InfoTip';

interface MetricsTabProps {
  isAdmin: boolean;
}

const PERCENTILE_SERIES = [
  { key: 'p50' as const, label: 'P50', color: '#0b6b5c' },
  { key: 'p75' as const, label: 'P75', color: '#0057ff' },
  { key: 'p90' as const, label: 'P90', color: '#6b4eff' },
  { key: 'p95' as const, label: 'P95', color: '#e0a040' },
  { key: 'p99' as const, label: 'P99', color: '#c0392b' },
];

function formatBucketTimeLabel(ts: string | number, label?: string): string {
  if (label) return label;
  if (typeof ts === 'number' && Number.isFinite(ts)) {
    const ms = ts < 1_000_000_000_000 ? ts * 1000 : ts;
    return new Date(ms).toISOString().replace('T', ' ').slice(5, 16) + ' UTC';
  }
  const str = String(ts);
  if (str.includes('T')) {
    return str.replace('T', ' ').slice(5, 16) + ' UTC';
  }
  return str || '—';
}

function classifyUptimeBar(uptimePct: number | null): 'notraffic' | 'ok' | 'partial' | 'err' {
  if (uptimePct === null || uptimePct === undefined) return 'notraffic';
  if (uptimePct >= 99) return 'ok';
  if (uptimePct >= 95) return 'partial';
  return 'err';
}

function errorBarColor(ratePct: number): string {
  if (ratePct <= 0) return 'var(--ok)';
  if (ratePct < 5) return 'var(--partial)';
  return 'var(--err)';
}

export const MetricsTab: React.FC<MetricsTabProps> = ({ isAdmin }) => {
  const [latencyData, setLatencyData] = useState<LatencyMetricsData>({ buckets: [] });
  const [speedData, setSpeedData] = useState<SpeedMetricsData>({
    models: [],
    cacheByProvider: [],
  });
  const [uptimeList, setUptimeList] = useState<ProviderReliabilityEntry[]>([]);
  const [coreLoading, setCoreLoading] = useState(true);

  // HU-20b Activity Controls & State
  const [activityRange, setActivityRange] = useState<ActivityRange>('7d');
  const [activityGroupBy, setActivityGroupBy] = useState<ActivityGroupBy>('model');
  const [selectedEntityFilter, setSelectedEntityFilter] = useState<string>('ALL');
  const [activityData, setActivityData] = useState<ActivityMetricsData>({
    range: '7d',
    groupBy: 'model',
    totals: {
      promptTokens: 0,
      completionTokens: 0,
      reasoningTokens: 0,
      totalTokens: 0,
    },
    items: [],
  });
  const [activityLoading, setActivityLoading] = useState(true);

  // Interactive hover states (zero cursor:help — pure pointer + floating white tooltips)
  const [hoveredLatencyIndex, setHoveredLatencyIndex] = useState<number | null>(null);
  const [hoveredSpeedModel, setHoveredSpeedModel] = useState<ModelSpeedEntry | null>(null);
  const [hoveredUptimeCell, setHoveredUptimeCell] = useState<{
    providerId: string;
    providerName: string;
    dayIndex: number;
    day: UptimeDayCell;
  } | null>(null);
  const [hoveredActivityIndex, setHoveredActivityIndex] = useState<number | null>(null);

  const loadTelemetry = useCallback(async () => {
    setCoreLoading(true);
    const [latRes, spdRes, upRes] = await Promise.allSettled([
      api.getMetricsLatency('24h'),
      api.getMetricsSpeed(),
      api.getMetricsUptime(),
    ]);

    if (latRes.status === 'fulfilled') setLatencyData(latRes.value);
    if (spdRes.status === 'fulfilled') setSpeedData(spdRes.value);
    if (upRes.status === 'fulfilled') setUptimeList(upRes.value);
    setCoreLoading(false);
  }, []);

  const loadActivity = useCallback(async () => {
    setActivityLoading(true);
    try {
      const data = await api.getMetricsActivity(activityRange, activityGroupBy);
      setActivityData(data);
      setSelectedEntityFilter('ALL');
    } catch {
      setActivityData({
        range: activityRange,
        groupBy: activityGroupBy,
        totals: {
          promptTokens: 0,
          completionTokens: 0,
          reasoningTokens: 0,
          totalTokens: 0,
        },
        items: [],
      });
    } finally {
      setActivityLoading(false);
    }
  }, [activityRange, activityGroupBy]);

  useEffect(() => {
    void loadTelemetry();
  }, [loadTelemetry]);

  useEffect(() => {
    void loadActivity();
  }, [loadActivity]);

  // Filtered activity items when user narrows down to a specific model/provider/user
  const visibleActivityItems = useMemo(() => {
    if (selectedEntityFilter === 'ALL') return activityData.items;
    return activityData.items.filter((it) => it.key === selectedEntityFilter);
  }, [activityData.items, selectedEntityFilter]);

  const displayedTotals = useMemo(() => {
    if (selectedEntityFilter === 'ALL') return activityData.totals;
    const promptTokens = visibleActivityItems.reduce((s, i) => s + i.promptTokens, 0);
    const completionTokens = visibleActivityItems.reduce((s, i) => s + i.completionTokens, 0);
    const reasoningTokens = visibleActivityItems.reduce((s, i) => s + i.reasoningTokens, 0);
    return {
      promptTokens,
      completionTokens,
      reasoningTokens,
      totalTokens: promptTokens + completionTokens + reasoningTokens,
    };
  }, [activityData.totals, selectedEntityFilter, visibleActivityItems]);

  // SVG Geometry for HU-18 Latency Percentiles Chart
  const svgW = 860;
  const svgH = 260;
  const padL = 56;
  const padR = 24;
  const padT = 20;
  const padB = 36;
  const plotW = svgW - padL - padR;
  const plotH = svgH - padT - padB;

  const latencyBuckets = latencyData.buckets;
  const maxLatencyMs = useMemo(() => {
    let m = 100;
    for (const b of latencyBuckets) {
      m = Math.max(m, b.p50, b.p75, b.p90, b.p95, b.p99);
    }
    return Math.ceil(m * 1.12);
  }, [latencyBuckets]);

  function bucketX(idx: number): number {
    if (latencyBuckets.length <= 1) return padL + plotW / 2;
    return padL + (idx / (latencyBuckets.length - 1)) * plotW;
  }

  function latencyY(msVal: number): number {
    const clamped = Math.max(0, Math.min(maxLatencyMs, msVal));
    return padT + plotH - (clamped / maxLatencyMs) * plotH;
  }

  function buildPolylinePoints(key: keyof Pick<LatencyBucketPoint, 'p50' | 'p75' | 'p90' | 'p95' | 'p99'>): string {
    return latencyBuckets
      .map((b, idx) => `${bucketX(idx).toFixed(1)},${latencyY(b[key]).toFixed(1)}`)
      .join(' ');
  }

  const activeLatencyBucket =
    hoveredLatencyIndex !== null ? latencyBuckets[hoveredLatencyIndex] ?? null : null;

  // SVG Geometry for HU-20b Stacked Token Activity Chart
  const actSvgW = 860;
  const actSvgH = 250;
  const actPlotW = actSvgW - padL - padR;
  const actPlotH = actSvgH - padT - 44;

  const maxActivityTokens = useMemo(() => {
    let m = 10;
    for (const item of visibleActivityItems) {
      m = Math.max(m, item.promptTokens + item.completionTokens + item.reasoningTokens);
    }
    return Math.ceil(m * 1.1);
  }, [visibleActivityItems]);

  const activeActivityItem =
    hoveredActivityIndex !== null ? visibleActivityItems[hoveredActivityIndex] ?? null : null;

  return (
    <>
      <header className="page-header">
        <div>
          <h1 className="page-title">Métricas, Uptime y Actividad</h1>
          <p className="page-subtitle">
            Telemetría calculada sobre tráfico real (sin pings artificiales que consuman cuota
            gratuita): percentiles completos <code className="mono">P50–P99</code>, disponibilidad
            de 60 días y desglose de tokens.
          </p>
        </div>

        <button
          type="button"
          className="btn btn-secondary btn-sm"
          onClick={() => {
            void loadTelemetry();
            void loadActivity();
          }}
        >
          Actualizar métricas
        </button>
      </header>

      {/* 1. HU-19 & HU-20: 60-Day Provider Uptime Strip + 7-Day Tool/Structured Error Bars */}
      <section className="card" aria-labelledby="uptime-section-title">
        <div className="card-header">
          <h2 id="uptime-section-title" className="card-title">
            Disponibilidad por proveedor (últimos 60 días) y errores de capacidades (7d)
            <InfoTip text="Basado únicamente en peticiones reales de tus aplicaciones. Los días sin tráfico se muestran en gris neutro y nunca penalizan el porcentaje como 0%. Verde ≥ 99%, Ámbar 95–99%, Rojo < 95%." />
          </h2>

          <div className="pct-legend-row">
            <span className="pct-legend-item">
              <span className="status-dot ok" /> ≥ 99%
            </span>
            <span className="pct-legend-item">
              <span className="status-dot partial" /> 95–99%
            </span>
            <span className="pct-legend-item">
              <span className="status-dot err" /> &lt; 95%
            </span>
            <span className="pct-legend-item">
              <span
                className="status-dot"
                style={{ background: '#d3dfef', border: '1px solid var(--line)' }}
              />{' '}
              Sin tráfico
            </span>
          </div>
        </div>

        {coreLoading && uptimeList.length === 0 ? (
          <p className="field-hint">Calculando serie de 60 días…</p>
        ) : uptimeList.length === 0 ? (
          <div className="empty-state" style={{ padding: '26px 16px' }}>
            <p className="field-hint">
              Aún no hay proveedores con historial registrado. Al instalar proveedores verás aquí su
              tira de 60 días UTC y sus tasas de error en herramientas y salidas JSON.
            </p>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
            {uptimeList.map((prov) => {
              const hoveredHere =
                hoveredUptimeCell && hoveredUptimeCell.providerId === prov.providerId
                  ? hoveredUptimeCell
                  : null;

              return (
                <div key={prov.providerId} className="uptime-provider-block">
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: 12,
                      flexWrap: 'wrap',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      <strong style={{ fontSize: '1.02rem', color: 'var(--fg)' }}>
                        {prov.providerName}
                      </strong>
                      <code className="key-prefix-pill">{prov.providerId}</code>
                    </div>

                    <span
                      className="font-display"
                      style={{
                        fontSize: '0.96rem',
                        fontWeight: 700,
                        color:
                          prov.overallUptimePct === null
                            ? 'var(--sub)'
                            : prov.overallUptimePct >= 99
                              ? 'var(--ok)'
                              : prov.overallUptimePct >= 95
                                ? '#8a5607'
                                : 'var(--err)',
                      }}
                    >
                      {prov.overallUptimePct === null
                        ? 'Sin tráfico en 60d'
                        : `${prov.overallUptimePct.toFixed(2)}% uptime`}
                    </span>
                  </div>

                  {/* 60 vertical day bars */}
                  <div
                    className="uptime-strip"
                    role="group"
                    aria-label={`Historial de 60 días para ${prov.providerName}`}
                    onMouseLeave={() => setHoveredUptimeCell(null)}
                  >
                    {prov.days.map((day, idx) => {
                      const barClass = classifyUptimeBar(day.uptimePct);
                      return (
                        <button
                          key={`${prov.providerId}-${day.date}-${idx}`}
                          type="button"
                          className={`uptime-bar ${barClass}`}
                          aria-label={`${day.date}: ${
                            day.uptimePct === null
                              ? 'Sin tráfico'
                              : `${day.uptimePct.toFixed(2)}%`
                          } (${day.totalRequests} peticiones)`}
                          onMouseEnter={() =>
                            setHoveredUptimeCell({
                              providerId: prov.providerId,
                              providerName: prov.providerName,
                              dayIndex: idx,
                              day,
                            })
                          }
                          onFocus={() =>
                            setHoveredUptimeCell({
                              providerId: prov.providerId,
                              providerName: prov.providerName,
                              dayIndex: idx,
                              day,
                            })
                          }
                        />
                      );
                    })}
                  </div>

                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      fontSize: '0.75rem',
                      color: 'var(--sub)',
                    }}
                  >
                    <span>Hace 60 días ({prov.days[0]?.date ?? ''})</span>
                    <span>Hoy UTC ({prov.days[prov.days.length - 1]?.date ?? ''})</span>
                  </div>

                  {/* Floating white tooltip for hovered day bar */}
                  {hoveredHere ? (
                    <div
                      className="floating-white-tooltip"
                      style={{
                        position: 'absolute',
                        top: 56,
                        left: `${Math.min(
                          74,
                          Math.max(4, (hoveredHere.dayIndex / 60) * 100)
                        )}%`,
                      }}
                    >
                      <div className="mono" style={{ fontWeight: 700, marginBottom: 4 }}>
                        {hoveredHere.day.date} (UTC)
                      </div>
                      <div>
                        Disponibilidad:{' '}
                        <strong>
                          {hoveredHere.day.uptimePct === null
                            ? 'Sin tráfico registrado'
                            : `${hoveredHere.day.uptimePct.toFixed(2)}%`}
                        </strong>
                      </div>
                      <div style={{ color: 'var(--sub)' }}>
                        Peticiones reales: <strong>{hoveredHere.day.totalRequests}</strong>
                      </div>
                    </div>
                  ) : null}

                  {/* HU-20: 7-Day Horizontal Error Bars for Tools & Structured Output */}
                  <div className="horiz-err-grid">
                    <div
                      className="horiz-err-item"
                      title={`Tasa de error en llamadas a herramientas (últimos 7 días): ${prov.toolErrorRate7d.toFixed(1)}%`}
                    >
                      <div
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          fontSize: '0.82rem',
                        }}
                      >
                        <span style={{ fontWeight: 700, color: 'var(--sub)' }}>
                          Errores en Tools (7d)
                        </span>
                        <strong className="mono">{prov.toolErrorRate7d.toFixed(1)}%</strong>
                      </div>
                      <div className="horiz-track">
                        <div
                          className="horiz-fill"
                          style={{
                            width: `${Math.max(prov.toolErrorRate7d > 0 ? 3 : 0, Math.min(100, prov.toolErrorRate7d))}%`,
                            background: errorBarColor(prov.toolErrorRate7d),
                          }}
                        />
                      </div>
                    </div>

                    <div
                      className="horiz-err-item"
                      title={`Tasa de error en salidas estructuradas JSON (últimos 7 días): ${prov.structuredErrorRate7d.toFixed(1)}%`}
                    >
                      <div
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          fontSize: '0.82rem',
                        }}
                      >
                        <span style={{ fontWeight: 700, color: 'var(--sub)' }}>
                          Errores en Structured Output (7d)
                        </span>
                        <strong className="mono">
                          {prov.structuredErrorRate7d.toFixed(1)}%
                        </strong>
                      </div>
                      <div className="horiz-track">
                        <div
                          className="horiz-fill"
                          style={{
                            width: `${Math.max(prov.structuredErrorRate7d > 0 ? 3 : 0, Math.min(100, prov.structuredErrorRate7d))}%`,
                            background: errorBarColor(prov.structuredErrorRate7d),
                          }}
                        />
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* 2. HU-18: Latency Percentiles (P50, P75, P90, P95, P99 TOGETHER) */}
      <section className="card" aria-labelledby="latency-section-title">
        <div className="card-header">
          <h2 id="latency-section-title" className="card-title">
            Latencia de extremo a extremo por percentiles (ms)
            <InfoTip text="P50 es la mediana (50% de peticiones más rápidas que ese valor), mientras que P90, P95 y P99 revelan las colas lentas o congestión puntual en proveedores gratuitos." />
          </h2>

          <div className="pct-legend-row">
            {PERCENTILE_SERIES.map((s) => (
              <span key={s.key} className="pct-legend-item">
                <span className="pct-swatch" style={{ background: s.color }} />
                {s.label}
              </span>
            ))}
          </div>
        </div>

        {latencyBuckets.length === 0 ? (
          <div className="empty-state" style={{ padding: '28px 16px' }}>
            <p className="field-hint">
              Aún no hay muestras de latencia registradas. En cuanto fluyan peticiones por{' '}
              <code className="mono">/v1/chat/completions</code>, verás las 5 curvas{' '}
              <code className="mono">P50–P99</code> juntas aquí.
            </p>
          </div>
        ) : (
          <div
            className="chart-stage"
            onMouseLeave={() => setHoveredLatencyIndex(null)}
          >
            <svg
              viewBox={`0 0 ${svgW} ${svgH}`}
              style={{ width: '100%', height: 'auto', display: 'block', overflow: 'visible' }}
              role="img"
              aria-label="Gráfico temporal de percentiles de latencia P50, P75, P90, P95 y P99"
            >
              {/* Horizontal grid lines */}
              {[0, 0.25, 0.5, 0.75, 1].map((frac) => {
                const val = Math.round(maxLatencyMs * frac);
                const y = latencyY(val);
                return (
                  <g key={frac}>
                    <line
                      x1={padL}
                      y1={y}
                      x2={svgW - padR}
                      y2={y}
                      stroke="#dce7f5"
                      strokeDasharray={frac === 0 ? undefined : '4 4'}
                    />
                    <text
                      x={padL - 8}
                      y={y + 4}
                      textAnchor="end"
                      fontSize="11"
                      fill="#2c4259"
                      fontFamily="var(--font-mono)"
                    >
                      {val}ms
                    </text>
                  </g>
                );
              })}

              {/* 5 Percentile Polylines rendered TOGETHER */}
              {PERCENTILE_SERIES.map((serie) => (
                <polyline
                  key={serie.key}
                  fill="none"
                  stroke={serie.color}
                  strokeWidth={serie.key === 'p50' || serie.key === 'p95' ? 2.6 : 2}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  points={buildPolylinePoints(serie.key)}
                />
              ))}

              {/* Active vertical guide + dots on all 5 percentiles */}
              {hoveredLatencyIndex !== null && activeLatencyBucket ? (
                <g>
                  <line
                    x1={bucketX(hoveredLatencyIndex)}
                    y1={padT}
                    x2={bucketX(hoveredLatencyIndex)}
                    y2={padT + plotH}
                    stroke="var(--accent)"
                    strokeWidth="1.5"
                    strokeDasharray="3 3"
                  />
                  {PERCENTILE_SERIES.map((serie) => (
                    <circle
                      key={serie.key}
                      cx={bucketX(hoveredLatencyIndex)}
                      cy={latencyY(activeLatencyBucket[serie.key])}
                      r={4.5}
                      fill="#ffffff"
                      stroke={serie.color}
                      strokeWidth={2.5}
                    />
                  ))}
                </g>
              ) : null}

              {/* X-axis first / middle / last labels */}
              {latencyBuckets.map((b, idx) => {
                const showLabel =
                  latencyBuckets.length <= 6 ||
                  idx === 0 ||
                  idx === Math.floor(latencyBuckets.length / 2) ||
                  idx === latencyBuckets.length - 1;
                if (!showLabel) return null;
                return (
                  <text
                    key={`lbl-${idx}`}
                    x={bucketX(idx)}
                    y={svgH - 10}
                    textAnchor={
                      idx === 0
                        ? 'start'
                        : idx === latencyBuckets.length - 1
                          ? 'end'
                          : 'middle'
                    }
                    fontSize="11"
                    fill="#2c4259"
                    fontFamily="var(--font-mono)"
                  >
                    {formatBucketTimeLabel(b.timestamp, b.label)}
                  </text>
                );
              })}

              {/* Interactive pointer hit columns across every bucket */}
              {latencyBuckets.map((_, idx) => {
                const colWidth =
                  latencyBuckets.length > 1 ? plotW / latencyBuckets.length : plotW;
                const xCenter = bucketX(idx);
                return (
                  <rect
                    key={`hit-${idx}`}
                    x={Math.max(padL, xCenter - colWidth / 2)}
                    y={padT}
                    width={colWidth}
                    height={plotH}
                    fill="transparent"
                    style={{ cursor: 'pointer' }}
                    onMouseEnter={() => setHoveredLatencyIndex(idx)}
                    onClick={() => setHoveredLatencyIndex(idx)}
                  />
                );
              })}
            </svg>

            {/* Floating White Tooltip showing ALL 5 percentiles simultaneously */}
            {hoveredLatencyIndex !== null && activeLatencyBucket ? (
              <div
                className="floating-white-tooltip"
                style={{
                  position: 'absolute',
                  top: 12,
                  left:
                    hoveredLatencyIndex > latencyBuckets.length / 2 ? '16px' : undefined,
                  right:
                    hoveredLatencyIndex <= latencyBuckets.length / 2 ? '16px' : undefined,
                }}
              >
                <div className="mono" style={{ fontWeight: 700, marginBottom: 6 }}>
                  {formatBucketTimeLabel(
                    activeLatencyBucket.timestamp,
                    activeLatencyBucket.label
                  )}
                </div>
                {PERCENTILE_SERIES.map((serie) => (
                  <div
                    key={serie.key}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: 16,
                    }}
                  >
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                      <span
                        className="pct-swatch"
                        style={{ background: serie.color, height: 8, width: 8, borderRadius: '50%' }}
                      />
                      <strong>{serie.label}</strong>
                    </span>
                    <span className="mono">
                      {Math.round(activeLatencyBucket[serie.key]).toLocaleString('es-ES')} ms
                    </span>
                  </div>
                ))}
                {typeof activeLatencyBucket.count === 'number' ? (
                  <div
                    style={{
                      marginTop: 6,
                      paddingTop: 5,
                      borderTop: '1px solid #e6eef8',
                      color: 'var(--sub)',
                      fontSize: '0.76rem',
                    }}
                  >
                    Muestras: {activeLatencyBucket.count}
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        )}
      </section>

      {/* 3. HU-18b: Model Speed (TTFT ms & Tokens/s with P50..P99) + Cache Hit Rate */}
      <section className="card" aria-labelledby="speed-section-title">
        <div className="card-header">
          <h2 id="speed-section-title" className="card-title">
            Velocidad real (TTFT y Tokens/s) y Aciertos de Caché
            <InfoTip text="Pasa el cursor sobre cualquier modelo para inspeccionar simultáneamente los 5 percentiles (P50, P75, P90, P95, P99) de Time to First Token y velocidad de generación." />
          </h2>
        </div>

        {speedData.models.length === 0 && speedData.cacheByProvider.length === 0 ? (
          <div className="empty-state" style={{ padding: '24px 16px' }}>
            <p className="field-hint">
              Aún no hay mediciones de TTFT, tokens/s ni caché registradas.
            </p>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 22 }}>
            {speedData.models.length > 0 ? (
              <div
                style={{ display: 'flex', flexDirection: 'column', gap: 12 }}
                onMouseLeave={() => setHoveredSpeedModel(null)}
              >
                {speedData.models.map((m) => {
                  const isHovered = hoveredSpeedModel?.id === m.id;
                  return (
                    <div
                      key={m.id}
                      className="speed-row-card"
                      tabIndex={0}
                      onMouseEnter={() => setHoveredSpeedModel(m)}
                      onFocus={() => setHoveredSpeedModel(m)}
                    >
                      <div
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          gap: 12,
                          marginBottom: 10,
                          flexWrap: 'wrap',
                        }}
                      >
                        <code
                          className="mono"
                          style={{ fontWeight: 700, fontSize: '0.9rem', color: 'var(--fg)' }}
                        >
                          {m.modelFullId}
                        </code>
                        <span className="field-hint">
                          {m.sampleCount} {m.sampleCount === 1 ? 'petición' : 'peticiones'}
                        </span>
                      </div>

                      <div
                        style={{
                          display: 'grid',
                          gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 280px), 1fr))',
                          gap: 12,
                        }}
                      >
                        <div>
                          <div className="field-hint" style={{ fontWeight: 700, marginBottom: 5 }}>
                            TTFT (ms) · P50 → P99
                          </div>
                          <div className="pct-pill-group">
                            {PERCENTILE_SERIES.map((s) => (
                              <span key={s.key} className="pct-chip">
                                <strong>{s.label}</strong>
                                {Math.round(m.ttftMs[s.key])}ms
                              </span>
                            ))}
                          </div>
                        </div>

                        <div>
                          <div className="field-hint" style={{ fontWeight: 700, marginBottom: 5 }}>
                            Velocidad (tok/s) · P50 → P99
                          </div>
                          <div className="pct-pill-group">
                            {PERCENTILE_SERIES.map((s) => (
                              <span key={s.key} className="pct-chip">
                                <strong>{s.label}</strong>
                                {m.tokensPerSec[s.key].toFixed(1)}
                              </span>
                            ))}
                          </div>
                        </div>
                      </div>

                      {isHovered ? (
                        <div
                          className="floating-white-tooltip"
                          style={{
                            position: 'absolute',
                            right: 12,
                            bottom: 'calc(100% + 8px)',
                            width: 'min(290px, calc(100vw - 44px))',
                          }}
                        >
                          <div className="mono" style={{ fontWeight: 700, marginBottom: 6 }}>
                            {m.modelFullId}
                          </div>
                          {PERCENTILE_SERIES.map((s) => (
                            <div
                              key={s.key}
                              style={{
                                display: 'flex',
                                justifyContent: 'space-between',
                                gap: 16,
                              }}
                            >
                              <strong>{s.label}</strong>
                              <span className="mono">
                                {Math.round(m.ttftMs[s.key])} ms ·{' '}
                                {m.tokensPerSec[s.key].toFixed(1)} tok/s
                              </span>
                            </div>
                          ))}
                        </div>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            ) : null}

            {/* Provider Cache Hit Rate % */}
            {speedData.cacheByProvider.length > 0 ? (
              <div>
                <h3 style={{ fontSize: '0.96rem', marginBottom: 12 }}>
                  Tasa de aciertos de caché de prompt por proveedor
                </h3>
                <div className="kpi-grid">
                  {speedData.cacheByProvider.map((c) => (
                    <div key={c.providerId} className="horiz-err-item">
                      <div
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                        }}
                      >
                        <strong>{c.providerName}</strong>
                        <span
                          className="font-display"
                          style={{ color: 'var(--ok)', fontWeight: 700 }}
                        >
                          {c.cacheHitRate.toFixed(1)}%
                        </span>
                      </div>
                      <div className="horiz-track">
                        <div
                          className="horiz-fill"
                          style={{
                            width: `${Math.min(100, Math.max(0, c.cacheHitRate))}%`,
                            background: 'var(--ok)',
                          }}
                        />
                      </div>
                      <span className="field-hint">
                        {c.cachedTokens.toLocaleString('es-ES')} en caché /{' '}
                        {c.promptTokens.toLocaleString('es-ES')} prompt tokens
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
        )}
      </section>

      {/* 4. HU-20b: Token Activity (prompt, completion, reasoning) + Comboboxes */}
      <section className="card" aria-labelledby="activity-section-title">
        <div className="card-header">
          <h2 id="activity-section-title" className="card-title">
            Actividad de tokens (Prompt, Completion y Reasoning)
            <InfoTip text="Desglosa el volumen consumido separando tokens de entrada (prompt), generación (completion) y razonamiento interno (reasoning)." />
          </h2>

          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
            <select
              aria-label="Rango de tiempo de actividad"
              className="select-compact"
              value={activityRange}
              onChange={(e) => setActivityRange(e.target.value as ActivityRange)}
            >
              <option value="today">Hoy (UTC)</option>
              <option value="7d">Últimos 7 días</option>
              <option value="30d">Últimos 30 días</option>
            </select>

            <select
              aria-label="Agrupar actividad por"
              className="select-compact"
              value={activityGroupBy}
              onChange={(e) => setActivityGroupBy(e.target.value as ActivityGroupBy)}
            >
              <option value="model">Agrupar por modelo</option>
              <option value="provider">Agrupar por proveedor</option>
              {isAdmin ? <option value="user">Agrupar por usuario</option> : null}
            </select>

            {activityData.items.length > 1 ? (
              <select
                aria-label="Filtrar elemento específico"
                className="select-compact"
                value={selectedEntityFilter}
                onChange={(e) => setSelectedEntityFilter(e.target.value)}
              >
                <option value="ALL">Todos ({activityData.items.length})</option>
                {activityData.items.map((it) => (
                  <option key={it.key} value={it.key}>
                    {it.label}
                  </option>
                ))}
              </select>
            ) : null}
          </div>
        </div>

        {/* Summary Totals Strip */}
        <div className="kpi-grid" style={{ marginBottom: 22 }}>
          <div className="horiz-err-item">
            <span className="field-hint">Prompt tokens</span>
            <strong className="font-display" style={{ fontSize: '1.3rem', color: 'var(--accent)' }}>
              {displayedTotals.promptTokens.toLocaleString('es-ES')}
            </strong>
          </div>
          <div className="horiz-err-item">
            <span className="field-hint">Completion tokens</span>
            <strong className="font-display" style={{ fontSize: '1.3rem', color: 'var(--ok)' }}>
              {displayedTotals.completionTokens.toLocaleString('es-ES')}
            </strong>
          </div>
          <div className="horiz-err-item">
            <span className="field-hint">Reasoning tokens</span>
            <strong className="font-display" style={{ fontSize: '1.3rem', color: '#8a5607' }}>
              {displayedTotals.reasoningTokens.toLocaleString('es-ES')}
            </strong>
          </div>
          <div className="horiz-err-item">
            <span className="field-hint">Total acumulado</span>
            <strong className="font-display" style={{ fontSize: '1.3rem', color: 'var(--fg)' }}>
              {displayedTotals.totalTokens.toLocaleString('es-ES')}
            </strong>
          </div>
        </div>

        {activityLoading ? (
          <p className="field-hint">Consultando actividad de tokens…</p>
        ) : visibleActivityItems.length === 0 ? (
          <div className="empty-state" style={{ padding: '24px 16px' }}>
            <p className="field-hint">Sin consumo de tokens registrado en el rango seleccionado.</p>
          </div>
        ) : (
          <div
            className="chart-stage"
            onMouseLeave={() => setHoveredActivityIndex(null)}
          >
            <svg
              viewBox={`0 0 ${actSvgW} ${actSvgH}`}
              style={{ width: '100%', height: 'auto', display: 'block' }}
              role="img"
              aria-label="Gráfico apilado de tokens prompt, completion y reasoning"
            >
              {[0, 0.5, 1].map((frac) => {
                const val = Math.round(maxActivityTokens * frac);
                const y = padT + actPlotH - frac * actPlotH;
                return (
                  <g key={frac}>
                    <line
                      x1={padL}
                      y1={y}
                      x2={actSvgW - padR}
                      y2={y}
                      stroke="#dce7f5"
                      strokeDasharray={frac === 0 ? undefined : '4 4'}
                    />
                    <text
                      x={padL - 8}
                      y={y + 4}
                      textAnchor="end"
                      fontSize="11"
                      fill="#2c4259"
                      fontFamily="var(--font-mono)"
                    >
                      {val.toLocaleString('es-ES')}
                    </text>
                  </g>
                );
              })}

              {visibleActivityItems.slice(0, 16).map((item, idx, arr) => {
                const slotW = actPlotW / arr.length;
                const barW = Math.min(54, Math.max(14, slotW * 0.62));
                const x = padL + idx * slotW + (slotW - barW) / 2;

                const hPrompt = (item.promptTokens / maxActivityTokens) * actPlotH;
                const hComp = (item.completionTokens / maxActivityTokens) * actPlotH;
                const hReas = (item.reasoningTokens / maxActivityTokens) * actPlotH;

                const yPrompt = padT + actPlotH - hPrompt;
                const yComp = yPrompt - hComp;
                const yReas = yComp - hReas;

                const shortLabel =
                  item.label.length > 14 ? `${item.label.slice(0, 13)}…` : item.label;

                return (
                  <g
                    key={item.key}
                    style={{ cursor: 'pointer' }}
                    onMouseEnter={() => setHoveredActivityIndex(idx)}
                  >
                    {/* Prompt segment */}
                    <rect
                      x={x}
                      y={yPrompt}
                      width={barW}
                      height={Math.max(0, hPrompt)}
                      fill="var(--accent)"
                      rx={2}
                    />
                    {/* Completion segment */}
                    <rect
                      x={x}
                      y={yComp}
                      width={barW}
                      height={Math.max(0, hComp)}
                      fill="var(--ok)"
                      rx={2}
                    />
                    {/* Reasoning segment */}
                    <rect
                      x={x}
                      y={yReas}
                      width={barW}
                      height={Math.max(0, hReas)}
                      fill="var(--partial)"
                      rx={2}
                    />
                    <text
                      x={x + barW / 2}
                      y={actSvgH - 14}
                      textAnchor="middle"
                      fontSize="10.5"
                      fill="#2c4259"
                      fontFamily="var(--font-mono)"
                    >
                      {shortLabel}
                    </text>
                  </g>
                );
              })}
            </svg>

            {hoveredActivityIndex !== null && activeActivityItem ? (
              <div
                className="floating-white-tooltip"
                style={{ position: 'absolute', top: 10, right: 16 }}
              >
                <div className="mono" style={{ fontWeight: 700, marginBottom: 6 }}>
                  {activeActivityItem.label}
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16 }}>
                  <span>Prompt:</span>
                  <strong className="mono">
                    {activeActivityItem.promptTokens.toLocaleString('es-ES')}
                  </strong>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16 }}>
                  <span>Completion:</span>
                  <strong className="mono">
                    {activeActivityItem.completionTokens.toLocaleString('es-ES')}
                  </strong>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16 }}>
                  <span>Reasoning:</span>
                  <strong className="mono">
                    {activeActivityItem.reasoningTokens.toLocaleString('es-ES')}
                  </strong>
                </div>
                <div
                  style={{
                    marginTop: 6,
                    paddingTop: 5,
                    borderTop: '1px solid #e6eef8',
                    display: 'flex',
                    justifyContent: 'space-between',
                    gap: 16,
                  }}
                >
                  <strong>Total:</strong>
                  <strong className="mono">
                    {activeActivityItem.totalTokens.toLocaleString('es-ES')}
                  </strong>
                </div>
              </div>
            ) : null}
          </div>
        )}
      </section>
    </>
  );
};
