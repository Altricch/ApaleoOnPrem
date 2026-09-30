import { db } from './repo';
import { moveCharges } from './folios';
import type { Charge, Folio, Routing } from './types';

/**
 * Charge routing: standing instructions that move matching charges from a
 * guest's folio onto another one - typically a company paying the room while
 * the guest settles their own extras.
 *
 * Routings are evaluated when a charge is posted and when a routing is
 * created, so adding a rule mid-stay also sweeps up what is already there.
 */

export function matchesRouting(routing: Routing, charge: Charge, sourceFolio: Folio): boolean {
  const { filter } = routing;
  if (filter.folioIds.length && !filter.folioIds.includes(sourceFolio.id)) return false;
  if (filter.serviceTypes.length && !filter.serviceTypes.includes(charge.serviceType)) return false;
  if (filter.serviceIds.length && (!charge.serviceId || !filter.serviceIds.includes(charge.serviceId))) return false;
  if (filter.subAccountIds.length
    && (!charge.subAccountId || !filter.subAccountIds.includes(charge.subAccountId))) return false;
  if (filter.from && charge.serviceDate < filter.from) return false;
  if (filter.to && charge.serviceDate > filter.to) return false;
  return true;
}

/** Routings that apply to a booking, most recently created last. */
export function routingsFor(bookingId: string): Routing[] {
  return db.routings.all({ bookingId }).sort((a, b) => a.created.localeCompare(b.created));
}

/**
 * Apply every routing of a booking to the charges currently sitting on its
 * folios. Returns the charges that moved.
 */
export function applyRoutings(bookingId: string): Charge[] {
  const routings = routingsFor(bookingId);
  if (!routings.length) return [];

  const moved: Charge[] = [];
  for (const routing of routings) {
    const target = db.folios.get(routing.targetFolioId);
    if (!target || target.isClosed) continue;

    // Candidate sources: every folio of the booking except the target itself.
    const sources = db.folios
      .all({ propertyId: routing.propertyId })
      .filter((f) => f.id !== target.id && !f.isClosed && belongsToBooking(f, bookingId));

    for (const source of sources) {
      const matching = db.charges
        .all({ folioId: source.id })
        .filter((c) => !c.routedToFolioId && matchesRouting(routing, c, source));
      if (!matching.length) continue;

      const ids = matching.map((c) => c.id);
      const result = moveCharges(source, target, ids, 'Routing');
      for (const charge of result) {
        charge.routedFromFolioId = source.id;
        charge.routedToFolioId = target.id;
        db.charges.put(charge);
      }
      moved.push(...result);
    }
  }
  return moved;
}

function belongsToBooking(folio: Folio, bookingId: string): boolean {
  if (folio.bookingId === bookingId) return true;
  if (!folio.reservationId) return false;
  return db.reservations.get(folio.reservationId)?.bookingId === bookingId;
}

/**
 * Route a single freshly posted charge, if a rule claims it. Called right
 * after posting so the charge lands on the right folio immediately.
 */
export function routeCharge(charge: Charge): Charge {
  const folio = db.folios.get(charge.folioId);
  if (!folio) return charge;
  const bookingId = folio.bookingId
    ?? (folio.reservationId ? db.reservations.get(folio.reservationId)?.bookingId : undefined);
  if (!bookingId) return charge;

  for (const routing of routingsFor(bookingId)) {
    if (routing.targetFolioId === folio.id) continue;
    if (!matchesRouting(routing, charge, folio)) continue;
    const target = db.folios.get(routing.targetFolioId);
    if (!target || target.isClosed) continue;
    const [moved] = moveCharges(folio, target, [charge.id], 'Routing');
    if (moved) {
      moved.routedFromFolioId = folio.id;
      moved.routedToFolioId = target.id;
      db.charges.put(moved);
      return moved;
    }
  }
  return charge;
}
