import React, { useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../api';
import { copyTextToClipboard } from '../clipboard';
import type { InternalApiKey } from '../types';
import { InfoTip } from './InfoTip';

interface ApiKeysTabProps {
  keys: InternalApiKey[];
  loading: boolean;
  autoFocusCreate?: boolean;
  onAutoFocusConsumed?: () => void;
  onKeysChanged: () => Promise<void>;
}

const KEY_NAME_PRESETS = ['Zed Editor', 'Cursor', 'Continue.dev', 'CLI local'];

function formatTimestamp(ts: number | null | undefined): string {
  if (ts === null || ts === undefined || !Number.isFinite(ts) || ts <= 0) {
    return 'Nunca usada';
  }
  const ms = ts < 1_000_000_000_000 ? ts * 1000 : ts;
  return new Intl.DateTimeFormat('es-ES', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(ms));
}

function formatCreatedDate(ts: number): string {
  if (!Number.isFinite(ts) || ts <= 0) {
    return '—';
  }
  const ms = ts < 1_000_000_000_000 ? ts * 1000 : ts;
  return new Intl.DateTimeFormat('es-ES', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(ms));
}

function formatKeyPrefix(prefix: string): string {
  if (!prefix) return 'sk-bf-••••';
  if (prefix.includes('•') || prefix.endsWith('...')) return prefix;
  return `${prefix}••••`;
}

export const ApiKeysTab: React.FC<ApiKeysTabProps> = ({
  keys,
  loading,
  autoFocusCreate,
  onAutoFocusConsumed,
  onKeysChanged,
}) => {
  const [name, setName] = useState('');
  const [expiresInDays, setExpiresInDays] = useState<string>('never');
  const [creating, setCreating] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // One-time secret reveal state (kept strictly in transient React state, never persisted)
  const [revealedKey, setRevealedKey] = useState<{ name: string; rawKey: string } | null>(null);
  const [copiedRawKey, setCopiedRawKey] = useState(false);
  const [copiedBaseUrl, setCopiedBaseUrl] = useState(false);
  const [copiedSnippet, setCopiedSnippet] = useState(false);

  // Revocation confirmation modal state
  const [confirmRevokeTarget, setConfirmRevokeTarget] = useState<InternalApiKey | null>(null);
  const [revokingId, setRevokingId] = useState<string | null>(null);

  const nameInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (autoFocusCreate) {
      nameInputRef.current?.focus();
      onAutoFocusConsumed?.();
    }
  }, [autoFocusCreate, onAutoFocusConsumed]);

  const baseUrl = `${window.location.origin}/v1`;
  const curlSnippet = `curl ${baseUrl}/models \\\n  -H "Authorization: Bearer sk-bf-tu_clave_aqui"`;

  async function handleCreateKey(e: React.FormEvent) {
    e.preventDefault();
    setErrorMessage(null);

    const cleanName = name.trim();
    if (!cleanName) {
      setErrorMessage('Asigna un nombre descriptivo para identificar dónde usarás esta clave.');
      nameInputRef.current?.focus();
      return;
    }

    setCreating(true);
    try {
      const daysNum = expiresInDays === 'never' ? null : Number(expiresInDays);
      const result = await api.createKey(
        cleanName,
        daysNum !== null && Number.isFinite(daysNum) && daysNum > 0
          ? { expiresInDays: daysNum }
          : undefined
      );
      setRevealedKey({
        name: result.key.name || cleanName,
        rawKey: result.rawKey,
      });
      setCopiedRawKey(false);
      setName('');
      setExpiresInDays('never');
      await onKeysChanged();
    } catch (err) {
      if (err instanceof ApiError) {
        setErrorMessage(err.message);
      } else {
        setErrorMessage('No se pudo generar la clave API interna.');
      }
    } finally {
      setCreating(false);
    }
  }

  const [revokeModalError, setRevokeModalError] = useState<string | null>(null);

  useEffect(() => {
    if (!confirmRevokeTarget) return;
    setRevokeModalError(null);
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !revokingId) {
        setConfirmRevokeTarget(null);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [confirmRevokeTarget, revokingId]);

  async function handleConfirmRevoke() {
    if (!confirmRevokeTarget) return;
    setRevokeModalError(null);
    setErrorMessage(null);
    setRevokingId(confirmRevokeTarget.id);

    try {
      await api.revokeKey(confirmRevokeTarget.id);
      setConfirmRevokeTarget(null);
      await onKeysChanged();
    } catch (err) {
      if (err instanceof ApiError) {
        setRevokeModalError(err.message);
      } else {
        setRevokeModalError('Error al revocar la clave seleccionada.');
      }
    } finally {
      setRevokingId(null);
    }
  }

  async function copyText(value: string, setter: (v: boolean) => void) {
    const ok = await copyTextToClipboard(value);
    if (ok) {
      setter(true);
      window.setTimeout(() => setter(false), 2400);
    } else {
      setter(false);
    }
  }

  return (
    <>
      <header className="page-header">
        <div>
          <h1 className="page-title">API Keys internas (sk-bf-…)</h1>
          <p className="page-subtitle">
            Emite llaves independientes para cada editor, agente o script sin exponer las claves
            maestras de tus proveedores externos.
          </p>
        </div>
      </header>

      {errorMessage ? (
        <div className="alert alert-error" role="alert">
          <span>{errorMessage}</span>
        </div>
      ) : null}

      {/* One-time reveal banner right after POST /api/keys */}
      {revealedKey ? (
        <section className="reveal-banner" role="region" aria-label="Clave recién generada">
          <div
            style={{
              display: 'flex',
              alignItems: 'flex-start',
              justifyContent: 'space-between',
              gap: 16,
              flexWrap: 'wrap',
            }}
          >
            <div>
              <h2 className="card-title" style={{ marginBottom: 4 }}>
                Nueva clave creada para «{revealedKey.name}»
              </h2>
              <p style={{ color: 'var(--partial)', fontWeight: 600, fontSize: '0.88rem' }}>
                Guarda esta clave ahora. Por seguridad no se volverá a mostrar completa.
              </p>
            </div>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => setRevealedKey(null)}
            >
              Entendido, cerrar aviso
            </button>
          </div>

          <div className="reveal-key-row">
            <code className="reveal-key-value">{revealedKey.rawKey}</code>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={() => copyText(revealedKey.rawKey, setCopiedRawKey)}
            >
              {copiedRawKey ? '✓ Clave copiada' : 'Copiar clave'}
            </button>
          </div>
        </section>
      ) : null}

      {/* Create Key Form Card */}
      <section className="card" aria-labelledby="create-key-heading">
        <div className="card-header">
          <h2 id="create-key-heading" className="card-title">
            Crear nueva clave interna
            <InfoTip text="core/ almacena únicamente el hash criptográfico y el prefijo de la llave. Si revocas una llave, deja de funcionar al instante." />
          </h2>
        </div>

        <form onSubmit={handleCreateKey} className="form-stack">
          <div className="field">
            <label htmlFor="key-name-input" className="field-label">
              Nombre descriptivo de la aplicación o entorno
            </label>
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
              <input
                ref={nameInputRef}
                id="key-name-input"
                type="text"
                className="input"
                style={{ flex: '1 1 260px' }}
                placeholder='ej. "Zed Editor" o "Cursor"'
                maxLength={80}
                value={name}
                onChange={(e) => setName(e.target.value)}
                disabled={creating}
              />
              <select
                aria-label="Expiración de la clave"
                className="input"
                style={{ flex: '0 0 auto', width: 'auto', minWidth: 168 }}
                value={expiresInDays}
                onChange={(e) => setExpiresInDays(e.target.value)}
                disabled={creating}
              >
                <option value="never">Sin vencimiento</option>
                <option value="7">Expira en 7 días</option>
                <option value="30">Expira en 30 días</option>
                <option value="90">Expira en 90 días</option>
                <option value="365">Expira en 1 año</option>
              </select>
              <button type="submit" className="btn btn-primary" disabled={creating}>
                {creating ? 'Generando…' : 'Generar API key'}
              </button>
            </div>
          </div>

          <div className="preset-chips" aria-label="Sugerencias rápidas de nombre">
            <span className="field-hint" style={{ marginRight: 4 }}>
              Sugerencias:
            </span>
            {KEY_NAME_PRESETS.map((preset) => (
              <button
                key={preset}
                type="button"
                className="preset-chip"
                onClick={() => {
                  setName(preset);
                  nameInputRef.current?.focus();
                }}
              >
                {preset}
              </button>
            ))}
          </div>
        </form>
      </section>

      {/* Active Keys Table Card */}
      <section className="card" aria-labelledby="active-keys-heading">
        <div className="card-header">
          <h2 id="active-keys-heading" className="card-title">
            Llaves activas ({keys.length})
          </h2>
        </div>

        {loading && keys.length === 0 ? (
          <p className="field-hint">Cargando llaves registradas…</p>
        ) : keys.length === 0 ? (
          <div className="empty-state">
            <div className="empty-icon" aria-hidden="true">
              <svg width="26" height="26" viewBox="0 0 24 24" fill="none">
                <path
                  d="M15 7.5a4.5 4.5 0 1 1-4.18 6.17L7 17.5H4.5V15l1.5-1.5h1.5V12l1.83-1.83A4.5 4.5 0 0 1 15 7.5Z"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
                <circle cx="15.5" cy="7" r="1" fill="currentColor" />
              </svg>
            </div>
            <h3 style={{ fontSize: '1.05rem' }}>Aún no tienes API keys internas</h3>
            <p className="field-hint" style={{ maxWidth: 440 }}>
              Crea tu primera llave arriba (por ejemplo para Zed Editor o Cursor) para empezar a
              enviar peticiones al endpoint <code className="mono">/v1</code>.
            </p>
          </div>
        ) : (
          <div className="table-wrap">
            <table className="bf-table">
              <thead>
                <tr>
                  <th>Nombre</th>
                  <th>Prefijo</th>
                  <th>Uso</th>
                  <th>Creada</th>
                  <th>Vencimiento</th>
                  <th>Último uso</th>
                  <th style={{ textAlign: 'right' }}>Acción</th>
                </tr>
              </thead>
              <tbody>
                {keys.map((item) => {
                  const expMs =
                    typeof item.expiresAt === 'number' && item.expiresAt > 0
                      ? item.expiresAt < 1_000_000_000_000
                        ? item.expiresAt * 1000
                        : item.expiresAt
                      : null;
                  const isExpired = expMs !== null && expMs <= Date.now();

                  return (
                    <tr key={item.id}>
                      <td style={{ fontWeight: 700 }}>{item.name}</td>
                      <td>
                        <code className="key-prefix-pill">{formatKeyPrefix(item.keyPrefix)}</code>
                      </td>
                      <td className="mono" style={{ fontSize: '0.78rem', color: 'var(--sub)' }}>
                        {typeof item.usedTokens === 'number' || typeof item.requestsCount === 'number' ? (
                          <span>
                            {(item.usedTokens ?? 0).toLocaleString('es-ES')} tok ·{' '}
                            {(item.requestsCount ?? 0).toLocaleString('es-ES')} pet.
                          </span>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td style={{ color: 'var(--sub)' }}>{formatCreatedDate(item.createdAt)}</td>
                      <td>
                        {expMs === null ? (
                          <span className="field-hint">Sin vencimiento</span>
                        ) : isExpired ? (
                          <span className="status-badge error">
                            Expirada · {formatCreatedDate(expMs)}
                          </span>
                        ) : (
                          <span className="mono" style={{ fontSize: '0.8rem', color: 'var(--sub)' }}>
                            {formatCreatedDate(expMs)}
                          </span>
                        )}
                      </td>
                      <td style={{ color: item.lastUsedAt ? 'var(--fg)' : 'var(--sub)' }}>
                        {formatTimestamp(item.lastUsedAt)}
                      </td>
                      <td style={{ textAlign: 'right' }}>
                        <button
                          type="button"
                          className="btn btn-danger btn-sm"
                          onClick={() => setConfirmRevokeTarget(item)}
                        >
                          Revocar
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

      {/* OpenAI Base URL & Quick Integration Snippet */}
      <section className="card" aria-labelledby="integration-heading">
        <div className="card-header">
          <h2 id="integration-heading" className="card-title">
            Conexión rápida con clientes OpenAI
            <InfoTip text="Cualquier herramienta compatible con la especificación OpenAI Chat Completions funciona apuntando a esta URL base." />
          </h2>
        </div>

        <div className="snippet-box" style={{ marginBottom: 16 }}>
          <div>
            <div className="field-hint" style={{ marginBottom: 6 }}>
              OpenAI Base URL
            </div>
            <code className="snippet-url">{baseUrl}</code>
          </div>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={() => copyText(baseUrl, setCopiedBaseUrl)}
          >
            {copiedBaseUrl ? '✓ Copiado' : 'Copiar Base URL'}
          </button>
        </div>

        <div
          style={{
            background: 'var(--bg)',
            color: 'var(--fg)',
            border: '1px solid var(--line)',
            borderRadius: 9,
            padding: '14px 16px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 14,
            flexWrap: 'wrap',
          }}
        >
          <pre
            className="mono"
            style={{
              margin: 0,
              fontSize: '0.84rem',
              lineHeight: 1.55,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-all',
            }}
          >
            {curlSnippet}
          </pre>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={() => copyText(curlSnippet, setCopiedSnippet)}
          >
            {copiedSnippet ? '✓ Comando copiado' : 'Copiar ejemplo'}
          </button>
        </div>
      </section>

      {/* Revoke Confirmation Modal */}
      {confirmRevokeTarget ? (
        <div
          className="modal-backdrop"
          role="dialog"
          aria-modal="true"
          aria-labelledby="revoke-modal-title"
          onClick={() => {
            if (!revokingId) setConfirmRevokeTarget(null);
          }}
        >
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <h2 id="revoke-modal-title" className="card-title" style={{ color: 'var(--err)' }}>
              Confirmar revocación de clave
            </h2>
            <p style={{ color: 'var(--sub)', fontSize: '0.94rem' }}>
              ¿Seguro que deseas revocar la clave{' '}
              <strong style={{ color: 'var(--fg)' }}>{confirmRevokeTarget.name}</strong> (
              <code className="mono">{formatKeyPrefix(confirmRevokeTarget.keyPrefix)}</code>)? Las
              aplicaciones que la utilicen perderán acceso de inmediato y esta acción no se puede
              deshacer.
            </p>
            {revokeModalError ? (
              <div className="alert alert-error" role="alert">
                <span>{revokeModalError}</span>
              </div>
            ) : null}
            <div className="modal-actions">
              <button
                type="button"
                className="btn btn-secondary"
                disabled={Boolean(revokingId)}
                onClick={() => setConfirmRevokeTarget(null)}
              >
                Cancelar
              </button>
              <button
                type="button"
                className="btn btn-danger"
                disabled={Boolean(revokingId)}
                onClick={handleConfirmRevoke}
              >
                {revokingId ? 'Revocando…' : 'Sí, revocar clave'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
};
