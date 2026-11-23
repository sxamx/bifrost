import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { api, ApiError } from '../api';
import type {
  ExitNodeItem,
  MarketplaceCatalogState,
  MarketplaceSourceItem,
  ProviderCategory,
  ProviderKeyItem,
  ProviderManifest,
  ProviderModelItem,
  ProviderPrivacyConfig,
  ProviderRateLimitKind,
  ProviderRateLimitWindow,
  ProviderSummary,
} from '../types';
import { InfoTip } from './InfoTip';
import { ProviderLogo } from './ProviderLogo';
import { ProviderVaultCard } from './ProviderVaultCard';

type ProvidersSubView = 'installed' | 'marketplace' | 'local-json';
type MarketplaceCategoryFilter = 'all' | ProviderCategory;

function formatProviderCategoryLabel(cat?: ProviderCategory): string {
  if (cat === 'aggregator') return 'Agregador';
  if (cat === 'official-api') return 'API Oficial';
  if (cat === 'experimental-adapter') return 'Adaptador Experimental';
  return 'Catálogo';
}

function formatRetentionLabel(privacy: ProviderPrivacyConfig): {
  label: string;
  tone: 'verified' | 'partial' | 'err' | 'neutral';
} {
  switch (privacy.retention) {
    case 'zero':
      return { label: 'ZDR estricto', tone: 'verified' };
    case 'transient':
      return {
        label: privacy.retentionDays
          ? `Retención temporal (${privacy.retentionDays}d)`
          : 'Retención temporal',
        tone: 'neutral',
      };
    case 'retained':
      return { label: 'Sin ZDR / Retiene prompts', tone: 'err' };
    case 'variable':
    default:
      return { label: 'ZDR variable', tone: 'partial' };
  }
}

function formatTrainingLabel(training: ProviderPrivacyConfig['training']): string {
  switch (training) {
    case 'never':
      return 'No entrena';
    case 'opt_out':
      return 'Entrena (opt-out)';
    case 'allowed':
      return 'Puede entrenar';
    default:
      return 'Entrenamiento: N/D';
  }
}

function formatRateLimitBadge(
  kind?: ProviderRateLimitKind | null,
  windows?: ProviderRateLimitWindow[]
): string | null {
  if (!kind) return null;
  const base =
    kind === 'requests'
      ? 'Límite: peticiones'
      : kind === 'tokens'
        ? 'Límite: tokens'
        : kind === 'concurrency'
          ? 'Límite: concurrencia'
          : 'Sin límite fijo';
  if (!windows || windows.length === 0) return base;
  const winTxt = windows
    .map((w) => (w === 'hour' ? 'hora' : w === 'day' ? 'día' : 'semana'))
    .join('/');
  return `${base} (${winTxt})`;
}

interface ProvidersTabProps {
  providers: ProviderSummary[];
  nodes: ExitNodeItem[];
  loading: boolean;
  initialSubView?: ProvidersSubView;
  onInitialSubViewConsumed?: () => void;
  initialExpandedProviderId?: string | null;
  onInitialExpandedProviderConsumed?: () => void;
  onOpenModel?: (fullId: string) => void;
  onProvidersChanged: () => Promise<void>;
}

const SAMPLE_MANIFEST_PLACEHOLDER = `{
  "schemaVersion": "1.0",
  "id": "openrouter",
  "name": "OpenRouter (Free Tier)",
  "packageType": "official-json",
  "baseUrl": "https://openrouter.ai/api/v1",
  "auth": {
    "type": "bearer",
    "header": "Authorization"
  },
  "modelsSource": "api",
  "modelsEndpoint": "/models"
}`;

function validateManifestJson(rawText: string): {
  manifest?: ProviderManifest;
  error?: string;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    return { error: 'El archivo o texto no contiene JSON válido.' };
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { error: 'La ficha debe ser un objeto JSON conforme a provider.schema.json.' };
  }

  const obj = parsed as Record<string, unknown>;
  if (typeof obj.id !== 'string' || !/^[a-z0-9-]+$/.test(obj.id)) {
    return {
      error: 'Campo "id" obligatorio (solo minúsculas, dígitos y guiones, ej. "openrouter").',
    };
  }
  if (typeof obj.name !== 'string' || obj.name.trim().length === 0) {
    return { error: 'Campo "name" obligatorio.' };
  }
  if (obj.packageType !== 'official-json' && obj.packageType !== 'experimental-adapter') {
    return {
      error: 'Campo "packageType" debe ser "official-json" o "experimental-adapter".',
    };
  }
  if (typeof obj.baseUrl !== 'string' || !obj.baseUrl.startsWith('http')) {
    return { error: 'Campo "baseUrl" debe ser una URL HTTP/HTTPS válida.' };
  }
  if (!obj.auth || typeof obj.auth !== 'object') {
    return { error: 'Campo "auth" obligatorio ({ type, header }).' };
  }
  if (obj.modelsSource !== 'api' && obj.modelsSource !== 'static') {
    return { error: 'Campo "modelsSource" debe ser "api" o "static".' };
  }
  if (obj.modelsSource === 'static' && typeof obj.reviewedAt !== 'string') {
    return {
      error: 'Cuando modelsSource es "static", el campo "reviewedAt" (YYYY-MM-DD) es obligatorio.',
    };
  }

  return { manifest: parsed as ProviderManifest };
}

