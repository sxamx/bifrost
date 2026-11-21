import React, { useMemo, useState } from 'react';
import { api, ApiError } from '../api';
import type {
  ExitNodeItem,
  ModelSyncDiff,
  ProviderKeyItem,
  ProviderKeyTestResult,
  ProviderModelItem,
  ProviderRateLimitKind,
  ProviderRateLimitWindow,
  ProviderSummary,
} from '../types';
import { InfoTip } from './InfoTip';

interface ProviderVaultCardProps {
  provider: ProviderSummary;
  keys: ProviderKeyItem[];
  models: ProviderModelItem[];
  nodes: ExitNodeItem[];
  onOpenModel?: (fullId: string) => void;
  onRefreshAll: () => Promise<void>;
  onRequestDeleteProvider: (provider: ProviderSummary) => void;
  onRequestDeleteKey: (provider: ProviderSummary, key: ProviderKeyItem) => void;
}

interface PendingCollisionConfirmation {
  key: ProviderKeyItem;
  targetNode: ExitNodeItem;
  existingKeysOnNode: ProviderKeyItem[];
}

function formatLast4(last4: string): string {
  const clean = (last4 || '').replace(/^•+/, '').slice(-4);
  return clean ? `••••${clean}` : '••••••••';
}

function formatSyncDate(ts: number | null | undefined): string {
  if (!ts || !Number.isFinite(ts) || ts <= 0) return 'Sin sincronizar';
  const ms = ts < 1_000_000_000_000 ? ts * 1000 : ts;
  return new Intl.DateTimeFormat('es-ES', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(ms));
}

function formatDiffLabel(diff: ModelSyncDiff): string {
  const addedWord = diff.addedCount === 1 ? 'nuevo' : 'nuevos';
  const retiredWord = diff.retiredCount === 1 ? 'retirado' : 'retirados';
  return `${diff.addedCount} ${addedWord}, ${diff.retiredCount} ${retiredWord}`;
}

function statusBadgeLabel(status: ProviderKeyItem['status']): string {
  switch (status) {
    case 'active':
      return 'Activa';
    case 'rate_limited':
      return 'Rate limit';
    case 'no_node':
      return 'Sin nodo / Fuera de servicio';
    case 'disabled':
      return 'Desactivada';
    case 'error':
    default:
      return 'Error';
  }
}

function formatRateLimitKind(kind?: ProviderRateLimitKind | null): string | null {
  if (!kind) return null;
  if (kind === 'requests') return 'Límite por peticiones';
  if (kind === 'tokens') return 'Límite por tokens';
  if (kind === 'none') return 'Sin límite fijo';
  return null;
}

function formatRateLimitWindow(w: ProviderRateLimitWindow): string {
  if (w === 'hour') return 'hora';
  if (w === 'day') return 'día';
  if (w === 'week') return 'semana';
  return w;
}

