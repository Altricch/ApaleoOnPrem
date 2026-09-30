import type { Request, Response } from 'express';
import { ApiBuilder } from '../core/router';
import {
  arrayParam, boolParam, dateParam, intParam, optionalIntParam, paging, requiredDateParam,
  requiredStringParam, sendCreated, sendList, sendNoContent, stringParam,
} from '../core/http';
import { conflict, notFound, unprocessable } from '../core/errors';
import { applyPatch, rejectImmutablePaths, type PatchOperation } from '../core/patch';
import { resolveLocalized } from '../core/localized';
import {
  addDays, atLocalTime, datesInclusive, diffDays, nightsBetween, nowIso, toBusinessDate,
} from '../core/dates';
import { authorizationId as mintAuthId, blockId as mintBlockId, groupId as mintGroupId, paymentAccountId as mintPaymentAccountId } from '../core/ids';
import { grossToAmount, money, round } from '../core/money';
import { transact } from '../core/db';
import {
  db, embeddedCompany, embeddedMarketSegment, embeddedProperty, embeddedRatePlan,
  embeddedService, embeddedUnit, embeddedUnitGroup, languagesOf,
  property as getProperty, ratePlan as getRatePlan, reservation as getReservation,
  booking as getBooking, block as getBlock, group as getGroup,
} from '../domain/repo';
import {
  assertAction, autoAssignUnit, assignUnit, balanceOf, checkAvailability, coversWholeStay,
  materialize, newBookingId, nextReservationId, quote, reservationActions, taxDetailsOf,
  totalGrossOf, unassignUnits, type CreateReservationInput,
} from '../domain/reservations';
import { ensureMainFolio, folioTotals, mainFolioOf } from '../domain/folios';
import { postAll, postCancellationFee, postNoShowFee, postThrough } from '../domain/posting';
import {
  priceStay, serviceDates, serviceCount, resolvePrice, resolveRestrictions, configFor,
} from '../domain/pricing';
import { AvailabilitySnapshot, canSell } from '../domain/availability';
import { isActive } from '../domain/operations';
import { logReservation } from '../domain/audit';
import { GENDERS, IDENTIFICATION_TYPES, SOURCES } from '../domain/reference';
import type {
  Authorization, Block, Booking, Group, PaymentAccount, Person, RatePlan, Reservation, Service,
} from '../domain/types';
import { openRestrictions } from '../domain/types';

/**
 * Booking API - offers, bookings, reservations, blocks, groups and the
 * payment artefacts that hang off them. This is where the PMS actually sells
 * and operates rooms.
 */

const api = new ApiBuilder('booking-v1');

/* ------------------------------------------------------------ presenters */

function reservationBody(r: Reservation, langs: readonly string[], expand: ReadonlySet<string>) {
  const booking = db.bookings.get(r.bookingId);
  const folios = db.folios.all({ reservationId: r.id });
  const paymentAccount = booking?.paymentAccountId
    ? db.paymentAccounts.get(booking.paymentAccountId)
    : undefined;

  return {
    id: r.id,
    bookingId: r.bookingId,
    blockId: r.blockId,
    groupName: r.groupId ? db.groups.get(r.groupId)?.name : undefined,
    status: r.status,
    checkInTime: r.checkInTime,
    checkOutTime: r.checkOutTime,
    cancellationTime: r.cancellationTime,
    noShowTime: r.noShowTime,
    unit: embeddedUnit(r.unitId, langs),
    property: embeddedProperty(r.propertyId, langs),
    ratePlan: embeddedRatePlan(r.ratePlanId, langs),
    unitGroup: embeddedUnitGroup(r.unitGroupId, langs),
    marketSegment: embeddedMarketSegment(r.marketSegmentId, langs),
    totalGrossAmount: totalGrossOf(r),
    arrival: r.arrival,
    departure: r.departure,
    created: r.created,
    modified: r.updated,
    adults: r.adults,
    childrenAges: r.childrenAges.length ? r.childrenAges : undefined,
    comment: r.comment,
    guestComment: r.guestComment,
    externalCode: r.externalCode,
    channelCode: r.channelCode,
    source: r.source,
    primaryGuest: r.primaryGuest,
    additionalGuests: r.additionalGuests.length ? r.additionalGuests : undefined,
    booker: expand.has('booker') ? booking?.booker : undefined,
    paymentAccount: paymentAccount ? paymentAccountBody(paymentAccount) : undefined,
    hasActivePaymentAccount: !!paymentAccount?.isActive,
    registeredCard: r.registeredCard,
    timeSlices: expand.has('timeSlices') ? r.timeSlices.map((t) => timeSliceBody(r, t, langs)) : undefined,
    services: expand.has('services') ? r.services.map((s) => reservationServiceBody(s, langs)) : undefined,
    guaranteeType: r.guaranteeType,
    cancellationFee: {
      id: r.cancellationFee.id,
      code: r.cancellationFee.code,
      name: resolveLocalized(r.cancellationFee.name, langs),
      description: resolveLocalized(
        r.cancellationFee.id ? db.cancellationPolicies.get(r.cancellationFee.id)?.description : undefined,
        langs,
      ),
      dueDateTime: r.cancellationFee.dueDateTime,
      fee: r.cancellationFee.fee,
    },
    noShowFee: {
      id: r.noShowFee.id,
      code: r.noShowFee.code,
      name: resolveLocalized(r.noShowFee.name, langs),
      description: resolveLocalized(
        r.noShowFee.id ? db.noShowPolicies.get(r.noShowFee.id)?.description : undefined,
        langs,
      ),
      fee: r.noShowFee.fee,
    },
    travelPurpose: r.travelPurpose,
    balance: balanceOf(r),
    assignedUnits: r.assignedUnits.length
      ? r.assignedUnits.map((a) => ({ unit: embeddedUnit(a.unitId, langs), timeRanges: a.timeRanges }))
      : undefined,
    validationMessages: r.validationMessages.length ? r.validationMessages : undefined,
    actions: expand.has('actions') ? reservationActions(r) : undefined,
    company: embeddedCompany(r.companyId),
    corporateCode: r.corporateCode,
    allFoliosHaveInvoice: folios.length > 0 && folios.every((f) => !!f.invoiceId),
    taxDetails: taxDetailsOf(r),
    hasCityTax: r.hasCityTax,
    commission: r.commission,
    promoCode: r.promoCode,
    payableAmount: { guest: balanceOf(r) },
    isPreCheckedIn: r.isPreCheckedIn,
    isOpenForCharges: r.status === 'InHouse' || (r.status === 'Confirmed' && !mainFolioOf(r.id)?.isClosed),
    externalReferences: r.externalReferences,
    isUnitAssignmentLocked: r.isUnitAssignmentLocked,
  };
}

function timeSliceBody(r: Reservation, t: Reservation['timeSlices'][number], langs: readonly string[]) {
  const property = db.properties.get(r.propertyId);
  const businessDate = property?.businessDate ?? t.serviceDate;
  const posted = db.charges.all({ propertyId: r.propertyId, serviceDate: t.serviceDate })
    .some((c) => c.reservationId === r.id && c.serviceType === 'Accommodation');
  return {
    from: t.from,
    to: t.to,
    serviceDate: t.serviceDate,
    ratePlan: embeddedRatePlan(t.ratePlanId, langs),
    unitGroup: embeddedUnitGroup(t.unitGroupId, langs),
    unit: embeddedUnit(r.unitId, langs),
    baseAmount: t.baseAmount,
    totalGrossAmount: money(t.totalAmount.grossAmount, t.totalAmount.currency),
    includedServices: t.includedServices.map((i) => ({
      service: embeddedService(i.serviceId, langs),
      serviceDate: t.serviceDate,
      count: i.count,
      amount: i.amount,
      bookedAsExtra: false,
    })),
    actions: [{
      action: 'Amend',
      isAllowed: !posted && t.serviceDate >= businessDate && isActive(r),
      reasons: posted
        ? [{ code: 'AmendNotAllowedWhenTimeSliceIsAlreadyPosted', message: 'The night has already been posted.' }]
        : t.serviceDate < businessDate
          ? [{ code: 'AmendNotAllowedWhenTimeSliceIsInThePast', message: 'The night is in the past.' }]
          : !isActive(r)
            ? [{ code: 'AmendNotAllowedForReservationInFinalStatus', message: 'The reservation is in a final status.' }]
            : undefined,
    }],
  };
}

function reservationServiceBody(s: Reservation['services'][number], langs: readonly string[]) {
  const service = db.services.get(s.serviceId);
  return {
    service: service
      ? {
        id: service.id,
        code: service.code,
        name: resolveLocalized(service.name, langs),
        description: resolveLocalized(service.description, langs),
        pricingUnit: service.pricingUnit,
        defaultGrossPrice: money(service.defaultGrossPrice, service.currency),
      }
      : { id: s.serviceId },
    totalAmount: s.totalAmount,
    dates: s.dates.map((d) => ({
      serviceDate: d.serviceDate,
      count: d.count,
      amount: d.amount,
      isMandatory: d.isMandatory,
    })),
  };
}

function paymentAccountBody(a: PaymentAccount) {
  return {
    accountNumber: a.accountNumber,
    accountHolder: a.accountHolder,
    expiryMonth: a.expiryMonth,
    expiryYear: a.expiryYear,
    paymentMethod: a.paymentMethod,
    payerEmail: a.payerEmail,
    payerReference: a.payerReference,
    isVirtual: a.isVirtual,
    isActive: a.isActive,
    inactiveReason: a.inactiveReason,
  };
}

function bookingBody(b: Booking, langs: readonly string[], expand: ReadonlySet<string>) {
  const reservations = db.reservations.getMany(b.reservationIds);
  const paymentAccount = b.paymentAccountId ? db.paymentAccounts.get(b.paymentAccountId) : undefined;
  const byProperty = new Map<string, { total: number; balance: number; currency: string }>();
  for (const r of reservations) {
    const entry = byProperty.get(r.propertyId) ?? { total: 0, balance: 0, currency: r.currency };
    entry.total += totalGrossOf(r).amount;
    entry.balance += balanceOf(r).amount;
    byProperty.set(r.propertyId, entry);
  }
  return {
    id: b.id,
    groupId: b.groupId,
    booker: b.booker,
    paymentAccount: paymentAccount ? paymentAccountBody(paymentAccount) : undefined,
    hasActivePaymentAccount: !!paymentAccount?.isActive,
    registeredCard: b.registeredCard,
    comment: b.comment,
    bookerComment: b.bookerComment,
    created: b.created,
    modified: b.updated,
    propertyValues: [...byProperty.entries()].map(([propertyId, v]) => ({
      property: embeddedProperty(propertyId, langs),
      totalGrossAmount: money(v.total, v.currency),
      balance: money(v.balance, v.currency),
    })),
    reservations: reservations.map((r) => bookingReservationBody(r, langs, expand)),
  };
}

function bookingReservationBody(r: Reservation, langs: readonly string[], expand: ReadonlySet<string>) {
  return {
    id: r.id,
    status: r.status,
    externalCode: r.externalCode,
    channelCode: r.channelCode,
    source: r.source,
    arrival: r.arrival,
    departure: r.departure,
    adults: r.adults,
    childrenAges: r.childrenAges.length ? r.childrenAges : undefined,
    totalGrossAmount: totalGrossOf(r),
    property: embeddedProperty(r.propertyId, langs),
    ratePlan: embeddedRatePlan(r.ratePlanId, langs),
    unitGroup: embeddedUnitGroup(r.unitGroupId, langs),
    services: expand.has('services') ? r.services.map((s) => reservationServiceBody(s, langs)) : undefined,
    guestComment: r.guestComment,
    cancellationFee: {
      id: r.cancellationFee.id,
      code: r.cancellationFee.code,
      name: resolveLocalized(r.cancellationFee.name, langs),
      description: undefined,
      dueDateTime: r.cancellationFee.dueDateTime,
      fee: r.cancellationFee.fee,
    },
    noShowFee: {
      id: r.noShowFee.id,
      code: r.noShowFee.code,
      name: resolveLocalized(r.noShowFee.name, langs),
      description: undefined,
      fee: r.noShowFee.fee,
    },
    company: embeddedCompany(r.companyId),
    isPreCheckedIn: r.isPreCheckedIn,
    isOpenForCharges: r.status === 'InHouse' || r.status === 'Confirmed',
    externalReferences: r.externalReferences,
  };
}

/* ---------------------------------------------------------------- offers */

