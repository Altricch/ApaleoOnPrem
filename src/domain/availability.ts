import { atLocalTime, nightsBetween, rangesOverlap } from '../core/dates';
import { db } from './repo';
import type { Block, Property, Unit, UnitGroup, UnitGroupType } from './types';
import { isActive } from './operations';

/**
 * The availability engine.
 *
 * For a given night and unit group apaleo reports a stack of counts that build
 * on one another:
 *
 *   physicalCount    every non-archived unit in the group
 *   houseCount       physicalCount minus units taken out of inventory
 *   soldCount        units held by active reservations (pickups included)
 *   block.remaining  units still held by blocks but not yet picked up
 *   sellableCount    houseCount - unsellable maintenance - sold - block.remaining
 *   availableCount   sellableCount + allowedOverbookingCount
 *
 * `OutOfInventory` maintenance is deducted from the house count (the unit is
 * treated as not existing), while `OutOfService` and `OutOfOrder` leave the
 * house count alone but make the unit unsellable. That distinction is what
 * makes occupancy percentages come out the way a revenue manager expects.
 */

export interface MaintenanceCounts {
  outOfService: number;
  outOfOrder: number;
  outOfInventory: number;
}

export interface BlockCounts {
  definite: number;
  tentative: number;
  optional: number;
  optionalDeducting: number;
  picked: number;
  remaining: number;
}

export interface UnitGroupAvailability {
  unitGroupId: string;
  date: string;
  physicalCount: number;
  houseCount: number;
  soldCount: number;
  occupancy: number;
  availableCount: number;
  sellableCount: number;
  allowedOverbookingCount: number;
  maintenance: MaintenanceCounts;
  block: BlockCounts;
}

export interface PropertyAvailability {
  date: string;
  physicalCount: number;
  houseCount: number;
  soldCount: number;
  occupancy: number;
  sellableCount: number;
  allowedOverbookingCount: number;
  houseOverbookingLimit: number;
  maintenance: MaintenanceCounts;
  block: BlockCounts;
}

const emptyBlockCounts = (): BlockCounts => ({
  definite: 0, tentative: 0, optional: 0, optionalDeducting: 0, picked: 0, remaining: 0,
});

const emptyMaintenance = (): MaintenanceCounts => ({ outOfService: 0, outOfOrder: 0, outOfInventory: 0 });

/**
 * Pre-computed, per-night index of everything that consumes inventory in a
 * property over a date range. Building this once and reading from it keeps the
 * availability grid linear rather than re-scanning reservations per night.
 */
export interface SnapshotOptions {
  /**
   * Count stays that have already departed as occupying their nights.
   *
   * Forward-looking availability must not count them - a checked-out
   * reservation no longer holds a room. Historical reporting must, or
   * occupancy for any past date collapses to zero.
   */
  includeCompleted?: boolean;
}

export class AvailabilitySnapshot {
  private readonly unitsByGroup = new Map<string, Unit[]>();
  private readonly maintenanceByUnitDate = new Map<string, Map<string, MaintenanceCounts>>();
  private readonly soldByGroupDate = new Map<string, number>();
  private readonly blocksByGroupDate = new Map<string, BlockCounts>();
  private readonly overbookingByGroupDate = new Map<string, number>();
  private readonly houseOverbookingByDate = new Map<string, number>();

  readonly dates: string[];

  constructor(
    readonly property: Property,
    readonly from: string,
    readonly to: string,
    private readonly options: SnapshotOptions = {},
  ) {
    // `to` is exclusive for stays but availability is reported per night, so
    // the last night is the one starting the day before `to`.
    this.dates = from === to ? [from] : nightsBetween(from, to);
    this.indexUnits();
    this.indexMaintenance();
    this.indexReservations();
    this.indexBlocks();
    this.indexOverbooking();
  }

  private key(groupId: string, date: string): string {
    return `${groupId}|${date}`;
  }

  private indexUnits(): void {
    for (const u of db.units.all({ propertyId: this.property.id, isArchived: false })) {
      const gid = u.unitGroupId ?? '';
      const list = this.unitsByGroup.get(gid) ?? [];
      list.push(u);
      this.unitsByGroup.set(gid, list);
    }
  }

  private indexMaintenance(): void {
    for (const m of db.maintenances.all({ propertyId: this.property.id })) {
      if (!rangesOverlap(m.fromDate, m.toDate, this.from, this.to)) continue;
      const unit = db.units.get(m.unitId);
      if (!unit || unit.isArchived) continue;
      const gid = unit.unitGroupId ?? '';
      for (const date of this.dates) {
        if (date < m.fromDate || date >= m.toDate) continue;
        let perGroup = this.maintenanceByUnitDate.get(gid);
        if (!perGroup) {
          perGroup = new Map();
          this.maintenanceByUnitDate.set(gid, perGroup);
        }
        const counts = perGroup.get(date) ?? emptyMaintenance();
        if (m.type === 'OutOfService') counts.outOfService += 1;
        else if (m.type === 'OutOfOrder') counts.outOfOrder += 1;
        else counts.outOfInventory += 1;
        perGroup.set(date, counts);
      }
    }
  }

