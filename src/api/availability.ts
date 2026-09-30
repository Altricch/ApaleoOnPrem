import { ApiBuilder } from '../core/router';
import {
  arrayParam, boolParam, intParam, paging, requiredDateParam, requiredStringParam,
  sendList, sendNoContent, stringParam,
} from '../core/http';
import { unprocessable } from '../core/errors';
import { applyPatch, type PatchOperation } from '../core/patch';
import { resolveLocalized } from '../core/localized';
import { addDays, atLocalTime, datesInclusive, nightsBetween, toBusinessDate } from '../core/dates';
import { transact } from '../core/db';
import {
  db, embeddedProperty, embeddedService, embeddedUnitGroup, languagesOf,
  property as getProperty, reservation as getReservation,
} from '../domain/repo';
import { AvailabilitySnapshot, serviceAvailability } from '../domain/availability';
import { activeMaintenanceFor, freeUnitsForStay, unitIsOccupied } from '../domain/operations';
import type { Overbooking, Property, TimeSliceDefinition, Unit, UnitGroupType } from '../domain/types';

/**
 * Availability API - what can still be sold, per unit group, per unit and per
 * service, plus the overbooking limits that let a property sell beyond its
 * physical inventory.
 */

const api = new ApiBuilder('availability-v1');

/** Check-in/check-out times for the template a request asks about. */
function sliceTimes(property: Property, template?: string): { checkIn: string; checkOut: string } {
  const definitions = db.timeSliceDefinitions.all({ propertyId: property.id });
  const match = template
    ? definitions.find((d) => d.template === template)
    : definitions.find((d) => d.template === 'OverNight') ?? definitions[0];
  return {
    checkIn: match?.checkInTime ?? property.defaultCheckInTime,
    checkOut: match?.checkOutTime ?? property.defaultCheckOutTime,
  };
}

function sliceBounds(property: Property, date: string, times: { checkIn: string; checkOut: string }) {
  return {
    from: atLocalTime(date, times.checkIn, property.timeZone),
    to: atLocalTime(addDays(date, 1), times.checkOut, property.timeZone),
  };
}

/** `to` is the departure date, so the last sellable night starts the day before. */
function nightsOf(from: string, to: string): string[] {
  const nights = nightsBetween(from, to);
  return nights.length ? nights : [from];
}

api.op('AvailabilityUnit-groupsGet', (req, res) => {
  const property = getProperty(requiredStringParam(req, 'propertyId'));
  const from = requiredDateParam(req, 'from');
  const to = requiredDateParam(req, 'to');
  const template = stringParam(req, 'timeSliceTemplate');
  const unitGroupTypes = arrayParam(req, 'unitGroupTypes');
  const timeSliceDefinitionIds = arrayParam(req, 'timeSliceDefinitionIds');
  const unitGroupIds = arrayParam(req, 'unitGroupIds');
  const adults = intParam(req, 'adults', 0);
  const childrenAges = arrayParam(req, 'childrenAges').map(Number);
  const onlySellable = boolParam(req, 'onlySellable') ?? false;
  const langs = languagesOf(arrayParam(req, 'languages'), property.id);
  const page = paging(req);

  const times = sliceTimes(property, template);
  const snapshot = new AvailabilitySnapshot(property, from, to);
  const occupancy = adults + childrenAges.length;

  // Restrict to unit groups a rate plan actually sells under the requested
  // time slice definition, otherwise the answer includes groups you cannot book.
  const definitionFilter = timeSliceDefinitionIds.length
    ? new Set(db.ratePlans.all({ propertyId: property.id })
      .filter((p) => timeSliceDefinitionIds.includes(p.timeSliceDefinitionId))
      .map((p) => p.unitGroupId))
    : undefined;

  const groups = snapshot.unitGroups().filter((g) => {
    if (unitGroupIds.length && !unitGroupIds.includes(g.id)) return false;
    if (unitGroupTypes.length && !unitGroupTypes.includes(g.type)) return false;
    if (definitionFilter && !definitionFilter.has(g.id)) return false;
    if (occupancy > 0 && g.maxPersons < occupancy) return false;
    return true;
  });

  const all = nightsOf(from, to).map((date) => {
    const bounds = sliceBounds(property, date, times);
    const perGroup = groups
      .map((g) => ({ group: g, availability: snapshot.forGroup(g, date) }))
      .filter(({ availability }) => !onlySellable || availability.availableCount > 0);
    return {
      from: bounds.from,
      to: bounds.to,
      property: propertyAvailabilityBody(snapshot, date, unitGroupTypes[0] as UnitGroupType | undefined),
      unitGroups: perGroup.map(({ group, availability }) => ({
        unitGroup: embeddedUnitGroup(group.id, langs),
        physicalCount: availability.physicalCount,
        houseCount: availability.houseCount,
        soldCount: availability.soldCount,
        occupancy: availability.occupancy,
        availableCount: availability.availableCount,
        sellableCount: availability.sellableCount,
        allowedOverbookingCount: availability.allowedOverbookingCount,
        maintenance: availability.maintenance,
        block: availability.block,
      })),
    };
  });

  sendList(res, 'timeSlices', all.slice(page.offset, page.offset + page.pageSize), all.length);
});

