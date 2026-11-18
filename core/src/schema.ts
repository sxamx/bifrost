import fs from 'node:fs';
import path from 'node:path';
import { validateProviderTargetUrl } from './url-security.js';

export type ProviderPackageType = 'official-json' | 'experimental-adapter';
export type ProviderModelsSource = 'api' | 'static';
export type ProviderCategory = 'aggregator' | 'official-api' | 'experimental-adapter';

export interface ProviderAuthConfig {
  type: 'bearer' | 'header' | 'none';
  header: string;
  prefix?: string;
  extraHeaders?: Record<string, string>;
}

export interface ProviderFreeRule {
  priceZeroPaths?: string[];
  requiredEndpoint?: string;
  idSuffix?: string;
}

export interface ProviderStaticModelDef {
  id: string;
  name: string;
  canonicalModelId?: string;
  contextLength?: number;
  maxOutput?: number;
}

export interface ProviderAdapterConfig {
  defaultPort: number;
  healthPath: string;
  accountLabel?: string;
}

export interface ProviderManifest {
  schemaVersion: '1.0';
  id: string;
  name: string;
  category?: ProviderCategory;
  packageType: ProviderPackageType;
  verified?: boolean;
  publishedAt?: string;
  baseUrl: string;
  auth: ProviderAuthConfig;
  modelsSource: ProviderModelsSource;
  modelsEndpoint?: string;
  freeRule?: ProviderFreeRule;
  staticModels?: ProviderStaticModelDef[];
  reviewedAt?: string;
  adapter?: ProviderAdapterConfig;
}

interface JsonSchemaNode {
  type?: string | string[];
  const?: unknown;
  enum?: unknown[];
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  format?: string;
  items?: JsonSchemaNode;
  properties?: Record<string, JsonSchemaNode>;
  required?: string[];
  additionalProperties?: boolean | JsonSchemaNode;
}

function isValidIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const [year, month, day] = value.split('-').map(Number);
  const dt = new Date(Date.UTC(year!, month! - 1, day));
  return (
    dt.getUTCFullYear() === year &&
    dt.getUTCMonth() === month! - 1 &&
    dt.getUTCDate() === day
  );
}

export function isValidHttpUri(value: string): boolean {
  if (value.trim().length === 0 || /\s/.test(value)) {
    return false;
  }
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function isValidUri(value: string): boolean {
  if (value.trim().length === 0 || /\s/.test(value)) {
    return false;
  }
  try {
    const parsed = new URL(value);
    return Boolean(parsed.protocol && parsed.protocol.endsWith(':'));
  } catch {
    return false;
  }
}

function matchesJsonType(value: unknown, expectedType: string): boolean {
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

export function validateAgainstSchema(
  value: unknown,
  schema: JsonSchemaNode,
  pointer = '$',
): string[] {
  const errors: string[] = [];

  if (schema.type !== undefined) {
    const allowedTypes = Array.isArray(schema.type) ? schema.type : [schema.type];
    const ok = allowedTypes.some((t) => matchesJsonType(value, t));
    if (!ok) {
      const actual = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
      errors.push(`${pointer}: expected type ${allowedTypes.join('|')}, got ${actual}`);
      return errors;
    }
  }

  if (value === null) {
    return errors;
  }

  if (schema.const !== undefined && value !== schema.const) {
    errors.push(
      `${pointer}: expected const ${JSON.stringify(schema.const)}, got ${JSON.stringify(value)}`,
    );
  }

  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    errors.push(
      `${pointer}: value ${JSON.stringify(value)} is not in enum [${schema.enum.map((v) => JSON.stringify(v)).join(', ')}]`,
    );
  }

  if (typeof value === 'string') {
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) {
      errors.push(
        `${pointer}: string length ${value.length} is less than minLength ${schema.minLength}`,
      );
    }
    if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) {
      errors.push(
        `${pointer}: string length ${value.length} exceeds maxLength ${schema.maxLength}`,
      );
    }
    if (typeof schema.pattern === 'string') {
      const regex = new RegExp(schema.pattern);
      if (!regex.test(value)) {
        errors.push(`${pointer}: value ${JSON.stringify(value)} does not match ${schema.pattern}`);
      }
    }
    if (schema.format === 'date' && !isValidIsoDate(value)) {
      errors.push(`${pointer}: value ${JSON.stringify(value)} is not a valid YYYY-MM-DD date`);
    }
    if (schema.format === 'uri' && !isValidUri(value)) {
      errors.push(`${pointer}: value ${JSON.stringify(value)} is not a valid URI`);
    }
  }

  if (Array.isArray(value) && schema.items) {
    value.forEach((item, idx) => {
      errors.push(...validateAgainstSchema(item, schema.items!, `${pointer}[${idx}]`));
    });
  }

  if (typeof value === 'object' && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    const props = schema.properties ?? {};

    if (Array.isArray(schema.required)) {
      for (const reqKey of schema.required) {
        if (!Object.prototype.hasOwnProperty.call(obj, reqKey) || obj[reqKey] === undefined) {
          errors.push(`${pointer}: missing required property "${reqKey}"`);
        }
      }
    }

    for (const [key, propValue] of Object.entries(obj)) {
      if (Object.prototype.hasOwnProperty.call(props, key)) {
        errors.push(...validateAgainstSchema(propValue, props[key]!, `${pointer}.${key}`));
      } else if (schema.additionalProperties === false) {
        errors.push(
          `${pointer}: unexpected additional property "${key}" (additionalProperties: false)`,
        );
      } else if (
        typeof schema.additionalProperties === 'object' &&
        schema.additionalProperties !== null
      ) {
        errors.push(
          ...validateAgainstSchema(propValue, schema.additionalProperties, `${pointer}.${key}`),
        );
      }
    }
  }

  return errors;
}

