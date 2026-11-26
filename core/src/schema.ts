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

export type DataRetentionKind = 'zero' | 'transient' | 'retained' | 'variable';
export type ProviderTrainingPolicy = 'never' | 'opt_out' | 'allowed' | 'unknown';
export type ProviderRateLimitKind = 'none' | 'requests' | 'tokens' | 'concurrency';
export type ProviderRateLimitWindow = 'hour' | 'day' | 'week';

export interface ProviderPrivacyConfig {
  retention: DataRetentionKind;
  training: ProviderTrainingPolicy;
  retentionDays?: number;
  policyUrl?: string;
  note?: string;
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
  privacy?: ProviderPrivacyConfig;
  rateLimitKind?: ProviderRateLimitKind;
  rateLimitWindows?: ProviderRateLimitWindow[];
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

const SAFE_RELATIVE_ENDPOINT_PATH_RE = /^\/(?!\/)[^\s\\?#\u0000-\u001f\u007f]*$/;
const RFC9110_HEADER_NAME_RE = /^[A-Za-z0-9-]+$/;
const HEADER_CONTROL_CHARS_RE = /[\r\n\0\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

const FORBIDDEN_EXTRA_HEADERS = new Set<string>([
  'host',
  'authorization',
  'proxy-authorization',
  'cookie',
  'content-length',
  'transfer-encoding',
  'connection',
  'upgrade',
  'te',
  'forwarded',
]);

export function isSafeRelativeEndpointPath(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  if (value.length === 0 || value.length > 512) return false;
  if (!SAFE_RELATIVE_ENDPOINT_PATH_RE.test(value)) return false;
  if (/(^|\/)\.\.(\/|$)/.test(value)) return false;
  return true;
}

export function isValidHeaderName(name: string): boolean {
  return name.length > 0 && name.length <= 128 && RFC9110_HEADER_NAME_RE.test(name);
}

export function hasHeaderControlChars(value: string): boolean {
  return HEADER_CONTROL_CHARS_RE.test(value);
}

export function isForbiddenExtraHeaderName(name: string): boolean {
  const lower = name.trim().toLowerCase();
  return FORBIDDEN_EXTRA_HEADERS.has(lower) || lower.startsWith('x-forwarded-');
}

export function isForbiddenAuthHeaderName(name: string): boolean {
  const lower = name.trim().toLowerCase();
  if (lower === 'authorization') return false;
  return FORBIDDEN_EXTRA_HEADERS.has(lower) || lower.startsWith('x-forwarded-');
}

export function validateAuthConfig(auth: unknown): string[] {
  const errors: string[] = [];
  if (!auth || typeof auth !== 'object' || Array.isArray(auth)) {
    return errors;
  }

  const cfg = auth as Record<string, unknown>;
  if (typeof cfg.header === 'string') {
    if (!isValidHeaderName(cfg.header) || hasHeaderControlChars(cfg.header)) {
      errors.push(
        `$.auth.header: invalid header name ${JSON.stringify(cfg.header)} (expected RFC 9110 token ^[A-Za-z0-9-]+$)`,
      );
    } else if (isForbiddenAuthHeaderName(cfg.header)) {
      errors.push(
        `$.auth.header: header "${cfg.header}" is forbidden as an auth header`,
      );
    }
  }

  if (cfg.prefix !== undefined) {
    if (typeof cfg.prefix !== 'string' || hasHeaderControlChars(cfg.prefix)) {
      errors.push('$.auth.prefix: contains forbidden control or CRLF characters');
    }
  }

  if (cfg.extraHeaders !== undefined) {
    if (
      !cfg.extraHeaders ||
      typeof cfg.extraHeaders !== 'object' ||
      Array.isArray(cfg.extraHeaders)
    ) {
      errors.push('$.auth.extraHeaders: must be an object');
    } else {
      for (const [key, val] of Object.entries(cfg.extraHeaders as Record<string, unknown>)) {
        if (!isValidHeaderName(key) || hasHeaderControlChars(key)) {
          errors.push(
            `$.auth.extraHeaders.${key}: invalid header name (expected RFC 9110 token ^[A-Za-z0-9-]+$)`,
          );
          continue;
        }
        if (isForbiddenExtraHeaderName(key)) {
          errors.push(
            `$.auth.extraHeaders.${key}: header "${key}" is forbidden in extraHeaders`,
          );
          continue;
        }
        if (typeof val !== 'string' || hasHeaderControlChars(val)) {
          errors.push(
            `$.auth.extraHeaders.${key}: header value must be a string without CRLF or control characters`,
          );
        }
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
  errors.push(...validateAuthConfig(manifest.auth));
  if (manifest.modelsEndpoint !== undefined) {
    if (!isSafeRelativeEndpointPath(manifest.modelsEndpoint)) {
      errors.push(
        '$.modelsEndpoint: must be a strict relative path starting with "/" (e.g. "/models") without protocol, host, query, fragment, or path traversal',
      );
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
  if (manifest.adapter && typeof manifest.adapter === 'object' && !Array.isArray(manifest.adapter)) {
    const adapter = manifest.adapter as Record<string, unknown>;
    if (!isSafeRelativeEndpointPath(adapter.healthPath)) {
      errors.push(
        '$.adapter.healthPath: must be a strict relative path starting with "/" (e.g. "/health") without protocol, host, query, fragment, or path traversal',
      );
    }
  }
  if (manifest.privacy !== undefined) {
    if (!manifest.privacy || typeof manifest.privacy !== 'object' || Array.isArray(manifest.privacy)) {
      errors.push('$.privacy: must be an object');
    } else {
      const priv = manifest.privacy as Record<string, unknown>;
      const validRetention: DataRetentionKind[] = ['zero', 'transient', 'retained', 'variable'];
      const validTraining: ProviderTrainingPolicy[] = ['never', 'opt_out', 'allowed', 'unknown'];
      if (typeof priv.retention !== 'string' || !validRetention.includes(priv.retention as DataRetentionKind)) {
        errors.push(`$.privacy.retention: must be one of ${validRetention.join(', ')}`);
      }
      if (typeof priv.training !== 'string' || !validTraining.includes(priv.training as ProviderTrainingPolicy)) {
        errors.push(`$.privacy.training: must be one of ${validTraining.join(', ')}`);
      }
      if (priv.retentionDays !== undefined) {
        if (typeof priv.retentionDays !== 'number' || !Number.isInteger(priv.retentionDays) || priv.retentionDays < 0) {
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
    const validKinds: ProviderRateLimitKind[] = ['none', 'requests', 'tokens', 'concurrency'];
    if (
      typeof manifest.rateLimitKind !== 'string' ||
      !validKinds.includes(manifest.rateLimitKind as ProviderRateLimitKind)
    ) {
      errors.push(`$.rateLimitKind: must be one of ${validKinds.join(', ')}`);
    }
  }
  if (manifest.rateLimitWindows !== undefined) {
    if (!Array.isArray(manifest.rateLimitWindows)) {
      errors.push('$.rateLimitWindows: must be an array');
    } else {
      const validWindows: ProviderRateLimitWindow[] = ['hour', 'day', 'week'];
      const seen = new Set<string>();
      for (let i = 0; i < manifest.rateLimitWindows.length; i++) {
        const w = manifest.rateLimitWindows[i];
        if (typeof w !== 'string' || !validWindows.includes(w as ProviderRateLimitWindow)) {
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

export function mergeHeadersCaseInsensitive(
  base: Record<string, string>,
  overrides?: Record<string, string>,
): Record<string, string> {
  const map = new Map<string, { name: string; value: string }>();

  const setEntry = (name: string, value: string) => {
    if (!isValidHeaderName(name) || hasHeaderControlChars(value)) return;
    map.set(name.toLowerCase(), { name, value });
  };

  for (const [k, v] of Object.entries(base)) {
    setEntry(k, v);
  }
  if (overrides) {
    for (const [k, v] of Object.entries(overrides)) {
      setEntry(k, v);
    }
  }

  const out: Record<string, string> = {};
  for (const { name, value } of map.values()) {
    out[name] = value;
  }
  return out;
}

export function buildProviderAuthHeaders(
  auth: ProviderAuthConfig,
  rawSecret: string,
): Record<string, string> {
  const map = new Map<string, { name: string; value: string }>();
  map.set('accept', { name: 'Accept', value: 'application/json' });

  for (const [key, val] of Object.entries(auth.extraHeaders ?? {})) {
    if (!isValidHeaderName(key) || isForbiddenExtraHeaderName(key)) {
      continue;
    }
    if (typeof val !== 'string' || hasHeaderControlChars(val)) {
      continue;
    }
    map.set(key.toLowerCase(), { name: key, value: val });
  }

  if (auth.type === 'bearer') {
    const headerName = auth.header || 'Authorization';
    const prefix = auth.prefix !== undefined ? auth.prefix : 'Bearer ';
    const value = `${prefix}${rawSecret}`;
    if (
      isValidHeaderName(headerName) &&
      !isForbiddenAuthHeaderName(headerName) &&
      !hasHeaderControlChars(value)
    ) {
      map.set(headerName.toLowerCase(), { name: headerName, value });
    }
  } else if (auth.type === 'header') {
    const headerName = auth.header || 'X-API-Key';
    const prefix = auth.prefix ?? '';
    const value = `${prefix}${rawSecret}`;
    if (
      isValidHeaderName(headerName) &&
      !isForbiddenAuthHeaderName(headerName) &&
      !hasHeaderControlChars(value)
    ) {
      map.set(headerName.toLowerCase(), { name: headerName, value });
    }
  }

  const headers: Record<string, string> = {};
  for (const { name, value } of map.values()) {
    headers[name] = value;
  }
  return headers;
}
