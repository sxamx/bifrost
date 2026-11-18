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
    // Default fallback: next 00:00 UTC midnight
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

  // Derive HU-17 Daily Quota Hero state
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

  return (
    <>
      <header className="page-header">
        <div>
          <h1 className="page-title">Resumen del sistema</h1>
          <p className="page-subtitle">
            Balance de cuota gratuita del día, salud del enrutador y punto de enlace local
            compatible con OpenAI.
          </p>
        </div>
        <button type="button" className="btn btn-secondary btn-sm" onClick={onNavigateMetrics}>
          Ver métricas detalladas →
        </button>
      </header>

      {/* HU-17 Primary Hero Block: "Cuota gratuita de hoy" */}
      <section className="quota-hero-card" aria-labelledby="daily-quota-hero-title">
        <div className="quota-hero-top">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
              <span className="meta-tag accent">Indicador principal</span>
              <h2 id="daily-quota-hero-title" className="card-title" style={{ fontSize: '1.18rem' }}>
                Cuota gratuita de hoy
              </h2>
              <InfoTip text="Calculada en el reloj UTC del servidor combinando los topes diarios configurados en tus claves y las cabeceras x-ratelimit-* reportadas por los proveedores." />
            </div>

            {summaryLoading && !summary ? (
              <p className="field-hint">Consultando consumo diario en core/…</p>
            ) : pctRemaining !== null ? (
              <p style={{ color: 'var(--sub)', fontSize: '0.94rem' }}>
                Consumidos hoy:{' '}
                <strong style={{ color: 'var(--fg)' }}>
                  {usedToday.toLocaleString('es-ES')} tokens
                </strong>
                {totalLimit ? (
                  <>
                    {' '}
                    de{' '}
                    <strong style={{ color: 'var(--fg)' }}>
                      {totalLimit.toLocaleString('es-ES')}
                    </strong>{' '}
                    disponibles
                  </>
                ) : null}
              </p>
            ) : (
              <p style={{ color: 'var(--sub)', fontSize: '0.94rem' }}>
                {effectiveProvidersCount === 0 ? (
                  'Aún no hay proveedores ni topes diarios configurados. Instala tu primer proveedor y define un tope estimado por cuenta para visualizar el porcentaje restante.'
                ) : (
                  <>
                    Sin tope diario numérico asignado · Consumo registrado hoy:{' '}
                    <strong style={{ color: 'var(--fg)' }}>
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
                <span className="field-hint" style={{ fontWeight: 700 }}>
                  disponible hoy
                </span>
              </>
            ) : (
              <>
                <div
                  className="quota-hero-pct"
                  style={{ fontSize: '1.9rem', color: 'var(--fg)' }}
                >
                  {effectiveProvidersCount === 0 ? '—' : '100%'}
                </div>
                <span className="field-hint" style={{ fontWeight: 700 }}>
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
            fontSize: '0.84rem',
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
              Nodos en línea: <strong>{summary.onlineNodesCount}</strong>
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

      <section className="kpi-grid" aria-label="Indicadores principales">
        <article className="kpi-card">
          <div className="kpi-label-row">
            <span>Proveedores conectados</span>
            <InfoTip text="Adaptadores activos instalados en core/ listos para enrutar peticiones." />
          </div>
          <div className="kpi-value">{effectiveProvidersCount}</div>
          <div className="kpi-footnote">
            <span className={`status-dot ${effectiveProvidersCount > 0 ? 'ok' : 'partial'}`} />
            <span>
              {effectiveProvidersCount > 0
                ? 'Enrutamiento disponible'
                : 'Pendiente de primer proveedor'}
            </span>
          </div>
        </article>

        <article className="kpi-card">
          <div className="kpi-label-row">
            <span>Modelos activos</span>
            <InfoTip text="Catálogo combinado de modelos gratuitos expuestos por tus proveedores configurados." />
          </div>
          <div className="kpi-value">{effectiveModelsCount}</div>
          <div className="kpi-footnote">
            <span className={`status-dot ${effectiveModelsCount > 0 ? 'ok' : 'partial'}`} />
            <span>Expuestos vía /v1/models</span>
          </div>
        </article>

        <article className="kpi-card">
          <div className="kpi-label-row">
            <span>API Keys internas</span>
            <InfoTip text="Llaves sk-bf-… asociadas a tu cuenta para autenticar editores y herramientas." />
          </div>
          <div className="kpi-value">{keysCount}</div>
          <div className="kpi-footnote">
            <span className={`status-dot ${keysCount > 0 ? 'ok' : 'partial'}`} />
            <span>{keysCount === 1 ? '1 llave activa' : `${keysCount} llaves activas`}</span>
          </div>
        </article>
      </section>

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
            <div className="field-hint" style={{ marginBottom: 6 }}>
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
