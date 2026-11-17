import React from 'react';
import type { ProviderSummary } from '../types';
import { InfoTip } from './InfoTip';

interface ProvidersTabProps {
  providers: ProviderSummary[];
  loading: boolean;
  onOpenMarketplaceModal: () => void;
}

export const ProvidersTab: React.FC<ProvidersTabProps> = ({
  providers,
  loading,
  onOpenMarketplaceModal,
}) => {
  return (
    <>
      <header className="page-header">
        <div>
          <h1 className="page-title">Proveedores y Marketplace</h1>
          <p className="page-subtitle">
            Administra los adaptadores conectados a tu router y sus bóvedas cifradas de
            credenciales.
          </p>
        </div>
        <button type="button" className="btn btn-primary" onClick={onOpenMarketplaceModal}>
          Explorar catálogo bifrost-providers
        </button>
      </header>

      {loading && providers.length === 0 ? (
        <section className="card">
          <p className="field-hint">Consultando proveedores registrados en core/…</p>
        </section>
      ) : providers.length === 0 ? (
        <section className="card">
          <div className="empty-state">
            <div className="empty-icon" aria-hidden="true">
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none">
                <path
                  d="M4 8.5L12 4l8 4.5v7L12 20l-8-4.5v-7Z"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinejoin="round"
                />
                <path
                  d="M12 12l8-4.5M12 12v8M12 12L4 7.5"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinejoin="round"
                />
              </svg>
            </div>

            <h2 className="card-title" style={{ justifyContent: 'center' }}>
              Sin proveedores instalados todavía
              <InfoTip text="En la Fase 2 podrás instalar adaptadores con un clic directamente desde el repositorio comunitario bifrost-providers." />
            </h2>

            <p className="field-hint" style={{ maxWidth: 520, fontSize: '0.92rem' }}>
              Tu núcleo Bifrost está listo y autenticado. El instalador interactivo del catálogo{' '}
              <code className="mono">bifrost-providers</code> y el gestor de claves cifradas de
              proveedores externos se habilitan en la Fase 2.
            </p>

            <div style={{ display: 'flex', gap: 12, marginTop: 8, flexWrap: 'wrap' }}>
              <button type="button" className="btn btn-primary" onClick={onOpenMarketplaceModal}>
                Ver cómo funciona el Marketplace (Fase 2)
              </button>
            </div>
          </div>
        </section>
      ) : (
        <section className="kpi-grid" aria-label="Proveedores instalados">
          {providers.map((provider) => (
            <article key={provider.id} className="kpi-card">
              <div className="kpi-label-row">
                <span className="mono" style={{ fontSize: '0.78rem' }}>
                  {provider.id}
                </span>
                <span className="role-badge guest">Activo</span>
              </div>
              <div className="kpi-value" style={{ fontSize: '1.25rem' }}>
                {provider.name}
              </div>
              <div className="kpi-footnote">
                <span className="status-dot ok" />
                <span>Registrado en core/</span>
              </div>
            </article>
          ))}
        </section>
      )}
    </>
  );
};