api.op('BookingOffersGet', (req, res) => {
  const property = getProperty(requiredStringParam(req, 'propertyId'));
  const arrival = requiredDateParam(req, 'arrival');
  const departure = requiredDateParam(req, 'departure');
  const adults = intParam(req, 'adults', 1);
  const childrenAges = arrayParam(req, 'childrenAges').map(Number);
  const includeUnavailable = boolParam(req, 'includeUnavailable') ?? false;
  const unitGroupIds = arrayParam(req, 'unitGroupIds');
  const unitGroupTypes = arrayParam(req, 'unitGroupTypes');
  const timeSliceTemplate = stringParam(req, 'timeSliceTemplate');
  const timeSliceDefinitionIds = arrayParam(req, 'timeSliceDefinitionIds');
  const channelCode = stringParam(req, 'channelCode');
  const promoCode = stringParam(req, 'promoCode');
  const corporateCode = stringParam(req, 'corporateCode');

  if (diffDays(arrival, departure) < 1) {
    throw unprocessable('`departure` must be after `arrival`.');
  }

  const langs = languagesOf(arrayParam(req, 'languages'), property.id);
  const snapshot = new AvailabilitySnapshot(property, arrival, departure);

  const plans = db.ratePlans.all({ propertyId: property.id }).filter((plan) => {
    if (plan.isArchived) return false;
    if (unitGroupIds.length && !unitGroupIds.includes(plan.unitGroupId)) return false;
    if (unitGroupTypes.length) {
      const g = db.unitGroups.get(plan.unitGroupId);
      if (!g || !unitGroupTypes.includes(g.type)) return false;
    }
    if (timeSliceDefinitionIds.length && !timeSliceDefinitionIds.includes(plan.timeSliceDefinitionId)) return false;
    if (timeSliceTemplate) {
      const t = db.timeSliceDefinitions.get(plan.timeSliceDefinitionId);
      if (!t || t.template !== timeSliceTemplate) return false;
    }
    // Promo-coded plans are hidden unless the matching code is supplied.
    if (plan.promoCodes.length && (!promoCode || !plan.promoCodes.includes(promoCode))) return false;
    // Corporate plans require the corporate code or the company.
    if (plan.companies.length && !corporateCode) return false;
    if (corporateCode && plan.companies.length
      && !plan.companies.some((c) => c.corporateCode === corporateCode)) return false;
    return true;
  });

  const offers = plans
    .map((plan) => buildOffer(plan, {
      property, arrival, departure, adults, childrenAges, channelCode, promoCode, corporateCode, snapshot, langs,
    }))
    .filter((o) => includeUnavailable || (o.availableUnits > 0 && o.validationMessages.length === 0))
    .sort((a, b) => a.totalGrossAmount.amount - b.totalGrossAmount.amount);

  if (!offers.length) {
    res.status(200).json({ property: embeddedProperty(property.id, langs), offers: [] });
    return;
  }
  res.json({ property: embeddedProperty(property.id, langs), offers });
});

interface OfferContext {
  property: ReturnType<typeof getProperty>;
  arrival: string;
  departure: string;
  adults: number;
  childrenAges: number[];
  channelCode?: string;
  promoCode?: string;
  corporateCode?: string;
  snapshot: AvailabilitySnapshot;
  langs: readonly string[];
  overridePrices?: Map<string, number>;
}

function buildOffer(plan: RatePlan, ctx: OfferContext) {
  const priced = priceStay({
    property: ctx.property,
    ratePlan: plan,
    arrival: ctx.arrival,
    departure: ctx.departure,
    adults: ctx.adults,
    childrenAges: ctx.childrenAges,
    channelCode: ctx.channelCode,
    promoCode: ctx.promoCode,
    corporateCode: ctx.corporateCode,
    overridePrices: ctx.overridePrices,
  });

  const group = db.unitGroups.get(plan.unitGroupId);
  const availability = group
    ? ctx.snapshot.dates.map((d) => ctx.snapshot.forGroup(group, d))
    : [];
  const availableUnits = availability.length
    ? Math.max(0, Math.min(...availability.map((a) => a.availableCount)))
    : 0;

  const messages = [...priced.validationMessages];
  if (availableUnits === 0 && !messages.some((m) => m.code === 'UnitGroupFullyBooked')) {
    messages.push({
      code: 'UnitGroupFullyBooked',
      message: `No units are available in '${plan.unitGroupId}' for the requested dates.`,
    });
  }

  const company = ctx.corporateCode
    ? plan.companies.find((c) => c.corporateCode === ctx.corporateCode)
    : undefined;

  return {
    arrival: priced.arrivalDateTime,
    departure: priced.departureDateTime,
    unitGroup: group
      ? {
        id: group.id,
        code: group.code,
        name: resolveLocalized(group.name, ctx.langs),
        description: resolveLocalized(group.description, ctx.langs),
        maxPersons: group.maxPersons,
        rank: group.rank,
        type: group.type,
      }
      : undefined,
    minGuaranteeType: plan.minGuaranteeType,
    availableUnits,
    ratePlan: embeddedRatePlan(plan.id, ctx.langs),
    totalGrossAmount: priced.totalGrossAmount,
    cancellationFee: {
      code: priced.cancellationFee.policy?.code ?? '',
      name: resolveLocalized(priced.cancellationFee.policy?.name, ctx.langs) ?? '',
      description: resolveLocalized(priced.cancellationFee.policy?.description, ctx.langs) ?? '',
      dueDateTime: priced.cancellationFee.dueDateTime ?? priced.arrivalDateTime,
      fee: priced.cancellationFee.fee,
    },
    noShowFee: {
      code: priced.noShowFee.policy?.code ?? '',
      name: resolveLocalized(priced.noShowFee.policy?.name, ctx.langs) ?? '',
      description: resolveLocalized(priced.noShowFee.policy?.description, ctx.langs) ?? '',
      fee: priced.noShowFee.fee,
    },
    timeSlices: priced.timeSlices.map((s, i) => ({
      from: s.from,
      to: s.to,
      availableUnits: availability[i]?.availableCount ?? availableUnits,
      baseAmount: s.baseAmount,
      totalGrossAmount: s.totalGrossAmount,
      includedServices: s.includedServices.map((inc) => ({
        service: embeddedService(inc.serviceId, ctx.langs),
        totalAmount: inc.amount,
      })),
    })),
    services: priced.services.map((s) => serviceOfferBody(s, ctx.langs)),
    taxDetails: priced.taxDetails,
    validationMessages: messages,
    companyId: company?.companyId,
    corporateCode: company?.corporateCode,
    isCorporate: !!company,
    prePaymentAmount: priced.prePaymentAmount,
    cityTaxes: priced.cityTaxes.map((t) => ({
      id: t.cityTaxId,
      code: t.code,
      name: t.name,
      totalGrossAmount: t.totalGrossAmount,
      dates: t.dates.map((d) => ({ serviceDate: d.serviceDate, amount: d.amount })),
    })),
  };
}

function serviceOfferBody(s: ReturnType<typeof priceStay>['services'][number], langs: readonly string[]) {
  const service = db.services.get(s.serviceId);
  return {
    service: service
      ? {
        id: service.id,
        code: service.code,
        name: resolveLocalized(service.name, langs),
        description: resolveLocalized(service.description, langs),
        pricingUnit: service.pricingUnit,
        defaultGrossPrice: money(service.defaultGrossPrice, service.currency),
      }
      : { id: s.serviceId },
    count: s.count,
    totalAmount: s.totalAmount,
    prePaymentAmount: money(0, s.totalAmount.currency),
    dates: s.dates.map((d) => ({
      serviceDate: d.serviceDate,
      amount: d.amount,
      isDefaultDate: d.isDefaultDate,
      isMandatory: d.isMandatory,
    })),
  };
}

api.op('BookingRate-plan-offersGet', (req, res) => {
  const plan = getRatePlan(requiredStringParam(req, 'ratePlanId'));
  const property = getProperty(plan.propertyId);
  const arrival = requiredDateParam(req, 'arrival');
  const departure = requiredDateParam(req, 'departure');
  const adults = intParam(req, 'adults', 1);
  const childrenAges = arrayParam(req, 'childrenAges').map(Number);
  const includeUnavailable = boolParam(req, 'includeUnavailable') ?? false;
  const langs = languagesOf(arrayParam(req, 'languages'), property.id);

  // `overridePrices` lets a caller quote a manual price per night.
  const overrides = arrayParam(req, 'overridePrices').map(Number);
  const overridePrices = new Map<string, number>();
  nightsBetween(arrival, departure).forEach((date, i) => {
    if (Number.isFinite(overrides[i])) overridePrices.set(date, overrides[i]!);
  });

  const snapshot = new AvailabilitySnapshot(property, arrival, departure);
  const offer = buildOffer(plan, {
    property, arrival, departure, adults, childrenAges,
    channelCode: stringParam(req, 'channelCode'),
    snapshot, langs,
    overridePrices: overridePrices.size ? overridePrices : undefined,
  });
  const offers = includeUnavailable || (offer.availableUnits > 0 && offer.validationMessages.length === 0)
    ? [offer]
    : [];
  res.json({ property: embeddedProperty(property.id, langs), offers });
});

api.op('BookingService-offersGet', (req, res) => {
  const plan = getRatePlan(requiredStringParam(req, 'ratePlanId'));
  const property = getProperty(plan.propertyId);
  const arrival = requiredDateParam(req, 'arrival');
  const departure = requiredDateParam(req, 'departure');
  const adults = intParam(req, 'adults', 1);
  const childrenAges = arrayParam(req, 'childrenAges').map(Number);
  const onlyDefaultDates = boolParam(req, 'onlyDefaultDates') ?? false;
  const channelCode = stringParam(req, 'channelCode');
  const langs = languagesOf(arrayParam(req, 'languages'), property.id);

  const services = availableServicesFor(plan, channelCode);
  const offers = services
    .map((service) => buildServiceOffer(service, plan, {
      property, arrival, departure, adults, childrenAges, onlyDefaultDates, langs,
    }))
    .filter((o): o is NonNullable<typeof o> => !!o);
  res.json({ services: offers });
});

function availableServicesFor(plan: RatePlan, channelCode?: string): Service[] {
  return db.services.all({ propertyId: plan.propertyId }).filter((s) => {
    if (s.channelCodes.length && channelCode && !s.channelCodes.includes(channelCode as any)) return false;
    return true;
  });
}

function buildServiceOffer(
  service: Service,
  plan: RatePlan,
  ctx: {
    property: ReturnType<typeof getProperty>;
    arrival: string;
    departure: string;
    adults: number;
    childrenAges: number[];
    onlyDefaultDates: boolean;
    langs: readonly string[];
  },
) {
  const included = plan.includedServices.find((i) => i.serviceId === service.id);
  const grossPrice = included?.grossPrice ?? service.defaultGrossPrice;
  const count = serviceCount(service, ctx.adults, ctx.childrenAges);
  if (count === 0) return undefined;

  const defaults = serviceDates(service, ctx.arrival, ctx.departure);
  const dates = ctx.onlyDefaultDates
    ? defaults
    : datesInclusive(ctx.arrival, ctx.departure);
  if (!dates.length) return undefined;

  const currency = ctx.property.currencyCode;
  const priced = dates.map((date) => {
    const config = configFor(service.accountingConfigs, date, 'Other');
    return {
      serviceDate: date,
      amount: grossToAmount(round(grossPrice * count, currency), config.vatType, currency),
      isDefaultDate: defaults.includes(date),
      isMandatory: included?.pricingMode === 'Included',
      availableCount: service.availability.quantity,
    };
  });
  const totalGross = priced
    .filter((p) => p.isDefaultDate)
    .reduce((s, p) => s + p.amount.grossAmount, 0);

  return {
    service: {
      id: service.id,
      code: service.code,
      name: resolveLocalized(service.name, ctx.langs),
      description: resolveLocalized(service.description, ctx.langs),
      pricingUnit: service.pricingUnit,
      defaultGrossPrice: money(service.defaultGrossPrice, service.currency),
    },
    count,
    availableCount: service.availability.quantity,
    totalAmount: grossToAmount(totalGross, priced[0]!.amount.vatType, currency),
    prePaymentAmount: money(0, currency),
    dates: priced,
  };
}

api.op('BookingOffer-indexGet', (req, res) => {
  const plan = getRatePlan(requiredStringParam(req, 'ratePlanId'));
  const property = getProperty(plan.propertyId);
  const from = requiredDateParam(req, 'from');
  const to = requiredDateParam(req, 'to');
  requiredStringParam(req, 'channelCode');
  const page = paging(req);
  const langs = languagesOf(arrayParam(req, 'languages'), property.id);
  const tsd = db.timeSliceDefinitions.get(plan.timeSliceDefinitionId);
  const checkIn = tsd?.checkInTime ?? property.defaultCheckInTime;
  const checkOut = tsd?.checkOutTime ?? property.defaultCheckOutTime;

  const snapshot = new AvailabilitySnapshot(property, from, addDays(to, 1));
  const group = db.unitGroups.get(plan.unitGroupId);

  const all = datesInclusive(from, to).map((date) => {
    const price = resolvePrice(plan, date);
    const restrictions = resolveRestrictions(plan, date) ?? openRestrictions();
    const availability = group ? snapshot.forGroup(group, date) : undefined;
    return {
      from: atLocalTime(date, checkIn, property.timeZone),
      to: atLocalTime(addDays(date, 1), checkOut, property.timeZone),
      serviceDate: date,
      ratePlan: embeddedRatePlan(plan.id, langs),
      unitGroup: embeddedUnitGroup(plan.unitGroupId, langs),
      baseAmount: price === undefined
        ? undefined
        : grossToAmount(price, configFor(plan.accountingConfigs, date, 'Accommodation').vatType, property.currencyCode),
      totalGrossAmount: price === undefined ? undefined : money(price, property.currencyCode),
      availableUnits: availability?.availableCount ?? 0,
      restrictions,
    };
  });

  sendList(res, 'timeSlices', all.slice(page.offset, page.offset + page.pageSize), all.length);
});

