import { addDays, diffDays, nightsBetween, nowIso, toBusinessDate } from '../core/dates';
import { money, type AmountModel, type MonetaryValue } from '../core/money';
import { conflict, unprocessable } from '../core/errors';
import { bookingId as mintBookingId, reservationId as mintReservationId } from '../core/ids';
import { canSell } from './availability';
import { db, property as getProperty, ratePlan as getRatePlan } from './repo';
import { priceStay, type PricedStay, type PriceRequest } from './pricing';
import { freeUnitsForStay, pickUnitForStay } from './operations';
import { logReservation } from './audit';
import type {
  Booking, Person, Reservation, ReservationService, ReservationTimeSlice, Property, RatePlan,
} from './types';

/**
 * Reservation lifecycle.
 *
 *   Confirmed ──check-in──▶ InHouse ──check-out──▶ CheckedOut
 *       │                      │
 *       ├──cancel──▶ Canceled  └──revert-check-in──▶ Confirmed
 *       └──no-show──▶ NoShow
 *
 * Every transition here also keeps the folio, the unit assignment and the
 * audit log consistent, because those are the things a front desk notices
 * when they drift.
 */

export type ReservationAction =
  | 'CheckIn' | 'CheckOut' | 'Cancel' | 'AmendTimeSlices' | 'AmendArrival' | 'AmendDeparture'
  | 'NoShow' | 'AssignUnit' | 'UnassignUnit' | 'RemoveCityTax' | 'AddCityTax'
  | 'RemoveService' | 'AddService' | 'CheckInRevert' | 'LockUnit' | 'UnlockUnit';

export interface ActionAvailability {
  action: ReservationAction;
  isAllowed: boolean;
  reasons?: { code: string; message: string }[];
}

/* ----------------------------------------------------------- allowed actions */

/**
 * Which actions the reservation currently permits, with the documented reason
 * codes when it does not. The UI drives its buttons from this, and the action
 * endpoints re-check the same rules rather than trusting the caller.
 */
