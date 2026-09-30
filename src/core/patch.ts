import { unprocessable } from './errors';

/**
 * RFC 6902 JSON Patch. apaleo exposes `PATCH` on almost every configuration
 * resource and documents the body as a list of these operations, so we need a
 * faithful implementation rather than a merge-patch shortcut.
 */
export interface PatchOperation {
  op: 'add' | 'remove' | 'replace' | 'move' | 'copy' | 'test';
  path: string;
  value?: unknown;
  from?: string;
}

type Json = any;

function unescape(token: string): string {
  return token.replace(/~1/g, '/').replace(/~0/g, '~');
}

function parsePointer(pointer: string): string[] {
  if (pointer === '') return [];
  if (!pointer.startsWith('/')) {
    throw unprocessable(`'${pointer}' is not a valid JSON pointer.`);
  }
  return pointer.slice(1).split('/').map(unescape);
}

function navigate(doc: Json, tokens: string[]): { parent: Json; key: string } {
  let current = doc;
  for (let i = 0; i < tokens.length - 1; i++) {
    const token = tokens[i]!;
    if (current === null || typeof current !== 'object') {
      throw unprocessable(`Path '/${tokens.join('/')}' does not exist on the resource.`);
    }
    const next = Array.isArray(current) ? current[index(current, token)] : current[token];
    if (next === undefined) {
      // Auto-vivify intermediate objects so `add` can create nested structures,
      // which is what callers expect when setting e.g. /bankAccount/iban.
      const created = {};
      if (Array.isArray(current)) current[index(current, token)] = created;
      else current[token] = created;
      current = created;
    } else {
      current = next;
    }
  }
  return { parent: current, key: tokens[tokens.length - 1]! };
}

function index(arr: unknown[], token: string): number {
  if (token === '-') return arr.length;
  const n = Number(token);
  if (!Number.isInteger(n) || n < 0) {
    throw unprocessable(`'${token}' is not a valid array index.`);
  }
  return n;
}

function getAt(doc: Json, pointer: string): Json {
  const tokens = parsePointer(pointer);
  let current = doc;
  for (const token of tokens) {
    if (current === null || typeof current !== 'object') return undefined;
    current = Array.isArray(current) ? current[index(current, token)] : current[token];
  }
  return current;
}

function deepEqual(a: Json, b: Json): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => deepEqual(a[k], b[k]));
}

/**
 * Apply a patch document to `target` in place and return it.
 * Operations are validated first so an invalid patch leaves nothing behind.
 */
export function applyPatch<T extends object>(target: T, operations: readonly PatchOperation[]): T {
  if (!Array.isArray(operations)) {
    throw unprocessable('The request body must be a JSON Patch document (an array of operations).');
  }
  // Work on a copy so a failure part-way through is not half-applied.
  const doc: Json = JSON.parse(JSON.stringify(target));

  for (const [i, raw] of operations.entries()) {
    const op = raw?.op;
    const at = `Operation ${i}`;
    if (!op) throw unprocessable(`${at}: 'op' is required.`);
    if (raw.path === undefined || raw.path === null) {
      throw unprocessable(`${at}: 'path' is required.`);
    }
    const tokens = parsePointer(raw.path);

    switch (op) {
      case 'add': {
        if (tokens.length === 0) throw unprocessable(`${at}: cannot 'add' to the document root.`);
        const { parent, key } = navigate(doc, tokens);
        if (Array.isArray(parent)) parent.splice(index(parent, key), 0, raw.value);
        else parent[key] = raw.value;
        break;
      }
      case 'replace': {
        if (tokens.length === 0) throw unprocessable(`${at}: cannot 'replace' the document root.`);
        const { parent, key } = navigate(doc, tokens);
        if (Array.isArray(parent)) parent[index(parent, key)] = raw.value;
        else parent[key] = raw.value;
        break;
      }
      case 'remove': {
        if (tokens.length === 0) throw unprocessable(`${at}: cannot 'remove' the document root.`);
        const { parent, key } = navigate(doc, tokens);
        if (Array.isArray(parent)) parent.splice(index(parent, key), 1);
        else delete parent[key];
        break;
      }
      case 'move':
      case 'copy': {
        if (!raw.from) throw unprocessable(`${at}: '${op}' requires 'from'.`);
        const value = getAt(doc, raw.from);
        if (op === 'move') {
          const fromTokens = parsePointer(raw.from);
          const src = navigate(doc, fromTokens);
          if (Array.isArray(src.parent)) src.parent.splice(index(src.parent, src.key), 1);
          else delete src.parent[src.key];
        }
        const { parent, key } = navigate(doc, tokens);
        const cloned = value === undefined ? undefined : JSON.parse(JSON.stringify(value));
        if (Array.isArray(parent)) parent.splice(index(parent, key), 0, cloned);
        else parent[key] = cloned;
        break;
      }
      case 'test': {
        if (!deepEqual(getAt(doc, raw.path), raw.value)) {
          throw unprocessable(`${at}: test failed for path '${raw.path}'.`);
        }
        break;
      }
      default:
        throw unprocessable(`${at}: '${String(op)}' is not a supported JSON Patch operation.`);
    }
  }

  // Copy the result back onto the original object reference.
  for (const key of Object.keys(target)) delete (target as Json)[key];
  Object.assign(target, doc);
  return target;
}

/**
 * Reject patches that touch immutable members. apaleo answers 400 when you try
 * to change e.g. a property's `code` or `id`.
 */
export function rejectImmutablePaths(operations: readonly PatchOperation[], immutable: readonly string[]): void {
  for (const op of operations) {
    const head = `/${parsePointer(op.path ?? '')[0] ?? ''}`;
    if (immutable.includes(head)) {
      throw unprocessable(`'${head}' cannot be changed.`);
    }
  }
}
