/** Shared application state: the signed-in session and the active property. */
import { api } from './api.js';

const PROPERTY_KEY = 'apaleo-clone.property';

export const state = {
  properties: [],
  /** The full property record for the active selection. */
  property: null,
  account: null,
  /** Cached per property so views do not refetch the same lookups. */
  cache: new Map(),
};

export function propertyId() {
  return state.property?.id ?? null;
}

/** The date the property is operating on, which is what every view defaults to. */
export function businessDate() {
  return state.property?.businessDate ?? today();
}

export function today() {
  return new Date().toISOString().slice(0, 10);
}

/** Today as the property sees it, which is not necessarily today here. */
function todayInZone(timeZone) {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date());
  } catch {
    return today();
  }
}

/**
 * The date the property is operating on.
 *
 * apaleo does not publish this as a field, so it is derived the same way the
 * server computes it: the night audit closes a date, and the property then
 * operates on the next one. With no audit yet, it is simply today in the
 * property's own time zone.
 */
async function resolveBusinessDate(property) {
  const local = todayInZone(property.timeZone);
  try {
    const { items } = await api.nightAuditLogs(property.id);
    const lastClosed = items[0]?.businessDate;
    if (!lastClosed) return local;
    const next = new Date(`${lastClosed}T00:00:00Z`);
    next.setUTCDate(next.getUTCDate() + 1);
    const afterAudit = next.toISOString().slice(0, 10);
    // The audit can only move the date forward, never behind the wall clock.
    return afterAudit > local ? afterAudit : local;
  } catch {
    return local;
  }
}

export async function loadProperties() {
  const [{ items }, account] = await Promise.all([
    api.properties({ includeArchived: false }),
    api.account().catch(() => null),
  ]);
  state.properties = items;
  state.account = account;

  let preferred = null;
  try {
    preferred = localStorage.getItem(PROPERTY_KEY);
  } catch { /* ignore */ }

  const chosen = items.find((p) => p.id === preferred) ?? items[0] ?? null;
  if (chosen) await selectProperty(chosen.id);
  return items;
}

export async function selectProperty(id) {
  state.cache.clear();
  // The list endpoint resolves localized text to a string; the detail
  // endpoint carries the business date and the full dictionaries.
  state.property = await api.property(id);
  state.property.displayName = resolveName(state.property.name);
  state.property.businessDate = await resolveBusinessDate(state.property);
  try {
    localStorage.setItem(PROPERTY_KEY, id);
  } catch { /* ignore */ }
  return state.property;
}

/** Refresh the active property, e.g. after the night audit moves its date. */
export async function refreshProperty() {
  if (state.property) await selectProperty(state.property.id);
}

export function resolveName(name) {
  if (!name) return '';
  if (typeof name === 'string') return name;
  return name.en ?? Object.values(name)[0] ?? '';
}

/**
 * Memoize a per-property lookup (unit groups, rate plans, services...) so
 * switching views does not refetch configuration that rarely changes.
 */
export async function cached(key, loader) {
  const scoped = `${propertyId()}:${key}`;
  if (!state.cache.has(scoped)) state.cache.set(scoped, loader());
  try {
    return await state.cache.get(scoped);
  } catch (err) {
    state.cache.delete(scoped);
    throw err;
  }
}

export function invalidate(key) {
  if (key === undefined) state.cache.clear();
  else state.cache.delete(`${propertyId()}:${key}`);
}