export function reservationActions(r: Reservation): ActionAvailability[] {
  const property = db.properties.get(r.propertyId);
  const businessDate = property?.businessDate ?? nowIso().slice(0, 10);
  const hasUnitForWholeStay = coversWholeStay(r);
  const mainFolio = mainFolioOf(r.id);
  const folioClosed = !!mainFolio?.isClosed;
  const hasPostedCharges = mainFolio
    ? db.charges.all({ folioId: mainFolio.id }).some((c) => c.isPosted)
    : false;

  const out: ActionAvailability[] = [];
  const add = (action: ReservationAction, isAllowed: boolean, reasons: { code: string; message: string }[] = []) =>
    out.push({ action, isAllowed, reasons: isAllowed ? undefined : reasons });

  // Check-in.
  {
    const reasons: { code: string; message: string }[] = [];
    if (r.status !== 'Confirmed') {
      reasons.push(reason('CheckInNotAllowedForReservationNotInStatusConfirmed', 'Only a confirmed reservation can be checked in.'));
    }
    if (businessDate < r.arrivalDate) {
      reasons.push(reason('CheckInNotAllowedBeforeArrivalDate', `Check-in is not possible before ${r.arrivalDate}.`));
    }
    if (businessDate >= r.departureDate) {
      reasons.push(reason('CheckInNotAllowedAfterDepartureDateTime', 'The departure date has passed.'));
    }
    if (!hasUnitForWholeStay) {
      reasons.push(reason('CheckInNotAllowedWithoutUnitAssignedForWholeStay', 'A unit must be assigned for the whole stay.'));
    }
    add('CheckIn', reasons.length === 0, reasons);
  }

  // Revert check-in.
  {
    const reasons: { code: string; message: string }[] = [];
    if (r.status !== 'InHouse') {
      reasons.push(reason('CheckInRevertNotAllowedForReservationNotInInHouseStatus', 'The reservation is not in house.'));
    }
    if (hasPostedCharges) {
      reasons.push(reason('CheckInRevertNotAllowedForReservationWithPostedCharges', 'Charges have already been posted.'));
    }
    add('CheckInRevert', reasons.length === 0, reasons);
  }

  // Check-out.
  {
    const reasons: { code: string; message: string }[] = [];
    if (r.status !== 'InHouse') {
      reasons.push(reason('CheckOutNotAllowedForReservationNotInStatusInHouse', 'Only an in-house reservation can be checked out.'));
    }
    if (diffDays(businessDate, r.departureDate) > 1) {
      reasons.push(reason('CheckOutNotAllowedWithDepartureDateMoreThanOneDayInTheFuture', 'The departure date is more than one day away.'));
    }
    add('CheckOut', reasons.length === 0, reasons);
  }

  add('Cancel', r.status === 'Confirmed',
    [reason('CancelNotAllowedForReservationNotInStatusConfirmed', 'Only a confirmed reservation can be cancelled.')]);

  {
    const reasons: { code: string; message: string }[] = [];
    if (r.status !== 'Confirmed') {
      reasons.push(reason('NoShowNotAllowedForReservationNotInStatusConfirmed', 'Only a confirmed reservation can be marked as a no-show.'));
    }
    if (businessDate < r.arrivalDate) {
      reasons.push(reason('NoShowNotAllowedBeforeArrivalDate', 'The arrival date has not been reached.'));
    }
    add('NoShow', reasons.length === 0, reasons);
  }

  const amendable = r.status === 'Confirmed' || r.status === 'InHouse';
  add('AmendTimeSlices', amendable && !folioClosed,
    [reason('AmendNotAllowedForNotAmendableTimeSlices', 'The stay can no longer be amended.')]);
  add('AmendArrival', r.status === 'Confirmed' && !folioClosed,
    [reason('AmendArrivalNotAllowedForReservationNotInStatusConfirmed', 'Only a confirmed reservation can change its arrival.')]);
  add('AmendDeparture', amendable && !folioClosed,
    [reason('AmendDepartureNotAllowedForReservationNotInStatusConfirmedOrInHouse', 'The reservation is in a final status.')]);

  {
    const reasons: { code: string; message: string }[] = [];
    if (!amendable) {
      reasons.push(reason('AssignUnitNotAllowedForReservationNotInStatusConfirmedOrInHouse', 'The reservation is in a final status.'));
    }
    if (r.departureDate < businessDate) {
      reasons.push(reason('AssignUnitNotAllowedForReservationInThePast', 'The reservation is in the past.'));
    }
    if (r.isUnitAssignmentLocked) {
      reasons.push(reason('AssignUnitNotAllowedForLockedReservation', 'The unit assignment is locked.'));
    }
    add('AssignUnit', reasons.length === 0, reasons);
  }

  {
    const reasons: { code: string; message: string }[] = [];
    if (r.status !== 'Confirmed') {
      reasons.push(reason('UnassignUnitNotAllowedForReservationNotInStatusConfirmed', 'Only a confirmed reservation can release its unit.'));
    }
    if (!r.assignedUnits.length) {
      reasons.push(reason('UnassignUnitNotAllowedForReservationWithoutUnit', 'No unit is assigned.'));
    }
    if (r.isUnitAssignmentLocked) {
      reasons.push(reason('UnassignUnitNotAllowedForLockedReservation', 'The unit assignment is locked.'));
    }
    add('UnassignUnit', reasons.length === 0, reasons);
  }

  {
    const reasons: { code: string; message: string }[] = [];
    if (!amendable) {
      reasons.push(reason('RemoveCityTaxNotAllowedForReservationNotInStatusConfirmedOrInHouse', 'The reservation is in a final status.'));
    }
    if (!r.hasCityTax) {
      reasons.push(reason('RemoveCityTaxNotAllowedForReservationWithoutCityTax', 'The reservation has no city tax.'));
    }
    if (hasPostedCharges) {
      reasons.push(reason('RemoveCityTaxNotAllowedForReservationWithPostedCharges', 'City tax has already been posted.'));
    }
    add('RemoveCityTax', reasons.length === 0, reasons);
  }

  {
    const plan = db.ratePlans.get(r.ratePlanId);
    const reasons: { code: string; message: string }[] = [];
    if (!amendable) {
      reasons.push(reason('AddCityTaxNotAllowedForReservationNotInStatusConfirmedOrInHouse', 'The reservation is in a final status.'));
    }
    if (r.hasCityTax) {
      reasons.push(reason('AddCityTaxNotAllowedForReservationWithCityTax', 'The reservation already has city tax.'));
    }
    if (plan && !plan.isSubjectToCityTax) {
      reasons.push(reason('AddCityTaxNotAllowedForReservationForRatePlanNotSubjectToCityTax', 'The rate plan is not subject to city tax.'));
    }
    add('AddCityTax', reasons.length === 0, reasons);
  }

  add('AddService', amendable && !folioClosed && r.departureDate >= businessDate,
    [reason('AddServiceNotAllowedForReservationNotInStatusConfirmedOrInHouse', 'Services cannot be added to this reservation.')]);
  add('RemoveService', amendable && r.departureDate >= businessDate,
    [reason('RemoveServiceNotAllowedForReservationNotInStatusConfirmedOrInHouse', 'Services cannot be removed from this reservation.')]);

  add('LockUnit', amendable && r.assignedUnits.length > 0 && !r.isUnitAssignmentLocked,
    [reason('LockUnitNotAllowedForReservationWhenUnitsNotAssigned', 'No unit is assigned.')]);
  add('UnlockUnit', r.isUnitAssignmentLocked,
    [reason('UnlockUnitNotAllowedForReservationNotLocked', 'The unit assignment is not locked.')]);

  return out;
}