function validateProviderSemantics(manifest: Record<string, unknown>): string[] {
  const errors: string[] = [];
  if (typeof manifest.baseUrl === 'string') {
    if (!isValidHttpUri(manifest.baseUrl)) {
      errors.push('$.baseUrl: must be an http:// or https:// URI');
    } else {
      const pkgType: ProviderPackageType =
        manifest.packageType === 'experimental-adapter' ? 'experimental-adapter' : 'official-json';
      const urlCheck = validateProviderTargetUrl(manifest.baseUrl, pkgType, 'baseUrl');
      if (!urlCheck.valid) {
        errors.push(`$.baseUrl: ${urlCheck.error ?? 'forbidden target URL'}`);
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
  return errors;
}

const schemaCache = new Map<string, JsonSchemaNode>();

function getProviderSchema(schemasDir: string): JsonSchemaNode {
  const schemaPath = path.resolve(schemasDir, 'provider.schema.json');
  const cached = schemaCache.get(schemaPath);
  if (cached) return cached;

  const raw = fs.readFileSync(schemaPath, 'utf8');
  const parsed = JSON.parse(raw) as JsonSchemaNode;
  schemaCache.set(schemaPath, parsed);
  return parsed;
}

export interface ManifestValidationResult {
  valid: boolean;
  errors: string[];
  manifest?: ProviderManifest;
}

export function validateProviderManifest(
  candidate: unknown,
  schemasDir: string = path.resolve(import.meta.dirname, '../../schemas'),
): ManifestValidationResult {
  const providerSchema = getProviderSchema(schemasDir);
  const errors = validateAgainstSchema(candidate, providerSchema);

  if (errors.length === 0 && candidate && typeof candidate === 'object' && !Array.isArray(candidate)) {
    errors.push(...validateProviderSemantics(candidate as Record<string, unknown>));
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  return {
    valid: true,
    errors: [],
    manifest: candidate as ProviderManifest,
  };
}

export function loadSeedManifests(
  schemasDir: string = path.resolve(import.meta.dirname, '../../schemas'),
): ProviderManifest[] {
  const examplesDir = path.join(schemasDir, 'examples');
  if (!fs.existsSync(examplesDir)) {
    return [];
  }

  const manifests: ProviderManifest[] = [];
  const files = fs
    .readdirSync(examplesDir)
    .filter((f) => f.endsWith('.provider.json'))
    .sort();

  for (const file of files) {
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(examplesDir, file), 'utf8'));
      const res = validateProviderManifest(parsed, schemasDir);
      if (res.valid && res.manifest) {
        manifests.push(res.manifest);
      }
    } catch {
      // Ignore unreadable example files
    }
  }

  return manifests;
}

export function buildProviderAuthHeaders(
  auth: ProviderAuthConfig,
  rawSecret: string,
): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    ...(auth.extraHeaders ?? {}),
  };

  if (auth.type === 'bearer') {
    const headerName = auth.header || 'Authorization';
    const prefix = auth.prefix !== undefined ? auth.prefix : 'Bearer ';
    headers[headerName] = `${prefix}${rawSecret}`;
  } else if (auth.type === 'header') {
    const headerName = auth.header || 'X-API-Key';
    const prefix = auth.prefix ?? '';
    headers[headerName] = `${prefix}${rawSecret}`;
  }

  return headers;
}
