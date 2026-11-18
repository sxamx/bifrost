import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from './api';
import { AcceptInviteScreen } from './components/AcceptInviteScreen';
import { ApiKeysTab } from './components/ApiKeysTab';
import { BackupsTab } from './components/BackupsTab';
import { BrandMark } from './components/BrandMark';
import { CompareTab } from './components/CompareTab';
import { LoginScreen } from './components/LoginScreen';
import { LogsTab } from './components/LogsTab';
import { MetricsTab } from './components/MetricsTab';
import { ModelsTab } from './components/ModelsTab';
import { NodesTab } from './components/NodesTab';
import { OverviewTab } from './components/OverviewTab';
import { PlaygroundTab } from './components/PlaygroundTab';
import { ProvidersTab } from './components/ProvidersTab';
import { SetupScreen } from './components/SetupScreen';
import { UsersTab } from './components/UsersTab';
import type {
  ActiveTab,
  AuthUser,
  DashboardStats,
  ExitNodeItem,
  InternalApiKey,
  ProviderSummary,
} from './types';

type BootStage = 'loading' | 'error' | 'setup' | 'invite' | 'login' | 'authenticated';

interface BeforeInstallPromptEvent extends Event {
  readonly platforms?: string[];
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
}

const EMPTY_STATS: DashboardStats = {
  providersCount: 0,
  modelsCount: 0,
  keysCount: 0,
};

function getUrlInviteToken(): string | null {
  const params = new URLSearchParams(window.location.search);
  const raw = params.get('invite');
  return raw && raw.trim().length > 0 ? raw.trim() : null;
}

function detectStandaloneMode(): boolean {
  if (typeof window === 'undefined') return false;
  const mq = window.matchMedia?.('(display-mode: standalone)').matches ?? false;
  const iosStandalone = Boolean(
    (window.navigator as Navigator & { standalone?: boolean }).standalone
  );
  return mq || iosStandalone;
}

async function enrichProvidersWithKeys(list: ProviderSummary[]): Promise<ProviderSummary[]> {
  return Promise.all(
    list.map(async (prov) => {
      if (Array.isArray(prov.keys)) {
        return prov;
      }
      try {
        const fetchedKeys = await api.getProviderKeys(prov.id);
        return { ...prov, keys: fetchedKeys };
      } catch {
        return prov;
      }
    })
  );
}

