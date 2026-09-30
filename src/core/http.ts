import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { config } from './config';
import { ApiError, badRequest, unprocessable } from './errors';
import { isBusinessDate } from './dates';

/** Wrap an async handler so rejected promises reach the error middleware. */
export function handler(fn: (req: Request, res: Response) => unknown | Promise<unknown>): RequestHandler {
  return (req, res, next) => {
    Promise.resolve(fn(req, res)).catch(next);
  };
}

/* ------------------------------------------------------------------ paging */

export interface Paging {
  pageNumber: number;
  pageSize: number;
  offset: number;
}

/**
 * apaleo pages with `pageNumber`/`pageSize`, caps the size at 500 and answers
 * `204 No Content` when the requested page is past the end of the collection.
 */
export function paging(req: Request): Paging {
  const pageNumber = intParam(req, 'pageNumber', 1);
  const pageSize = intParam(req, 'pageSize', config.defaultPageSize);
  if (pageNumber < 1) throw unprocessable('`pageNumber` must be 1 or greater.');
  if (pageSize < 1) throw unprocessable('`pageSize` must be 1 or greater.');
  if (pageSize > config.maxPageSize) {
    throw unprocessable(`\`pageSize\` must not exceed ${config.maxPageSize}.`);
  }
  return { pageNumber, pageSize, offset: (pageNumber - 1) * pageSize };
}

/**
 * Send a list envelope. `key` is the property the items live under
 * (`properties`, `reservations`, ...). Empty pages become 204, as upstream.
 */
export function sendList<T>(
  res: Response,
  key: string,
  items: readonly T[],
  count: number,
  extra: Record<string, unknown> = {},
): void {
  if (items.length === 0) {
    res.status(204).end();
    return;
  }
  res.status(200).json({ [key]: items, count, ...extra });
}

/** Send a single entity, or 404 via the caller's own `mustExist`. */
export function sendOne(res: Response, body: unknown): void {
  res.status(200).json(body);
}

export function sendCreated(res: Response, location: string, body?: unknown): void {
  res.setHeader('Location', location);
  if (body === undefined) res.status(201).end();
  else res.status(201).json(body);
}

export function sendNoContent(res: Response): void {
  res.status(204).end();
}

/* -------------------------------------------------------------- parameters */

export function rawParams(req: Request, name: string): string[] {
  const v = req.query[name];
  if (v === undefined) return [];
  if (Array.isArray(v)) return v.flatMap((x) => String(x).split(','));
  return String(v).split(',');
}

/** Read a repeated or comma-separated query parameter as a string array. */
export function arrayParam(req: Request, name: string): string[] {
  return rawParams(req, name).map((s) => s.trim()).filter((s) => s.length > 0);
}

export function stringParam(req: Request, name: string): string | undefined {
  const v = req.query[name];
  if (v === undefined) return undefined;
  const s = Array.isArray(v) ? String(v[0]) : String(v);
  return s.length ? s : undefined;
}

export function intParam(req: Request, name: string, fallback: number): number {
  const s = stringParam(req, name);
  if (s === undefined) return fallback;
  const n = Number.parseInt(s, 10);
  if (!Number.isFinite(n)) throw unprocessable(`\`${name}\` must be an integer.`);
  return n;
}

export function optionalIntParam(req: Request, name: string): number | undefined {
  const s = stringParam(req, name);
  if (s === undefined) return undefined;
  const n = Number.parseInt(s, 10);
  if (!Number.isFinite(n)) throw unprocessable(`\`${name}\` must be an integer.`);
  return n;
}

export function numberParam(req: Request, name: string): number | undefined {
  const s = stringParam(req, name);
  if (s === undefined) return undefined;
  const n = Number(s);
  if (!Number.isFinite(n)) throw unprocessable(`\`${name}\` must be a number.`);
  return n;
}

export function boolParam(req: Request, name: string): boolean | undefined {
  const s = stringParam(req, name);
  if (s === undefined) return undefined;
  if (s === 'true' || s === '1') return true;
  if (s === 'false' || s === '0') return false;
  throw unprocessable(`\`${name}\` must be true or false.`);
}

/** A `YYYY-MM-DD` query parameter. */
export function dateParam(req: Request, name: string): string | undefined {
  const s = stringParam(req, name);
  if (s === undefined) return undefined;
  const date = s.length > 10 ? s.slice(0, 10) : s;
  if (!isBusinessDate(date)) throw unprocessable(`\`${name}\` must be a date in the format YYYY-MM-DD.`);
  return date;
}

export function requiredDateParam(req: Request, name: string): string {
  const v = dateParam(req, name);
  if (v === undefined) throw unprocessable(`\`${name}\` is required.`);
  return v;
}

export function requiredStringParam(req: Request, name: string): string {
  const v = stringParam(req, name);
  if (v === undefined) throw unprocessable(`\`${name}\` is required.`);
  return v;
}

/** An ISO date-time query parameter, normalised to a UTC instant. */
export function dateTimeParam(req: Request, name: string): string | undefined {
  const s = stringParam(req, name);
  if (s === undefined) return undefined;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) throw unprocessable(`\`${name}\` must be a valid date-time.`);
  return d.toISOString();
}

/* ---------------------------------------------------------------- `expand` */

/**
 * Most list and detail endpoints accept `?expand=` to inline embedded
 * resources. Unknown values are silently ignored, which the specs call out
 * explicitly.
 */
export class Expand {
  private readonly set: Set<string>;

  constructor(values: readonly string[]) {
    this.set = new Set(values.map((v) => v.trim()).filter(Boolean));
  }

  static from(req: Request): Expand {
    return new Expand(arrayParam(req, 'expand'));
  }

  has(name: string): boolean {
    return this.set.has(name);
  }

  get any(): boolean {
    return this.set.size > 0;
  }
}

/* -------------------------------------------------------------- idempotency */

/**
 * apaleo honours an `Idempotency-Key` header on creating calls. We record the
 * response for a key and replay it on repeat, which is what makes retrying a
 * booking safe.
 */
export function idempotencyKey(req: Request): string | undefined {
  const k = req.get('idempotency-key');
  return k && k.trim().length ? k.trim() : undefined;
}

/* ---------------------------------------------------- error/response plumbing */

export function notImplemented(feature: string): never {
  throw new ApiError(501, `${feature} is not implemented in this clone.`);
}

/** Express error middleware rendering `ApiError` in apaleo's message shape. */
export function errorMiddleware(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  if (res.headersSent) return;
  if (err instanceof ApiError) {
    res.status(err.status).json(err.toBody());
    return;
  }
  if (err instanceof SyntaxError && 'body' in (err as any)) {
    res.status(400).json({ messages: ['The request body is not valid JSON.'] });
    return;
  }
  // eslint-disable-next-line no-console
  console.error(`[apaleo-clone] unhandled error on ${req.method} ${req.originalUrl}`, err);
  res.status(500).json({
    messages: [err instanceof Error ? err.message : 'An unexpected error occurred.'],
  });
}

/** Terminal 404 for routes that exist in no spec. */
export function notFoundMiddleware(req: Request, res: Response): void {
  res.status(404).json({
    messages: [`No route matches ${req.method} ${req.path}.`],
  });
}

export { badRequest };
