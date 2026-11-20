import React, { useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../api';
import type { PlaygroundChatTurn, ProviderModelItem, ReasoningEffort } from '../types';
import { InfoTip } from './InfoTip';

export const PlaygroundTab: React.FC = () => {
  const [models, setModels] = useState<ProviderModelItem[]>([]);
  const [modelsLoading, setModelsLoading] = useState(true);

  // Configuration Panel State
  const [selectedModel, setSelectedModel] = useState('');
  const [reasoningEffort, setReasoningEffort] = useState<ReasoningEffort>('none');
  const [temperature, setTemperature] = useState(0.7);
  const [maxTokens, setMaxTokens] = useState(2048);
  const [systemPrompt, setSystemPrompt] = useState(
    'Eres un asistente técnico claro, conciso y preciso.'
  );

  // Chat Multi-Turn State
  const [turns, setTurns] = useState<PlaygroundChatTurn[]>([]);
  const [promptInput, setPromptInput] = useState('');
  const [streamingContent, setStreamingContent] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [chatError, setChatError] = useState<string | null>(null);
  const [paramsOpen, setParamsOpen] = useState<boolean>(() =>
    typeof window !== 'undefined' ? window.innerWidth > 940 : true
  );

  const scrollBoxRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    setModelsLoading(true);
    api
      .getModels()
      .then((list) => {
        if (cancelled) return;
        const active = list.filter((m) => m.active !== false);
        setModels(active);
        if (active.length > 0) {
          setSelectedModel((prev) =>
            prev && active.some((m) => m.fullId === prev) ? prev : active[0].fullId
          );
        }
      })
      .catch(() => {
        if (!cancelled) setModels([]);
      })
      .finally(() => {
        if (!cancelled) setModelsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (scrollBoxRef.current) {
      scrollBoxRef.current.scrollTop = scrollBoxRef.current.scrollHeight;
    }
  }, [turns, streamingContent]);

  const currentModelObj = models.find((m) => m.fullId === selectedModel) ?? null;
  const supportsReasoning = Boolean(currentModelObj?.capabilities?.reasoning);

  async function handleSendMessage(e: React.FormEvent) {
    e.preventDefault();
    setChatError(null);

    const cleanPrompt = promptInput.trim();
    if (!cleanPrompt || !selectedModel || sending) return;

    const userTurn: PlaygroundChatTurn = {
      id: `u-${Date.now()}`,
      role: 'user',
      content: cleanPrompt,
      createdAt: Date.now(),
    };

    const nextHistory = [...turns, userTurn];
    setTurns(nextHistory);
    setPromptInput('');
    setSending(true);
    setStreamingContent('');

    const apiMessages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [];
    if (systemPrompt.trim().length > 0) {
      apiMessages.push({ role: 'system', content: systemPrompt.trim() });
    }
    for (const t of nextHistory) {
      apiMessages.push({ role: t.role, content: t.content });
    }

    try {
      const response = await api.sendPlaygroundChat(
        {
          model: selectedModel,
          messages: apiMessages,
          temperature,
          maxTokens,
          reasoningEffort: supportsReasoning ? reasoningEffort : 'none',
        },
        (partial) => {
          setStreamingContent(partial);
        }
      );

      const assistantTurn: PlaygroundChatTurn = {
        id: `a-${Date.now()}`,
        role: 'assistant',
        content: response.content || '(Respuesta vacía)',
        reasoningContent: response.reasoningContent,
        model: response.model ?? selectedModel,
        ttftMs: response.ttftMs,
        tokensPerSec: response.tokensPerSec,
        usage: response.usage,
        createdAt: Date.now(),
      };
      setTurns((prev) => [...prev, assistantTurn]);
    } catch (err) {
      setChatError(
        err instanceof ApiError
          ? err.message
          : 'Error al completar la petición en el Playground.'
      );
    } finally {
      setStreamingContent(null);
      setSending(false);
    }
  }

  return (
    <>
      <header className="page-header">
        <div>
          <h1 className="page-title">Playground interactivo</h1>
          <p className="page-subtitle">
            Prueba tus modelos en vivo sobre el pipeline real de Bifrost (con failover, nodos y
            medición instantánea de <code className="mono">TTFT</code> y{' '}
            <code className="mono">tok/s</code>).
          </p>
        </div>

        {turns.length > 0 ? (
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            disabled={sending}
            onClick={() => {
              setTurns([]);
              setChatError(null);
            }}
          >
            Limpiar conversación
          </button>
        ) : null}
      </header>

      <div className="playground-layout">
        {/* Left Sidebar / Mobile Collapsible Accordion: Configuration Panel */}
        <aside className="card playground-params-card" aria-label="Parámetros del Playground">
          <div className="playground-params-header">
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
              <h2 className="card-title" style={{ fontSize: '1.02rem' }}>
                Parámetros de ejecución
              </h2>
              <InfoTip text="Cada mensaje enviado aquí descuenta tokens de tu cuota diaria real y alimenta las métricas de latencia y velocidad." />
            </div>

            <button
              type="button"
              className="btn btn-secondary btn-sm playground-params-toggle-btn"
              aria-expanded={paramsOpen}
              onClick={() => setParamsOpen((prev) => !prev)}
            >
              {paramsOpen ? 'Ocultar ajustes' : 'Ajustes'}
            </button>
          </div>

          {!paramsOpen && selectedModel ? (
            <div
              className="playground-params-toggle-btn"
              style={{ marginTop: 8, gap: 6, flexWrap: 'wrap', alignItems: 'center' }}
            >
              <code className="key-prefix-pill" style={{ fontSize: '0.76rem' }}>
                {selectedModel}
              </code>
              <span className="meta-tag">T={temperature.toFixed(1)}</span>
            </div>
          ) : null}

          <div className={`form-stack playground-params-body${paramsOpen ? '' : ' collapsed'}`}>
            <div className="field">
              <label htmlFor="pg-model-select" className="field-label">
                Modelo (<code className="mono">provider/model</code>)
              </label>
              {modelsLoading ? (
                <span className="field-hint">Cargando modelos…</span>
              ) : models.length === 0 ? (
                <span className="field-error">
                  No hay modelos activos disponibles para tu cuenta todavía.
                </span>
              ) : (
                <select
                  id="pg-model-select"
                  className="input"
                  value={selectedModel}
                  onChange={(e) => setSelectedModel(e.target.value)}
                  disabled={sending}
                >
                  {models.map((m) => (
                    <option key={m.fullId} value={m.fullId}>
                      {m.name} ({m.fullId})
                    </option>
                  ))}
                </select>
              )}
            </div>

            <div className="field">
              <label htmlFor="pg-reasoning-select" className="field-label">
                Esfuerzo de razonamiento
                <InfoTip
                  text={
                    supportsReasoning
                      ? 'Este modelo declara soporte de razonamiento: ajusta cuánto presupuesto dedica a pensar.'
                      : 'Solo surte efecto en modelos con capacidad de reasoning habilitada.'
                  }
                />
              </label>
              <select
                id="pg-reasoning-select"
                className="input"
                value={supportsReasoning ? reasoningEffort : 'none'}
                disabled={sending || !supportsReasoning}
                onChange={(e) => setReasoningEffort(e.target.value as ReasoningEffort)}
              >
                <option value="none">Desactivado / Estándar</option>
                <option value="low">Bajo (low)</option>
                <option value="medium">Medio (medium)</option>
                <option value="high">Alto (high)</option>
              </select>
            </div>

            <div className="field">
              <label
                htmlFor="pg-temp-range"
                className="field-label"
                style={{ justifyContent: 'space-between' }}
              >
                <span>Temperatura</span>
                <code className="mono" style={{ color: 'var(--accent)' }}>
                  {temperature.toFixed(1)}
                </code>
              </label>
              <input
                id="pg-temp-range"
                type="range"
                min={0}
                max={2}
                step={0.1}
                value={temperature}
                disabled={sending}
                onChange={(e) => setTemperature(Number(e.target.value))}
                style={{ accentColor: 'var(--accent)', cursor: 'pointer' }}
              />
            </div>

            <div className="field">
              <label htmlFor="pg-max-tokens" className="field-label">
                Máximo de tokens de salida
              </label>
              <input
                id="pg-max-tokens"
                type="number"
                min={64}
                max={32768}
                step={64}
                className="input mono"
                value={maxTokens}
                disabled={sending}
                onChange={(e) =>
                  setMaxTokens(Math.max(64, Number(e.target.value) || 1024))
                }
              />
            </div>

            <div className="field">
              <label htmlFor="pg-system-prompt" className="field-label">
                Instrucción de sistema (System Prompt)
              </label>
              <textarea
                id="pg-system-prompt"
                rows={4}
                className="input"
                style={{ resize: 'vertical' }}
                value={systemPrompt}
                disabled={sending}
                onChange={(e) => setSystemPrompt(e.target.value)}
              />
            </div>
          </div>
        </aside>

        {/* Right Main Area: Multi-Turn Chat & Live Telemetry */}
        <section className="playground-chat-card" aria-label="Conversación del Playground">
          <div ref={scrollBoxRef} className="chat-messages-scroll">
            {turns.length === 0 && streamingContent === null ? (
              <div className="empty-state" style={{ margin: 'auto 0' }}>
                <h3 style={{ fontSize: '1.08rem' }}>Listo para conversar</h3>
                <p className="field-hint" style={{ maxWidth: 430 }}>
                  Envía un mensaje abajo para medir en tiempo real el{' '}
                  <code className="mono">TTFT (ms)</code>, los{' '}
                  <code className="mono">tokens/s</code> y el desglose de tokens de cada respuesta.
                </p>
              </div>
            ) : (
              <>
                {turns.map((turn) => (
                  <div key={turn.id} className={`chat-bubble ${turn.role}`}>
                    {turn.reasoningContent ? (
                      <details
                        style={{
                          background: 'var(--panel)',
                          border: '1px solid var(--line)',
                          borderRadius: 8,
                          padding: '8px 12px',
                          fontSize: '0.82rem',
                          color: 'var(--sub)',
                        }}
                      >
                        <summary style={{ cursor: 'pointer', fontWeight: 700 }}>
                          Cadena de razonamiento
                        </summary>
                        <p style={{ marginTop: 6, whiteSpace: 'pre-wrap' }}>
                          {turn.reasoningContent}
                        </p>
                      </details>
                    ) : null}

                    <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                      {turn.content}
                    </div>

                    {turn.role === 'assistant' ? (
                      <div className="chat-telemetry-bar">
                        {turn.model ? <span>{turn.model}</span> : null}
                        {turn.ttftMs !== null && turn.ttftMs !== undefined ? (
                          <span className="meta-tag accent">
                            TTFT: {Math.round(turn.ttftMs)} ms
                          </span>
                        ) : null}
                        {turn.tokensPerSec !== null && turn.tokensPerSec !== undefined ? (
                          <span className="meta-tag verified">
                            {turn.tokensPerSec.toFixed(1)} tok/s
                          </span>
                        ) : null}
                        {turn.usage ? (
                          <span>
                            prompt: {turn.usage.promptTokens} · completion:{' '}
                            {turn.usage.completionTokens}
                            {turn.usage.reasoningTokens > 0
                              ? ` · reasoning: ${turn.usage.reasoningTokens}`
                              : ''}
                          </span>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                ))}

                {streamingContent !== null ? (
                  <div className="chat-bubble assistant">
                    <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                      {streamingContent || 'Generando respuesta…'}
                    </div>
                  </div>
                ) : null}
              </>
            )}

            {chatError ? (
              <div className="alert alert-error" role="alert">
                <span>{chatError}</span>
              </div>
            ) : null}
          </div>

          <form onSubmit={handleSendMessage} className="chat-composer">
            <textarea
              rows={2}
              className="input"
              style={{ flex: 1, resize: 'none' }}
              placeholder={
                models.length === 0
                  ? 'Instala y detecta al menos un modelo para enviar mensajes…'
                  : 'Escribe tu prompt aquí (Enter + botón Enviar)…'
              }
              value={promptInput}
              disabled={sending || models.length === 0}
              onChange={(e) => setPromptInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                  void handleSendMessage(e);
                }
              }}
            />
            <button
              type="submit"
              className="btn btn-primary"
              disabled={sending || models.length === 0 || !promptInput.trim()}
            >
              {sending ? 'Generando…' : 'Enviar'}
            </button>
          </form>
        </section>
      </div>
    </>
  );
};
