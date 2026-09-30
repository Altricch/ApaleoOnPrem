import { addDays } from '../core/dates';
import { grossToAmount, money } from '../core/money';
import { resolveLocalized } from '../core/localized';
import { db } from './repo';
import { configFor } from './pricing';
import { ensureMainFolio, postFolioCharge } from './folios';
import { routeCharge } from './routing';
import { logReservation } from './audit';
import type { Charge, Folio, Reservation } from './types';

/**
 * Turning a priced reservation into money on a folio.
 *
 * Accommodation is posted one night at a time, on the night it is consumed -
 * which is what the night audit walks through. Services follow their own
 * service date (and shift by a day when the service is flagged `postNextDay`).
 * Nothing is posted twice: each posting is tagged with a stable charge id
 * derived from the reservation and the date.
 */

/**
 * Markers of everything already posted for a reservation. Routed charges live
 * on another folio, so this looks reservation-wide rather than folio-wide -
 * otherwise a routed night would be posted again on the next run.
 */
function existingMarkers(reservationId: string): Set<string> {
  return new Set(
    db.charges.all({ reservationId })
      .map((c) => c.sourceChargeId)
      .filter((x): x is string => !!x),
  );
}

const accommodationMarker = (r: Reservation, date: string) => `${r.id}|ACC|${date}`;
const includedMarker = (r: Reservation, date: string, serviceId: string) => `${r.id}|INC|${date}|${serviceId}`;
const serviceMarker = (r: Reservation, date: string, serviceId: string) => `${r.id}|SVC|${date}|${serviceId}`;
const cityTaxMarker = (r: Reservation, date: string, taxId: string) => `${r.id}|CTX|${date}|${taxId}`;

export interface PostResult {
  charges: Charge[];
  folio: Folio;
}

/**
 * Post everything the reservation owes for one service date. Safe to call
 * repeatedly: already-posted lines are skipped.
 */
export function postForDate(reservation: Reservation, date: string): PostResult {
  const folio = ensureMainFolio(reservation);
  const posted = existingMarkers(reservation.id);
  const charges: Charge[] = [];

  const add = (marker: string, make: () => Charge | undefined) => {
    if (posted.has(marker)) return;
    const charge = make();
    if (!charge) return;
    charge.sourceChargeId = marker;
    db.charges.put(charge);
    posted.add(marker);
    // A standing routing rule may send the charge straight to another folio.
    charges.push(routeCharge(charge));
  };

  // Accommodation for the night, net of any services included in the rate.
  const slice = reservation.timeSlices.find((t) => t.serviceDate === date);
  if (slice) {
    const plan = db.ratePlans.get(slice.ratePlanId);
    const config = configFor(plan?.accountingConfigs ?? [], date, 'Accommodation');
    add(accommodationMarker(reservation, date), () => postFolioCharge(folio, {
      serviceType: 'Accommodation',
      subAccountId: config.subAccountId,
      name: `Accommodation ${date}`,
      amount: slice.baseAmount,
      serviceDate: date,
      reservationId: reservation.id,
      kind: 'TS',
    }));

    for (const included of slice.includedServices) {
      const service = db.services.get(included.serviceId);
      if (!service) continue;
      const svcConfig = configFor(service.accountingConfigs, date, 'Other');
      add(includedMarker(reservation, date, included.serviceId), () => postFolioCharge(folio, {
        serviceType: svcConfig.serviceType,
        serviceId: service.id,
        subAccountId: svcConfig.subAccountId,
        name: resolveLocalized(service.name, ['en']) ?? service.code,
        amount: included.amount,
        quantity: included.count,
        serviceDate: date,
        reservationId: reservation.id,
        kind: 'TS',
      }));
    }
  }

  // Extra services delivered on this date.
  for (const booked of reservation.services) {
    const service = db.services.get(booked.serviceId);
    if (!service) continue;
    for (const entry of booked.dates) {
      // `postNextDay` services are consumed on one date and billed the next.
      const postDate = service.postNextDay ? addDays(entry.serviceDate, 1) : entry.serviceDate;
      if (postDate !== date) continue;
      const svcConfig = configFor(service.accountingConfigs, entry.serviceDate, 'Other');
      add(serviceMarker(reservation, entry.serviceDate, service.id), () => postFolioCharge(folio, {
        serviceType: svcConfig.serviceType,
        serviceId: service.id,
        subAccountId: svcConfig.subAccountId,
        name: resolveLocalized(service.name, ['en']) ?? service.code,
        amount: entry.amount,
        quantity: entry.count,
        serviceDate: entry.serviceDate,
        reservationId: reservation.id,
        kind: 'ES',
      }));
    }
  }

  // City tax for the night.
  if (reservation.hasCityTax) {
    for (const tax of reservation.cityTaxes) {
      const entry = tax.dates.find((d) => d.serviceDate === date);
      if (!entry) continue;
      add(cityTaxMarker(reservation, date, tax.cityTaxId), () => postFolioCharge(folio, {
        serviceType: 'CityTax',
        name: tax.name,
        amount: entry.amount,
        serviceDate: date,
        reservationId: reservation.id,
        kind: 'CT',
      }));
    }
  }

  return { charges, folio };
}

