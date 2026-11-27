import type { DatabaseSync } from 'node:sqlite';
import { redactSecretsInText, writeSystemLog } from './db.js';
import type { UpstreamTlsOptions } from './nodes.js';
import {
  MAX_PLAYGROUND_MESSAGE_CONTENT_LENGTH,
  MAX_PLAYGROUND_MESSAGE_REASONING_LENGTH,
  PlaygroundHistoryError,
  appendPlaygroundMessages,
  assertPlaygroundChatOwned,
  markChatGenerating,
  updatePlaygroundChat,
  type PlaygroundChatSettings,
  type PlaygroundMessageMetrics,
} from './playground-history.js';
import {
  computeTokensPerSec,
  executeChatCompletions,
  toSafeNonNegInt,
  type DrainingRegistry,
} from './router.js';

const MAX_PLAYGROUND_SSE_BUFFER_CHARS = 1_048_576;
const PLAYGROUND_TRUNCATION_NOTICE =
  '\n\n[Respuesta truncada por exceder el límite de 200.000 caracteres]';

function truncatePlaygroundText(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  const keepLen = Math.max(0, maxLength - PLAYGROUND_TRUNCATION_NOTICE.length);
  return `${text.slice(0, keepLen)}${PLAYGROUND_TRUNCATION_NOTICE}`.slice(0, maxLength);
}

export type ReasoningEffort = 'none' | 'low' | 'medium' | 'high';

const VALID_REASONING_EFFORTS = new Set<string>(['none', 'low', 'medium', 'high']);

const pendingStreamTasks = new Set<Promise<void>>();

export async function waitForPendingPlaygroundStreamsForTests(): Promise<void> {
  while (pendingStreamTasks.size > 0) {
    await Promise.allSettled(Array.from(pendingStreamTasks));
  }
}

export interface PlaygroundUserContext {
  id: string;
  username: string;
  role: 'admin' | 'guest';
}

export interface HandlePlaygroundChatOptions {
  db: DatabaseSync;
  masterKey: Buffer;
  registry: DrainingRegistry;
  user: PlaygroundUserContext;
  rawBody: Record<string, unknown>;
  acceptHeader?: string;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  upstreamTls?: UpstreamTlsOptions;
  now?: () => number;
  isGuestModelAllowed: (userId: string, modelFullId: string) => boolean;
  isProviderOrAllKeysDraining: (providerId: string) => boolean;
}

function asRecord(val: unknown): Record<string, unknown> {
  if (val && typeof val === 'object' && !Array.isArray(val)) {
    return val as Record<string, unknown>;
  }
  return {};
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function jsonResponse(body: unknown, status = 200, extraHeaders?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...(extraHeaders ?? {}),
    },
  });
}

async function normalizeRouterErrorResponse(res: Response): Promise<Response> {
  const retryAfter = res.headers.get('retry-after');
  const extraHeaders: Record<string, string> = {};
  if (retryAfter) {
    extraHeaders['Retry-After'] = retryAfter;
  }

  let parsed: Record<string, unknown> = {};
  try {
    parsed = asRecord(await res.json());
  } catch {
    return jsonResponse(
      { error: `Upstream routing failed (HTTP ${res.status}).`, code: 'upstream_error' },
      res.status,
      extraHeaders,
    );
  }

  const errField = parsed.error;
  if (errField && typeof errField === 'object' && !Array.isArray(errField)) {
    const errObj = errField as Record<string, unknown>;
    const msg =
      typeof errObj.message === 'string' && errObj.message.length > 0
        ? errObj.message
        : `Request failed (HTTP ${res.status}).`;
    return jsonResponse(
      {
        error: msg,
        message: msg,
        type: typeof errObj.type === 'string' ? errObj.type : undefined,
        code: typeof errObj.code === 'string' ? errObj.code : undefined,
        reset_at: typeof errObj.reset_at === 'string' ? errObj.reset_at : undefined,
      },
      res.status,
      extraHeaders,
    );
  }

  const msg =
    typeof errField === 'string' && errField.length > 0
      ? errField
      : typeof parsed.message === 'string' && parsed.message.length > 0
        ? parsed.message
        : `Request failed (HTTP ${res.status}).`;

  return jsonResponse({ ...parsed, error: msg, message: msg }, res.status, extraHeaders);
}