api.op('BookingReservationsByIdOffersGet', (req, res) => {
  const r = getReservation(req.params.id!);
  const property = getProperty(r.propertyId);
  const arrival = dateParam(req, 'arrival') ?? r.arrivalDate;
  const departure = dateParam(req, 'departure') ?? r.departureDate;
  const adults = optionalIntParam(req, 'adults') ?? r.adults;
  const childrenAges = arrayParam(req, 'childrenAges').length
    ? arrayParam(req, 'childrenAges').map(Number)
    : r.childrenAges;
  const includeUnavailable = boolParam(req, 'includeUnavailable') ?? false;
  const unitGroupIds = arrayParam(req, 'unitGroupIds');
  const langs = languagesOf(arrayParam(req, 'languages'), property.id);
  const snapshot = new AvailabilitySnapshot(property, arrival, departure);

  const plans = db.ratePlans.all({ propertyId: property.id })
    .filter((p) => !p.isArchived && (!unitGroupIds.length || unitGroupIds.includes(p.unitGroupId)));

  const offers = plans
    .map((plan) => {
      const offer = buildOffer(plan, {
        property, arrival, departure, adults, childrenAges,
        channelCode: stringParam(req, 'channelCode') ?? r.channelCode,
        promoCode: stringParam(req, 'promoCode') ?? r.promoCode,
        corporateCode: stringParam(req, 'corporateCode') ?? r.corporateCode,
        snapshot, langs,
      });
      // The reservation already holds a unit, so its own group has one more
      // available than a fresh enquiry would see.
      if (plan.unitGroupId === r.unitGroupId && isActive(r)) {
        offer.availableUnits += 1;
        offer.timeSlices.forEach((t) => { t.availableUnits += 1; });
      }
      return offer;
    })
    .filter((o) => includeUnavailable || (o.availableUnits > 0 && o.validationMessages.length === 0));

  res.json({ property: embeddedProperty(property.id, langs), offers });
});

api.op('BookingReservationsByIdService-offersGet', (req, res) => {
  const r = getReservation(req.params.id!);
  const property = getProperty(r.propertyId);
  const plan = getRatePlan(r.ratePlanId);
  const langs = languagesOf(arrayParam(req, 'languages'), property.id);
  const onlyDefaultDates = boolParam(req, 'onlyDefaultDates') ?? false;
  const channelCode = stringParam(req, 'channelCode') ?? r.channelCode;

  const offers = availableServicesFor(plan, channelCode)
    .map((service) => buildServiceOffer(service, plan, {
      property,
      arrival: r.arrivalDate,
      departure: r.departureDate,
      adults: r.adults,
      childrenAges: r.childrenAges,
      onlyDefaultDates,
      langs,
    }))
    .filter((o): o is NonNullable<typeof o> => !!o);
  res.json({ services: offers });
});

/* -------------------------------------------------------------- bookings */

api.op('BookingBookingsPost', (req, res) => createBooking(req, res, false));
api.op('BookingBookings$forcePost', (req, res) => createBooking(req, res, true));

function createBooking(req: Request, res: Response, force: boolean): void {
  const body = req.body as Record<string, any>;
  const result = transact(() => {
    const bookingId = newBookingId();
    const booking: Booking = {
      id: bookingId,
      booker: body.booker,
      comment: body.comment,
      bookerComment: body.bookerComment,
      registeredCard: body.registeredCard,
      created: nowIso(),
      updated: nowIso(),
      reservationIds: [],
      nextReservationOrdinal: 1,
      transactionReference: body.transactionReference,
    };
    if (body.paymentAccount) {
      booking.paymentAccountId = createPaymentAccount(body.paymentAccount, { bookingId }).id;
    }
    db.bookings.put(booking);
    const created = addReservations(booking, body.reservations ?? [], force);
    return { booking, created };
  });
  sendCreated(res, `/booking/v1/bookings/${result.booking.id}`, {
    id: result.booking.id,
    reservationIds: result.created.map((r) => ({ id: r.id })),
  });
}

/**
 * Turn `CreateReservationModel`s into persisted reservations, quoting each
 * one, checking inventory and opening the main folio.
 */
function addReservations(booking: Booking, inputs: any[], force: boolean): Reservation[] {
  if (!inputs.length) throw unprocessable('At least one reservation is required.');
  const created: Reservation[] = [];

  for (const raw of inputs) {
    const input = toCreateInput(raw);
    const q = quote(input);

    const availabilityMessages = checkAvailability(q, input.blockId);
    const blockingMessages = [...q.priced.validationMessages, ...availabilityMessages];
    if (!force) {
      const fatal = blockingMessages.filter((m) =>
        m.code === 'UnitGroupFullyBooked' || m.code === 'RatesNotSet'
        || m.code === 'BlockFullyBooked' || m.code === 'UnitGroupCapacityExceeded');
      if (fatal.length) throw unprocessable(fatal.map((m) => m.message));
    }

    const reservationId = nextReservationId(booking);
    const reservation = materialize(q, input, { reservationId, bookingId: booking.id }, blockingMessages.map((m) => ({
      category: m.code === 'UnitGroupFullyBooked' || m.code === 'BlockFullyBooked'
        ? 'OfferNotAvailable'
        : 'OfferNotAvailable',
      code: m.code,
      message: m.message,
    })));

    db.reservations.put(reservation);
    booking.reservationIds.push(reservation.id);
    ensureMainFolio(reservation);

    if (input.blockId) pickUpFromBlock(input.blockId, reservation);
    if (input.groupId) {
      const group = db.groups.get(input.groupId);
      if (group && !group.reservationIds.includes(reservation.id)) {
        group.reservationIds.push(reservation.id);
        db.groups.put(group);
      }
    }

    logReservation(reservation.id, {
      propertyId: reservation.propertyId,
      action: 'Created',
      message: `Reservation ${reservation.id} created for ${reservation.arrivalDate} to ${reservation.departureDate}.`,
    });
    created.push(reservation);
  }

  booking.updated = nowIso();
  db.bookings.put(booking);
  return created;
}

function toCreateInput(raw: Record<string, any>): CreateReservationInput {
  return {
    arrival: raw.arrival,
    departure: raw.departure,
    adults: raw.adults,
    childrenAges: raw.childrenAges,
    comment: raw.comment,
    guestComment: raw.guestComment,
    externalCode: raw.externalCode,
    channelCode: raw.channelCode,
    source: raw.source,
    primaryGuest: raw.primaryGuest as Person,
    additionalGuests: raw.additionalGuests,
    guaranteeType: raw.guaranteeType,
    travelPurpose: raw.travelPurpose,
    timeSlices: raw.timeSlices,
    services: raw.services,
    companyId: raw.companyId,
    corporateCode: raw.corporateCode,
    prePaymentAmount: raw.prePaymentAmount,
    commission: raw.commission,
    promoCode: raw.promoCode,
    externalReferences: raw.externalReferences,
    blockId: raw.blockId,
    groupId: raw.groupId,
    marketSegmentId: raw.marketSegmentId,
  };
}

/** Consume one unit per night from a block's allotment. */
function pickUpFromBlock(blockId: string, reservation: Reservation): void {
  const block = db.blocks.get(blockId);
  if (!block) return;
  for (const slice of block.timeSlices) {
    if (slice.serviceDate < reservation.arrivalDate || slice.serviceDate >= reservation.departureDate) continue;
    slice.pickedUnits = Math.min(slice.blockedUnits, slice.pickedUnits + 1);
  }
  block.updated = nowIso();
  db.blocks.put(block);
}

/** Release a reservation's pickup back to the block. */
function releaseToBlock(blockId: string, reservation: Reservation): void {
  const block = db.blocks.get(blockId);
  if (!block) return;
  for (const slice of block.timeSlices) {
    if (slice.serviceDate < reservation.arrivalDate || slice.serviceDate >= reservation.departureDate) continue;
    slice.pickedUnits = Math.max(0, slice.pickedUnits - 1);
  }
  block.updated = nowIso();
  db.blocks.put(block);
}

api.op('BookingBookingsByIdReservationsPost', (req, res) => addToBooking(req, res, false));
api.op('BookingBookingsByIdReservations$forcePost', (req, res) => addToBooking(req, res, true));

function addToBooking(req: Request, res: Response, force: boolean): void {
  const booking = getBooking(req.params.id!);
  const body = req.body as { reservations: any[] };
  const created = transact(() => addReservations(booking, body.reservations ?? [], force));
  res.status(201).json({ reservationIds: created.map((r) => ({ id: r.id })) });
}

api.op('BookingBookingsGet', (req, res) => {
  const reservationId = stringParam(req, 'reservationId');
  const groupId = stringParam(req, 'groupId');
  const bookingIds = arrayParam(req, 'bookingIds');
  const channelCodes = arrayParam(req, 'channelCode');
  const externalCode = stringParam(req, 'externalCode');
  const textSearch = stringParam(req, 'textSearch')?.toLowerCase();
  const hasActivePaymentAccount = boolParam(req, 'hasActivePaymentAccount');
  const expand = new Set(arrayParam(req, 'expand'));
  const langs = arrayParam(req, 'languages');
  const page = paging(req);

  const { items, count } = db.bookings.query({
    filter: (b) => {
      if (bookingIds.length && !bookingIds.includes(b.id)) return false;
      if (groupId && b.groupId !== groupId) return false;
      if (reservationId && !b.reservationIds.includes(reservationId)) return false;
      const reservations = db.reservations.getMany(b.reservationIds);
      if (channelCodes.length && !reservations.some((r) => channelCodes.includes(r.channelCode))) return false;
      if (externalCode && !reservations.some((r) => r.externalCode === externalCode)) return false;
      if (hasActivePaymentAccount !== undefined) {
        const account = b.paymentAccountId ? db.paymentAccounts.get(b.paymentAccountId) : undefined;
        if (!!account?.isActive !== hasActivePaymentAccount) return false;
      }
      if (textSearch) {
        const haystack = [
          b.id, b.booker?.firstName, b.booker?.lastName, b.booker?.email,
          ...reservations.map((r) => `${r.id} ${r.primaryGuest?.lastName ?? ''} ${r.externalCode ?? ''}`),
        ].filter(Boolean).join(' ').toLowerCase();
        if (!haystack.includes(textSearch)) return false;
      }
      return true;
    },
    sort: (a, b) => b.created.localeCompare(a.created),
    offset: page.offset,
    limit: page.pageSize,
  });
  sendList(res, 'bookings', items.map((b) => bookingBody(b, langs, expand)), count);
});

api.op('BookingBookingsByIdGet', (req, res) => {
  const b = getBooking(req.params.id!);
  res.json(bookingBody(b, arrayParam(req, 'languages'), new Set(arrayParam(req, 'expand'))));
});

api.op('BookingBookingsByIdPatch', (req, res) => {
  const b = getBooking(req.params.id!);
  const ops = req.body as PatchOperation[];
  rejectImmutablePaths(ops, ['/id', '/created', '/reservations']);
  const view = {
    booker: b.booker,
    comment: b.comment,
    bookerComment: b.bookerComment,
    paymentAccount: b.paymentAccountId ? paymentAccountBody(db.paymentAccounts.get(b.paymentAccountId)!) : undefined,
    registeredCard: b.registeredCard,
  };
  const patched = applyPatch(view, ops) as typeof view;
  b.booker = patched.booker;
  b.comment = patched.comment;
  b.bookerComment = patched.bookerComment;
  b.registeredCard = patched.registeredCard;
  if (patched.paymentAccount) {
    const account = b.paymentAccountId ? db.paymentAccounts.get(b.paymentAccountId) : undefined;
    if (account) {
      Object.assign(account, patched.paymentAccount, { updated: nowIso() });
      db.paymentAccounts.put(account);
    } else {
      b.paymentAccountId = createPaymentAccount(patched.paymentAccount, { bookingId: b.id }).id;
    }
  }
  b.updated = nowIso();
  db.bookings.put(b);
  sendNoContent(res);
});

/* ---------------------------------------------------------- reservations */