const reason = (code: string, message: string) => ({ code, message });

/** Throw unless the named action is currently permitted. */
export function assertAction(r: Reservation, action: ReservationAction): void {
  const entry = reservationActions(r).find((a) => a.action === action);
  if (!entry || entry.isAllowed) return;
  throw unprocessable(entry.reasons?.map((x) => x.message) ?? [`'${action}' is not allowed.`]);
}

/** Does the reservation have a unit assigned for every night of the stay? */
export function coversWholeStay(r: Reservation): boolean {
  if (!r.assignedUnits.length) return false;
  const nights = nightsBetween(r.arrivalDate, r.departureDate);
  return nights.every((night) =>
    r.assignedUnits.some((a) =>
      a.timeRanges.length === 0
      || a.timeRanges.some((t) => toBusinessDate(t.from) <= night && night < toBusinessDate(t.to))));
}

export function mainFolioOf(reservationId: string) {
  return db.folios.all({ reservationId }).find((f) => f.isMainFolio);
}

/* ------------------------------------------------------------- creation */

export interface CreateReservationInput {
  arrival: string;
  departure: string;
  adults: number;
  childrenAges?: number[];
  comment?: string;
  guestComment?: string;
  externalCode?: string;
  channelCode: string;
  source?: string;
  primaryGuest?: Person;
  additionalGuests?: Person[];
  guaranteeType?: string;
  travelPurpose?: string;
  timeSlices: { ratePlanId: string; totalAmount?: MonetaryValue }[];
  services?: { serviceId: string; count?: number; amount?: MonetaryValue; dates?: string[] }[];
  companyId?: string;
  corporateCode?: string;
  prePaymentAmount?: MonetaryValue;
  commission?: { commissionAmount: MonetaryValue; beforeCommissionAmount?: MonetaryValue };
  promoCode?: string;
  externalReferences?: Record<string, string>;
  blockId?: string;
  groupId?: string;
  marketSegmentId?: string;
}

export interface QuoteResult {
  property: Property;
  ratePlan: RatePlan;
  priced: PricedStay;
  arrivalDate: string;
  departureDate: string;
  /** Per-night rate plan, honouring mid-stay rate plan changes. */
  slicePlans: RatePlan[];
}

/**
 * Price a requested stay. `timeSlices` carries one entry per night, each
 * naming the rate plan for that night, so a stay can move between rate plans
 * mid-way - which is how apaleo models a guest extending onto a different
 * rate.
 */
