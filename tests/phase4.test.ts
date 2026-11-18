import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { createApp, runModelsAutoSyncTick } from '../core/src/app.js';
import {
  CACHE_KEY_AW_BENCH,
  CACHE_KEY_AW_CODING,
  CACHE_KEY_EPOCH_INTERNAL,
  CACHE_KEY_OPENCHARTS,
  buildZipArchive,
} from '../core/src/catalog/index.js';
import { hashPassword } from '../core/src/crypto.js';
import { openDatabase } from '../core/src/db.js';

function extractSessionCookie(res: Response): string {
  const setCookie = res.headers.get('set-cookie') ?? '';
  const match = /(bifrost_session=[^;]+)/.exec(setCookie);
  assert.ok(match, `Expected bifrost_session Set-Cookie header, got: ${setCookie}`);
  return match[1]!;
}

describe('Phase 4 Backend — Enriched Free Model Catalog, Monochrome SVG Logos, 4-Source Benchmarks & 6h Auto-Sync', () => {
  it('HU-14, HU-15: enriches free models via models.dev, supports GET /api/models filters & GET /api/models/:fullId, enforces guest user_model_access, and serves PWA headers', async () => {
    const db = openDatabase(':memory:');
    const masterKey = randomBytes(32);
    const tmpPanelDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bifrost-p4-panel-'));
    fs.writeFileSync(path.join(tmpPanelDir, 'index.html'), '<!doctype html><html></html>');
    fs.writeFileSync(path.join(tmpPanelDir, 'manifest.webmanifest'), '{"name":"Bifrost"}');
    fs.writeFileSync(path.join(tmpPanelDir, 'sw.js'), 'self.addEventListener("install", () => {});');

    let clockMs = Date.parse('2026-11-18T12:00:00.000Z');

    const mockModelsDevApi = {
      openrouter: {
        id: 'openrouter',
        name: 'OpenRouter',
        models: {
          'inclusionai/ling-3.2-flash:free': {
            id: 'inclusionai/ling-3.2-flash:free',
            name: 'Ling 3.2 Flash',
            family: 'ling-3.2',
            reasoning: true,
            tool_call: true,
            structured_output: true,
            release_date: '2026-11-13',
            modalities: { input: ['text', 'image'], output: ['text'] },
            open_weights: true,
            limit: { context: 1_048_576, output: 262_144 },
            cost: { input: 0, output: 0 },
          },
        },
      },
      nvidia: {
        id: 'nvidia',
        name: 'NVIDIA',
        models: {
          'nvidia/nemotron-3-ultra-550b-a55b': {
            id: 'nvidia/nemotron-3-ultra-550b-a55b',
            name: 'Nemotron 3 Ultra 550B',
            reasoning: true,
            tool_call: true,
            structured_output: false,
            release_date: '2026-10-01',
            modalities: { input: ['text'], output: ['text'] },
            open_weights: true,
            limit: { context: 131_072, output: 32_768 },
            cost: { input: 0, output: 0 },
          },
        },
      },
    };

    const mockModelsDevCanonical = {
      'inclusionai/ling-3.2-flash': {
        id: 'inclusionai/ling-3.2-flash',
        name: 'Ling 3.2 Flash',
        open_weights: true,
        limit: { context: 1_048_576, output: 262_144 },
      },
      'deepseek/deepseek-r1': {
        id: 'deepseek/deepseek-r1',
        name: 'DeepSeek R1',
        reasoning: true,
        tool_call: true,
        structured_output: true,
        release_date: '2025-01-20',
        modalities: { input: ['text'], output: ['text'] },
        open_weights: true,
        limit: { context: 65_536, output: 8_192 },
      },
    };

    const fetchMock: typeof fetch = async (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url === 'https://models.dev/api.json') {
        return new Response(JSON.stringify(mockModelsDevApi), { status: 200 });
      }
      if (url === 'https://models.dev/models.json') {
        return new Response(JSON.stringify(mockModelsDevCanonical), { status: 200 });
      }
      if (url === 'https://openrouter.example/api/v1/models') {
        return new Response(
          JSON.stringify({
            data: [
              {
                id: 'inclusionai/ling-3.2-flash:free',
                canonical_slug: 'inclusionai/ling-3.2-flash-20261113',
                pricing: { prompt: '0', completion: '0' },
              },
              {
                id: 'deepseek/deepseek-r1-0528:free',
                name: 'DeepSeek R1 0528 (free)',
                canonical_slug: 'deepseek/deepseek-r1-20250528',
                pricing: { prompt: '0', completion: '0' },
              },
              {
                id: 'mystery/unlisted-free:free',
                pricing: { prompt: '0', completion: '0' },
              },
              {
                id: 'anthropic/claude-paid',
                pricing: { prompt: '0.000003', completion: '0.000015' },
              },
            ],
          }),
          { status: 200 },
        );
      }
      if (url === 'https://nvidia.example/v1/models') {
        return new Response(
          JSON.stringify({
            data: [{ id: 'nvidia/nemotron-3-ultra-550b-a55b' }],
          }),
          { status: 200 },
        );
      }
      return new Response('Not Found', { status: 404 });
    };

    try {
      const app = createApp({
        db,
        masterKey,
        panelDistDir: tmpPanelDir,
        fetchImpl: fetchMock,
        now: () => clockMs,
      });

      // Verify PWA static asset headers (.webmanifest + /sw.js)
      const manifestRes = await app.request('/manifest.webmanifest');
      assert.equal(manifestRes.status, 200);
      assert.equal(
        manifestRes.headers.get('content-type'),
        'application/manifest+json; charset=utf-8',
      );

      const swRes = await app.request('/sw.js');
      assert.equal(swRes.status, 200);
      assert.equal(swRes.headers.get('service-worker-allowed'), '/');
      assert.equal(swRes.headers.get('cache-control'), 'no-cache, no-store, must-revalidate');

      // Setup admin
      const setupRes = await app.request('/api/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'admin', password: 'admin-password-123' }),
      });
      assert.equal(setupRes.status, 201);
      const adminCookie = extractSessionCookie(setupRes);

      // Install OpenRouter + NVIDIA NIM and detect free models
      for (const manifest of [
        {
          schemaVersion: '1.0',
          id: 'openrouter',
          name: 'OpenRouter',
          packageType: 'official-json',
          baseUrl: 'https://openrouter.example/api/v1',
          auth: { type: 'bearer', header: 'Authorization', prefix: 'Bearer ' },
          modelsSource: 'api',
          modelsEndpoint: '/models',
          freeRule: {
            priceZeroPaths: ['pricing.prompt', 'pricing.completion'],
            idSuffix: ':free',
          },
        },
        {
          schemaVersion: '1.0',
          id: 'nvidia-nim',
          name: 'NVIDIA NIM',
          packageType: 'official-json',
          baseUrl: 'https://nvidia.example/v1',
          auth: { type: 'bearer', header: 'Authorization', prefix: 'Bearer ' },
          modelsSource: 'api',
          modelsEndpoint: '/models',
        },
      ]) {
        const inst = await app.request('/api/providers', {
          method: 'POST',
          headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
          body: JSON.stringify(manifest),
        });
        assert.equal(inst.status, 201);

        await app.request(`/api/providers/${manifest.id}/keys`, {
          method: 'POST',
          headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
          body: JSON.stringify({ label: `${manifest.id} key`, secret: `sk-test-${manifest.id}-1234` }),
        });

        const det = await app.request(`/api/providers/${manifest.id}/detect-models`, {
          method: 'POST',
          headers: { Cookie: adminCookie },
        });
        assert.equal(det.status, 200);
      }

      // Check enriched models in GET /api/models
      const allModelsRes = await app.request('/api/models', {
        headers: { Cookie: adminCookie },
      });
      assert.equal(allModelsRes.status, 200);
      const allModelsBody = (await allModelsRes.json()) as {
        models: Array<{
          fullId: string;
          providerId: string;
          canonicalModelId: string | null;
          name: string;
          contextLength: number | null;
          maxOutput: number | null;
          modalities: { input: string[]; output: string[] };
          capabilities: { tools: boolean; reasoning: boolean; structuredOutput: boolean };
          upstreamCreatedAt: number | null;
        }>;
      };
      assert.equal(allModelsBody.models.length, 4);

      const ling = allModelsBody.models.find(
        (m) => m.fullId === 'openrouter/inclusionai/ling-3.2-flash:free',
      )!;
      assert.equal(ling.canonicalModelId, 'inclusionai/ling-3.2-flash');
      assert.equal(ling.name, 'Ling 3.2 Flash');
      assert.equal(ling.contextLength, 1_048_576);
      assert.equal(ling.maxOutput, 262_144);
      assert.deepEqual(ling.modalities, { input: ['text', 'image'], output: ['text'] });
      assert.deepEqual(ling.capabilities, {
        tools: true,
        reasoning: true,
        structuredOutput: true,
      });
      assert.equal(ling.upstreamCreatedAt, Math.floor(Date.parse('2026-11-13T00:00:00Z') / 1000));

      const r1 = allModelsBody.models.find(
        (m) => m.fullId === 'openrouter/deepseek/deepseek-r1-0528:free',
      )!;
      assert.equal(r1.canonicalModelId, 'deepseek/deepseek-r1');
      assert.equal(r1.contextLength, 65_536);
      assert.equal(r1.maxOutput, 8_192);

      // Unknown model preserves null (NEVER turns null into 0)
      const mystery = allModelsBody.models.find(
        (m) => m.fullId === 'openrouter/mystery/unlisted-free:free',
      )!;
      assert.equal(mystery.contextLength, null);
      assert.equal(mystery.maxOutput, null);

      // Filter by modality=image
      const imgRes = await app.request('/api/models?modality=image', {
        headers: { Cookie: adminCookie },
      });
      const imgBody = (await imgRes.json()) as { models: Array<{ fullId: string }> };
      assert.deepEqual(
        imgBody.models.map((m) => m.fullId),
        ['openrouter/inclusionai/ling-3.2-flash:free'],
      );

      // Filter by provider=nvidia-nim
      const nvRes = await app.request('/api/models?provider=nvidia-nim', {
        headers: { Cookie: adminCookie },
      });
      const nvBody = (await nvRes.json()) as { models: Array<{ fullId: string }> };
      assert.deepEqual(
        nvBody.models.map((m) => m.fullId),
        ['nvidia-nim/nvidia/nemotron-3-ultra-550b-a55b'],
      );

      // Filter by capability=structuredOutput & q=deepseek
      const qRes = await app.request('/api/models?capability=structuredOutput&q=deepseek', {
        headers: { Cookie: adminCookie },
      });
      const qBody = (await qRes.json()) as { models: Array<{ fullId: string }> };
      assert.deepEqual(
        qBody.models.map((m) => m.fullId),
        ['openrouter/deepseek/deepseek-r1-0528:free'],
      );

      // GET /api/models/:fullId with BOTH URL-encoded %2F and raw multi-segment path
      const detailEncoded = await app.request(
        `/api/models/${encodeURIComponent('openrouter/inclusionai/ling-3.2-flash:free')}`,
        { headers: { Cookie: adminCookie } },
      );
      assert.equal(detailEncoded.status, 200);
      const detailEncodedBody = (await detailEncoded.json()) as {
        fullId: string;
        logoSlug: string;
      };
      assert.equal(detailEncodedBody.fullId, 'openrouter/inclusionai/ling-3.2-flash:free');
      assert.equal(detailEncodedBody.logoSlug, 'openrouter');

      const detailRaw = await app.request(
        '/api/models/nvidia-nim/nvidia/nemotron-3-ultra-550b-a55b',
        { headers: { Cookie: adminCookie } },
      );
      assert.equal(detailRaw.status, 200);
      const detailRawBody = (await detailRaw.json()) as { fullId: string; logoSlug: string };
      assert.equal(detailRawBody.fullId, 'nvidia-nim/nvidia/nemotron-3-ultra-550b-a55b');
      assert.equal(detailRawBody.logoSlug, 'nvidia');

      // Guest isolation on GET /api/models and GET /api/models/:fullId
      const guestId = randomUUID();
      const guestHash = await hashPassword('guest-pass-123');
      db.prepare(
        `INSERT INTO users (id, username, password_hash, role, daily_token_limit, quota_reset_mode, created_at)
         VALUES (?, 'guest1', ?, 'guest', 10000, 'utc_midnight', ?)`,
      ).run(guestId, guestHash, Math.floor(clockMs / 1000));
      db.prepare(
        `INSERT INTO user_model_access (user_id, model_full_id)
         VALUES (?, 'openrouter/deepseek/deepseek-r1-0528:free')`,
      ).run(guestId);

      const guestLogin = await app.request('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'guest1', password: 'guest-pass-123' }),
      });
      const guestCookie = extractSessionCookie(guestLogin);

      const guestModelsRes = await app.request('/api/models', {
        headers: { Cookie: guestCookie },
      });
      const guestModelsBody = (await guestModelsRes.json()) as {
        models: Array<{ fullId: string }>;
      };
      assert.deepEqual(
        guestModelsBody.models.map((m) => m.fullId),
        ['openrouter/deepseek/deepseek-r1-0528:free'],
      );

      const guestForbiddenDetail = await app.request(
        `/api/models/${encodeURIComponent('openrouter/inclusionai/ling-3.2-flash:free')}`,
        { headers: { Cookie: guestCookie } },
      );
      assert.equal(guestForbiddenDetail.status, 403);
    } finally {
      db.close();
      fs.rmSync(tmpPanelDir, { recursive: true, force: true });
    }
  });

  it('HU-14b, HU-14c: sanitizes SVG logos (GET /api/logos/:slug) and enforces fail-closed benchmark stripping (anti-raw AW, anti-_external.csv Epoch) on GET /api/models/:fullId/benchmarks', async () => {
    const db = openDatabase(':memory:');
    const masterKey = randomBytes(32);
    let clockMs = Date.parse('2026-11-18T14:00:00.000Z');
    let offlineMode = false;

    const untrustedSvg = `
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" onload="alert(1)" style="fill:#ff0099">
        <script>window.stealCookies()</script>
        <foreignObject><iframe src="https://evil.example"></iframe></foreignObject>
        <a href="javascript:alert(2)"><path d="M1 1h22v22H1z" fill="#FF3300" stroke="#112233" onclick="evil()" /></a>
        <circle cx="12" cy="12" r="4" fill="none" stroke="#abcdef" />
      </svg>
    `;

    const epochZipBuffer = buildZipArchive([
      {
        filename: 'gpqa_diamond.csv',
        content: [
          'Model version,mean_score,Best score (across scorers),Release date,Organization,stderr,Started at',
          'deepseek-r1,0.715,0.728,2025-01-20,DeepSeek,0.018,2026-02-15',
        ].join('\n'),
      },
      {
        filename: 'aider_polyglot_external.csv',
        content: [
          'Model version,mean_score,Best score (across scorers),stderr',
          'deepseek-r1,0.999,0.999,0.001',
        ].join('\n'),
      },
      {
        filename: 'sneaky_external_with_source.csv',
        content: [
          'Model version,mean_score,Best score (across scorers),stderr,Source',
          'deepseek-r1,0.888,0.888,0.01,ThirdPartyBoard',
        ].join('\n'),
      },
      {
        filename: 'epoch_capabilities_index/processed_data_for_eci.csv',
        content: ['model,benchmark,score,source', 'deepseek-r1,ARC-AGI,0.777,'].join('\n'),
      },
      {
        filename: 'epoch_capabilities_index/eci_scores.csv',
        content: [
          'Model,Display name,eci,eci_ci_low,eci_ci_high,date,Organization',
          'deepseek-r1,DeepSeek R1,142.5,139.0,146.0,2025-01-20,DeepSeek',
        ].join('\n'),
      },
    ]);

    const fetchMock: typeof fetch = async (input) => {
      if (offlineMode) {
        throw new Error('ECONNREFUSED simulated offline');
      }
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

      if (url === 'https://models.dev/logos/openrouter.svg') {
        return new Response(untrustedSvg, { status: 200 });
      }
      if (url.startsWith('https://models.dev/logos/')) {
        return new Response('Not Found', { status: 404 });
      }
      if (url.includes('lmarena-ai%2Fleaderboard-dataset')) {
        return new Response(
          JSON.stringify({
            rows: [
              {
                row: {
                  model_name: 'DeepSeek R1',
                  organization: 'DeepSeek',
                  license: 'MIT',
                  score: 0.2415,
                  score_ci_lower: 0.221,
                  score_ci_upper: 0.262,
                  session_count: 8400,
                  observation_count: 520000,
                  rank: 3,
                  category: 'overall',
                  cost_per_task_p50: 0.42,
                },
              },
              {
                row: {
                  model_name: 'Qwen 3.6 Plus',
                  organization: 'Qwen',
                  score: 0.219,
                  score_ci_lower: 0.198,
                  score_ci_upper: 0.239,
                  session_count: 6100,
                  rank: 5,
                },
              },
            ],
          }),
          { status: 200 },
        );
      }
      if (url === 'https://artificialwatch.com/data/bench-index.json') {
        return new Response(
          JSON.stringify({
            url: 'https://artificialwatch.com',
            generatedAt: '2026-11-17',
            license: 'https://creativecommons.org/licenses/by/4.0/',
            sources: { arena: { name: 'LMArena' }, aa: { name: 'Artificial Analysis' } },
            models: [
              {
                id: 'deepseek-r1',
                name: 'DeepSeek R1',
                vendor: 'DeepSeek',
                index: 88.4,
                scores: {
                  arena: { raw: 1399.777, percentile: 91.2 },
                  aa: { raw: 64.563, percentile: 87.5 },
                },
              },
            ],
          }),
          { status: 200 },
        );
      }
      if (url === 'https://artificialwatch.com/data/coding-index.json') {
        return new Response(JSON.stringify({ models: [] }), { status: 200 });
      }
      if (url === 'https://epoch.ai/data/benchmark_data.zip') {
        return new Response(new Uint8Array(epochZipBuffer), {
          status: 200,
          headers: { 'content-type': 'application/zip' },
        });
      }
      if (url === 'https://www.opencharts.com/benchmarks/rankings.json') {
        return new Response(
          JSON.stringify({
            generatedAt: '2026-11-17T00:00:00Z',
            models: [
              {
                slug: 'deepseek-r1',
                name: 'DeepSeek R1',
                lab: 'DeepSeek',
                rank: 5,
                rankRange: { min: 4, max: 6 },
                index: 89.2,
                grade: 'A-',
                scores: [{ benchmark: 'scicode', value: 0.612345 }],
              },
            ],
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({}), { status: 200 });
    };

    try {
      const app = createApp({
        db,
        masterKey,
        fetchImpl: fetchMock,
        now: () => clockMs,
      });

      const setupRes = await app.request('/api/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'admin', password: 'admin-password-123' }),
      });
      const adminCookie = extractSessionCookie(setupRes);

      const nowSec = Math.floor(clockMs / 1000);
      db.prepare(
        `INSERT INTO providers (id, name, package_type, models_source, schema_json, enabled, created_at)
         VALUES ('openrouter', 'OpenRouter', 'official-json', 'api', '{}', 1, ?)`,
      ).run(nowSec);
      db.prepare(
        `INSERT INTO models (
           full_id, provider_id, model_id, canonical_model_id, name,
           modalities_json, capabilities_json, is_free, first_seen_at, active
         ) VALUES (
           'openrouter/deepseek/deepseek-r1:free', 'openrouter', 'deepseek/deepseek-r1:free',
           'deepseek/deepseek-r1', 'DeepSeek R1', '{"input":["text"],"output":["text"]}',
           '{"tools":true,"reasoning":true,"structured_output":true}', 1, ?, 1
         )`,
      ).run(nowSec);

      // 1. Test GET /api/logos/:slug JSON & raw SVG modes + strict XSS sanitization
      const logoJsonRes = await app.request('/api/logos/openrouter', {
        headers: { Cookie: adminCookie, Accept: 'image/svg+xml, application/json' },
      });
      assert.equal(logoJsonRes.status, 200);
      const logoBody = (await logoJsonRes.json()) as {
        hasLogo: boolean;
        slug: string;
        svg: string;
      };
      assert.equal(logoBody.hasLogo, true);
      assert.equal(/<script/i.test(logoBody.svg), false);
      assert.equal(/<foreignObject/i.test(logoBody.svg), false);
      assert.equal(/onload|onclick|javascript:/i.test(logoBody.svg), false);
      assert.equal(/#FF3300|#112233|#abcdef|#ff0099/i.test(logoBody.svg), false);
      assert.match(logoBody.svg, /fill="currentColor"/);
      assert.match(logoBody.svg, /stroke="currentColor"/);
      assert.match(logoBody.svg, /fill="none"/);

      const logoRawSvgRes = await app.request('/api/logos/openrouter', {
        headers: { Cookie: adminCookie, Accept: 'image/svg+xml' },
      });
      assert.equal(logoRawSvgRes.status, 200);
      assert.match(logoRawSvgRes.headers.get('content-type') ?? '', /image\/svg\+xml/);

      const missingLogoRes = await app.request('/api/logos/custom-sidecar', {
        headers: { Cookie: adminCookie },
      });
      assert.equal(missingLogoRes.status, 200);
      const missingLogoBody = (await missingLogoRes.json()) as {
        hasLogo: boolean;
        svg: string | null;
        initial: string;
      };
      assert.equal(missingLogoBody.hasLogo, false);
      assert.equal(missingLogoBody.svg, null);
      assert.equal(missingLogoBody.initial, 'C');

      // 2. Test GET /api/models/:fullId/benchmarks across all 4 sources
      const benchRes = await app.request(
        `/api/models/${encodeURIComponent('openrouter/deepseek/deepseek-r1:free')}/benchmarks`,
        { headers: { Cookie: adminCookie } },
      );
      assert.equal(benchRes.status, 200);
      const rawBenchText = await benchRes.text();

      // Anti-raw & anti-external leak assertions on HTTP body
      assert.equal(rawBenchText.includes('"raw"'), false);
      assert.equal(rawBenchText.includes('1399.777'), false);
      assert.equal(rawBenchText.includes('64.563'), false);
      assert.equal(rawBenchText.includes('0.999'), false);
      assert.equal(rawBenchText.includes('0.888'), false);
      assert.equal(rawBenchText.includes('0.777'), false);
      assert.equal(rawBenchText.includes('aider_polyglot'), false);
      assert.equal(rawBenchText.includes('0.612345'), false);

      const bench = JSON.parse(rawBenchText) as {
        fullId: string;
        canonicalModelId: string;
        lmarena: {
          available: boolean;
          score: number;
          ciLower: number;
          ciUpper: number;
          sessionsOrVotes: number;
          license: string;
          rankingPeers: Array<{ modelId: string; isCurrent: boolean }>;
        };
        artificialwatch: {
          available: boolean;
          globalIndex: number;
          medianPercentile: number;
          license: string;
          axes: Array<{ axisKey: string; percentile: number }>;
        };
        epoch: {
          available: boolean;
          license: string;
          runs: Array<{ benchmarkId: string; score: number; stderr: number }>;
          eci: { eci: number };
        };
        opencharts: {
          available: boolean;
          compositeIndex: number;
          grade: string;
          rankRange: string;
          methodologyUrl: string;
        };
      };

      assert.equal(bench.fullId, 'openrouter/deepseek/deepseek-r1:free');
      assert.equal(bench.lmarena.available, true);
      assert.equal(bench.lmarena.score, 0.2415);
      assert.equal(bench.lmarena.ciLower, 0.221);
      assert.equal(bench.lmarena.ciUpper, 0.262);
      assert.equal(bench.lmarena.sessionsOrVotes, 8400);
      assert.equal(bench.lmarena.license, 'CC BY 4.0');
      assert.equal(bench.lmarena.rankingPeers.length, 2);
      assert.equal(bench.lmarena.rankingPeers[0]?.isCurrent, true);

      assert.equal(bench.artificialwatch.available, true);
      assert.equal(bench.artificialwatch.globalIndex, 88.4);
      assert.equal(bench.artificialwatch.license, 'CC BY 4.0');
      assert.equal(bench.artificialwatch.axes.length, 2);

      assert.equal(bench.epoch.available, true);
      assert.equal(bench.epoch.license, 'CC BY 4.0');
      assert.equal(bench.epoch.runs.length, 1);
      assert.equal(bench.epoch.runs[0]?.benchmarkId, 'gpqa_diamond');
      assert.equal(bench.epoch.runs[0]?.score, 0.715);
      assert.equal(bench.epoch.runs[0]?.stderr, 0.018);
      assert.equal(bench.epoch.eci.eci, 142.5);

      assert.equal(bench.opencharts.available, true);
      assert.equal(bench.opencharts.compositeIndex, 89.2);
      assert.equal(bench.opencharts.grade, 'A-');
      assert.equal(bench.opencharts.rankRange, '#4–#6');
      assert.equal(
        bench.opencharts.methodologyUrl,
        'https://www.opencharts.com/benchmarks/methodology',
      );

      // Verify SQLite external_cache ALSO stripped raw & external CSV data BEFORE persistence
      for (const key of [
        CACHE_KEY_AW_BENCH,
        CACHE_KEY_AW_CODING,
        CACHE_KEY_EPOCH_INTERNAL,
        CACHE_KEY_OPENCHARTS,
      ]) {
        const row = db
          .prepare(`SELECT payload_json FROM external_cache WHERE cache_key = ?`)
          .get(key) as { payload_json: string };
        assert.equal(row.payload_json.includes('"raw"'), false);
        assert.equal(row.payload_json.includes('1399.777'), false);
        assert.equal(row.payload_json.includes('0.999'), false);
        assert.equal(row.payload_json.includes('0.612345'), false);
      }

      // 3. Offline cache fallback past TTL
      offlineMode = true;
      clockMs += 10 * 24 * 3600 * 1000;
      const offlineBenchRes = await app.request(
        '/api/models/openrouter/deepseek/deepseek-r1:free/benchmarks',
        { headers: { Cookie: adminCookie } },
      );
      assert.equal(offlineBenchRes.status, 200);
      const offlineBench = (await offlineBenchRes.json()) as {
        lmarena: { available: boolean };
      };
      assert.equal(offlineBench.lmarena.available, true);
    } finally {
      db.close();
    }
  });

  it('HU-16: runModelsAutoSyncTick updates ONLY enabled providers with models_source="api", skips static/disabled, and logs sync diffs without secrets', async () => {
    const db = openDatabase(':memory:');
    const masterKey = randomBytes(32);
    let clockMs = Date.parse('2026-11-18T16:00:00.000Z');
    const calledUrls: string[] = [];

    const fetchMock: typeof fetch = async (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      calledUrls.push(url);
      if (url.startsWith('https://models.dev/')) {
        return new Response(JSON.stringify({}), { status: 200 });
      }
      if (url === 'https://openrouter.example/api/v1/models') {
        return new Response(
          JSON.stringify({
            data: [
              {
                id: 'keep-free:free',
                name: 'Keep Free',
                pricing: { prompt: '0', completion: '0' },
              },
              {
                id: 'new-free:free',
                name: 'New Free',
                pricing: { prompt: '0', completion: '0' },
              },
            ],
          }),
          { status: 200 },
        );
      }
      throw new Error(`Unexpected URL called during auto-sync: ${url}`);
    };

    try {
      const app = createApp({
        db,
        masterKey,
        fetchImpl: fetchMock,
        now: () => clockMs,
      });

      const setupRes = await app.request('/api/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'admin', password: 'admin-password-123' }),
      });
      const adminCookie = extractSessionCookie(setupRes);
      const adminBody = (await setupRes.json()) as { user: { id: string } };

      // 1. Eligible API provider (enabled = 1, models_source = 'api')
      await app.request('/api/providers', {
        method: 'POST',
        headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          schemaVersion: '1.0',
          id: 'openrouter',
          name: 'OpenRouter',
          packageType: 'official-json',
          baseUrl: 'https://openrouter.example/api/v1',
          auth: { type: 'bearer', header: 'Authorization', prefix: 'Bearer ' },
          modelsSource: 'api',
          modelsEndpoint: '/models',
          freeRule: { priceZeroPaths: ['pricing.prompt', 'pricing.completion'], idSuffix: ':free' },
        }),
      });
      const secretKey = 'sk-or-v1-ultra-secret-sync-key-7788';
      await app.request('/api/providers/openrouter/keys', {
        method: 'POST',
        headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ label: 'Sync Key', secret: secretKey }),
      });

      // 2. Static provider (enabled = 1, models_source = 'static') — MUST BE SKIPPED!
      await app.request('/api/providers', {
        method: 'POST',
        headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          schemaVersion: '1.0',
          id: 'sidecar-static',
          name: 'Sidecar Static',
          packageType: 'experimental-adapter',
          baseUrl: 'http://127.0.0.1:4111/v1',
          auth: { type: 'bearer', header: 'Authorization' },
          modelsSource: 'static',
          reviewedAt: '2026-11-18',
          staticModels: [{ id: 'static-chat', name: 'Static Chat' }],
          adapter: { defaultPort: 4111, healthPath: '/health' },
        }),
      });

      // 3. Disabled API provider (enabled = 0, models_source = 'api') — MUST BE SKIPPED!
      db.prepare(
        `INSERT INTO providers (id, name, package_type, models_source, schema_json, enabled, created_at)
         VALUES ('disabled-api', 'Disabled API', 'official-json', 'api', '{"baseUrl":"https://disabled.example/v1","modelsEndpoint":"/models","auth":{"type":"none","header":"Authorization"}}', 0, ?)`,
      ).run(Math.floor(clockMs / 1000));

      // Seed pre-existing models on openrouter
      const initialSec = Math.floor(clockMs / 1000) - 86400;
      db.prepare(
        `INSERT INTO models (full_id, provider_id, model_id, name, modalities_json, capabilities_json, is_free, first_seen_at, active)
         VALUES
           ('openrouter/keep-free:free', 'openrouter', 'keep-free:free', 'Keep Free', '{}', '{}', 1, ?, 1),
           ('openrouter/retired-used:free', 'openrouter', 'retired-used:free', 'Retired Used', '{}', '{}', 1, ?, 1),
           ('openrouter/retired-unused:free', 'openrouter', 'retired-unused:free', 'Retired Unused', '{}', '{}', 1, ?, 1)`,
      ).run(initialSec, initialSec, initialSec);

      db.prepare(
        `INSERT INTO usage_logs (user_id, provider_id, model_full_id, duration_ms, status, created_at)
         VALUES (?, 'openrouter', 'openrouter/retired-used:free', 150, 'ok', ?)`,
      ).run(adminBody.user.id, initialSec + 60);

      const syncNowSec = Math.floor(clockMs / 1000);
      const tickResult = await runModelsAutoSyncTick(db, masterKey, {
        fetchImpl: fetchMock,
        nowSec: syncNowSec,
      });

      assert.equal(tickResult.providersChecked, 1);
      assert.equal(tickResult.skippedStaticOrDisabled, 2);
      assert.deepEqual(tickResult.summaries, [
        {
          providerId: 'openrouter',
          status: 'synced',
          added: 1,
          updated: 1,
          removedOrDeactivated: 2,
        },
      ]);

      // Verify neither static nor disabled provider URLs were contacted
      assert.equal(
        calledUrls.some((u) => u.includes('127.0.0.1:4111') || u.includes('disabled.example')),
        false,
      );

      // Verify first_seen_at preserved on keep-free, deactivated on retired-used, deleted on retired-unused
      const keepRow = db
        .prepare(`SELECT first_seen_at, active FROM models WHERE full_id = 'openrouter/keep-free:free'`)
        .get() as { first_seen_at: number; active: number };
      assert.equal(keepRow.first_seen_at, initialSec);
      assert.equal(keepRow.active, 1);

      const usedRow = db
        .prepare(`SELECT active FROM models WHERE full_id = 'openrouter/retired-used:free'`)
        .get() as { active: number };
      assert.equal(usedRow.active, 0);

      const unusedRow = db
        .prepare(`SELECT 1 FROM models WHERE full_id = 'openrouter/retired-unused:free'`)
        .get();
      assert.equal(unusedRow, undefined);

      // Verify system_logs category='sync' recorded with zero leaked secrets
      const syncLogs = db
        .prepare(`SELECT message, meta_json FROM system_logs WHERE category = 'sync'`)
        .all() as Array<{ message: string; meta_json: string | null }>;
      assert.ok(syncLogs.length >= 1);
      for (const log of syncLogs) {
        assert.equal(log.message.includes(secretKey), false);
        assert.equal((log.meta_json ?? '').includes(secretKey), false);
      }
    } finally {
      db.close();
    }
  });
});