export const ProvidersTab: React.FC<ProvidersTabProps> = ({
  providers,
  nodes,
  loading,
  initialSubView,
  onInitialSubViewConsumed,
  initialExpandedProviderId,
  onInitialExpandedProviderConsumed,
  onOpenModel,
  onProvidersChanged,
}) => {
  const [subView, setSubView] = useState<ProvidersSubView>(
    initialSubView ?? (providers.length === 0 ? 'marketplace' : 'installed')
  );
  const [focusedProviderId, setFocusedProviderId] = useState<string | null>(
    initialExpandedProviderId ?? null
  );

  const [catalog, setCatalog] = useState<MarketplaceCatalogState>({
    manifests: [],
    offline: false,
  });
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [sources, setSources] = useState<MarketplaceSourceItem[]>([]);
  const [sourcesExpanded, setSourcesExpanded] = useState(false);
  const [togglingSourceId, setTogglingSourceId] = useState<string | null>(null);
  const [deletingSourceId, setDeletingSourceId] = useState<string | null>(null);
  const [newSourceName, setNewSourceName] = useState('');
  const [newSourceUrl, setNewSourceUrl] = useState('');
  const [addingSource, setAddingSource] = useState(false);
  const [updatingProviderId, setUpdatingProviderId] = useState<string | null>(null);
  const [updatingAllProviders, setUpdatingAllProviders] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [categoryFilter, setCategoryFilter] = useState<MarketplaceCategoryFilter>('all');
  const [installingId, setInstallingId] = useState<string | null>(null);
  const [adapterUrlsById, setAdapterUrlsById] = useState<Record<string, string>>({});

  const [jsonText, setJsonText] = useState('');
  const [localAdapterUrl, setLocalAdapterUrl] = useState('');
  const [uploadingLocal, setUploadingLocal] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  const [keysByProvider, setKeysByProvider] = useState<Record<string, ProviderKeyItem[]>>({});
  const [allModels, setAllModels] = useState<ProviderModelItem[]>([]);

  const [globalBanner, setGlobalBanner] = useState<string | null>(null);
  const [globalError, setGlobalError] = useState<string | null>(null);
  const [providerToDelete, setProviderToDelete] = useState<ProviderSummary | null>(null);
  const [keyToDelete, setKeyToDelete] = useState<{
    provider: ProviderSummary;
    key: ProviderKeyItem;
  } | null>(null);
  const [deletingBusy, setDeletingBusy] = useState(false);

  useEffect(() => {
    if (initialSubView) {
      setSubView(initialSubView);
      onInitialSubViewConsumed?.();
    }
  }, [initialSubView, onInitialSubViewConsumed]);

  useEffect(() => {
    if (initialExpandedProviderId) {
      setFocusedProviderId(initialExpandedProviderId);
      setSubView('installed');
      onInitialExpandedProviderConsumed?.();
    }
  }, [initialExpandedProviderId, onInitialExpandedProviderConsumed]);

  const loadCatalog = useCallback(async (refresh = false) => {
    setCatalogLoading(true);
    try {
      const [stateRes, sourcesRes] = await Promise.allSettled([
        api.getMarketplace(refresh),
        api.getMarketplaceSources(),
      ]);
      if (stateRes.status === 'fulfilled') {
        setCatalog(stateRes.value);
        if (sourcesRes.status === 'fulfilled') {
          setSources(sourcesRes.value);
        } else if (Array.isArray(stateRes.value.sources)) {
          setSources(stateRes.value.sources);
        }
        if (refresh) {
          const cnt = stateRes.value.updatesAvailableCount ?? 0;
          setGlobalBanner(
            cnt > 0
              ? `Comprobación completada: ${cnt} ${
                  cnt === 1 ? 'actualización disponible' : 'actualizaciones disponibles'
                } en el catálogo.`
              : 'Catálogo comprobado: todos los proveedores instalados están al día.'
          );
        }
      } else {
        setCatalog({
          manifests: [],
          offline: true,
          notice:
            stateRes.reason instanceof Error
              ? stateRes.reason.message
              : 'Catálogo fuera de línea.',
        });
      }
    } finally {
      setCatalogLoading(false);
    }
  }, []);

  async function handleToggleSource(src: MarketplaceSourceItem) {
    setGlobalError(null);
    setTogglingSourceId(src.id);
    try {
      await api.updateMarketplaceSource(src.id, { enabled: !src.enabled });
      await loadCatalog(false);
    } catch (err) {
      setGlobalError(
        err instanceof ApiError ? err.message : 'No se pudo actualizar el repositorio.'
      );
    } finally {
      setTogglingSourceId(null);
    }
  }

  async function handleAddSource(e: React.FormEvent) {
    e.preventDefault();
    setGlobalError(null);
    const cleanName = newSourceName.trim();
    const cleanUrl = newSourceUrl.trim();
    if (!cleanName || !cleanUrl.startsWith('https://')) {
      setGlobalError('Ingresa un nombre y una URL HTTPS válida para el repositorio.');
      return;
    }
    setAddingSource(true);
    try {
      await api.addMarketplaceSource({ name: cleanName, url: cleanUrl, enabled: true });
      setNewSourceName('');
      setNewSourceUrl('');
      setGlobalBanner(`Repositorio «${cleanName}» añadido y activado.`);
      await loadCatalog(true);
    } catch (err) {
      setGlobalError(
        err instanceof ApiError ? err.message : 'No se pudo añadir el repositorio.'
      );
    } finally {
      setAddingSource(false);
    }
  }

  async function handleDeleteSource(src: MarketplaceSourceItem) {
    setGlobalError(null);
    setDeletingSourceId(src.id);
    try {
      await api.deleteMarketplaceSource(src.id);
      setGlobalBanner(`Repositorio «${src.name}» eliminado.`);
      await loadCatalog(false);
    } catch (err) {
      setGlobalError(
        err instanceof ApiError ? err.message : 'No se pudo eliminar el repositorio.'
      );
    } finally {
      setDeletingSourceId(null);
    }
  }

  async function handleUpdateInstalledProviders(providerId?: string) {
    setGlobalError(null);
    setGlobalBanner(null);
    if (providerId) {
      setUpdatingProviderId(providerId);
    } else {
      setUpdatingAllProviders(true);
    }
    try {
      const res = await api.updateInstalledMarketplaceProviders(providerId);
      const updatedCount = res.updated.length;
      const skippedCount = res.skipped.length;
      setGlobalBanner(
        updatedCount > 0
          ? `Actualización en sitio completada: ${updatedCount} ${
              updatedCount === 1 ? 'proveedor actualizado' : 'proveedores actualizados'
            }${skippedCount > 0 ? ` (${skippedCount} omitidos)` : ''}.`
          : 'No había cambios pendientes por aplicar.'
      );
      await Promise.all([onProvidersChanged(), loadCatalog(false)]);
    } catch (err) {
      setGlobalError(
        err instanceof ApiError
          ? err.message
          : 'No se pudo actualizar la ficha del proveedor.'
      );
    } finally {
      setUpdatingProviderId(null);
      setUpdatingAllProviders(false);
    }
  }

  const loadSupplementaryProviderData = useCallback(async (list: ProviderSummary[]) => {
    if (list.length === 0) {
      setKeysByProvider({});
      setAllModels([]);
      return;
    }

    const modelsPromise = api.getModels().catch(() => [] as ProviderModelItem[]);
    const keysEntries = await Promise.all(
      list.map(async (p) => {
        if (Array.isArray(p.keys)) {
          return [p.id, p.keys] as const;
        }
        try {
          const fetched = await api.getProviderKeys(p.id);
          return [p.id, fetched] as const;
        } catch {
          return [p.id, [] as ProviderKeyItem[]] as const;
        }
      })
    );

    const nextKeysMap: Record<string, ProviderKeyItem[]> = {};
    for (const [id, kList] of keysEntries) {
      nextKeysMap[id] = kList;
    }
    setKeysByProvider(nextKeysMap);
    setAllModels(await modelsPromise);
  }, []);

  useEffect(() => {
    void loadCatalog();
  }, [loadCatalog]);

  useEffect(() => {
    void loadSupplementaryProviderData(providers);
  }, [providers, loadSupplementaryProviderData]);

  const refreshEverything = useCallback(async () => {
    await onProvidersChanged();
  }, [onProvidersChanged]);

  const installedIds = useMemo(() => new Set(providers.map((p) => p.id)), [providers]);

  const filteredManifests = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return catalog.manifests.filter((m) => {
      if (m.approved === false) return false;
      const effectiveCategory: ProviderCategory =
        m.category ??
        (m.packageType === 'experimental-adapter' ? 'experimental-adapter' : 'official-api');
      if (categoryFilter !== 'all' && effectiveCategory !== categoryFilter) {
        return false;
      }
      if (!q) return true;
      return (
        m.name.toLowerCase().includes(q) ||
        m.id.toLowerCase().includes(q) ||
        effectiveCategory.toLowerCase().includes(q)
      );
    });
  }, [catalog.manifests, categoryFilter, searchQuery]);

  async function handleInstallFromCatalog(manifest: ProviderManifest) {
    setGlobalError(null);
    setGlobalBanner(null);
    setInstallingId(manifest.id);

    try {
      const customAdapterUrl = adapterUrlsById[manifest.id];
      await api.installFromMarketplace(manifest, customAdapterUrl);
      await refreshEverything();
      setGlobalBanner(
        `Proveedor «${manifest.name}» instalado. Ahora registra tu primera clave cifrada.`
      );
      setSubView('installed');
    } catch (err) {
      setGlobalError(
        err instanceof ApiError
          ? err.message
          : `No se pudo instalar el proveedor ${manifest.name}.`
      );
    } finally {
      setInstallingId(null);
    }
  }

  function handleFileUpload(e: React.ChangeEvent<HTMLInputElement>) {
    setLocalError(null);
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        setJsonText(reader.result);
      }
    };
    reader.onerror = () => {
      setLocalError('No se pudo leer el archivo seleccionado.');
    };
    reader.readAsText(file);
  }

  async function handleInstallLocalSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLocalError(null);
    setGlobalError(null);

    const validation = validateManifestJson(jsonText);
    if (!validation.manifest) {
      setLocalError(validation.error ?? 'Ficha JSON inválida.');
      return;
    }

    setUploadingLocal(true);
    try {
      await api.installLocalManifest(validation.manifest, localAdapterUrl);
      await refreshEverything();
      setJsonText('');
      setLocalAdapterUrl('');
      setGlobalBanner(`Ficha local «${validation.manifest.name}» instalada correctamente.`);
      setSubView('installed');
    } catch (err) {
      setLocalError(
        err instanceof ApiError ? err.message : 'Error al instalar la ficha JSON en core/.'
      );
    } finally {
      setUploadingLocal(false);
    }
  }

  async function handleConfirmDeleteProvider() {
    if (!providerToDelete) return;
    setDeletingBusy(true);
    setGlobalError(null);

    try {
      await api.deleteProvider(providerToDelete.id);
      const removedName = providerToDelete.name;
      setProviderToDelete(null);
      await refreshEverything();
      setGlobalBanner(`Proveedor «${removedName}» eliminado junto con sus claves y modelos.`);
    } catch (err) {
      setGlobalError(
        err instanceof ApiError ? err.message : 'No se pudo eliminar el proveedor.'
      );
    } finally {
      setDeletingBusy(false);
    }
  }

  async function handleConfirmDeleteKey() {
    if (!keyToDelete) return;
    setDeletingBusy(true);
    setGlobalError(null);

    try {
      await api.deleteProviderKey(keyToDelete.provider.id, keyToDelete.key.id);
      const keyLabel = keyToDelete.key.label;
      setKeyToDelete(null);
      await refreshEverything();
      setGlobalBanner(`Clave «${keyLabel}» eliminada de forma permanente.`);
    } catch (err) {
      setGlobalError(
        err instanceof ApiError ? err.message : 'No se pudo eliminar la clave del proveedor.'
      );
    } finally {
      setDeletingBusy(false);
    }
  }

  return (
    <>
      <header className="page-header">
        <div>
          <h1 className="page-title">Proveedores y Marketplace</h1>
          <p className="page-subtitle">
            Instala integraciones bajo demanda desde <code className="mono">bifrost-providers</code>{' '}
            o mediante fichas locales, registra múltiples cuentas cifradas y sincroniza sus modelos.
          </p>
        </div>

        <div className="subnav-bar" role="tablist" aria-label="Secciones de proveedores">
          <button
            type="button"
            role="tab"
            aria-selected={subView === 'installed'}
            className={`subnav-btn${subView === 'installed' ? ' active' : ''}`}
            onClick={() => setSubView('installed')}
          >
            <span>Instalados ({providers.length})</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={subView === 'marketplace'}
            className={`subnav-btn${subView === 'marketplace' ? ' active' : ''}`}
            onClick={() => setSubView('marketplace')}
          >
            <span>Catálogo Marketplace</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={subView === 'local-json'}
            className={`subnav-btn${subView === 'local-json' ? ' active' : ''}`}
            onClick={() => setSubView('local-json')}
          >
            <span>Subir ficha JSON</span>
          </button>
        </div>
      </header>

      {globalBanner ? (
        <div className="alert alert-ok" role="status">
          <span>{globalBanner}</span>
        </div>
      ) : null}

      {globalError ? (
        <div className="alert alert-error" role="alert">
          <span>{globalError}</span>
        </div>
      ) : null}

      {subView === 'installed' ? (
        loading && providers.length === 0 ? (
          <section className="card">
            <p className="field-hint">Cargando proveedores instalados…</p>
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
              <h2 className="card-title">Bifrost arranca sin proveedores preinstalados</h2>
              <p className="field-hint" style={{ maxWidth: 500 }}>
                Elige únicamente los proveedores que utilizas desde el catálogo{' '}
                <code className="mono">bifrost-providers</code> o importa una ficha JSON local.
              </p>
              <div style={{ display: 'flex', gap: 12, marginTop: 8, flexWrap: 'wrap' }}>
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => setSubView('marketplace')}
                >
                  Explorar Marketplace
                </button>
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => setSubView('local-json')}
                >
                  Importar ficha JSON local
                </button>
              </div>
            </div>
          </section>
        ) : (
          <div className="providers-master-detail">
            <aside className="providers-rail" aria-label="Proveedores instalados">
              <div className="providers-rail-label">Proveedores ({providers.length})</div>
              {providers.map((prov) => {
                const activeProvId =
                  focusedProviderId && providers.some((p) => p.id === focusedProviderId)
                    ? focusedProviderId
                    : providers[0]?.id;
                const isSelected = prov.id === activeProvId;
                const pKeys = prov.keys ?? keysByProvider[prov.id] ?? [];
                const pModels =
                  prov.models ??
                  allModels.filter((m) => m.providerId === prov.id && m.active !== false);
                const activeKeysCount = pKeys.filter((k) => k.status === 'active').length;
                const hasRateLimited = pKeys.some((k) => k.status === 'rate_limited');
                const healthDot: 'ok' | 'partial' | 'err' =
                  pKeys.length === 0
                    ? 'err'
                    : activeKeysCount > 0
                      ? hasRateLimited
                        ? 'partial'
                        : 'ok'
                      : 'partial';

                return (
                  <button
                    key={prov.id}
                    type="button"
                    className={`provider-rail-item${isSelected ? ' active' : ''}`}
                    aria-current={isSelected ? 'true' : undefined}
                    onClick={() => setFocusedProviderId(prov.id)}
                  >
                    <div className="provider-rail-left">
                      <svg
                        className="provider-rail-icon"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        aria-hidden="true"
                      >
                        <rect x="2" y="3" width="20" height="7" rx="2" />
                        <rect x="2" y="14" width="20" height="7" rx="2" />
                        <line x1="6" y1="6.5" x2="6.01" y2="6.5" />
                        <line x1="6" y1="17.5" x2="6.01" y2="17.5" />
                      </svg>
                      <div className="provider-rail-meta">
                        <span className="provider-rail-name">{prov.name}</span>
                        <span className="provider-rail-sub">
                          {pKeys.length} {pKeys.length === 1 ? 'clave' : 'claves'} · {pModels.length}{' '}
                          {pModels.length === 1 ? 'mod' : 'mods'}
                        </span>
                      </div>
                    </div>
                    <span className={`status-dot ${healthDot}`} aria-hidden="true" />
                  </button>
                );
              })}
            </aside>

            {(() => {
              const selectedProv =
                providers.find((p) => p.id === focusedProviderId) ?? providers[0];
              if (!selectedProv) return null;
              const pKeys = selectedProv.keys ?? keysByProvider[selectedProv.id] ?? [];
              const pModels =
                selectedProv.models ??
                allModels.filter((m) => m.providerId === selectedProv.id && m.active !== false);

              const selectedCatalogEntry =
                catalog.manifests.find((m) => m.id === selectedProv.id) ?? null;

              return (
                <ProviderVaultCard
                  key={selectedProv.id}
                  provider={selectedProv}
                  keys={pKeys}
                  models={pModels}
                  nodes={nodes}
                  catalogEntry={selectedCatalogEntry}
                  updatingManifest={updatingProviderId === selectedProv.id}
                  onUpdateManifest={() => void handleUpdateInstalledProviders(selectedProv.id)}
                  onOpenModel={onOpenModel}
                  onRefreshAll={refreshEverything}
                  onRequestDeleteProvider={(target) => setProviderToDelete(target)}
                  onRequestDeleteKey={(targetProv, targetKey) =>
                    setKeyToDelete({ provider: targetProv, key: targetKey })
                  }
                />
              );
            })()}
          </div>
        )
      ) : null}

      {subView === 'marketplace' ? (
        <section style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          {catalog.offline ? (
            <div className="alert alert-warning" role="status">
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 700, marginBottom: 4 }}>
                  Catálogo remoto fuera de línea o inaccesible
                </div>
                <p style={{ fontSize: '0.88rem' }}>
                  {catalog.notice ||
                    'No fue posible consultar el repositorio remoto bifrost-providers.'}{' '}
                  El panel sigue operativo: puedes reintentar la conexión o instalar cualquier
                  proveedor directamente desde una ficha JSON local.
                </p>
              </div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={() => void loadCatalog()}
                  disabled={catalogLoading}
                >
                  {catalogLoading ? 'Reintentando…' : 'Reintentar'}
                </button>
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  onClick={() => setSubView('local-json')}
                >
                  Subir ficha JSON local
                </button>
              </div>
            </div>
          ) : null}

          {/* HU-42: Multi-Repo Marketplace Sources Manager */}
          <div className="card" style={{ padding: '16px 20px' }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 12,
                  flexWrap: 'wrap',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <strong style={{ fontSize: '0.94rem' }}>Repositorios del Marketplace</strong>
                  <span className="meta-tag accent">
                    {catalog.enabledSourcesCount ??
                      sources.filter((s) => s.enabled).length}{' '}
                    {(catalog.enabledSourcesCount ??
                      sources.filter((s) => s.enabled).length) === 1
                      ? 'activo'
                      : 'activos'}{' '}
                    de {sources.length}
                  </span>
                  {catalog.catalogVersion ? (
                    <span className="meta-tag mono">v{catalog.catalogVersion}</span>
                  ) : null}
                  {catalog.checkedAt ? (
                    <span className="field-hint" style={{ fontSize: '0.75rem' }}>
                      Última comprobación:{' '}
                      {new Intl.DateTimeFormat('es-ES', {
                        dateStyle: 'short',
                        timeStyle: 'short',
                      }).format(
                        new Date(
                          catalog.checkedAt < 1_000_000_000_000
                            ? catalog.checkedAt * 1000
                            : catalog.checkedAt
                        )
                      )}
                    </span>
                  ) : null}
                </div>
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={() => setSourcesExpanded((prev) => !prev)}
                >
                  {sourcesExpanded ? 'Ocultar repositorios' : 'Gestionar repositorios'}
                </button>
              </div>

              {sourcesExpanded || sources.every((s) => !s.enabled) ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  {sources.map((src) => (
                    <div
                      key={src.id}
                      style={{
                        background: 'var(--bg)',
                        border: '1px solid var(--line)',
                        borderRadius: 8,
                        padding: '10px 12px',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        gap: 12,
                        flexWrap: 'wrap',
                      }}
                    >
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap' }}>
                          <strong style={{ fontSize: '0.86rem' }}>{src.name}</strong>
                          {src.isOfficial ? (
                            <span className="meta-tag verified">Oficial recomendado</span>
                          ) : (
                            <span className="meta-tag">Personalizado</span>
                          )}
                          {src.catalogVersion ? (
                            <span className="meta-tag mono">v{src.catalogVersion}</span>
                          ) : null}
                        </div>
                        <code
                          className="mono"
                          style={{ fontSize: '0.74rem', color: 'var(--sub)', wordBreak: 'break-all' }}
                        >
                          {src.url}
                        </code>
                        {src.lastError ? (
                          <span style={{ fontSize: '0.74rem', color: 'var(--err)' }}>
                            Error: {src.lastError}
                          </span>
                        ) : null}
                      </div>

                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
                        <button
                          type="button"
                          className={src.enabled ? 'btn btn-secondary btn-sm' : 'btn btn-primary btn-sm'}
                          disabled={togglingSourceId === src.id}
                          onClick={() => void handleToggleSource(src)}
                        >
                          {togglingSourceId === src.id
                            ? '…'
                            : src.enabled
                              ? 'Desactivar'
                              : 'Activar'}
                        </button>
                        {!src.isOfficial ? (
                          <button
                            type="button"
                            className="btn btn-danger btn-sm"
                            disabled={deletingSourceId === src.id}
                            onClick={() => void handleDeleteSource(src)}
                          >
                            {deletingSourceId === src.id ? '…' : 'Eliminar'}
                          </button>
                        ) : null}
                      </div>
                    </div>
                  ))}

                  <form
                    onSubmit={handleAddSource}
                    style={{
                      display: 'flex',
                      gap: 8,
                      flexWrap: 'wrap',
                      alignItems: 'center',
                      paddingTop: 6,
                      borderTop: '1px solid var(--line)',
                    }}
                  >
                    <input
                      type="text"
                      className="input"
                      style={{ flex: '1 1 160px', minWidth: 0 }}
                      placeholder="Nombre (ej. Catálogo equipo)"
                      value={newSourceName}
                      onChange={(e) => setNewSourceName(e.target.value)}
                      disabled={addingSource}
                    />
                    <input
                      type="url"
                      className="input mono"
                      style={{ flex: '2 1 260px', minWidth: 0 }}
                      placeholder="https://raw.githubusercontent.com/…/catalog.json"
                      value={newSourceUrl}
                      onChange={(e) => setNewSourceUrl(e.target.value)}
                      disabled={addingSource}
                    />
                    <button type="submit" className="btn btn-secondary btn-sm" disabled={addingSource}>
                      {addingSource ? 'Añadiendo…' : '+ Añadir repositorio'}
                    </button>
                  </form>
                </div>
              ) : null}
            </div>
          </div>

          <div className="card" style={{ padding: '20px 24px' }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 14,
                  flexWrap: 'wrap',
                }}
              >
                <input
                  type="search"
                  className="input"
                  style={{ maxWidth: 400 }}
                  placeholder="Buscar paquete aprobado por nombre, id o categoría…"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                />
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                  {(catalog.updatesAvailableCount ?? 0) > 0 ? (
                    <button
                      type="button"
                      className="btn btn-primary btn-sm"
                      disabled={updatingAllProviders}
                      onClick={() => void handleUpdateInstalledProviders()}
                    >
                      {updatingAllProviders
                        ? 'Actualizando todos…'
                        : `Actualizar todos (${catalog.updatesAvailableCount})`}
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    onClick={() => void loadCatalog(true)}
                    disabled={catalogLoading}
                  >
                    {catalogLoading ? 'Comprobando…' : 'Comprobar actualizaciones'}
                  </button>
                </div>
              </div>

              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 12,
                  flexWrap: 'wrap',
                }}
              >
                <div className="subnav-bar" role="group" aria-label="Filtrar por categoría">
                  {(
                    [
                      ['all', 'Todas las categorías'],
                      ['aggregator', 'Agregadores'],
                      ['official-api', 'APIs Oficiales'],
                      ['experimental-adapter', 'Adaptadores Experimentales'],
                    ] as const
                  ).map(([catKey, catLabel]) => (
                    <button
                      key={catKey}
                      type="button"
                      className={`subnav-btn${categoryFilter === catKey ? ' active' : ''}`}
                      onClick={() => setCategoryFilter(catKey)}
                    >
                      {catLabel}
                    </button>
                  ))}
                </div>

                <span className="field-hint" style={{ fontSize: '0.78rem' }}>
                  Solo paquetes aprobados en <code className="mono">bifrost-providers</code> ·
                  Instalación manual bajo demanda
                </span>
              </div>
            </div>
          </div>

          {catalogLoading && catalog.manifests.length === 0 ? (
            <div className="card">
              <p className="field-hint">Consultando fichas disponibles en los repositorios…</p>
            </div>
          ) : (catalog.enabledSourcesCount ?? sources.filter((s) => s.enabled).length) === 0 ? (
            (() => {
              const officialSource = sources.find((s) => s.isOfficial) ?? null;
              return (
                <div className="card">
                  <div className="empty-state">
                    <h3 style={{ fontSize: '1.05rem' }}>
                      Catálogo remoto desactivado por defecto (opt-in)
                    </h3>
                    <p className="field-hint" style={{ maxWidth: 500 }}>
                      Por privacidad, Bifrost no consulta repositorios externos hasta que actives
                      uno. Activa el repositorio oficial recomendado o añade tu propio catálogo
                      HTTPS arriba; también puedes importar fichas JSON locales.
                    </p>
                    <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', justifyContent: 'center' }}>
                      {officialSource ? (
                        <button
                          type="button"
                          className="btn btn-primary btn-sm"
                          disabled={togglingSourceId === officialSource.id}
                          onClick={() => void handleToggleSource(officialSource)}
                        >
                          {togglingSourceId === officialSource.id
                            ? 'Activando…'
                            : `Activar repositorio oficial (${officialSource.name})`}
                        </button>
                      ) : null}
                      <button
                        type="button"
                        className="btn btn-secondary btn-sm"
                        onClick={() => setSubView('local-json')}
                      >
                        Subir ficha JSON local
                      </button>
                    </div>
                  </div>
                </div>
              );
            })()
          ) : filteredManifests.length === 0 ? (
            <div className="card">
              <div className="empty-state">
                <h3 style={{ fontSize: '1.05rem' }}>
                  {catalog.offline
                    ? 'Sin fichas en caché del catálogo remoto'
                    : 'No se encontraron proveedores que coincidan con tu búsqueda'}
                </h3>
                <p className="field-hint" style={{ maxWidth: 460 }}>
                  Puedes importar manualmente cualquier manifiesto compatible con{' '}
                  <code className="mono">provider.schema.json</code> en la pestaña «Subir ficha
                  JSON».
                </p>
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  onClick={() => setSubView('local-json')}
                >
                  Ir a ficha JSON local
                </button>
              </div>
            </div>
          ) : (
            <div className="marketplace-grid">
              {filteredManifests.map((manifest) => {
                const isInstalled = installedIds.has(manifest.id);
                const isExperimental = manifest.packageType === 'experimental-adapter';
                const effectiveCategory: ProviderCategory =
                  manifest.category ??
                  (isExperimental ? 'experimental-adapter' : 'official-api');
                const defaultAdapterUrl = manifest.adapter?.defaultPort
                  ? `http://127.0.0.1:${manifest.adapter.defaultPort}`
                  : '';

                return (
                  <article key={manifest.id} className="marketplace-card">
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                      <div
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          gap: 8,
                          flexWrap: 'wrap',
                        }}
                      >
                        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                          <ProviderLogo slug={manifest.id} name={manifest.name} size={36} />
                          <code className="key-prefix-pill">{manifest.id}</code>
                        </div>
                        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                          {manifest.verified ? (
                            <span className="meta-tag verified">✓ Verificado</span>
                          ) : null}
                          <span className="meta-tag">
                            {formatProviderCategoryLabel(effectiveCategory)}
                          </span>
                          <span className="meta-tag">
                            {manifest.modelsSource === 'static' ? 'Estático' : 'API /models'}
                          </span>
                        </div>
                      </div>

                      <h3 style={{ fontSize: '1.08rem' }}>{manifest.name}</h3>

                      {manifest.description ? (
                        <p className="field-hint" style={{ fontSize: '0.86rem' }}>
                          {manifest.description}
                        </p>
                      ) : (
                        <p className="field-hint" style={{ fontSize: '0.84rem' }}>
                          Endpoint base: <code className="mono">{manifest.baseUrl}</code>
                        </p>
                      )}

                      {/* HU-40 Privacy ZDR & HU-38 Rate Limit Badges */}
                      {manifest.privacy || manifest.rateLimitKind ? (
                        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                          {manifest.privacy ? (() => {
                            const ret = formatRetentionLabel(manifest.privacy);
                            const badgeCls =
                              ret.tone === 'verified'
                                ? 'meta-tag verified'
                                : ret.tone === 'err'
                                  ? 'status-badge error'
                                  : ret.tone === 'partial'
                                    ? 'status-badge rate_limited'
                                    : 'meta-tag';
                            return (
                              <>
                                <span
                                  className={badgeCls}
                                  style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
                                >
                                  {ret.label}
                                  {manifest.privacy.retention === 'variable' ||
                                  manifest.privacy.note ? (
                                    <InfoTip
                                      text={
                                        manifest.privacy.note ||
                                        'La retención depende del proveedor upstream enrutado por este agregador.'
                                      }
                                    />
                                  ) : null}
                                </span>
                                <span className="meta-tag">
                                  {formatTrainingLabel(manifest.privacy.training)}
                                </span>
                                {manifest.privacy.policyUrl ? (
                                  <a
                                    href={manifest.privacy.policyUrl}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="meta-tag accent"
                                    style={{ textDecoration: 'none' }}
                                  >
                                    Política ↗
                                  </a>
                                ) : null}
                              </>
                            );
                          })() : null}
                          {formatRateLimitBadge(manifest.rateLimitKind, manifest.rateLimitWindows) ? (
                            <span className="meta-tag">
                              {formatRateLimitBadge(
                                manifest.rateLimitKind,
                                manifest.rateLimitWindows
                              )}
                            </span>
                          ) : null}
                        </div>
                      ) : null}

                      <div
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 10,
                          flexWrap: 'wrap',
                          fontSize: '0.78rem',
                          color: 'var(--sub)',
                        }}
                      >
                        {manifest.publishedAt ? (
                          <span>
                            Publicado: <strong className="mono">{manifest.publishedAt}</strong>
                          </span>
                        ) : null}
                        {manifest.modelsSource === 'static' && manifest.reviewedAt ? (
                          <span>
                            Revisado: <strong className="mono">{manifest.reviewedAt}</strong>
                          </span>
                        ) : null}
                        {manifest.manifestVersion || manifest.manifestHash ? (
                          <span className="meta-tag mono">
                            {manifest.manifestVersion ? `v${manifest.manifestVersion}` : ''}
                            {manifest.manifestVersion && manifest.manifestHash ? ' · ' : ''}
                            {manifest.manifestHash ? manifest.manifestHash.slice(0, 7) : ''}
                          </span>
                        ) : null}
                        {manifest.sourceName || manifest.sourceId ? (
                          <span className={`meta-tag${manifest.isOfficial ? ' verified' : ''}`}>
                            {manifest.sourceName || manifest.sourceId}
                          </span>
                        ) : null}
                      </div>

                      {isExperimental && !isInstalled ? (
                        <div className="field" style={{ marginTop: 4 }}>
                          <label
                            htmlFor={`adapter-url-${manifest.id}`}
                            className="field-label"
                            style={{ fontSize: '0.78rem' }}
                          >
                            URL del contenedor adaptador
                            <InfoTip text="Los paquetes experimental-adapter corren aislados exponiendo un puerto local OpenAI-compatible." />
                          </label>
                          <input
                            id={`adapter-url-${manifest.id}`}
                            type="url"
                            className="input mono"
                            style={{ padding: '8px 11px', fontSize: '0.82rem' }}
                            placeholder={defaultAdapterUrl || 'http://127.0.0.1:3100'}
                            value={adapterUrlsById[manifest.id] ?? defaultAdapterUrl}
                            onChange={(e) =>
                              setAdapterUrlsById((prev) => ({
                                ...prev,
                                [manifest.id]: e.target.value,
                              }))
                            }
                          />
                        </div>
                      ) : null}
                    </div>

                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        gap: 10,
                        paddingTop: 8,
                        borderTop: '1px solid var(--line)',
                      }}
                    >
                      <code className="key-prefix-pill" style={{ fontSize: '0.74rem' }}>
                        {isExperimental ? 'experimental-adapter' : 'official-json'}
                      </code>

                      {isInstalled ? (
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                          {manifest.updateAvailable ? (
                            <button
                              type="button"
                              className="btn btn-primary btn-sm"
                              disabled={updatingProviderId === manifest.id}
                              onClick={() => void handleUpdateInstalledProviders(manifest.id)}
                              title={`Instalado: ${(manifest.installedHash || '').slice(0, 8)} → Disponible: ${manifest.manifestVersion || manifest.manifestHash?.slice(0, 8) || 'nueva'}`}
                            >
                              {updatingProviderId === manifest.id ? 'Actualizando…' : 'Actualizar'}
                            </button>
                          ) : null}
                          <button
                            type="button"
                            className="btn btn-secondary btn-sm"
                            onClick={() => {
                              setFocusedProviderId(manifest.id);
                              setSubView('installed');
                            }}
                          >
                            ✓ Instalado · Configurar
                          </button>
                        </div>
                      ) : (
                        <button
                          type="button"
                          className="btn btn-primary btn-sm"
                          disabled={installingId === manifest.id}
                          onClick={() => void handleInstallFromCatalog(manifest)}
                        >
                          {installingId === manifest.id ? 'Instalando…' : 'Instalar proveedor'}
                        </button>
                      )}
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </section>
      ) : null}

      {subView === 'local-json' ? (
        <section className="card" aria-labelledby="local-manifest-heading">
          <div className="card-header">
            <h2 id="local-manifest-heading" className="card-title">
              Instalar proveedor desde ficha JSON local
              <InfoTip text="Valida e instala cualquier ficha compatible con schemas/provider.schema.json, incluso en entornos aislados sin salida a GitHub." />
            </h2>
          </div>

          {localError ? (
            <div className="alert alert-error" role="alert" style={{ marginBottom: 18 }}>
              <span>{localError}</span>
            </div>
          ) : null}

          <form onSubmit={handleInstallLocalSubmit} className="form-stack">
            <div className="field">
              <label htmlFor="manifest-file-input" className="field-label">
                Cargar archivo <code className="mono">.json</code> desde tu equipo
              </label>
              <input
                id="manifest-file-input"
                type="file"
                accept=".json,application/json"
                className="input"
                onChange={handleFileUpload}
                disabled={uploadingLocal}
              />
            </div>

            <div className="field">
              <label htmlFor="manifest-json-textarea" className="field-label">
                Contenido del manifiesto JSON
              </label>
              <textarea
                id="manifest-json-textarea"
                className="textarea-code"
                placeholder={SAMPLE_MANIFEST_PLACEHOLDER}
                value={jsonText}
                onChange={(e) => setJsonText(e.target.value)}
                disabled={uploadingLocal}
              />
            </div>

            <div className="field">
              <label htmlFor="local-adapter-url" className="field-label">
                URL local del adaptador (solo si <code className="mono">packageType</code> es{' '}
                <code className="mono">experimental-adapter</code>)
              </label>
              <input
                id="local-adapter-url"
                type="url"
                className="input mono"
                placeholder="http://127.0.0.1:3100 (opcional)"
                value={localAdapterUrl}
                onChange={(e) => setLocalAdapterUrl(e.target.value)}
                disabled={uploadingLocal}
              />
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 12 }}>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => setJsonText(SAMPLE_MANIFEST_PLACEHOLDER)}
                disabled={uploadingLocal}
              >
                Cargar plantilla de ejemplo
              </button>
              <button type="submit" className="btn btn-primary" disabled={uploadingLocal}>
                {uploadingLocal ? 'Validando e instalando…' : 'Instalar ficha JSON'}
              </button>
            </div>
          </form>
        </section>
      ) : null}

      {providerToDelete ? (
        <div
          className="modal-backdrop"
          role="dialog"
          aria-modal="true"
          aria-labelledby="delete-provider-modal-title"
          onClick={() => {
            if (!deletingBusy) setProviderToDelete(null);
          }}
        >
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <h2
              id="delete-provider-modal-title"
              className="card-title"
              style={{ color: 'var(--err)' }}
            >
              Confirmar eliminación de proveedor
            </h2>
            <p style={{ color: 'var(--sub)', fontSize: '0.94rem' }}>
              ¿Estás seguro de eliminar el proveedor{' '}
              <strong style={{ color: 'var(--fg)' }}>{providerToDelete.name}</strong> (
              <code className="mono">{providerToDelete.id}</code>)? Se borrarán en cascada todas
              sus claves cifradas y su catálogo de modelos sincronizados en Bifrost.
            </p>
            <div className="modal-actions">
              <button
                type="button"
                className="btn btn-secondary"
                disabled={deletingBusy}
                onClick={() => setProviderToDelete(null)}
              >
                Cancelar
              </button>
              <button
                type="button"
                className="btn btn-danger"
                disabled={deletingBusy}
                onClick={handleConfirmDeleteProvider}
              >
                {deletingBusy ? 'Eliminando…' : 'Sí, eliminar proveedor'}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {keyToDelete ? (
        <div
          className="modal-backdrop"
          role="dialog"
          aria-modal="true"
          aria-labelledby="delete-prov-key-modal-title"
          onClick={() => {
            if (!deletingBusy) setKeyToDelete(null);
          }}
        >
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <h2
              id="delete-prov-key-modal-title"
              className="card-title"
              style={{ color: 'var(--err)' }}
            >
              Confirmar revocación de clave de proveedor
            </h2>
            <p style={{ color: 'var(--sub)', fontSize: '0.94rem' }}>
              ¿Seguro que deseas retirar la clave{' '}
              <strong style={{ color: 'var(--fg)' }}>{keyToDelete.key.label}</strong> (
              <code className="mono">
                ••••{(keyToDelete.key.last4 || '').replace(/^•+/, '').slice(-4)}
              </code>
              ) del proveedor <strong>{keyToDelete.provider.name}</strong>? El router dejará de
              utilizarla de inmediato.
            </p>
            <div className="modal-actions">
              <button
                type="button"
                className="btn btn-secondary"
                disabled={deletingBusy}
                onClick={() => setKeyToDelete(null)}
              >
                Cancelar
              </button>
              <button
                type="button"
                className="btn btn-danger"
                disabled={deletingBusy}
                onClick={handleConfirmDeleteKey}
              >
                {deletingBusy ? 'Retirando…' : 'Sí, quitar clave'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
};
