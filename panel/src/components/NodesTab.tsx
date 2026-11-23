import React, { useEffect, useMemo, useState } from 'react';
import { api, ApiError } from '../api';
import { copyTextToClipboard } from '../clipboard';
import type {
  CreateNodeResult,
  ExitNodeItem,
  ExitNodeTestResult,
  NodeAssignedKeyRef,
  NodeMode,
  ProviderSummary,
} from '../types';
import { InfoTip } from './InfoTip';

interface NodesTabProps {
  nodes: ExitNodeItem[];
  providers: ProviderSummary[];
  loading: boolean;
  onNodesChanged: () => Promise<void>;
}

function formatDateTime(ts: number | null | undefined, emptyText: string): string {
  if (!ts || !Number.isFinite(ts) || ts <= 0) return emptyText;
  const ms = ts < 1_000_000_000_000 ? ts * 1000 : ts;
  return new Intl.DateTimeFormat('es-ES', {
    dateStyle: 'medium',
    timeStyle: 'medium',
  }).format(new Date(ms));
}

function formatHeartbeatElapsed(ts: number | null | undefined): string | null {
  if (!ts || !Number.isFinite(ts) || ts <= 0) return null;
  const ms = ts < 1_000_000_000_000 ? ts * 1000 : ts;
  const diffSec = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (diffSec < 60) return `hace ${diffSec}s`;
  if (diffSec < 3600) return `hace ${Math.floor(diffSec / 60)} min`;
  return `hace ${Math.floor(diffSec / 3600)} h`;
}

function nodeStatusLabel(status: ExitNodeItem['status']): string {
  switch (status) {
    case 'online':
      return 'En línea';
    case 'unresponsive':
      return 'Sin respuesta';
    case 'offline':
    default:
      return 'Desconectado';
  }
}

function formatLast4(last4: string): string {
  const clean = (last4 || '').replace(/^•+/, '').slice(-4);
  return clean ? `••••${clean}` : '••••••••';
}

