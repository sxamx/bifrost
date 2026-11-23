import React, { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { copyTextToClipboard } from '../clipboard';
import type {
  AuthUser,
  DashboardStats,
  FreeQuotaStatus,
  MetricsSummary,
  ProviderRateLimitWindow,
  ProviderSummary,
  QuotaConfidence,
  SystemUpdateStatus,
} from '../types';
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

function formatActiveWindowLabel(w?: ProviderRateLimitWindow | null): string {
  if (w === 'hour') return 'Ventana: hora';
  if (w === 'week') return 'Ventana: semana';
  return 'Ventana: día';
}

function formatConfidenceLabel(c?: QuotaConfidence | null): string {
  if (c === 'header_exact') return 'Exacto por cabecera';
  if (c === 'inferred') return 'Inferido por 429';
  return 'Configurado';
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
  const [freeQuota, setFreeQuota] = useState<FreeQuotaStatus | null>(null);
  const [summaryLoading, setSummaryLoading] = useState(true);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [copiedEndpoint, setCopiedEndpoint] = useState(false);

  // HU-41 System Update State (admin only)
  const [healthInfo, setHealthInfo] = useState<{
    version?: string;
    buildCommit?: string | null;
  } | null>(null);
  const [updateStatus, setUpdateStatus] = useState<SystemUpdateStatus | null>(null);
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const [triggeringUpdate, setTriggeringUpdate] = useState(false);
  const [updateFeedback, setUpdateFeedback] = useState<string | null>(null);
  const [updateProgress, setUpdateProgress] = useState<{
    active: boolean;
    pct: number;
    label: string;
    isError?: boolean;
  } | null>(null);
  const [copiedUpdateCmd, setCopiedUpdateCmd] = useState(false);
  const isMountedRef = useRef(true);
  const updatePollTimerRef = useRef<number | null>(null);
  const reloadTimerRef = useRef<number | null>(null);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      if (updatePollTimerRef.current !== null) {
        window.clearInterval(updatePollTimerRef.current);
        updatePollTimerRef.current = null;
      }
      if (reloadTimerRef.current !== null) {
        window.clearTimeout(reloadTimerRef.current);
        reloadTimerRef.current = null;
      }
    };
  }, []);

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
    Promise.allSettled([api.getMetricsSummary(), api.getFreeQuota()])
      .then(([sumRes, fqRes]) => {
        if (cancelled) return;
        setSummary(sumRes.status === 'fulfilled' ? sumRes.value : null);
        setFreeQuota(fqRes.status === 'fulfilled' ? fqRes.value : null);
      })
      .finally(() => {
        if (!cancelled) setSummaryLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [providers.length, keysCount]);

  useEffect(() => {
    let cancelled = false;
    api
      .getHealth()
      .then((h) => {
        if (!cancelled) setHealthInfo({ version: h.version, buildCommit: h.buildCommit });
      })
      .catch(() => {
        // ignore
      });
    if (isAdmin) {
      api
        .getUpdateStatus(false)
        .then((st) => {
          if (!cancelled) setUpdateStatus(st);
        })
        .catch(() => {
          // Silent if backend does not expose or offline
        });
    }
    return () => {
      cancelled = true;
    };
  }, [isAdmin]);

  async function handleCheckUpdateNow() {
    if (!isAdmin) return;
    setCheckingUpdate(true);
    setUpdateFeedback(null);
    try {
      const st = await api.getUpdateStatus(true);
      if (!isMountedRef.current) return;
      setUpdateStatus(st);
      if (!st.updateAvailable) {
        setUpdateFeedback('Bifrost ya está en la última versión disponible.');
      }
    } catch {
      if (!isMountedRef.current) return;
      setUpdateFeedback('No se pudo comprobar actualizaciones en este momento.');
    } finally {
      if (isMountedRef.current) setCheckingUpdate(false);
    }
  }

  async function handleTriggerUpdateNow() {
    if (!isAdmin) return;
    if (updatePollTimerRef.current !== null) {
      window.clearInterval(updatePollTimerRef.current);
      updatePollTimerRef.current = null;
    }
    if (reloadTimerRef.current !== null) {
      window.clearTimeout(reloadTimerRef.current);
      reloadTimerRef.current = null;
    }

    const previousCommit = updateStatus?.currentCommit ?? healthInfo?.buildCommit ?? null;
    const expectedLatest = updateStatus?.latestCommit ?? null;

    setTriggeringUpdate(true);
    setUpdateFeedback(null);
    setUpdateProgress({
      active: true,
      pct: 15,
      label: 'Enviando orden de actualización…',
    });

    try {
      const res = await api.triggerSystemUpdate();
      if (!isMountedRef.current) return;
      if (res.upToDate) {
        setUpdateProgress(null);
        setTriggeringUpdate(false);
        setUpdateFeedback(res.message || 'Bifrost ya está al día.');
        return;
      }

      setUpdateProgress({
        active: true,
        pct: 35,
        label: res.message || 'Descargando nueva versión…',
      });

      const startedAt = Date.now();
      let sawDisconnect = false;
      let polling = false;

      const pollOnce = async () => {
        if (!isMountedRef.current || polling) return;
        polling = true;
        try {
          if (Date.now() - startedAt > 90_000) {
            if (updatePollTimerRef.current !== null) {
              window.clearInterval(updatePollTimerRef.current);
              updatePollTimerRef.current = null;
            }
            if (!isMountedRef.current) return;
            setTriggeringUpdate(false);
            setUpdateProgress({
              active: false,
              pct: 100,
              label:
                'Tiempo de espera agotado (90s). Recarga manualmente o revisa los logs del servidor.',
              isError: true,
            });
            return;
          }

          const [hRes, stRes] = await Promise.allSettled([
            api.getHealth(),
            api.getUpdateStatus(false),
          ]);
          if (!isMountedRef.current) return;

          if (hRes.status === 'rejected') {
            sawDisconnect = true;
            setUpdateProgress({
              active: true,
              pct: 75,
              label: 'Reiniciando servidor…',
            });
            return;
          }

          const liveCommit = hRes.value.buildCommit ?? null;
          const liveStatus = stRes.status === 'fulfilled' ? stRes.value : null;
          if (liveStatus) setUpdateStatus(liveStatus);

          const commitChanged =
            Boolean(liveCommit) &&
            ((Boolean(previousCommit) && liveCommit !== previousCommit) ||
              (sawDisconnect && (!expectedLatest || liveCommit === expectedLatest)));

          if (commitChanged) {
            if (updatePollTimerRef.current !== null) {
              window.clearInterval(updatePollTimerRef.current);
              updatePollTimerRef.current = null;
            }
            setUpdateProgress({
              active: true,
              pct: 100,
              label: '¡Actualizado correctamente! Recargando…',
            });
            reloadTimerRef.current = window.setTimeout(() => {
              if (isMountedRef.current) window.location.reload();
            }, 1200);
            return;
          }

          const phase = liveStatus?.updatePhase;
          const phaseMsg = liveStatus?.updatePhaseMessage;
          if (phase === 'error') {
            if (updatePollTimerRef.current !== null) {
              window.clearInterval(updatePollTimerRef.current);
              updatePollTimerRef.current = null;
            }
            setTriggeringUpdate(false);
            setUpdateProgress({
              active: false,
              pct: 100,
              label: phaseMsg || 'Error durante la actualización.',
              isError: true,
            });
          } else if (phase === 'pulling') {
            setUpdateProgress({
              active: true,
              pct: 45,
              label: phaseMsg || 'Descargando nueva versión…',
            });
          } else if (phase === 'building') {
            setUpdateProgress({
              active: true,
              pct: 60,
              label: phaseMsg || 'Compilando nueva versión…',
            });
          } else if (phase === 'restarting' || sawDisconnect) {
            setUpdateProgress({
              active: true,
              pct: 75,
              label: phaseMsg || 'Reiniciando servidor…',
            });
          } else {
            setUpdateProgress((prev) => ({
              active: true,
              pct: Math.min(70, (prev?.pct ?? 35) + 5),
              label: phaseMsg || prev?.label || 'Descargando nueva versión…',
            }));
          }
        } catch {
          if (!isMountedRef.current) return;
          sawDisconnect = true;
          setUpdateProgress({
            active: true,
            pct: 75,
            label: 'Reiniciando servidor…',
          });
        } finally {
          polling = false;
        }
      };

      if (!isMountedRef.current) return;
      updatePollTimerRef.current = window.setInterval(() => {
        void pollOnce();
      }, 2000);
    } catch (err) {
      if (!isMountedRef.current) return;
      setTriggeringUpdate(false);
      setUpdateProgress({
        active: false,
        pct: 100,
        label:
          err instanceof Error ? err.message : 'No se pudo iniciar la actualización automática.',
        isError: true,
      });
    }
  }

  useEffect(() => {
    const timer = window.setInterval(() => {
      setNowMs(Date.now());
    }, 1000);
    return () => window.clearInterval(timer);
  }, []);

  async function handleCopyEndpoint() {
    const ok = await copyTextToClipboard(baseUrl);
    if (ok) {
      setCopiedEndpoint(true);
      window.setTimeout(() => setCopiedEndpoint(false), 2200);
    } else {
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

  const effectiveActiveWindow = freeQuota?.activeWindow ?? summary?.activeWindow ?? 'day';
  const effectiveConfidence = freeQuota?.confidence ?? summary?.quotaConfidence ?? 'configured';
  const effectiveAdaptiveAdjusted = Boolean(
    freeQuota?.adaptiveAdjusted ?? summary?.adaptiveAdjusted
  );
  const totalLimit =
    freeQuota?.effectiveLimit ??
    summary?.effectiveLimit ??
    summary?.totalDailyLimit ??
    (typeof user.dailyTokenLimit === 'number' && user.dailyTokenLimit > 0
      ? user.dailyTokenLimit
      : null);
  const usedToday = freeQuota?.usedInWindow ?? summary?.usedTokensToday ?? 0;
  const hasConfiguredLimit = totalLimit !== null && totalLimit > 0;

  const pctRemaining =
    freeQuota?.quotaPercentageRemaining !== null && freeQuota?.quotaPercentageRemaining !== undefined
      ? Math.round(freeQuota.quotaPercentageRemaining)
      : summary?.quotaPercentageRemaining !== null && summary?.quotaPercentageRemaining !== undefined
        ? Math.round(summary.quotaPercentageRemaining)
        : hasConfiguredLimit && totalLimit
          ? Math.max(0, Math.min(100, Math.round(((totalLimit - usedToday) / totalLimit) * 100)))
          : null;

  const providerQuotasList = freeQuota?.providers ?? summary?.providerQuotas ?? [];

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

      {/* HU-41 System Update Card (always accessible for admin) */}
      {isAdmin ? (
        <section className="card" aria-label="Estado de versión y actualizaciones de Bifrost">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 14,
                flexWrap: 'wrap',
              }}
            >
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  {updateStatus?.updateAvailable ? (
                    <span className="status-badge active">Actualización disponible</span>
                  ) : (
                    <span className="meta-tag verified">Al día</span>
                  )}
                  <strong style={{ fontSize: '0.92rem' }}>
                    {updateStatus?.updateAvailable
                      ? updateStatus.latestCommitMessage || 'Nueva versión de Bifrost disponible'
                      : 'Sistema Bifrost actualizado'}
                  </strong>
                  {(updateStatus?.currentVersion || healthInfo?.version) ? (
                    <span className="meta-tag mono">
                      v{updateStatus?.currentVersion || healthInfo?.version}
                      {(updateStatus?.currentCommit || healthInfo?.buildCommit)
                        ? ` · ${(updateStatus?.currentCommit || healthInfo?.buildCommit)?.slice(0, 7)}`
                        : ''}
                    </span>
                  ) : null}
                  {updateStatus?.updateAvailable && updateStatus.latestCommitUrl ? (
                    <a
                      href={updateStatus.latestCommitUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="meta-tag accent mono"
                      style={{ textDecoration: 'none' }}
                    >
                      → {updateStatus.latestCommit?.slice(0, 7) || 'commit'} ↗
                    </a>
                  ) : null}
                </div>
                {updateFeedback && !updateProgress ? (
                  <span className="field-hint" style={{ color: 'var(--ok)' }}>
                    {updateFeedback}
                  </span>
                ) : null}
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  disabled={checkingUpdate || triggeringUpdate}
                  onClick={() => void handleCheckUpdateNow()}
                >
                  {checkingUpdate ? 'Comprobando…' : 'Comprobar ahora'}
                </button>
                {updateStatus?.updateAvailable ? (
                  updateStatus.canAutoUpdate ? (
                    <button
                      type="button"
                      className="btn btn-primary btn-sm"
                      disabled={triggeringUpdate}
                      onClick={() => void handleTriggerUpdateNow()}
                    >
                      {triggeringUpdate ? 'Actualizando…' : 'Actualizar ahora'}
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="btn btn-primary btn-sm"
                      onClick={() => {
                        const cmd =
                          updateStatus.runtimeMode === 'docker'
                            ? 'docker compose pull && docker compose up -d'
                            : 'git pull && npm run build && systemctl restart bifrost';
                        void copyTextToClipboard(cmd).then((ok) => {
                          if (!ok) return;
                          setCopiedUpdateCmd(true);
                          window.setTimeout(() => setCopiedUpdateCmd(false), 2200);
                        });
                      }}
                    >
                      {copiedUpdateCmd
                        ? '✓ Comando copiado'
                        : `Copiar comando (${updateStatus.runtimeMode})`}
                    </button>
                  )
                ) : null}
              </div>
            </div>

            {updateProgress ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 10,
                    fontSize: '0.82rem',
                  }}
                >
                  <span style={{ color: updateProgress.isError ? 'var(--err)' : 'var(--fg-2)' }}>
                    {updateProgress.label}
                  </span>
                  {!updateProgress.isError ? (
                    <strong className="mono" style={{ color: 'var(--accent)' }}>
                      {updateProgress.pct}%
                    </strong>
                  ) : null}
                </div>
                <div className="quota-track" style={{ height: 6 }}>
                  <div
                    className={`quota-fill ${updateProgress.isError ? 'critical' : 'healthy'}`}
                    style={{
                      width: `${updateProgress.pct}%`,
                      transition: 'width 0.35s ease',
                    }}
                  />
                </div>
              </div>
            ) : null}
          </div>
        </section>
      ) : null}

      {/* HU-17 Primary Hero Block: "Cuota gratuita de hoy" */}
      <section className="quota-hero-card" aria-labelledby="daily-quota-hero-title">
        <div className="quota-hero-top">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <span className="meta-tag accent">{formatActiveWindowLabel(effectiveActiveWindow)}</span>
              <span className="meta-tag">{formatConfidenceLabel(effectiveConfidence)}</span>
              {effectiveAdaptiveAdjusted ? (
                <span className="status-badge rate_limited">Ajuste adaptativo 429</span>
              ) : null}
              <h2 id="daily-quota-hero-title" className="card-title">
                Cuota gratuita de hoy
              </h2>
              <InfoTip text="Calculada en el reloj UTC del servidor combinando los topes configurados en tus claves, cabeceras x-ratelimit-* y ajuste adaptativo ante respuestas 429." />
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

        {providerQuotasList.length > 0 ? (
          <div
            style={{
              marginTop: 6,
              paddingTop: 12,
              borderTop: '1px solid var(--line)',
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 220px), 1fr))',
              gap: 10,
            }}
          >
            {providerQuotasList.map((pq) => {
              const unitTxt = pq.unit === 'requests' ? 'pet.' : 'tok';
              const winTxt = pq.windowLabel || formatActiveWindowLabel(pq.activeWindow);
              const confidenceTxt =
                pq.effectiveLimit === null && pq.recent429Count7d === 0
                  ? 'Sin límite fijo'
                  : formatConfidenceLabel(pq.confidence);
              return (
                <div
                  key={pq.providerId}
                  style={{
                    background: 'var(--bg)',
                    border: '1px solid var(--line)',
                    borderRadius: 8,
                    padding: '9px 11px',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 4,
                  }}
                >
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: 6,
                    }}
                  >
                    <strong style={{ fontSize: '0.82rem', color: 'var(--fg)' }}>
                      {pq.providerName}
                    </strong>
                    <span className="meta-tag mono">{winTxt}</span>
                  </div>
                  <div className="mono" style={{ fontSize: '0.78rem', color: 'var(--sub)' }}>
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
                      fontSize: '0.72rem',
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
        ) : null}
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
