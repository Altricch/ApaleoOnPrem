import fs from 'fs';
import path from 'path';
import { config } from './config';

/**
 * Loads the OpenAPI (Swagger 2.0) documents downloaded from apaleo and exposes
 * them for three jobs: serving the docs UI, validating request bodies against
 * the real definitions, and checking at boot that every documented operation
 * is actually routed.
 */

export interface SpecDoc {
  key: string;
  title: string;
  version: string;
  swagger: string;
  info: Record<string, any>;
  paths: Record<string, Record<string, any>>;
  definitions: Record<string, any>;
  [k: string]: any;
}

export interface OperationInfo {
  spec: string;
  method: string;
  /** The templated path exactly as the spec declares it, e.g. `/inventory/v1/properties/{id}`. */
  path: string;
  operationId: string;
  tag: string;
  summary: string;
  scopes: string[];
  bodyDefinition?: string;
  bodyRequired: boolean;
}

/** The stable, publicly supported surface. */
export const V1_SPECS = [
  'account-v1',
  'availability-v1',
  'booking-v1',
  'finance-v1',
  'inventory-v1',
  'logs-v1',
  'operations-v1',
  'rateplan-v1',
  'reports-v1',
  'settings-v1',
] as const;

const docs = new Map<string, SpecDoc>();
let operations: OperationInfo[] | null = null;

export function loadSpecs(): Map<string, SpecDoc> {
  if (docs.size) return docs;
  if (!fs.existsSync(config.specDir)) return docs;
  for (const file of fs.readdirSync(config.specDir)) {
    if (!file.endsWith('.json') || file.startsWith('_')) continue;
    const key = file.replace(/\.json$/, '');
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(config.specDir, file), 'utf8'));
      docs.set(key, {
        key,
        title: raw.info?.title ?? key,
        version: raw.info?.version ?? 'v1',
        swagger: raw.swagger ?? '2.0',
        info: raw.info ?? {},
        paths: raw.paths ?? {},
        definitions: raw.definitions ?? {},
        ...raw,
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(`[apaleo-clone] could not parse spec ${file}:`, err);
    }
  }
  return docs;
}

export function getSpec(key: string): SpecDoc | undefined {
  return loadSpecs().get(key);
}

export function specKeys(): string[] {
  return [...loadSpecs().keys()].sort();
}

/**
 * apaleo documents required scopes in prose:
 *   "You must have at least one of these scopes: 'properties.create, setup.manage'."
 * The quoted form is authoritative; the unquoted fallback runs to the end of
 * the sentence rather than stopping at the dot inside a scope name.
 */
const QUOTED_SCOPES_RE = /scopes?:\s*'([^']+)'/i;
const BARE_SCOPES_RE = /scopes?:\s*([a-z0-9_.,\s-]+)/i;

/** Flatten every documented V1 operation, with its declared scopes. */
export function listOperations(): OperationInfo[] {
  if (operations) return operations;
  const out: OperationInfo[] = [];
  for (const key of V1_SPECS) {
    const doc = getSpec(key);
    if (!doc) continue;
    for (const [p, item] of Object.entries(doc.paths)) {
      for (const [method, op] of Object.entries(item)) {
        if (!['get', 'post', 'put', 'patch', 'delete', 'head'].includes(method)) continue;
        const description: string = op.description ?? '';
        const match = QUOTED_SCOPES_RE.exec(description) ?? BARE_SCOPES_RE.exec(description);
        const scopes = match
          ? match[1]!
            .split(',')
            .map((x) => x.trim().replace(/[^a-z0-9_.-]/gi, ''))
            .filter(Boolean)
          : [];
        const bodyParam = (op.parameters ?? []).find((x: any) => x.in === 'body');
        out.push({
          spec: key,
          method: method.toUpperCase(),
          path: p,
          operationId: op.operationId ?? `${method}:${p}`,
          tag: (op.tags ?? [])[0] ?? 'Other',
          summary: op.summary ?? '',
          scopes,
          bodyDefinition: refName(bodyParam?.schema),
          bodyRequired: Boolean(bodyParam?.required),
        });
      }
    }
  }
  operations = out;
  return out;
}

function refName(schema: any): string | undefined {
  if (!schema) return undefined;
  if (typeof schema.$ref === 'string') return schema.$ref.split('/').pop();
  if (schema.type === 'array' && schema.items?.$ref) return `array:${schema.items.$ref.split('/').pop()}`;
  return undefined;
}

/* -------------------------------------------------------------- validation */

export interface ValidationContext {
  definitions: Record<string, any>;
  errors: string[];
}

/**
 * Validate `value` against a named definition from one of the specs.
 * Returns the list of human-readable problems, empty when the body is valid.
 *
 * Deliberately lenient about unknown properties (the upstream ASP.NET model
 * binder ignores them) but strict about types, enums, required members,
 * numeric bounds and string formats.
 */
export function validateDefinition(specKey: string, definition: string, value: unknown): string[] {
  const doc = getSpec(specKey);
  if (!doc) return [];
  const isArray = definition.startsWith('array:');
  const name = isArray ? definition.slice('array:'.length) : definition;
  const schema = doc.definitions[name];
  if (!schema) return [];
  const ctx: ValidationContext = { definitions: doc.definitions, errors: [] };
  if (isArray) {
    walk(value, { type: 'array', items: { $ref: `#/definitions/${name}` } }, '', ctx);
  } else {
    walk(value, schema, '', ctx);
  }
  return ctx.errors;
}

const MAX_ERRORS = 25;

function fail(ctx: ValidationContext, pathStr: string, message: string): void {
  if (ctx.errors.length >= MAX_ERRORS) return;
  ctx.errors.push(pathStr ? `${pathStr}: ${message}` : message);
}