function reservationFilter(req: Request): (r: Reservation) => boolean {
  const bookingId = stringParam(req, 'bookingId');
  const propertyIds = arrayParam(req, 'propertyIds');
  const ratePlanIds = arrayParam(req, 'ratePlanIds');
  const companyIds = arrayParam(req, 'companyIds');
  const unitIds = arrayParam(req, 'unitIds');
  const unitGroupIds = arrayParam(req, 'unitGroupIds');
  const unitGroupTypes = arrayParam(req, 'unitGroupTypes');
  const blockIds = arrayParam(req, 'blockIds');
  const marketSegmentIds = arrayParam(req, 'marketSegmentIds');
  const statuses = arrayParam(req, 'status');
  const dateFilter = stringParam(req, 'dateFilter') ?? 'Arrival';
  const from = dateParam(req, 'from');
  const to = dateParam(req, 'to');
  const channelCodes = arrayParam(req, 'channelCode');
  const sources = arrayParam(req, 'sources');
  const validationCategories = arrayParam(req, 'validationMessageCategory');
  const externalCode = stringParam(req, 'externalCode');
  const textSearch = stringParam(req, 'textSearch')?.toLowerCase();
  const balanceFilters = arrayParam(req, 'balanceFilter');
  const allFoliosHaveInvoice = boolParam(req, 'allFoliosHaveInvoice');
  const isPreCheckedIn = boolParam(req, 'isPreCheckedIn');
  const hasActivePaymentAccount = boolParam(req, 'hasActivePaymentAccount');
  const externalReferences = arrayParam(req, 'externalReferences');

  return (r) => {
    if (bookingId && r.bookingId !== bookingId) return false;
    if (propertyIds.length && !propertyIds.includes(r.propertyId)) return false;
    if (ratePlanIds.length && !ratePlanIds.includes(r.ratePlanId)) return false;
    if (companyIds.length && (!r.companyId || !companyIds.includes(r.companyId))) return false;
    if (unitIds.length && (!r.unitId || !unitIds.includes(r.unitId))) return false;
    if (unitGroupIds.length && !unitGroupIds.includes(r.unitGroupId)) return false;
    if (blockIds.length && (!r.blockId || !blockIds.includes(r.blockId))) return false;
    if (marketSegmentIds.length && (!r.marketSegmentId || !marketSegmentIds.includes(r.marketSegmentId))) return false;
    if (statuses.length && !statuses.includes(r.status)) return false;
    if (channelCodes.length && !channelCodes.includes(r.channelCode)) return false;
    if (sources.length && (!r.source || !sources.includes(r.source))) return false;
    if (externalCode && r.externalCode !== externalCode) return false;
    if (isPreCheckedIn !== undefined && r.isPreCheckedIn !== isPreCheckedIn) return false;
    if (unitGroupTypes.length) {
      const g = db.unitGroups.get(r.unitGroupId);
      if (!g || !unitGroupTypes.includes(g.type)) return false;
    }
    if (validationCategories.length
      && !r.validationMessages.some((m) => validationCategories.includes(m.category))) return false;
    if (externalReferences.length) {
      const refs = Object.values(r.externalReferences ?? {});
      if (!externalReferences.some((x) => refs.includes(x))) return false;
    }
    if (hasActivePaymentAccount !== undefined) {
      const booking = db.bookings.get(r.bookingId);
      const account = booking?.paymentAccountId ? db.paymentAccounts.get(booking.paymentAccountId) : undefined;
      if (!!account?.isActive !== hasActivePaymentAccount) return false;
    }
    if (allFoliosHaveInvoice !== undefined) {
      const folios = db.folios.all({ reservationId: r.id });
      const all = folios.length > 0 && folios.every((f) => !!f.invoiceId);
      if (all !== allFoliosHaveInvoice) return false;
    }
    if (balanceFilters.length) {
      const balance = balanceOf(r).amount;
      const matches = balanceFilters.some((f) =>
        (f === 'Zero' && Math.abs(balance) < 1e-9)
        || (f === 'Positive' && balance > 0)
        || (f === 'Negative' && balance < 0));
      if (!matches) return false;
    }
    if (textSearch) {
      const haystack = [
        r.id, r.bookingId, r.externalCode, r.primaryGuest?.firstName, r.primaryGuest?.lastName,
        r.primaryGuest?.email, r.unitId, r.comment,
      ].filter(Boolean).join(' ').toLowerCase();
      if (!haystack.includes(textSearch)) return false;
    }
    if (from || to) return matchesDateFilter(r, dateFilter, from, to);
    return true;
  };
}

/**
 * apaleo's `dateFilter` selects which of the reservation's dates the
 * `from`/`to` window applies to.
 */
function matchesDateFilter(r: Reservation, filter: string, from?: string, to?: string): boolean {
  const within = (value: string | undefined) => {
    if (!value) return false;
    const date = value.length > 10 ? value.slice(0, 10) : value;
    if (from && date < from) return false;
    if (to && date > to) return false;
    return true;
  };
  switch (filter) {
    case 'Departure':
      return within(r.departureDate);
    case 'Stay': {
      // Any overlap between the stay and the window.
      const start = from ?? '0000-01-01';
      const end = to ?? '9999-12-31';
      return r.arrivalDate <= end && start < r.departureDate;
    }
    case 'Creation':
      return within(r.created);
    case 'Modification':
      return within(r.updated);
    case 'Cancellation':
      return within(r.cancellationTime);
    case 'ArrivalAndCheckIn':
      return within(r.arrivalDate) || within(r.checkInTime);
    case 'DepartureAndCheckOut':
      return within(r.departureDate) || within(r.checkOutTime);
    case 'Arrival':
    default:
      return within(r.arrivalDate);
  }
}

const SORTERS: Record<string, (a: Reservation, b: Reservation) => number> = {
  'arrival:asc': (a, b) => a.arrivalDate.localeCompare(b.arrivalDate),
  'arrival:desc': (a, b) => b.arrivalDate.localeCompare(a.arrivalDate),
  'departure:asc': (a, b) => a.departureDate.localeCompare(b.departureDate),
  'departure:desc': (a, b) => b.departureDate.localeCompare(a.departureDate),
  'created:asc': (a, b) => a.created.localeCompare(b.created),
  'created:desc': (a, b) => b.created.localeCompare(a.created),
  'modified:asc': (a, b) => a.updated.localeCompare(b.updated),
  'modified:desc': (a, b) => b.updated.localeCompare(a.updated),
  'id:asc': (a, b) => a.id.localeCompare(b.id),
  'id:desc': (a, b) => b.id.localeCompare(a.id),
  'lastName:asc': (a, b) => (a.primaryGuest?.lastName ?? '').localeCompare(b.primaryGuest?.lastName ?? ''),
  'lastName:desc': (a, b) => (b.primaryGuest?.lastName ?? '').localeCompare(a.primaryGuest?.lastName ?? ''),
};

function sorterFor(req: Request): (a: Reservation, b: Reservation) => number {
  const keys = arrayParam(req, 'sort').filter((k) => SORTERS[k]);
  if (!keys.length) return SORTERS['arrival:asc']!;
  return (a, b) => {
    for (const key of keys) {
      const result = SORTERS[key]!(a, b);
      if (result !== 0) return result;
    }
    return a.id.localeCompare(b.id);
  };
}

api.op('BookingReservationsGet', (req, res) => {
  const langs = arrayParam(req, 'languages');
  const expand = new Set(arrayParam(req, 'expand'));
  const page = paging(req);
  const { items, count } = db.reservations.query({
    filter: reservationFilter(req),
    sort: sorterFor(req),
    offset: page.offset,
    limit: page.pageSize,
  });
  sendList(res, 'reservations', items.map((r) => reservationBody(r, langs, expand)), count);
});

api.op('BookingReservations$countGet', (req, res) => {
  res.json({ count: db.reservations.all().filter(reservationFilter(req)).length });
});

api.op('BookingReservationsByIdGet', (req, res) => {
  const r = getReservation(req.params.id!);
  // The detail endpoint always includes the nested collections.
  const expand = new Set([...arrayParam(req, 'expand'), 'timeSlices', 'services', 'booker']);
  res.json(reservationBody(r, languagesOf(arrayParam(req, 'languages'), r.propertyId), expand));
});

api.op('BookingReservationsByIdPatch', (req, res) => {
  const r = getReservation(req.params.id!);
  const ops = req.body as PatchOperation[];
  rejectImmutablePaths(ops, [
    '/id', '/bookingId', '/status', '/property', '/created', '/arrival', '/departure',
    '/timeSlices', '/balance', '/totalGrossAmount',
  ]);
  const view = {
    comment: r.comment,
    guestComment: r.guestComment,
    externalCode: r.externalCode,
    source: r.source,
    primaryGuest: r.primaryGuest,
    additionalGuests: r.additionalGuests,
    travelPurpose: r.travelPurpose,
    guaranteeType: r.guaranteeType,
    companyId: r.companyId,
    corporateCode: r.corporateCode,
    marketSegmentId: r.marketSegmentId,
    isPreCheckedIn: r.isPreCheckedIn,
    externalReferences: r.externalReferences,
    channelCode: r.channelCode,
  };
  const patched = applyPatch(view, ops) as typeof view;
  if (patched.companyId && !db.companies.exists(patched.companyId)) {
    throw unprocessable(`Company '${patched.companyId}' does not exist.`);
  }
  if (patched.marketSegmentId && !db.marketSegments.exists(patched.marketSegmentId)) {
    throw unprocessable(`Market segment '${patched.marketSegmentId}' does not exist.`);
  }
  Object.assign(r, patched, { updated: nowIso() });
  r.additionalGuests = patched.additionalGuests ?? [];
  db.reservations.put(r);
  logReservation(r.id, {
    propertyId: r.propertyId,
    action: 'Changed',
    message: `Reservation ${r.id} updated.`,
  });
  sendNoContent(res);
});

api.op('BookingReservationsByIdServicesGet', (req, res) => {
  const r = getReservation(req.params.id!);
  const langs = languagesOf(arrayParam(req, 'languages'), r.propertyId);
  sendList(res, 'services', r.services.map((s) => reservationServiceBody(s, langs)), r.services.length);
});

api.op('BookingReservationsByIdServicesDelete', (req, res) => {
  const r = getReservation(req.params.id!);
  const serviceId = requiredStringParam(req, 'serviceId');
  assertAction(r, 'RemoveService');
  const index = r.services.findIndex((s) => s.serviceId === serviceId);
  if (index === -1) throw notFound(`Service '${serviceId}' is not booked on reservation '${r.id}'.`);
  if (r.services[index]!.dates.some((d) => d.isMandatory)) {
    throw unprocessable(`Service '${serviceId}' is included in the rate plan and cannot be removed.`);
  }
  r.services.splice(index, 1);
  r.updated = nowIso();
  db.reservations.put(r);
  logReservation(r.id, {
    propertyId: r.propertyId,
    action: 'Changed',
    message: `Service ${serviceId} removed.`,
  });
  sendNoContent(res);
});

/* ------------------------------------------------------ reservation actions */

api.op('BookingReservation-actionsByIdAssign-unitPut', (req, res) => {
  const r = getReservation(req.params.id!);
  assertAction(r, 'AssignUnit');
  const conditions = arrayParam(req, 'unitConditions');
  const assigned = transact(() => {
    const unitId = autoAssignUnit(r, conditions.length ? conditions : undefined);
    if (unitId) db.reservations.put(r);
    return unitId;
  });
  if (!assigned) {
    throw conflict('No unit is available for the whole stay.');
  }
  sendNoContent(res);
});

api.op('BookingReservation-actionsByIdAssign-unitByUnitIdPut', (req, res) => {
  const r = getReservation(req.params.id!);
  assertAction(r, 'AssignUnit');
  transact(() => {
    assignUnit(r, req.params.unitId!);
    db.reservations.put(r);
  });
  sendNoContent(res);
});

api.op('BookingReservation-actionsByIdUnassign-unitsPut', (req, res) => {
  const r = getReservation(req.params.id!);
  assertAction(r, 'UnassignUnit');
  transact(() => {
    unassignUnits(r);
    db.reservations.put(r);
  });
  sendNoContent(res);
});

api.op('BookingReservation-actionsByIdLock-unitPut', (req, res) => {
  const r = getReservation(req.params.id!);
  assertAction(r, 'LockUnit');
  r.isUnitAssignmentLocked = true;
  r.updated = nowIso();
  db.reservations.put(r);
  logReservation(r.id, { propertyId: r.propertyId, action: 'UnitLocked', message: 'Unit assignment locked.' });
  sendNoContent(res);
});

api.op('BookingReservation-actionsByIdUnlock-unitPut', (req, res) => {
  const r = getReservation(req.params.id!);
  assertAction(r, 'UnlockUnit');
  r.isUnitAssignmentLocked = false;
  r.updated = nowIso();
  db.reservations.put(r);
  logReservation(r.id, { propertyId: r.propertyId, action: 'UnitUnlocked', message: 'Unit assignment unlocked.' });
  sendNoContent(res);
});

api.op('BookingReservation-actionsByIdCheckinPut', (req, res) => {
  const r = getReservation(req.params.id!);
  const withCityTax = boolParam(req, 'withCityTax');
  assertAction(r, 'CheckIn');
  transact(() => {
    if (withCityTax === false && r.hasCityTax) {
      r.hasCityTax = false;
      r.cityTaxes = [];
    }
    r.status = 'InHouse';
    r.checkInTime = nowIso();
    r.updated = r.checkInTime;
    db.reservations.put(r);

    // Mark the unit dirty; housekeeping picks it up from there.
    if (r.unitId) {
      const unit = db.units.get(r.unitId);
      if (unit) {
        unit.condition = 'Dirty';
        db.units.put(unit);
      }
    }
    // Post everything due up to today so the guest can see their folio.
    const property = getProperty(r.propertyId);
    postThrough(r, property.businessDate);
    logReservation(r.id, {
      propertyId: r.propertyId,
      action: 'CheckedIn',
      message: `Reservation ${r.id} checked in${r.unitId ? ` to unit ${r.unitId}` : ''}.`,
    });
  });
  sendNoContent(res);
});