export const App: React.FC = () => {
  const [stage, setStage] = useState<BootStage>('loading');
  const [bootError, setBootError] = useState<string | null>(null);
  const [inviteToken, setInviteToken] = useState<string | null>(() => getUrlInviteToken());

  const [user, setUser] = useState<AuthUser | null>(null);
  const [stats, setStats] = useState<DashboardStats>(EMPTY_STATS);
  const [providers, setProviders] = useState<ProviderSummary[]>([]);
  const [providersLoaded, setProvidersLoaded] = useState(false);
  const [providersLoading, setProvidersLoading] = useState(false);

  const [nodes, setNodes] = useState<ExitNodeItem[]>([]);
  const [nodesLoading, setNodesLoading] = useState(false);

  const [keys, setKeys] = useState<InternalApiKey[]>([]);
  const [keysLoading, setKeysLoading] = useState(false);

  const [activeTab, setActiveTab] = useState<ActiveTab>('overview');
  const [autoFocusKeyInput, setAutoFocusKeyInput] = useState(false);
  const [providersSubView, setProvidersSubView] = useState<
    'installed' | 'marketplace' | 'local-json' | undefined
  >(undefined);
  const [guestInfoModalOpen, setGuestInfoModalOpen] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);

  // PWA Install State
  const [installPromptEvt, setInstallPromptEvt] = useState<BeforeInstallPromptEvent | null>(null);
  const [isStandalone, setIsStandalone] = useState<boolean>(() => detectStandaloneMode());

  const tabButtonRefs = useRef<Partial<Record<ActiveTab, HTMLButtonElement | null>>>({});

  useEffect(() => {
    const onBeforeInstall = (e: Event) => {
      e.preventDefault();
      setInstallPromptEvt(e as BeforeInstallPromptEvent);
    };
    const onAppInstalled = () => {
      setInstallPromptEvt(null);
      setIsStandalone(true);
    };
    const media = window.matchMedia?.('(display-mode: standalone)');
    const onDisplayModeChange = (ev: MediaQueryListEvent) => {
      setIsStandalone(ev.matches);
    };

    window.addEventListener('beforeinstallprompt', onBeforeInstall);
    window.addEventListener('appinstalled', onAppInstalled);
    media?.addEventListener?.('change', onDisplayModeChange);

    return () => {
      window.removeEventListener('beforeinstallprompt', onBeforeInstall);
      window.removeEventListener('appinstalled', onAppInstalled);
      media?.removeEventListener?.('change', onDisplayModeChange);
    };
  }, []);

  // Auto-center active tab in single-line horizontal rail
  useEffect(() => {
    const btn = tabButtonRefs.current[activeTab];
    if (btn && typeof btn.scrollIntoView === 'function') {
      btn.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' });
    }
  }, [activeTab, stage]);

  // Close mobile menu on Escape
  useEffect(() => {
    if (!mobileMenuOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setMobileMenuOpen(false);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [mobileMenuOpen]);

  async function handleTriggerInstallPwa() {
    if (!installPromptEvt) return;
    try {
      await installPromptEvt.prompt();
      const choice = await installPromptEvt.userChoice;
      if (choice.outcome === 'accepted') {
        setInstallPromptEvt(null);
      }
    } catch {
      setInstallPromptEvt(null);
    }
  }

  const loadWorkspaceData = useCallback(async (role: string) => {
    setKeysLoading(true);
    if (role === 'admin') {
      setProvidersLoading(true);
      setNodesLoading(true);
    }

    const [providersRes, keysRes, nodesRes] = await Promise.allSettled([
      role === 'admin'
        ? api.getProviders()
        : Promise.resolve({ providers: [] as ProviderSummary[] }),
      api.getKeys(),
      role === 'admin' ? api.getNodes() : Promise.resolve([] as ExitNodeItem[]),
    ]);

    if (
      role === 'admin' &&
      providersRes.status === 'fulfilled' &&
      Array.isArray(providersRes.value?.providers)
    ) {
      const hydrated = await enrichProvidersWithKeys(providersRes.value.providers);
      setProviders(hydrated);
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

    if (role === 'admin' && nodesRes.status === 'fulfilled' && Array.isArray(nodesRes.value)) {
      setNodes(nodesRes.value);
    } else {
      setNodes([]);
    }
    setNodesLoading(false);
  }, []);

  const bootstrap = useCallback(async () => {
    setBootError(null);
    setStage('loading');

    const currentInvite = getUrlInviteToken();
    setInviteToken(currentInvite);

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
      const authedUser = meResult.value.user;
      setUser(authedUser);
      setStats(meResult.value.stats ?? EMPTY_STATS);
      setStage('authenticated');
      await loadWorkspaceData(authedUser.role);
      return;
    }

    if (currentInvite) {
      setUser(null);
      setStage('invite');
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

  const refreshProvidersNodesAndStats = useCallback(async () => {
    setProvidersLoading(true);
    setNodesLoading(true);
    const [providersResult, nodesResult, meResult] = await Promise.allSettled([
      api.getProviders(),
      api.getNodes(),
      api.getMe(),
    ]);

    if (providersResult.status === 'fulfilled' && Array.isArray(providersResult.value?.providers)) {
      const hydrated = await enrichProvidersWithKeys(providersResult.value.providers);
      setProviders(hydrated);
      setProvidersLoaded(true);
    }
    setProvidersLoading(false);

    if (nodesResult.status === 'fulfilled' && Array.isArray(nodesResult.value)) {
      setNodes(nodesResult.value);
    }
    setNodesLoading(false);

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
    setMobileMenuOpen(false);
    try {
      await api.logout();
    } catch {
      // Transition cleanly to login screen even if session already expired
    } finally {
      setLoggingOut(false);
      setUser(null);
      setProviders([]);
      setNodes([]);
      setKeys([]);
      setActiveTab('overview');
      setStage('login');
    }
  }

  function selectSection(tab: ActiveTab) {
    setActiveTab(tab);
    setMobileMenuOpen(false);
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

  if (stage === 'invite' && inviteToken) {
    return (
      <AcceptInviteScreen
        inviteToken={inviteToken}
        onAccepted={bootstrap}
        onCancelToLogin={() => {
          setInviteToken(null);
          setStage('login');
        }}
      />
    );
  }

  if (stage === 'login' || !user) {
    return <LoginScreen onLoginSuccess={bootstrap} />;
  }

  const isAdmin = user.role === 'admin';
  const roleLabel = isAdmin ? 'admin' : 'invitado';
  const effectiveKeysCount = keys.length > 0 || !keysLoading ? keys.length : stats.keysCount;
  const effectiveProvidersCount = providersLoaded ? providers.length : stats.providersCount;
  const canInstallPwa = Boolean(installPromptEvt && !isStandalone);

  const usageTabs: Array<{ id: ActiveTab; label: string; pill?: string | number }> = [
    { id: 'overview', label: 'Resumen' },
    {
      id: 'models',
      label: 'Modelos',
      pill: stats.modelsCount > 0 ? stats.modelsCount : undefined,
    },
    { id: 'compare', label: 'Comparador' },
    { id: 'playground', label: 'Playground' },
    { id: 'metrics', label: 'Métricas' },
    { id: 'keys', label: 'API Keys', pill: 'sk-bf-…' },
  ];

  const adminTabs: Array<{ id: ActiveTab; label: string; pill?: string | number }> = isAdmin
    ? [
        { id: 'providers', label: 'Proveedores', pill: effectiveProvidersCount },
        { id: 'nodes', label: 'Nodos', pill: nodes.length },
        { id: 'users', label: 'Usuarios' },
        { id: 'logs', label: 'Logs' },
        { id: 'backups', label: 'Respaldos' },
      ]
    : [];

  const allVisibleTabs = [...usageTabs, ...adminTabs];

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="topbar-inner">
          {/* Compact Top Row: BrandMark + User/PWA/Drawer Cluster */}
          <div className="topbar-row-main">
            <BrandMark subtitle="Router OpenAI-compatible" />

            <div className="user-cluster">
              {canInstallPwa ? (
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  onClick={() => void handleTriggerInstallPwa()}
                  title="Instalar Bifrost como aplicación independiente"
                >
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                    <path
                      d="M12 4v11m0 0l-4-4m4 4l4-4M5 19h14"
                      stroke="currentColor"
                      strokeWidth="2.1"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                  <span>Instalar app</span>
                </button>
              ) : null}

              <div className="user-pill" title={`Usuario autenticado: ${user.username}`}>
                <span className="user-pill-name">{user.username}</span>
                <span className={`role-badge ${isAdmin ? 'admin' : 'guest'}`}>{roleLabel}</span>
              </div>

              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={() => void handleLogout()}
                disabled={loggingOut}
                title="Cerrar sesión"
              >
                <span>{loggingOut ? 'Saliendo…' : 'Salir'}</span>
                <span className="logout-label-full">{loggingOut ? '' : 'de sesión'}</span>
              </button>

              <button
                type="button"
                className="btn btn-secondary btn-sm mobile-menu-trigger"
                aria-expanded={mobileMenuOpen}
                aria-controls="bifrost-mobile-nav-drawer"
                onClick={() => setMobileMenuOpen(true)}
              >
                <svg width="17" height="17" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <path
                    d="M4 7h16M4 12h16M4 17h16"
                    stroke="currentColor"
                    strokeWidth="2.1"
                    strokeLinecap="round"
                  />
                </svg>
                <span>Menú</span>
              </button>
            </div>
          </div>

          {/* Single-Line Scrollable Navigation Rail (Never stacks into multi-row wall) */}
          <div className="topbar-nav-rail">
            <nav className="nav-tabs" aria-label="Navegación principal">
              {allVisibleTabs.map((item) => {
                const isActive = activeTab === item.id;
                return (
                  <button
                    key={item.id}
                    ref={(el) => {
                      tabButtonRefs.current[item.id] = el;
                    }}
                    type="button"
                    className={`nav-tab${isActive ? ' active' : ''}`}
                    aria-current={isActive ? 'page' : undefined}
                    onClick={() => selectSection(item.id)}
                  >
                    <span>{item.label}</span>
                    {item.pill !== undefined ? (
                      <span className="nav-tab-pill">{item.pill}</span>
                    ) : null}
                  </button>
                );
              })}
            </nav>
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
            onNavigateMetrics={() => setActiveTab('metrics')}
            onOpenMarketplaceInfo={() => setGuestInfoModalOpen(true)}
          />
        ) : null}

        {activeTab === 'models' ? (
          <ModelsTab
            onNavigateCompare={() => setActiveTab('compare')}
            onNavigatePlayground={() => setActiveTab('playground')}
          />
        ) : null}

        {activeTab === 'compare' ? <CompareTab /> : null}

        {activeTab === 'playground' ? <PlaygroundTab /> : null}

        {activeTab === 'metrics' ? <MetricsTab isAdmin={isAdmin} /> : null}

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
            nodes={nodes}
            loading={providersLoading}
            initialSubView={providersSubView}
            onInitialSubViewConsumed={() => setProvidersSubView(undefined)}
            onProvidersChanged={refreshProvidersNodesAndStats}
          />
        ) : null}

        {activeTab === 'nodes' && isAdmin ? (
          <NodesTab
            nodes={nodes}
            providers={providers}
            loading={nodesLoading}
            onNodesChanged={refreshProvidersNodesAndStats}
          />
        ) : null}

        {activeTab === 'users' && isAdmin ? <UsersTab /> : null}

        {activeTab === 'logs' && isAdmin ? <LogsTab /> : null}

        {activeTab === 'backups' && isAdmin ? (
          <BackupsTab onBackupRestored={refreshProvidersNodesAndStats} />
        ) : null}
      </main>

      {/* Categorized Navigation Sheet for Mobile & Split-View (<= 900px) */}
      {mobileMenuOpen ? (
        <div
          className="mobile-nav-backdrop"
          role="dialog"
          aria-modal="true"
          aria-label="Menú rápido de secciones"
          id="bifrost-mobile-nav-drawer"
          onClick={() => setMobileMenuOpen(false)}
        >
          <div className="mobile-nav-sheet" onClick={(e) => e.stopPropagation()}>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 10,
                paddingBottom: 12,
                borderBottom: '1px solid var(--line)',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                <strong className="font-display" style={{ fontSize: '0.98rem' }}>
                  Secciones
                </strong>
                <span className={`role-badge ${isAdmin ? 'admin' : 'guest'}`}>{roleLabel}</span>
              </div>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={() => setMobileMenuOpen(false)}
              >
                Cerrar
              </button>
            </div>

            <div className="mobile-nav-group">
              <span className="mobile-nav-group-label">Uso y Pruebas</span>
              {usageTabs.map((item) => {
                const isActive = activeTab === item.id;
                return (
                  <button
                    key={`drawer-${item.id}`}
                    type="button"
                    className={`mobile-nav-item${isActive ? ' active' : ''}`}
                    onClick={() => selectSection(item.id)}
                  >
                    <span>{item.label}</span>
                    {item.pill !== undefined ? (
                      <span className="nav-tab-pill">{item.pill}</span>
                    ) : null}
                  </button>
                );
              })}
            </div>

            {isAdmin && adminTabs.length > 0 ? (
              <div className="mobile-nav-group">
                <span className="mobile-nav-group-label">Administración</span>
                {adminTabs.map((item) => {
                  const isActive = activeTab === item.id;
                  return (
                    <button
                      key={`drawer-${item.id}`}
                      type="button"
                      className={`mobile-nav-item${isActive ? ' active' : ''}`}
                      onClick={() => selectSection(item.id)}
                    >
                      <span>{item.label}</span>
                      {item.pill !== undefined ? (
                        <span className="nav-tab-pill">{item.pill}</span>
                      ) : null}
                    </button>
                  );
                })}
              </div>
            ) : null}

            <div
              style={{
                marginTop: 'auto',
                paddingTop: 14,
                borderTop: '1px solid var(--line)',
                display: 'flex',
                flexDirection: 'column',
                gap: 10,
              }}
            >
              <div style={{ fontSize: '0.82rem', color: 'var(--sub)' }}>
                Sesión activa: <strong style={{ color: 'var(--fg)' }}>{user.username}</strong>
              </div>
              {canInstallPwa ? (
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  onClick={() => void handleTriggerInstallPwa()}
                >
                  Instalar aplicación Bifrost
                </button>
              ) : null}
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={() => void handleLogout()}
                disabled={loggingOut}
              >
                {loggingOut ? 'Cerrando sesión…' : 'Cerrar sesión'}
              </button>
            </div>
          </div>
        </div>
      ) : null}

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
