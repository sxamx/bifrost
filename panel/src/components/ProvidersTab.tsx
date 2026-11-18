import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { api, ApiError } from '../api';
import type {
  ExitNodeItem,
  MarketplaceCatalogState,
  ProviderCategory,
  ProviderKeyItem,
  ProviderManifest,
  ProviderModelItem,
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

interface ProvidersTabProps {
  providers: ProviderSummary[];
  nodes: ExitNodeItem[];
  loading: boolean;
  initialSubView?: ProvidersSubView;
  onInitialSubViewConsumed?: () => void;
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
  onProvidersChanged,
}) => {
  const [subView, setSubView] = useState<ProvidersSubView>(
    initialSubView ?? (providers.length === 0 ? 'marketplace' : 'installed')
  );

  const [catalog, setCatalog] = useState<MarketplaceCatalogState>({
    manifests: [],
    offline: false,
  });
  const [catalogLoading, setCatalogLoading] = useState(false);
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

  const loadCatalog = useCallback(async () => {
    setCatalogLoading(true);
    try {
      const state = await api.getMarketplace();
      setCatalog(state);
    } catch (err) {
      setCatalog({
        manifests: [],
        offline: true,
        notice: err instanceof Error ? err.message : 'Catálogo fuera de línea.',
      });
    } finally {
      setCatalogLoading(false);
    }
  }, []);

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
          <div className="provider-stack">
            {providers.map((prov) => {
              const pKeys = prov.keys ?? keysByProvider[prov.id] ?? [];
              const pModels =
                prov.models ??
                allModels.filter((m) => m.providerId === prov.id && m.active !== false);

              return (
                <ProviderVaultCard
                  key={prov.id}
                  provider={prov}
                  keys={pKeys}
                  models={pModels}
                  nodes={nodes}
                  onRefreshAll={refreshEverything}
                  onRequestDeleteProvider={(target) => setProviderToDelete(target)}
                  onRequestDeleteKey={(targetProv, targetKey) =>
                    setKeyToDelete({ provider: targetProv, key: targetKey })
                  }
                />
              );
            })}
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
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={() => void loadCatalog()}
                  disabled={catalogLoading}
                >
                  {catalogLoading ? 'Actualizando…' : 'Actualizar catálogo'}
                </button>
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
              <p className="field-hint">Consultando fichas disponibles en bifrost-providers…</p>
            </div>
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
                        borderTop: '1px solid #e6eef8',
                      }}
                    >
                      <code className="key-prefix-pill" style={{ fontSize: '0.74rem' }}>
                        {isExperimental ? 'experimental-adapter' : 'official-json'}
                      </code>

                      {isInstalled ? (
                        <button
                          type="button"
                          className="btn btn-secondary btn-sm"
                          onClick={() => setSubView('installed')}
                        >
                          ✓ Instalado · Configurar
                        </button>
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
