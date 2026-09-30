import { dispatch, type ApiRequest, type ApiResponse } from './dispatch';
import { ToolError, ok, raiseFor, type FailureContext } from './errors';

/**
 * Shared state for a server process: the credential, a resolved property, and
 * short-lived caches over configuration that tools read constantly but that
 * almost never changes within a conversation.
 *
 * The caches matter more than they look. Without them a question like "what
 * arrives tomorrow and at what rate" re-reads the property, its unit groups
 * and its rate plans on every tool call; with them each is read once and the
 * rest of the conversation is served from memory.
 */

const token = process.env.APALEO_TOKEN;

/** How long configuration stays cached. Long enough for a conversation. */
const TTL_MS = Number(process.env.APALEO_MCP_CACHE_TTL ?? 30_000);

interface Entry<T> {
  value: Promise<T>;
  expires: number;
}

const memo = new Map<string, Entry<unknown>>();

/** Memoize a lookup for `TTL_MS`. A rejected lookup is never cached. */
export async function cached<T>(key: string, load: () => Promise<T>): Promise<T> {
  const now = Date.now();
  const hit = memo.get(key);
  if (hit && hit.expires > now) return hit.value as Promise<T>;

  const value = load();
  memo.set(key, { value: value as Promise<unknown>, expires: now + TTL_MS });
  try {
    return await value;
  } catch (err) {
    memo.delete(key);
    throw err;
  }
}

/** Drop cached configuration. Called after any tool that changes it. */
export function invalidate(prefix?: string): void {
  if (!prefix) {
    memo.clear();
    return;
  }
  for (const key of memo.keys()) {
    if (key.startsWith(prefix)) memo.delete(key);
  }
}

/* --------------------------------------------------------------- calling */

/** Call the API and return the payload, raising an actionable error on failure. */
export async function call<T = any>(
  request: Omit<ApiRequest, 'token'>,
  context: FailureContext = {},
): Promise<T> {
  const response: ApiResponse<T> = await dispatch<T>({ ...request, token });
  if (!ok(response)) raiseFor(response, context);
  return response.body;
}

/** Call a list endpoint. A `204 No Content` becomes an empty page, not a crash. */
export async function callList<T>(
  request: Omit<ApiRequest, 'token'>,
  key: string,
  context: FailureContext = {},
): Promise<{ items: T[]; count: number }> {
  const body = await call<Record<string, unknown>>(request, context);
  if (!body) return { items: [], count: 0 };
  const items = (body[key] as T[]) ?? [];
  return { items, count: (body.count as number) ?? items.length };
}

/** Call a mutating endpoint that answers `204 No Content`. */
export async function callVoid(
  request: Omit<ApiRequest, 'token'>,
  context: FailureContext = {},
): Promise<void> {
  await call(request, context);
}

/* ------------------------------------------------------------- properties */

export interface PropertySummary {
  id: string;
  code: string;
  name: string;
  status: string;
  currencyCode: string;
  timeZone: string;
  city?: string;
  countryCode?: string;
}

export async function listProperties(): Promise<PropertySummary[]> {
  return cached('properties', async () => {
    const { items } = await callList<Record<string, any>>(
      { method: 'GET', path: '/inventory/v1/properties', query: { pageSize: 500 } },
      'properties',
    );
    return items.map((p) => ({
      id: p.id,
      code: p.code,
      name: typeof p.name === 'string' ? p.name : (p.name?.en ?? p.id),
      status: p.status,
      currencyCode: p.currencyCode,
      timeZone: p.timeZone,
      city: p.location?.city,
      countryCode: p.location?.countryCode,
    }));
  });
}

/**
 * Resolve the property a tool should act on.
 *
 * When the account has exactly one property, omitting the argument is
 * unambiguous and the tool should not force the model to look it up first.
 * With several, guessing would be worse than asking, so the error names them.
 */
export async function resolveProperty(id?: string): Promise<PropertySummary> {
  const properties = await listProperties();
  if (!properties.length) {
    throw new ToolError('This installation has no properties. Seed demo data with `npm run seed`.');
  }
  if (!id) {
    if (properties.length === 1) return properties[0]!;
    throw new ToolError(
      `propertyId is required: this account has ${properties.length} properties `
      + `(${properties.map((p) => `${p.id} = ${p.name}`).join(', ')}).`,
    );
  }
  const wanted = id.toUpperCase();
  const match = properties.find((p) => p.id.toUpperCase() === wanted || p.code.toUpperCase() === wanted);
  if (!match) {
    throw new ToolError(
      `No property '${id}'. Known properties: ${properties.map((p) => p.id).join(', ')}.`,
      404,
    );
  }
  return match;
}

/**
 * The date the property is operating on.
 *
 * apaleo does not publish this as a field. It is derived exactly as the
 * server computes it: the night audit closes a date and the property moves to
 * the next one; with no audit yet it is today in the property's own zone.
 */
export async function businessDate(property: PropertySummary): Promise<string> {
  return cached(`businessDate:${property.id}`, async () => {
    const local = todayIn(property.timeZone);
    const { items } = await callList<{ businessDate: string }>(
      {
        method: 'GET',
        path: '/logs/v1/finance/night-audit',
        query: { propertyIds: property.id, pageSize: 1 },
      },
      'logEntries',
    );
    const lastClosed = items[0]?.businessDate;
    if (!lastClosed) return local;
    const next = addDays(lastClosed, 1);
    return next > local ? next : local;
  });
}

export function todayIn(timeZone: string): string {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date());
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function diffDays(from: string, to: string): number {
  return Math.round(
    (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000,
  );
}

/** Resolve a date window, defaulting to the property's own calendar. */
export async function window(
  property: PropertySummary,
  from: string | undefined,
  to: string | undefined,
  defaultSpan: number,
): Promise<{ from: string; to: string }> {
  const start = from ?? await businessDate(property);
  const end = to ?? addDays(start, defaultSpan);
  if (diffDays(start, end) < 0) {
    throw new ToolError(`'to' (${end}) must not be before 'from' (${start}).`);
  }
  return { from: start, to: end };
}

/* ------------------------------------------------- configuration lookups */

export interface NamedRef { id: string; code?: string; name?: string }

export async function unitGroups(propertyId: string): Promise<NamedRef[]> {
  return cached(`unitGroups:${propertyId}`, async () => {
    const { items } = await callList<any>(
      { method: 'GET', path: '/inventory/v1/unit-groups', query: { propertyId, pageSize: 500 } },
      'unitGroups',
    );
    return items.map((g) => ({ id: g.id, code: g.code, name: g.name }));
  });
}

export async function ratePlans(propertyId: string): Promise<any[]> {
  return cached(`ratePlans:${propertyId}`, async () => {
    const { items } = await callList<any>(
      { method: 'GET', path: '/rateplan/v1/rate-plans', query: { propertyId, pageSize: 500 } },
      'ratePlans',
    );
    return items;
  });
}

export async function services(propertyId: string): Promise<any[]> {
  return cached(`services:${propertyId}`, async () => {
    const { items } = await callList<any>(
      { method: 'GET', path: '/rateplan/v1/services', query: { propertyId, pageSize: 500 } },
      'services',
    );
    return items;
  });
}

/** Units, keyed by id, for turning unit ids into room numbers cheaply. */
export async function unitNames(propertyId: string): Promise<Map<string, string>> {
  return cached(`unitNames:${propertyId}`, async () => {
    const { items } = await callList<any>(
      { method: 'GET', path: '/inventory/v1/units', query: { propertyId, pageSize: 500 } },
      'units',
    );
    return new Map(items.map((u) => [u.id, u.name]));
  });
}
