import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import {
  CACHE_KEY_AW_BENCH,
  CACHE_KEY_AW_CODING,
  CACHE_KEY_EPOCH_INTERNAL,
  CACHE_KEY_LMARENA_AGENT,
  CACHE_KEY_OPENCHARTS,
  OPENCHARTS_LICENSE_URL,
  buildZipArchive,
  crc32,
  filterArtificialWatchPayload,
  filterLmArenaPayload,
  filterOpenChartsPayload,
  getCachedModelBenchmarks,
  getProviderLogo,
  loadModelsDevSnapshot,
  parseCsvRows,
  readExternalCache,
  readZipArchive,
  resolveAndSyncModelBenchmarks,
  resolveCanonicalAndEnrichModel,
  sanitizeAndMonochromeSvg,
  syncEpochAiBenchmarks,
  syncLmArenaAgentBenchmarks,
  writeExternalCache,
} from '../core/src/catalog/index.js';
import {
  LEGACY_OFFICIAL_MARKETPLACE_SOURCE_URL,
  OFFICIAL_MARKETPLACE_SOURCE_URL,
  openDatabase,
} from '../core/src/db.js';
import {
  addMarketplaceSource,
  fetchAndMergeMarketplaceCatalog,
  isKnownUnapprovedMarketplaceId,
  normalizeMarketplaceSourceUrl,
  validateMarketplaceSourceUrl,
} from '../core/src/marketplace.js';
import { formatModelRow } from '../core/src/models-sync.js';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const SCHEMAS_DIR = path.join(REPO_ROOT, 'schemas');

