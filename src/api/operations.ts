import type { Request } from 'express';
import { ApiBuilder } from '../core/router';
import {
  arrayParam, dateParam, paging, requiredStringParam, sendCreated, sendList, sendNoContent, stringParam,
} from '../core/http';
import { conflict, notFound, unprocessable } from '../core/errors';
import { applyPatch, rejectImmutablePaths, type PatchOperation } from '../core/patch';
import { nowIso, rangesOverlap, toBusinessDate } from '../core/dates';
import { nextSeq, transact } from '../core/db';
import { db, embeddedUnit, languagesOf, property as getProperty, unit as getUnit } from '../domain/repo';
import { runNightAudit } from '../domain/nightaudit';
import { isActive } from '../domain/operations';
import type { Maintenance } from '../domain/types';

/**
 * Operations API - housekeeping and the night audit: the two things a hotel
 * does every day regardless of who is booking.
 */

const api = new ApiBuilder('operations-v1');

function maintenanceBody(m: Maintenance, langs: readonly string[]) {
  return {
    id: m.id,
    unit: embeddedUnit(m.unitId, langs),
    from: m.from,
    to: m.to,
    type: m.type,
    description: m.description,
  };
}

function maintenanceFilter(req: Request): (m: Maintenance) => boolean {
  const propertyId = stringParam(req, 'propertyId');
  const unitId = stringParam(req, 'unitId');
  const types = arrayParam(req, 'types');
  const from = dateParam(req, 'from');
  const to = dateParam(req, 'to');
  return (m) => {
    if (propertyId && m.propertyId !== propertyId) return false;
    if (unitId && m.unitId !== unitId) return false;
    if (types.length && !types.includes(m.type)) return false;
    if (from && m.toDate < from) return false;
    if (to && m.fromDate > to) return false;
    return true;
  };
}

api.op('OperationsMaintenancesGet', (req, res) => {
  const langs = languagesOf(arrayParam(req, 'languages'), stringParam(req, 'propertyId'));
  const page = paging(req);
  const { items, count } = db.maintenances.query({
    filter: maintenanceFilter(req),
    sort: (a, b) => a.fromDate.localeCompare(b.fromDate) || a.unitId.localeCompare(b.unitId),
    offset: page.offset,
    limit: page.pageSize,
  });
  sendList(res, 'maintenances', items.map((m) => maintenanceBody(m, langs)), count);
});

api.op('OperationsMaintenances$countGet', (req, res) => {
  res.json({ count: db.maintenances.all().filter(maintenanceFilter(req)).length });
});

api.op('OperationsMaintenancesPost', (req, res) => {
  const created = transact(() => createMaintenance(req.body));
  sendCreated(res, `/operations/v1/maintenances/${created.id}`, { id: created.id });
});

api.op('OperationsMaintenancesBulkPost', (req, res) => {
  const body = req.body as { maintenances: any[] };
  const ids = transact(() => body.maintenances.map((m) => createMaintenance(m).id));
  res.status(201).json({ ids: ids.map((id) => ({ id })) });
});

function createMaintenance(body: Record<string, any>): Maintenance {
  const unit = getUnit(body.unitId);
  const property = getProperty(unit.propertyId);
  const fromDate = toBusinessDate(body.from, property.timeZone);
  const toDate = toBusinessDate(body.to, property.timeZone);
  if (toDate <= fromDate) throw unprocessable('`to` must be after `from`.');

  const clash = db.maintenances
    .all({ unitId: unit.id })
    .find((m) => rangesOverlap(m.fromDate, m.toDate, fromDate, toDate));
  if (clash) {
    throw conflict(`Unit '${unit.id}' already has maintenance from ${clash.fromDate} to ${clash.toDate}.`);
  }

  // A maintenance window cannot be dropped on top of a stay already in place.
  const occupied = db.reservations
    .all({ unitId: unit.id })
    .find((r) => isActive(r) && rangesOverlap(r.arrivalDate, r.departureDate, fromDate, toDate));
  if (occupied) {
    throw conflict(
      `Unit '${unit.id}' is occupied by reservation '${occupied.id}' from ${occupied.arrivalDate} to ${occupied.departureDate}.`,
    );
  }

  const maintenance: Maintenance = {
    id: `${property.id}-M${nextSeq(`maintenance:${property.id}`)}`,
    propertyId: property.id,
    unitId: unit.id,
    type: body.type,
    from: body.from,
    to: body.to,
    fromDate,
    toDate,
    description: body.description,
    created: nowIso(),
  };
  db.maintenances.put(maintenance);
  return maintenance;
}

api.op('OperationsMaintenancesByIdGet', (req, res) => {
  const m = db.maintenances.get(req.params.id!);
  if (!m) throw notFound(`Maintenance '${req.params.id}' was not found.`);
  res.json(maintenanceBody(m, languagesOf(arrayParam(req, 'languages'), m.propertyId)));
});

api.op('OperationsMaintenancesByIdHead', (req, res) => {
  res.status(db.maintenances.exists(req.params.id!) ? 200 : 404).end();
});

api.op('OperationsMaintenancesByIdPatch', (req, res) => {
  const m = db.maintenances.get(req.params.id!);
  if (!m) throw notFound(`Maintenance '${req.params.id}' was not found.`);
  const ops = req.body as PatchOperation[];
  rejectImmutablePaths(ops, ['/id', '/unit', '/unitId']);
  const property = getProperty(m.propertyId);
  const view = { from: m.from, to: m.to, type: m.type, description: m.description };
  const patched = applyPatch(view, ops) as typeof view;

  const fromDate = toBusinessDate(patched.from, property.timeZone);
  const toDate = toBusinessDate(patched.to, property.timeZone);
  if (toDate <= fromDate) throw unprocessable('`to` must be after `from`.');
  const clash = db.maintenances
    .all({ unitId: m.unitId })
    .find((other) => other.id !== m.id && rangesOverlap(other.fromDate, other.toDate, fromDate, toDate));
  if (clash) throw conflict(`Unit '${m.unitId}' already has maintenance in that window.`);

  Object.assign(m, patched, { fromDate, toDate });
  db.maintenances.put(m);
  sendNoContent(res);
});

api.op('OperationsMaintenancesByIdDelete', (req, res) => {
  const id = req.params.id!;
  if (!db.maintenances.exists(id)) throw notFound(`Maintenance '${id}' was not found.`);
  db.maintenances.delete(id);
  sendNoContent(res);
});

api.op('OperationsUnits-conditionPut', (req, res) => {
  const body = req.body as { unitsConditions: { id: string; condition: string }[] };
  transact(() => {
    for (const entry of body.unitsConditions) {
      const unit = getUnit(entry.id);
      unit.condition = entry.condition as typeof unit.condition;
      db.units.put(unit);
    }
  });
  sendNoContent(res);
});

api.op('OperationsNight-auditPut', (req, res) => {
  const property = getProperty(requiredStringParam(req, 'propertyId'));
  const setReservationsToNoShow = stringParam(req, 'setReservationsToNoShow') !== 'false';
  const result = runNightAudit(property, {
    setReservationsToNoShow,
    triggeredBy: req.principal?.clientId ?? 'unknown',
  });
  // The documented response is 204; the summary goes to the logs endpoint.
  res.status(204)
    .setHeader('X-Business-Date', result.nextBusinessDate)
    .end();
});

export const operationsRouter = api.build();