function resolve(schema: any, ctx: ValidationContext): any {
  let s = schema;
  let guard = 0;
  while (s && typeof s.$ref === 'string' && guard++ < 20) {
    const name = s.$ref.split('/').pop()!;
    s = ctx.definitions[name];
  }
  return s ?? {};
}

function walk(value: unknown, rawSchema: any, pathStr: string, ctx: ValidationContext): void {
  if (ctx.errors.length >= MAX_ERRORS) return;
  const schema = resolve(rawSchema, ctx);

  // `allOf` composition: every branch must hold.
  if (Array.isArray(schema.allOf)) {
    for (const branch of schema.allOf) walk(value, branch, pathStr, ctx);
    if (!schema.type && !schema.properties) return;
  }

  if (value === null || value === undefined) {
    // Nullability is expressed with the `x-nullable` vendor extension; absence
    // of a value is checked by the parent via `required`.
    return;
  }

  const type = schema.type ?? (schema.properties ? 'object' : undefined);

  switch (type) {
    case 'object': {
      if (typeof value !== 'object' || Array.isArray(value)) {
        return fail(ctx, pathStr, `expected an object but got ${describe(value)}.`);
      }
      const obj = value as Record<string, unknown>;
      for (const req of schema.required ?? []) {
        const present = obj[req] !== undefined && obj[req] !== null;
        if (!present && !(schema.properties?.[req]?.readOnly)) {
          fail(ctx, join(pathStr, req), 'is required.');
        }
      }
      for (const [key, propSchema] of Object.entries<any>(schema.properties ?? {})) {
        if (obj[key] === undefined) continue;
        if (propSchema.readOnly) continue;
        walk(obj[key], propSchema, join(pathStr, key), ctx);
      }
      if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
        const declared = new Set(Object.keys(schema.properties ?? {}));
        for (const [key, v] of Object.entries(obj)) {
          if (declared.has(key)) continue;
          walk(v, schema.additionalProperties, join(pathStr, key), ctx);
        }
      }
      return;
    }
    case 'array': {
      if (!Array.isArray(value)) {
        return fail(ctx, pathStr, `expected an array but got ${describe(value)}.`);
      }
      if (typeof schema.minItems === 'number' && value.length < schema.minItems) {
        fail(ctx, pathStr, `must contain at least ${schema.minItems} item(s).`);
      }
      if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) {
        fail(ctx, pathStr, `must contain at most ${schema.maxItems} item(s).`);
      }
      if (schema.items) {
        value.forEach((v, i) => walk(v, schema.items, `${pathStr}[${i}]`, ctx));
      }
      return;
    }
    case 'string': {
      if (typeof value !== 'string') {
        return fail(ctx, pathStr, `expected a string but got ${describe(value)}.`);
      }
      if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
        return fail(ctx, pathStr, `must be one of: ${schema.enum.join(', ')}.`);
      }
      if (typeof schema.minLength === 'number' && value.length < schema.minLength) {
        fail(ctx, pathStr, `must be at least ${schema.minLength} character(s) long.`);
      }
      if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) {
        fail(ctx, pathStr, `must be at most ${schema.maxLength} character(s) long.`);
      }
      if (typeof schema.pattern === 'string' && !safeMatch(schema.pattern, value)) {
        fail(ctx, pathStr, `must match the pattern ${schema.pattern}.`);
      }
      checkFormat(value, schema.format, pathStr, ctx);
      return;
    }
    case 'integer':
    case 'number': {
      if (typeof value !== 'number' || Number.isNaN(value)) {
        return fail(ctx, pathStr, `expected a number but got ${describe(value)}.`);
      }
      if (type === 'integer' && !Number.isInteger(value)) {
        fail(ctx, pathStr, 'must be a whole number.');
      }
      if (typeof schema.minimum === 'number' && value < schema.minimum) {
        fail(ctx, pathStr, `must be ${schema.minimum} or greater.`);
      }
      if (typeof schema.maximum === 'number' && value > schema.maximum) {
        fail(ctx, pathStr, `must be ${schema.maximum} or less.`);
      }
      return;
    }
    case 'boolean': {
      if (typeof value !== 'boolean') {
        fail(ctx, pathStr, `expected true or false but got ${describe(value)}.`);
      }
      return;
    }
    default:
      // No declared type (free-form object) - nothing to check.
  }
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

function checkFormat(value: string, format: string | undefined, pathStr: string, ctx: ValidationContext): void {
  switch (format) {
    case 'date':
      if (!DATE_ONLY.test(value)) fail(ctx, pathStr, 'must be a date in the format YYYY-MM-DD.');
      break;
    case 'date-time':
      if (Number.isNaN(Date.parse(value))) fail(ctx, pathStr, 'must be a valid ISO 8601 date-time.');
      break;
    case 'email':
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value)) fail(ctx, pathStr, 'must be a valid email address.');
      break;
    case 'uri':
      try {
        // eslint-disable-next-line no-new
        new URL(value);
      } catch {
        fail(ctx, pathStr, 'must be a valid absolute URI.');
      }
      break;
    default:
      break;
  }
}

const patternCache = new Map<string, RegExp | null>();

function safeMatch(pattern: string, value: string): boolean {
  let re = patternCache.get(pattern);
  if (re === undefined) {
    try {
      re = new RegExp(pattern);
    } catch {
      re = null;
    }
    patternCache.set(pattern, re);
  }
  return re === null ? true : re.test(value);
}

function join(base: string, key: string): string {
  return base ? `${base}.${key}` : key;
}

function describe(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'an array';
  return `a ${typeof v}`;
}
