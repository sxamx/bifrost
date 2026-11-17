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

  if (Array.isArray(value) && schema.items) {
    value.forEach((item, idx) => {
      errors.push(...validateAgainstSchema(item, schema.items, `${pointer}[${idx}]`));
    });
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
  if (manifest.modelsSource === 'static') {
    if (!manifest.reviewedAt) {
      errors.push('$.reviewedAt: required when modelsSource is "static"');
    }
    if (!Array.isArray(manifest.staticModels) || manifest.staticModels.length === 0) {
      errors.push('$.staticModels: non-empty array required when modelsSource is "static"');
    }
  }
  if (manifest.modelsSource === 'api' && !manifest.modelsEndpoint) {
    errors.push('$.modelsEndpoint: required when modelsSource is "api"');
  }
  if (manifest.packageType === 'experimental-adapter' && !manifest.adapter) {
    errors.push('$.adapter: required when packageType is "experimental-adapter"');
  }
  return errors;
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

  if (hasFailures) {
    process.exit(1);
  }

  console.log(`[pass] All schemas and ${exampleFiles.length} example manifest(s) passed 100% validation.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  run();
}
