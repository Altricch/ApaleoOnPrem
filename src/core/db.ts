import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { config } from './config';

/**
 * Storage is a document store on top of SQLite. Each collection is a table
 * holding the entity as JSON plus a handful of *generated* columns lifted out
 * of that JSON so the filters the API actually exposes (property, status,
 * date range, ...) are index-backed rather than full scans.
 *
 * Going document-shaped rather than fully relational is deliberate: the apaleo
 * models are deeply nested (a reservation carries its time slices, services,
 * guests and folio references inline) and the API always reads and writes them
 * as whole aggregates.
 */

export type Row = Record<string, any>;

/** A column projected out of the JSON payload so it can be indexed. */
interface IndexedColumn {
  name: string;
  /** JSON path inside the document, e.g. `$.propertyId`. */
  jsonPath: string;
  type?: 'TEXT' | 'INTEGER' | 'REAL';
}

interface CollectionDef {
  name: string;
  indexes: IndexedColumn[];
}

const col = (name: string, jsonPath?: string, type: IndexedColumn['type'] = 'TEXT'): IndexedColumn => ({
  name,
  jsonPath: jsonPath ?? `$.${name}`,
  type,
});

/**
 * Every collection the clone persists. Adding a collection here is all that is
 * needed for `store('name')` to work.
 */
const COLLECTIONS: CollectionDef[] = [
  { name: 'accounts', indexes: [col('code')] },
  { name: 'subscriptions', indexes: [] },
  { name: 'users', indexes: [col('subjectId')] },

  { name: 'properties', indexes: [col('code'), col('status'), col('isArchived', '$.isArchived', 'INTEGER')] },
  { name: 'unitGroups', indexes: [col('propertyId'), col('code'), col('type')] },
  { name: 'units', indexes: [col('propertyId'), col('unitGroupId'), col('name'), col('condition'), col('isArchived', '$.isArchived', 'INTEGER')] },
  { name: 'unitAttributes', indexes: [col('name')] },

  { name: 'ageCategories', indexes: [col('propertyId'), col('code')] },
  { name: 'timeSliceDefinitions', indexes: [col('propertyId')] },
  { name: 'ratePlans', indexes: [col('propertyId'), col('code'), col('unitGroupId')] },
  { name: 'rates', indexes: [col('ratePlanId'), col('propertyId'), col('from'), col('to')] },
  { name: 'cancellationPolicies', indexes: [col('propertyId'), col('code')] },
  { name: 'noShowPolicies', indexes: [col('propertyId'), col('code')] },
  { name: 'capturePolicies', indexes: [col('propertyId'), col('code')] },
  { name: 'services', indexes: [col('propertyId'), col('code')] },
  { name: 'companies', indexes: [col('propertyId'), col('code')] },
  { name: 'promoCodes', indexes: [col('propertyId'), col('code')] },
  { name: 'corporateCodes', indexes: [col('propertyId'), col('code')] },

  { name: 'cityTaxes', indexes: [col('propertyId'), col('code')] },
  { name: 'marketSegments', indexes: [col('propertyId'), col('code')] },
  { name: 'subAccounts', indexes: [col('propertyId'), col('number'), col('code')] },
  { name: 'financeAccounts', indexes: [col('propertyId'), col('number'), col('type'), col('parentNumber'), col('scope'), col('reference')] },
  { name: 'accountingTransactions', indexes: [col('propertyId'), col('date'), col('debitedAccount'), col('creditedAccount'), col('entryGroupNumber'), col('reference')] },
  { name: 'invoiceAddresses', indexes: [col('propertyId')] },
  { name: 'propertySettings', indexes: [col('propertyId')] },
  { name: 'featureSettings', indexes: [col('propertyId')] },
  { name: 'languageSettings', indexes: [] },

  { name: 'bookings', indexes: [col('groupId'), col('created')] },
  {
    name: 'reservations',
    indexes: [
      col('bookingId'), col('propertyId'), col('status'), col('blockId'), col('groupId'),
      col('arrival'), col('departure'), col('unitGroupId'), col('unitId', '$.unit.id'),
      col('created'), col('updated'), col('externalCode'), col('channelCode'),
      col('lastName', '$.primaryGuest.lastName'),
    ],
  },
  { name: 'blocks', indexes: [col('propertyId'), col('groupId'), col('status'), col('from'), col('to')] },
  { name: 'groups', indexes: [col('propertyId'), col('code')] },
  { name: 'overbookings', indexes: [col('propertyId'), col('unitGroupId'), col('date')] },

  { name: 'folios', indexes: [col('propertyId'), col('reservationId'), col('type'), col('isClosed', '$.isClosed', 'INTEGER'), col('created')] },
  { name: 'charges', indexes: [col('folioId'), col('propertyId'), col('reservationId'), col('serviceDate'), col('subAccountId'), col('sourceChargeId')] },
  { name: 'payments', indexes: [col('folioId'), col('propertyId'), col('businessDate'), col('status')] },
  { name: 'refunds', indexes: [col('folioId'), col('propertyId'), col('businessDate'), col('status')] },
  { name: 'allowances', indexes: [col('folioId'), col('propertyId')] },
  { name: 'transitoryCharges', indexes: [col('folioId'), col('propertyId')] },
  { name: 'invoices', indexes: [col('propertyId'), col('number'), col('status'), col('created'), col('folioId')] },
  { name: 'routings', indexes: [col('propertyId'), col('bookingId'), col('targetFolioId')] },
  { name: 'authorizations', indexes: [col('reservationId'), col('propertyId'), col('status')] },
  { name: 'paymentAccounts', indexes: [col('reservationId'), col('bookingId')] },

  { name: 'maintenances', indexes: [col('propertyId'), col('unitId'), col('from'), col('to'), col('type')] },
  { name: 'nightAuditLogs', indexes: [col('propertyId'), col('businessDate')] },
  { name: 'reservationLogs', indexes: [col('propertyId'), col('reservationId'), col('created')] },
  { name: 'folioLogs', indexes: [col('propertyId'), col('folioId'), col('created')] },
  { name: 'transactionExportLogs', indexes: [col('propertyId'), col('created')] },

  { name: 'sequences', indexes: [] },
  { name: 'idempotency', indexes: [] },
];

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (db) return db;
  if (config.dbFile !== ':memory:') {
    fs.mkdirSync(path.dirname(config.dbFile), { recursive: true });
  }
  db = new Database(config.dbFile);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}

