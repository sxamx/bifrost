import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';

import {
  CACHE_KEY_AW_BENCH,
  CACHE_KEY_EPOCH_INTERNAL,
  filterArtificialWatchPayload,
  parseAndFilterEpochZip,
  readResponseBufferWithLimit,
  syncArtificialWatchBenchmarks,
  syncEpochAiBenchmarks,
} from '../core/src/catalog/benchmarks.js';
import { readExternalCache } from '../core/src/catalog/cache.js';
import {
  UpstreamSsrfError,
  assertSafeUpstreamUrl,
  assertSafeUpstreamUrlSync,
  isPrivateOrReservedIp as isCorePrivateOrReservedIp,
  isStrictLoopbackIp,
  isUnconditionallyBlockedIp,
  validateSafeUpstreamUrl,
  validateSafeUpstreamUrlSync,
} from '../core/src/ssrf.js';
import { getProviderLogo, sanitizeAndMonochromeSvg } from '../core/src/catalog/logos.js';
import { MAX_ZIP_ENTRIES, buildZipArchive, crc32, readZipArchive } from '../core/src/catalog/zip.js';
import {
  isPrivateOrReservedIp as isNodesPrivateOrReservedIp,
  validateAndResolveTarget,
} from '../nodes/dist/index.js';

function createTestCacheDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE external_cache (
      cache_key TEXT PRIMARY KEY,
      payload_json TEXT NOT NULL,
      etag TEXT,
      fetched_at INTEGER NOT NULL
    );
  `);
  return db;
}

describe('VULN-03 — Strict Allowlist SVG Sanitizer & Monochrome Normalizer (logos.ts)', () => {
  it('neutralizes slash-delimited event handlers, nested scripts, SMIL animations, feImage, links, styles, external url() and entities', () => {
    const attackVectors: ReadonlyArray<{ name: string; payload: string }> = [
      {
        name: 'classic onload handler',
        payload: '<svg onload="alert(1)" viewBox="0 0 24 24"><path d="M0 0h10v10z"/></svg>',
      },
      {
        name: 'slash-delimited <svg/onload=...> & <rect/onmouseover=...>',
        payload:
          '<svg/onload="alert(1)" viewBox="0 0 24 24"><rect/onmouseover="alert(2)" width="10" height="10"/></svg>',
      },
      {
        name: 'nested script tag reconstruction <scr<script>x</script>ipt>',
        payload:
          '<svg viewBox="0 0 24 24"><scr<script>x</script>ipt>alert(1)</scr<script>x</script>ipt><path d="M1 1h5v5z"/></svg>',
      },
      {
        name: 'self-closing nested script tag reconstruction <scr<script/>ipt>',
        payload:
          '<svg viewBox="0 0 24 24"><scr<script/>ipt>alert(1)</scr<script/>ipt><path d="M1 1h5v5z"/></svg>',
      },
      {
        name: 'foreignObject HTML injection',
        payload:
          '<svg viewBox="0 0 24 24"><foreignObject><iframe src="javascript:alert(1)"></iframe></foreignObject><path d="M1 1h5v5z"/></svg>',
      },
      {
        name: 'slash-delimited <use/href=...> external SSRF & javascript xlink:href',
        payload:
          '<svg viewBox="0 0 24 24"><use/href="https://evil.example/ssrf.svg#x"/><use xlink:href="javascript:alert(1)"/><path d="M1 1h5v5z"/></svg>',
      },
      {
        name: 'SMIL <set> and <animate> DOM mutation',
        payload:
          '<svg viewBox="0 0 24 24"><set attributeName="onload" to="alert(1)"/><animate attributeName="href" values="javascript:alert(1)"/><path d="M1 1h5v5z"/></svg>',
      },
      {
        name: '<image> and <feImage> external tracking pixels',
        payload:
          '<svg viewBox="0 0 24 24"><image href="https://evil.example/track.png"/><filter id="f"><feImage xlink:href="https://evil.example/leak.png"/></filter><path filter="url(#f)" d="M1 1h5v5z"/></svg>',
      },
      {
        name: '<a> anchor with hex-encoded javascript URI',
        payload:
          '<svg viewBox="0 0 24 24"><a href="&#x6a;&#x61;&#x76;&#x61;&#x73;&#x63;&#x72;&#x69;&#x70;&#x74;:alert(1)"><path d="M1 1h5v5z"/></a><circle cx="5" cy="5" r="3"/></svg>',
      },
      {
        name: 'quoted and unquoted style=background:url(...) & external filter/fill/mask url()',
        payload:
          '<svg viewBox="0 0 24 24" style=background:url(https://evil.example/1)><path style="fill:url(https://evil.example/2)" filter="url(https://evil.example/3)" clip-path="url(https://evil.example/4)" mask="url(https://evil.example/5)" fill=url(https://evil.example/6) d="M1 1h5v5z"/></svg>',
      },
      {
        name: 'hex-encoded external url() in fill & clip-path',
        payload:
          '<svg viewBox="0 0 24 24"><path fill="&#x75;&#x72;&#x6c;(https://evil.example/p)" clip-path="&#117;&#114;&#108;(https://evil.example/c)" d="M1 1h5v5z"/></svg>',
      },
      {
        name: 'non-SVG XHTML namespace spoofing',
        payload:
          '<svg xmlns="http://www.w3.org/1999/xhtml" viewBox="0 0 24 24"><path d="M1 1h5v5z"/></svg>',
      },
    ];

    for (const { name, payload } of attackVectors) {
      const out = sanitizeAndMonochromeSvg(payload);
      assert.ok(out !== null, `Vector "${name}" should produce sanitized output`);
      assert.doesNotMatch(out, /\bon[a-z]+\s*=/i, `Leaked event handler in: ${name} -> ${out}`);
      assert.doesNotMatch(out, /<script\b/i, `Leaked <script> in: ${name} -> ${out}`);
      assert.doesNotMatch(out, /alert\s*\(/i, `Leaked JS payload text in: ${name} -> ${out}`);
      assert.doesNotMatch(out, /<foreignobject\b/i, `Leaked <foreignObject> in: ${name}`);
      assert.doesNotMatch(out, /<(?:set|animate|feimage|image|a|iframe|style|filter)\b/i, `Leaked active tag in: ${name} -> ${out}`);
      assert.doesNotMatch(out, /\bstyle\s*=/i, `Leaked style attribute in: ${name} -> ${out}`);
      assert.doesNotMatch(out, /\bfilter\s*=/i, `Leaked filter attribute in: ${name} -> ${out}`);
      assert.doesNotMatch(out, /javascript\s*:/i, `Leaked javascript: URI in: ${name} -> ${out}`);
      assert.doesNotMatch(out, /evil\.example/i, `Leaked external domain in: ${name} -> ${out}`);
      assert.doesNotMatch(out, /1999\/xhtml/i, `Leaked XHTML namespace in: ${name} -> ${out}`);
    }

    assert.equal(sanitizeAndMonochromeSvg('<div>not an svg</div>'), null);
    assert.equal(sanitizeAndMonochromeSvg(''), null);
    assert.equal(sanitizeAndMonochromeSvg('<svg>' + 'a'.repeat(300_000) + '</svg>'), null);
  });

  it('preserves complex real-world SVG geometry (viewBox, defs, linearGradient, clipPath, symbol/use) and normalizes colors to currentColor', async () => {
    const complexRealLogo = `<?xml version="1.0" encoding="UTF-8"?>
      <!-- Provider vector mark -->
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" width="128" height="128" fill="none">
        <defs>
          <linearGradient id="brand-grad_1" x1="0%" y1="0%" x2="100%" y2="100%" gradientUnits="userSpaceOnUse">
            <stop offset="0%" stop-color="#FF3366" stop-opacity="1"/>
            <stop offset="100%" stop-color="rgb(20, 40, 200)" stop-opacity="0.45"/>
          </linearGradient>
          <clipPath id="logo-clip" clipPathUnits="userSpaceOnUse">
            <rect x="4" y="4" width="120" height="120" rx="16"/>
          </clipPath>
          <symbol id="glyph-dot" viewBox="0 0 10 10">
            <circle cx="5" cy="5" r="4" fill="#00FFAA"/>
          </symbol>
        </defs>
        <g clip-path="url(#logo-clip)" transform="translate(2, 2)">
          <path d="M16 64L64 16l48 48-48 48Z" fill="url(#brand-grad_1)" stroke="#112233" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>
          <circle cx="64" cy="64" r="14" fill="transparent" stroke="none"/>
          <use xlink:href="#glyph-dot" x="59" y="59" width="10" height="10"/>
        </g>
      </svg>`;

    const sanitized = sanitizeAndMonochromeSvg(complexRealLogo);
    assert.ok(sanitized !== null);

    // Exact XML case-sensitive tag and attribute preservation
    assert.match(sanitized, /^<svg\b[^>]*viewBox="0 0 128 128"/);
    assert.match(sanitized, /\bfill="none"/);
    assert.match(sanitized, /<linearGradient id="brand-grad_1"[^>]*gradientUnits="userSpaceOnUse">/);
    assert.match(sanitized, /<clipPath id="logo-clip" clipPathUnits="userSpaceOnUse">/);
    assert.match(sanitized, /clip-path="url\(#logo-clip\)"/);
    assert.match(sanitized, /fill="url\(#brand-grad_1\)"/);
    assert.match(sanitized, /<use href="#glyph-dot"/);

    // Monochrome enforcement: hex/rgb converted to currentColor, while none/transparent/url(#id) stay intact
    assert.doesNotMatch(sanitized, /#FF3366|#112233|#00FFAA|rgb\(/i);
    assert.match(sanitized, /stop-color="currentColor" stop-opacity="1"/);
    assert.match(sanitized, /stop-color="currentColor" stop-opacity="0\.45"/);
    assert.match(sanitized, /stroke="currentColor"/);
    assert.match(sanitized, /fill="transparent" stroke="none"/);

    // Offline SQLite cache round-trip via getProviderLogo
    const db = createTestCacheDb();
    const res = await getProviderLogo(db, 'OpenRouter', {
      nowSec: 1_700_000_000,
      fetchFn: async () =>
        new Response(complexRealLogo, {
          status: 200,
          headers: { 'content-type': 'image/svg+xml', etag: '"v1"' },
        }),
    });
    assert.equal(res.hasLogo, true);
    if (res.hasLogo) {
      assert.equal(res.svg, sanitized);
    }
    db.close();
  });
});

describe('VULN-06 — ArtificialWatch License Scrubbing & Prototype Pollution Guard (benchmarks.ts)', () => {
  it('strips raw scores before SQLite persistence and blocks __proto__, constructor, and prototype keys', async () => {
    const maliciousJson = JSON.parse(`{
      "generatedAt": "2026-11-18T00:00:00Z",
      "sources": {
        "__proto__": { "name": "polluted_source_proto", "polluted": true },
        "constructor": { "name": "polluted_ctor" },
        "prototype": { "name": "polluted_proto_prop" },
        "swe_bench": { "name": "SWE-bench Verified", "raw": 99.9 }
      },
      "models": [
        {
          "id": "deepseek/deepseek-r1",
          "name": "DeepSeek R1",
          "vendor": "DeepSeek",
          "index": 84.5,
          "raw": 91.2,
          "scores": {
            "__proto__": { "percentile": 99.9, "polluted": "yes", "raw": 100 },
            "constructor": { "percentile": 88.8, "raw": 88.8 },
            "prototype": { "percentile": 77.7, "raw": 77.7 },
            "swe_bench": { "percentile": 93.4, "raw": 71.2 },
            "gpqa": { "percentile": 95.1, "raw": 82.0 }
          }
        }
      ]
    }`) as unknown;

    const snap = filterArtificialWatchPayload(maliciousJson, 'coding');
    assert.equal(({} as Record<string, unknown>).polluted, undefined);
    assert.equal(snap.models.length, 1);

    const model = snap.models[0]!;
    assert.equal(Object.getPrototypeOf(model.scores), null);
    assert.equal(Object.prototype.hasOwnProperty.call(model.scores, '__proto__'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(model.scores, 'constructor'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(model.scores, 'prototype'), false);
    assert.deepEqual(Object.keys(model.scores).sort(), ['gpqa', 'swe_bench']);
    assert.deepEqual(model.scores['swe_bench'], { percentile: 93.4 });
    assert.equal(model.boards, 2);

    assert.ok(snap.sources !== null);
    assert.equal(Object.getPrototypeOf(snap.sources), null);
    assert.deepEqual(Object.keys(snap.sources), ['swe_bench']);

    // Verify full SQLite cache persistence contains zero `raw` keys
    const db = createTestCacheDb();
    await syncArtificialWatchBenchmarks(db, {
      nowSec: 1_700_000_100,
      fetchFn: async () =>
        new Response(JSON.stringify(maliciousJson), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    });
    const cached = readExternalCache<unknown>(db, CACHE_KEY_AW_BENCH);
    assert.ok(cached !== null);
    const serialized = JSON.stringify(cached.data);
    assert.doesNotMatch(serialized, /"raw"\s*:/);
    assert.doesNotMatch(serialized, /polluted/);
    db.close();
  });
});

describe('VULN-07 — PKZIP CRC32, Anti-Bomb Limits, Overlapping Offset Guard & Streaming Download Cap (zip.ts & benchmarks.ts)', () => {
  it('computes IEEE 802.3 CRC32 accurately and rejects single-bit payload corruption', () => {
    assert.equal(crc32(Buffer.from('123456789', 'utf8')), 0xcbf43926);

    const validZip = buildZipArchive([
      { filename: 'eci_scores.csv', content: 'Model,eci\ngpt-5,145.2\n' },
    ]);
    const corruptedZip = Buffer.from(validZip);
    // Flip 1 bit inside the compressed payload right after local header (30 + filename length)
    const flipIndex = 30 + Buffer.byteLength('eci_scores.csv') + 1;
    corruptedZip[flipIndex] = corruptedZip[flipIndex]! ^ 0xff;

    const entries = readZipArchive(corruptedZip);
    assert.equal(entries.length, 1);
    assert.throws(() => entries[0]!.readText(), /CRC32 integrity check failed|incorrect|mismatch|invalid/i);
  });

  it('blocks stored (method=0) size bypasses, >512 entry bombs, overlapping localHeaderOffset bombs, cumulative budget, corrupt CD bounds, and null bytes', () => {
    // 1. Null byte in filename
    const nullNameZip = buildZipArchive([{ filename: 'bad\0file.csv', content: 'a,b\n1,2\n' }]);
    assert.throws(() => readZipArchive(nullNameZip), /null byte/i);

    // 2. Entry count > MAX_ZIP_ENTRIES (512)
    const manyFiles = Array.from({ length: MAX_ZIP_ENTRIES + 1 }, (_, idx) => ({
      filename: `f_${idx}.txt`,
      content: 'x',
    }));
    const tooManyEntriesZip = buildZipArchive(manyFiles);
    assert.throws(() => readZipArchive(tooManyEntriesZip), /exceeds maximum allowed \(512\)/);

    // 3. Overlapping localHeaderOffset (`zbsm.zip` style multi-header bomb pointing to offset 0)
    const twoEntryZip = Buffer.from(
      buildZipArchive([
        { filename: 'a.csv', content: 'hello world' },
        { filename: 'b.csv', content: 'hello world' },
      ]),
    );
    const eocdPos = twoEntryZip.length - 22;
    const cdOffset = twoEntryZip.readUInt32LE(eocdPos + 16);
    const firstCdLen = 46 + Buffer.byteLength('a.csv');
    const secondCdStart = cdOffset + firstCdLen;
    // Point second Central Directory header's localHeaderOffset (offset +42) to 0 as well
    twoEntryZip.writeUInt32LE(0, secondCdStart + 42);
    assert.throws(() => readZipArchive(twoEntryZip), /overlapping local header offset/i);

    // 4. Stored (method = 0) entry with compressedSize > maxEntryUncompressedBytes or mismatched sizes
    const rawPayload = Buffer.alloc(2048, 0x41);
    const nameBuf = Buffer.from('stored.csv', 'utf8');
    const loc = Buffer.alloc(30);
    loc.writeUInt32LE(0x04034b50, 0);
    loc.writeUInt16LE(20, 4);
    loc.writeUInt16LE(0, 8); // method 0 (stored)
    loc.writeUInt32LE(crc32(rawPayload), 14);
    loc.writeUInt32LE(rawPayload.length, 18);
    loc.writeUInt32LE(rawPayload.length, 22);
    loc.writeUInt16LE(nameBuf.length, 26);

    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(0, 10); // method 0 (stored)
    cen.writeUInt32LE(crc32(rawPayload), 16);
    cen.writeUInt32LE(rawPayload.length, 20); // compressedSize = 2048
    cen.writeUInt32LE(128, 24); // forged tiny uncompressedSize = 128 to try bypassing old check
    cen.writeUInt16LE(nameBuf.length, 28);
    cen.writeUInt32LE(0, 42);

    const cdStart = loc.length + nameBuf.length + rawPayload.length;
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(1, 8);
    eocd.writeUInt16LE(1, 10);
    eocd.writeUInt32LE(cen.length + nameBuf.length, 12);
    eocd.writeUInt32LE(cdStart, 16);
    const forgedStoredZip = Buffer.concat([loc, nameBuf, rawPayload, cen, nameBuf, eocd]);

    const forgedEntries = readZipArchive(forgedStoredZip, 1024);
    assert.throws(
      () => forgedEntries[0]!.readBuffer(),
      /exceeds maximum allowed uncompressed size|mismatched compressedSize/i,
    );

    // 5. Cumulative total uncompressed budget (`> maxEntryUncompressedBytes * 2`) across distinct entries
    const chunkPayload = 'A'.repeat(900);
    const cumulativeZip = buildZipArchive([
      { filename: 'part1.txt', content: chunkPayload },
      { filename: 'part2.txt', content: chunkPayload },
      { filename: 'part3.txt', content: chunkPayload },
    ]);
    const cumEntries = readZipArchive(cumulativeZip, 1000); // max total = 2000 bytes
    assert.equal(cumEntries[0]!.readText().length, 900);
    assert.equal(cumEntries[1]!.readText().length, 900);
    assert.throws(
      () => cumEntries[2]!.readText(),
      /exceeds maximum total uncompressed byte budget/i,
    );

    // 6. Central Directory variable field (`fileNameLen`) overflowing `centralDirEnd`
    const overflowCdZip = Buffer.from(validSingleFileZip());
    const ovEocd = overflowCdZip.length - 22;
    const ovCdOffset = overflowCdZip.readUInt32LE(ovEocd + 16);
    overflowCdZip.writeUInt16LE(9999, ovCdOffset + 28); // forged huge fileNameLen
    assert.throws(
      () => readZipArchive(overflowCdZip),
      /exceed directory bounds/i,
    );

    // 7. Deflate bomb exceeding maxEntryUncompressedBytes
    const bigZeroes = Buffer.alloc(16 * 1024, 0);
    const deflateBombZip = buildZipArchive([{ filename: 'bomb.csv', content: bigZeroes }]);
    const bombEntries = readZipArchive(deflateBombZip, 4096);
    assert.throws(() => bombEntries[0]!.readBuffer(), /exceeds maximum allowed uncompressed size/i);
  });

  it('enforces streaming download byte cap on Epoch AI ZIP responses while still parsing valid archives & excluding *_external.csv', async () => {
    // 1. Oversized Content-Length header rejected immediately before reading
    const oversizedHeaderRes = new Response(new Uint8Array(64), {
      status: 200,
      headers: { 'content-length': String(100 * 1024 * 1024) },
    });
    await assert.rejects(
      () => readResponseBufferWithLimit(oversizedHeaderRes, 1024),
      /Content-Length.*exceeds maximum allowed/i,
    );

    // 2. Oversized chunked ReadableStream WITHOUT Content-Length aborted mid-stream
    let chunksPulled = 0;
    const infiniteLikeStream = new ReadableStream<Uint8Array>({
      pull(controller) {
        chunksPulled += 1;
        controller.enqueue(new Uint8Array(512));
        if (chunksPulled >= 20) {
          controller.close();
        }
      },
    });
    const chunkedRes = new Response(infiniteLikeStream, { status: 200 });
    await assert.rejects(
      () => readResponseBufferWithLimit(chunkedRes, 1024),
      /Streamed response body exceeded maximum allowed size/i,
    );
    assert.ok(chunksPulled <= 5, `Stream should cancel early, pulled ${chunksPulled} chunks`);

    // 3. Valid Epoch AI archive with Zip-Slip path & *_external.csv exclusion works end-to-end
    const epochZip = buildZipArchive([
      {
        filename: 'eci_scores.csv',
        content: 'Model,Display name,eci,eci_ci_low,eci_ci_high,date,Organization\nqwen3-235b,Qwen 3 235B,141.5,139.0,144.0,2026-05-01,Alibaba\n',
      },
      {
        filename: '../../gpqa_diamond.csv',
        content:
          'Model version,mean_score,Best score (across scorers),stderr,Organization,Release date,Started at\nqwen3-235b,0.78,0.81,0.02,Alibaba,2026-05-01,2026-05-02T00:00:00Z\n',
      },
      {
        filename: 'math_level_5_external.csv',
        content: 'Model version,mean_score,Best score (across scorers),stderr,Source\nsecret-ext,0.99,0.99,0.01,ThirdParty\n',
      },
      {
        filename: 'processed_data_for_eci.csv',
        content: 'Model,score\nsecret-mixed,0.95\n',
      },
    ]);

    const db = createTestCacheDb();
    // Fails closed if archive exceeds maxDownloadBytes (e.g. 50 bytes)
    const blockedSnap = await syncEpochAiBenchmarks(db, {
      nowSec: 1_700_000_200,
      maxDownloadBytes: 50,
      fetchFn: async () => new Response(new Uint8Array(epochZip), { status: 200 }),
    });
    assert.equal(blockedSnap, null);
    assert.equal(readExternalCache(db, CACHE_KEY_EPOCH_INTERNAL), null);

    // Succeeds cleanly within maxDownloadBytes and strips *_external.csv + processed_data_for_eci.csv
    const validSnap = await syncEpochAiBenchmarks(db, {
      nowSec: 1_700_000_300,
      forceRefresh: true,
      fetchFn: async () => new Response(new Uint8Array(epochZip), { status: 200 }),
    });
    assert.ok(validSnap !== null);
    assert.deepEqual(validSnap.includedBenchmarkFiles, ['gpqa_diamond.csv']);
    assert.equal(validSnap.skippedExternalFilesCount, 2);
    assert.equal(validSnap.eciScores.length, 1);
    assert.equal(validSnap.internalRuns.length, 1);
    assert.equal(validSnap.internalRuns[0]!.benchmark, 'gpqa_diamond');
    assert.doesNotMatch(JSON.stringify(validSnap), /secret-ext|secret-mixed/);

    const directParsed = parseAndFilterEpochZip(epochZip, '2026-11-18T00:00:00Z');
    assert.equal(directParsed.internalRuns.length, 1);
    db.close();
  });
});

function validSingleFileZip(): Buffer {
  return buildZipArchive([{ filename: 'ok.txt', content: 'ok' }]);
}

describe('VULN-08 — Nodes HTTP CONNECT SSRF IPv6 Transition & Cloud IMDS Hardening (nodes/src/ssrf.ts)', () => {
  it('blocks 6to4, Teredo, BMWG, NAT64, SIIT, deprecated ::/96, AWS fd00:ec2::254, and Alibaba 100.100.100.200', async () => {
    const mustBlockIps = [
      '2002:a9fe:a9fe::1', // 6to4 -> 169.254.169.254
      '2002:7f00:0001::1', // 6to4 -> 127.0.0.1
      '2002:0808:0808::1', // 6to4 -> 8.8.8.8 (entire 2002::/16 blocked)
      '2001:0000:4136:e378:8000:63bf:3fff:fdd2', // Teredo 2001:0000::/32
      '2001:0:0:1::1', // Teredo
      '2001:0002:0:0::1', // BMWG 2001:0002::/32
      '64:ff9b::169.254.169.254', // NAT64 Well-Known -> IMDS
      '64:ff9b::8.8.8.8', // NAT64 Well-Known 64:ff9b::/96
      '64:ff9b:1:ff::1', // NAT64 Local-Use 64:ff9b:1::/48
      '::ffff:0:169.254.169.254', // SIIT ::ffff:0:0:0/96
      '::ffff:0:8.8.8.8', // SIIT ::ffff:0:0:0/96
      '::169.254.169.254', // Deprecated ::/96
      'fd00:ec2::254', // AWS EC2 IPv6 IMDS
      '100.100.100.200', // Alibaba Cloud IMDS
      '169.254.169.254', // AWS/GCP/Azure IMDS
      '192.0.0.192', // Oracle Cloud IMDS
      '192.88.99.1', // 6to4 Relay Anycast
    ];

    for (const ip of mustBlockIps) {
      assert.equal(isNodesPrivateOrReservedIp(ip), true, `nodes ssrf must block ${ip}`);
      const resolved = await validateAndResolveTarget(
        { host: ip, port: 443 },
        { allowedPorts: new Set([443]), allowPrivateTargets: false },
      );
      assert.equal(resolved.allowed, false, `validateAndResolveTarget must reject ${ip}`);
    }

    for (const host of ['metadata.google.internal', 'metadata', 'instance-data', 'svc.internal']) {
      const resolved = await validateAndResolveTarget(
        { host, port: 443 },
        { allowedPorts: new Set([443]), allowPrivateTargets: false },
      );
      assert.equal(resolved.allowed, false, `validateAndResolveTarget must reject host ${host}`);
    }

    // Legitimate public IPv4 & IPv6 endpoints remain allowed on port 443
    for (const publicIp of ['1.1.1.1', '104.18.2.15', '2606:4700:4700::1111', '2001:4860:4860::8888']) {
      assert.equal(isNodesPrivateOrReservedIp(publicIp), false, `Public IP ${publicIp} should be allowed`);
      const resolved = await validateAndResolveTarget(
        { host: publicIp, port: 443 },
        { allowedPorts: new Set([443]), allowPrivateTargets: false },
      );
      assert.equal(resolved.allowed, true, `Public target ${publicIp}:443 should be allowed`);
    }
  });
});

describe('Core Reusable SSRF Guard (core-ssrf.ts — official-json & experimental-adapter modes)', () => {
  it('enforces strict HTTPS & public-IP rules in official-json mode including DNS-rebinding protection', async () => {
    // Public HTTPS endpoint with public DNS resolution -> allowed
    const okOpenRouter = await validateSafeUpstreamUrl('https://openrouter.ai/api/v1', {
      mode: 'official-json',
      lookupFn: async () => [{ address: '104.18.2.15', family: 4 }],
    });
    assert.equal(okOpenRouter.allowed, true);
    assert.deepEqual(okOpenRouter.resolvedIps, ['104.18.2.15']);

    // Plain HTTP to public domain -> blocked
    const plainHttp = await validateSafeUpstreamUrl('http://openrouter.ai/api/v1', {
      mode: 'official-json',
      lookupFn: async () => [{ address: '104.18.2.15', family: 4 }],
    });
    assert.equal(plainHttp.allowed, false);

    // Embedded credentials -> blocked
    const withCreds = validateSafeUpstreamUrlSync('https://admin:secret@openrouter.ai/api/v1');
    assert.equal(withCreds.allowed, false);

    // Loopback blocked by default in official-json mode
    for (const loopUrl of [
      'http://127.0.0.1:8080/v1',
      'https://127.0.0.1:8443/v1',
      'http://[::1]:8080/v1',
      'http://localhost:3000/v1',
    ]) {
      assert.equal(
        validateSafeUpstreamUrlSync(loopUrl, { mode: 'official-json' }).allowed,
        false,
        `Loopback URL ${loopUrl} must be blocked by default in official-json mode`,
      );
    }

    // DNS rebinding / nip.io resolving to IMDS, RFC1918, or loopback -> blocked
    for (const rebindIp of ['169.254.169.254', '10.0.0.5', '127.0.0.1', 'fd00:ec2::254', '2002:a9fe:a9fe::1']) {
      const rebindRes = await validateSafeUpstreamUrl('https://rebind.attacker.example/v1', {
        mode: 'official-json',
        lookupFn: async () => [{ address: rebindIp, family: rebindIp.includes(':') ? 6 : 4 }],
      });
      assert.equal(rebindRes.allowed, false, `DNS rebinding to ${rebindIp} must be blocked`);
    }

    // Decimal & hex IPv4 IMDS obfuscations normalized by WHATWG URL (`2852039166` -> `169.254.169.254`) -> blocked
    assert.equal(validateSafeUpstreamUrlSync('http://2852039166/latest/meta-data').allowed, false);
    assert.equal(validateSafeUpstreamUrlSync('https://0xa9fea9fe/latest/meta-data').allowed, false);
  });

  it('supports experimental-adapter local loopback sidecars while blocking LAN, Tailscale CGNAT, and Cloud IMDS', async () => {
    // Local sidecar adapters on 127.0.0.1 / ::1 / localhost are permitted in experimental-adapter mode
    for (const sidecarUrl of [
      'http://127.0.0.1:8787/v1',
      'http://[::1]:8787/v1',
      'http://localhost:8787/v1',
    ]) {
      const res = await validateSafeUpstreamUrl(sidecarUrl, { mode: 'experimental-adapter' });
      assert.equal(res.allowed, true, `Sidecar ${sidecarUrl} should be allowed in experimental-adapter mode`);
    }

    // Public HTTPS adapter is also allowed when resolving to public IP
    const pubAdapter = await validateSafeUpstreamUrl('https://adapter.example.com/v1', {
      mode: 'experimental-adapter',
      lookupFn: async () => [{ address: '93.184.216.34', family: 4 }],
    });
    assert.equal(pubAdapter.allowed, true);

    // Non-loopback private LAN, CGNAT, and IMDS are strictly blocked in experimental-adapter mode
    for (const badAdapterUrl of [
      'http://169.254.169.254/latest/meta-data',
      'https://169.254.169.254/latest/meta-data',
      'http://100.100.100.200/latest/meta-data',
      'http://100.64.0.10:9443/v1',
      'http://192.168.1.50:8787/v1',
      'http://10.0.0.12:8787/v1',
      'http://172.16.5.4:8787/v1',
      'http://[fd00:ec2::254]/latest/meta-data',
      'http://[fe80::1]:8787/v1',
      'http://[2002:7f00:0001::1]:8787/v1',
      'http://[::ffff:127.0.0.1]:8787/v1',
      'http://metadata.google.internal/computeMetadata/v1/',
    ]) {
      const res = await validateSafeUpstreamUrl(badAdapterUrl, { mode: 'experimental-adapter' });
      assert.equal(res.allowed, false, `Malicious adapterUrl ${badAdapterUrl} must be blocked`);
    }
  });

  it('UNCONDITIONALLY blocks 169.254.0.0/16, Cloud IMDS, 0.0.0.0/8, RFC1918, and IPv6 link-local/transition ranges EVEN when allowLocalhostForTests=true', async () => {
    // 1. Local test server URLs (127.0.0.1, ::1, localhost) ARE allowed when allowLocalhostForTests: true
    assert.equal(isStrictLoopbackIp('127.0.0.1'), true);
    assert.equal(isStrictLoopbackIp('::1'), true);
    assert.equal(isStrictLoopbackIp('::ffff:127.0.0.1'), false);

    for (const localTestUrl of [
      'http://127.0.0.1:45123/v1',
      'http://[::1]:45123/v1',
      'http://localhost:45123/v1',
    ]) {
      const checked = await assertSafeUpstreamUrl(localTestUrl, {
        mode: 'official-json',
        allowLocalhostForTests: true,
      });
      assert.ok(checked.startsWith('http://'));
    }

    // 2. IMDS, link-local, 0.0.0.0, ULA, IPv6 transition ranges, and RFC1918 STILL FAIL even with allowLocalhost + allowLocalhostForTests!
    const unconditionallyForbiddenUrls = [
      'http://169.254.169.254/latest/meta-data/iam/security-credentials/',
      'https://169.254.169.254/latest/meta-data/',
      'http://169.254.170.2/v2/credentials', // AWS ECS task metadata
      'http://100.100.100.200/latest/meta-data/', // Alibaba IMDS
      'http://192.0.0.192/opc/v2/instance/', // Oracle IMDS
      'http://0.0.0.0:8080/v1',
      'http://[fe80::1]:8080/v1',
      'http://[fd00:ec2::254]/latest/meta-data/',
      'http://[fc00::1]:8080/v1',
      'http://[2002:a9fe:a9fe::1]/',
      'http://[2002:7f00:0001::1]:8080/v1', // 6to4 encapsulating 127.0.0.1 MUST NOT count as localhost!
      'http://[2001:0000:4136:e378:8000:63bf:3fff:fdd2]/',
      'http://[2001:2::1]/',
      'http://[64:ff9b::127.0.0.1]/',
      'http://[64:ff9b:1::1]/',
      'http://[::ffff:0:127.0.0.1]/',
      'http://[::ffff:169.254.169.254]/',
      'http://[::ffff:127.0.0.1]:8080/',
      'http://10.0.0.1:8080/v1',
      'http://192.168.1.1:8080/v1',
      'http://metadata.google.internal/computeMetadata/v1/',
    ];

    for (const forbiddenUrl of unconditionallyForbiddenUrls) {
      assert.throws(
        () =>
          assertSafeUpstreamUrlSync(forbiddenUrl, {
            mode: 'official-json',
            allowLocalhost: true,
            allowLocalhostForTests: true,
          }),
        UpstreamSsrfError,
        `Expected UpstreamSsrfError even in test mode for ${forbiddenUrl}`,
      );

      await assert.rejects(
        () =>
          assertSafeUpstreamUrl(forbiddenUrl, {
            mode: 'experimental-adapter',
            allowLocalhost: true,
            allowLocalhostForTests: true,
          }),
        UpstreamSsrfError,
        `Expected async UpstreamSsrfError even in test mode for ${forbiddenUrl}`,
      );
    }

    // DNS rebinding to 169.254.169.254 MUST also fail even when allowLocalhostForTests: true!
    await assert.rejects(
      () =>
        assertSafeUpstreamUrl('https://imds-rebind.example.com/v1', {
          mode: 'official-json',
          allowLocalhost: true,
          allowLocalhostForTests: true,
          lookupFn: async () => [{ address: '169.254.169.254', family: 4 }],
        }),
      UpstreamSsrfError,
    );

    assert.equal(isUnconditionallyBlockedIp('169.254.169.254'), true);
    assert.equal(isUnconditionallyBlockedIp('fd00:ec2::254'), true);
    assert.equal(isUnconditionallyBlockedIp('2002:7f00:0001::1'), true);
    assert.equal(isCorePrivateOrReservedIp('127.0.0.1'), true);
    assert.equal(isCorePrivateOrReservedIp('1.1.1.1'), false);
  });
});