api.op('BookingReservation-actionsByIdRevert-checkinPut', (req, res) => {
  const r = getReservation(req.params.id!);
  assertAction(r, 'CheckInRevert');
  transact(() => {
    r.status = 'Confirmed';
    r.checkInTime = undefined;
    r.updated = nowIso();
    db.reservations.put(r);
    logReservation(r.id, {
      propertyId: r.propertyId,
      action: 'CheckInReverted',
      message: `Check-in reverted for reservation ${r.id}.`,
    });
  });
  sendNoContent(res);
});

api.op('BookingReservation-actionsByIdCheckoutPut', (req, res) => {
  const r = getReservation(req.params.id!);
  assertAction(r, 'CheckOut');

  /**
   * Posting and settling are two separate steps on purpose.
   *
   * Everything still outstanding is posted first and committed: the guest
   * genuinely owes for those nights whether or not they can pay right now.
   * Only then is the balance checked. Doing both in one transaction would
   * roll the postings back with the error, leaving the front desk unable to
   * see the amount they need to collect.
   */
  transact(() => postAll(r));

  const folios = db.folios.all({ reservationId: r.id });
  const open = folios.filter((f) => !f.isClosed && Math.abs(folioTotals(f).balance.amount) > 1e-9);
  if (open.length) {
    const company = r.companyId ? db.companies.get(r.companyId) : undefined;
    // Settling on account is only allowed when the company is set up for it.
    if (!company?.canCheckOutOnAr) {
      throw unprocessable(open.map((f) =>
        `Folio '${f.id}' has an open balance of ${folioTotals(f).balance.amount.toFixed(2)} ${f.currency}.`));
    }
  }

  transact(() => {
    for (const folio of folios) {
      if (folio.isClosed) continue;
      const outstanding = folioTotals(folio).balance.amount;
      folio.isClosed = true;
      folio.closedAt = nowIso();
      folio.checkedOutOn = folio.closedAt;
      // An allowed on-account departure leaves the balance as a receivable.
      if (Math.abs(outstanding) > 1e-9) folio.checkedOutOnAccountsReceivable = true;
      db.folios.put(folio);
    }
    r.status = 'CheckedOut';
    r.checkOutTime = nowIso();
    r.updated = r.checkOutTime;
    db.reservations.put(r);
    if (r.unitId) {
      const unit = db.units.get(r.unitId);
      if (unit) {
        unit.condition = 'Dirty';
        db.units.put(unit);
      }
    }
    logReservation(r.id, {
      propertyId: r.propertyId,
      action: 'CheckedOut',
      message: `Reservation ${r.id} checked out.`,
    });
  });
  sendNoContent(res);
});

api.op('BookingReservation-actionsByIdCancelPut', (req, res) => {
  const r = getReservation(req.params.id!);
  assertAction(r, 'Cancel');
  transact(() => {
    const property = getProperty(r.propertyId);
    r.status = 'Canceled';
    r.cancellationTime = nowIso();
    r.updated = r.cancellationTime;
    // Cancelling frees the unit and any block pickup.
    r.assignedUnits = [];
    r.unitId = undefined;
    r.unit = undefined;
    db.reservations.put(r);
    if (r.blockId) releaseToBlock(r.blockId, r);
    postCancellationFee(r, property.businessDate);
    logReservation(r.id, {
      propertyId: r.propertyId,
      action: 'Canceled',
      message: `Reservation ${r.id} cancelled.`,
    });
  });
  sendNoContent(res);
});

api.op('BookingReservation-actionsByIdNoshowPut', (req, res) => {
  const r = getReservation(req.params.id!);
  assertAction(r, 'NoShow');
  transact(() => {
    const property = getProperty(r.propertyId);
    r.status = 'NoShow';
    r.noShowTime = nowIso();
    r.updated = r.noShowTime;
    r.assignedUnits = [];
    r.unitId = undefined;
    r.unit = undefined;
    db.reservations.put(r);
    if (r.blockId) releaseToBlock(r.blockId, r);
    postNoShowFee(r, property.businessDate);
    logReservation(r.id, {
      propertyId: r.propertyId,
      action: 'SetToNoShow',
      message: `Reservation ${r.id} marked as a no-show.`,
    });
  });
  sendNoContent(res);
});

api.op('BookingReservation-actionsByIdAmendPut', (req, res) => amendReservation(req, res, false));
api.op('BookingReservation-actionsByIdAmend$forcePut', (req, res) => amendReservation(req, res, true));

/**
 * Amend the stay: new dates, occupancy or per-night rate plans. The stay is
 * re-quoted and the reservation's time slices are replaced, keeping already
 * posted nights intact.
 */
function amendReservation(req: Request, res: Response, force: boolean): void {
  const r = getReservation(req.params.id!);
  assertAction(r, 'AmendTimeSlices');
  const body = req.body as Record<string, any>;

  transact(() => {
    const property = getProperty(r.propertyId);
    const arrival = toBusinessDate(body.arrival, property.timeZone);
    const departure = toBusinessDate(body.departure, property.timeZone);

    const postedDates = new Set(
      db.charges.all({ propertyId: r.propertyId })
        .filter((c) => c.reservationId === r.id && c.serviceType === 'Accommodation')
        .map((c) => c.serviceDate),
    );
    for (const date of postedDates) {
      if (date < arrival || date >= departure) {
        throw unprocessable(`Night ${date} has already been posted and cannot be removed from the stay.`);
      }
    }

    const input: CreateReservationInput = {
      arrival: body.arrival,
      departure: body.departure,
      adults: body.adults,
      childrenAges: body.childrenAges ?? [],
      channelCode: r.channelCode,
      timeSlices: (body.timeSlices ?? []).map((t: any) => ({
        ratePlanId: t.ratePlanId ?? r.ratePlanId,
        totalAmount: body.requote ? undefined : t.totalAmount,
      })),
      promoCode: r.promoCode,
      corporateCode: r.corporateCode,
      companyId: r.companyId,
      services: r.services
        .filter((s) => s.bookedAsExtra)
        .map((s) => ({ serviceId: s.serviceId, dates: s.dates.map((d) => d.serviceDate) })),
    };
    const q = quote(input);

    if (!force) {
      const messages = [...q.priced.validationMessages, ...checkAvailabilityForAmend(r, q)];
      const fatal = messages.filter((m) =>
        m.code === 'UnitGroupFullyBooked' || m.code === 'RatesNotSet' || m.code === 'UnitGroupCapacityExceeded');
      if (fatal.length) throw unprocessable(fatal.map((m) => m.message));
    }

    const rebuilt = materialize(
      q,
      { ...input, primaryGuest: r.primaryGuest, blockId: r.blockId, groupId: r.groupId },
      { reservationId: r.id, bookingId: r.bookingId },
      [],
    );
    r.arrival = rebuilt.arrival;
    r.departure = rebuilt.departure;
    r.arrivalDate = rebuilt.arrivalDate;
    r.departureDate = rebuilt.departureDate;
    r.adults = rebuilt.adults;
    r.childrenAges = rebuilt.childrenAges;
    r.timeSlices = rebuilt.timeSlices;
    r.services = rebuilt.services;
    r.cityTaxes = r.hasCityTax ? rebuilt.cityTaxes : [];
    r.hasCityTax = r.hasCityTax && rebuilt.cityTaxes.length > 0;
    r.cancellationFee = rebuilt.cancellationFee;
    r.noShowFee = rebuilt.noShowFee;
    r.ratePlanId = rebuilt.ratePlanId;
    r.unitGroupId = rebuilt.unitGroupId;
    r.updated = nowIso();

    // A shortened or lengthened stay may invalidate the unit assignment.
    if (r.assignedUnits.length && !coversWholeStay(r)) {
      r.assignedUnits = r.assignedUnits.map((a) => ({
        unitId: a.unitId,
        timeRanges: [{ from: r.arrival, to: r.departure }],
      }));
    }
    db.reservations.put(r);
    logReservation(r.id, {
      propertyId: r.propertyId,
      action: 'Amended',
      message: `Stay amended to ${r.arrivalDate} - ${r.departureDate} for ${r.adults} adult(s).`,
    });
  });
  sendNoContent(res);
}

function checkAvailabilityForAmend(r: Reservation, q: ReturnType<typeof quote>) {
  const messages: { code: string; message: string }[] = [];
  const property = getProperty(r.propertyId);
  const result = canSell(property, q.ratePlan.unitGroupId, q.arrivalDate, q.departureDate, 1);
  if (!result.ok) {
    // The reservation's own inventory hold does not count against it.
    const sameGroup = q.ratePlan.unitGroupId === r.unitGroupId;
    const holdsUnit = isActive(r) && r.arrivalDate <= result.date && result.date < r.departureDate;
    if (!(sameGroup && holdsUnit && result.available + 1 > 0)) {
      messages.push({
        code: 'UnitGroupFullyBooked',
        message: `No availability in unit group '${q.ratePlan.unitGroupId}' on ${result.date}.`,
      });
    }
  }
  return messages;
}

api.op('BookingReservation-actionsByIdBook-servicePut', (req, res) => bookService(req, res, false));
api.op('BookingReservation-actionsByIdBook-service$forcePut', (req, res) => bookService(req, res, true));

function bookService(req: Request, res: Response, force: boolean): void {
  const r = getReservation(req.params.id!);
  assertAction(r, 'AddService');
  const body = req.body as { serviceId: string; count?: number; amount?: { amount: number; currency: string }; dates?: string[] };
  const service = db.services.get(body.serviceId);
  if (!service) throw unprocessable(`Service '${body.serviceId}' does not exist.`);
  if (service.propertyId !== r.propertyId) {
    throw unprocessable(`Service '${body.serviceId}' belongs to a different property.`);
  }

  transact(() => {
    const currency = r.currency;
    const defaults = serviceDates(service, r.arrivalDate, r.departureDate);
    const dates = body.dates?.length ? body.dates : defaults;
    if (!dates.length) throw unprocessable('The service is not available on any date of the stay.');
    if (!force) {
      const outside = dates.filter((d) => d < r.arrivalDate || d > r.departureDate);
      if (outside.length) {
        throw unprocessable(`Service dates ${outside.join(', ')} fall outside the stay.`);
      }
    }
    const count = body.count ?? serviceCount(service, r.adults, r.childrenAges);
    const unitPrice = body.amount?.amount ?? service.defaultGrossPrice;

    const priced = dates.map((date) => {
      const config = configFor(service.accountingConfigs, date, 'Other');
      return {
        serviceDate: date,
        amount: grossToAmount(round(unitPrice * count, currency), config.vatType, currency),
        count,
        isMandatory: false,
      };
    });
    const totalGross = priced.reduce((s, d) => s + d.amount.grossAmount, 0);

    const existing = r.services.find((s) => s.serviceId === service.id);
    if (existing) {
      // Re-booking the same service replaces its dates rather than duplicating.
      existing.dates = priced;
      existing.totalAmount = grossToAmount(totalGross, priced[0]!.amount.vatType, currency);
      existing.bookedAsExtra = true;
    } else {
      r.services.push({
        id: `${r.id}-S${r.services.length + 1}`,
        serviceId: service.id,
        dates: priced,
        totalAmount: grossToAmount(totalGross, priced[0]!.amount.vatType, currency),
        bookedAsExtra: true,
      });
    }
    r.updated = nowIso();
    db.reservations.put(r);
    logReservation(r.id, {
      propertyId: r.propertyId,
      action: 'Changed',
      message: `Service ${service.code} booked for ${dates.length} date(s).`,
    });
  });
  sendNoContent(res);
}

api.op('BookingReservation-actionsByIdRemove-city-taxPut', (req, res) => {
  const r = getReservation(req.params.id!);
  assertAction(r, 'RemoveCityTax');
  r.hasCityTax = false;
  r.cityTaxes = [];
  r.updated = nowIso();
  db.reservations.put(r);
  logReservation(r.id, { propertyId: r.propertyId, action: 'CityTaxRemoved', message: 'City tax removed.' });
  sendNoContent(res);
});

api.op('BookingReservation-actionsByIdAdd-city-taxPut', (req, res) => {
  const r = getReservation(req.params.id!);
  assertAction(r, 'AddCityTax');
  transact(() => {
    const property = getProperty(r.propertyId);
    const plan = getRatePlan(r.ratePlanId);
    const priced = priceStay({
      property,
      ratePlan: plan,
      arrival: r.arrivalDate,
      departure: r.departureDate,
      adults: r.adults,
      childrenAges: r.childrenAges,
      channelCode: r.channelCode,
      extraServices: r.services.filter((s) => s.bookedAsExtra).map((s) => ({ serviceId: s.serviceId })),
    });
    if (!priced.cityTaxes.length) {
      throw unprocessable('No city tax is configured for this property.');
    }
    r.hasCityTax = true;
    r.cityTaxes = priced.cityTaxes.map((t) => ({
      cityTaxId: t.cityTaxId,
      code: t.code,
      name: t.name,
      dates: t.dates,
    }));
    r.updated = nowIso();
    db.reservations.put(r);
    logReservation(r.id, { propertyId: r.propertyId, action: 'CityTaxAdded', message: 'City tax added.' });
  });
  sendNoContent(res);
});