function propertyAvailabilityBody(snapshot: AvailabilitySnapshot, date: string, type?: UnitGroupType) {
  const a = snapshot.forProperty(date, type);
  return {
    physicalCount: a.physicalCount,
    houseCount: a.houseCount,
    soldCount: a.soldCount,
    occupancy: a.occupancy,
    sellableCount: a.sellableCount,
    allowedOverbookingCount: a.allowedOverbookingCount,
    houseOverbookingLimit: a.houseOverbookingLimit,
    maintenance: a.maintenance,
    block: a.block,
  };
}

api.op('AvailabilityUnitsGet', (req, res) => {
  const property = getProperty(requiredStringParam(req, 'propertyId'));
  const from = requiredDateParam(req, 'from');
  const to = requiredDateParam(req, 'to');
  const langs = languagesOf(arrayParam(req, 'languages'), property.id);
  const page = paging(req);
  const units = availableUnits(property, from, to, req);
  sendList(res, 'units', units.slice(page.offset, page.offset + page.pageSize).map((u) => availableUnitBody(u, langs)), units.length);
});

api.op('AvailabilityReservationsByIdUnitsGet', (req, res) => {
  const reservation = getReservation(req.params.id!);
  const property = getProperty(reservation.propertyId);
  const from = stringParam(req, 'from') ? toBusinessDate(stringParam(req, 'from')!, property.timeZone) : reservation.arrivalDate;
  const to = stringParam(req, 'to') ? toBusinessDate(stringParam(req, 'to')!, property.timeZone) : reservation.departureDate;
  const langs = languagesOf(arrayParam(req, 'languages'), property.id);
  const page = paging(req);

  // Default to the reservation's own unit group when the caller does not
  // narrow it, and ignore the unit this reservation already holds.
  const unitGroupId = stringParam(req, 'unitGroupId') ?? reservation.unitGroupId;
  const units = availableUnits(property, from, to, req, {
    unitGroupId,
    ignoreReservationId: reservation.id,
  });
  sendList(res, 'units', units.slice(page.offset, page.offset + page.pageSize).map((u) => availableUnitBody(u, langs)), units.length);
});

function availableUnits(
  property: Property,
  from: string,
  to: string,
  req: Parameters<typeof arrayParam>[0],
  overrides: { unitGroupId?: string; ignoreReservationId?: string } = {},
): Unit[] {
  const unitGroupId = overrides.unitGroupId ?? stringParam(req, 'unitGroupId');
  const includeOutOfService = boolParam(req, 'includeOutOfService') ?? false;
  const unitCondition = stringParam(req, 'unitCondition');
  const unitAttributeIds = arrayParam(req, 'unitAttributeIds');

  return freeUnitsForStay(property.id, unitGroupId, from, to, {
    ignoreReservationId: overrides.ignoreReservationId,
    ignoreMaintenance: includeOutOfService,
  }).filter((u) => {
    if (unitCondition && u.condition !== unitCondition) return false;
    if (unitAttributeIds.length && !unitAttributeIds.every((a) => u.attributes.includes(a))) return false;
    return true;
  }).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
}

function availableUnitBody(u: Unit, langs: readonly string[]) {
  const maintenance = activeMaintenanceFor(u.id);
  return {
    id: u.id,
    name: u.name,
    description: resolveLocalized(u.description, langs) ?? u.name,
    property: embeddedProperty(u.propertyId, langs),
    unitGroup: embeddedUnitGroup(u.unitGroupId, langs),
    status: {
      isOccupied: unitIsOccupied(u.id),
      condition: u.condition,
      maintenanceType: maintenance?.type,
    },
    maxPersons: u.maxPersons,
    attributes: u.attributes
      .map((id) => db.unitAttributes.get(id))
      .filter((a): a is NonNullable<typeof a> => !!a)
      .map((a) => ({ id: a.id, name: a.name, description: a.description })),
    connectedUnits: undefined,
  };
}

