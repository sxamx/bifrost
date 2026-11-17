import React, { useState } from 'react';
import type { AuthUser, DashboardStats, ProviderSummary } from '../types';
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
  onOpenMarketplaceInfo: () => void;
}

export const OverviewTab: React.FC<OverviewTabProps> = ({
  user,
  stats,
  providers,
  providersLoaded,
  keysCount,
  onNavigateProviders,
  onNavigateCreateKey,
  onOpenMarketplaceInfo,
}) => {
  const [copiedEndpoint, setCopiedEndpoint] = useState(false);

  const isAdmin = user.role === 'admin';
  const effectiveProvidersCount = providersLoaded ? providers.length : stats.providersCount;
  const showOnboarding = effectiveProvidersCount === 0;
  const baseUrl = `${window.location.origin}/v1`;

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

  const dailyLimitLabel =
    typeof user.dailyTokenLimit === 'number' && user.dailyTokenLimit > 0
      ? user.dailyTokenLimit.toLocaleString('es-ES')
      : 'Sin límite';

  return (
    <>
      <header className="page-header">
        <div>
          <h1 className="page-title">Resumen del sistema</h1>
          <p className="page-subtitle">
            Estado general del gateway Bifrost, llaves activas y punto de enlace local compatible
            con OpenAI.
          </p>
        </div>
      </header>

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
            <span>Modelos detectados</span>
            <InfoTip text="Catálogo combinado de modelos expuestos por tus proveedores configurados." />
          </div>
          <div className="kpi-value">{stats.modelsCount ?? 0}</div>
          <div className="kpi-footnote">
            <span className={`status-dot ${(stats.modelsCount ?? 0) > 0 ? 'ok' : 'partial'}`} />
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

        <article className="kpi-card">
          <div className="kpi-label-row">
            <span>Cuota diaria de tokens</span>
            <InfoTip
              text={`Modo de reinicio: ${
                user.quotaResetMode || 'diario UTC'
              }. Controlado automáticamente por core/.`}
            />
          </div>
          <div className="kpi-value" style={{ fontSize: '1.45rem' }}>
            {dailyLimitLabel}
          </div>
          <div className="kpi-footnote">
            <span className="status-dot ok" />
            <span>Cuenta: {user.username}</span>
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