function migrate(d: Database.Database): void {
  for (const c of COLLECTIONS) {
    const generated = c.indexes
      .map((i) => `,\n    "${i.name}" ${i.type} GENERATED ALWAYS AS (json_extract(data, '${i.jsonPath}')) VIRTUAL`)
      .join('');
    d.exec(`
      CREATE TABLE IF NOT EXISTS "${c.name}" (
        id TEXT PRIMARY KEY,
        data TEXT NOT NULL,
        seq INTEGER${generated}
      );
    `);
    d.exec(`CREATE TABLE IF NOT EXISTS "${c.name}_seq" (n INTEGER);`);
    for (const i of c.indexes) {
      d.exec(`CREATE INDEX IF NOT EXISTS "ix_${c.name}_${i.name}" ON "${c.name}" ("${i.name}");`);
    }
  }
  // A single monotonic counter gives every write a stable ordering, which the
  // list endpoints use as the tie-breaker for equal timestamps.
  d.exec(`CREATE TABLE IF NOT EXISTS _seq (name TEXT PRIMARY KEY, value INTEGER NOT NULL);`);
}

/** Reset everything. Used by the seeder and the test suite. */
export function resetDb(): void {
  const d = getDb();
  for (const c of COLLECTIONS) d.exec(`DELETE FROM "${c.name}";`);
  d.exec(`DELETE FROM _seq;`);
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}

/** Atomically increment and return a named counter. */
export function nextSeq(name: string): number {
  const d = getDb();
  const tx = d.transaction(() => {
    d.prepare(`INSERT INTO _seq(name, value) VALUES(?, 0) ON CONFLICT(name) DO NOTHING`).run(name);
    d.prepare(`UPDATE _seq SET value = value + 1 WHERE name = ?`).run(name);
    return (d.prepare(`SELECT value FROM _seq WHERE name = ?`).get(name) as any).value as number;
  });
  return tx();
}

export interface QueryOptions<T> {
  /** Index-backed equality/`IN` filters, e.g. `{ propertyId: 'MUC' }`. */
  where?: Record<string, unknown>;
  /** Arbitrary predicate applied after loading. Use for anything not indexed. */
  filter?: (item: T) => boolean;
  sort?: (a: T, b: T) => number;
  offset?: number;
  limit?: number;
}

/**
 * Typed handle onto one collection.
 */
export class Collection<T extends { id: string }> {
  constructor(readonly name: string) {}

  private get d() {
    return getDb();
  }

  get(id: string): T | undefined {
    if (!id) return undefined;
    const row = this.d.prepare(`SELECT data FROM "${this.name}" WHERE id = ?`).get(id) as Row | undefined;
    return row ? (JSON.parse(row.data) as T) : undefined;
  }

