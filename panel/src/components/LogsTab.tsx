import React, { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../api';
import type { SystemLogEntry } from '../types';
import { InfoTip } from './InfoTip';

const LOG_LEVEL_OPTIONS = [
  { value: '', label: 'Todos los niveles' },
  { value: 'info', label: 'Info' },
  { value: 'warn', label: 'Advertencia (warn)' },
  { value: 'error', label: 'Error' },
];

const LOG_CATEGORY_OPTIONS = [
  { value: '', label: 'Todas las categorías' },
  { value: 'failover', label: 'Failover de claves' },
  { value: 'stream_resume', label: 'Reanudación SSE (stream_resume)' },
  { value: 'node', label: 'Nodos de salida' },
  { value: 'sync', label: 'Sincronización modelos' },
  { value: 'auth', label: 'Autenticación' },
  { value: 'backup', label: 'Respaldos' },
  { value: 'system', label: 'Sistema' },
];

function formatUtcTimestamp(ts: number | string): string {
  let date: Date;
  if (typeof ts === 'number' && Number.isFinite(ts)) {
    const ms = ts < 1_000_000_000_000 ? ts * 1000 : ts;
    date = new Date(ms);
  } else {
    const parsed = Date.parse(String(ts));
    date = Number.isNaN(parsed) ? new Date() : new Date(parsed);
  }
  return date.toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
}

export const LogsTab: React.FC = () => {
  const [level, setLevel] = useState('');
  const [category, setCategory] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [appliedQuery, setAppliedQuery] = useState('');

  const [logs, setLogs] = useState<SystemLogEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [expandedMetaId, setExpandedMetaId] = useState<number | string | null>(null);

  const fetchLogs = useCallback(async () => {
    setLoading(true);
    setErrorMessage(null);
    try {
      const res = await api.getSystemLogs({
        level: level || undefined,
        category: category || undefined,
        q: appliedQuery || undefined,
        limit: 100,
      });
      setLogs(res.logs);
      setTotal(res.total);
    } catch (err) {
      setErrorMessage(
        err instanceof ApiError
          ? err.message
          : 'No fue posible consultar los registros del sistema.'
      );
    } finally {
      setLoading(false);
    }
  }, [level, category, appliedQuery]);

  useEffect(() => {
    void fetchLogs();
  }, [fetchLogs]);

  function handleSearchSubmit(e: React.FormEvent) {
    e.preventDefault();
    setAppliedQuery(searchInput.trim());
  }

  return (
    <>
      <header className="page-header">
        <div>
          <h1 className="page-title">Logs del sistema y Failover</h1>
          <p className="page-subtitle">
            Auditoría cronológica en UTC de rotación por <code className="mono">429</code>,
            reanudación de streams cortados, caídas de nodos y eventos internos sin exponer
            secretos.
          </p>
        </div>
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          disabled={loading}
          onClick={() => void fetchLogs()}
        >
          {loading ? 'Actualizando…' : 'Refrescar logs'}
        </button>
      </header>

      {errorMessage ? (
        <div className="alert alert-error" role="alert">
          <span>{errorMessage}</span>
        </div>
      ) : null}

      {/* Filter Bar */}
      <section className="card" style={{ padding: '20px 24px' }} aria-label="Filtros de auditoría">
        <form
          onSubmit={handleSearchSubmit}
          style={{
            display: 'flex',
            alignItems: 'flex-end',
            gap: 14,
            flexWrap: 'wrap',
          }}
        >
          <div className="field" style={{ flex: '1 1 160px', minWidth: 0 }}>
            <label htmlFor="log-level-select" className="field-label">
              Nivel
            </label>
            <select
              id="log-level-select"
              className="input"
              value={level}
              onChange={(e) => setLevel(e.target.value)}
            >
              {LOG_LEVEL_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>

          <div className="field" style={{ flex: '1 1 200px', minWidth: 0 }}>
            <label htmlFor="log-category-select" className="field-label">
              Categoría
              <InfoTip text="Filtra por eventos de failover entre cuentas, reanudación automática de SSE (stream_resume), nodos o sincronización." />
            </label>
            <select
              id="log-category-select"
              className="input"
              value={category}
              onChange={(e) => setCategory(e.target.value)}
            >
              {LOG_CATEGORY_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>

          <div className="field" style={{ flex: '2 1 220px', minWidth: 0 }}>
            <label htmlFor="log-search-input" className="field-label">
              Búsqueda por texto
            </label>
            <input
              id="log-search-input"
              type="search"
              className="input"
              placeholder="Buscar proveedor, nodo, código HTTP o mensaje…"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
            />
          </div>

          <div style={{ display: 'flex', gap: 8 }}>
            <button type="submit" className="btn btn-primary">
              Filtrar
            </button>
            {level || category || appliedQuery ? (
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => {
                  setLevel('');
                  setCategory('');
                  setSearchInput('');
                  setAppliedQuery('');
                }}
              >
                Limpiar
              </button>
            ) : null}
          </div>
        </form>
      </section>

      {/* UTC Audit Table */}
      <section className="card" aria-labelledby="logs-audit-heading">
        <div className="card-header">
          <h2 id="logs-audit-heading" className="card-title">
            Eventos registrados ({total})
          </h2>
        </div>

        {loading && logs.length === 0 ? (
          <p className="field-hint">Cargando eventos del sistema…</p>
        ) : logs.length === 0 ? (
          <div className="empty-state">
            <h3 style={{ fontSize: '1.05rem' }}>Sin registros para los filtros seleccionados</h3>
            <p className="field-hint" style={{ maxWidth: 460 }}>
              Cuando ocurran failovers automáticos, reanudaciones de streaming o cambios en nodos,
              aparecerán registrados aquí con marca de tiempo UTC.
            </p>
          </div>
        ) : (
          <div className="table-wrap">
            <table className="bf-table">
              <thead>
                <tr>
                  <th>Fecha / Hora (UTC)</th>
                  <th>Nivel</th>
                  <th>Categoría</th>
                  <th>Mensaje</th>
                  <th style={{ textAlign: 'right' }}>Contexto</th>
                </tr>
              </thead>
              <tbody>
                {logs.map((entry) => {
                  const hasMeta =
                    entry.meta && Object.keys(entry.meta).length > 0;
                  const isExpanded = expandedMetaId === entry.id;

                  return (
                    <React.Fragment key={entry.id}>
                      <tr>
                        <td style={{ whiteSpace: 'nowrap' }}>
                          <code className="mono" style={{ fontSize: '0.8rem', color: 'var(--sub)' }}>
                            {formatUtcTimestamp(entry.createdAt)}
                          </code>
                        </td>
                        <td>
                          <span className={`log-badge ${entry.level}`}>{entry.level}</span>
                        </td>
                        <td>
                          <code className="key-prefix-pill">{entry.category}</code>
                        </td>
                        <td style={{ color: 'var(--fg)', fontWeight: 500 }}>{entry.message}</td>
                        <td style={{ textAlign: 'right' }}>
                          {hasMeta ? (
                            <button
                              type="button"
                              className="btn btn-ghost btn-sm"
                              onClick={() =>
                                setExpandedMetaId(isExpanded ? null : entry.id)
                              }
                            >
                              {isExpanded ? 'Ocultar JSON' : 'Ver detalle'}
                            </button>
                          ) : (
                            <span className="field-hint">—</span>
                          )}
                        </td>
                      </tr>
                      {hasMeta && isExpanded ? (
                        <tr>
                          <td colSpan={5} style={{ background: 'var(--surface-muted)' }}>
                            <pre
                              className="mono"
                              style={{
                                margin: 0,
                                fontSize: '0.78rem',
                                color: 'var(--fg)',
                                whiteSpace: 'pre-wrap',
                                wordBreak: 'break-all',
                              }}
                            >
                              {JSON.stringify(entry.meta, null, 2)}
                            </pre>
                          </td>
                        </tr>
                      ) : null}
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
};