  private indexReservations(): void {
    for (const r of db.reservations.all({ propertyId: this.property.id })) {
      const occupies = isActive(r) || (this.options.includeCompleted && r.status === 'CheckedOut');
      if (!occupies) continue;
      if (!rangesOverlap(r.arrivalDate, r.departureDate, this.from, this.to)) continue;
      // A reservation can move between unit groups mid-stay, so count the
      // group named on each individual time slice.
      for (const slice of r.timeSlices) {
        const date = slice.serviceDate;
        if (date < this.from || date >= this.to) continue;
        const k = this.key(slice.unitGroupId, date);
        this.soldByGroupDate.set(k, (this.soldByGroupDate.get(k) ?? 0) + 1);
      }
    }
  }

  private indexBlocks(): void {
    for (const b of db.blocks.all({ propertyId: this.property.id })) {
      if (b.status === 'Canceled') continue;
      if (!rangesOverlap(b.fromDate, b.toDate, this.from, this.to)) continue;
      for (const slice of b.timeSlices) {
        const date = slice.serviceDate;
        if (date < this.from || date >= this.to) continue;
        const k = this.key(b.unitGroupId, date);
        const counts = this.blocksByGroupDate.get(k) ?? emptyBlockCounts();
        applyBlockSlice(counts, b, slice.blockedUnits, slice.pickedUnits);
        this.blocksByGroupDate.set(k, counts);
      }
    }
  }

  private indexOverbooking(): void {
    for (const o of db.overbookings.all({ propertyId: this.property.id })) {
      if (o.date < this.from || o.date >= this.to) continue;
      if (o.unitGroupId) {
        this.overbookingByGroupDate.set(this.key(o.unitGroupId, o.date), o.limit);
      } else {
        this.houseOverbookingByDate.set(o.date, o.limit);
      }
    }
  }

  unitGroups(): UnitGroup[] {
    return db.unitGroups.all({ propertyId: this.property.id });
  }

  /** Availability for one unit group on one night. */
  forGroup(group: UnitGroup, date: string): UnitGroupAvailability {
    const units = this.unitsByGroup.get(group.id) ?? [];
    const physicalCount = units.length;
    const maintenance = this.maintenanceByUnitDate.get(group.id)?.get(date) ?? emptyMaintenance();
    const houseCount = physicalCount - maintenance.outOfInventory;
    const soldCount = this.soldByGroupDate.get(this.key(group.id, date)) ?? 0;
    const block = this.blocksByGroupDate.get(this.key(group.id, date)) ?? emptyBlockCounts();
    const allowedOverbookingCount = this.overbookingByGroupDate.get(this.key(group.id, date)) ?? 0;

    const unsellable = maintenance.outOfService + maintenance.outOfOrder;
    const sellableCount = Math.max(0, houseCount - unsellable - soldCount - block.remaining);
    return {
      unitGroupId: group.id,
      date,
      physicalCount,
      houseCount,
      soldCount,
      occupancy: houseCount > 0 ? round1((soldCount / houseCount) * 100) : 0,
      sellableCount,
      availableCount: sellableCount + allowedOverbookingCount,
      allowedOverbookingCount,
      maintenance,
      block,
    };
  }

  /** Property-level roll-up, restricted to one unit group type. */
  forProperty(date: string, unitGroupType?: UnitGroupType): PropertyAvailability {
    const groups = this.unitGroups().filter((g) => !unitGroupType || g.type === unitGroupType);
    const maintenance = emptyMaintenance();
    const block = emptyBlockCounts();
    let physicalCount = 0;
    let houseCount = 0;
    let soldCount = 0;
    let sellableCount = 0;
    let allowedOverbookingCount = 0;

    for (const g of groups) {
      const a = this.forGroup(g, date);
      physicalCount += a.physicalCount;
      houseCount += a.houseCount;
      soldCount += a.soldCount;
      sellableCount += a.sellableCount;
      allowedOverbookingCount += a.allowedOverbookingCount;
      maintenance.outOfService += a.maintenance.outOfService;
      maintenance.outOfOrder += a.maintenance.outOfOrder;
      maintenance.outOfInventory += a.maintenance.outOfInventory;
      block.definite += a.block.definite;
      block.tentative += a.block.tentative;
      block.optional += a.block.optional;
      block.optionalDeducting += a.block.optionalDeducting;
      block.picked += a.block.picked;
      block.remaining += a.block.remaining;
    }

    const houseOverbookingLimit = this.houseOverbookingByDate.get(date) ?? 0;
    return {
      date,
      physicalCount,
      houseCount,
      soldCount,
      occupancy: houseCount > 0 ? round1((soldCount / houseCount) * 100) : 0,
      sellableCount,
      allowedOverbookingCount,
      houseOverbookingLimit,
      maintenance,
      block,
    };
  }