/* ---------------------------------------------------------------- blocks */

function blockBody(b: Block, langs: readonly string[], expand: ReadonlySet<string>) {
  const group = db.groups.get(b.groupId);
  const pickedReservations = db.reservations.all({ blockId: b.id }).filter(isActive).length;
  return {
    id: b.id,
    group: group ? { id: group.id, name: group.name } : { id: b.groupId },
    status: b.status,
    property: embeddedProperty(b.propertyId, langs),
    ratePlan: embeddedRatePlan(b.ratePlanId, langs),
    unitGroup: embeddedUnitGroup(b.unitGroupId, langs),
    marketSegment: embeddedMarketSegment(b.marketSegmentId, langs),
    grossDailyRate: b.grossDailyRate,
    from: b.from,
    to: b.to,
    pickedReservations,
    promoCode: b.promoCode,
    corporateCode: b.corporateCode,
    created: b.created,
    modified: b.updated,
    timeSlices: expand.has('timeSlices')
      ? b.timeSlices.map((t) => ({
        from: t.from,
        to: t.to,
        blockedUnits: t.blockedUnits,
        pickedUnits: t.pickedUnits,
        baseAmount: t.baseAmount,
        totalGrossAmount: t.totalGrossAmount,
      }))
      : undefined,
    actions: expand.has('actions') ? blockActions(b) : undefined,
    optionalCutoff: b.optionalCutoff,
    optionalCutoffBehavior: b.optionalCutoffBehavior,
    isOptionalDeductingInventory: b.isOptionalDeductingInventory,
  };
}

function blockActions(b: Block) {
  const property = db.properties.get(b.propertyId);
  const inPast = !!property && b.toDate < property.businessDate;
  const reservations = db.reservations.all({ blockId: b.id });
  const activeReservations = reservations.filter(isActive).length;
  const fullyPicked = b.timeSlices.every((t) => t.pickedUnits >= t.blockedUnits);

  const entry = (action: string, isAllowed: boolean, code?: string, message?: string) => ({
    action,
    isAllowed,
    reasons: isAllowed || !code ? undefined : [{ code, message: message ?? code }],
  });

  return [
    entry('Delete', activeReservations === 0, 'DeleteNotAllowedForBlockWithReservations', 'The block has reservations.'),
    entry('Confirm', b.status === 'Tentative' && !inPast,
      b.status !== 'Tentative' ? 'ConfirmNotAllowedForBlockNotInStatusTentative' : 'ConfirmNotAllowedForBlockInThePast',
      b.status !== 'Tentative' ? 'Only a tentative block can be confirmed.' : 'The block is in the past.'),
    entry('Release', b.status === 'Definite' && !inPast && activeReservations === 0,
      activeReservations > 0 ? 'ReleaseNotAllowedForBlockWithReservations'
        : inPast ? 'ReleaseNotAllowedForBlockInThePast' : 'ReleaseNotAllowedForBlockNotInStatusDefinite',
      'The block cannot be released.'),
    entry('Cancel', (b.status === 'Definite' || b.status === 'Tentative') && activeReservations === 0,
      activeReservations > 0
        ? 'CancelNotAllowedForBlockWithNotCancelledReservations'
        : 'CancelNotAllowedForBlockNotInStatusDefiniteOrTentative',
      'The block cannot be cancelled.'),
    entry('Pickup', b.status === 'Definite' && !inPast && !fullyPicked,
      fullyPicked ? 'PickupNotAllowedForFullyPickedBlock'
        : inPast ? 'PickupNotAllowedForBlockInThePast' : 'PickupNotAllowedForBlockNotInStatusDefinite',
      'The block cannot be picked up from.'),
    entry('Modify', !inPast && b.status !== 'Canceled',
      b.status === 'Canceled' ? 'ModifyNotAllowedForBlockInStatusCanceled' : 'ModifyNotAllowedForBlockInThePast',
      'The block cannot be modified.'),
    entry('Wash', b.status === 'Definite' && activeReservations > 0,
      activeReservations === 0 ? 'WashNotAllowedForBlockWithoutReservations' : 'WashNotAllowedForBlockNotInStatusDefinite',
      'The block cannot be washed.'),
    entry('SetToOptional', b.status === 'Tentative' && !inPast,
      b.status !== 'Tentative' ? 'SetToOptionalNotAllowedForBlockNotInStatusTentative' : 'SetToOptionalNotAllowedForBlockInThePast',
      'The block cannot be set to optional.'),
  ];
}

api.op('BookingBlocksPost', (req, res) => {
  const body = req.body as Record<string, any>;
  const group = getGroup(body.groupId);
  const plan = getRatePlan(body.ratePlanId);
  const property = getProperty(plan.propertyId);
  const fromDate = toBusinessDate(body.from, property.timeZone);
  const toDate = toBusinessDate(body.to, property.timeZone);
  if (diffDays(fromDate, toDate) < 1) throw unprocessable('`to` must be after `from`.');

  const created = transact(() => {
    const tsd = db.timeSliceDefinitions.get(plan.timeSliceDefinitionId);
    const checkIn = tsd?.checkInTime ?? property.defaultCheckInTime;
    const checkOut = tsd?.checkOutTime ?? property.defaultCheckOutTime;
    const currency = body.grossDailyRate.currency ?? property.currencyCode;
    const config = configFor(plan.accountingConfigs, fromDate, 'Accommodation');

    const perDate = new Map<string, number>();
    for (const slice of body.timeSlices ?? []) {
      // Explicit per-night allotments are given in order from `from`.
      perDate.set(addDays(fromDate, perDate.size), slice.blockedUnits);
    }
    const defaultUnits = body.blockedUnits ?? 0;

    const timeSlices = nightsBetween(fromDate, toDate).map((date) => ({
      from: atLocalTime(date, checkIn, property.timeZone),
      to: atLocalTime(addDays(date, 1), checkOut, property.timeZone),
      serviceDate: date,
      blockedUnits: perDate.get(date) ?? defaultUnits,
      pickedUnits: 0,
      baseAmount: grossToAmount(body.grossDailyRate.amount, config.vatType, currency),
      totalGrossAmount: money(body.grossDailyRate.amount, currency),
    }));

    const block: Block = {
      id: mintBlockId(property.id, (id) => db.blocks.exists(id)),
      propertyId: property.id,
      groupId: group.id,
      status: 'Tentative',
      ratePlanId: plan.id,
      unitGroupId: plan.unitGroupId,
      marketSegmentId: body.marketSegmentId ?? plan.marketSegmentId,
      promoCode: body.promoCode,
      corporateCode: body.corporateCode,
      grossDailyRate: money(body.grossDailyRate.amount, currency),
      from: atLocalTime(fromDate, checkIn, property.timeZone),
      to: atLocalTime(toDate, checkOut, property.timeZone),
      fromDate,
      toDate,
      timeSlices,
      created: nowIso(),
      updated: nowIso(),
      currency,
      isOptionalDeductingInventory: false,
    };
    db.blocks.put(block);
    if (!group.blockIds.includes(block.id)) {
      group.blockIds.push(block.id);
      group.updated = nowIso();
      db.groups.put(group);
    }
    if (!group.propertyIds.includes(property.id)) {
      group.propertyIds.push(property.id);
      db.groups.put(group);
    }
    return block;
  });
  sendCreated(res, `/booking/v1/blocks/${created.id}`, { id: created.id });
});

function blockFilter(req: Request): (b: Block) => boolean {
  const groupId = stringParam(req, 'groupId');
  const propertyIds = arrayParam(req, 'propertyIds');
  const statuses = arrayParam(req, 'status');
  const unitGroupIds = arrayParam(req, 'unitGroupIds');
  const ratePlanIds = arrayParam(req, 'ratePlanIds');
  const timeSliceDefinitionIds = arrayParam(req, 'timeSliceDefinitionIds');
  const unitGroupTypes = arrayParam(req, 'unitGroupTypes');
  const timeSliceTemplate = stringParam(req, 'timeSliceTemplate');
  const from = dateParam(req, 'from');
  const to = dateParam(req, 'to');

  return (b) => {
    if (groupId && b.groupId !== groupId) return false;
    if (propertyIds.length && !propertyIds.includes(b.propertyId)) return false;
    if (statuses.length && !statuses.includes(b.status)) return false;
    if (unitGroupIds.length && !unitGroupIds.includes(b.unitGroupId)) return false;
    if (ratePlanIds.length && !ratePlanIds.includes(b.ratePlanId)) return false;
    if (unitGroupTypes.length) {
      const g = db.unitGroups.get(b.unitGroupId);
      if (!g || !unitGroupTypes.includes(g.type)) return false;
    }
    const plan = db.ratePlans.get(b.ratePlanId);
    if (timeSliceDefinitionIds.length
      && (!plan || !timeSliceDefinitionIds.includes(plan.timeSliceDefinitionId))) return false;
    if (timeSliceTemplate) {
      const tsd = plan ? db.timeSliceDefinitions.get(plan.timeSliceDefinitionId) : undefined;
      if (!tsd || tsd.template !== timeSliceTemplate) return false;
    }
    if (from && b.toDate < from) return false;
    if (to && b.fromDate > to) return false;
    return true;
  };
}

api.op('BookingBlocksGet', (req, res) => {
  const langs = arrayParam(req, 'languages');
  const expand = new Set(arrayParam(req, 'expand'));
  const page = paging(req);
  const { items, count } = db.blocks.query({
    filter: blockFilter(req),
    sort: (a, b) => a.fromDate.localeCompare(b.fromDate) || a.id.localeCompare(b.id),
    offset: page.offset,
    limit: page.pageSize,
  });
  sendList(res, 'blocks', items.map((b) => blockBody(b, langs, expand)), count);
});

api.op('BookingBlocks$countGet', (req, res) => {
  res.json({ count: db.blocks.all().filter(blockFilter(req)).length });
});

api.op('BookingBlocksByIdGet', (req, res) => {
  const b = getBlock(req.params.id!);
  const expand = new Set([...arrayParam(req, 'expand'), 'timeSlices']);
  res.json(blockBody(b, languagesOf(arrayParam(req, 'languages'), b.propertyId), expand));
});

api.op('BookingBlocksByIdHead', (req, res) => {
  res.status(db.blocks.exists(req.params.id!) ? 200 : 404).end();
});

api.op('BookingBlocksByIdDelete', (req, res) => {
  const b = getBlock(req.params.id!);
  assertBlockAction(b, 'Delete');
  transact(() => {
    db.blocks.delete(b.id);
    const group = db.groups.get(b.groupId);
    if (group) {
      group.blockIds = group.blockIds.filter((id) => id !== b.id);
      db.groups.put(group);
    }
  });
  sendNoContent(res);
});

function assertBlockAction(b: Block, action: string): void {
  const entry = blockActions(b).find((a) => a.action === action);
  if (!entry || entry.isAllowed) return;
  throw unprocessable(entry.reasons?.map((r) => r.message) ?? [`'${action}' is not allowed for this block.`]);
}

api.op('BookingBlocksByIdPatch', (req, res) => {
  const b = getBlock(req.params.id!);
  assertBlockAction(b, 'Modify');
  const ops = req.body as PatchOperation[];
  rejectImmutablePaths(ops, ['/id', '/status', '/property', '/created', '/group']);
  const view = {
    grossDailyRate: b.grossDailyRate,
    marketSegmentId: b.marketSegmentId,
    promoCode: b.promoCode,
    corporateCode: b.corporateCode,
    optionalCutoff: b.optionalCutoff,
    optionalCutoffBehavior: b.optionalCutoffBehavior,
    isOptionalDeductingInventory: b.isOptionalDeductingInventory,
  };
  const patched = applyPatch(view, ops) as typeof view;
  const rateChanged = patched.grossDailyRate?.amount !== b.grossDailyRate.amount;
  Object.assign(b, patched);
  if (rateChanged) {
    const plan = db.ratePlans.get(b.ratePlanId);
    for (const slice of b.timeSlices) {
      const config = configFor(plan?.accountingConfigs ?? [], slice.serviceDate, 'Accommodation');
      slice.baseAmount = grossToAmount(b.grossDailyRate.amount, config.vatType, b.currency);
      slice.totalGrossAmount = money(b.grossDailyRate.amount, b.currency);
    }
  }
  b.updated = nowIso();
  db.blocks.put(b);
  sendNoContent(res);
});

api.op('BookingBlock-actionsByIdConfirmPut', (req, res) => {
  const b = getBlock(req.params.id!);
  assertBlockAction(b, 'Confirm');
  b.status = 'Definite';
  b.updated = nowIso();
  db.blocks.put(b);
  sendNoContent(res);
});

api.op('BookingBlock-actionsByIdCancelPut', (req, res) => {
  const b = getBlock(req.params.id!);
  assertBlockAction(b, 'Cancel');
  b.status = 'Canceled';
  b.updated = nowIso();
  db.blocks.put(b);
  sendNoContent(res);
});

api.op('BookingBlock-actionsByIdReleasePut', (req, res) => {
  const b = getBlock(req.params.id!);
  assertBlockAction(b, 'Release');
  // Releasing hands unpicked inventory back by zeroing the allotment.
  for (const slice of b.timeSlices) slice.blockedUnits = slice.pickedUnits;
  b.updated = nowIso();
  db.blocks.put(b);
  sendNoContent(res);
});