describe('Ola 6 — Benchmarks Matching (Nemotron & Short Models), Licenses, Cache, Marketplace, Logos & ZIP', () => {
  it('matches Nemotron tiers, NVFP4 quant suffixes, and short model IDs (o3) while blocking gpt-4.1/gpt-41 and 8b/70b collisions', async () => {
    const db = openDatabase(':memory:');
    const nowSec = 1_795_000_000;
    try {
      const lmSnap = filterLmArenaPayload(
        {
          rows: [
            {
              row: {
                model_name: 'Nemotron 3 Ultra',
                organization: 'NVIDIA',
                score: 0.312,
                rank: 2,
                session_count: 4200,
                observation_count: 150000,
                category: 'coding',
              },
            },
            {
              row: {
                model_name: 'NVIDIA-Nemotron-3.5-Super-VL-120B-A12B (NVFP4)',
                organization: 'NVIDIA',
                score: 0.289,
                rank: 4,
                session_count: 3100,
                category: 'overall',
              },
            },
            {
              row: {
                model_name: 'nemotron-3-super',
                organization: 'NVIDIA',
                score: 0.265,
                rank: 7,
                session_count: 2500,
              },
            },
            {
              row: {
                model_name: 'o3',
                organization: 'OpenAI',
                score: 0.355,
                rank: 1,
                session_count: 9000,
                category: 'agent-hard',
              },
            },
            {
              row: {
                model_name: 'gpt-41',
                organization: 'OpenAI',
                score: 0.111,
                rank: 50,
              },
            },
            {
              row: {
                model_name: 'llama-3.1-70b',
                organization: 'Meta',
                score: 0.222,
                rank: 20,
              },
            },
            {
              row: {
                model_name: 'nemotron-nano-12b',
                organization: 'NVIDIA',
                score: 0.144,
                rank: 35,
              },
            },
            {
              row: {
                model_name: 'model-11.2b',
                organization: 'Test',
                score: 0.155,
                rank: 36,
              },
            },
          ],
        },
        '2026-11-26T00:00:00.000Z',
      );
      writeExternalCache(db, CACHE_KEY_LMARENA_AGENT, lmSnap, '"lma-etag"', nowSec);

      // 1. NVIDIA Nemotron 3 Ultra 550B (free) matches "Nemotron 3 Ultra"
      const nemotronUltra = getCachedModelBenchmarks(db, {
        canonicalModelId: 'nvidia/nemotron-3-ultra-550b-a55b',
        modelId: 'nvidia/nemotron-3-ultra-550b-a55b:free',
        name: 'NVIDIA: Nemotron 3 Ultra (free)',
      });
      assert.ok(nemotronUltra.lmarena);
      assert.equal(nemotronUltra.lmarena.entry.model, 'Nemotron 3 Ultra');
      assert.equal(nemotronUltra.lmarena.entry.score, 0.312);

      // Even without display name, MoE-stripped tiered secondary matches "Nemotron 3 Ultra"
      const nemotronUltraIdOnly = getCachedModelBenchmarks(db, {
        canonicalModelId: 'nvidia/nemotron-3-ultra-550b-a55b',
        modelId: 'nvidia/nemotron-3-ultra-550b-a55b',
      });
      assert.ok(nemotronUltraIdOnly.lmarena);
      assert.equal(nemotronUltraIdOnly.lmarena.entry.model, 'Nemotron 3 Ultra');

      // 2. NVIDIA Nemotron 3.5 Super VL 120B A12B matches "NVIDIA-Nemotron-3.5-Super-VL-120B-A12B (NVFP4)"
      const nemotronSuperVl = getCachedModelBenchmarks(db, {
        canonicalModelId: 'nvidia/nemotron-3.5-super-vl-120b-a12b',
        modelId: 'nvidia/nemotron-3.5-super-vl-120b-a12b',
      });
      assert.ok(nemotronSuperVl.lmarena);
      assert.equal(
        nemotronSuperVl.lmarena.entry.model,
        'NVIDIA-Nemotron-3.5-Super-VL-120B-A12B (NVFP4)',
      );

      // 3. NVIDIA Nemotron 3 Super 120B A12B matches "nemotron-3-super"
      const nemotronSuper = getCachedModelBenchmarks(db, {
        canonicalModelId: 'nvidia/nemotron-3-super-120b-a12b',
        modelId: 'nvidia/nemotron-3-super-120b-a12b',
      });
      assert.ok(nemotronSuper.lmarena);
      assert.equal(nemotronSuper.lmarena.entry.model, 'nemotron-3-super');

      // 4. Short known model ID openai/o3 matches "o3"
      const o3 = getCachedModelBenchmarks(db, {
        canonicalModelId: 'openai/o3',
        modelId: 'openai/o3',
        name: 'OpenAI o3',
      });
      assert.ok(o3.lmarena);
      assert.equal(o3.lmarena.entry.model, 'o3');
      assert.equal(o3.lmarena.entry.category, 'agent-hard');

      // 5. NO collision between gpt-4.1 vs gpt-41
      const gpt41Dot = getCachedModelBenchmarks(db, {
        canonicalModelId: 'openai/gpt-4.1',
        modelId: 'openai/gpt-4.1',
        name: 'GPT-4.1',
      });
      assert.equal(gpt41Dot.lmarena, null);

      // 6. NO collision between llama-3.1-8b vs llama-3.1-70b
      const llama8b = getCachedModelBenchmarks(db, {
        canonicalModelId: 'meta-llama/llama-3.1-8b',
        modelId: 'meta-llama/llama-3.1-8b',
        name: 'Llama 3.1 8B',
      });
      assert.equal(llama8b.lmarena, null);

      // 7. NO collision between nemotron-nano-9b vs nemotron-nano-12b
      const nano9b = getCachedModelBenchmarks(db, {
        canonicalModelId: 'nvidia/nemotron-nano-9b',
        modelId: 'nvidia/nemotron-nano-9b',
      });
      assert.equal(nano9b.lmarena, null);

      // 8. NO collision between model-1.12b vs model-11.2b
      const m112 = getCachedModelBenchmarks(db, {
        canonicalModelId: 'test/model-1.12b',
        modelId: 'test/model-1.12b',
      });
      assert.equal(m112.lmarena, null);

      // 8b. Dense sizes & distinct MoE sizes NEVER collide (qwen2.5-omni-3b vs 7b, nemotron-3-super-49b vs 120b-a12b, 200b-a20b vs 120b-a12b)
      const sizeGuardSnap = filterLmArenaPayload(
        {
          rows: [
            { row: { model_name: 'qwen2.5-omni-7b', score: 0.18 } },
            { row: { model_name: 'nvidia/nemotron-3-super-120b-a12b', score: 0.27 } },
          ],
        },
        '2026-11-26T00:00:00.000Z',
      );
      writeExternalCache(db, CACHE_KEY_LMARENA_AGENT, sizeGuardSnap, null, nowSec);

      const qwenOmni3b = getCachedModelBenchmarks(db, {
        canonicalModelId: 'qwen/qwen2.5-omni-3b',
        modelId: 'qwen/qwen2.5-omni-3b',
      });
      assert.equal(qwenOmni3b.lmarena, null, 'qwen2.5-omni-3b must NOT match qwen2.5-omni-7b');

      const nemotronSuper49b = getCachedModelBenchmarks(db, {
        canonicalModelId: 'nvidia/nemotron-3-super-49b',
        modelId: 'nvidia/nemotron-3-super-49b',
      });
      assert.equal(
        nemotronSuper49b.lmarena,
        null,
        'nvidia/nemotron-3-super-49b must NOT collide with nvidia/nemotron-3-super-120b-a12b',
      );

      const nemotronSuper200b = getCachedModelBenchmarks(db, {
        canonicalModelId: 'nvidia/nemotron-3-super-200b-a20b',
        modelId: 'nvidia/nemotron-3-super-200b-a20b',
      });
      assert.equal(
        nemotronSuper200b.lmarena,
        null,
        'distinct MoE sizes (200b-a20b vs 120b-a12b) must NOT collide via secondary keys',
      );

      // 9. Exact match takes priority over secondary quant-stripped match
      const exactPlusQuantSnap = filterLmArenaPayload(
        {
          rows: [
            { row: { model_name: 'NVIDIA-Nemotron-3.5-Super-VL-120B-A12B (NVFP4)', score: 0.25 } },
            { row: { model_name: 'nemotron-3.5-super-vl-120b-a12b', score: 0.30 } },
          ],
        },
        '2026-11-26T00:00:00.000Z',
      );
      writeExternalCache(db, CACHE_KEY_LMARENA_AGENT, exactPlusQuantSnap, null, nowSec);
      const exactWin = getCachedModelBenchmarks(db, {
        canonicalModelId: 'nvidia/nemotron-3.5-super-vl-120b-a12b',
        modelId: 'nvidia/nemotron-3.5-super-vl-120b-a12b',
      });
      assert.equal(exactWin.lmarena?.entry.model, 'nemotron-3.5-super-vl-120b-a12b');
      assert.equal(exactWin.lmarena?.entry.score, 0.30);

      // 10. parseCsvRows only activates quotes when field.length === 0
      const csvRows = parseCsvRows('a,b,c\nfoo"bar,baz,"hello, ""world"""\n');
      assert.deepEqual(csvRows, [
        ['a', 'b', 'c'],
        ['foo"bar', 'baz', 'hello, "world"'],
      ]);

      // 11. Defensive pagination in syncLmArenaAgentBenchmarks when num_rows_total > 100
      const fetchedOffsets: number[] = [];
      const paginatedSnap = await syncLmArenaAgentBenchmarks(db, {
        forceRefresh: true,
        nowSec: nowSec + 10,
        fetchFn: async (input) => {
          const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
          const offset = Number(url.searchParams.get('offset') ?? '0');
          fetchedOffsets.push(offset);
          return new Response(
            JSON.stringify({
              num_rows_total: 230,
              rows: [{ row: { model_name: `model-offset-${offset}`, score: 0.5 + offset / 1000, rank: offset + 1 } }],
            }),
            { status: 200 },
          );
        },
      });
      assert.deepEqual(fetchedOffsets, [0, 100, 200]);
      assert.equal(paginatedSnap?.entries.length, 3);

      // 12. Truncated pagination (failure on offset >= 100) must NOT persist page-0 ETag
      const truncSnap = await syncLmArenaAgentBenchmarks(db, {
        forceRefresh: true,
        nowSec: nowSec + 20,
        fetchFn: async (input) => {
          const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
          const offset = Number(url.searchParams.get('offset') ?? '0');
          if (offset === 0) {
            return new Response(
              JSON.stringify({
                num_rows_total: 200,
                rows: [{ row: { model_name: 'model-page-0', score: 0.4, rank: 1 } }],
              }),
              { status: 200, headers: { etag: '"should-not-persist"' } },
            );
          }
          return new Response('Upstream Timeout', { status: 504 });
        },
      });
      assert.equal(truncSnap?.entries.length, 1);
      const cachedTrunc = readExternalCache(db, CACHE_KEY_LMARENA_AGENT);
      assert.equal(cachedTrunc?.etag, null, 'Truncated LMArena snapshot must not save ETag');
    } finally {
      db.close();
    }
  });

  it('enforces exact OpenCharts licensing (license: null, array attribution), dual ArtificialWatch attribution, and strict https?:// URL validation', async () => {
    const db = openDatabase(':memory:');
    const nowSec = 1_795_000_000;
    try {
      const ocFiltered = filterOpenChartsPayload({
        generatedAt: '2026-11-26T00:00:00Z',
        attribution: [
          { publisher: 'OpenCharts', url: 'https://www.opencharts.com/benchmarks', license: 'Link Attribution' },
          { publisher: 'BadLink', url: 'javascript:alert(1)' },
        ],
        models: [
          {
            slug: 'openai/o3',
            name: 'o3',
            index: 92.5,
            indexRange: { min: Number.NaN, max: 95 },
            rank: Number.POSITIVE_INFINITY,
            rankRange: { min: 1, max: 3 },
            grade: 'A+',
            url: 'javascript:alert(1)',
          },
          {
            slug: 'deepseek-r1',
            name: 'DeepSeek R1',
            index: 88.1,
            rank: 4,
            url: 'https://www.opencharts.com/models/deepseek-r1',
          },
        ],
      });

      assert.match(ocFiltered.attribution, /OpenCharts/);
      assert.match(ocFiltered.attribution, /https:\/\/www\.opencharts\.com\/benchmarks/);
      assert.equal(ocFiltered.attribution.includes('javascript:'), false);

      const ocO3 = ocFiltered.models.find((m) => m.slug === 'openai/o3')!;
      assert.equal(ocO3.url, null, 'javascript: URL must be discarded');
      assert.equal(ocO3.indexRange, null, 'NaN range must be discarded');
      assert.equal(ocO3.rank, null, 'Infinity rank must be discarded');
      assert.deepEqual(ocO3.rankRange, { min: 1, max: 3 });

      const ocR1 = ocFiltered.models.find((m) => m.slug === 'deepseek-r1')!;
      assert.equal(ocR1.url, 'https://www.opencharts.com/models/deepseek-r1');

      const awBench = filterArtificialWatchPayload(
        {
          url: 'javascript:alert(2)',
          generatedAt: '2026-11-26',
          sources: { arena: { name: 'LMArena' } },
          models: [
            {
              id: 'o3',
              name: 'o3',
              index: 94.0,
              page: 'data:text/html,<script>alert(1)</script>',
              scores: { arena: { raw: 1450, percentile: 98.0 } },
            },
          ],
        },
        'bench',
      );
      assert.equal(awBench.sourceUrl, 'https://artificialwatch.com');
      assert.equal(awBench.models[0]?.page, null);

      const awCoding = filterArtificialWatchPayload(
        {
          url: 'https://artificialwatch.com/coding',
          generatedAt: '2026-11-26',
          sources: { swe: { name: 'SWE-bench' } },
          models: [
            {
              id: 'o3',
              name: 'o3',
              index: 93.2,
              page: 'https://artificialwatch.com/models/o3',
              scores: { swe: { raw: 72.1, percentile: 96.5 } },
            },
          ],
        },
        'coding',
      );
      assert.equal(awCoding.models[0]?.page, 'https://artificialwatch.com/models/o3');

      writeExternalCache(db, CACHE_KEY_OPENCHARTS, ocFiltered, null, nowSec);
      writeExternalCache(db, CACHE_KEY_AW_BENCH, awBench, null, nowSec);
      writeExternalCache(db, CACHE_KEY_AW_CODING, awCoding, null, nowSec);
      writeExternalCache(
        db,
        CACHE_KEY_LMARENA_AGENT,
        filterLmArenaPayload(
          {
            rows: [
              {
                row: {
                  model_name: 'o3',
                  score: 0.35,
                  session_count: Number.NaN,
                  observation_count: Number.POSITIVE_INFINITY,
                  rank: 1,
                  category: 'coding-agent',
                },
              },
            ],
          },
          '2026-11-26T00:00:00Z',
        ),
        null,
        nowSec,
      );
      writeExternalCache(
        db,
        CACHE_KEY_EPOCH_INTERNAL,
        {
          source: 'epoch_ai',
          license: 'CC BY 4.0',
          attribution: 'Epoch AI',
          sourceUrl: 'https://epoch.ai/benchmarks',
          capturedAt: '2026-11-26T00:00:00Z',
          includedBenchmarkFiles: [],
          skippedExternalFilesCount: 0,
          eciScores: [],
          internalRuns: [],
        },
        null,
        nowSec,
      );

      const resolved = await resolveAndSyncModelBenchmarks(
        db,
        {
          fullId: 'openai/o3',
          canonicalModelId: 'openai/o3',
          modelId: 'openai/o3',
          name: 'OpenAI o3',
        },
        { nowSec, ttlSec: 3600 },
      );

      assert.equal(resolved.opencharts.license, null);
      assert.notEqual(resolved.opencharts.license, 'CC BY 4.0');
      assert.equal(resolved.opencharts.licenseUrl, OPENCHARTS_LICENSE_URL);
      assert.equal(resolved.opencharts.methodologyUrl, 'https://www.opencharts.com/benchmarks/methodology');
      assert.equal(resolved.lmarena.category, 'coding-agent');
      assert.equal(resolved.lmarena.sessions, null);
      assert.equal(resolved.lmarena.votes, null);
      assert.match(resolved.artificialwatch.attribution, /Bench Index/i);
      assert.match(resolved.artificialwatch.attribution, /Coding Index/i);
    } finally {
      db.close();
    }
  });

  it('recovers priceUsdPerMillion from canonicalHit.cost, links MoE aliases, deduplicates in-flight fetches, merges formatModelRow fields, and handles corrupt cache JSON safely', async () => {
    const db = openDatabase(':memory:');
    try {
      // 1. Corrupt external_cache JSON returns null without throwing
      db.prepare(
        `INSERT INTO external_cache (cache_key, payload_json, etag, fetched_at)
         VALUES ('corrupt:key', '{not-valid-json', NULL, 1795000000)`,
      ).run();
      assert.equal(readExternalCache(db, 'corrupt:key'), null);

      // 2. canonicalHit.cost fallback + no short-circuit before providerHit + finite validation + models/ strip + MoE alias link
      const snapshot = {
        api: {
          nvidia: {
            models: {
              'nvidia/nemotron-3.5-super-vl-120b-a12b': {
                id: 'nvidia/nemotron-3.5-super-vl-120b-a12b',
                name: 'Nemotron 3.5 Super VL',
                reasoning: true,
                tool_call: true,
                modalities: { input: ['text', 'image'], output: ['text'] },
                limit: { context: 131_072, output: 16_384 },
                cost: { input: 0.4, output: 1.2 },
              },
            },
          },
          google: {
            models: {
              'gemini-2.5-flash': {
                id: 'gemini-2.5-flash',
                name: 'Gemini 2.5 Flash',
                tool_call: true,
                limit: { context: 1_000_000, output: 65_536 },
                cost: { input: 0.15, output: 0.6 },
              },
            },
          },
        },
        canonical: {
          'acme/canonical-priced': {
            id: 'acme/canonical-priced',
            name: 'Canonical Priced',
            cost: { input: 0.25, output: 0.75 },
            limit: { context: 64_000, output: Number.NaN },
            reasoning: true,
            modalities: { input: ['text', 'audio'], output: ['text'] },
          },
          'nvidia/nemotron-3.5-super-vl': {
            id: 'nvidia/nemotron-3.5-super-vl',
            name: 'Nemotron 3.5 Super VL Canonical',
            family: 'nemotron-3.5',
            open_weights: true,
          },
          'qwen/qwen2.5-omni-7b': {
            id: 'qwen/qwen2.5-omni-7b',
            name: 'Qwen 2.5 Omni 7B',
            cost: { input: 0.3, output: 0.9 },
          },
          'nvidia/nemotron-3-super-120b-a12b': {
            id: 'nvidia/nemotron-3-super-120b-a12b',
            name: 'Nemotron 3 Super 120B A12B',
            cost: { input: 0.5, output: 1.5 },
          },
        },
      };

      const fromCanonical = resolveCanonicalAndEnrichModel(
        'openrouter',
        'acme/canonical-priced:free',
        snapshot,
      );
      assert.deepEqual(fromCanonical.priceUsdPerMillion, { input: 0.25, output: 0.75 });
      assert.equal(fromCanonical.contextLength, 64_000);
      assert.equal(fromCanonical.maxOutput, null, 'NaN limit must become null');

      // MoE alias link: querying short canonical name finds providerHit with -120b-a12b & vice versa
      const moeLinkedShortToLong = resolveCanonicalAndEnrichModel(
        'nvidia-nim',
        'nvidia/nemotron-3.5-super-vl',
        snapshot,
      );
      assert.deepEqual(moeLinkedShortToLong.priceUsdPerMillion, { input: 0.4, output: 1.2 });
      assert.equal(moeLinkedShortToLong.family, 'nemotron-3.5');

      const moeLinkedLongToShort = resolveCanonicalAndEnrichModel(
        'nvidia-nim',
        'nvidia/nemotron-3.5-super-vl-120b-a12b',
        snapshot,
      );
      assert.equal(moeLinkedLongToShort.family, 'nemotron-3.5');
      assert.equal(moeLinkedLongToShort.openWeights, true);

      // Negative guards: dense sizes, distinct MoE sizes, and conflicting vendors must NOT cross-link
      const qwen3bEnriched = resolveCanonicalAndEnrichModel(
        'openrouter',
        'qwen/qwen2.5-omni-3b',
        snapshot,
      );
      assert.equal(qwen3bEnriched.canonicalModelId, null);
      assert.deepEqual(qwen3bEnriched.priceUsdPerMillion, { input: null, output: null });

      const super49bEnriched = resolveCanonicalAndEnrichModel(
        'nvidia-nim',
        'nvidia/nemotron-3-super-49b',
        snapshot,
      );
      assert.equal(super49bEnriched.canonicalModelId, null);
      assert.deepEqual(super49bEnriched.priceUsdPerMillion, { input: null, output: null });

      const super200bEnriched = resolveCanonicalAndEnrichModel(
        'nvidia-nim',
        'nvidia/nemotron-3-super-200b-a20b',
        snapshot,
      );
      assert.equal(super200bEnriched.canonicalModelId, null);
      assert.deepEqual(super200bEnriched.priceUsdPerMillion, { input: null, output: null });

      const crossVendorEnriched = resolveCanonicalAndEnrichModel(
        'openrouter',
        'acme/nemotron-3.5-super-vl',
        snapshot,
      );
      assert.equal(crossVendorEnriched.canonicalModelId, null);
      assert.deepEqual(crossVendorEnriched.priceUsdPerMillion, { input: null, output: null });

      // Optional models/ prefix stripping (Google AI Studio)
      const googleModel = resolveCanonicalAndEnrichModel(
        'google-ai-studio',
        'models/gemini-2.5-flash',
        snapshot,
      );
      assert.deepEqual(googleModel.priceUsdPerMillion, { input: 0.15, output: 0.6 });
      assert.equal(googleModel.contextLength, 1_000_000);

      // formatModelRow merges capabilities & modalities from modelsDevSnapshot
      const formatted = formatModelRow(
        {
          full_id: 'openrouter/acme/canonical-priced:free',
          provider_id: 'openrouter',
          model_id: 'acme/canonical-priced:free',
          canonical_model_id: null,
          name: 'Canonical Priced',
          context_length: null,
          max_output: null,
          modalities_json: JSON.stringify({ input: ['text'], output: ['text'] }),
          capabilities_json: JSON.stringify({ tools: true, reasoning: false, structuredOutput: false }),
          is_free: 1,
          first_seen_at: 1_795_000_000,
          upstream_created_at: null,
          active: 1,
          disabled_by_admin: 0,
        },
        { modelsDevSnapshot: snapshot },
      );
      assert.equal(formatted.capabilities.tools, true);
      assert.equal(formatted.capabilities.reasoning, true);
      assert.deepEqual(formatted.modalities.input.sort(), ['audio', 'text']);
      assert.deepEqual(formatted.pricing, {
        referencePromptPer1M: 0.25,
        referenceCompletionPer1M: 0.75,
      });

      // Singleflight deduplication in loadModelsDevSnapshot and syncEpochAiBenchmarks
      let modelsDevCalls = 0;
      const slowModelsDevFetch: typeof fetch = async () => {
        modelsDevCalls += 1;
        await new Promise((r) => setTimeout(r, 25));
        return new Response(JSON.stringify({}), { status: 200 });
      };
      await Promise.all([
        loadModelsDevSnapshot(db, { fetchFn: slowModelsDevFetch, nowSec: 1_795_000_100 }),
        loadModelsDevSnapshot(db, { fetchFn: slowModelsDevFetch, nowSec: 1_795_000_100 }),
      ]);
      assert.equal(modelsDevCalls, 2, 'Should issue only 1 api.json + 1 models.json fetch for concurrent calls');

      let epochCalls = 0;
      const validZip = buildZipArchive([
        {
          filename: 'gpqa_diamond.csv',
          content: 'Model version,mean_score,Best score (across scorers),stderr\no3,0.82,0.84,0.01\n',
        },
      ]);
      const slowEpochFetch: typeof fetch = async () => {
        epochCalls += 1;
        await new Promise((r) => setTimeout(r, 25));
        return new Response(new Uint8Array(validZip), { status: 200 });
      };
      await Promise.all([
        syncEpochAiBenchmarks(db, { fetchFn: slowEpochFetch, nowSec: 1_795_000_100 }),
        syncEpochAiBenchmarks(db, { fetchFn: slowEpochFetch, nowSec: 1_795_000_100 }),
      ]);
      assert.equal(epochCalls, 1, 'Concurrent syncEpochAiBenchmarks must share one in-flight download');
    } finally {
      db.close();
    }
  });

  it('normalizes legacy marketplace URL, isolates unapprovedIds against seenIds, handles trailing / baseDirPath, supports 304, and falls back to per-source cache on partial failure', async () => {
    const db = openDatabase(':memory:');
    const nowSec = 1_795_000_000;
    try {
      // 1. Legacy URL normalization
      assert.equal(
        normalizeMarketplaceSourceUrl(LEGACY_OFFICIAL_MARKETPLACE_SOURCE_URL),
        OFFICIAL_MARKETPLACE_SOURCE_URL,
      );
      const validated = await validateMarketplaceSourceUrl(LEGACY_OFFICIAL_MARKETPLACE_SOURCE_URL);
      assert.equal(validated.ok, true);
      if (validated.ok) {
        assert.equal(validated.url, OFFICIAL_MARKETPLACE_SOURCE_URL);
      }

      // Official already exists in DB with OFFICIAL_MARKETPLACE_SOURCE_URL -> adding legacy URL returns 409 duplicate
      const dupRes = await addMarketplaceSource(
        db,
        { name: 'Legacy Dup', url: LEGACY_OFFICIAL_MARKETPLACE_SOURCE_URL },
        nowSec,
      );
      assert.equal(dupRes.ok, false);
      if (!dupRes.ok) {
        assert.equal(dupRes.status, 409);
      }

      // Enable official and add community source with trailing slash URL
      db.prepare(`UPDATE marketplace_sources SET enabled = 1 WHERE id = 'official'`).run();
      const addedComm = await addMarketplaceSource(
        db,
        { name: 'Community Slash', url: 'https://community.example.com/catalog/', enabled: true },
        nowSec + 1,
      );
      assert.equal(addedComm.ok, true);
      if (!addedComm.ok) return;

      let failCommunity = false;
      let officialReturn304 = false;
      let officialFetchCount = 0;

      const groqManifest = {
        schemaVersion: '1.0',
        id: 'groq',
        name: 'Groq Official',
        packageType: 'official-json',
        baseUrl: 'https://api.groq.com/openai/v1',
        auth: { type: 'bearer', header: 'Authorization', prefix: 'Bearer ' },
        modelsSource: 'api',
        modelsEndpoint: '/models',
      };
      const commOnlyManifest = {
        schemaVersion: '1.0',
        id: 'comm-provider',
        name: 'Community Provider',
        packageType: 'official-json',
        baseUrl: 'https://api.comm.example.com/v1',
        auth: { type: 'bearer', header: 'Authorization', prefix: 'Bearer ' },
        modelsSource: 'api',
        modelsEndpoint: '/models',
      };

      const fetchMock: typeof fetch = async (input, init) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        const headers = (init?.headers ?? {}) as Record<string, string>;

        if (url === OFFICIAL_MARKETPLACE_SOURCE_URL) {
          officialFetchCount += 1;
          if (officialReturn304 && headers['If-None-Match'] === '"off-v1"') {
            return new Response(null, { status: 304 });
          }
          return new Response(
            JSON.stringify({
              updatedAt: '2026-11-26',
              providers: [{ ...groqManifest, approved: true }],
            }),
            { status: 200, headers: { etag: '"off-v1"' } },
          );
        }

        if (url === 'https://community.example.com/catalog/') {
          if (failCommunity) {
            return new Response('Service Unavailable', { status: 503 });
          }
          return new Response(
            JSON.stringify({
              updatedAt: '2026-11-25',
              providers: [
                // Community tries to poison higher-priority official 'groq' as approved:false
                { id: 'groq', approved: false },
                // Trailing-slash relative manifestPath resolution
                { id: 'comm-provider', approved: true, manifestPath: 'providers/comm-provider.json' },
                // Remote manifest file itself has approved:false -> must be recorded in unapprovedIds
                { id: 'remote-unapproved', approved: true, manifestPath: 'providers/remote-unapproved.json' },
              ],
            }),
            { status: 200, headers: { etag: '"comm-v1"' } },
          );
        }

        if (url === 'https://community.example.com/catalog/providers/comm-provider.json') {
          return new Response(JSON.stringify(commOnlyManifest), { status: 200 });
        }

        if (url === 'https://community.example.com/catalog/providers/remote-unapproved.json') {
          return new Response(JSON.stringify({ ...commOnlyManifest, id: 'remote-unapproved', approved: false }), {
            status: 200,
          });
        }

        return new Response('Not Found', { status: 404 });
      };

      // Initial fetch: both succeed; trailing-slash manifestPath resolves; seenIds protects 'groq'
      const first = await fetchAndMergeMarketplaceCatalog(db, {
        fetchImpl: fetchMock,
        nowSec,
        bundledDir: SCHEMAS_DIR,
      });
      assert.equal(first.online, true);
      assert.equal(first.partialErrors, undefined);
      assert.deepEqual(
        first.providers.map((p) => p.id),
        ['groq', 'comm-provider'],
      );
      assert.equal(isKnownUnapprovedMarketplaceId(db, 'groq'), false, 'seenIds must exclude groq from unapprovedIds');
      assert.equal(
        isKnownUnapprovedMarketplaceId(db, 'remote-unapproved'),
        true,
        'remote manifest approved:false must be recorded in unapprovedIds',
      );

      // Deleting marketplace:index does NOT invalidate per-source caches within TTL
      db.prepare(`DELETE FROM external_cache WHERE cache_key = 'marketplace:index'`).run();
      const fetchesBefore = officialFetchCount;
      const decoupled = await fetchAndMergeMarketplaceCatalog(db, {
        fetchImpl: fetchMock,
        nowSec: nowSec + 60,
        bundledDir: SCHEMAS_DIR,
      });
      assert.equal(officialFetchCount, fetchesBefore, 'Per-source cache should remain valid when marketplace:index is cleared');
      assert.equal(decoupled.providers.length, 2);

      // Past TTL: official returns 304 Not Modified, community fails 503 -> partial fallback preserves comm-provider + reports partialErrors
      officialReturn304 = true;
      failCommunity = true;
      const partial = await fetchAndMergeMarketplaceCatalog(db, {
        fetchImpl: fetchMock,
        nowSec: nowSec + 3600,
        bundledDir: SCHEMAS_DIR,
      });
      assert.equal(partial.online, true);
      assert.equal(partial.providers.length, 2, 'Failed source must fall back to its prior cached manifests');
      assert.ok(partial.providers.some((p) => p.id === 'comm-provider'));
      assert.equal(partial.partialErrors?.length, 1);
      assert.equal(partial.partialErrors?.[0]?.sourceId, addedComm.source.id);
    } finally {
      db.close();
    }
  });

  it('preserves SVG elements after nested <svg>, enforces 256 KB streaming logo cap + 304, and rejects overlapping ZIP byte ranges & double-counting', async () => {
    // 1. Nested <svg> must not truncate subsequent elements
    const nestedSvg =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><svg viewBox="0 0 12 12"><rect width="4" height="4" fill="#ff0000"/></svg><path d="M1 1h20v20H1z" fill="#00ff00"/></svg>';
    const sanitized = sanitizeAndMonochromeSvg(nestedSvg);
    assert.ok(sanitized);
    assert.match(sanitized, /<rect /);
    assert.match(sanitized, /<path d="M1 1h20v20H1z"/);

    // Zero-width chars obfuscating javascript: are stripped and blocked
    const obfSvg =
      '<svg xmlns="http://www.w3.org/2000/svg"><use href="java\u200Bscript:alert(1)"/><circle cx="5" cy="5" r="3"/></svg>';
    const cleanObf = sanitizeAndMonochromeSvg(obfSvg);
    assert.ok(cleanObf);
    assert.equal(cleanObf.includes('use'), false);
    assert.match(cleanObf, /<circle /);

    // 2. Logo 304 If-None-Match + 256 KB streaming cap
    const db = openDatabase(':memory:');
    try {
      let seenEtagHeader: string | null = null;
      const firstLogo = await getProviderLogo(db, 'test-logo', {
        nowSec: 1_795_000_000,
        fetchFn: async () =>
          new Response('<svg xmlns="http://www.w3.org/2000/svg"><circle cx="1" cy="1" r="1"/></svg>', {
            status: 200,
            headers: { etag: '"logo-v1"' },
          }),
      });
      assert.equal(firstLogo.hasLogo, true);

      const revalidated = await getProviderLogo(db, 'test-logo', {
        nowSec: 1_795_000_000 + 8 * 86400,
        fetchFn: async (_url, init) => {
          const hdrs = (init?.headers ?? {}) as Record<string, string>;
          seenEtagHeader = hdrs['If-None-Match'] ?? null;
          return new Response(null, { status: 304 });
        },
      });
      assert.equal(seenEtagHeader, '"logo-v1"');
      assert.equal(revalidated.hasLogo, true);

      const oversizedLogo = await getProviderLogo(db, 'huge-logo', {
        nowSec: 1_795_000_000,
        fetchFn: async () => {
          const hugeBody = new Uint8Array(300 * 1024).fill(0x20);
          return new Response(hugeBody, { status: 200 });
        },
      });
      assert.equal(oversizedLogo.hasLogo, false);
    } finally {
      db.close();
    }

    // 3. ZIP overlapping [localHeaderOffset, dataEnd) ranges with DIFFERENT start offsets are rejected
    // Craft a ZIP with entry1 at offset 0 (covering [0, 80)) and entry2 starting inside entry1's payload (e.g. offset 50)!
    const innerName = Buffer.from('b.txt', 'utf8');
    const innerPayload = Buffer.from('hi', 'utf8');
    const fakeLocal2 = Buffer.alloc(30);
    fakeLocal2.writeUInt32LE(0x04034b50, 0);
    fakeLocal2.writeUInt16LE(20, 4);
    fakeLocal2.writeUInt16LE(0, 8); // stored
    fakeLocal2.writeUInt32LE(crc32(innerPayload), 14);
    fakeLocal2.writeUInt32LE(innerPayload.length, 18);
    fakeLocal2.writeUInt32LE(innerPayload.length, 22);
    fakeLocal2.writeUInt16LE(innerName.length, 26);
    const embeddedLocal2 = Buffer.concat([fakeLocal2, innerName, innerPayload]);

    const outerName = Buffer.from('a.txt', 'utf8');
    const outerPayload = Buffer.concat([Buffer.from('PREFIX'), embeddedLocal2, Buffer.from('SUFFIX')]);
    const local1 = Buffer.alloc(30);
    local1.writeUInt32LE(0x04034b50, 0);
    local1.writeUInt16LE(20, 4);
    local1.writeUInt16LE(0, 8); // stored
    local1.writeUInt32LE(crc32(outerPayload), 14);
    local1.writeUInt32LE(outerPayload.length, 18);
    local1.writeUInt32LE(outerPayload.length, 22);
    local1.writeUInt16LE(outerName.length, 26);

    const local2Offset = 30 + outerName.length + 6; // starts INSIDE entry1's payload!
    const cdOffset = local1.length + outerName.length + outerPayload.length;

    const cen1 = Buffer.alloc(46);
    cen1.writeUInt32LE(0x02014b50, 0);
    cen1.writeUInt16LE(20, 4);
    cen1.writeUInt16LE(20, 6);
    cen1.writeUInt16LE(0, 10);
    cen1.writeUInt32LE(crc32(outerPayload), 16);
    cen1.writeUInt32LE(outerPayload.length, 20);
    cen1.writeUInt32LE(outerPayload.length, 24);
    cen1.writeUInt16LE(outerName.length, 28);
    cen1.writeUInt32LE(0, 42);

    const cen2 = Buffer.alloc(46);
    cen2.writeUInt32LE(0x02014b50, 0);
    cen2.writeUInt16LE(20, 4);
    cen2.writeUInt16LE(20, 6);
    cen2.writeUInt16LE(0, 10);
    cen2.writeUInt32LE(crc32(innerPayload), 16);
    cen2.writeUInt32LE(innerPayload.length, 20);
    cen2.writeUInt32LE(innerPayload.length, 24);
    cen2.writeUInt16LE(innerName.length, 28);
    cen2.writeUInt32LE(local2Offset, 42);

    const cdBuf = Buffer.concat([cen1, outerName, cen2, innerName]);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(2, 8);
    eocd.writeUInt16LE(2, 10);
    eocd.writeUInt32LE(cdBuf.length, 12);
    eocd.writeUInt32LE(cdOffset, 16);

    const overlappingRangeZip = Buffer.concat([local1, outerName, outerPayload, cdBuf, eocd]);
    assert.throws(() => readZipArchive(overlappingRangeZip), /overlapping entry byte range/i);

    // 4. Re-reading the same ZIP entry does not double-count totalUncompressedRead
    const rereadZip = buildZipArchive([{ filename: 'one.txt', content: 'A'.repeat(900) }]);
    const rereadEntries = readZipArchive(rereadZip, 1000); // total budget = 2000 bytes
    assert.equal(rereadEntries[0]!.readText().length, 900);
    assert.equal(rereadEntries[0]!.readText().length, 900);
    assert.equal(rereadEntries[0]!.readText().length, 900);

    // 5. EOCD trailing garbage with mismatched comment length is rejected
    const badCommentZip = Buffer.concat([rereadZip, Buffer.from('EXTRA')]);
    assert.throws(() => readZipArchive(badCommentZip), /End of Central Directory/i);
  });

  it('validate-schemas.mjs validates marketplace-repo/index.json and rejects invalid manifests', async () => {
    // @ts-expect-error ESM script without .d.ts declaration file
    const validatorModule = await import('../scripts/validate-schemas.mjs');
    const providerSchema = JSON.parse(
      fs.readFileSync(path.join(SCHEMAS_DIR, 'provider.schema.json'), 'utf8'),
    );
    const okResult = validatorModule.validateMarketplaceRepo(
      providerSchema,
      path.join(SCHEMAS_DIR, 'marketplace-repo'),
    );
    assert.deepEqual(okResult.errors, []);
    assert.ok(okResult.validatedProviders >= 6);

    // Verify new schema tightening catches duplicate rateLimitWindows & out-of-range defaultPort
    const schemaErrs = validatorModule.validateAgainstSchema(
      {
        schemaVersion: '1.0',
        id: 'bad-adapter',
        name: 'Bad Adapter',
        packageType: 'experimental-adapter',
        baseUrl: 'http://127.0.0.1:9999/v1',
        auth: { type: 'none', header: 'Authorization' },
        modelsSource: 'static',
        reviewedAt: '2026-11-26',
        staticModels: [{ id: 'm1', name: 'M1', unexpectedProp: 1 }],
        adapter: { defaultPort: 70000, healthPath: '/health' },
        rateLimitKind: 'requests',
        rateLimitWindows: ['day', 'day'],
      },
      providerSchema,
    );
    assert.ok(schemaErrs.some((e: string) => e.includes('unexpectedProp')));
    assert.ok(schemaErrs.some((e: string) => e.includes('defaultPort')));
    assert.ok(schemaErrs.some((e: string) => e.includes('uniqueItems')));

    // Verify validateMarketplaceRepo catches mismatched ID in a temporary repo
    const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'bifrost-mp-schema-'));
    try {
      fs.mkdirSync(path.join(tmpRepo, 'providers'), { recursive: true });
      fs.writeFileSync(
        path.join(tmpRepo, 'index.json'),
        JSON.stringify({
          schemaVersion: '1.0',
          repository: 'test/repo',
          updatedAt: '2026-11-26',
          providers: [
            { id: 'alpha', name: 'Alpha', approved: true, manifestPath: 'providers/alpha.json' },
          ],
        }),
      );
      fs.writeFileSync(
        path.join(tmpRepo, 'providers', 'alpha.json'),
        JSON.stringify({
          schemaVersion: '1.0',
          id: 'beta',
          name: 'Beta',
          packageType: 'official-json',
          baseUrl: 'https://api.example.com/v1',
          auth: { type: 'bearer', header: 'Authorization' },
          modelsSource: 'api',
          modelsEndpoint: '/models',
        }),
      );
      const badRes = validatorModule.validateMarketplaceRepo(providerSchema, tmpRepo);
      assert.ok(badRes.errors.some((e: string) => e.includes('mismatch')));
    } finally {
      fs.rmSync(tmpRepo, { recursive: true, force: true });
    }
  });
});