export function quote(input: CreateReservationInput): QuoteResult {
  if (!input.timeSlices?.length) throw unprocessable('`timeSlices` must contain at least one entry.');

  const firstPlan = getRatePlan(input.timeSlices[0]!.ratePlanId);
  const property = getProperty(firstPlan.propertyId);
  const arrivalDate = toBusinessDate(input.arrival, property.timeZone);
  const departureDate = toBusinessDate(input.departure, property.timeZone);
  const nights = diffDays(arrivalDate, departureDate);

  if (nights < 1) throw unprocessable('`departure` must be at least one day after `arrival`.');
  if (input.timeSlices.length !== nights) {
    throw unprocessable(`The stay covers ${nights} night(s) but ${input.timeSlices.length} time slice(s) were supplied.`);
  }

  const slicePlans = input.timeSlices.map((t) => getRatePlan(t.ratePlanId));
  for (const plan of slicePlans) {
    if (plan.propertyId !== property.id) {
      throw unprocessable('All time slices must use rate plans from the same property.');
    }
  }

  // Manual per-night prices override the rate table.
  const overridePrices = new Map<string, number>();
  input.timeSlices.forEach((slice, i) => {
    if (slice.totalAmount) overridePrices.set(addDays(arrivalDate, i), slice.totalAmount.amount);
  });

  const request: PriceRequest = {
    property,
    ratePlan: firstPlan,
    arrival: arrivalDate,
    departure: departureDate,
    adults: input.adults,
    childrenAges: input.childrenAges ?? [],
    channelCode: input.channelCode,
    promoCode: input.promoCode,
    corporateCode: input.corporateCode,
    companyId: input.companyId,
    overridePrices: overridePrices.size ? overridePrices : undefined,
    extraServices: input.services?.map((s) => ({ serviceId: s.serviceId, dates: s.dates })),
  };
  const priced = priceStay(request);

  // Re-price any night whose rate plan differs from the first.
  priced.timeSlices.forEach((slice, i) => {
    const plan = slicePlans[i]!;
    if (plan.id === firstPlan.id) return;
    const single = priceStay({
      ...request,
      ratePlan: plan,
      arrival: slice.serviceDate,
      departure: addDays(slice.serviceDate, 1),
    });
    const replacement = single.timeSlices[0];
    if (replacement) priced.timeSlices[i] = replacement;
    priced.validationMessages.push(...single.validationMessages.filter(
      (m) => !priced.validationMessages.some((x) => x.code === m.code && x.message === m.message),
    ));
  });

  priced.totalGrossAmount = money(
    priced.timeSlices.reduce((sum, s) => sum + s.totalGrossAmount.amount, 0)
    + priced.services.reduce((sum, s) => sum + s.totalAmount.grossAmount, 0)
    + priced.cityTaxes.reduce((sum, t) => sum + t.totalGrossAmount.amount, 0),
    property.currencyCode,
  );

  return { property, ratePlan: firstPlan, priced, arrivalDate, departureDate, slicePlans };
}

/**
 * Check inventory for a quoted stay. Returns the validation messages rather
 * than throwing, so `$force` variants of the booking endpoints can go ahead
 * anyway.
 */
export function checkAvailability(q: QuoteResult, blockId?: string): { code: string; message: string }[] {
  const messages: { code: string; message: string }[] = [];
  if (blockId) {
    const block = db.blocks.get(blockId);
    if (!block) {
      messages.push({ code: 'BlockFullyBooked', message: `Block '${blockId}' was not found.` });
      return messages;
    }
    const shortfall = block.timeSlices.find((t) => t.pickedUnits >= t.blockedUnits);
    if (shortfall) {
      messages.push({
        code: 'BlockFullyBooked',
        message: `Block '${blockId}' has no units left on ${shortfall.serviceDate}.`,
      });
    }
    return messages;
  }
  const result = canSell(q.property, q.ratePlan.unitGroupId, q.arrivalDate, q.departureDate, 1);
  if (!result.ok) {
    messages.push({
      code: 'UnitGroupFullyBooked',
      message: `No availability in unit group '${q.ratePlan.unitGroupId}' on ${result.date}.`,
    });
  }
  return messages;
}