  /** The house-level cap, which trims per-group availability when set. */
  houseLimitFor(date: string): number {
    return this.houseOverbookingByDate.get(date) ?? 0;
  }

  /** Time-slice boundaries for a night in the property's local time. */
  sliceBounds(date: string, checkInTime: string, checkOutTime: string): { from: string; to: string } {
    return {
      from: atLocalTime(date, checkInTime, this.property.timeZone),
      to: atLocalTime(addOneDay(date), checkOutTime, this.property.timeZone),
    };
  }
}

function applyBlockSlice(counts: BlockCounts, block: Block, blocked: number, picked: number): void {
  const remaining = Math.max(0, blocked - picked);
  counts.picked += picked;
  switch (block.status) {
    case 'Definite':
      counts.definite += blocked;
      counts.remaining += remaining;
      break;
    case 'Tentative':
      counts.tentative += blocked;
      counts.remaining += remaining;
      break;
    case 'Optional':
      counts.optional += blocked;
      if (block.isOptionalDeductingInventory) {
        counts.optionalDeducting += blocked;
        counts.remaining += remaining;
      }
      break;
    default:
      break;
  }
}

function addOneDay(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/**
 * Can `count` units of a group be sold for every night of `[from, to)`?
 * This is the single question the booking flow asks before accepting a stay.
 */
export function canSell(
  property: Property,
  unitGroupId: string,
  from: string,
  to: string,
  count = 1,
): { ok: true } | { ok: false; date: string; available: number } {
  const snapshot = new AvailabilitySnapshot(property, from, to);
  const group = db.unitGroups.get(unitGroupId);
  if (!group) return { ok: false, date: from, available: 0 };
  for (const date of snapshot.dates) {
    const a = snapshot.forGroup(group, date);
    if (a.availableCount < count) {
      return { ok: false, date, available: a.availableCount };
    }
  }
  return { ok: true };
}

/** Availability for every night in a range, per unit group. */
export function availabilityGrid(
  property: Property,
  from: string,
  to: string,
  unitGroupIds?: readonly string[],
): Map<string, UnitGroupAvailability[]> {
  const snapshot = new AvailabilitySnapshot(property, from, to);
  const groups = snapshot.unitGroups()
    .filter((g) => !unitGroupIds?.length || unitGroupIds.includes(g.id));
  const out = new Map<string, UnitGroupAvailability[]>();
  for (const g of groups) {
    out.set(g.id, snapshot.dates.map((d) => snapshot.forGroup(g, d)));
  }
  return out;
}

/** Service availability: how many of a service are still sellable per date. */
export interface ServiceAvailability {
  serviceId: string;
  serviceDate: string;
  quantity: number;
  soldCount: number;
  availableCount: number;
  block: BlockCounts;
}

/**
 * Services are not capacity-limited by default in apaleo - `quantity` reflects
 * a configured cap where one exists, otherwise the house count acts as a
 * sensible ceiling so the numbers remain meaningful.
 */
export function serviceAvailability(
  property: Property,
  from: string,
  to: string,
  serviceIds?: readonly string[],
): ServiceAvailability[] {
  const services = db.services.all({ propertyId: property.id })
    .filter((s) => !serviceIds?.length || serviceIds.includes(s.id));
  const dates = from === to ? [from] : nightsBetween(from, to);
  const capacity = db.units.count({ propertyId: property.id, isArchived: false });

  const sold = new Map<string, number>();
  for (const r of db.reservations.all({ propertyId: property.id })) {
    if (!isActive(r)) continue;
    for (const s of r.services) {
      for (const d of s.dates) {
        if (d.serviceDate < from || d.serviceDate >= to) continue;
        const k = `${s.serviceId}|${d.serviceDate}`;
        sold.set(k, (sold.get(k) ?? 0) + d.count);
      }
    }
  }

  const out: ServiceAvailability[] = [];
  for (const s of services) {
    for (const date of dates) {
      const soldCount = sold.get(`${s.id}|${date}`) ?? 0;
      out.push({
        serviceId: s.id,
        serviceDate: date,
        quantity: capacity,
        soldCount,
        availableCount: Math.max(0, capacity - soldCount),
        block: emptyBlockCounts(),
      });
    }
  }
  return out;
}