export const ProviderVaultCard: React.FC<ProviderVaultCardProps> = ({
  provider,
  keys,
  models,
  nodes,
  onOpenModel,
  onRefreshAll,
  onRequestDeleteProvider,
  onRequestDeleteKey,
}) => {
  const [modelsOpen, setModelsOpen] = useState(models.length <= 6);
  const [modelSearch, setModelSearch] = useState('');
  const [visibleModelsLimit, setVisibleModelsLimit] = useState(6);

  const [showAddKeyForm, setShowAddKeyForm] = useState(keys.length === 0);
  const [label, setLabel] = useState('');
  const [secret, setSecret] = useState('');
  const [quotaInput, setQuotaInput] = useState('');
  const [savingKey, setSavingKey] = useState(false);

  // HU-08 & HU-11d Node Assignment & IP-Sharing Warning state
  const [updatingKeyNodeId, setUpdatingKeyNodeId] = useState<string | null>(null);
  const [collisionPrompt, setCollisionPrompt] = useState<PendingCollisionConfirmation | null>(null);

  // HU-27 & HU-29 Key toggle & test state
  const [togglingKeyId, setTogglingKeyId] = useState<string | null>(null);
  const [testingKeyId, setTestingKeyId] = useState<string | null>(null);
  const [keyTestResults, setKeyTestResults] = useState<Record<string, ProviderKeyTestResult>>({});

  const [syncingModels, setSyncingModels] = useState(false);
  const [reloadDiff, setReloadDiff] = useState<ModelSyncDiff | null>(null);
  const [detectBanner, setDetectBanner] = useState<string | null>(null);
  const [cardError, setCardError] = useState<string | null>(null);

  const modelsSource = provider.modelsSource ?? provider.manifest?.modelsSource ?? 'api';
  const isStaticSource = modelsSource === 'static';
  const reviewedAt = provider.reviewedAt ?? provider.manifest?.reviewedAt ?? null;
  const accountSecretLabel =
    provider.manifest?.adapter?.accountLabel ??
    (provider.packageType === 'experimental-adapter' ? 'Token / Sesión' : 'API Key secreta');

  const hasSavedKeys = keys.length >= 1;
  const hasDetectedModels = models.length > 0 || Boolean(provider.lastModelsSyncAt);

  async function handleAddKey(e: React.FormEvent) {
    e.preventDefault();
    setCardError(null);

    const cleanLabel = label.trim();
    const cleanSecret = secret.trim();
    if (!cleanLabel || !cleanSecret) {
      setCardError('Ingresa una etiqueta descriptiva y el secreto de la cuenta/clave.');
      return;
    }

    let parsedQuota: number | undefined;
    if (quotaInput.trim().length > 0) {
      const n = Number(quotaInput.trim());
      if (!Number.isFinite(n) || n <= 0) {
        setCardError('El tope diario opcional debe ser un número entero positivo.');
        return;
      }
      parsedQuota = Math.floor(n);
    }

    setSavingKey(true);
    try {
      await api.addProviderKey(provider.id, {
        label: cleanLabel,
        secret: cleanSecret,
        dailyQuotaLimit: parsedQuota,
      });
      setLabel('');
      setSecret('');
      setQuotaInput('');
      setShowAddKeyForm(false);
      await onRefreshAll();
    } catch (err) {
      setCardError(
        err instanceof ApiError ? err.message : 'No se pudo guardar la clave cifrada.'
      );
    } finally {
      setSavingKey(false);
    }
  }

  async function executeNodeAssignment(
    key: ProviderKeyItem,
    targetNodeId: string | null,
    confirmForce: boolean
  ) {
    setCardError(null);
    setUpdatingKeyNodeId(key.id);

    try {
      await api.assignKeyNode(provider.id, key.id, targetNodeId, confirmForce);
      setCollisionPrompt(null);
      await onRefreshAll();
    } catch (err) {
      // If backend responds 409 / requiresConfirmation for same-provider IP sharing, trigger HU-11d modal
      if (
        !confirmForce &&
        targetNodeId &&
        err instanceof ApiError &&
        (err.status === 409 || Boolean(err.data.requiresConfirmation))
      ) {
        const foundNode = nodes.find((n) => n.id === targetNodeId) ?? {
          id: targetNodeId,
          name: targetNodeId,
          mode: 'tailscale',
          endpoint: '',
          status: 'online',
          lastSeenAt: null,
          lastRotatedAt: null,
        };
        const siblings = keys.filter((other) => other.id !== key.id && other.nodeId === targetNodeId);
        setCollisionPrompt({
          key,
          targetNode: foundNode,
          existingKeysOnNode: siblings,
        });
      } else {
        setCardError(
          err instanceof ApiError
            ? err.message
            : 'No fue posible actualizar el nodo asignado a la clave.'
        );
      }
    } finally {
      setUpdatingKeyNodeId(null);
    }
  }

  function handleSelectKeyNode(key: ProviderKeyItem, rawValue: string) {
    const nextNodeId = rawValue === '' ? null : rawValue;
    if (nextNodeId === (key.nodeId ?? null)) {
      return;
    }

    // HU-11d: Check if target node already holds another key of THIS same provider
    if (nextNodeId !== null) {
      const existingSameProviderKeys = keys.filter(
        (other) => other.id !== key.id && other.nodeId === nextNodeId
      );
      if (existingSameProviderKeys.length > 0) {
        const targetNode = nodes.find((n) => n.id === nextNodeId) ?? {
          id: nextNodeId,
          name: nextNodeId,
          mode: 'tailscale',
          endpoint: '',
          status: 'online',
          lastSeenAt: null,
          lastRotatedAt: null,
        };
        setCollisionPrompt({
          key,
          targetNode,
          existingKeysOnNode: existingSameProviderKeys,
        });
        return;
      }
    }

    void executeNodeAssignment(key, nextNodeId, false);
  }

  async function handleDetectModels() {
    setCardError(null);
    setReloadDiff(null);
    setDetectBanner(null);
    setSyncingModels(true);

    try {
      const res = await api.detectProviderModels(provider.id, models.length);
      await onRefreshAll();
      setDetectBanner(
        `Detección completada: ${res.totalModels} ${
          res.totalModels === 1 ? 'modelo registrado' : 'modelos registrados'
        }.`
      );
    } catch (err) {
      setCardError(
        err instanceof ApiError
          ? err.message
          : 'Error al detectar modelos desde el proveedor.'
      );
    } finally {
      setSyncingModels(false);
    }
  }

  async function handleReloadModels() {
    setCardError(null);
    setDetectBanner(null);
    setSyncingModels(true);

    try {
      const diff = await api.reloadProviderModels(provider.id, models.length);
      setReloadDiff(diff);
      await onRefreshAll();
    } catch (err) {
      setCardError(
        err instanceof ApiError
          ? err.message
          : 'No se pudo recargar el catálogo de modelos del proveedor.'
      );
    } finally {
      setSyncingModels(false);
    }
  }

  async function handleToggleKey(key: ProviderKeyItem) {
    setCardError(null);
    setTogglingKeyId(key.id);
    try {
      const nextEnabled = key.status === 'disabled';
      await api.toggleProviderKey(provider.id, key.id, nextEnabled);
      await onRefreshAll();
    } catch (err) {
      setCardError(
        err instanceof ApiError ? err.message : 'No se pudo cambiar el estado de la clave.'
      );
    } finally {
      setTogglingKeyId(null);
    }
  }

  async function handleTestKey(key: ProviderKeyItem) {
    setCardError(null);
    setTestingKeyId(key.id);
    try {
      const res = await api.testProviderKey(provider.id, key.id);
      setKeyTestResults((prev) => ({ ...prev, [key.id]: res }));
      await onRefreshAll();
    } catch (err) {
      setKeyTestResults((prev) => ({
        ...prev,
        [key.id]: {
          ok: false,
          httpStatus: err instanceof ApiError ? err.status : null,
          latencyMs: 0,
          message: err instanceof ApiError ? err.message : 'Error al probar la clave.',
        },
      }));
    } finally {
      setTestingKeyId(null);
    }
  }

  const filteredModels = useMemo(() => {
    const q = modelSearch.trim().toLowerCase();
    if (!q) return models;
    return models.filter(
      (m) =>
        m.name.toLowerCase().includes(q) ||
        m.fullId.toLowerCase().includes(q) ||
        m.modelId.toLowerCase().includes(q)
    );
  }, [models, modelSearch]);

  const visibleModels = filteredModels.slice(0, visibleModelsLimit);
  const privacy = provider.privacy ?? provider.manifest?.privacy ?? null;
  const hasPrivacyWarning = Boolean(
    privacy &&
      (privacy.retention === 'retained' ||
        privacy.training === 'allowed' ||
        privacy.training === 'opt_out')
  );
  const rateLimitKind = provider.rateLimitKind ?? provider.manifest?.rateLimitKind ?? null;
  const rateLimitWindows = provider.rateLimitWindows ?? provider.manifest?.rateLimitWindows ?? [];
  const rateLimitLabel = formatRateLimitKind(rateLimitKind);

  return (
    <article className="provider-card" aria-labelledby={`prov-heading-${provider.id}`}>
      {/* Provider Header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
          gap: 16,
          flexWrap: 'wrap',
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <h2
              id={`prov-heading-${provider.id}`}
              className="card-title"
              style={{ fontSize: '1.14rem' }}
            >
              {provider.name}
            </h2>
            <code className="key-prefix-pill">{provider.id}</code>
            {provider.verified ? <span className="meta-tag verified">✓ Verificado</span> : null}
            <span className="meta-tag">
              {provider.packageType === 'experimental-adapter'
                ? 'Adaptador aislado'
                : 'Ficha oficial JSON'}
            </span>
            <span className="meta-tag accent">
              {isStaticSource ? 'Catálogo estático' : 'Catálogo vía API'}
            </span>
            {rateLimitLabel ? (
              <span className="meta-tag">
                {rateLimitLabel}
                {rateLimitWindows.length > 0
                  ? ` · ${rateLimitWindows.map(formatRateLimitWindow).join('/')}`
                  : ''}
              </span>
            ) : null}
            {hasPrivacyWarning && privacy ? (
              <span
                className="status-badge rate_limited"
                style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
              >
                Sin ZDR / Entrenamiento
                <InfoTip
                  text={
                    privacy.note ||
                    `Retención: ${privacy.retention}. Política de entrenamiento: ${privacy.training}. Evita enviar datos sensibles por este proveedor.`
                  }
                />
              </span>
            ) : null}
          </div>

          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 14,
              flexWrap: 'wrap',
              fontSize: '0.8rem',
              color: 'var(--sub)',
            }}
          >
            {provider.baseUrl ? (
              <span>
                Endpoint: <code className="mono">{provider.baseUrl}</code>
              </span>
            ) : null}
            {isStaticSource && reviewedAt ? (
              <span>
                Revisada: <strong>{reviewedAt}</strong>
              </span>
            ) : null}
            {!isStaticSource && provider.lastModelsSyncAt ? (
              <span>Sincronizado: {formatSyncDate(provider.lastModelsSyncAt)}</span>
            ) : null}
          </div>
        </div>

        <button
          type="button"
          className="btn btn-danger btn-sm"
          onClick={() => onRequestDeleteProvider(provider)}
        >
          Eliminar proveedor
        </button>
      </div>

      {cardError ? (
        <div className="alert alert-error" role="alert">
          <span>{cardError}</span>
        </div>
      ) : null}

      {/* Section 1: Encrypted Accounts / Keys Vault + Node Binding (HU-07, HU-08, HU-09, HU-11d) */}
      <section className="provider-section" aria-label={`Claves de ${provider.name}`}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 12,
            flexWrap: 'wrap',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <h3 style={{ fontSize: '0.98rem' }}>
              Cuentas y claves cifradas ({keys.length})
            </h3>
            <InfoTip text="Cada clave nueva se asigna automáticamente al nodo en línea con menos claves de este proveedor (reparto equitativo). Puedes cambiar el nodo manualmente en la tabla." />
          </div>

          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={() => setShowAddKeyForm((prev) => !prev)}
          >
            {showAddKeyForm ? 'Ocultar formulario' : '+ Agregar clave / cuenta'}
          </button>
        </div>

        {showAddKeyForm ? (
          <form
            onSubmit={handleAddKey}
            style={{
              background: 'var(--panel)',
              border: '1px solid var(--line)',
              borderRadius: 9,
              padding: '16px 18px',
              display: 'flex',
              flexDirection: 'column',
              gap: 14,
            }}
          >
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 200px), 1fr))',
                gap: 14,
              }}
            >
              <div className="field">
                <label htmlFor={`key-label-${provider.id}`} className="field-label">
                  Etiqueta de cuenta
                </label>
                <input
                  id={`key-label-${provider.id}`}
                  type="text"
                  className="input"
                  placeholder="ej. Cuenta personal #1"
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                  disabled={savingKey}
                />
              </div>

              <div className="field">
                <label htmlFor={`key-secret-${provider.id}`} className="field-label">
                  {accountSecretLabel}
                </label>
                <input
                  id={`key-secret-${provider.id}`}
                  type="password"
                  autoComplete="off"
                  className="input mono"
                  placeholder="sk-..."
                  value={secret}
                  onChange={(e) => setSecret(e.target.value)}
                  disabled={savingKey}
                />
              </div>

              <div className="field">
                <label htmlFor={`key-quota-${provider.id}`} className="field-label">
                  Tope diario estimado (opcional)
                  <InfoTip text="Límite opcional de peticiones/tokens diarios para balancear múltiples cuentas gratuitas." />
                </label>
                <input
                  id={`key-quota-${provider.id}`}
                  type="number"
                  min={1}
                  className="input"
                  placeholder="Sin tope fijo"
                  value={quotaInput}
                  onChange={(e) => setQuotaInput(e.target.value)}
                  disabled={savingKey}
                />
              </div>
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
              {keys.length > 0 ? (
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={() => setShowAddKeyForm(false)}
                  disabled={savingKey}
                >
                  Cancelar
                </button>
              ) : null}
              <button type="submit" className="btn btn-primary btn-sm" disabled={savingKey}>
                {savingKey ? 'Cifrando y guardando…' : 'Guardar clave cifrada'}
              </button>
            </div>
          </form>
        ) : null}

        {keys.length === 0 ? (
          <p className="field-hint">
            No hay claves registradas en este proveedor. Registra al menos una cuenta para habilitar
            la detección de modelos y el failover automático.
          </p>
        ) : (
          <div
            className="table-wrap"
            style={{
              background: 'var(--panel)',
              borderRadius: 9,
              border: '1px solid var(--line)',
            }}
          >
            <table className="bf-table">
              <thead>
                <tr>
                  <th>Etiqueta</th>
                  <th>Terminación</th>
                  <th>Nodo de salida asignado</th>
                  <th>Estado</th>
                  <th style={{ textAlign: 'right' }}>Acción</th>
                </tr>
              </thead>
              <tbody>
                {keys.map((k) => {
                  const assignedNode = k.nodeId
                    ? nodes.find((n) => n.id === k.nodeId) ?? null
                    : null;

                  return (
                    <tr key={k.id}>
                      <td style={{ fontWeight: 700 }}>
                        {k.label}
                        {typeof k.dailyQuotaLimit === 'number' && k.dailyQuotaLimit > 0 ? (
                          <span className="field-hint" style={{ display: 'block', fontWeight: 500 }}>
                            Tope diario: {k.dailyQuotaLimit.toLocaleString('es-ES')}
                          </span>
                        ) : null}
                      </td>
                      <td>
                        <code className="key-prefix-pill">{formatLast4(k.last4)}</code>
                      </td>
                      <td>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                          <select
                            aria-label={`Nodo asignado para ${k.label}`}
                            className="select-compact"
                            style={{ maxWidth: 230 }}
                            title={
                              assignedNode
                                ? `${assignedNode.name} (${assignedNode.endpoint})`
                                : 'Directo / Sin nodo'
                            }
                            value={k.nodeId ?? ''}
                            disabled={updatingKeyNodeId === k.id}
                            onChange={(e) => handleSelectKeyNode(k, e.target.value)}
                          >
                            <option value="">Directo / Sin nodo</option>
                            {nodes.map((nodeOpt) => {
                              const statusTxt =
                                nodeOpt.status === 'online'
                                  ? 'En línea'
                                  : nodeOpt.status === 'unresponsive'
                                    ? 'Sin respuesta'
                                    : 'Desconectado';
                              return (
                                <option
                                  key={nodeOpt.id}
                                  value={nodeOpt.id}
                                  title={`${nodeOpt.name} (${nodeOpt.endpoint})`}
                                >
                                  {nodeOpt.name} · {statusTxt}
                                </option>
                              );
                            })}
                            {k.nodeId && !assignedNode ? (
                              <option value={k.nodeId}>{k.nodeId} (no disponible)</option>
                            ) : null}
                          </select>
                          {k.forcedNode ? (
                            <InfoTip text="Asignación manual forzada: este nodo comparte IP con otra clave del mismo proveedor." />
                          ) : null}
                        </div>
                      </td>
                      <td>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>
                            <span
                              className={`status-badge ${
                                k.status === 'disabled' ? 'offline' : k.status
                              }`}
                            >
                              <span
                                className={`status-dot ${
                                  k.status === 'active'
                                    ? 'ok'
                                    : k.status === 'rate_limited'
                                      ? 'partial'
                                      : k.status === 'disabled'
                                        ? 'muted'
                                        : 'err'
                                }`}
                              />
                              {statusBadgeLabel(k.status)}
                            </span>
                            {k.lastError ? (
                              <InfoTip
                                label={`Detalle de error en ${k.label}`}
                                text={`Último motivo reportado: ${k.lastError}`}
                              />
                            ) : null}
                          </div>
                          {keyTestResults[k.id] ? (
                            <span
                              className="mono"
                              style={{
                                fontSize: '0.72rem',
                                color: keyTestResults[k.id].ok ? 'var(--ok)' : 'var(--err)',
                              }}
                            >
                              {keyTestResults[k.id].ok
                                ? `OK · ${keyTestResults[k.id].latencyMs} ms`
                                : keyTestResults[k.id].message}
                            </span>
                          ) : null}
                        </div>
                      </td>
                      <td style={{ textAlign: 'right' }}>
                        <div
                          style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            justifyContent: 'flex-end',
                            gap: 6,
                            flexWrap: 'wrap',
                          }}
                        >
                          <button
                            type="button"
                            className="btn btn-secondary btn-sm"
                            disabled={testingKeyId === k.id || k.status === 'no_node'}
                            title={
                              k.status === 'no_node'
                                ? 'Asigna un nodo en línea o modo directo para probar esta clave'
                                : 'Probar validez y latencia de esta clave'
                            }
                            onClick={() => void handleTestKey(k)}
                          >
                            {testingKeyId === k.id ? 'Probando…' : 'Probar'}
                          </button>
                          <button
                            type="button"
                            className="btn btn-secondary btn-sm"
                            disabled={togglingKeyId === k.id}
                            onClick={() => void handleToggleKey(k)}
                          >
                            {togglingKeyId === k.id
                              ? '…'
                              : k.status === 'disabled'
                                ? 'Activar'
                                : 'Desactivar'}
                          </button>
                          <button
                            type="button"
                            className="btn btn-danger btn-sm"
                            onClick={() => onRequestDeleteKey(provider, k)}
                          >
                            Quitar
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Section 2: On-Demand Model Detection & Reload (HU-06b & HU-06c) */}
      <section className="provider-section" aria-label={`Modelos de ${provider.name}`}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 12,
            flexWrap: 'wrap',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <h3 style={{ fontSize: '0.98rem' }}>
              Modelos disponibles ({models.length})
            </h3>
            {isStaticSource ? (
              <span className="meta-tag">
                Lista estática{reviewedAt ? ` · Revisada ${reviewedAt}` : ''}
              </span>
            ) : (
              <span className="meta-tag accent">Fuente: API del proveedor</span>
            )}
            <InfoTip
              text={
                isStaticSource
                  ? 'Este proveedor utiliza una lista declarativa estática curada en su manifiesto y muestra su fecha de última revisión.'
                  : 'Los modelos se consultan directamente en el endpoint /models del proveedor usando una de tus claves activas.'
              }
            />
          </div>

          {hasSavedKeys ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              {!hasDetectedModels ? (
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  disabled={syncingModels}
                  onClick={handleDetectModels}
                >
                  {syncingModels ? 'Detectando modelos…' : 'Detectar modelos'}
                </button>
              ) : (
                <>
                  {models.length === 0 ? (
                    <button
                      type="button"
                      className="btn btn-primary btn-sm"
                      disabled={syncingModels}
                      onClick={handleDetectModels}
                    >
                      {syncingModels ? 'Detectando…' : 'Detectar modelos'}
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    disabled={syncingModels}
                    onClick={handleReloadModels}
                  >
                    {syncingModels ? 'Recargando…' : 'Recargar modelos'}
                  </button>
                </>
              )}
            </div>
          ) : null}
        </div>

        {reloadDiff ? (
          <div className="diff-banner" role="status">
            <span>
              Catálogo actualizado: <strong>{formatDiffLabel(reloadDiff)}</strong> (total activos:{' '}
              {reloadDiff.totalModels}).
            </span>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => setReloadDiff(null)}
            >
              Cerrar
            </button>
          </div>
        ) : null}

        {detectBanner ? (
          <div className="alert alert-ok" role="status">
            <span>{detectBanner}</span>
          </div>
        ) : null}

        {models.length === 0 ? (
          <p className="field-hint">
            0 modelos activos en este proveedor.{' '}
            {hasSavedKeys
              ? 'Pulsa «Detectar modelos» para cargar el catálogo disponible.'
              : 'Guarda primero al menos una clave arriba para habilitar «Detectar modelos».'}
          </p>
        ) : (
          <>
            {models.length > 6 ? (
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 10,
                  flexWrap: 'wrap',
                }}
              >
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={() => setModelsOpen((prev) => !prev)}
                >
                  {modelsOpen
                    ? `Ocultar catálogo (${models.length})`
                    : `Explorar catálogo (${models.length} modelos)`}
                </button>
                {modelsOpen ? (
                  <input
                    type="search"
                    className="input"
                    style={{ maxWidth: 300, padding: '6px 10px', fontSize: '0.82rem' }}
                    placeholder={`Buscar entre ${models.length} modelos…`}
                    value={modelSearch}
                    onChange={(e) => {
                      setModelSearch(e.target.value);
                      setVisibleModelsLimit(6);
                    }}
                  />
                ) : null}
              </div>
            ) : null}

            {modelsOpen ? (
              <>
                {filteredModels.length === 0 ? (
                  <p className="field-hint">
                    Ningún modelo coincide con «{modelSearch.trim()}».
                  </p>
                ) : (
                  <div className="models-grid">
                    {visibleModels.map((m) => (
                      <button
                        key={m.fullId}
                        type="button"
                        className="model-tile clickable-tile"
                        onClick={() => onOpenModel?.(m.fullId)}
                        title={`Abrir ficha y métricas de ${m.fullId}`}
                      >
                        <div
                          style={{
                            display: 'flex',
                            alignItems: 'flex-start',
                            justifyContent: 'space-between',
                            gap: 8,
                            width: '100%',
                          }}
                        >
                          <span style={{ fontWeight: 700, fontSize: '0.88rem', color: 'var(--fg)' }}>
                            {m.name}
                          </span>
                          {m.isFree ? <span className="meta-tag verified">Gratis</span> : null}
                        </div>
                        <code
                          className="mono"
                          style={{ fontSize: '0.76rem', color: 'var(--sub)', wordBreak: 'break-all' }}
                        >
                          {m.fullId}
                        </code>
                        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 2 }}>
                          {typeof m.contextLength === 'number' && m.contextLength > 0 ? (
                            <span className="meta-tag">
                              {Math.round(m.contextLength / 1024)}k ctx
                            </span>
                          ) : null}
                          {m.capabilities?.tools ? <span className="meta-tag">Tools</span> : null}
                          {m.capabilities?.reasoning ? (
                            <span className="meta-tag">Reasoning</span>
                          ) : null}
                          {m.capabilities?.structuredOutput ? (
                            <span className="meta-tag">JSON</span>
                          ) : null}
                        </div>
                      </button>
                    ))}
                  </div>
                )}

                {filteredModels.length > visibleModelsLimit ? (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm"
                      onClick={() => setVisibleModelsLimit((prev) => prev + 12)}
                    >
                      Mostrar más (+{Math.min(12, filteredModels.length - visibleModelsLimit)} de{' '}
                      {filteredModels.length - visibleModelsLimit} restantes)
                    </button>
                    {visibleModelsLimit > 6 ? (
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        onClick={() => setVisibleModelsLimit(6)}
                      >
                        Contraer lista
                      </button>
                    ) : null}
                  </div>
                ) : visibleModelsLimit > 6 && filteredModels.length > 6 ? (
                  <div>
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      onClick={() => setVisibleModelsLimit(6)}
                    >
                      Mostrar menos modelos
                    </button>
                  </div>
                ) : null}
              </>
            ) : null}
          </>
        )}
      </section>

      {/* HU-11d Explicit IP-Sharing Ban Risk Warning Modal */}
      {collisionPrompt ? (
        <div
          className="modal-backdrop"
          role="dialog"
          aria-modal="true"
          aria-labelledby={`ip-ban-risk-title-${provider.id}`}
          onClick={() => {
            if (!updatingKeyNodeId) setCollisionPrompt(null);
          }}
        >
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <h2
              id={`ip-ban-risk-title-${provider.id}`}
              className="card-title"
              style={{ color: 'var(--err)' }}
            >
              Riesgo de baneo por IP compartida ({provider.name})
            </h2>

            <div className="alert alert-warning" role="alert">
              <span>
                El nodo <strong>{collisionPrompt.targetNode.name}</strong> ya tiene vinculada otra
                clave de <strong>{provider.name}</strong>. Usar múltiples cuentas gratuitas desde
                la misma IP de salida puede provocar bloqueos o suspensión de cuentas en el
                proveedor.
              </span>
            </div>

            {collisionPrompt.existingKeysOnNode.length > 0 ? (
              <div style={{ fontSize: '0.88rem', color: 'var(--sub)' }}>
                Claves de {provider.name} ya activas en ese nodo:
                <ul style={{ margin: '6px 0 0', paddingLeft: 20 }}>
                  {collisionPrompt.existingKeysOnNode.map((existing) => (
                    <li key={existing.id}>
                      <strong>{existing.label}</strong> (
                      <code className="mono">{formatLast4(existing.last4)}</code>)
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            <div className="modal-actions">
              <button
                type="button"
                className="btn btn-secondary"
                disabled={Boolean(updatingKeyNodeId)}
                onClick={() => setCollisionPrompt(null)}
              >
                Cancelar cambio
              </button>
              <button
                type="button"
                className="btn btn-danger"
                disabled={Boolean(updatingKeyNodeId)}
                onClick={() =>
                  void executeNodeAssignment(
                    collisionPrompt.key,
                    collisionPrompt.targetNode.id,
                    true
                  )
                }
              >
                {updatingKeyNodeId ? 'Forzando asignación…' : 'Asumir riesgo y compartir nodo'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </article>
  );
};
