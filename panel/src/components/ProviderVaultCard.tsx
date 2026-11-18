import React, { useState } from 'react';
import { api, ApiError } from '../api';
import type {
  ExitNodeItem,
  ModelSyncDiff,
  ProviderKeyItem,
  ProviderModelItem,
  ProviderSummary,
} from '../types';
import { InfoTip } from './InfoTip';

interface ProviderVaultCardProps {
  provider: ProviderSummary;
  keys: ProviderKeyItem[];
  models: ProviderModelItem[];
  nodes: ExitNodeItem[];
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
      return 'Sin servicio';
    case 'error':
    default:
      return 'Error';
  }
}

export const ProviderVaultCard: React.FC<ProviderVaultCardProps> = ({
  provider,
  keys,
  models,
  nodes,
  onRefreshAll,
  onRequestDeleteProvider,
  onRequestDeleteKey,
}) => {
  const [showAddKeyForm, setShowAddKeyForm] = useState(keys.length === 0);
  const [label, setLabel] = useState('');
  const [secret, setSecret] = useState('');
  const [quotaInput, setQuotaInput] = useState('');
  const [savingKey, setSavingKey] = useState(false);

  // HU-08 & HU-11d Node Assignment & IP-Sharing Warning state
  const [updatingKeyNodeId, setUpdatingKeyNodeId] = useState<string | null>(null);
  const [collisionPrompt, setCollisionPrompt] = useState<PendingCollisionConfirmation | null>(null);

  const [syncingModels, setSyncingModels] = useState(false);
  const [reloadDiff, setReloadDiff] = useState<ModelSyncDiff | null>(null);
  const [detectBanner, setDetectBanner] = useState<string | null>(null);
  const [cardError, setCardError] = useState<string | null>(null);
  const [showAllModels, setShowAllModels] = useState(false);

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

  const visibleModels = showAllModels ? models : models.slice(0, 8);

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
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <h2
              id={`prov-heading-${provider.id}`}
              className="card-title"
              style={{ fontSize: '1.22rem' }}
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
          </div>

          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 16,
              flexWrap: 'wrap',
              fontSize: '0.83rem',
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
                Última revisión de ficha estática: <strong>{reviewedAt}</strong>
              </span>
            ) : null}
            {!isStaticSource && provider.lastModelsSyncAt ? (
              <span>Última sincronización: {formatSyncDate(provider.lastModelsSyncAt)}</span>
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
              background: '#ffffff',
              border: '1px solid var(--line)',
              borderRadius: 14,
              padding: '18px 20px',
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
              background: '#ffffff',
              borderRadius: 12,
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
                            value={k.nodeId ?? ''}
                            disabled={updatingKeyNodeId === k.id}
                            onChange={(e) => handleSelectKeyNode(k, e.target.value)}
                          >
                            <option value="">Directo / Sin nodo</option>
                            {nodes.map((nodeOpt) => (
                              <option key={nodeOpt.id} value={nodeOpt.id}>
                                {nodeOpt.name} ({nodeOpt.endpoint}) —{' '}
                                {nodeOpt.status === 'online'
                                  ? 'En línea'
                                  : nodeOpt.status === 'unresponsive'
                                    ? 'Sin respuesta'
                                    : 'Desconectado'}
                              </option>
                            ))}
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
                        <div style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>
                          <span className={`status-badge ${k.status}`}>
                            <span
                              className={`status-dot ${
                                k.status === 'active'
                                  ? 'ok'
                                  : k.status === 'rate_limited'
                                    ? 'partial'
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
                      </td>
                      <td style={{ textAlign: 'right' }}>
                        <button
                          type="button"
                          className="btn btn-danger btn-sm"
                          onClick={() => onRequestDeleteKey(provider, k)}
                        >
                          Quitar clave
                        </button>
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
            <div className="models-grid">
              {visibleModels.map((m) => (
                <div key={m.fullId} className="model-tile">
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'flex-start',
                      justifyContent: 'space-between',
                      gap: 8,
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
                </div>
              ))}
            </div>

            {models.length > 8 ? (
              <div>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => setShowAllModels((prev) => !prev)}
                >
                  {showAllModels
                    ? 'Mostrar menos modelos'
                    : `Ver los ${models.length} modelos detectados`}
                </button>
              </div>
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
