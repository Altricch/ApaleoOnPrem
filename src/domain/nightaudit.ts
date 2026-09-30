import { addDays, nowIso } from '../core/dates';
import { money } from '../core/money';
import { nextSeq, transact } from '../core/db';
import { db } from './repo';
import { postThrough, postNoShowFee } from './posting';
import { logReservation } from './audit';
import type { NightAuditLog, Property, Reservation } from './types';

/**
 * The night audit: the once-a-day run that closes out the business date.
 *
 * Order matters and mirrors apaleo's own sequence:
 *
 *   1. reservations that were due to arrive and never did become no-shows
 *      (optional, and charged their no-show fee)
 *   2. every in-house reservation has the closing day's accommodation,
 *      services and city tax posted to its folio
 *   3. units still occupied by a reservation that should have departed are
 *      reported as a warning rather than silently checked out
 *   4. the property's business date advances by one day
 *
 * It is idempotent per business date: postings are keyed by reservation and
 * date, so re-running a day does not duplicate revenue.
 */

export interface NightAuditOptions {
  setReservationsToNoShow?: boolean;
  triggeredBy?: string;
}

export interface NightAuditResult {
  propertyId: string;
  businessDate: string;
  nextBusinessDate: string;
  chargesPosted: number;
  noShowsMarked: number;
  reservationIdsSetToNoShow: string[];
  reservationsInHouse: number;
  revenue: { amount: number; currency: string };
  warnings: string[];
  log: NightAuditLog;
}

export function runNightAudit(property: Property, options: NightAuditOptions = {}): NightAuditResult {
  const businessDate = property.businessDate;
  const warnings: string[] = [];
  const reservationIdsSetToNoShow: string[] = [];
  let chargesPosted = 0;

  const result = transact(() => {
    /* 1. No-shows: confirmed reservations whose arrival date has passed. */
    if (options.setReservationsToNoShow !== false) {
      const due = db.reservations
        .all({ propertyId: property.id, status: 'Confirmed' })
        .filter((r) => r.arrivalDate <= businessDate);
      for (const r of due) {
        r.status = 'NoShow';
        r.noShowTime = nowIso();
        r.updated = r.noShowTime;
        r.assignedUnits = [];
        r.unitId = undefined;
        r.unit = undefined;
        db.reservations.put(r);
        postNoShowFee(r, businessDate);
        reservationIdsSetToNoShow.push(r.id);
        logReservation(r.id, {
          propertyId: property.id,
          action: 'SetToNoShow',
          message: `Set to no-show by the night audit for ${businessDate}.`,
          source: options.triggeredBy ?? 'night-audit',
        });
      }
    }

    /* 2. Post the closing day for everyone in house. */
    const inHouse = db.reservations.all({ propertyId: property.id, status: 'InHouse' });
    for (const r of inHouse) {
      const { charges } = postThrough(r, businessDate);
      chargesPosted += charges.length;
    }

    /* 3. Warn about rooms that should have been vacated. */
    const overdue = inHouse.filter((r) => r.departureDate <= businessDate);
    for (const r of overdue) {
      warnings.push(
        `Reservation ${r.id} was due to depart on ${r.departureDate} but is still in house.`,
      );
    }
    const unassigned = db.reservations
      .all({ propertyId: property.id, status: 'Confirmed' })
      .filter((r) => r.arrivalDate === addDays(businessDate, 1) && !r.unitId);
    if (unassigned.length) {
      warnings.push(`${unassigned.length} arrival(s) for tomorrow have no unit assigned.`);
    }

    /* 4. Roll the business date forward. */
    const nextBusinessDate = addDays(businessDate, 1);
    property.businessDate = nextBusinessDate;
    db.properties.put(property);

    const revenue = revenueFor(property.id, businessDate, property.currencyCode);
    const log: NightAuditLog = {
      id: `${property.id}-NA-${nextSeq(`nightaudit:${property.id}`)}`,
      propertyId: property.id,
      businessDate,
      created: nowIso(),
      triggeredBy: options.triggeredBy ?? 'system',
      summary: {
        chargesPosted,
        noShowsMarked: reservationIdsSetToNoShow.length,
        reservationsInHouse: inHouse.length,
        revenue,
      },
      warnings,
    };
    db.nightAuditLogs.put(log);

    return {
      propertyId: property.id,
      businessDate,
      nextBusinessDate,
      chargesPosted,
      noShowsMarked: reservationIdsSetToNoShow.length,
      reservationIdsSetToNoShow,
      reservationsInHouse: inHouse.length,
      revenue,
      warnings,
      log,
    } satisfies NightAuditResult;
  });

  return result;
}

function revenueFor(propertyId: string, date: string, currency: string) {
  const charges = db.charges.all({ propertyId, serviceDate: date });
  return money(charges.reduce((sum, c) => sum + c.amount.grossAmount, 0), currency);
}

/** Reservations the audit would turn into no-shows, for a dry run. */
export function pendingNoShows(property: Property): Reservation[] {
  return db.reservations
    .all({ propertyId: property.id, status: 'Confirmed' })
    .filter((r) => r.arrivalDate <= property.businessDate);
}