/** Build the persisted reservation from a quote. */
export function materialize(
  q: QuoteResult,
  input: CreateReservationInput,
  ids: { reservationId: string; bookingId: string },
  validationMessages: { category: string; code: string; message: string }[],
): Reservation {
  const { property, priced } = q;
  const now = nowIso();

  const timeSlices: ReservationTimeSlice[] = priced.timeSlices.map((s, i) => ({
    from: s.from,
    to: s.to,
    serviceDate: s.serviceDate,
    ratePlanId: q.slicePlans[i]?.id ?? s.ratePlanId,
    unitGroupId: q.slicePlans[i]?.unitGroupId ?? s.unitGroupId,
    baseAmount: s.baseAmount,
    totalAmount: toAmount(s.totalGrossAmount, s.baseAmount),
    includedServices: s.includedServices,
  }));

  const services: ReservationService[] = priced.services.map((s, i) => ({
    id: `${ids.reservationId}-S${i + 1}`,
    serviceId: s.serviceId,
    dates: s.dates.map((d) => ({
      serviceDate: d.serviceDate,
      amount: d.amount,
      count: d.count,
      isMandatory: d.isMandatory,
    })),
    totalAmount: s.totalAmount,
    bookedAsExtra: !s.dates.some((d) => d.isMandatory),
  }));

  return {
    id: ids.reservationId,
    bookingId: ids.bookingId,
    blockId: input.blockId,
    groupId: input.groupId,
    propertyId: property.id,
    status: 'Confirmed',
    ratePlanId: q.ratePlan.id,
    unitGroupId: q.ratePlan.unitGroupId,
    marketSegmentId: input.marketSegmentId ?? q.ratePlan.marketSegmentId,
    arrival: priced.arrivalDateTime,
    departure: priced.departureDateTime,
    arrivalDate: q.arrivalDate,
    departureDate: q.departureDate,
    created: now,
    updated: now,
    adults: input.adults,
    childrenAges: input.childrenAges ?? [],
    comment: input.comment,
    guestComment: input.guestComment,
    externalCode: input.externalCode,
    channelCode: input.channelCode as Reservation['channelCode'],
    source: input.source,
    primaryGuest: input.primaryGuest,
    additionalGuests: input.additionalGuests ?? [],
    guaranteeType: (input.guaranteeType ?? q.ratePlan.minGuaranteeType) as Reservation['guaranteeType'],
    travelPurpose: input.travelPurpose as Reservation['travelPurpose'],
    timeSlices,
    services,
    assignedUnits: [],
    companyId: input.companyId,
    corporateCode: input.corporateCode,
    promoCode: input.promoCode,
    commission: input.commission
      ? {
        commissionAmount: input.commission.commissionAmount,
        beforeCommissionAmount: input.commission.beforeCommissionAmount ?? priced.totalGrossAmount,
      }
      : undefined,
    cancellationFee: {
      id: priced.cancellationFee.policy?.id,
      code: priced.cancellationFee.policy?.code,
      name: priced.cancellationFee.policy?.name,
      dueDateTime: priced.cancellationFee.dueDateTime,
      fee: priced.cancellationFee.fee,
    },
    noShowFee: {
      id: priced.noShowFee.policy?.id,
      code: priced.noShowFee.policy?.code,
      name: priced.noShowFee.policy?.name,
      fee: priced.noShowFee.fee,
    },
    isPreCheckedIn: false,
    isUnitAssignmentLocked: false,
    hasCityTax: priced.cityTaxes.length > 0,
    cityTaxes: priced.cityTaxes.map((t) => ({
      cityTaxId: t.cityTaxId,
      code: t.code,
      name: t.name,
      dates: t.dates,
    })),
    prePaymentAmount: input.prePaymentAmount ?? priced.prePaymentAmount,
    validationMessages,
    currency: property.currencyCode,
    nextFolioOrdinal: 1,
    externalReferences: input.externalReferences,
  };
}

function toAmount(total: MonetaryValue, like: AmountModel): AmountModel {
  const ratio = like.grossAmount === 0 ? 1 : like.netAmount / like.grossAmount;
  return {
    grossAmount: total.amount,
    netAmount: Math.round(total.amount * ratio * 100) / 100,
    vatType: like.vatType,
    vatPercent: like.vatPercent,
    currency: total.currency,
  };
}

/** Allocate the next reservation id inside a booking. */
export function nextReservationId(booking: Booking): string {
  const id = mintReservationId(booking.id, booking.nextReservationOrdinal);
  booking.nextReservationOrdinal += 1;
  return id;
}

export function newBookingId(): string {
  return mintBookingId((id) => db.bookings.exists(id));
}

/* ------------------------------------------------------------ totals */

export function totalGrossOf(r: Reservation): MonetaryValue {
  const accommodation = r.timeSlices.reduce((s, t) => s + t.totalAmount.grossAmount, 0);
  const services = r.services.reduce((s, x) => s + x.totalAmount.grossAmount, 0);
  const cityTax = r.cityTaxes.reduce(
    (s, t) => s + t.dates.reduce((a, d) => a + d.amount.grossAmount, 0), 0,
  );
  return money(accommodation + services + cityTax, r.currency);
}

