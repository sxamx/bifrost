#!/usr/bin/env node
/**
 * Zero-dependency JSON Schema (Draft 2020-12 subset) validator for Bifrost.
 * Parses schemas/provider.schema.json, schemas/model.schema.json, and validates
 * all example manifests in schemas/examples/*.json.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');
const SCHEMAS_DIR = path.join(REPO_ROOT, 'schemas');
const EXAMPLES_DIR = path.join(SCHEMAS_DIR, 'examples');
const MARKETPLACE_REPO_DIR = path.join(SCHEMAS_DIR, 'marketplace-repo');
const SAFE_MANIFEST_PATH_RE = /^providers\/[a-z0-9-]+\.json$/;

function isValidIsoDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const [year, month, day] = value.split('-').map(Number);
  const dt = new Date(Date.UTC(year, month - 1, day));
  return (
    dt.getUTCFullYear() === year &&
    dt.getUTCMonth() === month - 1 &&
    dt.getUTCDate() === day
  );
}

function isValidHttpUri(value) {
  if (typeof value !== 'string' || value.trim().length === 0 || /\s/.test(value)) {
    return false;
  }
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function isValidUri(value) {
  if (typeof value !== 'string' || value.trim().length === 0 || /\s/.test(value)) {
    return false;
  }
  try {
    const parsed = new URL(value);
    return Boolean(parsed.protocol && parsed.protocol.endsWith(':'));
  } catch {
    return false;
  }
}

function matchesJsonType(value, expectedType) {
  switch (expectedType) {
    case 'null':
      return value === null;
    case 'boolean':
      return typeof value === 'boolean';
    case 'string':
      return typeof value === 'string';
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'array':
      return Array.isArray(value);
    case 'object':
      return typeof value === 'object' && value !== null && !Array.isArray(value);
    default:
      return false;
  }
}

export function validateAgainstSchema(value, schema, pointer = '$') {
  const errors = [];

  if (schema.type !== undefined) {
    const allowedTypes = Array.isArray(schema.type) ? schema.type : [schema.type];
    const ok = allowedTypes.some((t) => matchesJsonType(value, t));
    if (!ok) {
      errors.push(`${pointer}: expected type ${allowedTypes.join('|')}, got ${value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value}`);
      return errors;
    }
  }

  if (value === null) {
    return errors;
  }

  if (schema.const !== undefined && value !== schema.const) {
    errors.push(`${pointer}: expected const ${JSON.stringify(schema.const)}, got ${JSON.stringify(value)}`);
  }

  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    errors.push(`${pointer}: value ${JSON.stringify(value)} is not in enum [${schema.enum.map((v) => JSON.stringify(v)).join(', ')}]`);
  }

  if (typeof value === 'string') {
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) {
      errors.push(`${pointer}: string length ${value.length} is less than minLength ${schema.minLength}`);
    }
    if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) {
      errors.push(`${pointer}: string length ${value.length} exceeds maxLength ${schema.maxLength}`);
    }
    if (typeof schema.pattern === 'string') {
      const regex = new RegExp(schema.pattern);
      if (!regex.test(value)) {
        errors.push(`${pointer}: value ${JSON.stringify(value)} does not match pattern ${schema.pattern}`);
      }
    }
    if (schema.format === 'date' && !isValidIsoDate(value)) {
      errors.push(`${pointer}: value ${JSON.stringify(value)} is not a valid ISO-8601 date (YYYY-MM-DD)`);
    }
    if (schema.format === 'uri' && !isValidUri(value)) {
      errors.push(`${pointer}: value ${JSON.stringify(value)} is not a valid URI`);
    }
  }

  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) {
      errors.push(`${pointer}: value ${value} is less than minimum ${schema.minimum}`);
    }
    if (typeof schema.maximum === 'number' && value > schema.maximum) {
      errors.push(`${pointer}: value ${value} exceeds maximum ${schema.maximum}`);
    }
  }

  if (Array.isArray(value)) {
    if (schema.items) {
      value.forEach((item, idx) => {
        errors.push(...validateAgainstSchema(item, schema.items, `${pointer}[${idx}]`));
      });
    }
    if (schema.uniqueItems === true) {
      const seen = new Set();
      value.forEach((item, idx) => {
        const key = JSON.stringify(item);
        if (seen.has(key)) {
          errors.push(`${pointer}[${idx}]: duplicate item ${key} (uniqueItems: true)`);
        } else {
          seen.add(key);
        }
      });
    }
  }

  if (typeof value === 'object' && !Array.isArray(value)) {
    const props = schema.properties ?? {};

    if (Array.isArray(schema.required)) {
      for (const reqKey of schema.required) {
        if (!Object.prototype.hasOwnProperty.call(value, reqKey) || value[reqKey] === undefined) {
          errors.push(`${pointer}: missing required property "${reqKey}"`);
        }
      }
    }

    for (const [key, propValue] of Object.entries(value)) {
      if (Object.prototype.hasOwnProperty.call(props, key)) {
        errors.push(...validateAgainstSchema(propValue, props[key], `${pointer}.${key}`));
      } else if (schema.additionalProperties === false) {
        errors.push(`${pointer}: unexpected additional property "${key}" (additionalProperties: false)`);
      } else if (typeof schema.additionalProperties === 'object' && schema.additionalProperties !== null) {
        errors.push(...validateAgainstSchema(propValue, schema.additionalProperties, `${pointer}.${key}`));
      }
    }
  }

  return errors;
}

function validateProviderSemantics(manifest) {
  const errors = [];
  if (typeof manifest.baseUrl === 'string') {
    if (!isValidHttpUri(manifest.baseUrl)) {
      errors.push('$.baseUrl: must be an http:// or https:// URI');
    } else {
      const parsed = new URL(manifest.baseUrl);
      if (parsed.username || parsed.password) {
        errors.push('$.baseUrl: credentials (userinfo) are not allowed in URL');
      }
      const pkgType =
        manifest.packageType === 'experimental-adapter' ? 'experimental-adapter' : 'official-json';
      if (pkgType === 'official-json' && parsed.protocol !== 'https:') {
        errors.push('$.baseUrl: official-json providers must use https://');
      }
    }
  }
  if (manifest.modelsSource === 'static') {
    if (!manifest.reviewedAt) {
      errors.push('$.reviewedAt: required when modelsSource is "static"');
    }
    if (!Array.isArray(manifest.staticModels) || manifest.staticModels.length === 0) {
      errors.push('$.staticModels: non-empty array required when modelsSource is "static"');
    }
  }
  if (manifest.modelsSource === 'api') {
    if (typeof manifest.modelsEndpoint !== 'string' || manifest.modelsEndpoint.trim().length === 0) {
      errors.push('$.modelsEndpoint: required when modelsSource is "api"');
    }
  }
  if (manifest.packageType === 'experimental-adapter' && !manifest.adapter) {
    errors.push('$.adapter: required when packageType is "experimental-adapter"');
  }
  if (manifest.privacy !== undefined) {
    if (!manifest.privacy || typeof manifest.privacy !== 'object' || Array.isArray(manifest.privacy)) {
      errors.push('$.privacy: must be an object');
    } else {
      const priv = manifest.privacy;
      const validRetention = ['zero', 'transient', 'retained', 'variable'];
      const validTraining = ['never', 'opt_out', 'allowed', 'unknown'];
      if (typeof priv.retention !== 'string' || !validRetention.includes(priv.retention)) {
        errors.push(`$.privacy.retention: must be one of ${validRetention.join(', ')}`);
      }
      if (typeof priv.training !== 'string' || !validTraining.includes(priv.training)) {
        errors.push(`$.privacy.training: must be one of ${validTraining.join(', ')}`);
      }
      if (priv.retentionDays !== undefined) {
        if (
          typeof priv.retentionDays !== 'number' ||
          !Number.isInteger(priv.retentionDays) ||
          priv.retentionDays < 0
        ) {
          errors.push('$.privacy.retentionDays: must be a non-negative integer');
        }
      }
      if (priv.policyUrl !== undefined) {
        if (typeof priv.policyUrl !== 'string' || !isValidHttpUri(priv.policyUrl)) {
          errors.push('$.privacy.policyUrl: must be an http:// or https:// URI');
        }
      }
      if (priv.note !== undefined && typeof priv.note !== 'string') {
        errors.push('$.privacy.note: must be a string');
      }
    }
  }
  if (manifest.rateLimitKind !== undefined) {
    const validKinds = ['none', 'requests', 'tokens', 'concurrency'];
    if (typeof manifest.rateLimitKind !== 'string' || !validKinds.includes(manifest.rateLimitKind)) {
      errors.push(`$.rateLimitKind: must be one of ${validKinds.join(', ')}`);
    }
  }
  if (manifest.rateLimitWindows !== undefined) {
    if (!Array.isArray(manifest.rateLimitWindows)) {
      errors.push('$.rateLimitWindows: must be an array');
    } else {
      const validWindows = ['hour', 'day', 'week'];
      const seen = new Set();
      for (let i = 0; i < manifest.rateLimitWindows.length; i += 1) {
        const w = manifest.rateLimitWindows[i];
        if (typeof w !== 'string' || !validWindows.includes(w)) {
          errors.push(`$.rateLimitWindows[${i}]: must be one of ${validWindows.join(', ')}`);
        } else if (seen.has(w)) {
          errors.push(`$.rateLimitWindows[${i}]: duplicate window "${w}"`);
        } else {
          seen.add(w);
        }
      }
      if (manifest.rateLimitKind === 'none' && manifest.rateLimitWindows.length > 0) {
        errors.push('$.rateLimitWindows: must be empty or omitted when rateLimitKind is "none"');
      }
    }
  }
  return errors;
}

export function validateMarketplaceRepo(providerSchema, repoDir = MARKETPLACE_REPO_DIR) {
  const errors = [];
  const indexPath = path.join(repoDir, 'index.json');
  const providersDir = path.join(repoDir, 'providers');

  if (!fs.existsSync(indexPath)) {
    errors.push(`Missing marketplace index: ${indexPath}`);
    return { errors, validatedProviders: 0 };
  }

  let indexData;
  try {
    indexData = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  } catch (err) {
    errors.push(`schemas/marketplace-repo/index.json: invalid JSON (${err.message})`);
    return { errors, validatedProviders: 0 };
  }

  if (!indexData || typeof indexData !== 'object' || Array.isArray(indexData)) {
    errors.push('schemas/marketplace-repo/index.json: root must be a JSON object');
    return { errors, validatedProviders: 0 };
  }

  if (indexData.schemaVersion !== '1.0') {
    errors.push(`index.json $.schemaVersion: expected "1.0", got ${JSON.stringify(indexData.schemaVersion)}`);
  }
  if (typeof indexData.repository !== 'string' || indexData.repository.trim().length === 0) {
    errors.push('index.json $.repository: non-empty string required');
  }
  if (typeof indexData.updatedAt !== 'string' || !isValidIsoDate(indexData.updatedAt)) {
    errors.push(`index.json $.updatedAt: invalid ISO date ${JSON.stringify(indexData.updatedAt)}`);
  }
  if (!Array.isArray(indexData.providers) || indexData.providers.length === 0) {
    errors.push('index.json $.providers: non-empty array required');
    return { errors, validatedProviders: 0 };
  }

  const seenIds = new Set();
  const validatedFiles = new Set();

  for (let i = 0; i < indexData.providers.length; i += 1) {
    const entry = indexData.providers[i];
    const ptr = `index.json $.providers[${i}]`;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      errors.push(`${ptr}: expected object`);
      continue;
    }
    if (typeof entry.id !== 'string' || !/^[a-z0-9-]+$/.test(entry.id)) {
      errors.push(`${ptr}.id: invalid provider id ${JSON.stringify(entry.id)}`);
    } else if (seenIds.has(entry.id)) {
      errors.push(`${ptr}.id: duplicate provider id "${entry.id}"`);
    } else {
      seenIds.add(entry.id);
    }
    if (typeof entry.name !== 'string' || entry.name.trim().length === 0) {
      errors.push(`${ptr}.name: non-empty string required`);
    }
    if (typeof entry.approved !== 'boolean') {
      errors.push(`${ptr}.approved: boolean required`);
    }
    if (entry.publishedAt !== undefined && !isValidIsoDate(entry.publishedAt)) {
      errors.push(`${ptr}.publishedAt: invalid ISO date ${JSON.stringify(entry.publishedAt)}`);
    }
    if (typeof entry.manifestPath !== 'string' || !SAFE_MANIFEST_PATH_RE.test(entry.manifestPath)) {
      errors.push(`${ptr}.manifestPath: must match ^providers/[a-z0-9-]+\\.json$`);
      continue;
    }

    const resolvedFile = path.resolve(repoDir, entry.manifestPath);
    const rel = path.relative(repoDir, resolvedFile);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      errors.push(`${ptr}.manifestPath: escapes marketplace-repo directory`);
      continue;
    }
    if (!fs.existsSync(resolvedFile)) {
      errors.push(`${ptr}.manifestPath: target file does not exist (${entry.manifestPath})`);
      continue;
    }

    let manifest;
    try {
      manifest = JSON.parse(fs.readFileSync(resolvedFile, 'utf8'));
    } catch (err) {
      errors.push(`${entry.manifestPath}: invalid JSON (${err.message})`);
      continue;
    }

    validatedFiles.add(path.resolve(resolvedFile));
    const manifestErrors = [
      ...validateAgainstSchema(manifest, providerSchema),
      ...validateProviderSemantics(manifest),
    ];
    if (typeof entry.id === 'string' && manifest.id !== entry.id) {
      manifestErrors.push(
        `$.id: mismatch between index.json (${JSON.stringify(entry.id)}) and ${entry.manifestPath} (${JSON.stringify(manifest.id)})`,
      );
    }
    if (entry.packageType !== undefined && manifest.packageType !== entry.packageType) {
      manifestErrors.push(
        `$.packageType: mismatch between index.json (${JSON.stringify(entry.packageType)}) and ${entry.manifestPath} (${JSON.stringify(manifest.packageType)})`,
      );
    }
    for (const errMsg of manifestErrors) {
      errors.push(`schemas/marketplace-repo/${entry.manifestPath}: ${errMsg}`);
    }
  }

  if (fs.existsSync(providersDir)) {
    const providerFiles = fs
      .readdirSync(providersDir)
      .filter((f) => f.endsWith('.json'))
      .sort();

    for (const filename of providerFiles) {
      const fullFile = path.resolve(providersDir, filename);
      if (validatedFiles.has(fullFile)) continue;
      let manifest;
      try {
        manifest = JSON.parse(fs.readFileSync(fullFile, 'utf8'));
      } catch (err) {
        errors.push(`schemas/marketplace-repo/providers/${filename}: invalid JSON (${err.message})`);
        continue;
      }
      validatedFiles.add(fullFile);
      const manifestErrors = [
        ...validateAgainstSchema(manifest, providerSchema),
        ...validateProviderSemantics(manifest),
      ];
      for (const errMsg of manifestErrors) {
        errors.push(`schemas/marketplace-repo/providers/${filename}: ${errMsg}`);
      }
    }
  }

  return { errors, validatedProviders: validatedFiles.size };
}

function loadSchema(schemaFilename) {
  const fullPath = path.join(SCHEMAS_DIR, schemaFilename);
  const raw = fs.readFileSync(fullPath, 'utf8');
  const parsed = JSON.parse(raw);

  if (parsed.$schema !== 'https://json-schema.org/draft/2020-12/schema') {
    throw new Error(`${schemaFilename}: unexpected $schema ${JSON.stringify(parsed.$schema)}`);
  }
  if (!isValidUri(parsed.$id)) {
    throw new Error(`${schemaFilename}: invalid $id URI ${JSON.stringify(parsed.$id)}`);
  }
  if (parsed.type !== 'object' || typeof parsed.properties !== 'object') {
    throw new Error(`${schemaFilename}: root schema must define an object with properties`);
  }
  return parsed;
}

function run() {
  const providerSchema = loadSchema('provider.schema.json');
  const modelSchema = loadSchema('model.schema.json');
  console.log('[ok] Parsed schemas/provider.schema.json and schemas/model.schema.json');

  // Verify model.schema.json against a canonical normalized model sample + negative checks
  const validModelSample = {
    fullId: 'openrouter/deepseek/deepseek-r1:free',
    providerId: 'openrouter',
    modelId: 'deepseek/deepseek-r1:free',
    canonicalModelId: 'deepseek/deepseek-r1',
    name: 'DeepSeek R1 (free)',
    contextLength: 65536,
    maxOutput: 8192,
    modalities: { input: ['text'], output: ['text'] },
    capabilities: { tools: true, reasoning: true, structuredOutput: true },
    isFree: true,
    firstSeenAt: 1763419200,
    upstreamCreatedAt: 1737331200
  };
  const modelSampleErrors = validateAgainstSchema(validModelSample, modelSchema);
  if (modelSampleErrors.length > 0) {
    console.error('[fail] Canonical model sample failed model.schema.json:', modelSampleErrors);
    process.exit(1);
  }

  const invalidProbeErrors = validateAgainstSchema(
    { ...validModelSample, unknownField: true },
    modelSchema
  );
  if (invalidProbeErrors.length === 0) {
    console.error('[fail] Validator self-check failed to reject additionalProperties on model.schema.json');
    process.exit(1);
  }

  if (!fs.existsSync(EXAMPLES_DIR)) {
    console.error(`[fail] Examples directory not found: ${EXAMPLES_DIR}`);
    process.exit(1);
  }

  const exampleFiles = fs
    .readdirSync(EXAMPLES_DIR)
    .filter((f) => f.endsWith('.json'))
    .sort();

  if (exampleFiles.length === 0) {
    console.error(`[fail] No *.json files found in ${EXAMPLES_DIR}`);
    process.exit(1);
  }

  let hasFailures = false;
  for (const filename of exampleFiles) {
    const filePath = path.join(EXAMPLES_DIR, filename);
    let data;
    try {
      data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (err) {
      console.error(`[fail] ${filename}: invalid JSON (${err.message})`);
      hasFailures = true;
      continue;
    }

    const isModelExample = filename.endsWith('.model.json');
    const targetSchema = isModelExample ? modelSchema : providerSchema;
    const errors = [
      ...validateAgainstSchema(data, targetSchema),
      ...(isModelExample ? [] : validateProviderSemantics(data))
    ];

    if (errors.length > 0) {
      console.error(`[fail] schemas/examples/${filename}:`);
      for (const e of errors) {
        console.error(`  - ${e}`);
      }
      hasFailures = true;
    } else {
      console.log(`[ok] Validated schemas/examples/${filename}`);
    }
  }

  if (fs.existsSync(MARKETPLACE_REPO_DIR)) {
    const mpCheck = validateMarketplaceRepo(providerSchema, MARKETPLACE_REPO_DIR);
    if (mpCheck.errors.length > 0) {
      console.error('[fail] schemas/marketplace-repo validation failed:');
      for (const e of mpCheck.errors) {
        console.error(`  - ${e}`);
      }
      hasFailures = true;
    } else {
      console.log(
        `[ok] Validated schemas/marketplace-repo/index.json and ${mpCheck.validatedProviders} provider manifest(s)`,
      );
    }
  }

  if (hasFailures) {
    process.exit(1);
  }

  console.log(`[pass] All schemas, ${exampleFiles.length} example manifest(s), and marketplace-repo manifests passed 100% validation.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  run();
}
