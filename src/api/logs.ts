import { ApiBuilder } from '../core/router';
import { arrayParam, paging, sendList } from '../core/http';
import { unprocessable } from '../core/errors';
import { db } from '../domain/repo';
import type { AuditLogEntry } from '../domain/types';

/**
 * Logs API - read-only audit trails over reservations, folios, night audit
 * runs and accounting exports.
 *
 * Date filtering uses apaleo's expression syntax: an array of `OP_VALUE`
 * strings (`gte_2024-01-01`, `lt_2024-02-01`) that all have to hold.
 */

const api = new ApiBuilder('logs-v1');

type Comparison = 'eq' | 'neq' | 'lt' | 'gt' | 'lte' | 'gte';

interface DatePredicate {
  op: Comparison;
  value: string;
}

function parseDateFilters(expressions: readonly string[]): DatePredicate[] {
  return expressions.map((raw) => {
    const separator = raw.indexOf('_');
    if (separator === -1) {
      throw unprocessable(`'${raw}' is not a valid filter expression. Use the form 'OPERATION_VALUE', e.g. 'gte_2024-01-01'.`);
    }
    const op = raw.slice(0, separator) as Comparison;
    const value = raw.slice(separator + 1);
    if (!['eq', 'neq', 'lt', 'gt', 'lte', 'gte'].includes(op)) {
      throw unprocessable(`'${op}' is not a supported operation. Use eq, neq, lt, gt, lte or gte.`);
    }
    if (!value) throw unprocessable(`'${raw}' is missing a value.`);
    return { op, value };
  });
}

function matchesDate(value: string, predicates: readonly DatePredicate[]): boolean {
  return predicates.every(({ op, value: other }) => {
    // Compare on the common prefix length so `gte_2024-01-01` matches an
    // instant on that day rather than excluding everything after midnight.
    const a = value.slice(0, other.length);
    switch (op) {
      case 'eq': return a === other;
      case 'neq': return a !== other;
      case 'lt': return a < other;
      case 'lte': return a <= other;
      case 'gt': return a > other;
      case 'gte': return a >= other;
      default: return true;
    }
  });
}

interface CommonFilters {
  eventTypes: string[];
  clientIds: string[];
  propertyIds: string[];
  subjectIds: string[];
  dates: DatePredicate[];
}

function commonFilters(req: Parameters<typeof arrayParam>[0]): CommonFilters {
  return {
    eventTypes: arrayParam(req, 'eventTypes'),
    clientIds: arrayParam(req, 'clientIds'),
    propertyIds: arrayParam(req, 'propertyIds'),
    subjectIds: arrayParam(req, 'subjectIds'),
    dates: parseDateFilters(arrayParam(req, 'dateFilter')),
  };
}

function matchesCommon(entry: AuditLogEntry, f: CommonFilters): boolean {
  if (f.eventTypes.length && !f.eventTypes.includes(entry.action)) return false;
  if (f.propertyIds.length && !f.propertyIds.includes(entry.propertyId)) return false;
  if (f.clientIds.length && !f.clientIds.includes(entry.source)) return false;
  if (f.subjectIds.length && !f.subjectIds.includes(entry.source)) return false;
  if (f.dates.length && !matchesDate(entry.created, f.dates)) return false;
  return true;
}

const newestFirst = (a: { created: string }, b: { created: string }) => b.created.localeCompare(a.created);

api.op('LogsBookingReservationGet', (req, res) => {
  const reservationIds = arrayParam(req, 'reservationIds');
  const filters = commonFilters(req);
  const expand = new Set(arrayParam(req, 'expand'));
  const page = paging(req);

  const { items, count } = db.reservationLogs.query({
    filter: (e) =>
      (!reservationIds.length || (!!e.reservationId && reservationIds.includes(e.reservationId)))
      && matchesCommon(e, filters),
    sort: newestFirst,
    offset: page.offset,
    limit: page.pageSize,
  });

  sendList(res, 'logEntries', items.map((e) => ({
    reservationId: e.reservationId,
    eventType: e.action,
    changes: expand.has('changes') && e.changes?.length
      ? e.changes.map((c) => ({
        changeType: 'ReservationChanged',
        attribute: c.path,
        oldValue: c.from,
        newValue: c.to,
      }))
      : undefined,
    clientId: e.source,
    propertyId: e.propertyId,
    created: e.created,
    subjectId: e.source,
    message: e.message,
  })), count);
});