/**
 * Post every night from arrival up to and including `throughDate`. Used by
 * the night audit and by check-out for a same-day departure.
 */
export function postThrough(reservation: Reservation, throughDate: string): PostResult {
  const folio = ensureMainFolio(reservation);
  const charges: Charge[] = [];
  for (const slice of reservation.timeSlices) {
    if (slice.serviceDate > throughDate) continue;
    charges.push(...postForDate(reservation, slice.serviceDate).charges);
  }
  // Services with a posting date inside the window but no matching night
  // (a departure-day breakfast, for instance) still need posting.
  for (const booked of reservation.services) {
    const service = db.services.get(booked.serviceId);
    if (!service) continue;
    for (const entry of booked.dates) {
      const postDate = service.postNextDay ? addDays(entry.serviceDate, 1) : entry.serviceDate;
      if (postDate > throughDate) continue;
      if (reservation.timeSlices.some((t) => t.serviceDate === postDate)) continue;
      charges.push(...postForDate(reservation, postDate).charges);
    }
  }
  return { charges, folio };
}

/** Post everything remaining, as happens at check-out. */
export function postAll(reservation: Reservation): PostResult {
  return postThrough(reservation, addDays(reservation.departureDate, 1));
}

/**
 * Charge the cancellation fee. apaleo posts it to the reservation's folio so
 * it can be settled or written off like any other charge.
 */
export function postCancellationFee(reservation: Reservation, businessDate: string): Charge | undefined {
  const fee = reservation.cancellationFee.fee;
  if (!fee || fee.amount <= 0) return undefined;
  const folio = ensureMainFolio(reservation);
  const policy = reservation.cancellationFee.id
    ? db.cancellationPolicies.get(reservation.cancellationFee.id)
    : undefined;
  const charge = postFolioCharge(folio, {
    serviceType: 'CancellationFees',
    name: `Cancellation fee (${reservation.cancellationFee.code ?? 'policy'})`,
    amount: grossToAmount(fee.amount, policy?.fee.vatType ?? 'Normal', fee.currency),
    serviceDate: businessDate,
    reservationId: reservation.id,
    kind: 'CF',
  });
  logReservation(reservation.id, {
    propertyId: reservation.propertyId,
    action: 'CancellationFeePosted',
    message: `Cancellation fee ${fee.amount.toFixed(2)} ${fee.currency} posted to folio ${folio.id}.`,
  });
  return charge;
}

export function postNoShowFee(reservation: Reservation, businessDate: string): Charge | undefined {
  const fee = reservation.noShowFee.fee;
  if (!fee || fee.amount <= 0) return undefined;
  const folio = ensureMainFolio(reservation);
  const policy = reservation.noShowFee.id ? db.noShowPolicies.get(reservation.noShowFee.id) : undefined;
  const charge = postFolioCharge(folio, {
    serviceType: 'NoShow',
    name: `No-show fee (${reservation.noShowFee.code ?? 'policy'})`,
    amount: grossToAmount(fee.amount, policy?.fee.vatType ?? 'Normal', fee.currency),
    serviceDate: businessDate,
    reservationId: reservation.id,
    kind: 'NF',
  });
  logReservation(reservation.id, {
    propertyId: reservation.propertyId,
    action: 'NoShowFeePosted',
    message: `No-show fee ${fee.amount.toFixed(2)} ${fee.currency} posted to folio ${folio.id}.`,
  });
  return charge;
}

/** Revenue posted for a property on a business date, for reporting. */
export function revenueOn(propertyId: string, date: string, currency: string) {
  const charges = db.charges.all({ propertyId, serviceDate: date });
  return money(charges.reduce((s, c) => s + c.amount.grossAmount, 0), currency);
}