api.op('BookingBlock-actionsByIdWashPut', (req, res) => {
  const b = getBlock(req.params.id!);
  assertBlockAction(b, 'Wash');
  // Washing trims the allotment down to what has actually been picked up.
  for (const slice of b.timeSlices) slice.blockedUnits = slice.pickedUnits;
  b.updated = nowIso();
  db.blocks.put(b);
  sendNoContent(res);
});

api.op('BookingBlock-actionsByIdSet-to-optionalPut', (req, res) => {
  const b = getBlock(req.params.id!);
  assertBlockAction(b, 'SetToOptional');
  const body = (req.body ?? {}) as Record<string, any>;
  b.status = 'Optional';
  b.optionalCutoff = body.optionalCutoff ?? b.from;
  b.optionalCutoffBehavior = body.optionalCutoffBehavior ?? 'DoNothing';
  b.isOptionalDeductingInventory = body.isOptionalDeductingInventory ?? false;
  b.updated = nowIso();
  db.blocks.put(b);
  sendNoContent(res);
});

api.op('BookingBlock-actionsByIdStart-optionalPut', (req, res) => {
  const b = getBlock(req.params.id!);
  if (b.status !== 'Optional') throw unprocessable('The block is not optional.');
  // Starting the optional period makes it hold inventory again.
  b.isOptionalDeductingInventory = true;
  b.updated = nowIso();
  db.blocks.put(b);
  sendNoContent(res);
});

api.op('BookingBlock-actionsByIdCutoff-optionalPut', (req, res) => {
  const b = getBlock(req.params.id!);
  if (b.status !== 'Optional') throw unprocessable('The block is not optional.');
  transact(() => {
    if (b.optionalCutoffBehavior === 'AutoRelease') {
      for (const slice of b.timeSlices) slice.blockedUnits = slice.pickedUnits;
      b.status = 'Canceled';
    } else {
      b.status = 'Tentative';
    }
    b.isOptionalDeductingInventory = false;
    b.updated = nowIso();
    db.blocks.put(b);
  });
  sendNoContent(res);
});

api.op('BookingBlock-actionsByIdAmendPut', (req, res) => {
  const b = getBlock(req.params.id!);
  assertBlockAction(b, 'Modify');
  const body = req.body as Record<string, any>;
  const property = getProperty(b.propertyId);
  const plan = db.ratePlans.get(b.ratePlanId);
  const tsd = plan ? db.timeSliceDefinitions.get(plan.timeSliceDefinitionId) : undefined;
  const checkIn = tsd?.checkInTime ?? property.defaultCheckInTime;
  const checkOut = tsd?.checkOutTime ?? property.defaultCheckOutTime;

  transact(() => {
    const fromDate = body.from ? toBusinessDate(body.from, property.timeZone) : b.fromDate;
    const toDate = body.to ? toBusinessDate(body.to, property.timeZone) : b.toDate;
    if (diffDays(fromDate, toDate) < 1) throw unprocessable('`to` must be after `from`.');

    const rate = body.grossDailyRate ? money(body.grossDailyRate.amount, body.grossDailyRate.currency ?? b.currency) : b.grossDailyRate;
    const explicit = new Map<string, number>();
    (body.timeSlices ?? []).forEach((slice: any, i: number) => {
      explicit.set(addDays(fromDate, i), slice.blockedUnits);
    });
    const previous = new Map(b.timeSlices.map((t) => [t.serviceDate, t]));

    b.timeSlices = nightsBetween(fromDate, toDate).map((date) => {
      const before = previous.get(date);
      const blockedUnits = explicit.get(date) ?? before?.blockedUnits ?? body.blockedUnits ?? 0;
      const picked = before?.pickedUnits ?? 0;
      if (blockedUnits < picked) {
        throw unprocessable(`Cannot reduce ${date} below the ${picked} unit(s) already picked up.`);
      }
      const config = configFor(plan?.accountingConfigs ?? [], date, 'Accommodation');
      return {
        from: atLocalTime(date, checkIn, property.timeZone),
        to: atLocalTime(addDays(date, 1), checkOut, property.timeZone),
        serviceDate: date,
        blockedUnits,
        pickedUnits: picked,
        baseAmount: grossToAmount(rate.amount, config.vatType, b.currency),
        totalGrossAmount: money(rate.amount, b.currency),
      };
    });
    b.fromDate = fromDate;
    b.toDate = toDate;
    b.from = atLocalTime(fromDate, checkIn, property.timeZone);
    b.to = atLocalTime(toDate, checkOut, property.timeZone);
    b.grossDailyRate = rate;
    b.updated = nowIso();
    db.blocks.put(b);
  });
  sendNoContent(res);
});

/* ---------------------------------------------------------------- groups */

function groupBody(g: Group, langs: readonly string[], expand: ReadonlySet<string>) {
  const blocks = db.blocks.getMany(g.blockIds);
  const dates = blocks.flatMap((b) => [b.from, b.to]).sort();
  const paymentAccount = g.paymentAccountId ? db.paymentAccounts.get(g.paymentAccountId) : undefined;
  return {
    id: g.id,
    name: g.name,
    from: dates[0],
    to: dates[dates.length - 1],
    booker: g.booker,
    comment: g.comment,
    bookerComment: g.bookerComment,
    paymentAccount: paymentAccount ? paymentAccountBody(paymentAccount) : undefined,
    hasActivePaymentAccount: !!paymentAccount?.isActive,
    created: g.created,
    modified: g.updated,
    propertyIds: g.propertyIds,
    blocks: blocks.map((b) => ({
      id: b.id,
      status: b.status,
      property: embeddedProperty(b.propertyId, langs),
      ratePlan: embeddedRatePlan(b.ratePlanId, langs),
      unitGroup: embeddedUnitGroup(b.unitGroupId, langs),
      marketSegment: embeddedMarketSegment(b.marketSegmentId, langs),
      grossDailyRate: b.grossDailyRate,
      from: b.from,
      to: b.to,
      blockedUnits: b.timeSlices.reduce((max, t) => Math.max(max, t.blockedUnits), 0),
      pickedReservations: db.reservations.all({ blockId: b.id }).filter(isActive).length,
      created: b.created,
      modified: b.updated,
    })),
    actions: expand.has('actions')
      ? [{
        action: 'Delete',
        isAllowed: blocks.length === 0,
        reasons: blocks.length
          ? [{ code: 'DeleteNotAllowedForGroupWithBlocks', message: 'The group still has blocks.' }]
          : undefined,
      }]
      : undefined,
  };
}

api.op('BookingGroupsPost', (req, res) => {
  const body = req.body as Record<string, any>;
  for (const propertyId of body.propertyIds ?? []) getProperty(propertyId);
  const created = transact(() => {
    const id = mintGroupId((candidate) => db.groups.exists(candidate));
    const group: Group = {
      id,
      name: body.name,
      propertyIds: body.propertyIds ?? [],
      booker: body.booker,
      comment: body.comment,
      bookerComment: body.bookerComment,
      registeredCard: body.registeredCard,
      created: nowIso(),
      updated: nowIso(),
      blockIds: [],
      reservationIds: [],
    };
    if (body.paymentAccount) {
      group.paymentAccountId = createPaymentAccount(body.paymentAccount, { groupId: id }).id;
    }
    db.groups.put(group);
    return group;
  });
  sendCreated(res, `/booking/v1/groups/${created.id}`, { id: created.id });
});

function groupFilter(req: Request): (g: Group) => boolean {
  const propertyIds = arrayParam(req, 'propertyIds');
  const textSearch = stringParam(req, 'textSearch')?.toLowerCase();
  const from = dateParam(req, 'from');
  const to = dateParam(req, 'to');
  return (g) => {
    if (propertyIds.length && !propertyIds.some((p) => g.propertyIds.includes(p))) return false;
    if (textSearch && !`${g.id} ${g.name}`.toLowerCase().includes(textSearch)) return false;
    if (from || to) {
      const blocks = db.blocks.getMany(g.blockIds);
      if (!blocks.length) return false;
      const start = blocks.reduce((min, b) => (b.fromDate < min ? b.fromDate : min), blocks[0]!.fromDate);
      const end = blocks.reduce((max, b) => (b.toDate > max ? b.toDate : max), blocks[0]!.toDate);
      if (from && end < from) return false;
      if (to && start > to) return false;
    }
    return true;
  };
}

api.op('BookingGroupsGet', (req, res) => {
  const langs = arrayParam(req, 'languages');
  const expand = new Set(arrayParam(req, 'expand'));
  const page = paging(req);
  const { items, count } = db.groups.query({
    filter: groupFilter(req),
    sort: (a, b) => b.created.localeCompare(a.created),
    offset: page.offset,
    limit: page.pageSize,
  });
  sendList(res, 'groups', items.map((g) => groupBody(g, langs, expand)), count);
});

api.op('BookingGroups$countGet', (req, res) => {
  res.json({ count: db.groups.all().filter(groupFilter(req)).length });
});

api.op('BookingGroupsByIdGet', (req, res) => {
  const g = getGroup(req.params.id!);
  res.json(groupBody(g, arrayParam(req, 'languages'), new Set([...arrayParam(req, 'expand'), 'actions'])));
});

api.op('BookingGroupsByIdHead', (req, res) => {
  res.status(db.groups.exists(req.params.id!) ? 200 : 404).end();
});

api.op('BookingGroupsByIdPatch', (req, res) => {
  const g = getGroup(req.params.id!);
  const ops = req.body as PatchOperation[];
  rejectImmutablePaths(ops, ['/id', '/created', '/blocks']);
  const view = {
    name: g.name,
    booker: g.booker,
    comment: g.comment,
    bookerComment: g.bookerComment,
    propertyIds: g.propertyIds,
  };
  const patched = applyPatch(view, ops) as typeof view;
  for (const propertyId of patched.propertyIds ?? []) getProperty(propertyId);
  Object.assign(g, patched, { updated: nowIso() });
  db.groups.put(g);
  sendNoContent(res);
});

api.op('BookingGroupsByIdDelete', (req, res) => {
  const g = getGroup(req.params.id!);
  if (g.blockIds.length) throw unprocessable('The group still has blocks and cannot be deleted.');
  db.groups.delete(g.id);
  sendNoContent(res);
});

api.op('BookingGroupsByIdReservationsPost', (req, res) => {
  const g = getGroup(req.params.id!);
  const body = req.body as { reservations: any[] };
  const created = transact(() => {
    const booking: Booking = {
      id: newBookingId(),
      groupId: g.id,
      booker: g.booker,
      comment: g.comment,
      created: nowIso(),
      updated: nowIso(),
      reservationIds: [],
      nextReservationOrdinal: 1,
    };
    db.bookings.put(booking);
    const reservations = addReservations(
      booking,
      (body.reservations ?? []).map((r) => ({ ...r, groupId: g.id })),
      false,
    );
    g.reservationIds.push(...reservations.map((r) => r.id));
    g.updated = nowIso();
    db.groups.put(g);
    return reservations;
  });
  res.status(201).json({ reservationIds: created.map((r) => ({ id: r.id })) });
});

/* ------------------------------------------------------- payment accounts */

interface PaymentAccountOwner {
  reservationId?: string;
  bookingId?: string;
  groupId?: string;
  propertyId?: string;
}

function createPaymentAccount(
  input: Record<string, any>,
  owner: PaymentAccountOwner,
  payerInteraction: PaymentAccount['payerInteraction'] = 'PaymentAccount',
): PaymentAccount {
  const account: PaymentAccount = {
    id: mintPaymentAccountId((id) => db.paymentAccounts.exists(id)),
    ...owner,
    accountNumber: maskAccountNumber(input.accountNumber),
    accountHolder: input.accountHolder,
    expiryMonth: input.expiryMonth,
    expiryYear: input.expiryYear,
    paymentMethod: input.paymentMethod,
    payerEmail: input.payerEmail,
    payerReference: input.payerReference,
    isVirtual: input.isVirtual ?? false,
    isActive: !input.inactiveReason,
    inactiveReason: input.inactiveReason,
    payerInteraction,
    created: nowIso(),
    updated: nowIso(),
  };
  db.paymentAccounts.put(account);
  return account;
}

/**
 * Card numbers never need to be stored in full here, and storing them would be
 * a liability in a local clone, so everything but the last four digits is
 * masked on the way in.
 */
function maskAccountNumber(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.length) return undefined;
  const digits = value.replace(/\D/g, '');
  if (digits.length <= 4) return digits;
  return `${'*'.repeat(digits.length - 4)}${digits.slice(-4)}`;
}

function paymentAccountTarget(body: Record<string, any>): PaymentAccountOwner {
  const owner: PaymentAccountOwner = {};
  const target = body.target ?? body;
  if (target.reservationId) {
    const r = getReservation(target.reservationId);
    owner.reservationId = r.id;
    owner.bookingId = r.bookingId;
    owner.propertyId = r.propertyId;
  }
  if (target.bookingId) owner.bookingId = target.bookingId;
  if (target.groupId) owner.groupId = target.groupId;
  if (target.propertyId) owner.propertyId = target.propertyId;
  if (!owner.reservationId && !owner.bookingId && !owner.groupId) {
    throw unprocessable('A reservation, booking or group must be supplied as the target.');
  }
  return owner;
}