/**
 * HU-21, HU-22 & HU-43b: Executes a session-authenticated Playground chat request through
 * the exact same Bifrost routing engine (`executeChatCompletions`) used by `/v1/chat/completions`,
 * preserving exit-node tunnels, key failover, mid-stream SSE resumption, server-UTC daily
 * quota enforcement, automatic `usage_logs` telemetry, and optional resilient server-side
 * encrypted chat persistence decoupled from client socket disconnects.
 */
export async function handlePlaygroundChat(
  opts: HandlePlaygroundChatOptions,
): Promise<Response> {
  const { db, masterKey, registry, user, rawBody, isGuestModelAllowed, isProviderOrAllKeysDraining } =
    opts;
  const nowFn = opts.now ?? (() => Date.now());

  const model = typeof rawBody.model === 'string' ? rawBody.model.trim() : '';
  if (!model) {
    return jsonResponse(
      { error: 'Field "model" is required and must be a non-empty string.', code: 'invalid_model' },
      400,
    );
  }

  if (!Array.isArray(rawBody.messages) || rawBody.messages.length === 0) {
    return jsonResponse(
      { error: 'Field "messages" must be a non-empty array of chat messages.', code: 'invalid_messages' },
      400,
    );
  }

  for (const m of rawBody.messages) {
    const rec = asRecord(m);
    if (typeof rec.role !== 'string' || !rec.role.trim()) {
      return jsonResponse(
        { error: 'Each message in "messages" must include a valid "role".', code: 'invalid_messages' },
        400,
      );
    }
  }

  // Validate optional chatId (HU-43b) — strictly bound to session user.id (no admin override)
  let boundChatId: string | null = null;
  if (rawBody.chatId !== undefined && rawBody.chatId !== null) {
    if (typeof rawBody.chatId !== 'string' || rawBody.chatId.trim().length === 0) {
      return jsonResponse(
        { error: 'Field "chatId" must be a non-empty string.', code: 'invalid_chat_id' },
        400,
      );
    }
    const candidateChatId = rawBody.chatId.trim();
    try {
      assertPlaygroundChatOwned(db, user.id, candidateChatId);
    } catch (err) {
      if (err instanceof PlaygroundHistoryError) {
        return jsonResponse({ error: err.message, code: 'chat_not_found' }, err.status);
      }
      throw err;
    }
    boundChatId = candidateChatId;
  }

  // Validate reasoning_effort / reasoningEffort ('none' | 'low' | 'medium' | 'high')
  const rawEffort = rawBody.reasoning_effort ?? rawBody.reasoningEffort;
  const hasExplicitReasoningEffort =
    rawEffort !== undefined && rawEffort !== null && rawEffort !== '';
  let reasoningEffort: ReasoningEffort = 'none';
  if (hasExplicitReasoningEffort) {
    if (typeof rawEffort !== 'string' || !VALID_REASONING_EFFORTS.has(rawEffort.trim().toLowerCase())) {
      return jsonResponse(
        {
          error: 'Invalid reasoning_effort. Expected one of: none, low, medium, high.',
          code: 'invalid_reasoning_effort',
        },
        400,
      );
    }
    reasoningEffort = rawEffort.trim().toLowerCase() as ReasoningEffort;
  }

  // Validate optional temperature
  let temperature: number | undefined;
  if (rawBody.temperature !== undefined && rawBody.temperature !== null) {
    const t = Number(rawBody.temperature);
    if (!Number.isFinite(t) || t < 0 || t > 2) {
      return jsonResponse(
        { error: 'Invalid temperature. Expected a number between 0 and 2.', code: 'invalid_temperature' },
        400,
      );
    }
    temperature = t;
  }

  // Validate optional max_tokens / maxTokens
  const rawMaxTokens = rawBody.max_tokens ?? rawBody.maxTokens;
  let maxTokens: number | undefined;
  if (rawMaxTokens !== undefined && rawMaxTokens !== null) {
    const mt = Number(rawMaxTokens);
    if (!Number.isInteger(mt) || mt < 1) {
      return jsonResponse(
        { error: 'Invalid max_tokens. Expected a positive integer.', code: 'invalid_max_tokens' },
        400,
      );
    }
    maxTokens = mt;
  }

  // Enforce guest model whitelist (HU-04 / HU-21)
  if (user.role === 'guest' && !isGuestModelAllowed(user.id, model)) {
    return jsonResponse(
      {
        error: `Access to model "${model}" is not allowed for this guest account.`,
        code: 'model_access_denied',
      },
      403,
    );
  }

  const modelRow = db
    .prepare(
      `SELECT m.full_id, m.model_id, m.provider_id, m.disabled_by_admin
       FROM models m
       JOIN providers p ON p.id = m.provider_id
       WHERE m.full_id = ? AND m.active = 1 AND p.enabled = 1`,
    )
    .get(model) as
    | { full_id: string; model_id: string; provider_id: string; disabled_by_admin: number }
    | undefined;

  if (
    !modelRow ||
    Number(modelRow.disabled_by_admin ?? 0) === 1 ||
    isProviderOrAllKeysDraining(modelRow.provider_id)
  ) {
    return jsonResponse(
      {
        error: `No active provider or model is configured for "${model}" yet.`,
        code: 'model_not_found',
      },
      404,
    );
  }

  const providerRow = db
    .prepare(`SELECT * FROM providers WHERE id = ? AND enabled = 1`)
    .get(modelRow.provider_id) as Record<string, unknown> | undefined;

  if (!providerRow) {
    return jsonResponse(
      {
        error: `Provider "${modelRow.provider_id}" is not enabled.`,
        code: 'provider_unavailable',
      },
      503,
    );
  }

  // Build normalized messages list, prepending optional systemPrompt if provided
  const messages: Array<Record<string, unknown>> = rawBody.messages.map((m) => ({
    ...asRecord(m),
  }));
  const rawSystemPrompt = typeof rawBody.systemPrompt === 'string' ? rawBody.systemPrompt.trim() : '';
  if (rawSystemPrompt) {
    const first = messages[0];
    if (!first || first.role !== 'system' || first.content !== rawSystemPrompt) {
      messages.unshift({ role: 'system', content: rawSystemPrompt });
    }
  }
  const effectiveSystemPrompt =
    rawSystemPrompt ||
    (messages[0]?.role === 'system' && typeof messages[0].content === 'string'
      ? messages[0].content.trim()
      : '');

  const persistAssistantMessageSafe = (
    content: string,
    reasoningContent: string | null,
    metrics: PlaygroundMessageMetrics | null,
  ) => {
    if (!boundChatId) return;
    const safeContent = truncatePlaygroundText(content, MAX_PLAYGROUND_MESSAGE_CONTENT_LENGTH);
    const safeReasoning =
      reasoningContent !== null
        ? truncatePlaygroundText(reasoningContent, MAX_PLAYGROUND_MESSAGE_REASONING_LENGTH)
        : null;
    try {
      appendPlaygroundMessages(
        db,
        masterKey,
        user.id,
        boundChatId,
        {
          role: 'assistant',
          content: safeContent,
          reasoningContent: safeReasoning,
          modelFullId: modelRow.full_id,
          metrics,
        },
        Math.floor(nowFn() / 1000),
      );
    } catch {
      // Chat may have been deleted concurrently while generating
    }
  };

  // HU-43b: Persist latest user message, model & encrypted settings BEFORE calling upstream
  if (boundChatId) {
    const nowSec = Math.floor(nowFn() / 1000);
    const chatSettings: PlaygroundChatSettings = {
      reasoningEffort,
      temperature: temperature ?? null,
      maxTokens: maxTokens ?? null,
      systemPrompt: effectiveSystemPrompt.length > 0 ? effectiveSystemPrompt : null,
    };

    try {
      updatePlaygroundChat(
        db,
        masterKey,
        user.id,
        boundChatId,
        {
          modelFullId: modelRow.full_id,
          settings: chatSettings,
        },
        nowSec,
      );

      let lastUserContent = '';
      for (let i = rawBody.messages.length - 1; i >= 0; i--) {
        const m = asRecord(rawBody.messages[i]);
        if (m.role === 'user' && typeof m.content === 'string' && m.content.length > 0) {
          lastUserContent = m.content;
          break;
        }
      }
      if (lastUserContent.length > 0) {
        appendPlaygroundMessages(
          db,
          masterKey,
          user.id,
          boundChatId,
          {
            role: 'user',
            content: lastUserContent,
            modelFullId: modelRow.full_id,
          },
          nowSec,
        );
      }
    } catch (err) {
      if (err instanceof PlaygroundHistoryError) {
        return jsonResponse({ error: err.message, code: 'chat_persistence_error' }, err.status);
      }
      throw err;
    }

    markChatGenerating(boundChatId, true);
  }

  const accept = opts.acceptHeader ?? '';
  const wantsStream =
    rawBody.stream === true ||
    (rawBody.stream !== false && accept.includes('text/event-stream'));

  const upstreamPayload: Record<string, unknown> = {
    model: modelRow.full_id,
    messages,
    stream: wantsStream,
  };
  if (temperature !== undefined) {
    upstreamPayload.temperature = temperature;
  }
  if (maxTokens !== undefined) {
    upstreamPayload.max_tokens = maxTokens;
  }
  if (reasoningEffort !== 'none') {
    upstreamPayload.reasoning_effort = reasoningEffort;
  } else if (
    hasExplicitReasoningEffort &&
    modelRow.provider_id === 'nvidia-nim' &&
    rawBody.chat_template_kwargs === undefined
  ) {
    upstreamPayload.chat_template_kwargs = { enable_thinking: false };
  }
  if (rawBody.chat_template_kwargs !== undefined) {
    upstreamPayload.chat_template_kwargs = rawBody.chat_template_kwargs;
  }
  if (rawBody.tools !== undefined) {
    upstreamPayload.tools = rawBody.tools;
  }
  if (rawBody.tool_choice !== undefined) {
    upstreamPayload.tool_choice = rawBody.tool_choice;
  }
  if (rawBody.response_format !== undefined) {
    upstreamPayload.response_format = rawBody.response_format;
  }

  const startedAtMs = nowFn();
  let routerRes: Response;
  try {
    routerRes = await executeChatCompletions({
      db,
      masterKey,
      registry,
      fetchImpl: opts.fetchImpl ?? globalThis.fetch,
      upstreamTls: opts.upstreamTls,
      now: nowFn,
      userId: user.id,
      modelFullId: modelRow.full_id,
      modelId: modelRow.model_id,
      providerRow,
      requestBody: upstreamPayload,
      signal: boundChatId ? undefined : opts.signal,
    });
  } catch (err) {
    const errMsg = redactSecretsInText(
      err instanceof Error ? err.message : 'Playground upstream request failed.',
    );
    writeSystemLog(
      db,
      'error',
      'system',
      `Playground request failed for "${modelRow.full_id}": ${errMsg}`,
      { userId: user.id, modelFullId: modelRow.full_id, providerId: modelRow.provider_id },
      Math.floor(nowFn() / 1000),
    );
    if (boundChatId) {
      persistAssistantMessageSafe(errMsg, null, { error: errMsg });
      markChatGenerating(boundChatId, false);
    }
    return jsonResponse({ error: errMsg, code: 'upstream_error' }, 502);
  }

  if (!routerRes.ok) {
    const normalized = await normalizeRouterErrorResponse(routerRes);
    const cloned = normalized.clone();
    let errDetail = `HTTP ${routerRes.status}`;
    try {
      const errJson = (await cloned.json()) as Record<string, unknown>;
      if (typeof errJson.error === 'string' && errJson.error.length > 0) {
        errDetail = redactSecretsInText(errJson.error.slice(0, 240));
      }
    } catch {
      // Ignore parse error
    }
    writeSystemLog(
      db,
      'error',
      'system',
      `Playground error (HTTP ${routerRes.status}) on "${modelRow.full_id}": ${errDetail}`,
      {
        userId: user.id,
        modelFullId: modelRow.full_id,
        providerId: modelRow.provider_id,
        httpStatus: routerRes.status,
      },
      Math.floor(nowFn() / 1000),
    );
    if (boundChatId) {
      persistAssistantMessageSafe(errDetail, null, { error: errDetail });
      markChatGenerating(boundChatId, false);
    }
    return normalized;
  }

  // Streaming SSE response: pipe upstream SSE frames directly and inject telemetry summary before [DONE].
  // When boundChatId is set (HU-43b), reading from upstream is decoupled from the client socket so
  // browser disconnects/tab switches never abort upstream reading or server-side persistence.
  if (wantsStream && routerRes.body) {
    const reader = routerRes.body.getReader();
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();

    let firstTokenMs: number | null = null;
    let promptTokens = 0;
    let completionTokens = 0;
    let reasoningTokens = 0;
    let cachedTokens = 0;
    let generatedChars = 0;
    let assistantContentAcc = '';
    let assistantReasoningAcc = '';

    const estimatedPromptTokens = Math.max(
      1,
      Math.ceil(
        messages.reduce((acc, m) => {
          const content =
            typeof m.content === 'string'
              ? m.content
              : Array.isArray(m.content)
                ? JSON.stringify(m.content)
                : '';
          return acc + content.length + 12;
        }, 0) / 4,
      ),
    );

    let clientOpen = true;
    let streamController: ReadableStreamDefaultController<Uint8Array> | null = null;

    const safeEnqueue = (chunk: Uint8Array) => {
      if (!clientOpen || !streamController) return;
      try {
        streamController.enqueue(chunk);
      } catch {
        clientOpen = false;
      }
    };

    const safeClose = () => {
      if (!clientOpen || !streamController) return;
      clientOpen = false;
      try {
        streamController.close();
      } catch {
        // Client already disconnected
      }
    };

    const safeError = (err: unknown) => {
      if (!clientOpen || !streamController) return;
      clientOpen = false;
      try {
        streamController.error(err);
      } catch {
        // Client already disconnected
      }
    };

    const startUpstreamPump = () => {
      const pumpTask = (async () => {
        let buffer = '';
        let emittedDone = false;
        let finalMetrics: PlaygroundMessageMetrics | null = null;

        const computeFinalMetrics = () => {
          const durationMs = Math.max(1, nowFn() - startedAtMs);
          const ttftMs = firstTokenMs ?? durationMs;
          const effectivePrompt = promptTokens > 0 ? promptTokens : estimatedPromptTokens;
          const effectiveCompletion =
            completionTokens > 0
              ? completionTokens
              : generatedChars > 0
                ? Math.max(1, Math.ceil(generatedChars / 4))
                : 0;
          const tokensPerSec = computeTokensPerSec(
            effectiveCompletion,
            reasoningTokens,
            durationMs,
          );
          const totalTokens = effectivePrompt + effectiveCompletion + reasoningTokens;
          return {
            durationMs,
            ttftMs,
            effectivePrompt,
            effectiveCompletion,
            tokensPerSec,
            totalTokens,
          };
        };

        const emitMetricsAndDone = () => {
          if (emittedDone) return;
          emittedDone = true;
          const {
            durationMs,
            ttftMs,
            effectivePrompt,
            effectiveCompletion,
            tokensPerSec,
            totalTokens,
          } = computeFinalMetrics();

          finalMetrics = {
            ttftMs,
            tokensPerSec,
            promptTokens: effectivePrompt,
            completionTokens: effectiveCompletion,
            reasoningTokens,
          };

          const summaryEvt = {
            object: 'bifrost.playground.metrics',
            model,
            reasoningEffort,
            ttftMs,
            ttft_ms: ttftMs,
            tokensPerSec,
            tokens_per_sec: tokensPerSec,
            durationMs,
            usage: {
              promptTokens: effectivePrompt,
              completionTokens: effectiveCompletion,
              reasoningTokens,
              cachedTokens,
              totalTokens,
              prompt_tokens: effectivePrompt,
              completion_tokens: effectiveCompletion,
              reasoning_tokens: reasoningTokens,
              cached_tokens: cachedTokens,
              total_tokens: totalTokens,
              completion_tokens_details: {
                reasoning_tokens: reasoningTokens,
              },
            },
          };

          safeEnqueue(encoder.encode(`data: ${JSON.stringify(summaryEvt)}\n\n`));
          safeEnqueue(encoder.encode('data: [DONE]\n\n'));
        };

        let eventDataLines: string[] = [];
        let eventDataChars = 0;

        const isValidJsonFrame = (raw: string): boolean => {
          const t = raw.trim();
          if (!t) return false;
          try {
            JSON.parse(t);
            return true;
          } catch {
            return false;
          }
        };

        const processEventPayload = (payload: string) => {
          const trimmed = payload.trim();
          if (!trimmed) return;
          if (trimmed === '[DONE]') {
            emitMetricsAndDone();
            return;
          }

          let parsed: Record<string, unknown>;
          try {
            const candidate = JSON.parse(trimmed) as unknown;
            if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
              return;
            }
            parsed = candidate as Record<string, unknown>;
          } catch {
            // Discard truncated / malformed JSON frames instead of forwarding broken JSON
            return;
          }

          const choices = Array.isArray(parsed.choices) ? parsed.choices : [];
          if (choices.length > 0) {
            const delta = asRecord(asRecord(choices[0]).delta);
            const contentDelta = typeof delta.content === 'string' ? delta.content : '';
            const reasoningDelta =
              typeof delta.reasoning_content === 'string'
                ? delta.reasoning_content
                : typeof delta.reasoning === 'string'
                  ? delta.reasoning
                  : '';
            const hasToolCalls = Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0;
            if (contentDelta || reasoningDelta || hasToolCalls) {
              if (firstTokenMs === null) {
                firstTokenMs = Math.max(1, nowFn() - startedAtMs);
              }
              assistantContentAcc += contentDelta;
              assistantReasoningAcc += reasoningDelta;
              generatedChars += contentDelta.length + reasoningDelta.length;
            }
          }
          if (parsed.usage && typeof parsed.usage === 'object') {
            const u = asRecord(parsed.usage);
            const compDetails = asRecord(u.completion_tokens_details);
            const promptDetails = asRecord(u.prompt_tokens_details);
            promptTokens = Math.max(
              promptTokens,
              toSafeNonNegInt(u.prompt_tokens ?? u.promptTokens),
            );
            completionTokens = Math.max(
              completionTokens,
              toSafeNonNegInt(u.completion_tokens ?? u.completionTokens),
            );
            reasoningTokens = Math.max(
              reasoningTokens,
              toSafeNonNegInt(
                u.reasoning_tokens ?? u.reasoningTokens ?? compDetails.reasoning_tokens,
              ),
            );
            cachedTokens = Math.max(
              cachedTokens,
              toSafeNonNegInt(u.cached_tokens ?? u.cachedTokens ?? promptDetails.cached_tokens),
            );
          }

          safeEnqueue(encoder.encode(`data: ${trimmed}\n\n`));
        };

        const flushEventData = () => {
          if (eventDataLines.length === 0) return;
          const payload = eventDataLines.join('\n');
          eventDataLines = [];
          eventDataChars = 0;
          processEventPayload(payload);
        };

        const processLine = (rawLine: string) => {
          const line = rawLine.replace(/\r$/, '');
          if (line === '') {
            flushEventData();
            return;
          }
          if (line.startsWith(':')) {
            return;
          }
          if (!line.startsWith('data:')) {
            return;
          }

          const dataPart = line.slice(5).replace(/^ /, '');
          if (eventDataLines.length > 0) {
            const buffered = eventDataLines.join('\n').trim();
            if (buffered === '[DONE]' || isValidJsonFrame(buffered)) {
              flushEventData();
            }
          }
          if (eventDataChars + dataPart.length > MAX_PLAYGROUND_SSE_BUFFER_CHARS) {
            eventDataLines = [];
            eventDataChars = 0;
            throw new Error('Upstream SSE event exceeded maximum buffer size.');
          }
          eventDataLines.push(dataPart);
          eventDataChars += dataPart.length;
          if (eventDataLines.length === 1 && dataPart.trim() === '[DONE]') {
            flushEventData();
          }
        };

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            if (buffer.length > MAX_PLAYGROUND_SSE_BUFFER_CHARS) {
              throw new Error('Upstream SSE line exceeded maximum buffer size.');
            }
            const lines = buffer.split('\n');
            buffer = lines.pop() ?? '';
            for (const line of lines) {
              processLine(line);
            }
          }
          buffer += decoder.decode();
          if (buffer.trim()) {
            for (const line of buffer.split('\n')) {
              processLine(line);
            }
          }
          flushEventData();
          emitMetricsAndDone();
          safeClose();

          if (boundChatId) {
            const hasContent = assistantContentAcc.length > 0 || assistantReasoningAcc.length > 0;
            if (hasContent) {
              persistAssistantMessageSafe(
                assistantContentAcc,
                assistantReasoningAcc.length > 0 ? assistantReasoningAcc : null,
                finalMetrics,
              );
            } else {
              const emptyErr = 'Upstream closed stream without returning content.';
              persistAssistantMessageSafe(emptyErr, null, {
                ...(finalMetrics ?? {}),
                error: emptyErr,
              });
            }
          }
        } catch (err) {
          const safeErrMsg = redactSecretsInText(
            err instanceof Error ? err.message : 'Playground stream interrupted.',
          );
          if (boundChatId) {
            const { ttftMs, effectivePrompt, effectiveCompletion, tokensPerSec } =
              computeFinalMetrics();
            persistAssistantMessageSafe(
              assistantContentAcc.length > 0 ? assistantContentAcc : safeErrMsg,
              assistantReasoningAcc.length > 0 ? assistantReasoningAcc : null,
              {
                ttftMs,
                tokensPerSec,
                promptTokens: effectivePrompt,
                completionTokens: effectiveCompletion,
                reasoningTokens,
                error: safeErrMsg,
              },
            );
          }
          safeError(err);
        } finally {
          reader.releaseLock();
          if (boundChatId) {
            markChatGenerating(boundChatId, false);
          }
        }
      })();

      pendingStreamTasks.add(pumpTask);
      void pumpTask.finally(() => {
        pendingStreamTasks.delete(pumpTask);
      });
    };

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller;
        startUpstreamPump();
      },
      cancel() {
        // Client disconnected / navigated away: stop enqueueing to client.
        // For persisted chats (HU-43b, boundChatId !== null), keep reading upstream to finish persistence.
        // For ephemeral chats (boundChatId === null), cancel upstream reader immediately to stop waste.
        clientOpen = false;
        if (boundChatId === null) {
          void reader.cancel().catch(() => {
            // Ignore upstream reader cancel errors
          });
        }
      },
    });

    const headers = new Headers({
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const failoverCount = routerRes.headers.get('x-bifrost-failover-count');
    if (failoverCount) {
      headers.set('X-Bifrost-Failover-Count', failoverCount);
    }

    return new Response(stream, { status: 200, headers });
  }

  // Non-streaming JSON response
  try {
    const durationMs = Math.max(1, nowFn() - startedAtMs);
    const rawJson = asRecord(await routerRes.json());
    const choices = Array.isArray(rawJson.choices) ? rawJson.choices : [];
    const firstMessage = choices.length > 0 ? asRecord(asRecord(choices[0]).message) : {};

    const content = typeof firstMessage.content === 'string' ? firstMessage.content : '';
    const reasoningContent =
      typeof firstMessage.reasoning_content === 'string'
        ? firstMessage.reasoning_content
        : typeof firstMessage.reasoning === 'string'
          ? firstMessage.reasoning
          : undefined;

    const u = asRecord(rawJson.usage);
    const compDetails = asRecord(u.completion_tokens_details);
    const promptDetails = asRecord(u.prompt_tokens_details);

    const estimatedNonStreamPrompt = Math.max(
      1,
      Math.ceil(
        messages.reduce((acc, m) => {
          const msgContent =
            typeof m.content === 'string'
              ? m.content
              : Array.isArray(m.content)
                ? JSON.stringify(m.content)
                : '';
          return acc + msgContent.length + 12;
        }, 0) / 4,
      ),
    );
    const promptTokens =
      toSafeNonNegInt(u.prompt_tokens ?? u.promptTokens) || estimatedNonStreamPrompt;
    const completionTokens =
      toSafeNonNegInt(u.completion_tokens ?? u.completionTokens) ||
      (content.length > 0 ? Math.max(1, Math.ceil(content.length / 4)) : 0);
    const reasoningTokens = toSafeNonNegInt(
      u.reasoning_tokens ?? u.reasoningTokens ?? compDetails.reasoning_tokens,
    );
    const cachedTokens = toSafeNonNegInt(
      u.cached_tokens ?? u.cachedTokens ?? promptDetails.cached_tokens,
    );
    const totalTokens =
      toSafeNonNegInt(u.total_tokens ?? u.totalTokens) ||
      promptTokens + completionTokens + reasoningTokens;

    const headerTtft = Number(routerRes.headers.get('x-bifrost-ttft-ms'));
    const headerTps = Number(routerRes.headers.get('x-bifrost-tokens-per-sec'));

    const ttftMs =
      Number.isFinite(headerTtft) && headerTtft > 0 ? Math.round(headerTtft) : durationMs;
    const tokensPerSec =
      Number.isFinite(headerTps) && headerTps > 0
        ? round2(headerTps)
        : computeTokensPerSec(completionTokens, reasoningTokens, durationMs);

    if (boundChatId) {
      const hasContent = content.length > 0 || (reasoningContent !== undefined && reasoningContent.length > 0);
      const metrics: PlaygroundMessageMetrics = {
        ttftMs,
        tokensPerSec,
        promptTokens,
        completionTokens,
        reasoningTokens,
      };
      if (hasContent) {
        persistAssistantMessageSafe(content, reasoningContent ?? null, metrics);
      } else {
        const emptyErr = 'Upstream returned an empty response.';
        persistAssistantMessageSafe(emptyErr, null, { ...metrics, error: emptyErr });
      }
    }

    return jsonResponse({
      ...rawJson,
      model: typeof rawJson.model === 'string' ? rawJson.model : model,
      choices,
      content,
      ...(reasoningContent !== undefined ? { reasoningContent } : {}),
      reasoningEffort,
      ttftMs,
      ttft_ms: ttftMs,
      tokensPerSec,
      tokens_per_sec: tokensPerSec,
      durationMs,
      usage: {
        ...u,
        promptTokens,
        completionTokens,
        reasoningTokens,
        cachedTokens,
        totalTokens,
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        reasoning_tokens: reasoningTokens,
        cached_tokens: cachedTokens,
        total_tokens: totalTokens,
        completion_tokens_details: {
          ...compDetails,
          reasoning_tokens: reasoningTokens,
        },
      },
    });
  } catch (err) {
    const errMsg = redactSecretsInText(
      err instanceof Error ? err.message : 'Failed to read upstream Playground response.',
    );
    if (boundChatId) {
      persistAssistantMessageSafe(errMsg, null, { error: errMsg });
    }
    return jsonResponse({ error: errMsg, code: 'upstream_error' }, 502);
  } finally {
    if (boundChatId) {
      markChatGenerating(boundChatId, false);
    }
  }
}