export const NodesTab: React.FC<NodesTabProps> = ({
  nodes,
  providers,
  loading,
  onNodesChanged,
}) => {
  // Add node modal / form state (HU-11 & HU-11b)
  const [addModalOpen, setAddModalOpen] = useState(false);
  const [name, setName] = useState('');
  const [mode, setMode] = useState<NodeMode>('tailscale');
  const [endpoint, setEndpoint] = useState('');
  const [creating, setCreating] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  // One-time install command modal state (HU-11)
  const [createdResult, setCreatedResult] = useState<CreateNodeResult | null>(null);
  const [copiedCommand, setCopiedCommand] = useState(false);
  const [copiedToken, setCopiedToken] = useState(false);

  // Rotation, Test, Update & Delete state (HU-11c, HU-13, HU-28, HU-41)
  const [rotatingId, setRotatingId] = useState<string | null>(null);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, ExitNodeTestResult>>({});
  const [updatingId, setUpdatingId] = useState<string | null>(null);
  const [nodeToDelete, setNodeToDelete] = useState<ExitNodeItem | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [banner, setBanner] = useState<string | null>(null);
  const [errorBanner, setErrorBanner] = useState<string | null>(null);

  // Map nodeId -> assigned provider keys across all installed providers
  const assignedKeysByNode = useMemo(() => {
    const map: Record<string, NodeAssignedKeyRef[]> = {};
    for (const n of nodes) {
      map[n.id] = n.assignedKeys ? [...n.assignedKeys] : [];
    }

    for (const prov of providers) {
      const pKeys = prov.keys ?? [];
      for (const k of pKeys) {
        if (!k.nodeId) continue;
        if (!map[k.nodeId]) {
          map[k.nodeId] = [];
        }
        const alreadyListed = map[k.nodeId].some((item) => item.id === k.id);
        if (!alreadyListed) {
          map[k.nodeId].push({
            id: k.id,
            providerId: prov.id,
            providerName: prov.name,
            label: k.label,
            last4: k.last4,
          });
        }
      }
    }
    return map;
  }, [nodes, providers]);

  async function handleTestNode(node: ExitNodeItem) {
    setErrorBanner(null);
    setTestingId(node.id);
    try {
      const res = await api.testNode(node.id);
      setTestResults((prev) => ({ ...prev, [node.id]: res }));
      await onNodesChanged();
    } catch (err) {
      setTestResults((prev) => ({
        ...prev,
        [node.id]: {
          ok: false,
          status: 'unresponsive',
          latencyMs: null,
          error: err instanceof ApiError ? err.message : 'No se pudo contactar al nodo.',
        },
      }));
    } finally {
      setTestingId(null);
    }
  }

  async function handleUpdateNode(node: ExitNodeItem) {
    setErrorBanner(null);
    setBanner(null);
    setUpdatingId(node.id);
    try {
      const res = await api.updateNode(node.id);
      if (res.upToDate) {
        setBanner(
          res.message || `El nodo «${node.name}» ya está al día con la última versión.`
        );
      } else {
        setBanner(
          res.message ||
            `Actualización enviada al nodo «${node.name}». El agente se reiniciará en unos segundos.`
        );
      }
      await onNodesChanged();
    } catch (err) {
      setErrorBanner(
        err instanceof ApiError
          ? err.message
          : `No se pudo iniciar la actualización del nodo «${node.name}».`
      );
    } finally {
      setUpdatingId(null);
    }
  }

  async function handleCreateNode(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);
    setErrorBanner(null);

    const cleanName = name.trim();
    const cleanEndpoint = endpoint.trim();
    if (!cleanName) {
      setFormError('Ingresa un nombre descriptivo para identificar el nodo (ej. VM Frankfurt #1).');
      return;
    }
    if (!cleanEndpoint) {
      setFormError(
        mode === 'tailscale'
          ? 'Ingresa la IP o hostname de Tailscale y puerto (ej. 100.84.12.9:9443).'
          : 'Ingresa la IP pública o dominio TLS y puerto (ej. 203.0.113.40:9443).'
      );
      return;
    }

    setCreating(true);
    try {
      const result = await api.createNode({
        name: cleanName,
        mode,
        endpoint: cleanEndpoint,
      });
      setAddModalOpen(false);
      setName('');
      setEndpoint('');
      setMode('tailscale');
      setCopiedCommand(false);
      setCopiedToken(false);
      setCreatedResult(result);
      await onNodesChanged();
    } catch (err) {
      setFormError(
        err instanceof ApiError ? err.message : 'No fue posible registrar el nodo de salida.'
      );
    } finally {
      setCreating(false);
    }
  }

  async function handleRotateToken(node: ExitNodeItem) {
    setBanner(null);
    setErrorBanner(null);
    setRotatingId(node.id);

    try {
      const res = await api.rotateNodeToken(node.id);
      await onNodesChanged();
      const graceMinutes = Math.round((res.graceSeconds ?? 300) / 60);
      setBanner(
        `Token del nodo «${node.name}» rotado con éxito. Ventana de coexistencia sin cortes activa por ${graceMinutes} minutos.`
      );
    } catch (err) {
      setErrorBanner(
        err instanceof ApiError
          ? err.message
          : `Error al rotar el token del nodo «${node.name}».`
      );
    } finally {
      setRotatingId(null);
    }
  }

  const [deleteModalError, setDeleteModalError] = useState<string | null>(null);

  useEffect(() => {
    if (!addModalOpen && !createdResult && !nodeToDelete) return;
    setDeleteModalError(null);
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (nodeToDelete && !deleting) setNodeToDelete(null);
      else if (addModalOpen && !creating) setAddModalOpen(false);
      else if (createdResult) setCreatedResult(null);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [addModalOpen, createdResult, nodeToDelete, deleting, creating]);

  async function handleConfirmDeleteNode() {
    if (!nodeToDelete) return;
    setDeleting(true);
    setDeleteModalError(null);
    setErrorBanner(null);

    try {
      const affectedCount = (assignedKeysByNode[nodeToDelete.id] ?? []).length;
      const deletedName = nodeToDelete.name;
      await api.deleteNode(nodeToDelete.id);
      setNodeToDelete(null);
      await onNodesChanged();
      setBanner(
        affectedCount > 0
          ? `Nodo «${deletedName}» retirado. ${affectedCount} ${
              affectedCount === 1 ? 'clave quedó marcada' : 'claves quedaron marcadas'
            } sin servicio hasta reasignación.`
          : `Nodo «${deletedName}» retirado correctamente.`
      );
    } catch (err) {
      setDeleteModalError(
        err instanceof ApiError ? err.message : 'No fue posible eliminar el nodo.'
      );
    } finally {
      setDeleting(false);
    }
  }

  async function copyToClipboard(text: string, setter: (v: boolean) => void) {
    const ok = await copyTextToClipboard(text);
    if (ok) {
      setter(true);
      window.setTimeout(() => setter(false), 2400);
    } else {
      setter(false);
    }
  }

  const keysAffectedOnDelete = nodeToDelete ? assignedKeysByNode[nodeToDelete.id] ?? [] : [];

  return (
    <>
      <header className="page-header">
        <div>
          <h1 className="page-title">Nodos de salida (Zero-Knowledge)</h1>
          <p className="page-subtitle">
            Distribuye tus cuentas gratuitas en distintas IPs mediante túneles TCP{' '}
            <code className="mono">HTTP CONNECT</code>. El nodo remoto nunca ve tus prompts ni tus
            claves API.
          </p>
        </div>

        <button
          type="button"
          className="btn btn-primary"
          onClick={() => {
            setFormError(null);
            setAddModalOpen(true);
          }}
        >
          + Agregar nodo
        </button>
      </header>

      {banner ? (
        <div className="alert alert-ok" role="status">
          <span>{banner}</span>
        </div>
      ) : null}

      {errorBanner ? (
        <div className="alert alert-error" role="alert">
          <span>{errorBanner}</span>
        </div>
      ) : null}

      {/* Nodes Overview / Table (HU-12 & HU-11c) */}
      <section className="card" aria-labelledby="nodes-table-heading">
        <div className="card-header">
          <h2 id="nodes-table-heading" className="card-title">
            Nodos registrados ({nodes.length})
            <InfoTip text="core/ sondea /_bifrost/health cada 30 s. Si un nodo supera 120 s sin responder, pasa a «Sin respuesta» y sus claves quedan protegidas en estado «Sin servicio». El token rota cada 24 h con 5 min de gracia." />
          </h2>
        </div>

        {loading && nodes.length === 0 ? (
          <p className="field-hint">Cargando estado de nodos de salida…</p>
        ) : nodes.length === 0 ? (
          <div className="empty-state">
            <div className="empty-icon" aria-hidden="true">
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none">
                <circle cx="12" cy="5" r="2.5" stroke="currentColor" strokeWidth="2" />
                <circle cx="5" cy="18" r="2.5" stroke="currentColor" strokeWidth="2" />
                <circle cx="19" cy="18" r="2.5" stroke="currentColor" strokeWidth="2" />
                <path
                  d="M10.8 7.2L6.3 15.6M13.2 7.2l4.5 8.4M7.5 18h9"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                />
              </svg>
            </div>
            <h3 style={{ fontSize: '1.06rem' }}>Sin nodos de salida configurados</h3>
            <p className="field-hint" style={{ maxWidth: 500 }}>
              Actualmente el tráfico sale directamente desde la IP de este servidor. Vincula VMs
              ligeras por Tailscale o TLS para aislar una IP por cuenta gratuita.
            </p>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => setAddModalOpen(true)}
            >
              Vincular primer nodo
            </button>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {nodes.map((node) => {
              const linkedKeys = assignedKeysByNode[node.id] ?? [];
              const keysCount = node.assignedKeysCount ?? linkedKeys.length;
              const elapsed = formatHeartbeatElapsed(node.lastSeenAt);

              return (
                <div key={node.id} className="provider-section" style={{ gap: 10 }}>
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: 12,
                      flexWrap: 'wrap',
                    }}
                  >
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 8,
                        flexWrap: 'wrap',
                        minWidth: 0,
                      }}
                    >
                      <strong style={{ fontSize: '0.96rem', color: 'var(--fg)' }}>
                        {node.name}
                      </strong>
                      <span className={`status-badge ${node.status}`}>
                        <span
                          className={`status-dot ${
                            node.status === 'online'
                              ? 'ok'
                              : node.status === 'unresponsive'
                                ? 'err'
                                : 'offline'
                          }`}
                        />
                        {nodeStatusLabel(node.status)}
                      </span>
                      {node.status === 'unresponsive' ? (
                        <InfoTip
                          label={`Alerta de caída en ${node.name}`}
                          text="Más de 120 segundos sin respuesta al heartbeat. Las claves asignadas a este nodo están temporalmente marcadas sin servicio hasta que recupere conexión."
                        />
                      ) : null}
                      {node.mode === 'tailscale' ? (
                        <span className="meta-tag verified">Tailscale</span>
                      ) : (
                        <span className="status-badge rate_limited">IP pública TLS</span>
                      )}
                      <code className="key-prefix-pill">{node.endpoint}</code>
                      <span className="meta-tag accent">
                        {keysCount} {keysCount === 1 ? 'clave' : 'claves'}
                      </span>
                    </div>

                    <div
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 6,
                        flexWrap: 'wrap',
                      }}
                    >
                      <button
                        type="button"
                        className="btn btn-secondary btn-sm"
                        disabled={testingId === node.id}
                        onClick={() => void handleTestNode(node)}
                      >
                        {testingId === node.id ? 'Probando…' : 'Probar'}
                      </button>
                      {node.updateAvailable === true ? (
                        <button
                          type="button"
                          className="btn btn-primary btn-sm"
                          disabled={updatingId === node.id}
                          onClick={() => void handleUpdateNode(node)}
                        >
                          {updatingId === node.id ? 'Actualizando…' : 'Actualizar nodo'}
                        </button>
                      ) : node.updateAvailable === false ? (
                        <span className="meta-tag verified">Al día</span>
                      ) : (
                        <button
                          type="button"
                          className="btn btn-secondary btn-sm"
                          disabled={updatingId === node.id}
                          onClick={() => void handleUpdateNode(node)}
                          title="Versión del nodo no reportada aún"
                        >
                          {updatingId === node.id ? 'Actualizando…' : 'Actualizar nodo'}
                        </button>
                      )}
                      <button
                        type="button"
                        className="btn btn-secondary btn-sm"
                        disabled={rotatingId === node.id}
                        onClick={() => void handleRotateToken(node)}
                      >
                        {rotatingId === node.id ? 'Rotando…' : 'Rotar token'}
                      </button>
                      <button
                        type="button"
                        className="btn btn-danger btn-sm"
                        onClick={() => setNodeToDelete(node)}
                      >
                        Quitar
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
                      fontSize: '0.8rem',
                      color: 'var(--sub)',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
                      <span>
                        Heartbeat:{' '}
                        <strong style={{ color: 'var(--fg)' }}>
                          {formatDateTime(node.lastSeenAt, 'Sin señal aún')}
                        </strong>
                        {elapsed ? ` (${elapsed})` : ''}
                      </span>
                      <span>
                        Rotación token:{' '}
                        <strong style={{ color: 'var(--fg)' }}>
                          {formatDateTime(node.lastRotatedAt, 'Inicial')}
                        </strong>
                      </span>
                    </div>
                    {testResults[node.id] ? (
                      <span
                        className="mono"
                        style={{
                          fontSize: '0.76rem',
                          color: testResults[node.id].ok ? 'var(--ok)' : 'var(--err)',
                        }}
                      >
                        {testResults[node.id].ok
                          ? `En línea · ${testResults[node.id].latencyMs ?? 0} ms`
                          : testResults[node.id].error || 'Sin respuesta'}
                      </span>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* HU-11 & HU-11b Modal: Add Exit Node */}
      {addModalOpen ? (
        <div
          className="modal-backdrop"
          role="dialog"
          aria-modal="true"
          aria-labelledby="add-node-modal-title"
          onClick={() => {
            if (!creating) setAddModalOpen(false);
          }}
        >
          <div
            className="modal-card"
            style={{ maxWidth: 590 }}
            onClick={(e) => e.stopPropagation()}
          >
            <h2 id="add-node-modal-title" className="card-title" style={{ fontSize: '1.2rem' }}>
              Agregar nodo de salida
            </h2>
            <p className="field-hint" style={{ fontSize: '0.9rem' }}>
              Registra una VM remota para enrutar tráfico TLS de extremo a extremo sin revelar tus
              credenciales al nodo.
            </p>

            {formError ? (
              <div className="alert alert-error" role="alert">
                <span>{formError}</span>
              </div>
            ) : null}

            <form onSubmit={handleCreateNode} className="form-stack">
              <div className="field">
                <span className="field-label">Modo de transporte de red</span>
                <div className="mode-selector-grid">
                  <button
                    type="button"
                    className={`mode-option-card${mode === 'tailscale' ? ' selected' : ''}`}
                    onClick={() => setMode('tailscale')}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <strong style={{ color: 'var(--fg)', fontSize: '0.92rem' }}>Tailscale</strong>
                      <span className="meta-tag verified">Recomendado</span>
                    </div>
                    <span className="field-hint" style={{ fontSize: '0.8rem' }}>
                      Se enlaza solo a <code className="mono">100.x.y.z</code> sobre WireGuard sin
                      exponer ningún puerto público a internet.
                    </span>
                  </button>

                  <button
                    type="button"
                    className={`mode-option-card${mode === 'public_ip' ? ' selected' : ''}`}
                    onClick={() => setMode('public_ip')}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <strong style={{ color: 'var(--fg)', fontSize: '0.92rem' }}>
                        IP pública + TLS
                      </strong>
                    </div>
                    <span className="field-hint" style={{ fontSize: '0.8rem' }}>
                      Para VMs sin red malla. Escucha sobre HTTPS autenticado con token rotativo.
                    </span>
                  </button>
                </div>
              </div>

              {/* HU-11b Explicit Public Port Exposure Warning Banner */}
              {mode === 'public_ip' ? (
                <div className="alert alert-warning" role="alert">
                  <div>
                    <div style={{ fontWeight: 700, marginBottom: 4 }}>
                      Advertencia de exposición de puerto público y TLS obligatorio
                    </div>
                    <p style={{ fontSize: '0.84rem' }}>
                      Al usar <strong>IP pública</strong>, el puerto del agente quedará alcanzable en
                      internet. Asegúrate de mantener TLS habilitado en el nodo y restringir el
                      firewall (UFW / Security Group) únicamente a la IP de salida de tu servidor
                      central Bifrost.
                    </p>
                  </div>
                </div>
              ) : null}

              <div className="field">
                <label htmlFor="node-name-input" className="field-label">
                  Nombre del nodo
                </label>
                <input
                  id="node-name-input"
                  type="text"
                  className="input"
                  placeholder="ej. Nodo Helsinki #1"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  disabled={creating}
                />
              </div>

              <div className="field">
                <label htmlFor="node-endpoint-input" className="field-label">
                  {mode === 'tailscale'
                    ? 'IP / Hostname Tailscale y puerto'
                    : 'IP pública / Dominio TLS y puerto'}
                </label>
                <input
                  id="node-endpoint-input"
                  type="text"
                  className="input mono"
                  placeholder={
                    mode === 'tailscale' ? '100.84.12.9:9443' : '203.0.113.40:9443'
                  }
                  value={endpoint}
                  onChange={(e) => setEndpoint(e.target.value)}
                  disabled={creating}
                />
              </div>

              <div className="modal-actions">
                <button
                  type="button"
                  className="btn btn-secondary"
                  disabled={creating}
                  onClick={() => setAddModalOpen(false)}
                >
                  Cancelar
                </button>
                <button type="submit" className="btn btn-primary" disabled={creating}>
                  {creating ? 'Generando token…' : 'Registrar nodo y obtener comando'}
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}

      {/* HU-11 One-Time Install Command Modal */}
      {createdResult ? (
        <div
          className="modal-backdrop"
          role="dialog"
          aria-modal="true"
          aria-labelledby="install-node-cmd-title"
        >
          <div
            className="modal-card"
            style={{ maxWidth: 640 }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="gate-badge" style={{ alignSelf: 'flex-start', marginBottom: 0 }}>
              Nodo registrado · Instalación única
            </div>
            <h2 id="install-node-cmd-title" className="card-title" style={{ fontSize: '1.2rem' }}>
              Comando de instalación para «{createdResult.node.name}»
            </h2>

            <div className="alert alert-warning" role="alert">
              <span>
                <strong>Guarda o ejecuta este comando ahora.</strong> Por seguridad, el{' '}
                <code className="mono">nodeToken</code> completo solo se muestra esta única vez y en
                la base de datos únicamente se conserva su hash SHA-256.
              </span>
            </div>

            <div
              style={{
                background: 'var(--bg)',
                color: 'var(--fg)',
                border: '1px solid var(--line)',
                borderRadius: 9,
                padding: '14px 16px',
                display: 'flex',
                flexDirection: 'column',
                gap: 12,
              }}
            >
              <pre
                className="mono"
                style={{
                  margin: 0,
                  fontSize: '0.83rem',
                  lineHeight: 1.55,
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-all',
                }}
              >
                {createdResult.installCommand}
              </pre>
              <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
                {createdResult.rawToken ? (
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    onClick={() => copyToClipboard(createdResult.rawToken, setCopiedToken)}
                  >
                    {copiedToken ? '✓ Token copiado' : 'Copiar solo token'}
                  </button>
                ) : null}
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  onClick={() =>
                    copyToClipboard(createdResult.installCommand, setCopiedCommand)
                  }
                >
                  {copiedCommand ? '✓ Comando copiado' : 'Copiar comando'}
                </button>
              </div>
            </div>

            <div className="modal-actions">
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => setCreatedResult(null)}
              >
                Ya copié el comando, cerrar
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {/* HU-13 Modal: Confirm Node Removal listing keys left without service */}
      {nodeToDelete ? (
        <div
          className="modal-backdrop"
          role="dialog"
          aria-modal="true"
          aria-labelledby="delete-node-modal-title"
          onClick={() => {
            if (!deleting) setNodeToDelete(null);
          }}
        >
          <div
            className="modal-card"
            style={{ maxWidth: 560 }}
            onClick={(e) => e.stopPropagation()}
          >
            <h2
              id="delete-node-modal-title"
              className="card-title"
              style={{ color: 'var(--err)' }}
            >
              Confirmar retiro del nodo «{nodeToDelete.name}»
            </h2>

            {keysAffectedOnDelete.length > 0 || (nodeToDelete.assignedKeysCount ?? 0) > 0 ? (
              <>
                <p style={{ color: 'var(--sub)', fontSize: '0.93rem' }}>
                  Al quitar este nodo (<code className="mono">{nodeToDelete.endpoint}</code>),{' '}
                  <strong>
                    {Math.max(keysAffectedOnDelete.length, nodeToDelete.assignedKeysCount ?? 0)}
                  </strong>{' '}
                  {Math.max(keysAffectedOnDelete.length, nodeToDelete.assignedKeysCount ?? 0) === 1
                    ? 'clave de proveedor pasará'
                    : 'claves de proveedor pasarán'}{' '}
                  a estado <code className="mono" style={{ color: 'var(--err)' }}>no_node</code>{' '}
                  (sin servicio) hasta que les asignes otro nodo o salida directa:
                </p>

                {keysAffectedOnDelete.length > 0 ? (
                  <ul className="affected-keys-list">
                    {keysAffectedOnDelete.map((item) => (
                      <li key={item.id}>
                        <strong>{item.providerName}</strong> — {item.label} (
                        <code className="mono">{formatLast4(item.last4)}</code>)
                      </li>
                    ))}
                  </ul>
                ) : null}
              </>
            ) : (
              <p style={{ color: 'var(--sub)', fontSize: '0.93rem' }}>
                Ninguna clave de proveedor está vinculada actualmente a{' '}
                <strong>{nodeToDelete.name}</strong> (0 claves quedarán sin servicio). ¿Deseas
                retirarlo de Bifrost?
              </p>
            )}

            {deleteModalError ? (
              <div className="alert alert-error" role="alert">
                <span>{deleteModalError}</span>
              </div>
            ) : null}

            <div className="modal-actions">
              <button
                type="button"
                className="btn btn-secondary"
                disabled={deleting}
                onClick={() => setNodeToDelete(null)}
              >
                Cancelar
              </button>
              <button
                type="button"
                className="btn btn-danger"
                disabled={deleting}
                onClick={handleConfirmDeleteNode}
              >
                {deleting ? 'Quitando nodo…' : 'Confirmar y quitar nodo'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
};