function respondPaymentAccount(res: Response, account: PaymentAccount): void {
  sendCreated(res, `/booking/v1/payment-accounts/${account.id}`, {
    id: account.id,
    ...(account.paymentLinkUrl ? { paymentLinkUrl: account.paymentLinkUrl } : {}),
  });
}

api.op('BookingPayment-accountsBy-terminalPost', (req, res) => {
  const body = req.body as Record<string, any>;
  const account = createPaymentAccount(body, paymentAccountTarget(body), 'Terminal');
  respondPaymentAccount(res, account);
});

api.op('BookingPayment-accountsBy-linkPost', (req, res) => {
  const body = req.body as Record<string, any>;
  const account = createPaymentAccount(body, paymentAccountTarget(body), 'PaymentLink');
  // A real integration would hand back a PSP-hosted page; we mint a local URL
  // so the flow is exercisable end to end.
  account.paymentLinkUrl = `${req.protocol}://${req.get('host')}/pay/${account.id}`;
  account.expiresAt = new Date(Date.now() + 7 * 86400_000).toISOString();
  account.isActive = false;
  account.inactiveReason = 'PendingPayerInteraction';
  db.paymentAccounts.put(account);
  respondPaymentAccount(res, account);
});

api.op('BookingPayment-accountsBy-authorizationPost', (req, res) => {
  const body = req.body as Record<string, any>;
  const authorization = db.authorizations.get(body.authorizationId);
  if (!authorization) throw unprocessable(`Authorization '${body.authorizationId}' does not exist.`);
  const account = createPaymentAccount(body, paymentAccountTarget(body), 'Authorization');
  respondPaymentAccount(res, account);
});

api.op('BookingPayment-accountsBy-stored-payment-methodPost', (req, res) => {
  const body = req.body as Record<string, any>;
  const account = createPaymentAccount(
    { ...body, accountNumber: body.storedPaymentMethodId },
    paymentAccountTarget(body),
    'PaymentAccount',
  );
  respondPaymentAccount(res, account);
});

api.op('BookingPayment-accountsGet', (req, res) => {
  const reservationId = stringParam(req, 'reservationId');
  const bookingId = stringParam(req, 'bookingId');
  const page = paging(req);
  const { items, count } = db.paymentAccounts.query({
    filter: (a) =>
      (!reservationId || a.reservationId === reservationId)
      && (!bookingId || a.bookingId === bookingId),
    sort: (a, b) => b.created.localeCompare(a.created),
    offset: page.offset,
    limit: page.pageSize,
  });
  sendList(res, 'paymentAccounts', items.map((a) => ({ id: a.id, ...paymentAccountBody(a) })), count);
});

api.op('BookingPayment-accountsByIdGet', (req, res) => {
  const a = db.paymentAccounts.get(req.params.id!);
  if (!a) throw notFound(`Payment account '${req.params.id}' was not found.`);
  res.json({
    id: a.id,
    ...paymentAccountBody(a),
    paymentLinkUrl: a.paymentLinkUrl,
    expiresAt: a.expiresAt,
    actions: [
      { action: 'Cancel', isAllowed: a.isActive },
      { action: 'ExpirePaymentLink', isAllowed: a.payerInteraction === 'PaymentLink' && !a.isActive && !!a.paymentLinkUrl },
    ],
  });
});

api.op('BookingPayment-account-actionsByPaymentAccountIdCancelPut', (req, res) => {
  const a = db.paymentAccounts.get(req.params.paymentAccountId!);
  if (!a) throw notFound(`Payment account '${req.params.paymentAccountId}' was not found.`);
  if (!a.isActive) throw unprocessable('Only an active payment account can be cancelled.');
  a.isActive = false;
  a.inactiveReason = 'Canceled';
  a.updated = nowIso();
  db.paymentAccounts.put(a);
  sendNoContent(res);
});

api.op('BookingPayment-account-actionsByPaymentAccountIdExpire-payment-linkPut', (req, res) => {
  const a = db.paymentAccounts.get(req.params.paymentAccountId!);
  if (!a) throw notFound(`Payment account '${req.params.paymentAccountId}' was not found.`);
  if (a.payerInteraction !== 'PaymentLink' || !a.paymentLinkUrl) {
    throw unprocessable('Only a pending payment-link account can be expired.');
  }
  a.paymentLinkUrl = undefined;
  a.expiresAt = nowIso();
  a.isActive = false;
  a.inactiveReason = 'Expired';
  a.updated = nowIso();
  db.paymentAccounts.put(a);
  sendNoContent(res);
});

/* --------------------------------------------------------- authorizations */

function authorizationBody(a: Authorization) {
  return {
    id: a.id,
    target: {
      reservationId: a.reservationId,
      folioId: a.folioId,
      propertyId: a.propertyId,
    },
    created: a.created,
    updated: a.updated,
    externalReference: a.externalReference,
    amount: a.amount,
    remainingBalance: a.remainingBalance,
    status: a.status,
    failureReason: a.failureReason,
    payerInteraction: a.payerInteraction,
    expiresAt: a.expiresAt,
    paymentLinkUrl: a.paymentLinkUrl,
    actions: [
      {
        action: 'Cancel',
        isAllowed: a.status === 'Success',
        reasons: a.status === 'Success' ? undefined
          : [{ code: 'OnlySuccessfulAuthorizationCanBeCanceled', message: 'Only a successful authorization can be cancelled.' }],
      },
      {
        action: 'Refresh',
        isAllowed: a.status === 'Success',
        reasons: a.status === 'Success' ? undefined
          : [{ code: 'OnlySuccessfulAuthorizationCanBeRefreshed', message: 'Only a successful authorization can be refreshed.' }],
      },
      {
        action: 'ExpirePaymentLink',
        isAllowed: a.payerInteraction === 'PaymentLink' && a.status === 'Pending',
        reasons: a.payerInteraction === 'PaymentLink' && a.status === 'Pending' ? undefined
          : [{ code: 'OnlyPendingPaymentLinkAuthorizationCanBeExpired', message: 'Only a pending payment link can be expired.' }],
      },
    ],
  };
}

function createAuthorization(
  body: Record<string, any>,
  payerInteraction: Authorization['payerInteraction'],
  status: Authorization['status'],
): Authorization {
  const target = body.target ?? body;
  const reservation = target.reservationId ? getReservation(target.reservationId) : undefined;
  const folio = target.folioId ? db.folios.get(target.folioId) : undefined;
  const propertyId = reservation?.propertyId ?? folio?.propertyId ?? target.propertyId;
  if (!propertyId) throw unprocessable('A reservation, folio or property must be supplied as the target.');
  const currency = db.properties.get(propertyId)?.currencyCode ?? 'EUR';
  const amount = money(body.amount?.amount ?? 0, body.amount?.currency ?? currency);

  const authorization: Authorization = {
    id: mintAuthId((id) => db.authorizations.exists(id)),
    propertyId,
    reservationId: reservation?.id,
    folioId: folio?.id,
    amount,
    remainingBalance: amount,
    status,
    payerInteraction,
    created: nowIso(),
    updated: nowIso(),
    expiresAt: new Date(Date.now() + 7 * 86400_000).toISOString(),
    paymentAccountId: body.paymentAccountId,
    externalReference: body.externalReference,
  };
  db.authorizations.put(authorization);
  return authorization;
}

api.op('BookingAuthorizationsBy-linkPost', (req, res) => {
  const authorization = createAuthorization(req.body, 'PaymentLink', 'Pending');
  authorization.paymentLinkUrl = `${req.protocol}://${req.get('host')}/authorize/${authorization.id}`;
  db.authorizations.put(authorization);
  sendCreated(res, `/booking/v1/authorizations/${authorization.id}`, {
    id: authorization.id,
    paymentLinkUrl: authorization.paymentLinkUrl,
  });
});

api.op('BookingAuthorizationsBy-terminalPost', (req, res) => {
  const authorization = createAuthorization(req.body, 'Terminal', 'Success');
  sendCreated(res, `/booking/v1/authorizations/${authorization.id}`, { id: authorization.id });
});

api.op('BookingAuthorizationsBy-payment-accountPost', (req, res) => {
  const body = req.body as Record<string, any>;
  if (body.paymentAccountId && !db.paymentAccounts.exists(body.paymentAccountId)) {
    throw unprocessable(`Payment account '${body.paymentAccountId}' does not exist.`);
  }
  const authorization = createAuthorization(body, 'PaymentAccount', 'Success');
  sendCreated(res, `/booking/v1/authorizations/${authorization.id}`, { id: authorization.id });
});

api.op('BookingAuthorizationsBy-authorizationPost', (req, res) => {
  const body = req.body as Record<string, any>;
  const source = db.authorizations.get(body.authorizationId);
  if (!source) throw unprocessable(`Authorization '${body.authorizationId}' does not exist.`);
  if (source.status !== 'Success') {
    throw unprocessable('Only a successful authorization can be used as the source for another.');
  }
  const authorization = createAuthorization(
    { ...body, target: body.target ?? { reservationId: source.reservationId, folioId: source.folioId } },
    'Authorization',
    'Success',
  );
  sendCreated(res, `/booking/v1/authorizations/${authorization.id}`, { id: authorization.id });
});

api.op('BookingAuthorizationsGet', (req, res) => {
  const reservationId = stringParam(req, 'reservationId');
  const folioId = stringParam(req, 'folioId');
  const statuses = arrayParam(req, 'status');
  const page = paging(req);
  const { items, count } = db.authorizations.query({
    filter: (a) =>
      (!reservationId || a.reservationId === reservationId)
      && (!folioId || a.folioId === folioId)
      && (!statuses.length || statuses.includes(a.status)),
    sort: (a, b) => b.created.localeCompare(a.created),
    offset: page.offset,
    limit: page.pageSize,
  });
  sendList(res, 'authorizations', items.map(authorizationBody), count);
});

api.op('BookingAuthorizationsByIdGet', (req, res) => {
  const a = db.authorizations.get(req.params.id!);
  if (!a) throw notFound(`Authorization '${req.params.id}' was not found.`);
  res.json(authorizationBody(a));
});

api.op('BookingAuthorization-actionsByAuthorizationIdCancelPut', (req, res) => {
  const a = requireAuthorization(req.params.authorizationId!);
  if (a.status !== 'Success') throw unprocessable('Only a successful authorization can be cancelled.');
  a.status = 'Canceled';
  a.remainingBalance = money(0, a.amount.currency);
  a.updated = nowIso();
  db.authorizations.put(a);
  sendNoContent(res);
});

api.op('BookingAuthorization-actionsByAuthorizationIdRefreshPut', (req, res) => {
  const a = requireAuthorization(req.params.authorizationId!);
  if (a.status !== 'Success') throw unprocessable('Only a successful authorization can be refreshed.');
  a.expiresAt = new Date(Date.now() + 7 * 86400_000).toISOString();
  a.updated = nowIso();
  db.authorizations.put(a);
  sendNoContent(res);
});

api.op('BookingAuthorization-actionsByAuthorizationIdExpire-payment-linkPut', (req, res) => {
  const a = requireAuthorization(req.params.authorizationId!);
  if (a.payerInteraction !== 'PaymentLink' || a.status !== 'Pending') {
    throw unprocessable('Only a pending payment-link authorization can be expired.');
  }
  a.status = 'Expired';
  a.paymentLinkUrl = undefined;
  a.updated = nowIso();
  db.authorizations.put(a);
  sendNoContent(res);
});

function requireAuthorization(id: string): Authorization {
  const a = db.authorizations.get(id);
  if (!a) throw notFound(`Authorization '${id}' was not found.`);
  return a;
}

/* ----------------------------------------------------------------- types */

api.op('BookingTypesSourcesGet', (_req, res) => {
  // Sources actually in use, plus the well-known defaults.
  const used = new Set(db.reservations.all().map((r) => r.source).filter((s): s is string => !!s));
  const sources = [...new Set([...SOURCES, ...used])].sort();
  res.json({ sources });
});

api.op('BookingTypesByTypeAllowed-valuesGet', (req, res) => {
  const type = req.params.type!;
  requiredStringParam(req, 'countryCode');
  const textSearch = stringParam(req, 'textSearch')?.toLowerCase();
  const page = paging(req);
  const source = type === 'Gender' ? GENDERS : type === 'IdentificationType' ? IDENTIFICATION_TYPES : undefined;
  if (!source) throw unprocessable(`'${type}' is not a supported type. Use 'Gender' or 'IdentificationType'.`);

  let values = [...source] as string[];
  if (textSearch) values = values.filter((v) => v.toLowerCase().includes(textSearch));
  const sort = arrayParam(req, 'sort');
  if (sort.includes('value:desc')) values.sort((a, b) => b.localeCompare(a));
  else values.sort((a, b) => a.localeCompare(b));

  sendList(res, 'allowedValues', values.slice(page.offset, page.offset + page.pageSize), values.length);
});

export const bookingRouter = api.build();
