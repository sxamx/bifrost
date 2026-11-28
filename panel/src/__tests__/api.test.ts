import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api } from '../api';

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      ...headers,
    },
  });
}

function sseResponse(chunks: string[], status = 200): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });

  return new Response(stream, {
    status,
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
    },
  });
}

describe('panel/src/api.ts', () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('Playground SSE streaming parser (sendPlaygroundChat / streamPlaygroundChat)', () => {
    it('parses split SSE chunks, reasoning_content, bifrost.playground.metrics frame, and [DONE]', async () => {
      const frame1 =
        'data: {"choices":[{"delta":{"reasoning_content":"Analizando "}}]}\n\n' +
        'data: {"choices":[{"delta":{"reasoning_content":"el prompt","content":"Hola "}}]}\n\n';
      const frame2 =
        'data: {"choices":[{"delta":{"content":"mundo!"}}]}\n\n' +
        'data: {"object":"bifrost.playground.metrics","ttftMs":145,"tokensPerSec":72.5,' +
        '"usage":{"prompt_tokens":20,"completion_tokens":12,"completion_tokens_details":{"reasoning_tokens":8}}}\n\n' +
        'data: [DONE]\n\n';

      // Deliberately split JSON frames mid-line across stream reads
      const combined = `: keepalive comment\n\n${frame1}data: {malformed-json}\n\n${frame2}`;
      const splitA = combined.slice(0, 48);
      const splitB = combined.slice(48, 130);
      const splitC = combined.slice(130, 235);
      const splitD = combined.slice(235);

      fetchMock.mockResolvedValueOnce(sseResponse([splitA, splitB, splitC, splitD]));

      const deltas: Array<{ text: string; reasoning: string | undefined }> = [];
      const result = await api.streamPlaygroundChat(
        {
          model: 'openrouter/deepseek/deepseek-r1:free',
          messages: [{ role: 'user', content: 'Di hola' }],
          temperature: 0.4,
          maxTokens: 256,
          reasoningEffort: 'medium',
          chatId: 'chat-1',
        },
        (partialText, partialReasoning) => {
          deltas.push({ text: partialText, reasoning: partialReasoning });
        }
      );

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0]!;
      expect(url).toBe('/api/playground/chat');
      expect(init?.method).toBe('POST');
      const sentBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(sentBody.stream).toBe(true);
      expect(sentBody.chatId).toBe('chat-1');
      expect(sentBody.reasoning_effort).toBe('medium');

      expect(deltas).toEqual([
        { text: '', reasoning: 'Analizando ' },
        { text: 'Hola ', reasoning: 'Analizando el prompt' },
        { text: 'Hola mundo!', reasoning: 'Analizando el prompt' },
      ]);

      expect(result.content).toBe('Hola mundo!');
      expect(result.reasoningContent).toBe('Analizando el prompt');
      expect(result.model).toBe('openrouter/deepseek/deepseek-r1:free');
      expect(result.ttftMs).toBe(145);
      expect(result.tokensPerSec).toBe(72.5);
      expect(result.usage).toEqual({
        promptTokens: 20,
        completionTokens: 12,
        reasoningTokens: 8,
        totalTokens: 40,
      });
    });

    it('throws ApiError with server message on HTTP error response', async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({ error: 'Modelo no permitido para este usuario' }, 403)
      );

      await expect(
        api.sendPlaygroundChat({
          model: 'groq/llama-3.3-70b',
          messages: [{ role: 'user', content: 'ping' }],
          stream: true,
        })
      ).rejects.toMatchObject({
        name: 'ApiError',
        status: 403,
        message: 'Modelo no permitido para este usuario',
      });
    });

    it('propagates AbortSignal to fetch and rejects when aborted', async () => {
      const controller = new AbortController();
      const abortErr = new DOMException('Aborted', 'AbortError');

      fetchMock.mockImplementationOnce((_input, init) => {
        expect(init?.signal).toBe(controller.signal);
        return Promise.reject(abortErr);
      });

      controller.abort();

      await expect(
        api.streamPlaygroundChat(
          {
            model: 'groq/llama-3.3-70b',
            messages: [{ role: 'user', content: 'cancel me' }],
          },
          undefined,
          { signal: controller.signal }
        )
      ).rejects.toThrow('Aborted');
    });
  });

  describe('ApiError normalization (401 / 403 / 409 / 429)', () => {
    it('normalizes 401 expired session errors', async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({ error: 'Sesión expirada. Inicia sesión nuevamente.' }, 401)
      );

      let caught: unknown;
      try {
        await api.getMe();
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(ApiError);
      const apiErr = caught as ApiError;
      expect(apiErr.status).toBe(401);
      expect(apiErr.message).toBe('Sesión expirada. Inicia sesión nuevamente.');
      expect(apiErr.data).toEqual({ error: 'Sesión expirada. Inicia sesión nuevamente.' });
    });

    it('normalizes 403 guest forbidden errors', async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({ error: 'Acceso restringido a administradores', role: 'guest' }, 403)
      );

      await expect(api.getUsers()).rejects.toMatchObject({
        name: 'ApiError',
        status: 403,
        message: 'Acceso restringido a administradores',
        data: { role: 'guest' },
      });
    });

    it('normalizes 409 NODE_PROVIDER_COLLISION errors preserving payload metadata', async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse(
          {
            error: 'El nodo ya tiene otra clave asignada para el mismo proveedor',
            code: 'NODE_PROVIDER_COLLISION',
            conflictingKeyId: 'key-existing-1',
          },
          409
        )
      );

      let caught: unknown;
      try {
        await api.assignKeyNode('groq', 'key-2', 'node-eu-1', false);
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(ApiError);
      const apiErr = caught as ApiError;
      expect(apiErr.status).toBe(409);
      expect(apiErr.data.code).toBe('NODE_PROVIDER_COLLISION');
      expect(apiErr.data.conflictingKeyId).toBe('key-existing-1');
    });

    it('normalizes 429 rate-limit errors preserving reset_at', async () => {
      const resetAt = 1763500000;
      fetchMock.mockResolvedValueOnce(
        jsonResponse({ error: 'Límite de cuota excedido', reset_at: resetAt }, 429)
      );

      let caught: unknown;
      try {
        await api.getModels();
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(ApiError);
      const apiErr = caught as ApiError;
      expect(apiErr.status).toBe(429);
      expect(apiErr.message).toBe('Límite de cuota excedido');
      expect(apiErr.data.reset_at).toBe(resetAt);
    });

    it('falls back to HTTP status message on non-JSON empty error response', async () => {
      fetchMock.mockResolvedValueOnce(new Response('', { status: 502 }));

      await expect(api.getHealth()).rejects.toMatchObject({
        name: 'ApiError',
        status: 502,
        message: 'Error HTTP 502',
      });
    });
  });

  describe('addProviderKey default egressMode & setKeyEgress / assignKeyNode', () => {
    it('sends egressMode: "none" and status: "no_node" by default when no egress/node/status/enabled is provided', async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          key: {
            id: 'k-1',
            providerId: 'groq',
            label: 'Clave principal',
            last4: '9876',
            nodeId: null,
            egressMode: 'none',
            status: 'no_node',
          },
        })
      );

      const created = await api.addProviderKey('groq', {
        label: '  Clave principal  ',
        secret: 'test-provider-secret-9876',
      });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0]!;
      expect(url).toBe('/api/providers/groq/keys');
      expect(init?.method).toBe('POST');

      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body).toEqual({
        label: 'Clave principal',
        secret: 'test-provider-secret-9876',
        egressMode: 'none',
        status: 'no_node',
      });
      expect(created.status).toBe('no_node');
      expect(created.nodeId).toBeNull();
      expect(created.egressMode).toBe('none');
    });

    it('honors explicit enabled: true, explicit status: "active", and explicit egressMode values', async () => {
      fetchMock
        .mockResolvedValueOnce(
          jsonResponse({
            key: { id: 'k-2', label: 'Activa', last4: '1111', nodeId: 'node-1', status: 'active' },
          })
        )
        .mockResolvedValueOnce(
          jsonResponse({
            key: { id: 'k-3', label: 'Explicita', last4: '2222', nodeId: null, status: 'active' },
          })
        )
        .mockResolvedValueOnce(
          jsonResponse({
            key: {
              id: 'k-4',
              label: 'Directa',
              last4: '3333',
              nodeId: null,
              egressMode: 'direct',
              status: 'active',
            },
          })
        )
        .mockResolvedValueOnce(
          jsonResponse({
            key: {
              id: 'k-5',
              label: 'Nodo',
              last4: '4444',
              nodeId: 'node-2',
              egressMode: 'node',
              status: 'active',
            },
          })
        );

      const k2 = await api.addProviderKey('openrouter', {
        label: 'Activa',
        secret: 'test-secret-1111',
        enabled: true,
        dailyQuotaLimit: 50000,
        nodeId: 'node-1',
      });

      const firstBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as Record<
        string,
        unknown
      >;
      expect(firstBody.status).toBe('active');
      expect(firstBody.dailyQuotaLimit).toBe(50000);
      expect(firstBody.nodeId).toBe('node-1');
      // Derived egressMode when backend response omits it
      expect(k2.egressMode).toBe('node');

      const k3 = await api.addProviderKey('openrouter', {
        label: 'Explicita',
        secret: 'test-secret-2222',
        status: 'active',
      });

      const secondBody = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)) as Record<
        string,
        unknown
      >;
      expect(secondBody.status).toBe('active');
      expect(k3.egressMode).toBe('direct');

      const k4 = await api.addProviderKey('openrouter', {
        label: 'Directa',
        secret: 'test-secret-3333',
        egressMode: 'direct',
      });
      const thirdBody = JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body)) as Record<
        string,
        unknown
      >;
      expect(thirdBody).toEqual({
        label: 'Directa',
        secret: 'test-secret-3333',
        egressMode: 'direct',
      });
      expect(k4.egressMode).toBe('direct');

      const k5 = await api.addProviderKey('openrouter', {
        label: 'Nodo',
        secret: 'test-secret-4444',
        egressMode: 'node',
        nodeId: 'node-2',
        confirmForce: true,
      });
      const fourthBody = JSON.parse(String(fetchMock.mock.calls[3]?.[1]?.body)) as Record<
        string,
        unknown
      >;
      expect(fourthBody).toEqual({
        label: 'Nodo',
        secret: 'test-secret-4444',
        egressMode: 'node',
        nodeId: 'node-2',
        confirmForce: true,
      });
      expect(k5.egressMode).toBe('node');
    });

    it('supports setKeyEgress and assignKeyNode with "none", "direct", and "node" modes', async () => {
      fetchMock
        .mockResolvedValueOnce(
          jsonResponse({
            key: {
              id: 'k-10',
              label: 'Key 10',
              last4: '1010',
              nodeId: null,
              egressMode: 'none',
              status: 'no_node',
            },
          })
        )
        .mockResolvedValueOnce(
          jsonResponse({
            key: {
              id: 'k-10',
              label: 'Key 10',
              last4: '1010',
              nodeId: null,
              egressMode: 'direct',
              status: 'active',
            },
          })
        )
        .mockResolvedValueOnce(
          jsonResponse({
            key: {
              id: 'k-10',
              label: 'Key 10',
              last4: '1010',
              nodeId: 'node-eu-1',
              egressMode: 'node',
              forcedNode: true,
              status: 'active',
            },
          })
        )
        .mockResolvedValueOnce(
          jsonResponse({
            key: {
              id: 'k-10',
              label: 'Key 10',
              last4: '1010',
              nodeId: null,
              status: 'disabled',
            },
          })
        );

      const asNone = await api.setKeyEgress('groq', 'k-10', { egressMode: 'none' });
      expect(asNone.egressMode).toBe('none');
      expect(asNone.status).toBe('no_node');
      expect(asNone.nodeId).toBeNull();
      expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
        nodeId: null,
        confirmForce: false,
        egressMode: 'none',
      });

      const asDirect = await api.setKeyEgress('groq', 'k-10', { egressMode: 'direct' });
      expect(asDirect.egressMode).toBe('direct');
      expect(asDirect.status).toBe('active');
      expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({
        nodeId: null,
        confirmForce: false,
        egressMode: 'direct',
      });

      const asNode = await api.setKeyEgress('groq', 'k-10', {
        egressMode: 'node',
        nodeId: 'node-eu-1',
        confirmForce: true,
      });
      expect(asNode.egressMode).toBe('node');
      expect(asNode.nodeId).toBe('node-eu-1');
      expect(asNode.forcedNode).toBe(true);
      expect(JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body))).toEqual({
        nodeId: 'node-eu-1',
        confirmForce: true,
        egressMode: 'node',
      });

      const asLegacyAssign = await api.assignKeyNode('groq', 'k-10', null, false, 'none');
      expect(asLegacyAssign.egressMode).toBe('none');
      expect(JSON.parse(String(fetchMock.mock.calls[3]?.[1]?.body))).toEqual({
        nodeId: null,
        confirmForce: false,
        egressMode: 'none',
      });
    });
  });

  describe('Resilient normalization for providers, metrics, benchmarks, and backups', () => {
    it('normalizes partial provider payloads without throwing on malformed schema_json', async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          providers: [
            {
              id: 'groq',
              name: 'Groq',
              schema_json: '{broken-json',
              keys: [{ id: 'k1', status: 'unknown_status' }],
            },
            {
              schema_json: JSON.stringify({
                id: 'cerebras',
                name: 'Cerebras',
                packageType: 'official-json',
                modelsSource: 'api',
                baseUrl: 'https://api.cerebras.ai/v1',
              }),
            },
          ],
        })
      );

      const res = await api.getProviders();
      expect(res.providers).toHaveLength(2);
      expect(res.providers[0]).toMatchObject({
        id: 'groq',
        name: 'Groq',
        enabled: true,
        keysCount: 1,
      });
      expect(res.providers[0]?.keys?.[0]?.status).toBe('active');
      expect(res.providers[1]).toMatchObject({
        id: 'cerebras',
        name: 'Cerebras',
        baseUrl: 'https://api.cerebras.ai/v1',
      });
    });

    it('preserves null values in metrics summary and handles empty/partial payloads', async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          usedTokensToday: 1200,
          totalDailyLimit: null,
          quotaPercentageRemaining: null,
          nextResetAt: null,
          providerQuotas: [
            {
              provider_id: 'openrouter',
              provider_name: 'OpenRouter',
              rate_limit_kind: 'requests',
              active_window: 'day',
              configured_limit: null,
              inferred_limit: null,
              effective_limit: null,
              used_in_window: 5,
              remaining_in_window: null,
              header_remaining: null,
              earliest_reset_at: null,
            },
          ],
        })
      );

      const summary = await api.getMetricsSummary();
      expect(summary.quotaPercentageRemaining).toBeNull();
      expect(summary.totalDailyLimit).toBeNull();
      expect(summary.effectiveLimit).toBeNull();
      expect(summary.nextResetAt).toBeNull();
      expect(summary.usedTokensToday).toBe(1200);
      expect(summary.providerQuotas).toHaveLength(1);
      expect(summary.providerQuotas?.[0]).toMatchObject({
        providerId: 'openrouter',
        unit: 'requests',
        configuredLimit: null,
        inferredLimit: null,
        effectiveLimit: null,
        remainingInWindow: null,
        headerRemaining: null,
        earliestResetAt: null,
      });

      // Empty partial responses on secondary metrics endpoints never throw
      fetchMock
        .mockResolvedValueOnce(jsonResponse({}))
        .mockResolvedValueOnce(jsonResponse({}))
        .mockResolvedValueOnce(jsonResponse({}))
        .mockResolvedValueOnce(jsonResponse({ providers: [{ id: 'groq', days: [{ date: '2026-01-01', totalRequests: 0, uptimePct: 100 }] }] }));

      const freeQuota = await api.getFreeQuota();
      expect(freeQuota.effectiveLimit).toBeNull();
      expect(freeQuota.quotaPercentageRemaining).toBeNull();
      expect(freeQuota.providers).toEqual([]);

      const latency = await api.getMetricsLatency();
      expect(latency).toEqual({ buckets: [], overall: null, overallRaw: null });

      const speed = await api.getMetricsSpeed();
      expect(speed).toEqual({ models: [], cacheByProvider: [] });

      const uptime = await api.getMetricsUptime();
      expect(uptime).toHaveLength(1);
      expect(uptime[0]?.days).toHaveLength(60);
      expect(uptime[0]?.overallUptimePct).toBeNull();
    });

    it('normalizes partial and complete model benchmark payloads without throwing', async () => {
      fetchMock
        .mockResolvedValueOnce(jsonResponse({}))
        .mockResolvedValueOnce(
          jsonResponse({
            canonicalModelId: 'deepseek/deepseek-r1',
            sources: {
              lmarena: {
                score: 1358,
                rank: 4,
                totalRanked: 120,
                license: 'CC BY 4.0',
              },
              artificialwatch: {
                globalIndex: 88.2,
                medianPercentile: 94,
                axes: [{ axisKey: 'coding', label: 'Código', percentile: 96 }],
              },
              epoch: {
                runs: [{ id: 'gpqa', name: 'GPQA Diamond', score: 71.5, stderr: 1.2 }],
              },
              opencharts: {
                compositeIndex: 91.4,
                grade: 'A+',
                rankRange: '#1-5',
              },
            },
          })
        );

      const emptyBench = await api.getModelBenchmarks('groq/llama-3.3-70b');
      expect(emptyBench.fullId).toBe('groq/llama-3.3-70b');
      expect(emptyBench.lmarena.available).toBe(false);
      expect(emptyBench.lmarena.score).toBeNull();
      expect(emptyBench.artificialwatch.available).toBe(false);
      expect(emptyBench.epoch.available).toBe(false);
      expect(emptyBench.opencharts.available).toBe(false);

      const fullBench = await api.getModelBenchmarks('openrouter/deepseek/deepseek-r1:free');
      expect(fullBench.canonicalModelId).toBe('deepseek/deepseek-r1');
      expect(fullBench.lmarena).toMatchObject({
        available: true,
        score: 1358,
        rank: 4,
        license: 'CC BY 4.0',
      });
      expect(fullBench.artificialwatch).toMatchObject({
        available: true,
        globalIndex: 88.2,
        medianPercentile: 94,
      });
      expect(fullBench.epoch.runs[0]).toMatchObject({
        benchmarkId: 'gpqa',
        score: 71.5,
        stderr: 1.2,
      });
      expect(fullBench.opencharts).toMatchObject({
        available: true,
        compositeIndex: 91.4,
        grade: 'A+',
        rankRange: '#1-5',
      });
    });

    it('handles backup export Blob, multipart import, base64 fallback on 415, and preserves password errors', async () => {
      const exportBytes = new Uint8Array([0x42, 0x49, 0x46, 0x31]);
      fetchMock.mockResolvedValueOnce(
        new Response(exportBytes, {
          status: 200,
          headers: { 'content-type': 'application/octet-stream' },
        })
      );

      const blob = await api.exportBackup({
        password: 'test-backup-password',
        includeProvidersAndConfig: true,
        includeProviderKeys: true,
        includeUsersAndQuotas: false,
        includeNodes: true,
      });
      expect(blob.size).toBe(4);

      // Export error throws ApiError
      fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'Contraseña demasiado corta' }, 400));
      await expect(
        api.exportBackup({
          password: '123',
          includeProvidersAndConfig: true,
          includeProviderKeys: false,
          includeUsersAndQuotas: false,
          includeNodes: false,
        })
      ).rejects.toMatchObject({
        name: 'ApiError',
        status: 400,
        message: 'Contraseña demasiado corta',
      });

      // Import fallback to JSON base64 when endpoint returns 415
      const backupFile = new File([exportBytes], 'backup.bifrost.enc', {
        type: 'application/octet-stream',
      });
      fetchMock
        .mockResolvedValueOnce(jsonResponse({ error: 'Unsupported Media Type' }, 415))
        .mockResolvedValueOnce(
          jsonResponse({
            ok: true,
            message: 'Respaldo restaurado',
            restored: { providers: 2, nodes: 1 },
          })
        );

      const imported = await api.importBackup(backupFile, 'test-backup-password');
      expect(imported).toEqual({
        ok: true,
        message: 'Respaldo restaurado',
        restored: { providers: 2, nodes: 1 },
      });
      expect(fetchMock).toHaveBeenCalledTimes(4);
      const fallbackBody = JSON.parse(String(fetchMock.mock.calls[3]?.[1]?.body)) as Record<
        string,
        unknown
      >;
      expect(fallbackBody.fileBase64).toBe(btoa('BIF1'));

      // Import password error on 400 does NOT trigger fallback retry
      fetchMock.mockResolvedValueOnce(
        jsonResponse({ error: 'Contraseña incorrecta al descifrar respaldo' }, 400)
      );
      await expect(api.importBackup(backupFile, 'wrong-pass')).rejects.toMatchObject({
        name: 'ApiError',
        status: 400,
        message: 'Contraseña incorrecta al descifrar respaldo',
      });
      expect(fetchMock).toHaveBeenCalledTimes(5);
    });
  });
});
