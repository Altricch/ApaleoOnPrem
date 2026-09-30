import { addDays, nowIso, rangesOverlap, toBusinessDate } from '../core/dates';
import { db } from './repo';
import type { Maintenance, Reservation, Unit } from './types';

/**
 * Housekeeping- and inventory-side helpers shared by the Inventory,
 * Operations and Availability APIs.
 */

/** A unit is occupied while a checked-in reservation is assigned to it. */
export function unitIsOccupied(unitId: string): boolean {
  return db.reservations.all({ unitId, status: 'InHouse' }).length > 0;
}

/** The maintenance window covering right now, if any. */
export function activeMaintenanceFor(unitId: string): Maintenance | undefined {
  const now = nowIso();
  return db.maintenances.all({ unitId }).find((m) => m.from <= now && m.to > now);
}

/** Maintenance windows touching a date range, expressed as business dates. */
export function maintenancesInRange(propertyId: string, from: string, to: string): Maintenance[] {
  return db.maintenances
    .all({ propertyId })
    .filter((m) => rangesOverlap(m.fromDate, m.toDate, from, to));
}

/**
 * Which units are blocked by maintenance on a given night. `OutOfInventory`
 * also removes the unit from the house count, which matters for occupancy
 * reporting; all three types make the unit unsellable.
 */
export function unitsUnderMaintenance(propertyId: string, date: string): Set<string> {
  const blocked = new Set<string>();
  for (const m of db.maintenances.all({ propertyId })) {
    if (m.fromDate <= date && date < m.toDate) blocked.add(m.unitId);
  }
  return blocked;
}

/** Reservations holding a unit on a given night. */
export function reservationsOccupyingUnit(unitId: string, date: string): Reservation[] {
  return db.reservations
    .all({ unitId })
    .filter((r) => isActive(r) && r.arrivalDate <= date && date < r.departureDate);
}

export function isActive(r: Reservation): boolean {
  return r.status === 'Confirmed' || r.status === 'InHouse';
}

/** Reservations that consume inventory on a night (active, not yet departed). */
export function reservationsOnDate(propertyId: string, date: string): Reservation[] {
  return db.reservations
    .all({ propertyId })
    .filter((r) => isActive(r) && r.arrivalDate <= date && date < r.departureDate);
}

/**
 * Units of a group that are free for the whole of `[from, to)`: not archived,
 * not under maintenance, and not held by another reservation.
 */
export function freeUnitsForStay(
  propertyId: string,
  unitGroupId: string | undefined,
  from: string,
  to: string,
  opts: { ignoreReservationId?: string; ignoreMaintenance?: boolean } = {},
): Unit[] {
  const candidates = unitGroupId
    ? db.units.all({ propertyId, unitGroupId, isArchived: false })
    : db.units.all({ propertyId, isArchived: false });

  return candidates.filter((u) => {
    if (!opts.ignoreMaintenance) {
      const blocked = db.maintenances.all({ unitId: u.id })
        .some((m) => rangesOverlap(m.fromDate, m.toDate, from, to));
      if (blocked) return false;
    }
    const taken = db.reservations.all({ unitId: u.id }).some((r) =>
      r.id !== opts.ignoreReservationId
      && isActive(r)
      && rangesOverlap(r.arrivalDate, r.departureDate, from, to));
    return !taken;
  });
}

/**
 * Pick the unit to auto-assign. Prefers clean units, then the lowest natural
 * name, which is what a front desk would do by hand.
 */
export function pickUnitForStay(
  propertyId: string,
  unitGroupId: string | undefined,
  from: string,
  to: string,
  ignoreReservationId?: string,
): Unit | undefined {
  const free = freeUnitsForStay(propertyId, unitGroupId, from, to, { ignoreReservationId });
  const rank = (u: Unit) => (u.condition === 'Clean' ? 0 : u.condition === 'CleanToBeInspected' ? 1 : 2);
  return free.sort((a, b) =>
    rank(a) - rank(b) || a.name.localeCompare(b.name, undefined, { numeric: true }))[0];
}

/** Normalise a maintenance payload's dates into business dates. */
export function maintenanceDates(from: string, to: string, timeZone: string) {
  return { fromDate: toBusinessDate(from, timeZone), toDate: toBusinessDate(to, timeZone) };
}

/** House count: sellable physical units, excluding out-of-inventory ones. */
export function houseCount(propertyId: string, date: string): number {
  const units = db.units.all({ propertyId, isArchived: false });
  const outOfInventory = new Set(
    db.maintenances
      .all({ propertyId, type: 'OutOfInventory' })
      .filter((m) => m.fromDate <= date && date < m.toDate)
      .map((m) => m.unitId),
  );
  return units.filter((u) => !outOfInventory.has(u.id)).length;
}

/** Tomorrow, relative to the property's current business date. */
export function nextBusinessDate(propertyId: string): string {
  const p = db.properties.get(propertyId);
  return p ? addDays(p.businessDate, 1) : addDays(new Date().toISOString().slice(0, 10), 1);
}