api.op('AvailabilityServicesGet', (req, res) => {
  const property = getProperty(requiredStringParam(req, 'propertyId'));
  const from = requiredDateParam(req, 'from');
  const to = requiredDateParam(req, 'to');
  const template = stringParam(req, 'timeSliceTemplate');
  const channelCodes = arrayParam(req, 'channelCodes');
  const langs = languagesOf(arrayParam(req, 'languages'), property.id);
  const page = paging(req);
  const times = sliceTimes(property, template);

  const serviceIds = db.services.all({ propertyId: property.id })
    .filter((s) => !channelCodes.length || !s.channelCodes.length
      || channelCodes.some((c) => s.channelCodes.includes(c as any)))
    .map((s) => s.id);

  const availability = serviceAvailability(property, from, to, serviceIds);
  const byDate = new Map<string, typeof availability>();
  for (const entry of availability) {
    const list = byDate.get(entry.serviceDate) ?? [];
    list.push(entry);
    byDate.set(entry.serviceDate, list);
  }

  const all = nightsOf(from, to).map((date) => {
    const bounds = sliceBounds(property, date, times);
    return {
      from: bounds.from,
      to: bounds.to,
      services: (byDate.get(date) ?? []).map((entry) => {
        const service = db.services.get(entry.serviceId);
        // A configured quota beats the house count as the ceiling.
        const quantity = service?.availability.quantity ?? entry.quantity;
        return {
          service: embeddedService(entry.serviceId, langs),
          quantity,
          soldCount: entry.soldCount,
          availableCount: Math.max(0, quantity - entry.soldCount),
          serviceDate: entry.serviceDate,
          block: entry.block,
        };
      }),
    };
  });

  sendList(res, 'timeSlices', all.slice(page.offset, page.offset + page.pageSize), all.length);
});

/* ---------------------------------------------------------- overbooking */

const overbookingId = (propertyId: string, date: string, unitGroupId?: string) =>
  `${propertyId}|${unitGroupId ?? 'HOUSE'}|${date}`;

api.op('AvailabilityUnit-groupsByIdPatch', (req, res) => {
  const group = db.unitGroups.get(req.params.id!);
  if (!group) throw unprocessable(`Unit group '${req.params.id}' does not exist.`);
  const property = getProperty(group.propertyId);
  const from = requiredDateParam(req, 'from');
  const to = requiredDateParam(req, 'to');
  requiredStringParam(req, 'timeSliceTemplate');
  const ops = req.body as PatchOperation[];

  transact(() => {
    for (const date of nightsOf(from, to)) {
      const id = overbookingId(property.id, date, group.id);
      const current = db.overbookings.get(id);
      const view = { allowedOverbookingCount: current?.limit ?? 0 };
      const patched = applyPatch(view, ops) as typeof view;
      const limit = Number(patched.allowedOverbookingCount) || 0;
      if (limit < 0) throw unprocessable('`allowedOverbookingCount` must not be negative.');
      if (limit === 0) {
        db.overbookings.delete(id);
        continue;
      }
      const record: Overbooking = {
        id,
        propertyId: property.id,
        unitGroupId: group.id,
        date,
        unitGroupType: group.type,
        limit,
      };
      db.overbookings.put(record);
    }
  });
  sendNoContent(res);
});

api.op('AvailabilityPropertiesByIdGet', (req, res) => {
  const property = getProperty(req.params.id!);
  const from = requiredDateParam(req, 'from');
  const to = requiredDateParam(req, 'to');
  requiredStringParam(req, 'timeSliceTemplate');
  const unitGroupType = requiredStringParam(req, 'unitGroupType');
  const times = sliceTimes(property, stringParam(req, 'timeSliceTemplate'));

  // Only the dates that actually carry a house-level limit are reported.
  const slices = datesInclusive(from, to)
    .map((date) => ({ date, record: db.overbookings.get(overbookingId(property.id, date)) }))
    .filter((x) => x.record && x.record.unitGroupType === unitGroupType)
    .map(({ date, record }) => {
      const bounds = sliceBounds(property, date, times);
      return { from: bounds.from, to: bounds.to, houseOverbookingLimit: record!.limit };
    });

  sendList(res, 'timeSlices', slices, slices.length);
});

api.op('AvailabilityPropertiesByIdPatch', (req, res) => {
  const property = getProperty(req.params.id!);
  const from = requiredDateParam(req, 'from');
  const to = requiredDateParam(req, 'to');
  requiredStringParam(req, 'timeSliceTemplate');
  const unitGroupType = requiredStringParam(req, 'unitGroupType') as UnitGroupType;
  const ops = req.body as PatchOperation[];

  transact(() => {
    for (const date of nightsOf(from, to)) {
      const id = overbookingId(property.id, date);
      const current = db.overbookings.get(id);
      const view = { houseOverbookingLimit: current?.limit ?? 0 };
      const patched = applyPatch(view, ops) as typeof view;
      const limit = Number(patched.houseOverbookingLimit) || 0;
      if (limit < 0) throw unprocessable('`houseOverbookingLimit` must not be negative.');
      if (limit === 0) {
        db.overbookings.delete(id);
        continue;
      }
      db.overbookings.put({ id, propertyId: property.id, date, unitGroupType, limit });
    }
  });
  sendNoContent(res);
});

export const availabilityRouter = api.build();
export type { TimeSliceDefinition };