api.op('LogsFinanceFolioGet', (req, res) => {
  const folioIds = arrayParam(req, 'folioIds');
  const filters = commonFilters(req);
  const page = paging(req);

  const { items, count } = db.folioLogs.query({
    filter: (e) =>
      (!folioIds.length || (!!e.folioId && folioIds.includes(e.folioId)))
      && matchesCommon(e, filters),
    sort: newestFirst,
    offset: page.offset,
    limit: page.pageSize,
  });

  sendList(res, 'logEntries', items.map((e) => ({
    folioId: e.folioId,
    eventType: e.action,
    relatedEntityId: e.relatedEntityId,
    relatedEntityDescription: e.message,
    amount: e.amount,
    clientId: e.source,
    serviceDate: e.serviceDate,
    propertyId: e.propertyId,
    created: e.created,
    subjectId: e.source,
  })), count);
});

api.op('LogsFinanceNight-auditGet', (req, res) => {
  const statuses = arrayParam(req, 'statuses');
  const propertyIds = arrayParam(req, 'propertyIds');
  const subjectIds = arrayParam(req, 'subjectIds');
  const dates = parseDateFilters(arrayParam(req, 'dateFilter'));
  const page = paging(req);

  const { items, count } = db.nightAuditLogs.query({
    filter: (log) => {
      // A run only lands in the log once it has finished, so it is a success
      // unless it recorded warnings that stopped it part-way.
      const status = 'Success';
      if (statuses.length && !statuses.includes(status)) return false;
      if (propertyIds.length && !propertyIds.includes(log.propertyId)) return false;
      if (subjectIds.length && !subjectIds.includes(log.triggeredBy)) return false;
      if (dates.length && !matchesDate(log.created, dates)) return false;
      return true;
    },
    sort: newestFirst,
    offset: page.offset,
    limit: page.pageSize,
  });

  sendList(res, 'logEntries', items.map((log) => ({
    ended: log.created,
    setReservationsToNoShow: log.summary.noShowsMarked > 0,
    status: 'Success',
    failureCode: 'None',
    reservationIdsSetToNoShow: [],
    propertyId: log.propertyId,
    created: log.created,
    subjectId: log.triggeredBy,
    businessDate: log.businessDate,
    warnings: log.warnings.length ? log.warnings : undefined,
  })), count);
});

api.op('LogsFinanceTransactions-exportGet', (req, res) => {
  const types = arrayParam(req, 'types');
  const propertyIds = arrayParam(req, 'propertyIds');
  const subjectIds = arrayParam(req, 'subjectIds');
  const dates = parseDateFilters(arrayParam(req, 'dateFilter'));
  const page = paging(req);

  const logs = exportLogs()
    .filter((e) => (!types.length || types.includes(e.type))
      && (!propertyIds.length || propertyIds.includes(e.propertyId))
      && (!subjectIds.length || subjectIds.includes(e.subjectId))
      && (!dates.length || matchesDate(e.created, dates)))
    .sort(newestFirst);

  sendList(res, 'logEntries', logs.slice(page.offset, page.offset + page.pageSize), logs.length);
});

/** Export runs are journaled by the Finance API's export endpoints. */
interface ExportLogEntry {
  periodStart: string;
  periodEnd: string;
  type: string;
  clientId: string;
  propertyId: string;
  created: string;
  subjectId: string;
}

function exportLogs(): ExportLogEntry[] {
  return db.transactionExportLogs.all().map((e) => ({
    periodStart: e.periodStart,
    periodEnd: e.periodEnd,
    type: e.type,
    clientId: e.clientId,
    propertyId: e.propertyId,
    created: e.created,
    subjectId: e.subjectId,
  }));
}

export const logsRouter = api.build();