  getMany(ids: readonly string[]): T[] {
    const unique = [...new Set(ids.filter(Boolean))];
    if (unique.length === 0) return [];
    const placeholders = unique.map(() => '?').join(',');
    const rows = this.d
      .prepare(`SELECT data FROM "${this.name}" WHERE id IN (${placeholders}) ORDER BY seq`)
      .all(...unique) as Row[];
    return rows.map((r) => JSON.parse(r.data) as T);
  }

  exists(id: string): boolean {
    return !!this.d.prepare(`SELECT 1 FROM "${this.name}" WHERE id = ?`).get(id);
  }

  put(item: T): T {
    const seq = nextSeq('global');
    this.d
      .prepare(`INSERT INTO "${this.name}"(id, data, seq) VALUES(?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET data = excluded.data`)
      .run(item.id, JSON.stringify(item), seq);
    return item;
  }

  putAll(items: readonly T[]): void {
    const tx = this.d.transaction((list: readonly T[]) => {
      for (const i of list) this.put(i);
    });
    tx(items);
  }

  delete(id: string): boolean {
    const info = this.d.prepare(`DELETE FROM "${this.name}" WHERE id = ?`).run(id);
    return info.changes > 0;
  }

  deleteWhere(where: Record<string, unknown>): number {
    const { clause, params } = buildWhere(where);
    const info = this.d.prepare(`DELETE FROM "${this.name}" ${clause}`).run(...params);
    return info.changes;
  }

  /** Raw scan honouring indexed `where` clauses only. */
  private scan(where?: Record<string, unknown>): T[] {
    const { clause, params } = buildWhere(where);
    const rows = this.d.prepare(`SELECT data FROM "${this.name}" ${clause} ORDER BY seq`).all(...params) as Row[];
    return rows.map((r) => JSON.parse(r.data) as T);
  }

  /** Everything matching, unpaged. */
  all(where?: Record<string, unknown>): T[] {
    return this.scan(where);
  }

  /**
   * Query with filtering, sorting and paging. Returns the page plus the total
   * count before paging, which is what every apaleo list envelope reports.
   */
  query(opts: QueryOptions<T> = {}): { items: T[]; count: number } {
    let items = this.scan(opts.where);
    if (opts.filter) items = items.filter(opts.filter);
    const count = items.length;
    if (opts.sort) items.sort(opts.sort);
    const offset = opts.offset ?? 0;
    if (offset || opts.limit !== undefined) {
      items = items.slice(offset, opts.limit === undefined ? undefined : offset + opts.limit);
    }
    return { items, count };
  }

  count(where?: Record<string, unknown>): number {
    const { clause, params } = buildWhere(where);
    const row = this.d.prepare(`SELECT COUNT(*) AS n FROM "${this.name}" ${clause}`).get(...params) as Row;
    return row.n as number;
  }

  /** Read-modify-write helper. Throws if the entity is gone. */
  update(id: string, mutate: (item: T) => void): T {
    const item = this.get(id);
    if (!item) throw new Error(`${this.name}/${id} not found`);
    mutate(item);
    return this.put(item);
  }
}

function buildWhere(where?: Record<string, unknown>): { clause: string; params: unknown[] } {
  if (!where) return { clause: '', params: [] };
  const parts: string[] = [];
  const params: unknown[] = [];
  for (const [key, value] of Object.entries(where)) {
    if (value === undefined) continue;
    if (value === null) {
      parts.push(`"${key}" IS NULL`);
    } else if (Array.isArray(value)) {
      if (value.length === 0) {
        parts.push('1 = 0');
        continue;
      }
      parts.push(`"${key}" IN (${value.map(() => '?').join(',')})`);
      params.push(...value.map(normalize));
    } else {
      parts.push(`"${key}" = ?`);
      params.push(normalize(value));
    }
  }
  return { clause: parts.length ? `WHERE ${parts.join(' AND ')}` : '', params };
}

function normalize(v: unknown): unknown {
  if (typeof v === 'boolean') return v ? 1 : 0;
  return v;
}

const handles = new Map<string, Collection<any>>();

/** Get (memoized) the handle for a collection declared in `COLLECTIONS`. */
export function store<T extends { id: string }>(name: string): Collection<T> {
  let h = handles.get(name);
  if (!h) {
    if (!COLLECTIONS.some((c) => c.name === name)) {
      throw new Error(`Unknown collection '${name}'. Declare it in COLLECTIONS.`);
    }
    h = new Collection<T>(name);
    handles.set(name, h);
  }
  return h as Collection<T>;
}

/** Run a function inside a SQLite transaction. */
export function transact<T>(fn: () => T): T {
  return getDb().transaction(fn)();
}
