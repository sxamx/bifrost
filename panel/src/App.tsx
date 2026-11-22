import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError } from './api';
import { copyTextToClipboard } from './clipboard';
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
type PaletteKey = 'obsidian' | 'stone' | 'nordic';
type ThemeMode = 'dark' | 'light';

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

function renderTabIcon(tab: ActiveTab): React.ReactNode {
  switch (tab) {
    case 'overview':
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
          <rect x="3" y="3" width="7" height="9" rx="1" />
          <rect x="14" y="3" width="7" height="5" rx="1" />
          <rect x="14" y="12" width="7" height="9" rx="1" />
          <rect x="3" y="16" width="7" height="5" rx="1" />
        </svg>
      );
    case 'models':
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
          <path d="M12 2 2 7l10 5 10-5-10-5Z" />
          <path d="m2 17 10 5 10-5" />
          <path d="m2 12 10 5 10-5" />
        </svg>
      );
    case 'compare':
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
          <path d="M16 3h5v5" />
          <path d="M8 3H3v5" />
          <path d="M12 22v-8.3a4 4 0 0 0-1.172-2.872L3 3" />
          <path d="m15 9 6-6" />
        </svg>
      );
    case 'playground':
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
        </svg>
      );
    case 'metrics':
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
          <path d="M3 3v18h18" />
          <path d="m19 9-5 5-4-4-3 3" />
        </svg>
      );
    case 'keys':
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
          <path d="m15.5 7.5 2.3 2.3a1 1 0 0 0 1.4 0l2.1-2.1a1 1 0 0 0 0-1.4L19 4" />
          <path d="m21 2-9.6 9.6" />
          <circle cx="7.5" cy="15.5" r="5.5" />
        </svg>
      );
    case 'providers':
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
          <rect x="2" y="2" width="20" height="8" rx="2" />
          <rect x="2" y="14" width="20" height="8" rx="2" />
          <line x1="6" y1="6" x2="6.01" y2="6" />
          <line x1="6" y1="18" x2="6.01" y2="18" />
        </svg>
      );
    case 'nodes':
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
          <circle cx="12" cy="12" r="9" />
          <path d="M3.6 9h16.8" />
          <path d="M3.6 15h16.8" />
        </svg>
      );
    case 'users':
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
          <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
          <circle cx="9" cy="7" r="4" />
        </svg>
      );
    case 'logs':
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
          <path d="M4 6h16" />
          <path d="M4 12h16" />
          <path d="M4 18h10" />
        </svg>
      );
    case 'backups':
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
          <polyline points="7 10 12 15 17 10" />
          <line x1="12" y1="15" x2="12" y2="3" />
        </svg>
      );
  }
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
  const [targetModelFullId, setTargetModelFullId] = useState<string | null>(null);
  const [targetProviderId, setTargetProviderId] = useState<string | null>(null);
  const [guestInfoModalOpen, setGuestInfoModalOpen] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);

  // Theme & Palette Studio State
  const [themeMode, setThemeMode] = useState<ThemeMode>(() => {
    try {
      const s = localStorage.getItem('bf_theme');
      return s === 'light' ? 'light' : 'dark';
    } catch {
      return 'dark';
    }
  });
  const [palette, setPalette] = useState<PaletteKey>(() => {
    try {
      const p = localStorage.getItem('bf_palette');
      return p === 'stone' || p === 'nordic' ? p : 'obsidian';
    } catch {
      return 'obsidian';
    }
  });

  // Topbar Endpoint Copy & Command Palette (⌘K)
  const [copiedTopUrl, setCopiedTopUrl] = useState(false);
  const [cmdOpen, setCmdOpen] = useState(false);
  const [cmdQuery, setCmdQuery] = useState('');
  const cmdInputRef = useRef<HTMLInputElement | null>(null);

  // PWA Install State
  const [installPromptEvt, setInstallPromptEvt] = useState<BeforeInstallPromptEvent | null>(null);
  const [isStandalone, setIsStandalone] = useState<boolean>(() => detectStandaloneMode());

  const tabButtonRefs = useRef<Partial<Record<ActiveTab, HTMLButtonElement | null>>>({});

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', themeMode);
    document.documentElement.setAttribute('data-palette', palette);
    const metaTheme = document.querySelector('meta[name="theme-color"]');
    if (metaTheme) {
      const bgMap: Record<ThemeMode, Record<PaletteKey, string>> = {
        dark: { obsidian: '#09090b', stone: '#100f0d', nordic: '#0b0d10' },
        light: { obsidian: '#f6f6f5', stone: '#f5f3ee', nordic: '#f2f4f7' },
      };
      metaTheme.setAttribute('content', bgMap[themeMode][palette]);
    }
    try {
      localStorage.setItem('bf_theme', themeMode);
      localStorage.setItem('bf_palette', palette);
    } catch {
      // ignore storage errors
    }
  }, [themeMode, palette]);

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

  // Keyboard shortcut ⌘K / Ctrl+K & Escape
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setCmdOpen((prev) => !prev);
      } else if (e.key === 'Escape') {
        setCmdOpen(false);
        setMobileMenuOpen(false);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  useEffect(() => {
    if (cmdOpen) {
      setCmdQuery('');
      window.setTimeout(() => cmdInputRef.current?.focus(), 20);
    }
  }, [cmdOpen]);

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

  async function handleCopyTopEndpoint() {
    const baseUrl = `${window.location.origin}/v1`;
    const ok = await copyTextToClipboard(baseUrl);
    if (ok) {
      setCopiedTopUrl(true);
      window.setTimeout(() => setCopiedTopUrl(false), 1800);
    } else {
      setCopiedTopUrl(false);
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
    setCmdOpen(false);
    window.scrollTo({ top: 0, behavior: 'auto' });
  }

  const isAdmin = user?.role === 'admin';
  const roleLabel = isAdmin ? 'admin' : 'invitado';
  const effectiveKeysCount = keys.length > 0 || !keysLoading ? keys.length : stats.keysCount;
  const effectiveProvidersCount = providersLoaded ? providers.length : stats.providersCount;
  const canInstallPwa = Boolean(installPromptEvt && !isStandalone);

  const usageTabs: Array<{ id: ActiveTab; label: string; pill?: string | number }> = useMemo(
    () => [
      { id: 'overview', label: 'Resumen' },
      {
        id: 'models',
        label: 'Modelos',
        pill: stats.modelsCount > 0 ? stats.modelsCount : undefined,
      },
      { id: 'compare', label: 'Comparador' },
      { id: 'playground', label: 'Playground' },
      { id: 'metrics', label: 'Métricas' },
      { id: 'keys', label: 'API Keys', pill: effectiveKeysCount > 0 ? effectiveKeysCount : 'sk-bf' },
    ],
    [stats.modelsCount, effectiveKeysCount]
  );

  const adminTabs: Array<{ id: ActiveTab; label: string; pill?: string | number }> = useMemo(
    () =>
      isAdmin
        ? [
            { id: 'providers', label: 'Proveedores (BYOK)', pill: effectiveProvidersCount },
            { id: 'nodes', label: 'Nodos de salida', pill: nodes.length },
            { id: 'logs', label: 'Logs' },
            { id: 'users', label: 'Usuarios' },
            { id: 'backups', label: 'Respaldos' },
          ]
        : [],
    [isAdmin, effectiveProvidersCount, nodes.length]
  );

  const allVisibleTabs = useMemo(() => [...usageTabs, ...adminTabs], [usageTabs, adminTabs]);

  const filteredCmdTabs = useMemo(() => {
    const q = cmdQuery.trim().toLowerCase();
    if (!q) return allVisibleTabs;
    return allVisibleTabs.filter(
      (t) => t.label.toLowerCase().includes(q) || t.id.toLowerCase().includes(q)
    );
  }, [allVisibleTabs, cmdQuery]);

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

  const baseUrl = `${window.location.origin}/v1`;

  return (
    <div className="app-shell">
      {/* FULLSCREEN STICKY TOPBAR */}
      <header className="topbar">
        <div className="topbar-left">
          <button
            type="button"
            className="btn btn-secondary btn-sm mobile-menu-trigger"
            aria-expanded={mobileMenuOpen}
            aria-controls="bifrost-mobile-nav-drawer"
            onClick={() => setMobileMenuOpen(true)}
            aria-label="Abrir menú de navegación"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path
                d="M4 7h16M4 12h16M4 17h16"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
              />
            </svg>
            <span>Menú</span>
          </button>
          <button
            type="button"
            className="brand-home-btn"
            onClick={() => selectSection('overview')}
            title="Ir a Resumen"
          >
            <BrandMark />
          </button>
          <span className="crumb-sep">/</span>
          <button
            type="button"
            className="crumb-ws"
            onClick={() => void handleCopyTopEndpoint()}
            title="Clic para copiar endpoint OpenAI-compatible"
          >
            <span>{baseUrl}</span>
            <span className="copy-hint">{copiedTopUrl ? '¡Copiado!' : 'Copiar'}</span>
          </button>
        </div>

        <div className="topbar-right">
          {/* Command Palette Trigger (⌘K) */}
          <button
            type="button"
            className="cmd-k-trigger"
            onClick={() => setCmdOpen(true)}
            aria-label="Abrir buscador rápido y paleta de comandos"
          >
            <span className="cmd-k-left">
              <svg
                width="13"
                height="13"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                aria-hidden="true"
              >
                <circle cx="11" cy="11" r="8" />
                <path d="m21 21-4.3-4.3" />
              </svg>
              <span className="cmd-k-text">Ir a sección, modelos, claves…</span>
            </span>
            <span className="kbd">⌘K</span>
          </button>

          {/* Curated Palette & Theme Switcher */}
          <div className="theme-cluster" role="group" aria-label="Paleta y modo de color">
            <button
              type="button"
              className={`palette-dot-btn${palette === 'obsidian' ? ' active' : ''}`}
              onClick={() => setPalette('obsidian')}
              title="Paleta: Obsidian & Paper"
              aria-label="Paleta Obsidian & Paper"
            >
              <span className="palette-dot" style={{ background: '#09090b' }} />
            </button>
            <button
              type="button"
              className={`palette-dot-btn${palette === 'stone' ? ' active' : ''}`}
              onClick={() => setPalette('stone')}
              title="Paleta: Warm Stone"
              aria-label="Paleta Warm Stone"
            >
              <span className="palette-dot" style={{ background: '#d6cfc2' }} />
            </button>
            <button
              type="button"
              className={`palette-dot-btn${palette === 'nordic' ? ' active' : ''}`}
              onClick={() => setPalette('nordic')}
              title="Paleta: Nordic Bifrost"
              aria-label="Paleta Nordic Bifrost"
            >
              <span className="palette-dot" style={{ background: '#0057ff' }} />
            </button>
            <button
              type="button"
              className="theme-toggle-btn"
              onClick={() => setThemeMode((m) => (m === 'dark' ? 'light' : 'dark'))}
              title="Alternar entre modo oscuro y claro"
            >
              {themeMode === 'dark' ? 'Oscuro' : 'Claro'}
            </button>
          </div>

          <div className="user-cluster">
            {canInstallPwa ? (
              <button
                type="button"
                className="btn btn-primary btn-sm"
                onClick={() => void handleTriggerInstallPwa()}
                title="Instalar Bifrost como aplicación independiente"
              >
                <span>Instalar app</span>
              </button>
            ) : null}

            <div className="user-pill" title={`Usuario autenticado: ${user.username}`}>
              <span className="status-dot ok" />
              <span className="user-pill-name">{user.username}</span>
              <span className={`role-badge ${isAdmin ? 'admin' : 'guest'}`}>{roleLabel}</span>
            </div>

            <button
              type="button"
              className="btn btn-secondary btn-sm desktop-logout-btn"
              onClick={() => void handleLogout()}
              disabled={loggingOut}
              title="Cerrar sesión"
            >
              <span>{loggingOut ? 'Saliendo…' : 'Salir'}</span>
            </button>
          </div>
        </div>
      </header>

      {/* GROUPED LEFT SIDEBAR NAVIGATION */}
      <aside className="sidebar" aria-label="Navegación principal">
        <div>
          <div className="nav-group-label">Gateway</div>
          <div className="nav-list">
            {usageTabs.map((item) => {
              const isActive = activeTab === item.id;
              return (
                <button
                  key={item.id}
                  ref={(el) => {
                    tabButtonRefs.current[item.id] = el;
                  }}
                  type="button"
                  className={`sidebar-nav-item${isActive ? ' active' : ''}`}
                  aria-current={isActive ? 'page' : undefined}
                  onClick={() => selectSection(item.id)}
                >
                  <span className="sidebar-nav-left">
                    {renderTabIcon(item.id)}
                    <span>{item.label}</span>
                  </span>
                  {item.pill !== undefined ? (
                    <span className="nav-tab-pill">{item.pill}</span>
                  ) : null}
                </button>
              );
            })}
          </div>
        </div>

        {isAdmin && adminTabs.length > 0 ? (
          <div>
            <div className="nav-group-label">Infraestructura & Sistema</div>
            <div className="nav-list">
              {adminTabs.map((item) => {
                const isActive = activeTab === item.id;
                return (
                  <button
                    key={item.id}
                    ref={(el) => {
                      tabButtonRefs.current[item.id] = el;
                    }}
                    type="button"
                    className={`sidebar-nav-item${isActive ? ' active' : ''}`}
                    aria-current={isActive ? 'page' : undefined}
                    onClick={() => selectSection(item.id)}
                  >
                    <span className="sidebar-nav-left">
                      {renderTabIcon(item.id)}
                      <span>{item.label}</span>
                    </span>
                    {item.pill !== undefined ? (
                      <span className="nav-tab-pill">{item.pill}</span>
                    ) : null}
                  </button>
                );
              })}
            </div>
          </div>
        ) : null}
      </aside>

      {/* MAIN WORKSPACE */}
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
            isAdmin={isAdmin}
            initialModelFullId={targetModelFullId}
            onInitialModelConsumed={() => setTargetModelFullId(null)}
            onNavigateCompare={() => setActiveTab('compare')}
            onNavigatePlayground={() => setActiveTab('playground')}
          />
        ) : null}

        {activeTab === 'compare' ? (
          <CompareTab
            onOpenModel={(fullId) => {
              setTargetModelFullId(fullId);
              setActiveTab('models');
              window.scrollTo({ top: 0, behavior: 'smooth' });
            }}
          />
        ) : null}

        {activeTab === 'playground' ? <PlaygroundTab /> : null}

        {activeTab === 'metrics' ? (
          <MetricsTab
            isAdmin={isAdmin}
            onOpenModel={(fullId) => {
              setTargetModelFullId(fullId);
              setActiveTab('models');
              window.scrollTo({ top: 0, behavior: 'smooth' });
            }}
            onOpenProvider={(providerId) => {
              if (isAdmin) {
                setTargetProviderId(providerId);
                setProvidersSubView('installed');
                setActiveTab('providers');
              } else {
                setActiveTab('models');
              }
              window.scrollTo({ top: 0, behavior: 'smooth' });
            }}
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
            nodes={nodes}
            loading={providersLoading}
            initialSubView={providersSubView}
            onInitialSubViewConsumed={() => setProvidersSubView(undefined)}
            initialExpandedProviderId={targetProviderId}
            onInitialExpandedProviderConsumed={() => setTargetProviderId(null)}
            onOpenModel={(fullId) => {
              setTargetModelFullId(fullId);
              setActiveTab('models');
              window.scrollTo({ top: 0, behavior: 'smooth' });
            }}
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

      {/* COMMAND PALETTE MODAL (⌘K / Ctrl+K) */}
      {cmdOpen ? (
        <div
          className="modal-backdrop"
          role="dialog"
          aria-modal="true"
          aria-label="Paleta rápida de comandos"
          onClick={() => setCmdOpen(false)}
        >
          <div className="cmd-modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="cmd-input-row">
              <svg
                width="15"
                height="15"
                viewBox="0 0 24 24"
                fill="none"
                stroke="var(--fg-3)"
                strokeWidth="2"
                aria-hidden="true"
              >
                <circle cx="11" cy="11" r="8" />
                <path d="m21 21-4.3-4.3" />
              </svg>
              <input
                ref={cmdInputRef}
                type="text"
                value={cmdQuery}
                onChange={(e) => setCmdQuery(e.target.value)}
                placeholder="Ir a sección, crear clave sk-bf-… o cambiar tema…"
              />
              <span className="kbd">ESC</span>
            </div>
            <div className="cmd-list">
              {filteredCmdTabs.map((t) => (
                <button
                  key={`cmd-${t.id}`}
                  type="button"
                  className="cmd-item"
                  onClick={() => selectSection(t.id)}
                >
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                    {renderTabIcon(t.id)}
                    <span>Ir a {t.label}</span>
                  </span>
                  <span className="mono" style={{ fontSize: 11, color: 'var(--fg-3)' }}>
                    {t.pill ?? t.id}
                  </span>
                </button>
              ))}
              <button
                type="button"
                className="cmd-item"
                onClick={() => {
                  setCmdOpen(false);
                  setActiveTab('keys');
                  setAutoFocusKeyInput(true);
                }}
              >
                <span>+ Crear nueva clave interna sk-bf-…</span>
                <span className="mono" style={{ fontSize: 11, color: 'var(--fg-3)' }}>
                  API Keys
                </span>
              </button>
              <button
                type="button"
                className="cmd-item"
                onClick={() => {
                  void handleCopyTopEndpoint();
                  setCmdOpen(false);
                }}
              >
                <span>Copiar endpoint compatible con OpenAI</span>
                <span className="mono" style={{ fontSize: 11, color: 'var(--fg-3)' }}>
                  /v1
                </span>
              </button>
              <button
                type="button"
                className="cmd-item"
                onClick={() => {
                  setThemeMode((m) => (m === 'dark' ? 'light' : 'dark'));
                  setCmdOpen(false);
                }}
              >
                <span>
                  Cambiar a modo {themeMode === 'dark' ? 'Claro' : 'Oscuro'}
                </span>
                <span className="mono" style={{ fontSize: 11, color: 'var(--fg-3)' }}>
                  Tema
                </span>
              </button>
            </div>
          </div>
        </div>
      ) : null}

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
              <span className="mobile-nav-group-label">Gateway</span>
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
                <span className="mobile-nav-group-label">Infraestructura & Sistema</span>
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
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 8,
                }}
              >
                <span style={{ fontSize: '0.8rem', color: 'var(--sub)' }}>Tema y paleta</span>
                <div className="theme-cluster">
                  <button
                    type="button"
                    className={`palette-dot-btn${palette === 'obsidian' ? ' active' : ''}`}
                    onClick={() => setPalette('obsidian')}
                    aria-label="Paleta Obsidian"
                  >
                    <span className="palette-dot" style={{ background: '#09090b' }} />
                  </button>
                  <button
                    type="button"
                    className={`palette-dot-btn${palette === 'stone' ? ' active' : ''}`}
                    onClick={() => setPalette('stone')}
                    aria-label="Paleta Warm Stone"
                  >
                    <span className="palette-dot" style={{ background: '#d6cfc2' }} />
                  </button>
                  <button
                    type="button"
                    className={`palette-dot-btn${palette === 'nordic' ? ' active' : ''}`}
                    onClick={() => setPalette('nordic')}
                    aria-label="Paleta Nordic Bifrost"
                  >
                    <span className="palette-dot" style={{ background: '#0057ff' }} />
                  </button>
                  <button
                    type="button"
                    className="theme-toggle-btn"
                    onClick={() => setThemeMode((m) => (m === 'dark' ? 'light' : 'dark'))}
                  >
                    {themeMode === 'dark' ? 'Oscuro' : 'Claro'}
                  </button>
                </div>
              </div>
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
      {/* Mobile / PWA Bottom Navigation Bar (<= 640px) */}
      <nav className="mobile-bottom-bar" aria-label="Navegación rápida móvil">
        {(
          [
            ['overview', 'Resumen'],
            ['models', 'Modelos'],
            ['metrics', 'Métricas'],
            ['playground', 'Chat'],
          ] as Array<[ActiveTab, string]>
        ).map(([id, label]) => (
          <button
            key={`mb-${id}`}
            type="button"
            className={`mobile-bottom-btn${activeTab === id ? ' active' : ''}`}
            onClick={() => selectSection(id)}
          >
            {renderTabIcon(id)}
            <span>{label}</span>
          </button>
        ))}
        <button
          type="button"
          className={`mobile-bottom-btn${mobileMenuOpen ? ' active' : ''}`}
          onClick={() => setMobileMenuOpen(true)}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
            <path d="M4 7h16M4 12h16M4 17h16" strokeLinecap="round" />
          </svg>
          <span>Más</span>
        </button>
      </nav>
    </div>
  );
};
