import React, { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from './api';
import { ApiKeysTab } from './components/ApiKeysTab';
import { BrandMark } from './components/BrandMark';
import { LoginScreen } from './components/LoginScreen';
import { OverviewTab } from './components/OverviewTab';
import { ProvidersTab } from './components/ProvidersTab';
import { SetupScreen } from './components/SetupScreen';
import type {
  ActiveTab,
  AuthUser,
  DashboardStats,
  InternalApiKey,
  ProviderSummary,
} from './types';

type BootStage = 'loading' | 'error' | 'setup' | 'login' | 'authenticated';

const EMPTY_STATS: DashboardStats = {
  providersCount: 0,
  modelsCount: 0,
  keysCount: 0,
};

export const App: React.FC = () => {
  const [stage, setStage] = useState<BootStage>('loading');
  const [bootError, setBootError] = useState<string | null>(null);

  const [user, setUser] = useState<AuthUser | null>(null);
  const [stats, setStats] = useState<DashboardStats>(EMPTY_STATS);
  const [providers, setProviders] = useState<ProviderSummary[]>([]);
  const [providersLoaded, setProvidersLoaded] = useState(false);
  const [providersLoading, setProvidersLoading] = useState(false);

  const [keys, setKeys] = useState<InternalApiKey[]>([]);
  const [keysLoading, setKeysLoading] = useState(false);

  const [activeTab, setActiveTab] = useState<ActiveTab>('overview');
  const [autoFocusKeyInput, setAutoFocusKeyInput] = useState(false);
  const [providersSubView, setProvidersSubView] = useState<
    'installed' | 'marketplace' | 'local-json' | undefined
  >(undefined);
  const [guestInfoModalOpen, setGuestInfoModalOpen] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);

  const loadWorkspaceData = useCallback(async () => {
    setProvidersLoading(true);
    setKeysLoading(true);

    const [providersRes, keysRes] = await Promise.allSettled([api.getProviders(), api.getKeys()]);

    if (providersRes.status === 'fulfilled' && Array.isArray(providersRes.value?.providers)) {
      setProviders(providersRes.value.providers);
      setProvidersLoaded(true);
    } else {
      setProviders([]);
      setProvidersLoaded(false);
    }
    setProvidersLoading(false);

    if (keysRes.status === 'fulfilled' && Array.isArray(keysRes.value?.keys)) {
      setKeys(keysRes.value.keys);
    } else {
      setKeys([]);
    }
    setKeysLoading(false);
  }, []);

  const bootstrap = useCallback(async () => {
    setBootError(null);
    setStage('loading');

    const [statusResult, meResult] = await Promise.allSettled([api.getStatus(), api.getMe()]);

    if (statusResult.status === 'rejected') {
      const reason = statusResult.reason;
      setBootError(
        reason instanceof Error
          ? reason.message
          : 'No se pudo conectar con la API /api/status de Bifrost.'
      );
      setStage('error');
      return;
    }

    if (!statusResult.value.initialized) {
      setUser(null);
      setStage('setup');
      return;
    }

    if (meResult.status === 'fulfilled') {
      setUser(meResult.value.user);
      setStats(meResult.value.stats ?? EMPTY_STATS);
      setStage('authenticated');
      await loadWorkspaceData();
      return;
    }

    const meErr = meResult.reason;
    if (meErr instanceof ApiError && meErr.status === 401) {
      setUser(null);
      setStage('login');
      return;
    }

    setUser(null);
    setStage('login');
  }, [loadWorkspaceData]);

  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  const refreshKeysAndStats = useCallback(async () => {
    const [keysResult, meResult] = await Promise.allSettled([api.getKeys(), api.getMe()]);
    if (keysResult.status === 'fulfilled' && Array.isArray(keysResult.value?.keys)) {
      setKeys(keysResult.value.keys);
    }
    if (meResult.status === 'fulfilled') {
      setUser(meResult.value.user);
      setStats(meResult.value.stats ?? EMPTY_STATS);
    } else if (meResult.reason instanceof ApiError && meResult.reason.status === 401) {
      setUser(null);
      setStage('login');
    }
  }, []);

  const refreshProvidersAndStats = useCallback(async () => {
    setProvidersLoading(true);
    const [providersResult, meResult] = await Promise.allSettled([api.getProviders(), api.getMe()]);
    if (providersResult.status === 'fulfilled' && Array.isArray(providersResult.value?.providers)) {
      setProviders(providersResult.value.providers);
      setProvidersLoaded(true);
    }
    setProvidersLoading(false);

    if (meResult.status === 'fulfilled') {
      setUser(meResult.value.user);
      setStats(meResult.value.stats ?? EMPTY_STATS);
    } else if (meResult.reason instanceof ApiError && meResult.reason.status === 401) {
      setUser(null);
      setStage('login');
    }
  }, []);

  async function handleLogout() {
    setLoggingOut(true);
    try {
      await api.logout();
    } catch {
      // Transition cleanly to login screen even if session already expired
    } finally {
      setLoggingOut(false);
      setUser(null);
      setProviders([]);
      setKeys([]);
      setActiveTab('overview');
      setStage('login');
    }
  }

  if (stage === 'loading') {
    return (
      <div className="boot-loader" role="status" aria-live="polite">
        <div className="spinner" aria-hidden="true" />
        <span style={{ fontWeight: 600 }}>Conectando con el núcleo de Bifrost…</span>
      </div>
    );
  }

  if (stage === 'error') {
    return (
      <main className="gate-wrapper">
        <section className="gate-card">
          <div style={{ marginBottom: 20 }}>
            <BrandMark subtitle="Estado de conexión" />
          </div>
          <h1 className="gate-title">Núcleo no disponible temporalmente</h1>
          <p className="gate-desc">
            No fue posible verificar el estado inicial del servidor en{' '}
            <code className="mono">/api/status</code>.
          </p>
          {bootError ? (
            <div className="alert alert-error" style={{ marginBottom: 20 }}>
              <span>{bootError}</span>
            </div>
          ) : null}
          <button type="button" className="btn btn-primary" onClick={() => void bootstrap()}>
            Reintentar conexión
          </button>
        </section>
      </main>
    );
  }

  if (stage === 'setup') {
    return <SetupScreen onSetupComplete={bootstrap} />;
  }

  if (stage === 'login' || !user) {
    return <LoginScreen onLoginSuccess={bootstrap} />;
  }

  const isAdmin = user.role === 'admin';
  const roleLabel = isAdmin ? 'admin' : 'invitado';
  const effectiveKeysCount = keys.length > 0 || !keysLoading ? keys.length : stats.keysCount;

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="topbar-inner">
          <BrandMark subtitle="Router OpenAI-compatible" />

          <nav className="nav-tabs" aria-label="Navegación principal">
            <button
              type="button"
              className={`nav-tab${activeTab === 'overview' ? ' active' : ''}`}
              onClick={() => setActiveTab('overview')}
            >
              <span>Resumen</span>
            </button>

            <button
              type="button"
              className={`nav-tab${activeTab === 'keys' ? ' active' : ''}`}
              onClick={() => setActiveTab('keys')}
            >
              <span>API Keys</span>
              <span className="nav-tab-pill">sk-bf-…</span>
            </button>

            {isAdmin ? (
              <button
                type="button"
                className={`nav-tab${activeTab === 'providers' ? ' active' : ''}`}
                onClick={() => setActiveTab('providers')}
              >
                <span>Proveedores</span>
                <span className="nav-tab-pill">
                  {providersLoaded ? providers.length : stats.providersCount}
                </span>
              </button>
            ) : null}
          </nav>

          <div className="user-cluster">
            <div className="user-pill" title={`Usuario autenticado: ${user.username}`}>
              <span>{user.username}</span>
              <span className={`role-badge ${isAdmin ? 'admin' : 'guest'}`}>{roleLabel}</span>
            </div>

            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={handleLogout}
              disabled={loggingOut}
            >
              {loggingOut ? 'Saliendo…' : 'Cerrar sesión'}
            </button>
          </div>
        </div>
      </header>

      <main className="main-container">
        {activeTab === 'overview' ? (
          <OverviewTab
            user={user}
            stats={stats}
            providers={providers}
            providersLoaded={providersLoaded}
            keysCount={effectiveKeysCount}
            onNavigateProviders={() => {
              setProvidersSubView('marketplace');
              setActiveTab('providers');
            }}
            onNavigateCreateKey={() => {
              setActiveTab('keys');
              setAutoFocusKeyInput(true);
            }}
            onOpenMarketplaceInfo={() => setGuestInfoModalOpen(true)}
          />
        ) : null}

        {activeTab === 'keys' ? (
          <ApiKeysTab
            keys={keys}
            loading={keysLoading}
            autoFocusCreate={autoFocusKeyInput}
            onAutoFocusConsumed={() => setAutoFocusKeyInput(false)}
            onKeysChanged={refreshKeysAndStats}
          />
        ) : null}

        {activeTab === 'providers' && isAdmin ? (
          <ProvidersTab
            providers={providers}
            loading={providersLoading}
            initialSubView={providersSubView}
            onInitialSubViewConsumed={() => setProvidersSubView(undefined)}
            onProvidersChanged={refreshProvidersAndStats}
          />
        ) : null}
      </main>

      {/* Info Modal for Guest Role clicking Add Provider */}
      {guestInfoModalOpen ? (
        <div
          className="modal-backdrop"
          role="dialog"
          aria-modal="true"
          aria-labelledby="guest-prov-modal-title"
          onClick={() => setGuestInfoModalOpen(false)}
        >
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <h2 id="guest-prov-modal-title" className="card-title">
              Instalación reservada al administrador
            </h2>
            <p style={{ color: 'var(--sub)', fontSize: '0.93rem' }}>
              Solo una cuenta con rol <strong>admin</strong> puede instalar proveedores desde{' '}
              <code className="mono">bifrost-providers</code> o registrar credenciales cifradas.
              Mientras tanto, puedes crear tus propias llaves internas{' '}
              <code className="mono">sk-bf-…</code>.
            </p>
            <div className="modal-actions">
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => setGuestInfoModalOpen(false)}
              >
                Cerrar
              </button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => {
                  setGuestInfoModalOpen(false);
                  setActiveTab('keys');
                  setAutoFocusKeyInput(true);
                }}
              >
                Crear API key interna
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
};
