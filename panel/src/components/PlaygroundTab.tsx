import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../api';
import type {
  AppendPlaygroundMessageInput,
  PlaygroundChatMessage,
  PlaygroundChatSummary,
  PlaygroundChatTurn,
  ProviderModelItem,
  ReasoningEffort,
} from '../types';
import { InfoTip } from './InfoTip';

function renderInlineMarkdown(text: string): React.ReactNode[] {
  const tokens = text.split(/(`[^`]+`|\*\*[^*]+\*\*)/g);
  return tokens.map((tok, i) => {
    if (tok.startsWith('`') && tok.endsWith('`') && tok.length > 2) {
      return (
        <code
          key={i}
          className="mono"
          style={{
            background: 'var(--surface-2)',
            padding: '1px 5px',
            borderRadius: 4,
            fontSize: '0.88em',
          }}
        >
          {tok.slice(1, -1)}
        </code>
      );
    }
    if (tok.startsWith('**') && tok.endsWith('**') && tok.length > 4) {
      return <strong key={i}>{tok.slice(2, -2)}</strong>;
    }
    return <React.Fragment key={i}>{tok}</React.Fragment>;
  });
}

const SimpleMarkdown: React.FC<{ text: string }> = ({ text }) => {
  const parts = text.split(/(```[\s\S]*?```)/g);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, wordBreak: 'break-word' }}>
      {parts.map((part, idx) => {
        if (part.startsWith('```') && part.endsWith('```') && part.length >= 6) {
          const inner = part.slice(3, -3).replace(/^[a-zA-Z0-9_-]+\n/, '');
          return (
            <pre
              key={idx}
              className="mono"
              style={{
                margin: 0,
                padding: '9px 11px',
                borderRadius: 7,
                background: 'var(--panel)',
                border: '1px solid var(--line)',
                overflowX: 'auto',
                fontSize: '0.8rem',
                lineHeight: 1.45,
              }}
            >
              <code>{inner}</code>
            </pre>
          );
        }
        const lines = part.split('\n');
        return (
          <div key={idx} style={{ whiteSpace: 'pre-wrap' }}>
            {lines.map((line, lineIdx) => (
              <React.Fragment key={lineIdx}>
                {renderInlineMarkdown(line)}
                {lineIdx < lines.length - 1 ? '\n' : null}
              </React.Fragment>
            ))}
          </div>
        );
      })}
    </div>
  );
};

function formatRelativeTime(ts: number): string {
  if (!ts || !Number.isFinite(ts) || ts <= 0) return '';
  const ms = ts < 1_000_000_000_000 ? ts * 1000 : ts;
  const diffSec = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (diffSec < 45) return 'ahora';
  if (diffSec < 3600) return `hace ${Math.floor(diffSec / 60)} min`;
  if (diffSec < 86400) return `hace ${Math.floor(diffSec / 3600)} h`;
  const days = Math.floor(diffSec / 86400);
  if (days === 1) return 'ayer';
  if (days < 7) return `hace ${days} d`;
  return new Intl.DateTimeFormat('es-ES', { day: '2-digit', month: 'short' }).format(new Date(ms));
}

function mapStoredMessageToTurn(msg: PlaygroundChatMessage): PlaygroundChatTurn {
  const m = msg.metrics;
  const hasUsage =
    m &&
    (typeof m.promptTokens === 'number' ||
      typeof m.completionTokens === 'number' ||
      typeof m.reasoningTokens === 'number');
  const promptTokens = m?.promptTokens ?? 0;
  const completionTokens = m?.completionTokens ?? 0;
  const reasoningTokens = m?.reasoningTokens ?? 0;

  return {
    id: msg.id,
    role: msg.role === 'assistant' ? 'assistant' : 'user',
    content: msg.content,
    reasoningContent: msg.reasoningContent ?? undefined,
    model: msg.modelFullId ?? undefined,
    ttftMs: m?.ttftMs ?? null,
    tokensPerSec: m?.tokensPerSec ?? null,
    usage: hasUsage
      ? {
          promptTokens,
          completionTokens,
          reasoningTokens,
          totalTokens: promptTokens + completionTokens + reasoningTokens,
        }
      : undefined,
    createdAt: msg.createdAt,
  };
}

function upsertChatSummary(
  list: PlaygroundChatSummary[],
  updated: PlaygroundChatSummary
): PlaygroundChatSummary[] {
  const rest = list.filter((c) => c.id !== updated.id);
  return [updated, ...rest].sort((a, b) => b.updatedAt - a.updatedAt);
}

export const PlaygroundTab: React.FC = () => {
  const [models, setModels] = useState<ProviderModelItem[]>([]);
  const [modelsLoading, setModelsLoading] = useState(true);

  // HU-43 Encrypted Per-Account Chat History State
  const [chats, setChats] = useState<PlaygroundChatSummary[]>([]);
  const [chatsLoading, setChatsLoading] = useState(true);
  const [activeChatId, setActiveChatId] = useState<string | null>(null);
  const [loadingChatId, setLoadingChatId] = useState<string | null>(null);
  const [creatingChat, setCreatingChat] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState<boolean>(() =>
    typeof window !== 'undefined' ? window.innerWidth > 940 : true
  );

  // Rename / Delete / Clear confirmation states
  const [renamingChatId, setRenamingChatId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [savingRename, setSavingRename] = useState(false);
  const [chatToDelete, setChatToDelete] = useState<PlaygroundChatSummary | null>(null);
  const [clearModalOpen, setClearModalOpen] = useState(false);
  const [modalBusy, setModalBusy] = useState(false);
  const [modalError, setModalError] = useState<string | null>(null);

  // Configuration Panel State
  const [selectedModel, setSelectedModel] = useState('');
  const [reasoningEffort, setReasoningEffort] = useState<ReasoningEffort>('none');
  const [temperature, setTemperature] = useState(0.7);
  const [maxTokensInput, setMaxTokensInput] = useState('2048');
  const [systemPrompt, setSystemPrompt] = useState(
    'Eres un asistente técnico claro, conciso y preciso.'
  );
  const [paramsOpen, setParamsOpen] = useState(false);

  // Chat Multi-Turn State
  const [turns, setTurns] = useState<PlaygroundChatTurn[]>([]);
  const [promptInput, setPromptInput] = useState('');
  const [streamingContent, setStreamingContent] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [chatError, setChatError] = useState<string | null>(null);

  const scrollBoxRef = useRef<HTMLDivElement | null>(null);
  const reqIdRef = useRef(0);
  const loadChatReqIdRef = useRef(0);
  const isMountedRef = useRef(true);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      reqIdRef.current += 1;
      loadChatReqIdRef.current += 1;
    };
  }, []);

  useEffect(() => {
    if (!chatToDelete && !clearModalOpen) return;
    setModalError(null);
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !modalBusy) {
        setChatToDelete(null);
        setClearModalOpen(false);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [chatToDelete, clearModalOpen, modalBusy]);

  const loadChatDetail = useCallback(
    async (chatId: string, activeModels?: ProviderModelItem[]) => {
      const reqId = ++loadChatReqIdRef.current;
      setLoadingChatId(chatId);
      setChatError(null);
      setHistoryError(null);
      try {
        const detail = await api.getPlaygroundChat(chatId);
        if (!isMountedRef.current || reqId !== loadChatReqIdRef.current) return;
        setActiveChatId(detail.chat.id);
        setChats((prev) => upsertChatSummary(prev, detail.chat));
        setTurns(
          detail.messages
            .filter((m) => m.role === 'user' || m.role === 'assistant')
            .map(mapStoredMessageToTurn)
        );
        const list = activeModels ?? models;
        if (detail.chat.modelFullId && list.some((m) => m.fullId === detail.chat.modelFullId)) {
          setSelectedModel(detail.chat.modelFullId);
        }
        if (typeof window !== 'undefined' && window.innerWidth <= 940) {
          setHistoryOpen(false);
        }
      } catch (err) {
        if (!isMountedRef.current || reqId !== loadChatReqIdRef.current) return;
        setHistoryError(
          err instanceof ApiError ? err.message : 'No se pudo cargar la conversación seleccionada.'
        );
      } finally {
        if (isMountedRef.current && reqId === loadChatReqIdRef.current) {
          setLoadingChatId(null);
        }
      }
    },
    [models]
  );

  useEffect(() => {
    let cancelled = false;
    setModelsLoading(true);
    setChatsLoading(true);

    Promise.allSettled([api.getModels(), api.getPlaygroundChats()]).then(
      async ([modelsRes, chatsRes]) => {
        if (cancelled) return;
        const activeModels =
          modelsRes.status === 'fulfilled'
            ? modelsRes.value.filter((m) => m.active !== false && !m.disabledByAdmin)
            : [];
        setModels(activeModels);
        if (activeModels.length > 0) {
          setSelectedModel((prev) =>
            prev && activeModels.some((m) => m.fullId === prev) ? prev : activeModels[0].fullId
          );
        }
        setModelsLoading(false);

        if (chatsRes.status === 'fulfilled') {
          const sorted = [...chatsRes.value].sort((a, b) => b.updatedAt - a.updatedAt);
          setChats(sorted);
          setChatsLoading(false);
          if (sorted.length > 0) {
            await loadChatDetail(sorted[0].id, activeModels);
          }
        } else {
          setChats([]);
          setChatsLoading(false);
        }
      }
    );

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (scrollBoxRef.current) {
      scrollBoxRef.current.scrollTop = scrollBoxRef.current.scrollHeight;
    }
  }, [turns, streamingContent]);

  const currentModelObj = models.find((m) => m.fullId === selectedModel) ?? null;
  const supportsReasoning = Boolean(currentModelObj?.capabilities?.reasoning);
  const activeChat = chats.find((c) => c.id === activeChatId) ?? null;

  function parseClampedMaxTokens(raw: string): number {
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed)) return 2048;
    return Math.max(64, Math.min(32768, parsed));
  }

  async function handleCreateNewChat() {
    if (sending || creatingChat) return;
    setCreatingChat(true);
    setHistoryError(null);
    setChatError(null);
    try {
      const created = await api.createPlaygroundChat({
        modelFullId: selectedModel || null,
      });
      if (!isMountedRef.current) return;
      setChats((prev) => upsertChatSummary(prev, created));
      setActiveChatId(created.id);
      setTurns([]);
      setPromptInput('');
      setRenamingChatId(null);
      if (typeof window !== 'undefined' && window.innerWidth <= 940) {
        setHistoryOpen(false);
      }
    } catch (err) {
      if (!isMountedRef.current) return;
      setHistoryError(
        err instanceof ApiError ? err.message : 'No se pudo crear una nueva conversación.'
      );
    } finally {
      if (isMountedRef.current) setCreatingChat(false);
    }
  }

  function startRename(chat: PlaygroundChatSummary, e: React.MouseEvent) {
    e.stopPropagation();
    setRenamingChatId(chat.id);
    setRenameDraft(chat.title);
    setHistoryError(null);
  }

  async function handleSaveRename(chatId: string) {
    const clean = renameDraft.trim();
    if (!clean) {
      setRenamingChatId(null);
      return;
    }
    setSavingRename(true);
    setHistoryError(null);
    try {
      const updated = await api.updatePlaygroundChat(chatId, { title: clean });
      if (!isMountedRef.current) return;
      setChats((prev) => upsertChatSummary(prev, updated));
      setRenamingChatId(null);
    } catch (err) {
      if (!isMountedRef.current) return;
      setHistoryError(
        err instanceof ApiError ? err.message : 'No se pudo renombrar la conversación.'
      );
    } finally {
      if (isMountedRef.current) setSavingRename(false);
    }
  }

  async function handleConfirmDeleteChat() {
    if (!chatToDelete) return;
    setModalBusy(true);
    setModalError(null);
    try {
      await api.deletePlaygroundChat(chatToDelete.id);
      if (!isMountedRef.current) return;
      const deletedId = chatToDelete.id;
      const remaining = chats.filter((c) => c.id !== deletedId);
      setChats(remaining);
      setChatToDelete(null);
      if (activeChatId === deletedId) {
        if (remaining.length > 0) {
          void loadChatDetail(remaining[0].id);
        } else {
          setActiveChatId(null);
          setTurns([]);
        }
      }
    } catch (err) {
      if (!isMountedRef.current) return;
      setModalError(
        err instanceof ApiError ? err.message : 'No se pudo eliminar la conversación.'
      );
    } finally {
      if (isMountedRef.current) setModalBusy(false);
    }
  }

  async function handleConfirmClearHistory() {
    setModalBusy(true);
    setModalError(null);
    try {
      await api.clearPlaygroundChats();
      if (!isMountedRef.current) return;
      setChats([]);
      setActiveChatId(null);
      setTurns([]);
      setClearModalOpen(false);
    } catch (err) {
      if (!isMountedRef.current) return;
      setModalError(
        err instanceof ApiError ? err.message : 'No se pudo limpiar el historial de chats.'
      );
    } finally {
      if (isMountedRef.current) setModalBusy(false);
    }
  }

  async function handleSendMessage(e: React.FormEvent) {
    e.preventDefault();
    setChatError(null);
    setHistoryError(null);

    const cleanPrompt = promptInput.trim();
    if (!cleanPrompt || !selectedModel || sending) return;

    const effectiveMaxTokens = parseClampedMaxTokens(maxTokensInput);
    setMaxTokensInput(String(effectiveMaxTokens));

    const reqId = ++reqIdRef.current;
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
      let targetChatId = activeChatId;
      if (!targetChatId) {
        try {
          const created = await api.createPlaygroundChat({ modelFullId: selectedModel });
          if (isMountedRef.current && reqId === reqIdRef.current) {
            targetChatId = created.id;
            setActiveChatId(created.id);
            setChats((prev) => upsertChatSummary(prev, created));
          }
        } catch {
          // Allow chatting even if history persistence endpoint is temporarily unavailable
        }
      }

      const response = await api.sendPlaygroundChat(
        {
          model: selectedModel,
          messages: apiMessages,
          temperature,
          maxTokens: effectiveMaxTokens,
          reasoningEffort: supportsReasoning ? reasoningEffort : 'none',
        },
        (partial) => {
          if (isMountedRef.current && reqId === reqIdRef.current) {
            setStreamingContent(partial);
          }
        }
      );

      if (!isMountedRef.current || reqId !== reqIdRef.current) return;

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

      if (targetChatId) {
        const toPersist: AppendPlaygroundMessageInput[] = [
          {
            role: 'user',
            content: cleanPrompt,
            modelFullId: selectedModel,
          },
          {
            role: 'assistant',
            content: assistantTurn.content,
            reasoningContent: assistantTurn.reasoningContent ?? null,
            modelFullId: assistantTurn.model ?? selectedModel,
            metrics: {
              ttftMs: assistantTurn.ttftMs ?? null,
              tokensPerSec: assistantTurn.tokensPerSec ?? null,
              promptTokens: assistantTurn.usage?.promptTokens ?? null,
              completionTokens: assistantTurn.usage?.completionTokens ?? null,
              reasoningTokens: assistantTurn.usage?.reasoningTokens ?? null,
            },
          },
        ];
        try {
          const persisted = await api.appendPlaygroundMessage(targetChatId, {
            messages: toPersist,
          });
          if (isMountedRef.current && persisted?.chat) {
            setChats((prev) => upsertChatSummary(prev, persisted.chat));
          }
        } catch (persistErr) {
          if (isMountedRef.current) {
            setHistoryError(
              persistErr instanceof ApiError
                ? `Respuesta recibida, pero no se pudo guardar en historial: ${persistErr.message}`
                : 'Respuesta recibida, pero no se pudo guardar en el historial cifrado.'
            );
          }
        }
      }
    } catch (err) {
      if (!isMountedRef.current || reqId !== reqIdRef.current) return;
      setTurns((prev) => prev.filter((t) => t.id !== userTurn.id));
      setPromptInput(cleanPrompt);
      setChatError(
        err instanceof ApiError
          ? err.message
          : 'Error al completar la petición en el Playground.'
      );
    } finally {
      if (isMountedRef.current && reqId === reqIdRef.current) {
        setStreamingContent(null);
        setSending(false);
      }
    }
  }

  return (
    <>
      <header className="page-header">
        <div>
          <h1 className="page-title">Playground interactivo</h1>
          <p className="page-subtitle">
            Prueba tus modelos en vivo con failover real, medición instantánea de{' '}
            <code className="mono">TTFT</code> / <code className="mono">tok/s</code> e historial
            cifrado privado por cuenta.
          </p>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <button
            type="button"
            className="btn btn-secondary btn-sm pg-history-mobile-toggle"
            aria-expanded={historyOpen}
            onClick={() => setHistoryOpen((prev) => !prev)}
          >
            Historial ({chats.length})
          </button>
          <button
            type="button"
            className="btn btn-primary btn-sm"
            disabled={sending || creatingChat}
            onClick={() => void handleCreateNewChat()}
          >
            {creatingChat ? 'Creando…' : '+ Nuevo chat'}
          </button>
        </div>
      </header>

      <div className="pg-workspace-layout">
        {/* HU-43 Encrypted Per-Account Chat History Sidebar */}
        <aside
          className={`card pg-history-sidebar${historyOpen ? '' : ' collapsed'}`}
          aria-label="Historial de chats cifrados"
        >
          <div className="pg-history-header">
            <div style={{ display: 'flex', alignItems: 'center', gap: 7, minWidth: 0 }}>
              <strong style={{ fontSize: '0.92rem', color: 'var(--fg)' }}>Conversaciones</strong>
              <span className="nav-tab-pill">{chats.length}</span>
            </div>
            {chats.length > 0 ? (
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                style={{ fontSize: '0.75rem', padding: '2px 7px', color: 'var(--err)' }}
                disabled={sending}
                onClick={() => setClearModalOpen(true)}
                title="Borrar todo tu historial de conversaciones"
              >
                Limpiar historial
              </button>
            ) : null}
          </div>

          {historyError ? (
            <div className="alert alert-error" role="alert" style={{ padding: '8px 10px', fontSize: '0.78rem' }}>
              <span>{historyError}</span>
            </div>
          ) : null}

          <div className="pg-history-list">
            {chatsLoading ? (
              <p className="field-hint" style={{ padding: '8px 4px', fontSize: '0.8rem' }}>
                Descifrando tu historial privado…
              </p>
            ) : chats.length === 0 ? (
              <div className="pg-history-empty">
                <p className="field-hint" style={{ fontSize: '0.8rem' }}>
                  Aún no tienes conversaciones guardadas. Envía un mensaje o pulsa{' '}
                  <strong>+ Nuevo chat</strong>.
                </p>
              </div>
            ) : (
              chats.map((chat) => {
                const isActive = chat.id === activeChatId;
                const isRenaming = renamingChatId === chat.id;
                const isLoadingThis = loadingChatId === chat.id;

                return (
                  <div
                    key={chat.id}
                    className={`pg-chat-item${isActive ? ' active' : ''}`}
                    role="button"
                    tabIndex={0}
                    onClick={() => {
                      if (!isRenaming && !sending) {
                        void loadChatDetail(chat.id);
                      }
                    }}
                    onKeyDown={(e) => {
                      if (!isRenaming && !sending && (e.key === 'Enter' || e.key === ' ')) {
                        e.preventDefault();
                        void loadChatDetail(chat.id);
                      }
                    }}
                  >
                    {isRenaming ? (
                      <div
                        style={{ display: 'flex', flexDirection: 'column', gap: 6, width: '100%' }}
                        onClick={(e) => e.stopPropagation()}
                      >
                        <input
                          type="text"
                          className="input"
                          style={{ padding: '5px 8px', fontSize: '0.82rem' }}
                          value={renameDraft}
                          autoFocus
                          disabled={savingRename}
                          onChange={(e) => setRenameDraft(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              e.preventDefault();
                              void handleSaveRename(chat.id);
                            } else if (e.key === 'Escape') {
                              setRenamingChatId(null);
                            }
                          }}
                        />
                        <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                          <button
                            type="button"
                            className="btn btn-secondary btn-sm"
                            style={{ minHeight: 24, padding: '2px 8px', fontSize: '0.74rem' }}
                            disabled={savingRename}
                            onClick={() => setRenamingChatId(null)}
                          >
                            Cancelar
                          </button>
                          <button
                            type="button"
                            className="btn btn-primary btn-sm"
                            style={{ minHeight: 24, padding: '2px 8px', fontSize: '0.74rem' }}
                            disabled={savingRename || !renameDraft.trim()}
                            onClick={() => void handleSaveRename(chat.id)}
                          >
                            {savingRename ? '…' : 'Guardar'}
                          </button>
                        </div>
                      </div>
                    ) : (
                      <>
                        <div className="pg-chat-item-top">
                          <span className="pg-chat-title" title={chat.title}>
                            {isLoadingThis ? 'Cargando…' : chat.title}
                          </span>
                          <div className="pg-chat-actions" onClick={(e) => e.stopPropagation()}>
                            <button
                              type="button"
                              className="pg-chat-icon-btn"
                              aria-label={`Renombrar ${chat.title}`}
                              title="Renombrar conversación"
                              disabled={sending}
                              onClick={(e) => startRename(chat, e)}
                            >
                              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                                <path d="M12 20h9" strokeLinecap="round" />
                                <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" strokeLinejoin="round" />
                              </svg>
                            </button>
                            <button
                              type="button"
                              className="pg-chat-icon-btn danger"
                              aria-label={`Eliminar ${chat.title}`}
                              title="Eliminar conversación"
                              disabled={sending}
                              onClick={() => setChatToDelete(chat)}
                            >
                              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                                <path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6" strokeLinecap="round" strokeLinejoin="round" />
                              </svg>
                            </button>
                          </div>
                        </div>
                        <div className="pg-chat-meta">
                          <span className="mono pg-chat-model" title={chat.modelFullId ?? undefined}>
                            {chat.modelFullId ? chat.modelFullId.split('/').pop() : 'Sin modelo'}
                          </span>
                          <span>
                            {chat.messageCount} msg
                            {chat.updatedAt ? ` · ${formatRelativeTime(chat.updatedAt)}` : ''}
                          </span>
                        </div>
                      </>
                    )}
                  </div>
                );
              })
            )}
          </div>

          {/* Privacy & Encryption Notice (HU-43) */}
          <div className="pg-privacy-box" role="note" aria-label="Privacidad y cifrado del historial">
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 600, color: 'var(--fg)' }}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--ok)" strokeWidth="2.1" aria-hidden="true">
                <rect x="5" y="11" width="14" height="10" rx="2" />
                <path d="M8 11V7a4 4 0 0 1 8 0v4" strokeLinecap="round" />
              </svg>
              <span>Historial cifrado (AES-256-GCM)</span>
            </div>
            <p style={{ margin: 0, fontSize: '0.73rem', color: 'var(--sub)', lineHeight: 1.45 }}>
              Estrictamente privado por cuenta: ningún otro usuario ni administrador puede leer tus
              chats y quedan excluidos de los backups <code className="mono">.bifrost.enc</code>.
            </p>
          </div>
        </aside>

        {/* Right Main Area: Compact Controls Bar + Chat Stream */}
        <section className="playground-chat-card" aria-label="Conversación del Playground">
          {/* Top Compact Model & Parameters Strip */}
          <div className="pg-toolbar">
            <div className="pg-toolbar-row">
              <div style={{ flex: '1 1 220px', minWidth: 0 }}>
                {modelsLoading ? (
                  <span className="field-hint">Cargando modelos…</span>
                ) : models.length === 0 ? (
                  <span className="field-error" style={{ fontSize: '0.8rem' }}>
                    No hay modelos activos disponibles para tu cuenta todavía.
                  </span>
                ) : (
                  <select
                    id="pg-model-select"
                    aria-label="Modelo (provider/model)"
                    className="input"
                    style={{ padding: '6px 32px 6px 10px', fontSize: '0.83rem' }}
                    value={selectedModel}
                    onChange={(e) => {
                      const nextModel = e.target.value;
                      setSelectedModel(nextModel);
                      if (activeChatId) {
                        void api
                          .updatePlaygroundChat(activeChatId, { modelFullId: nextModel })
                          .then((updated) => {
                            if (isMountedRef.current) {
                              setChats((prev) => upsertChatSummary(prev, updated));
                            }
                          })
                          .catch(() => {
                            // non-blocking metadata sync
                          });
                      }
                    }}
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

              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <span className="meta-tag mono" title="Temperatura y tope de salida activos">
                  T={temperature.toFixed(1)} · {parseClampedMaxTokens(maxTokensInput)} tok
                </span>
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  aria-expanded={paramsOpen}
                  onClick={() => setParamsOpen((prev) => !prev)}
                >
                  {paramsOpen ? 'Ocultar parámetros' : 'Parámetros'}
                </button>
              </div>
            </div>

            {paramsOpen ? (
              <div className="pg-params-drawer">
                <div className="pg-params-grid">
                  <div
                    className="field"
                    style={!supportsReasoning ? { opacity: 0.56 } : undefined}
                  >
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
                      style={!supportsReasoning ? { cursor: 'not-allowed' } : undefined}
                      value={supportsReasoning ? reasoningEffort : 'none'}
                      disabled={sending || !supportsReasoning}
                      onChange={(e) => setReasoningEffort(e.target.value as ReasoningEffort)}
                    >
                      {!supportsReasoning ? (
                        <option value="none">No soportado por este modelo</option>
                      ) : (
                        <>
                          <option value="none">Desactivado / Estándar</option>
                          <option value="low">Bajo (low)</option>
                          <option value="medium">Medio (medium)</option>
                          <option value="high">Alto (high)</option>
                        </>
                      )}
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
                      style={{ accentColor: 'var(--accent)', cursor: 'pointer', marginTop: 6 }}
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
                      value={maxTokensInput}
                      disabled={sending}
                      onChange={(e) => setMaxTokensInput(e.target.value)}
                      onBlur={() => setMaxTokensInput(String(parseClampedMaxTokens(maxTokensInput)))}
                    />
                  </div>
                </div>

                <div className="field" style={{ marginTop: 10 }}>
                  <label htmlFor="pg-system-prompt" className="field-label">
                    Instrucción de sistema (System Prompt)
                  </label>
                  <textarea
                    id="pg-system-prompt"
                    rows={2}
                    className="input"
                    style={{ resize: 'vertical' }}
                    value={systemPrompt}
                    disabled={sending}
                    onChange={(e) => setSystemPrompt(e.target.value)}
                  />
                </div>
              </div>
            ) : null}
          </div>

          {activeChat ? (
            <div className="pg-active-chat-bar">
              <span
                style={{
                  fontSize: '0.82rem',
                  fontWeight: 600,
                  color: 'var(--fg)',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
                title={activeChat.title}
              >
                {activeChat.title}
              </span>
              <span className="field-hint" style={{ fontSize: '0.75rem', flexShrink: 0 }}>
                Guardado cifrado automáticamente
              </span>
            </div>
          ) : null}

          <div ref={scrollBoxRef} className="chat-messages-scroll">
            {loadingChatId ? (
              <div className="empty-state" style={{ margin: 'auto 0' }}>
                <div className="spinner" aria-hidden="true" />
                <p className="field-hint">Descifrando conversación…</p>
              </div>
            ) : turns.length === 0 && streamingContent === null ? (
              <div className="empty-state" style={{ margin: 'auto 0' }}>
                <h3 style={{ fontSize: '1.06rem' }}>Listo para conversar</h3>
                <p className="field-hint" style={{ maxWidth: 440 }}>
                  Envía un mensaje abajo para medir en tiempo real el{' '}
                  <code className="mono">TTFT (ms)</code>, los{' '}
                  <code className="mono">tokens/s</code> y guardar la conversación cifrada en tu
                  historial privado.
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

                    {turn.role === 'assistant' ? (
                      <SimpleMarkdown text={turn.content} />
                    ) : (
                      <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                        {turn.content}
                      </div>
                    )}

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
                  : 'Escribe tu prompt aquí (Ctrl+Enter o botón Enviar)…'
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

      {/* Confirm Delete Single Chat Modal */}
      {chatToDelete ? (
        <div
          className="modal-backdrop"
          role="dialog"
          aria-modal="true"
          aria-labelledby="delete-chat-modal-title"
          onClick={() => {
            if (!modalBusy) setChatToDelete(null);
          }}
        >
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <h2
              id="delete-chat-modal-title"
              className="card-title"
              style={{ color: 'var(--err)' }}
            >
              Eliminar conversación
            </h2>
            <p style={{ color: 'var(--sub)', fontSize: '0.92rem' }}>
              ¿Seguro que deseas eliminar permanentemente{' '}
              <strong style={{ color: 'var(--fg)' }}>«{chatToDelete.title}»</strong> (
              {chatToDelete.messageCount}{' '}
              {chatToDelete.messageCount === 1 ? 'mensaje' : 'mensajes'})? Esta acción no se puede
              deshacer.
            </p>
            {modalError ? (
              <div className="alert alert-error" role="alert">
                <span>{modalError}</span>
              </div>
            ) : null}
            <div className="modal-actions">
              <button
                type="button"
                className="btn btn-secondary"
                disabled={modalBusy}
                onClick={() => setChatToDelete(null)}
              >
                Cancelar
              </button>
              <button
                type="button"
                className="btn btn-danger"
                disabled={modalBusy}
                onClick={() => void handleConfirmDeleteChat()}
              >
                {modalBusy ? 'Eliminando…' : 'Sí, eliminar chat'}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {/* Confirm Clear All History Modal */}
      {clearModalOpen ? (
        <div
          className="modal-backdrop"
          role="dialog"
          aria-modal="true"
          aria-labelledby="clear-chats-modal-title"
          onClick={() => {
            if (!modalBusy) setClearModalOpen(false);
          }}
        >
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <h2
              id="clear-chats-modal-title"
              className="card-title"
              style={{ color: 'var(--err)' }}
            >
              Limpiar todo el historial del Playground
            </h2>
            <p style={{ color: 'var(--sub)', fontSize: '0.92rem' }}>
              Se eliminarán de forma irreversible tus{' '}
              <strong style={{ color: 'var(--fg)' }}>
                {chats.length} {chats.length === 1 ? 'conversación' : 'conversaciones'}
              </strong>{' '}
              cifradas del Playground asociadas a tu cuenta.
            </p>
            {modalError ? (
              <div className="alert alert-error" role="alert">
                <span>{modalError}</span>
              </div>
            ) : null}
            <div className="modal-actions">
              <button
                type="button"
                className="btn btn-secondary"
                disabled={modalBusy}
                onClick={() => setClearModalOpen(false)}
              >
                Cancelar
              </button>
              <button
                type="button"
                className="btn btn-danger"
                disabled={modalBusy}
                onClick={() => void handleConfirmClearHistory()}
              >
                {modalBusy ? 'Limpiando…' : 'Sí, borrar todo mi historial'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
};
