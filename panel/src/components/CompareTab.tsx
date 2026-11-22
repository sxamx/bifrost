import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { copyTextToClipboard } from '../clipboard';
import type { ModelSpeedEntry, ProviderModelItem } from '../types';
import { InfoTip } from './InfoTip';

interface CompareTabProps {
  onOpenModel?: (fullId: string) => void;
}

const COMPARE_SESSION_KEY = 'bf_compare_selected_ids';

function readStoredCompareIds(): string[] {
  try {
    const raw = sessionStorage.getItem(COMPARE_SESSION_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((x): x is string => typeof x === 'string' && x.length > 0).slice(0, 3)
      : [];
  } catch {
    return [];
  }
}

export const CompareTab: React.FC<CompareTabProps> = ({ onOpenModel }) => {
  const [models, setModels] = useState<ProviderModelItem[]>([]);
  const [speedByModel, setSpeedByModel] = useState<Record<string, ModelSpeedEntry>>({});
  const [loading, setLoading] = useState(true);

  const [selectedIds, setSelectedIds] = useState<string[]>(() => readStoredCompareIds());
  const [copiedId, setCopiedId] = useState<string | null>(null);

  useEffect(() => {
    try {
      if (selectedIds.length > 0) {
        sessionStorage.setItem(COMPARE_SESSION_KEY, JSON.stringify(selectedIds));
      } else {
        sessionStorage.removeItem(COMPARE_SESSION_KEY);
      }
    } catch {
      // Ignore storage errors
    }
  }, [selectedIds]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    Promise.allSettled([api.getModels(), api.getMetricsSpeed()])
      .then(([modelsRes, speedRes]) => {
        if (cancelled) return;

        const list =
          modelsRes.status === 'fulfilled'
            ? modelsRes.value.filter((m) => m.active !== false)
            : [];
        setModels(list);

        // Start with 1 model selected by default if models exist (HU-21)
        if (list.length > 0) {
          setSelectedIds((prev) => {
            const validPrev = prev.filter((id) => list.some((m) => m.fullId === id));
            return validPrev.length > 0 ? validPrev.slice(0, 3) : [list[0].fullId];
          });
        } else {
          setSelectedIds([]);
        }

        if (speedRes.status === 'fulfilled') {
          const map: Record<string, ModelSpeedEntry> = {};
          for (const item of speedRes.value.models) {
            map[item.modelFullId] = item;
          }
          setSpeedByModel(map);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const availableToAdd = useMemo(
    () => models.filter((m) => !selectedIds.includes(m.fullId)),
    [models, selectedIds]
  );

  function handleAddColumn() {
    if (selectedIds.length >= 3) return;
    const nextCandidate = availableToAdd[0] ?? models[0];
    if (!nextCandidate) return;
    setSelectedIds((prev) => [...prev, nextCandidate.fullId]);
  }

  function handleChangeColumnModel(colIndex: number, newFullId: string) {
    setSelectedIds((prev) => prev.map((id, idx) => (idx === colIndex ? newFullId : id)));
  }

  function handleRemoveColumn(colIndex: number) {
    setSelectedIds((prev) => prev.filter((_, idx) => idx !== colIndex));
  }

  async function handleCopyModelId(fullId: string) {
    const ok = await copyTextToClipboard(fullId);
    if (ok) {
      setCopiedId(fullId);
      window.setTimeout(() => setCopiedId(null), 2000);
    } else {
      setCopiedId(null);
    }
  }

  return (
    <>
      <header className="page-header">
        <div>
          <h1 className="page-title">Comparador de modelos</h1>
          <p className="page-subtitle">
            Contrasta lado a lado hasta 3 modelos permitidos: ventana de contexto, capacidades,
            modalidades y velocidad real medida en tu instancia.
          </p>
        </div>

        {models.length > 0 && selectedIds.length < 3 ? (
          <button
            type="button"
            className="btn btn-primary"
            onClick={handleAddColumn}
            disabled={models.length <= selectedIds.length && models.length < 2}
          >
            + Agregar modelo ({selectedIds.length}/3)
          </button>
        ) : null}
      </header>

      {loading ? (
        <section className="card">
          <p className="field-hint">Cargando catálogo de modelos permitidos…</p>
        </section>
      ) : models.length === 0 ? (
        <section className="card">
          <div className="empty-state">
            <h2 className="card-title">Sin modelos activos para comparar</h2>
            <p className="field-hint" style={{ maxWidth: 480 }}>
              Una vez que se detecten modelos en los proveedores conectados (y estén habilitados
              para tu cuenta), podrás comparar hasta 3 modelos en paralelo aquí.
            </p>
          </div>
        </section>
      ) : selectedIds.length === 0 ? (
        <section className="card">
          <div className="empty-state">
            <p className="field-hint">Ninguna columna activa.</p>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={() => setSelectedIds([models[0].fullId])}
            >
              Seleccionar primer modelo
            </button>
          </div>
        </section>
      ) : (
        <section className="compare-columns-grid" aria-label="Columnas de comparación de modelos">
          {selectedIds.map((fullId, colIdx) => {
            const model = models.find((m) => m.fullId === fullId) ?? models[0];
            const speed = speedByModel[model.fullId];
            const inputMods = model.modalities?.input ?? ['text'];
            const outputMods = model.modalities?.output ?? ['text'];

            return (
              <article key={`${colIdx}-${model.fullId}`} className="compare-col-card">
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 10,
                  }}
                >
                  <span className="meta-tag accent">Columna #{colIdx + 1}</span>
                  <button
                    type="button"
                    className="btn btn-danger btn-sm"
                    onClick={() => handleRemoveColumn(colIdx)}
                  >
                    Quitar
                  </button>
                </div>

                <div className="field">
                  <label
                    htmlFor={`compare-select-${colIdx}`}
                    className="field-label"
                    style={{ fontSize: '0.8rem' }}
                  >
                    Modelo seleccionado
                  </label>
                  <select
                    id={`compare-select-${colIdx}`}
                    className="input"
                    value={model.fullId}
                    onChange={(e) => handleChangeColumnModel(colIdx, e.target.value)}
                  >
                    {models.map((opt) => (
                      <option key={opt.fullId} value={opt.fullId}>
                        {opt.name} ({opt.fullId})
                      </option>
                    ))}
                  </select>
                </div>

                {/* HU-15 Copyable provider/model ID */}
                <div
                  style={{
                    background: 'var(--surface-muted)',
                    border: '1px solid var(--line)',
                    borderRadius: 12,
                    padding: '10px 12px',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 8,
                  }}
                >
                  <code
                    className="mono"
                    style={{
                      fontSize: '0.8rem',
                      fontWeight: 600,
                      color: 'var(--accent)',
                      wordBreak: 'break-all',
                    }}
                  >
                    {model.fullId}
                  </code>
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    onClick={() => void handleCopyModelId(model.fullId)}
                  >
                    {copiedId === model.fullId ? '✓ Copiado' : 'Copiar ID'}
                  </button>
                </div>

                <div className="compare-spec-list">
                  <div className="compare-spec-row">
                    <span className="compare-spec-label">Proveedor</span>
                    <code className="key-prefix-pill">{model.providerId}</code>
                  </div>

                  <div className="compare-spec-row">
                    <span className="compare-spec-label">Tarifa / Nivel</span>
                    {model.isFree !== false ? (
                      <span className="status-badge active">Gratis ($0 / $0)</span>
                    ) : (
                      <span className="meta-tag">
                        {model.pricing?.prompt !== undefined
                          ? `$${model.pricing.prompt} / $${model.pricing.completion ?? 0}`
                          : 'Estándar'}
                      </span>
                    )}
                  </div>

                  <div className="compare-spec-row">
                    <span className="compare-spec-label">Ventana de contexto</span>
                    <strong className="mono">
                      {typeof model.contextLength === 'number' && model.contextLength > 0
                        ? `${model.contextLength.toLocaleString('es-ES')} tok`
                        : 'No declarada'}
                    </strong>
                  </div>

                  <div className="compare-spec-row">
                    <span className="compare-spec-label">Salida máxima</span>
                    <strong className="mono">
                      {typeof model.maxOutput === 'number' && model.maxOutput > 0
                        ? `${model.maxOutput.toLocaleString('es-ES')} tok`
                        : 'No declarada'}
                    </strong>
                  </div>

                  <div className="compare-spec-row">
                    <span className="compare-spec-label">Modalidades</span>
                    <span className="mono" style={{ fontSize: '0.8rem' }}>
                      {inputMods.join(', ')} → {outputMods.join(', ')}
                    </span>
                  </div>

                  <div className="compare-spec-row">
                    <span className="compare-spec-label">Herramientas (Tools)</span>
                    <span
                      className={`status-badge ${
                        model.capabilities?.tools ? 'active' : 'offline'
                      }`}
                    >
                      {model.capabilities?.tools ? 'Sí' : 'No'}
                    </span>
                  </div>

                  <div className="compare-spec-row">
                    <span className="compare-spec-label">Razonamiento</span>
                    <span
                      className={`status-badge ${
                        model.capabilities?.reasoning ? 'active' : 'offline'
                      }`}
                    >
                      {model.capabilities?.reasoning ? 'Sí' : 'No'}
                    </span>
                  </div>

                  <div className="compare-spec-row">
                    <span className="compare-spec-label">Structured Output (JSON)</span>
                    <span
                      className={`status-badge ${
                        model.capabilities?.structuredOutput ? 'active' : 'offline'
                      }`}
                    >
                      {model.capabilities?.structuredOutput ? 'Sí' : 'No'}
                    </span>
                  </div>

                  <div className="compare-spec-row">
                    <span className="compare-spec-label">
                      TTFT mediana (P50){' '}
                      <InfoTip text="Mediana real de Time to First Token registrada por tu propio router." />
                    </span>
                    <strong className="mono">
                      {speed ? `${Math.round(speed.ttftMs.p50)} ms` : 'Sin tráfico aún'}
                    </strong>
                  </div>

                  <div className="compare-spec-row">
                    <span className="compare-spec-label">Velocidad (P50)</span>
                    <strong className="mono" style={{ color: 'var(--accent)' }}>
                      {speed
                        ? `${speed.tokensPerSec.p50.toFixed(1)} tok/s`
                        : 'Sin tráfico aún'}
                    </strong>
                  </div>
                </div>

                {onOpenModel ? (
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    style={{ width: '100%', justifyContent: 'center', marginTop: 4 }}
                    onClick={() => onOpenModel(model.fullId)}
                  >
                    Ver ficha y benchmarks →
                  </button>
                ) : null}
              </article>
            );
          })}
        </section>
      )}
    </>
  );
};
