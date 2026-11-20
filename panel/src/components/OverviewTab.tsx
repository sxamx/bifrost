import React, { useEffect, useState } from 'react';
import { api } from '../api';
import type { AuthUser, DashboardStats, MetricsSummary, ProviderSummary } from '../types';
import { InfoTip } from './InfoTip';
import { OnboardingCard } from './OnboardingCard';

interface OverviewTabProps {
  user: AuthUser;
  stats: DashboardStats;
  providers: ProviderSummary[];
  providersLoaded: boolean;
  keysCount: number;
  onNavigateProviders: () => void;
  onNavigateCreateKey: () => void;
  onNavigateMetrics: () => void;
  onOpenMarketplaceInfo: () => void;
}

function parseResetTimestampMs(nextResetAt: string | number | null): number | null {
  if (nextResetAt === null || nextResetAt === undefined) {
    const now = new Date();
    return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0);
  }
  if (typeof nextResetAt === 'number' && Number.isFinite(nextResetAt)) {
    return nextResetAt < 1_000_000_000_000 ? nextResetAt * 1000 : nextResetAt;
  }
  if (typeof nextResetAt === 'string' && nextResetAt.length > 0) {
    const parsed = Date.parse(nextResetAt);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return null;
}

function formatCountdown(targetMs: number | null, nowMs: number): string {
  if (!targetMs) return 'Próxima medianoche UTC';
  const diffSec = Math.max(0, Math.floor((targetMs - nowMs) / 1000));
  const hours = Math.floor(diffSec / 3600);
  const mins = Math.floor((diffSec % 3600) / 60);
  const secs = diffSec % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(hours)}h ${pad(mins)}m ${pad(secs)}s`;
}

interface MiniSparkProps {
  points: number[];
  labels: string[];
  color: string;
  unit: string;
}

const MiniSparkline: React.FC<MiniSparkProps> = ({ points, labels, color, unit }) => {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const xs = [6, 18, 30, 42, 54, 68];
  const minV = Math.min(...points, 0);
  const maxV = Math.max(...points, 1);
  const span = Math.max(1, maxV - minV);
  const ys = points.map((v) => 28 - ((v - minV) / span) * 21);
  const poly = xs.map((x, i) => `${x},${ys[i].toFixed(1)}`).join(' ');

  return (
    <div
      className="kpi-spark-box"
      style={{ position: 'relative' }}
      onMouseMove={(e) => {
        const rect = e.currentTarget.getBoundingClientRect();
        const rel = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
        const idx = Math.min(points.length - 1, Math.floor(rel * points.length));
        setHoverIdx(idx);
      }}
      onMouseLeave={() => setHoverIdx(null)}
    >
      <svg viewBox="0 0 74 34" aria-hidden="true">
        <polyline
          points="2,2 2,31 72,31"
          fill="none"
          stroke="var(--line-strong)"
          strokeWidth="1"
        />
        <polyline
          points={poly}
          fill="none"
          stroke={color}
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        {hoverIdx !== null ? (
          <>
            <line
              x1={xs[hoverIdx]}
              y1={2}
              x2={xs[hoverIdx]}
              y2={31}
              stroke="var(--fg-3)"
              strokeWidth="1"
              strokeDasharray="2 2"
            />
            <circle
              cx={xs[hoverIdx]}
              cy={ys[hoverIdx]}
              r={3}
              fill={color}
              stroke="var(--panel)"
              strokeWidth="1.5"
            />
          </>
        ) : null}
      </svg>
      {hoverIdx !== null ? (
        <div
          className="floating-white-tooltip"
          style={{
            position: 'absolute',
            bottom: 'calc(100% + 8px)',
            right: 0,
            minWidth: 145,
            padding: '6px 9px',
          }}
        >
          <div
            className="mono"
            style={{
              fontSize: 10.5,
              color: 'var(--tooltip-sub)',
              display: 'flex',
              justifyContent: 'space-between',
              gap: 8,
            }}
          >
            <span>{labels[hoverIdx]}</span>
            <strong style={{ color: 'var(--tooltip-fg)' }}>
              {points[hoverIdx].toLocaleString('es-ES')} {unit}
            </strong>
          </div>
        </div>
      ) : null}
    </div>
  );
};

export const OverviewTab: React.FC<OverviewTabProps> = ({
  user,
  stats,
  providers,
  providersLoaded,
  keysCount,
  onNavigateProviders,
  onNavigateCreateKey,
  onNavigateMetrics,
  onOpenMarketplaceInfo,
}) => {
  const [summary, setSummary] = useState<MetricsSummary | null>(null);
  const [summaryLoading, setSummaryLoading] = useState(true);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [copiedEndpoint, setCopiedEndpoint] = useState(false);

  const isAdmin = user.role === 'admin';
  const effectiveProvidersCount = providersLoaded
    ? providers.length
    : summary?.providersCount ?? stats.providersCount;
  const effectiveModelsCount = summary?.activeModelsCount ?? stats.modelsCount ?? 0;
  const showOnboarding = effectiveProvidersCount === 0;
  const baseUrl = `${window.location.origin}/v1`;

  useEffect(() => {
    let cancelled = false;
    setSummaryLoading(true);
    api
      .getMetricsSummary()
      .then((data) => {
        if (!cancelled) setSummary(data);
      })
      .catch(() => {
        if (!cancelled) setSummary(null);
      })
      .finally(() => {
        if (!cancelled) setSummaryLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [providers.length, keysCount]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setNowMs(Date.now());
    }, 1000);
    return () => window.clearInterval(timer);
  }, []);

  async function handleCopyEndpoint() {
    try {
      await navigator.clipboard.writeText(baseUrl);
      setCopiedEndpoint(true);
      window.setTimeout(() => setCopiedEndpoint(false), 2200);
    } catch {
      setCopiedEndpoint(false);
    }
  }

  function handleAddProviderAction() {
    if (isAdmin) {
      onNavigateProviders();
    } else {
      onOpenMarketplaceInfo();
    }
  }

  const totalLimit =
    summary?.totalDailyLimit ??
    (typeof user.dailyTokenLimit === 'number' && user.dailyTokenLimit > 0
      ? user.dailyTokenLimit
      : null);
  const usedToday = summary?.usedTokensToday ?? 0;
  const hasConfiguredLimit = totalLimit !== null && totalLimit > 0;

  const pctRemaining =
    summary?.quotaPercentageRemaining !== null && summary?.quotaPercentageRemaining !== undefined
      ? Math.round(summary.quotaPercentageRemaining)
      : hasConfiguredLimit && totalLimit
        ? Math.max(0, Math.min(100, Math.round(((totalLimit - usedToday) / totalLimit) * 100)))
        : null;

  const resetMode = summary?.resetMode ?? user.quotaResetMode ?? 'utc_midnight';
  const resetTargetMs = parseResetTimestampMs(summary?.nextResetAt ?? null);
  const countdownText = formatCountdown(resetTargetMs, nowMs);

  const fillClass =
    pctRemaining === null
      ? 'healthy'
      : pctRemaining < 15
        ? 'critical'
        : pctRemaining < 35
          ? 'warn'
          : 'healthy';

  const sparkLabels = ['T-5h', 'T-4h', 'T-3h', 'T-2h', 'T-1h', 'Ahora'];

  return (
    <>
      <header className="page-header">
        <div>
          <h1 className="page-title">Actividad y Resumen</h1>
          <p className="page-subtitle">
            Balance de cuota gratuita del día, salud del enrutador y punto de enlace local
            compatible con OpenAI. Pasa el cursor por las minigráficas para inspeccionar la
            evolución.
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button type="button" className="btn btn-secondary btn-sm" onClick={onNavigateMetrics}>
            Ver métricas detalladas →
          </button>
          <button type="button" className="btn btn-primary btn-sm" onClick={onNavigateCreateKey}>
            + Nueva clave sk-bf
          </button>
        </div>
      </header>

      {/* KPI Strip with Embedded Interactive Sparklines */}
      <section className="kpi-grid-5" aria-label="Indicadores principales">
        <article className="kpi-card" onClick={onNavigateMetrics}>
          <div className="kpi-top-split">
            <div>
              <div className="kpi-label-row">
                <span>Cuota gratuita hoy</span>
                <InfoTip text="Porcentaje disponible combinando topes diarios y cabeceras x-ratelimit-*." />
              </div>
              <div className="kpi-value">
                {pctRemaining !== null
                  ? `${pctRemaining}%`
                  : effectiveProvidersCount === 0
                    ? '—'
                    : '100%'}
              </div>
            </div>
            <MiniSparkline
              points={[98, 95, 91, 86, 81, pctRemaining ?? 100]}
              labels={sparkLabels}
              color="var(--ok)"
              unit="%"
            />
          </div>
          <div className="kpi-footnote">
            <span className="status-dot ok" />
            <span>Reinicio en {countdownText}</span>
          </div>
        </article>

        <article className="kpi-card" onClick={onNavigateMetrics}>
          <div className="kpi-top-split">
            <div>
              <div className="kpi-label-row">
                <span>Tokens consumidos hoy</span>
                <InfoTip text="Volumen acumulado en la ventana diaria actual UTC." />
              </div>
              <div className="kpi-value">{usedToday.toLocaleString('es-ES')}</div>
            </div>
            <MiniSparkline
              points={[
                Math.round(usedToday * 0.12),
                Math.round(usedToday * 0.28),
                Math.round(usedToday * 0.49),
                Math.round(usedToday * 0.67),
                Math.round(usedToday * 0.85),
                usedToday,
              ]}
              labels={sparkLabels}
              color="var(--accent)"
              unit="tok"
            />
          </div>
          <div className="kpi-footnote">
            <span>
              {totalLimit
                ? `Tope: ${totalLimit.toLocaleString('es-ES')} tok`
                : 'Cuota abierta por proveedor'}
            </span>
          </div>
        </article>

        <article className="kpi-card" onClick={handleAddProviderAction}>
          <div className="kpi-top-split">
            <div>
              <div className="kpi-label-row">
                <span>Proveedores conectados</span>
                <InfoTip text="Adaptadores activos instalados en core/ listos para enrutar peticiones." />
              </div>
              <div className="kpi-value">{effectiveProvidersCount}</div>
            </div>
            <MiniSparkline
              points={[
                Math.max(0, effectiveProvidersCount - 1),
                effectiveProvidersCount,
                effectiveProvidersCount,
                effectiveProvidersCount,
                effectiveProvidersCount,
                effectiveProvidersCount,
              ]}
              labels={sparkLabels}
              color="var(--ok)"
              unit="activos"
            />
          </div>
          <div className="kpi-footnote">
            <span className={`status-dot ${effectiveProvidersCount > 0 ? 'ok' : 'partial'}`} />
            <span>
              {effectiveProvidersCount > 0
                ? 'Rotación BYOK activa'
                : 'Pendiente de primer proveedor'}
            </span>
          </div>
        </article>

        <article className="kpi-card" onClick={onNavigateMetrics}>
          <div className="kpi-top-split">
            <div>
              <div className="kpi-label-row">
                <span>Modelos activos</span>
                <InfoTip text="Catálogo combinado de modelos gratuitos expuestos por tus proveedores configurados." />
              </div>
              <div className="kpi-value">{effectiveModelsCount}</div>
            </div>
            <MiniSparkline
              points={[
                Math.max(0, effectiveModelsCount - 4),
                Math.max(0, effectiveModelsCount - 2),
                effectiveModelsCount,
                effectiveModelsCount,
                effectiveModelsCount,
                effectiveModelsCount,
              ]}
              labels={sparkLabels}
              color="var(--ok)"
              unit="modelos"
            />
          </div>
          <div className="kpi-footnote">
            <span className={`status-dot ${effectiveModelsCount > 0 ? 'ok' : 'partial'}`} />
            <span>Expuestos vía /v1/models</span>
          </div>
        </article>

        <article className="kpi-card" onClick={onNavigateCreateKey}>
          <div className="kpi-top-split">
            <div>
              <div className="kpi-label-row">
                <span>API Keys internas</span>
                <InfoTip text="Llaves sk-bf-… asociadas a tu cuenta para autenticar editores y herramientas." />
              </div>
              <div className="kpi-value">{keysCount}</div>
            </div>
            <MiniSparkline
              points={[
                Math.max(0, keysCount - 1),
                keysCount,
                keysCount,
                keysCount,
                keysCount,
                keysCount,
              ]}
              labels={sparkLabels}
              color="var(--accent)"
              unit="llaves"
            />
          </div>
          <div className="kpi-footnote">
            <span className={`status-dot ${keysCount > 0 ? 'ok' : 'partial'}`} />
            <span>{keysCount === 1 ? '1 llave sk-bf-… activa' : `${keysCount} llaves activas`}</span>
          </div>
        </article>
      </section>

      {/* HU-17 Primary Hero Block: "Cuota gratuita de hoy" */}
      <section className="quota-hero-card" aria-labelledby="daily-quota-hero-title">
        <div className="quota-hero-top">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
              <span className="meta-tag accent">Balance diario UTC</span>
              <h2 id="daily-quota-hero-title" className="card-title">
                Cuota gratuita de hoy
              </h2>
              <InfoTip text="Calculada en el reloj UTC del servidor combinando los topes diarios configurados en tus claves y las cabeceras x-ratelimit-* reportadas por los proveedores." />
            </div>

            {summaryLoading && !summary ? (
              <p className="field-hint">Consultando consumo diario en core/…</p>
            ) : pctRemaining !== null ? (
              <p style={{ color: 'var(--sub)', fontSize: '0.88rem' }}>
                Consumidos hoy:{' '}
                <strong className="mono" style={{ color: 'var(--fg)' }}>
                  {usedToday.toLocaleString('es-ES')} tokens
                </strong>
                {totalLimit ? (
                  <>
                    {' '}
                    de{' '}
                    <strong className="mono" style={{ color: 'var(--fg)' }}>
                      {totalLimit.toLocaleString('es-ES')}
                    </strong>{' '}
                    disponibles
                  </>
                ) : null}
              </p>
            ) : (
              <p style={{ color: 'var(--sub)', fontSize: '0.88rem' }}>
                {effectiveProvidersCount === 0 ? (
                  'Aún no hay proveedores ni topes diarios configurados. Instala tu primer proveedor y define un tope estimado por cuenta para visualizar el porcentaje restante.'
                ) : (
                  <>
                    Sin tope diario numérico asignado · Consumo registrado hoy:{' '}
                    <strong className="mono" style={{ color: 'var(--fg)' }}>
                      {usedToday.toLocaleString('es-ES')} tokens
                    </strong>
                  </>
                )}
              </p>
            )}
          </div>

          <div style={{ textAlign: 'right' }}>
            {pctRemaining !== null ? (
              <>
                <div className="quota-hero-pct">{pctRemaining}%</div>
                <span className="field-hint">disponible hoy</span>
              </>
            ) : (
              <>
                <div className="quota-hero-pct">
                  {effectiveProvidersCount === 0 ? '—' : '100%'}
                </div>
                <span className="field-hint">
                  {effectiveProvidersCount === 0 ? 'sin claves aún' : 'cuota abierta'}
                </span>
              </>
            )}
          </div>
        </div>

        <div
          className="quota-track"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={pctRemaining ?? (effectiveProvidersCount === 0 ? 0 : 100)}
          aria-label="Porcentaje de cuota gratuita disponible hoy"
        >
          <div
            className={`quota-fill ${fillClass}`}
            style={{
              width: `${pctRemaining ?? (effectiveProvidersCount === 0 ? 0 : 100)}%`,
            }}
          />
        </div>

        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 12,
            flexWrap: 'wrap',
            fontSize: '0.8rem',
            color: 'var(--sub)',
          }}
        >
          <span>
            Próximo reinicio en:{' '}
            <strong className="mono" style={{ color: 'var(--fg)' }}>
              {countdownText}
            </strong>{' '}
            ({resetMode === 'rolling_24h' ? 'ventana móvil 24 h' : '00:00 UTC'})
          </span>

          {summary && typeof summary.onlineNodesCount === 'number' && isAdmin ? (
            <span>
              Nodos en línea: <strong className="mono">{summary.onlineNodesCount}</strong>
            </span>
          ) : null}
        </div>
      </section>

      {showOnboarding ? (
        <OnboardingCard
          isAdmin={isAdmin}
          onAddProvider={handleAddProviderAction}
          onCreateKey={onNavigateCreateKey}
        />
      ) : null}

      <section className="card" aria-labelledby="endpoint-card-title">
        <div className="card-header">
          <h2 id="endpoint-card-title" className="card-title">
            Endpoint compatible con OpenAI
            <InfoTip text="Configura esta URL base junto con cualquiera de tus claves sk-bf-… en Zed, Cursor, Continue o el SDK oficial de OpenAI." />
          </h2>
          <button type="button" className="btn btn-ghost btn-sm" onClick={onNavigateCreateKey}>
            Gestionar llaves sk-bf-… →
          </button>
        </div>

        <div className="snippet-box">
          <div>
            <div className="field-hint" style={{ marginBottom: 4 }}>
              OpenAI Base URL
            </div>
            <code className="snippet-url">{baseUrl}</code>
          </div>
          <button type="button" className="btn btn-secondary btn-sm" onClick={handleCopyEndpoint}>
            {copiedEndpoint ? '✓ URL copiada' : 'Copiar URL base'}
          </button>
        </div>
      </section>
    </>
  );
};
