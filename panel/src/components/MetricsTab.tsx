import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import type {
  ActivityGroupBy,
  ActivityMetricsData,
  ActivityRange,
  FreeQuotaStatus,
  LatencyBucketPoint,
  LatencyMetricsData,
  ModelSpeedEntry,
  ProviderRateLimitWindow,
  ProviderReliabilityEntry,
  QuotaConfidence,
  SpeedMetricsData,
  UptimeDayCell,
} from '../types';
import { InfoTip } from './InfoTip';

interface MetricsTabProps {
  isAdmin: boolean;
  onOpenModel?: (modelIdOrQuery: string) => void;
  onOpenProvider?: (providerId: string) => void;
}

const PERCENTILE_SERIES = [
  { key: 'p50' as const, label: 'P50', color: 'var(--c-lat-50)' },
  { key: 'p75' as const, label: 'P75', color: 'var(--c-lat-75)' },
  { key: 'p90' as const, label: 'P90', color: 'var(--c-lat-90)' },
  { key: 'p95' as const, label: 'P95', color: 'var(--c-lat-95)' },
  { key: 'p99' as const, label: 'P99', color: 'var(--c-lat-99)' },
];

const THROUGHPUT_SERIES = [
  { key: 'p50' as const, label: 'P50', color: 'var(--c-tp-50)' },
  { key: 'p75' as const, label: 'P75', color: 'var(--c-tp-75)' },
  { key: 'p90' as const, label: 'P90', color: 'var(--c-tp-90)' },
  { key: 'p95' as const, label: 'P95', color: 'var(--c-tp-95)' },
  { key: 'p99' as const, label: 'P99', color: 'var(--c-tp-99)' },
];

function formatBucketTimeLabel(ts: string | number, label?: string): string {
  const raw = label && label.trim().length > 0 ? label.trim() : null;
  if (raw) {
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(raw)) {
      return `${raw.slice(5, 10)} ${raw.slice(11, 16)} UTC`;
    }
    return raw;
  }
  if (typeof ts === 'number' && Number.isFinite(ts)) {
    const ms = ts < 1_000_000_000_000 ? ts * 1000 : ts;
    return new Date(ms).toISOString().replace('T', ' ').slice(5, 16) + ' UTC';
  }
  const str = String(ts);
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(str)) {
    return `${str.slice(5, 10)} ${str.slice(11, 16)} UTC`;
  }
  return str || '—';
}

function formatLatencyAxis(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0ms';
  if (ms >= 60_000) return `${(ms / 60_000).toFixed(1)}m`;
  if (ms >= 1_000) return `${(ms / 1_000).toFixed(ms >= 10_000 ? 0 : 1)}s`;
  return `${Math.round(ms)}ms`;
}

function formatLatencyValue(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0 ms';
  if (ms >= 60_000) return `${(ms / 60_000).toFixed(1)} min`;
  if (ms >= 10_000) return `${(ms / 1_000).toFixed(1)} s`;
  return `${Math.round(ms).toLocaleString('es-ES')} ms`;
}

function classifyUptimeBar(uptimePct: number | null): 'notraffic' | 'ok' | 'partial' | 'err' {
  if (uptimePct === null || uptimePct === undefined) return 'notraffic';
  if (uptimePct >= 99) return 'ok';
  if (uptimePct >= 95) return 'partial';
  return 'err';
}

function formatCompactCount(val: number): string {
  if (val >= 1_000_000) return `${(val / 1_000_000).toFixed(val >= 10_000_000 ? 0 : 2)}M`;
  if (val >= 1_000) return `${Math.round(val / 1_000)}K`;
  return String(val);
}

function errorBarColor(ratePct: number): string {
  if (ratePct <= 0) return 'var(--ok)';
  if (ratePct < 5) return 'var(--partial)';
  return 'var(--err)';
}

function buildSmoothSvgPath(xs: number[], ys: number[]): string {
  if (xs.length === 0) return '';
  if (xs.length === 1) return `M ${xs[0].toFixed(1)},${ys[0].toFixed(1)}`;
  let d = `M ${xs[0].toFixed(1)},${ys[0].toFixed(1)}`;
  for (let i = 0; i < xs.length - 1; i++) {
    const cx = ((xs[i] + xs[i + 1]) / 2).toFixed(1);
    d += ` C ${cx},${ys[i].toFixed(1)} ${cx},${ys[i + 1].toFixed(1)} ${xs[i + 1].toFixed(1)},${ys[
      i + 1
    ].toFixed(1)}`;
  }
  return d;
}

function formatQuotaWindow(w?: ProviderRateLimitWindow | null): string {
  if (w === 'hour') return 'hora';
  if (w === 'week') return 'semana';
  return 'día';
}

function formatQuotaConfidence(c?: QuotaConfidence | null): string {
  if (c === 'header_exact') return 'Exacto por cabecera';
  if (c === 'inferred') return 'Inferido por 429';
  return 'Configurado';
}