/**
 * Outstanding balance across the reservation's folios. Mirrors
 * `folioTotals`, summed over every folio the reservation owns.
 */
export function balanceOf(r: Reservation): MonetaryValue {
  const folios = db.folios.all({ reservationId: r.id });
  let balance = 0;
  for (const folio of folios) {
    for (const c of db.charges.all({ folioId: folio.id })) balance += c.amount.grossAmount;
    for (const t of db.transitoryCharges.all({ folioId: folio.id })) balance += t.amount.grossAmount;
    for (const a of db.allowances.all({ folioId: folio.id })) balance -= a.amount.grossAmount;
    for (const p of db.payments.all({ folioId: folio.id })) {
      if (p.status === 'Success') balance -= p.amount.amount;
    }
    for (const refund of db.refunds.all({ folioId: folio.id })) {
      if (refund.status === 'Success') balance += refund.amount.amount;
    }
  }
  return money(balance, r.currency);
}

/** VAT breakdown over everything the reservation will be charged. */
export function taxDetailsOf(r: Reservation) {
  const byType = new Map<string, { vatType: string; vatPercent: number; net: number; tax: number }>();
  const add = (a: AmountModel) => {
    const key = `${a.vatType}|${a.vatPercent}`;
    const e = byType.get(key) ?? { vatType: a.vatType, vatPercent: a.vatPercent, net: 0, tax: 0 };
    e.net += a.netAmount;
    e.tax += a.grossAmount - a.netAmount;
    byType.set(key, e);
  };
  for (const t of r.timeSlices) {
    add(t.baseAmount);
    t.includedServices.forEach((i) => add(i.amount));
  }
  for (const s of r.services) s.dates.forEach((d) => add(d.amount));
  for (const t of r.cityTaxes) t.dates.forEach((d) => add(d.amount));

  return [...byType.values()]
    .filter((e) => e.net !== 0 || e.tax !== 0)
    .sort((a, b) => a.vatPercent - b.vatPercent)
    .map((e) => ({
      vatType: e.vatType,
      vatPercent: e.vatPercent,
      net: money(e.net, r.currency),
      tax: money(e.tax, r.currency),
    }));
}

/* ------------------------------------------------------ unit assignment */

/** Assign a specific unit for the whole stay. */
export function assignUnit(r: Reservation, unitId: string, force = false): void {
  const unit = db.units.get(unitId);
  if (!unit) throw unprocessable(`Unit '${unitId}' does not exist.`);
  if (unit.propertyId !== r.propertyId) {
    throw unprocessable(`Unit '${unitId}' belongs to a different property.`);
  }
  if (!force) {
    const free = freeUnitsForStay(r.propertyId, unit.unitGroupId, r.arrivalDate, r.departureDate, {
      ignoreReservationId: r.id,
    });
    if (!free.some((u) => u.id === unitId)) {
      throw conflict(`Unit '${unitId}' is not available for the whole stay.`);
    }
  }
  r.assignedUnits = [{ unitId, timeRanges: [{ from: r.arrival, to: r.departure }] }];
  r.unitId = unitId;
  r.unit = { id: unitId };
  r.updated = nowIso();
  logReservation(r.id, {
    propertyId: r.propertyId,
    action: 'UnitAssigned',
    message: `Unit ${unit.name} (${unitId}) assigned.`,
  });
}

/** Auto-assign the best free unit, optionally restricted by condition. */
export function autoAssignUnit(r: Reservation, conditions?: readonly string[]): string | undefined {
  let candidate = pickUnitForStay(r.propertyId, r.unitGroupId, r.arrivalDate, r.departureDate, r.id);
  if (conditions?.length) {
    const free = freeUnitsForStay(r.propertyId, r.unitGroupId, r.arrivalDate, r.departureDate, {
      ignoreReservationId: r.id,
    }).filter((u) => conditions.includes(u.condition));
    candidate = free.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))[0];
  }
  if (!candidate) return undefined;
  assignUnit(r, candidate.id);
  return candidate.id;
}

export function unassignUnits(r: Reservation): void {
  r.assignedUnits = [];
  r.unitId = undefined;
  r.unit = undefined;
  r.updated = nowIso();
  logReservation(r.id, {
    propertyId: r.propertyId,
    action: 'UnitUnassigned',
    message: 'Unit assignment removed.',
  });
}

