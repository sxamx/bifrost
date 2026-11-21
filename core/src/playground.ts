import type { DatabaseSync } from 'node:sqlite';
import { redactSecretsInText, writeSystemLog } from './db.js';
import type { UpstreamTlsOptions } from './nodes.js';
import {
  executeChatCompletions,
  type DrainingRegistry,
} from './router.js';

export type ReasoningEffort = 'none' | 'low' | 'medium' | 'high';

const VALID_REASONING_EFFORTS = new Set<string>(['none', 'low', 'medium', 'high']);

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

function toSafeNonNegInt(val: unknown): number {
  const n = Number(val);
  return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : 0;
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
 * HU-21 & HU-22: Executes a session-authenticated Playground chat request through
 * the exact same Bifrost routing engine (`executeChatCompletions`) used by `/v1/chat/completions`,
 * preserving exit-node tunnels, key failover, mid-stream SSE resumption, server-UTC daily
 * quota enforcement, and automatic `usage_logs` telemetry.
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

  // Validate reasoning_effort / reasoningEffort ('none' | 'low' | 'medium' | 'high')
  const rawEffort = rawBody.reasoning_effort ?? rawBody.reasoningEffort;
  let reasoningEffort: ReasoningEffort = 'none';
  if (rawEffort !== undefined && rawEffort !== null && rawEffort !== '') {
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
    (user.role !== 'admin' && Number(modelRow.disabled_by_admin ?? 0) === 1) ||
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
  const systemPrompt = typeof rawBody.systemPrompt === 'string' ? rawBody.systemPrompt.trim() : '';
  if (systemPrompt) {
    const first = messages[0];
    if (!first || first.role !== 'system' || first.content !== systemPrompt) {
      messages.unshift({ role: 'system', content: systemPrompt });
    }
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
    return normalized;
  }

  // Streaming SSE response: pipe upstream SSE frames directly and inject telemetry summary before [DONE]
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

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        let buffer = '';
        let emittedDone = false;

        const emitMetricsAndDone = () => {
          if (emittedDone) return;
          emittedDone = true;
          const durationMs = Math.max(1, nowFn() - startedAtMs);
          const ttftMs = firstTokenMs ?? durationMs;
          const effectiveCompletion =
            completionTokens > 0
              ? completionTokens
              : generatedChars > 0
                ? Math.max(1, Math.ceil(generatedChars / 4))
                : 0;
          const totalOutTokens = effectiveCompletion + reasoningTokens;
          const tokensPerSec =
            totalOutTokens > 0 && durationMs > 0
              ? round2((totalOutTokens / durationMs) * 1000)
              : null;
          const totalTokens = promptTokens + effectiveCompletion + reasoningTokens;

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
              promptTokens,
              completionTokens: effectiveCompletion,
              reasoningTokens,
              cachedTokens,
              totalTokens,
              prompt_tokens: promptTokens,
              completion_tokens: effectiveCompletion,
              reasoning_tokens: reasoningTokens,
              cached_tokens: cachedTokens,
              total_tokens: totalTokens,
              completion_tokens_details: {
                reasoning_tokens: reasoningTokens,
              },
            },
          };

          controller.enqueue(encoder.encode(`data: ${JSON.stringify(summaryEvt)}\n\n`));
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        };

        const processLine = (rawLine: string) => {
          const trimmed = rawLine.trim();
          if (!trimmed) return;
          if (!trimmed.startsWith('data:')) {
            controller.enqueue(encoder.encode(`${rawLine}\n`));
            return;
          }
          const payload = trimmed.slice(5).trim();
          if (payload === '[DONE]') {
            emitMetricsAndDone();
            return;
          }

          try {
            const parsed = asRecord(JSON.parse(payload));
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
                generatedChars += contentDelta.length + reasoningDelta.length;
              }
            }
            if (parsed.usage && typeof parsed.usage === 'object') {
              const u = asRecord(parsed.usage);
              const compDetails = asRecord(u.completion_tokens_details);
              const promptDetails = asRecord(u.prompt_tokens_details);
              promptTokens = toSafeNonNegInt(u.prompt_tokens ?? u.promptTokens) || promptTokens;
              completionTokens =
                toSafeNonNegInt(u.completion_tokens ?? u.completionTokens) || completionTokens;
              reasoningTokens =
                toSafeNonNegInt(
                  u.reasoning_tokens ?? u.reasoningTokens ?? compDetails.reasoning_tokens,
                ) || reasoningTokens;
              cachedTokens =
                toSafeNonNegInt(
                  u.cached_tokens ?? u.cachedTokens ?? promptDetails.cached_tokens,
                ) || cachedTokens;
            }
          } catch {
            // Forward non-JSON data frame unchanged
          }

          controller.enqueue(encoder.encode(`data: ${payload}\n\n`));
        };

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
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
          emitMetricsAndDone();
          controller.close();
        } catch (err) {
          controller.error(err);
        } finally {
          reader.releaseLock();
        }
      },
    });

    const headers = new Headers({
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    });
    const failoverCount = routerRes.headers.get('x-bifrost-failover-count');
    if (failoverCount) {
      headers.set('X-Bifrost-Failover-Count', failoverCount);
    }

    return new Response(stream, { status: 200, headers });
  }

  // Non-streaming JSON response
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

  const promptTokens = toSafeNonNegInt(u.prompt_tokens ?? u.promptTokens);
  const completionTokens = toSafeNonNegInt(u.completion_tokens ?? u.completionTokens);
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
  const totalOutTokens = completionTokens + reasoningTokens;
  const tokensPerSec =
    Number.isFinite(headerTps) && headerTps > 0
      ? round2(headerTps)
      : totalOutTokens > 0 && durationMs > 0
        ? round2((totalOutTokens / durationMs) * 1000)
        : null;

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
}