export const MetricsTab: React.FC<MetricsTabProps> = ({
  isAdmin,
  onOpenModel,
  onOpenProvider,
}) => {
  const [latencyData, setLatencyData] = useState<LatencyMetricsData>({ buckets: [] });
  const [speedData, setSpeedData] = useState<SpeedMetricsData>({
    models: [],
    cacheByProvider: [],
  });
  const [uptimeList, setUptimeList] = useState<ProviderReliabilityEntry[]>([]);
  const [freeQuota, setFreeQuota] = useState<FreeQuotaStatus | null>(null);
  const [coreLoading, setCoreLoading] = useState(true);

  // HU-20b Activity Controls & State
  const [activityRange, setActivityRange] = useState<ActivityRange>('7d');
  const [activityGroupBy, setActivityGroupBy] = useState<ActivityGroupBy>('model');
  const [selectedEntityFilter, setSelectedEntityFilter] = useState<string>('ALL');
  const [speedSort, setSpeedSort] = useState<
    'samples_desc' | 'tps_desc' | 'ttft_asc' | 'ttft_desc'
  >('samples_desc');
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

  // Interactive hover & isolation states
  const [hoveredLatencyIndex, setHoveredLatencyIndex] = useState<number | null>(null);
  const [isolatedPercentile, setIsolatedPercentile] = useState<string | null>(null);
  const [hoveredSpeedModel, setHoveredSpeedModel] = useState<ModelSpeedEntry | null>(null);
  const [hoveredUptimeCell, setHoveredUptimeCell] = useState<{
    providerId: string;
    providerName: string;
    dayIndex: number;
    day: UptimeDayCell;
  } | null>(null);
  const [hoveredActivityIndex, setHoveredActivityIndex] = useState<number | null>(null);
  const [isolatedTokenSeries, setIsolatedTokenSeries] = useState<
    'prompt' | 'completion' | 'reasoning' | null
  >(null);

  const loadTelemetry = useCallback(async () => {
    setCoreLoading(true);
    const [latRes, spdRes, upRes, fqRes] = await Promise.allSettled([
      api.getMetricsLatency('24h'),
      api.getMetricsSpeed(),
      api.getMetricsUptime(),
      api.getFreeQuota(),
    ]);

    if (latRes.status === 'fulfilled') setLatencyData(latRes.value);
    if (spdRes.status === 'fulfilled') setSpeedData(spdRes.value);
    if (upRes.status === 'fulfilled') setUptimeList(upRes.value);
    if (fqRes.status === 'fulfilled') setFreeQuota(fqRes.value);
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

  const sortedUsedSpeedModels = useMemo(() => {
    const used = speedData.models.filter((m) => m.sampleCount > 0);
    return [...used].sort((a, b) => {
      if (speedSort === 'tps_desc') return b.tokensPerSec.p50 - a.tokensPerSec.p50;
      if (speedSort === 'ttft_asc') return a.ttftMs.p50 - b.ttftMs.p50;
      if (speedSort === 'ttft_desc') return b.ttftMs.p50 - a.ttftMs.p50;
      return b.sampleCount - a.sampleCount;
    });
  }, [speedData.models, speedSort]);

  const nonEmptyActivityItems = useMemo(() => {
    return [...activityData.items]
      .filter((it) => it.totalTokens > 0)
      .sort((a, b) => b.totalTokens - a.totalTokens);
  }, [activityData.items]);

  const visibleActivityItems = useMemo(() => {
    if (selectedEntityFilter === 'ALL') return nonEmptyActivityItems;
    return nonEmptyActivityItems.filter((it) => it.key === selectedEntityFilter);
  }, [nonEmptyActivityItems, selectedEntityFilter]);

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
  const svgH = 250;
  const padL = 56;
  const padR = 24;
  const padT = 18;
  const padB = 34;
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

  function buildCurvePath(
    key: keyof Pick<LatencyBucketPoint, 'p50' | 'p75' | 'p90' | 'p95' | 'p99'>
  ): string {
    const xs = latencyBuckets.map((_, idx) => bucketX(idx));
    const ys = latencyBuckets.map((b) => latencyY(b[key]));
    return buildSmoothSvgPath(xs, ys);
  }

  const latencyAvgs = useMemo(() => {
    if (latencyBuckets.length === 0) {
      return { p50: 0, p75: 0, p90: 0, p95: 0, p99: 0 };
    }
    const n = latencyBuckets.length;
    return {
      p50: Math.round(latencyBuckets.reduce((s, b) => s + b.p50, 0) / n),
      p75: Math.round(latencyBuckets.reduce((s, b) => s + b.p75, 0) / n),
      p90: Math.round(latencyBuckets.reduce((s, b) => s + b.p90, 0) / n),
      p95: Math.round(latencyBuckets.reduce((s, b) => s + b.p95, 0) / n),
      p99: Math.round(latencyBuckets.reduce((s, b) => s + b.p99, 0) / n),
    };
  }, [latencyBuckets]);

  const activeLatencyBucket =
    hoveredLatencyIndex !== null ? latencyBuckets[hoveredLatencyIndex] ?? null : null;

  // SVG Geometry for HU-20b Stacked Token Activity Chart
  const actSvgW = 860;
  const actSvgH = 240;
  const actPlotW = actSvgW - padL - padR;
  const actPlotH = actSvgH - padT - 40;

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
          <h1 className="page-title">Métricas, Percentiles y Disponibilidad</h1>
          <p className="page-subtitle">
            Telemetría calculada sobre tráfico real: curvas multi-percentil{' '}
            <code className="mono">P50–P99</code>, disponibilidad de 60 días y desglose de tokens
            con aislamiento interactivo por serie.
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

      {/* 0. HU-39: Adaptive Free Quota Window & Per-Provider Breakdown */}
      {freeQuota && freeQuota.providers.length > 0 ? (
        <section className="card" aria-labelledby="quota-adaptive-section-title">
          <div className="card-header">
            <h2 id="quota-adaptive-section-title" className="card-title">
              Cuota gratuita adaptativa por proveedor
              <InfoTip text="Ventana real activa, unidad (tokens o peticiones), claves usables y nivel de confianza (cabeceras HTTP, configurado o inferido por 429)." />
            </h2>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
              <span className="meta-tag accent">
                Ventana: {formatQuotaWindow(freeQuota.activeWindow)}
              </span>
              <span className="meta-tag">
                {freeQuota.effectiveLimit === null &&
                !freeQuota.adaptiveAdjusted &&
                freeQuota.confidence === 'inferred'
                  ? freeQuota.providers.some((p) => p.recent429Count7d > 0)
                    ? 'En aprendizaje (429)'
                    : 'Sin límite fijo'
                  : formatQuotaConfidence(freeQuota.confidence)}
              </span>
              {freeQuota.adaptiveAdjusted ? (
                <span className="status-badge rate_limited">Ajuste adaptativo 429</span>
              ) : null}
            </div>
          </div>

          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 230px), 1fr))',
              gap: 10,
            }}
          >
            {freeQuota.providers.map((pq) => {
              const unitTxt = pq.unit === 'requests' ? 'pet.' : 'tok';
              const winTxt = pq.windowLabel || formatQuotaWindow(pq.activeWindow);
              const confidenceTxt =
                pq.effectiveLimit === null
                  ? pq.recent429Count7d === 0
                    ? 'Sin límite fijo'
                    : 'En aprendizaje (429)'
                  : formatQuotaConfidence(pq.confidence);
              return (
                <div
                  key={pq.providerId}
                  className="horiz-err-item"
                  role={onOpenProvider ? 'button' : undefined}
                  tabIndex={onOpenProvider ? 0 : undefined}
                  style={onOpenProvider ? { cursor: 'pointer' } : undefined}
                  onClick={() => onOpenProvider?.(pq.providerId)}
                  onKeyDown={(e) => {
                    if (onOpenProvider && (e.key === 'Enter' || e.key === ' ')) {
                      e.preventDefault();
                      onOpenProvider(pq.providerId);
                    }
                  }}
                >
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: 8,
                    }}
                  >
                    <strong>{pq.providerName}</strong>
                    <span className="meta-tag mono">{winTxt}</span>
                  </div>
                  <div className="mono" style={{ fontSize: '0.84rem', color: 'var(--sub)' }}>
                    {pq.unit === 'none' ? (
                      <strong style={{ color: 'var(--fg)' }}>
                        {pq.rateLimitKind === 'concurrency'
                          ? 'Límite por concurrencia'
                          : 'Sin límite de cuota'}
                      </strong>
                    ) : (
                      <>
                        <strong style={{ color: 'var(--fg)' }}>
                          {pq.usedInWindow.toLocaleString('es-ES')}
                        </strong>
                        {pq.effectiveLimit !== null
                          ? ` / ${pq.effectiveLimit.toLocaleString('es-ES')} ${unitTxt}`
                          : ` ${unitTxt} usados`}
                      </>
                    )}
                  </div>
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: 6,
                      fontSize: '0.73rem',
                      color: 'var(--fg-3)',
                      flexWrap: 'wrap',
                    }}
                  >
                    <span>
                      {confidenceTxt} · {pq.usableKeysCount}{' '}
                      {pq.usableKeysCount === 1 ? 'clave' : 'claves'}
                    </span>
                    {pq.recent429Count7d > 0 ? (
                      <span style={{ color: 'var(--partial)' }}>{pq.recent429Count7d} × 429</span>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      ) : null}

      {/* 1. HU-19 & HU-20: 60-Day Provider Uptime Strip + 7-Day Tool/Structured Error Bars */}
      <section className="card" aria-labelledby="uptime-section-title">
        <div className="card-header">
          <h2 id="uptime-section-title" className="card-title">
            Disponibilidad por proveedor (60 días) y errores de capacidades (7d)
            <InfoTip text="Basado únicamente en peticiones reales de tus aplicaciones. Los días sin tráfico se muestran en tono neutro y nunca penalizan el porcentaje como 0%. Verde ≥ 99%, Ámbar 95–99%, Rojo < 95%." />
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
                style={{ background: 'var(--line-strong)', border: '1px solid var(--line)' }}
              />{' '}
              Sin tráfico
            </span>
          </div>
        </div>

        {coreLoading && uptimeList.length === 0 ? (
          <p className="field-hint">Calculando serie de 60 días…</p>
        ) : uptimeList.length === 0 ? (
          <div className="empty-state" style={{ padding: '24px 16px' }}>
            <p className="field-hint">
              Aún no hay proveedores con historial registrado. Al instalar proveedores verás aquí su
              tira de 60 días UTC y sus tasas de error en herramientas y salidas JSON.
            </p>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
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
                      <strong style={{ fontSize: '0.96rem', color: 'var(--fg)' }}>
                        {prov.providerName}
                      </strong>
                      <code className="key-prefix-pill">{prov.providerId}</code>
                    </div>

                    <span
                      className="mono"
                      style={{
                        fontSize: '0.88rem',
                        fontWeight: 600,
                        color:
                          prov.overallUptimePct === null
                            ? 'var(--sub)'
                            : prov.overallUptimePct >= 99
                              ? 'var(--ok)'
                              : prov.overallUptimePct >= 95
                                ? 'var(--partial)'
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
                      fontSize: '0.73rem',
                      color: 'var(--fg-3)',
                    }}
                  >
                    <span>Hace 60 días ({prov.days[0]?.date ?? ''})</span>
                    <span>Pasa el cursor por cada día para inspeccionar tráfico</span>
                    <span>Hoy UTC ({prov.days[prov.days.length - 1]?.date ?? ''})</span>
                  </div>

                  {/* Floating tooltip for hovered day bar */}
                  {hoveredHere ? (
                    <div
                      className="floating-white-tooltip"
                      style={{
                        position: 'absolute',
                        top: 48,
                        left: `${Math.min(
                          72,
                          Math.max(4, (hoveredHere.dayIndex / 60) * 100)
                        )}%`,
                      }}
                    >
                      <div
                        className="mono"
                        style={{
                          fontWeight: 600,
                          marginBottom: 4,
                          paddingBottom: 4,
                          borderBottom: '1px solid var(--tooltip-line)',
                        }}
                      >
                        {hoveredHere.day.date} (UTC)
                      </div>
                      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 14 }}>
                        <span style={{ color: 'var(--tooltip-sub)' }}>Disponibilidad</span>
                        <strong className="mono">
                          {hoveredHere.day.uptimePct === null
                            ? 'Sin tráfico'
                            : `${hoveredHere.day.uptimePct.toFixed(2)}%`}
                        </strong>
                      </div>
                      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 14 }}>
                        <span style={{ color: 'var(--tooltip-sub)' }}>Peticiones reales</span>
                        <strong className="mono">
                          {hoveredHere.day.totalRequests.toLocaleString('es-ES')}
                        </strong>
                      </div>
                      {typeof hoveredHere.day.errorRequests === 'number' &&
                      hoveredHere.day.errorRequests > 0 ? (
                        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 14 }}>
                          <span style={{ color: 'var(--tooltip-sub)' }}>Errores</span>
                          <strong className="mono" style={{ color: 'var(--err)' }}>
                            {hoveredHere.day.errorRequests.toLocaleString('es-ES')}
                          </strong>
                        </div>
                      ) : null}
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
                          fontSize: '0.8rem',
                        }}
                      >
                        <span style={{ fontWeight: 500, color: 'var(--sub)' }}>
                          Tool call error rate (7d)
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
                          fontSize: '0.8rem',
                        }}
                      >
                        <span style={{ fontWeight: 500, color: 'var(--sub)' }}>
                          Structured output error rate (7d)
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

      {/* 2. HU-18: Latency Percentiles (P50, P75, P90, P95, P99 TOGETHER + Interactive Legend Table) */}
      <section className="card" aria-labelledby="latency-section-title">
        <div className="card-header">
          <h2 id="latency-section-title" className="card-title">
            Latencia de extremo a extremo por percentiles (P50 – P99)
            <InfoTip text="Pasa el cursor sobre la gráfica o sobre cualquier fila P50–P99 debajo para aislar esa curva e inspeccionar valores exactos." />
          </h2>

          <div className="pct-legend-row">
            {PERCENTILE_SERIES.map((s) => (
              <span
                key={s.key}
                className="pct-legend-item"
                onMouseEnter={() => setIsolatedPercentile(s.key)}
                onMouseLeave={() => setIsolatedPercentile(null)}
              >
                <span className="pct-swatch" style={{ background: s.color }} />
                {s.label}
              </span>
            ))}
          </div>
        </div>

        {latencyBuckets.length === 0 ? (
          <div className="empty-state" style={{ padding: '26px 16px' }}>
            <p className="field-hint">
              Aún no hay muestras de latencia registradas. En cuanto fluyan peticiones por{' '}
              <code className="mono">/v1/chat/completions</code>, verás las 5 curvas{' '}
              <code className="mono">P50–P99</code> juntas aquí.
            </p>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div
              className="chart-stage"
              style={{ cursor: 'crosshair' }}
              onMouseLeave={() => setHoveredLatencyIndex(null)}
            >
              <div className="chart-scroll-x">
                <svg
                  className="chart-svg-responsive"
                  viewBox={`0 0 ${svgW} ${svgH}`}
                  style={{ width: '100%', height: 'auto', display: 'block', overflow: 'visible' }}
                  role="img"
                  aria-label="Gráfico temporal de percentiles de latencia P50, P75, P90, P95 y P99"
                >
                {/* Horizontal dotted grid lines */}
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
                        stroke="var(--line)"
                        strokeDasharray={frac === 0 ? undefined : '2 3'}
                      />
                      <text
                        x={padL - 8}
                        y={y + 4}
                        textAnchor="end"
                        fontSize="10.5"
                        fill="var(--fg-3)"
                        fontFamily="var(--font-mono)"
                      >
                        {formatLatencyAxis(val)}
                      </text>
                    </g>
                  );
                })}

                {/* 5 Smooth Percentile Curves */}
                {PERCENTILE_SERIES.map((serie) => {
                  const isDimmed =
                    isolatedPercentile !== null && isolatedPercentile !== serie.key;
                  const isHighlighted = isolatedPercentile === serie.key;
                  return (
                    <path
                      key={serie.key}
                      className="perf-line"
                      fill="none"
                      stroke={serie.color}
                      strokeWidth={isHighlighted ? 2.6 : 1.75}
                      opacity={isDimmed ? 0.18 : 1}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d={buildCurvePath(serie.key)}
                    />
                  );
                })}

                {/* Active vertical crosshair + dots on all 5 percentiles */}
                {hoveredLatencyIndex !== null && activeLatencyBucket ? (
                  <g>
                    <line
                      x1={bucketX(hoveredLatencyIndex)}
                      y1={padT}
                      x2={bucketX(hoveredLatencyIndex)}
                      y2={padT + plotH}
                      stroke="var(--fg-3)"
                      strokeWidth="1"
                      strokeDasharray="2 2"
                    />
                    {PERCENTILE_SERIES.map((serie) => (
                      <circle
                        key={serie.key}
                        cx={bucketX(hoveredLatencyIndex)}
                        cy={latencyY(activeLatencyBucket[serie.key])}
                        r={4}
                        fill={serie.color}
                        stroke="var(--panel)"
                        strokeWidth={1.8}
                      />
                    ))}
                  </g>
                ) : null}

                {/* X-axis labels */}
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
                      y={svgH - 8}
                      textAnchor={
                        idx === 0
                          ? 'start'
                          : idx === latencyBuckets.length - 1
                            ? 'end'
                            : 'middle'
                      }
                      fontSize="10.5"
                      fill="var(--fg-3)"
                      fontFamily="var(--font-mono)"
                    >
                      {formatBucketTimeLabel(b.timestamp, b.label)}
                    </text>
                  );
                })}

                {/* Interactive hit columns */}
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
                      style={{ cursor: 'crosshair' }}
                      onMouseEnter={() => setHoveredLatencyIndex(idx)}
                      onClick={() => setHoveredLatencyIndex(idx)}
                    />
                  );
                })}
                </svg>
              </div>

              {/* Floating Dark/Glass Tooltip showing ALL 5 percentiles simultaneously */}
              {hoveredLatencyIndex !== null && activeLatencyBucket ? (
                <div
                  className="floating-white-tooltip"
                  style={{
                    position: 'absolute',
                    top: 10,
                    left:
                      hoveredLatencyIndex > latencyBuckets.length / 2 ? '16px' : undefined,
                    right:
                      hoveredLatencyIndex <= latencyBuckets.length / 2 ? '16px' : undefined,
                  }}
                >
                  <div
                    className="mono"
                    style={{
                      fontWeight: 600,
                      marginBottom: 6,
                      paddingBottom: 5,
                      borderBottom: '1px solid var(--tooltip-line)',
                    }}
                  >
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
                      <span
                        style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: 6,
                          color: 'var(--tooltip-sub)',
                        }}
                      >
                        <span
                          className="pct-swatch"
                          style={{ background: serie.color }}
                        />
                        {serie.label}
                      </span>
                      <span className="mono" style={{ fontWeight: 600 }}>
                        {formatLatencyValue(activeLatencyBucket[serie.key])}
                      </span>
                    </div>
                  ))}
                  {typeof activeLatencyBucket.count === 'number' ? (
                    <div
                      style={{
                        marginTop: 6,
                        paddingTop: 5,
                        borderTop: '1px solid var(--tooltip-line)',
                        color: 'var(--tooltip-sub)',
                        fontSize: '0.73rem',
                      }}
                    >
                      Muestras en ventana: {activeLatencyBucket.count}
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>

            {/* Interactive 5-Row Percentile Legend Table (OpenRouter Performance layout) */}
            <div className="p-legend">
              {PERCENTILE_SERIES.map((serie) => {
                const liveVal = activeLatencyBucket
                  ? Math.round(activeLatencyBucket[serie.key])
                  : latencyAvgs[serie.key];
                const modeLabel = activeLatencyBucket
                  ? formatBucketTimeLabel(
                      activeLatencyBucket.timestamp,
                      activeLatencyBucket.label
                    )
                  : 'Avg';
                return (
                  <div
                    key={`leg-row-${serie.key}`}
                    className="p-row"
                    onMouseEnter={() => setIsolatedPercentile(serie.key)}
                    onMouseLeave={() => setIsolatedPercentile(null)}
                  >
                    <span className="p-left">
                      <i className="p-dot" style={{ background: serie.color }} />
                      {serie.label}
                    </span>
                    <span className="p-right">
                      <span>{modeLabel}</span>{' '}
                      <strong>{formatLatencyValue(liveVal)}</strong>
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </section>

      {/* 3. HU-18b: Model Speed (TTFT ms & Tokens/s with P50..P99) + Cache Hit Rate */}
      <section className="card" aria-labelledby="speed-section-title">
        <div className="card-header">
          <h2 id="speed-section-title" className="card-title">
            Velocidad por modelo (Throughput tok/s y Latencia TTFT P50–P99) y Caché
            <InfoTip text="Muestra únicamente modelos con tráfico registrado. Pasa el cursor sobre cualquier tarjeta para ver todos los percentiles o haz clic para abrir su ficha." />
          </h2>
          {sortedUsedSpeedModels.length > 1 ? (
            <select
              aria-label="Ordenar modelos por métrica"
              className="select-compact"
              value={speedSort}
              onChange={(e) =>
                setSpeedSort(
                  e.target.value as 'samples_desc' | 'tps_desc' | 'ttft_asc' | 'ttft_desc'
                )
              }
            >
              <option value="samples_desc">Más peticiones (mayor a menor)</option>
              <option value="tps_desc">Mayor velocidad (P50 tok/s)</option>
              <option value="ttft_asc">Menor latencia TTFT (P50)</option>
              <option value="ttft_desc">Mayor latencia TTFT (P50)</option>
            </select>
          ) : null}
        </div>

        {sortedUsedSpeedModels.length === 0 && speedData.cacheByProvider.length === 0 ? (
          <div className="empty-state" style={{ padding: '24px 16px' }}>
            <p className="field-hint">
              Aún no hay mediciones de TTFT, tokens/s ni caché registradas.
            </p>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
            {sortedUsedSpeedModels.length > 0 ? (
              <div
                style={{ display: 'flex', flexDirection: 'column', gap: 10 }}
                onMouseLeave={() => setHoveredSpeedModel(null)}
              >
                {sortedUsedSpeedModels.map((m) => {
                  const isHovered = hoveredSpeedModel?.id === m.id;
                  return (
                    <div
                      key={m.id}
                      className="speed-row-card"
                      role={onOpenModel ? 'button' : undefined}
                      tabIndex={0}
                      style={onOpenModel ? { cursor: 'pointer' } : undefined}
                      onMouseEnter={() => setHoveredSpeedModel(m)}
                      onFocus={() => setHoveredSpeedModel(m)}
                      onClick={() => onOpenModel?.(m.modelFullId)}
                      onKeyDown={(e) => {
                        if (onOpenModel && (e.key === 'Enter' || e.key === ' ')) {
                          e.preventDefault();
                          onOpenModel(m.modelFullId);
                        }
                      }}
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
                          style={{ fontWeight: 600, fontSize: '0.88rem', color: 'var(--fg)' }}
                        >
                          {m.modelFullId}
                        </code>
                        <span className="field-hint">
                          {m.sampleCount.toLocaleString('es-ES')}{' '}
                          {m.sampleCount === 1 ? 'petición' : 'peticiones'}
                        </span>
                      </div>

                      <div
                        style={{
                          display: 'grid',
                          gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 280px), 1fr))',
                          gap: 14,
                        }}
                      >
                        <div>
                          <div className="field-hint" style={{ fontWeight: 600, marginBottom: 6 }}>
                            Throughput (tok/s) · P50 → P99
                          </div>
                          <div className="pct-pill-group">
                            {THROUGHPUT_SERIES.map((s) => (
                              <span key={s.key} className="pct-chip">
                                <i
                                  className="p-dot"
                                  style={{
                                    background: s.color,
                                    display: 'inline-block',
                                    marginRight: 5,
                                  }}
                                />
                                <strong style={{ marginRight: 5 }}>{s.label}</strong>
                                <span className="mono">
                                  {m.tokensPerSec[s.key].toLocaleString('es-ES', {
                                    minimumFractionDigits: 1,
                                    maximumFractionDigits: 1,
                                  })}{' '}
                                  tok/s
                                </span>
                              </span>
                            ))}
                          </div>
                        </div>

                        <div>
                          <div className="field-hint" style={{ fontWeight: 600, marginBottom: 6 }}>
                            Latencia TTFT (ms) · P50 → P99
                          </div>
                          <div className="pct-pill-group">
                            {PERCENTILE_SERIES.map((s) => (
                              <span key={s.key} className="pct-chip">
                                <i
                                  className="p-dot"
                                  style={{
                                    background: s.color,
                                    display: 'inline-block',
                                    marginRight: 5,
                                  }}
                                />
                                <strong style={{ marginRight: 5 }}>{s.label}</strong>
                                <span className="mono">
                                  {Math.round(m.ttftMs[s.key]).toLocaleString('es-ES')} ms
                                </span>
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
                          <div
                            className="mono"
                            style={{
                              fontWeight: 600,
                              marginBottom: 6,
                              paddingBottom: 5,
                              borderBottom: '1px solid var(--tooltip-line)',
                            }}
                          >
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
                              <span
                                style={{
                                  display: 'inline-flex',
                                  alignItems: 'center',
                                  gap: 6,
                                  color: 'var(--tooltip-sub)',
                                }}
                              >
                                <i className="p-dot" style={{ background: s.color }} />
                                {s.label}
                              </span>
                              <span className="mono" style={{ fontWeight: 600 }}>
                                {Math.round(m.ttftMs[s.key])} ms ·{' '}
                                {m.tokensPerSec[s.key].toFixed(1)} tok/s
                              </span>
                            </div>
                          ))}
                          {onOpenModel ? (
                            <div
                              style={{
                                marginTop: 6,
                                paddingTop: 5,
                                borderTop: '1px solid var(--tooltip-line)',
                                fontSize: '0.72rem',
                                color: 'var(--tooltip-sub)',
                              }}
                            >
                              Clic para abrir ficha del modelo →
                            </div>
                          ) : null}
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
                <h3 style={{ fontSize: '0.9rem', fontWeight: 600, marginBottom: 10 }}>
                  Caché de prompt y ahorro de cuota por proveedor
                </h3>
                <div className="kpi-grid">
                  {speedData.cacheByProvider.map((c) => (
                    <div
                      key={c.providerId}
                      className="horiz-err-item"
                      role={onOpenProvider ? 'button' : undefined}
                      tabIndex={onOpenProvider ? 0 : undefined}
                      title={onOpenProvider ? `Abrir proveedor ${c.providerName}` : undefined}
                      style={onOpenProvider ? { cursor: 'pointer' } : undefined}
                      onClick={() => onOpenProvider?.(c.providerId)}
                      onKeyDown={(e) => {
                        if (onOpenProvider && (e.key === 'Enter' || e.key === ' ')) {
                          e.preventDefault();
                          onOpenProvider(c.providerId);
                        }
                      }}
                    >
                      <div
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                        }}
                      >
                        <strong>{c.providerName}</strong>
                        <span
                          className="mono"
                          style={{ color: 'var(--ok)', fontWeight: 600 }}
                        >
                          {c.cacheHitRate.toFixed(1)}%
                        </span>
                      </div>
                      <div className="horiz-track">
                        <div
                          className="horiz-fill"
                          style={{
                            width: `${Math.min(100, Math.max(0, c.cacheHitRate))}%`,
                            background: 'var(--c-cache-hit)',
                          }}
                        />
                      </div>
                      <span className="field-hint">
                        {c.cachedTokens.toLocaleString('es-ES')} cached /{' '}
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

      {/* 4. HU-20b: Token Activity (prompt, completion, reasoning) + Interactive Series Filter */}
      <section className="card" aria-labelledby="activity-section-title">
        <div className="card-header">
          <h2 id="activity-section-title" className="card-title">
            Desglose de tokens (Prompt, Completion y Reasoning)
            <InfoTip text="Pasa el cursor por las columnas para ver el desglose o por la leyenda inferior para aislar una categoría." />
          </h2>

          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
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
              <option value="apiKey">Agrupar por API key</option>
              {isAdmin ? <option value="user">Agrupar por usuario</option> : null}
            </select>

            {nonEmptyActivityItems.length > 1 ? (
              <select
                aria-label="Filtrar elemento específico"
                className="select-compact"
                value={selectedEntityFilter}
                onChange={(e) => setSelectedEntityFilter(e.target.value)}
              >
                <option value="ALL">Todos ({nonEmptyActivityItems.length})</option>
                {nonEmptyActivityItems.map((it) => (
                  <option key={it.key} value={it.key}>
                    {it.label}
                  </option>
                ))}
              </select>
            ) : null}
          </div>
        </div>

        {/* Summary Totals Strip */}
        <div className="kpi-grid" style={{ marginBottom: 18 }}>
          <div
            className="horiz-err-item"
            onMouseEnter={() => setIsolatedTokenSeries('prompt')}
            onMouseLeave={() => setIsolatedTokenSeries(null)}
          >
            <span className="field-hint" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <i className="p-dot" style={{ background: 'var(--c-bar-1)' }} />
              Prompt tokens
            </span>
            <strong className="mono" style={{ fontSize: '1.2rem', color: 'var(--fg)' }}>
              {displayedTotals.promptTokens.toLocaleString('es-ES')}
            </strong>
          </div>
          <div
            className="horiz-err-item"
            onMouseEnter={() => setIsolatedTokenSeries('completion')}
            onMouseLeave={() => setIsolatedTokenSeries(null)}
          >
            <span className="field-hint" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <i className="p-dot" style={{ background: 'var(--c-bar-2)' }} />
              Completion tokens
            </span>
            <strong className="mono" style={{ fontSize: '1.2rem', color: 'var(--fg)' }}>
              {displayedTotals.completionTokens.toLocaleString('es-ES')}
            </strong>
          </div>
          <div
            className="horiz-err-item"
            onMouseEnter={() => setIsolatedTokenSeries('reasoning')}
            onMouseLeave={() => setIsolatedTokenSeries(null)}
          >
            <span className="field-hint" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <i className="p-dot" style={{ background: 'var(--c-bar-3)' }} />
              Reasoning tokens
            </span>
            <strong className="mono" style={{ fontSize: '1.2rem', color: 'var(--fg)' }}>
              {displayedTotals.reasoningTokens.toLocaleString('es-ES')}
            </strong>
          </div>
          <div className="horiz-err-item">
            <span className="field-hint">Total acumulado</span>
            <strong className="mono" style={{ fontSize: '1.2rem', color: 'var(--fg)' }}>
              {displayedTotals.totalTokens.toLocaleString('es-ES')}
            </strong>
          </div>
        </div>

        {activityLoading && visibleActivityItems.length === 0 ? (
          <p className="field-hint">Consultando actividad de tokens…</p>
        ) : visibleActivityItems.length === 0 ? (
          <div className="empty-state" style={{ padding: '24px 16px' }}>
            <p className="field-hint">Sin consumo de tokens registrado en el rango seleccionado.</p>
          </div>
        ) : (
          <div
            className="chart-stage"
            style={{
              opacity: activityLoading ? 0.55 : 1,
              transition: 'opacity 0.15s ease',
            }}
            onMouseLeave={() => setHoveredActivityIndex(null)}
          >
            <div className="chart-scroll-x">
              <svg
                className="chart-svg-responsive"
                viewBox={`0 0 ${actSvgW} ${actSvgH}`}
                style={{ width: '100%', height: 'auto', display: 'block' }}
                role="img"
                aria-label="Gráfico apilado de tokens prompt, completion y reasoning"
              >
              {[0, 0.25, 0.5, 0.75, 1].map((frac) => {
                const val = Math.round(maxActivityTokens * frac);
                const y = padT + actPlotH - frac * actPlotH;
                return (
                  <g key={frac}>
                    <line
                      x1={padL}
                      y1={y}
                      x2={actSvgW - padR}
                      y2={y}
                      stroke="var(--line)"
                      strokeDasharray={frac === 0 ? undefined : '2 3'}
                    />
                    <text
                      x={padL - 8}
                      y={y + 4}
                      textAnchor="end"
                      fontSize="10.5"
                      fill="var(--fg-3)"
                      fontFamily="var(--font-mono)"
                    >
                      {formatCompactCount(val)}
                    </text>
                  </g>
                );
              })}

              {visibleActivityItems.slice(0, 16).map((item, idx, arr) => {
                const slotW = actPlotW / arr.length;
                const barW = Math.min(34, Math.max(12, slotW * 0.52));
                const x = padL + idx * slotW + (slotW - barW) / 2;

                const hPrompt = (item.promptTokens / maxActivityTokens) * actPlotH;
                const hComp = (item.completionTokens / maxActivityTokens) * actPlotH;
                const hReas = (item.reasoningTokens / maxActivityTokens) * actPlotH;

                const yPrompt = padT + actPlotH - hPrompt;
                const yComp = yPrompt - hComp;
                const yReas = yComp - hReas;

                const maxLabelChars = Math.max(4, Math.min(14, Math.floor((slotW - 10) / 6.4)));
                const shortLabel =
                  item.label.length > maxLabelChars
                    ? `${item.label.slice(0, Math.max(3, maxLabelChars - 1))}…`
                    : item.label;
                const isColHovered = hoveredActivityIndex === idx;

                const canNavigateBar =
                  (activityGroupBy === 'model' && Boolean(onOpenModel)) ||
                  (activityGroupBy === 'provider' && Boolean(onOpenProvider));

                return (
                  <g
                    key={item.key}
                    style={{ cursor: canNavigateBar ? 'pointer' : 'default' }}
                    onMouseEnter={() => setHoveredActivityIndex(idx)}
                    onClick={() => {
                      if (activityGroupBy === 'model' && onOpenModel) {
                        onOpenModel(item.key || item.label);
                      } else if (activityGroupBy === 'provider' && onOpenProvider) {
                        onOpenProvider(item.key);
                      }
                    }}
                  >
                    <rect
                      x={padL + idx * slotW + 2}
                      y={padT}
                      width={Math.max(4, slotW - 4)}
                      height={actPlotH}
                      rx={4}
                      fill={isColHovered ? 'var(--surface-2)' : 'transparent'}
                    />
                    <rect
                      x={x}
                      y={yPrompt}
                      width={barW}
                      height={Math.max(0, hPrompt)}
                      fill="var(--c-bar-1)"
                      opacity={
                        isolatedTokenSeries && isolatedTokenSeries !== 'prompt' ? 0.2 : 1
                      }
                      rx={1.5}
                    />
                    <rect
                      x={x}
                      y={yComp}
                      width={barW}
                      height={Math.max(0, hComp)}
                      fill="var(--c-bar-2)"
                      opacity={
                        isolatedTokenSeries && isolatedTokenSeries !== 'completion' ? 0.2 : 1
                      }
                      rx={1.5}
                    />
                    <rect
                      x={x}
                      y={yReas}
                      width={barW}
                      height={Math.max(0, hReas)}
                      fill="var(--c-bar-3)"
                      opacity={
                        isolatedTokenSeries && isolatedTokenSeries !== 'reasoning' ? 0.2 : 1
                      }
                      rx={1.5}
                    />
                    <text
                      x={x + barW / 2}
                      y={actSvgH - 12}
                      textAnchor="middle"
                      fontSize="10"
                      fill="var(--fg-3)"
                      fontFamily="var(--font-mono)"
                    >
                      {shortLabel}
                    </text>
                  </g>
                );
              })}
              </svg>
            </div>

            {/* Bottom Legend Bar (OpenRouter Activity style) */}
            <div
              style={{
                borderTop: '1px solid var(--line)',
                paddingTop: 10,
                marginTop: 6,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                flexWrap: 'wrap',
                gap: 10,
                fontSize: '0.78rem',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
                <span
                  className="pct-legend-item"
                  onMouseEnter={() => setIsolatedTokenSeries('reasoning')}
                  onMouseLeave={() => setIsolatedTokenSeries(null)}
                >
                  <i className="p-dot" style={{ background: 'var(--c-bar-3)' }} />
                  Reasoning
                </span>
                <span
                  className="pct-legend-item"
                  onMouseEnter={() => setIsolatedTokenSeries('completion')}
                  onMouseLeave={() => setIsolatedTokenSeries(null)}
                >
                  <i className="p-dot" style={{ background: 'var(--c-bar-2)' }} />
                  Completion
                </span>
                <span
                  className="pct-legend-item"
                  onMouseEnter={() => setIsolatedTokenSeries('prompt')}
                  onMouseLeave={() => setIsolatedTokenSeries(null)}
                >
                  <i className="p-dot" style={{ background: 'var(--c-bar-1)' }} />
                  Prompt
                </span>
              </div>
              <span className="mono" style={{ color: 'var(--fg-3)' }}>
                {displayedTotals.totalTokens.toLocaleString('es-ES')} tokens
              </span>
            </div>

            {hoveredActivityIndex !== null && activeActivityItem ? (
              <div
                className="floating-white-tooltip"
                style={{ position: 'absolute', top: 10, right: 16 }}
              >
                <div
                  className="mono"
                  style={{
                    fontWeight: 600,
                    marginBottom: 6,
                    paddingBottom: 5,
                    borderBottom: '1px solid var(--tooltip-line)',
                  }}
                >
                  {activeActivityItem.label}
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16 }}>
                  <span
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 6,
                      color: 'var(--tooltip-sub)',
                    }}
                  >
                    <i className="p-dot" style={{ background: 'var(--c-bar-1)' }} />
                    Prompt
                  </span>
                  <strong className="mono">
                    {activeActivityItem.promptTokens.toLocaleString('es-ES')}
                  </strong>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16 }}>
                  <span
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 6,
                      color: 'var(--tooltip-sub)',
                    }}
                  >
                    <i className="p-dot" style={{ background: 'var(--c-bar-2)' }} />
                    Completion
                  </span>
                  <strong className="mono">
                    {activeActivityItem.completionTokens.toLocaleString('es-ES')}
                  </strong>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16 }}>
                  <span
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 6,
                      color: 'var(--tooltip-sub)',
                    }}
                  >
                    <i className="p-dot" style={{ background: 'var(--c-bar-3)' }} />
                    Reasoning
                  </span>
                  <strong className="mono">
                    {activeActivityItem.reasoningTokens.toLocaleString('es-ES')}
                  </strong>
                </div>
                <div
                  style={{
                    marginTop: 6,
                    paddingTop: 5,
                    borderTop: '1px solid var(--tooltip-line)',
                    display: 'flex',
                    justifyContent: 'space-between',
                    gap: 16,
                  }}
                >
                  <span style={{ color: 'var(--tooltip-sub)' }}>Total</span>
                  <strong className="mono">
                    {activeActivityItem.totalTokens.toLocaleString('es-ES')}
                  </strong>
                </div>
                {typeof activeActivityItem.requestsCount === 'number' ? (
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      gap: 16,
                      marginTop: 2,
                    }}
                  >
                    <span style={{ color: 'var(--tooltip-sub)' }}>Peticiones</span>
                    <strong className="mono">
                      {activeActivityItem.requestsCount.toLocaleString('es-ES')}
                    </strong>
                  </div>
                ) : null}
                {(activityGroupBy === 'model' && onOpenModel) ||
                (activityGroupBy === 'provider' && onOpenProvider) ? (
                  <div
                    style={{
                      marginTop: 5,
                      fontSize: '0.71rem',
                      color: 'var(--tooltip-sub)',
                    }}
                  >
                    Clic para abrir {activityGroupBy === 'model' ? 'ficha del modelo' : 'proveedor'} →
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        )}
      </section>
    </>
  );
};
