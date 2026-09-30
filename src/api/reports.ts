import { ApiBuilder } from '../core/router';
import {
  arrayParam, intParam, paging, requiredDateParam, requiredStringParam, sendList, stringParam,
} from '../core/http';
import { unprocessable } from '../core/errors';
import { resolveLocalized } from '../core/localized';
import { addDays, datesInclusive } from '../core/dates';
import { money, round, type MonetaryValue } from '../core/money';
import {
  db, embeddedUnitGroup, languagesOf, property as getProperty,
} from '../domain/repo';
import { AvailabilitySnapshot } from '../domain/availability';
import { isActive } from '../domain/operations';
import type { Charge, Property, Reservation } from '../domain/types';

/**
 * Reports API - the numbers a revenue manager and a night auditor look at.
 *
 * Everything is derived from the same sources as the operational endpoints:
 * posted charges for revenue, the availability snapshot for inventory
 * counts, so a report never disagrees with the folio it was computed from.
 */

const api = new ApiBuilder('reports-v1');

/* ------------------------------------------------------- ordered services */

api.op('ReportsReportsOrdered-servicesGet', (req, res) => {
  const property = getProperty(requiredStringParam(req, 'propertyId'));
  const serviceIds = arrayParam(req, 'serviceIds');
  if (!serviceIds.length) throw unprocessable('`serviceIds` must contain at least one service id.');
  const from = requiredDateParam(req, 'from');
  const to = requiredDateParam(req, 'to');
  const langs = languagesOf(arrayParam(req, 'languages'), property.id);

  const rows: Record<string, unknown>[] = [];
  for (const reservation of db.reservations.all({ propertyId: property.id })) {
    if (reservation.status === 'Canceled') continue;
    for (const booked of reservation.services) {
      if (!serviceIds.includes(booked.serviceId)) continue;
      const service = db.services.get(booked.serviceId);
      for (const entry of booked.dates) {
        if (entry.serviceDate < from || entry.serviceDate > to) continue;
        rows.push({
          id: booked.serviceId,
          code: service?.code ?? booked.serviceId,
          name: resolveLocalized(service?.name, langs) ?? booked.serviceId,
          serviceDate: entry.serviceDate,
          count: entry.count,
          guest: reservation.primaryGuest
            ? {
              firstName: reservation.primaryGuest.firstName,
              lastName: reservation.primaryGuest.lastName,
              email: reservation.primaryGuest.email,
            }
            : undefined,
          reservation: {
            id: reservation.id,
            status: reservation.status,
            arrival: reservation.arrival,
            departure: reservation.departure,
            adults: reservation.adults,
            childrenAges: reservation.childrenAges,
          },
          unit: reservation.unitId
            ? { id: reservation.unitId, name: db.units.get(reservation.unitId)?.name }
            : undefined,
          unitGroup: embeddedUnitGroup(reservation.unitGroupId, langs),
        });
      }
    }
  }
  rows.sort((a, b) => String(a.serviceDate).localeCompare(String(b.serviceDate)));
  sendList(res, 'orderedServices', rows, rows.length);
});

/* -------------------------------------------------------------- arrivals */

api.op('ReportsReportsArrivalsGet', (req, res) => {
  const property = getProperty(requiredStringParam(req, 'propertyId'));
  const month = intParam(req, 'month', 0);
  const year = intParam(req, 'year', 0);
  if (month < 1 || month > 12) throw unprocessable('`month` must be between 1 and 12.');
  if (year < 1900 || year > 2999) throw unprocessable('`year` must be a four-digit year.');

  const prefix = `${year}-${String(month).padStart(2, '0')}`;
  const arrivals = db.reservations
    .all({ propertyId: property.id })
    .filter((r) => r.arrivalDate.startsWith(prefix) && r.status !== 'Canceled');

  const total = arrivals.length;
  const totalAdults = arrivals.reduce((s, r) => s + r.adults, 0);
  const totalChildren = arrivals.reduce((s, r) => s + r.childrenAges.length, 0);

  const travelPurposeBreakdown = breakdown(
    arrivals,
    (r) => r.travelPurpose,
    (purpose, entries) => ({ purpose, number: entries.length, percent: percentOf(entries.length, total), reservationIds: entries.map((r) => r.id) }),
  );
  const nationalityBreakdown = breakdown(
    arrivals,
    (r) => r.primaryGuest?.nationalityCountryCode,
    (countryCode, entries) => ({ countryCode, number: entries.length, percent: percentOf(entries.length, total), reservationIds: entries.map((r) => r.id) }),
  );
  const countryOfResidenceBreakdown = breakdown(
    arrivals,
    (r) => r.primaryGuest?.address?.countryCode,
    (countryCode, entries) => ({ countryCode, number: entries.length, percent: percentOf(entries.length, total), reservationIds: entries.map((r) => r.id) }),
  );

  res.json({
    total,
    totalAdults,
    totalChildren,
    travelPurposeBreakdown,
    nationalityBreakdown,
    countryOfResidenceBreakdown,
  });
});

function breakdown<T, R>(
  items: readonly Reservation[],
  key: (r: Reservation) => string | undefined,
  make: (value: string | undefined, entries: Reservation[]) => R,
): R[] {
  const groups = new Map<string, Reservation[]>();
  for (const item of items) {
    const k = key(item) ?? '';
    const list = groups.get(k) ?? [];
    list.push(item);
    groups.set(k, list);
  }
  return [...groups.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .map(([k, entries]) => make(k || undefined, entries));
}

const percentOf = (n: number, total: number) => (total === 0 ? 0 : round((n / total) * 100, 'EUR'));

/* -------------------------------------------------- property performance */

interface PerformanceBucket {
  houseCount: number;
  houseItemsCount: number;
  soldCount: number;
  soldItemsCount: number;
  unsoldCount: number;
  unsoldItemsCount: number;
  outOfOrderCount: number;
  outOfOrderItemsCount: number;
  tentativelyBlockedCount: number;
  tentativelyBlockedItemsCount: number;
  definitelyBlockedCount: number;
  optionallyBlockedCount: number;
  arrivalsCount: number;
  departuresCount: number;
  noShowsCount: number;
  cancellationsCount: number;
  grossAccommodation: number;
  netAccommodation: number;
  grossFoodAndBeverages: number;
  netFoodAndBeverages: number;
  grossOther: number;
  netOther: number;
}

const emptyBucket = (): PerformanceBucket => ({
  houseCount: 0, houseItemsCount: 0, soldCount: 0, soldItemsCount: 0,
  unsoldCount: 0, unsoldItemsCount: 0, outOfOrderCount: 0, outOfOrderItemsCount: 0,
  tentativelyBlockedCount: 0, tentativelyBlockedItemsCount: 0,
  definitelyBlockedCount: 0, optionallyBlockedCount: 0,
  arrivalsCount: 0, departuresCount: 0, noShowsCount: 0, cancellationsCount: 0,
  grossAccommodation: 0, netAccommodation: 0,
  grossFoodAndBeverages: 0, netFoodAndBeverages: 0, grossOther: 0, netOther: 0,
});

function addBucket(target: PerformanceBucket, source: PerformanceBucket): void {
  for (const key of Object.keys(target) as (keyof PerformanceBucket)[]) {
    target[key] += source[key];
  }
}

/**
 * Turn a bucket into the wire model, deriving the three headline metrics:
 * occupancy (sold over house), ADR (room revenue per sold room) and RevPAR
 * (room revenue per available room).
 */
function performanceBody(bucket: PerformanceBucket, currency: string, extra: Record<string, unknown> = {}) {
  const grossUnitRevenue = bucket.grossAccommodation;
  const netUnitRevenue = bucket.netAccommodation;
  const mv = (amount: number): MonetaryValue => money(amount, currency);
  return {
    ...extra,
    houseCount: bucket.houseCount,
    houseItemsCount: bucket.houseItemsCount,
    soldCount: bucket.soldCount,
    soldItemsCount: bucket.soldItemsCount,
    unsoldCount: bucket.unsoldCount,
    unsoldItemsCount: bucket.unsoldItemsCount,
    outOfOrderCount: bucket.outOfOrderCount,
    outOfOrderItemsCount: bucket.outOfOrderItemsCount,
    tentativelyBlockedCount: bucket.tentativelyBlockedCount,
    tentativelyBlockedItemsCount: bucket.tentativelyBlockedItemsCount,
    definitelyBlockedCount: bucket.definitelyBlockedCount,
    optionallyBlockedCount: bucket.optionallyBlockedCount,
    arrivalsCount: bucket.arrivalsCount,
    departuresCount: bucket.departuresCount,
    noShowsCount: bucket.noShowsCount,
    cancellationsCount: bucket.cancellationsCount,
    occupancyPercentage: bucket.houseCount === 0 ? 0 : round((bucket.soldCount / bucket.houseCount) * 100, currency),
    grossUnitRevenue: mv(grossUnitRevenue),
    netUnitRevenue: mv(netUnitRevenue),
    grossAccommodationRevenue: mv(bucket.grossAccommodation),
    netAccommodationRevenue: mv(bucket.netAccommodation),
    grossFoodAndBeveragesRevenue: mv(bucket.grossFoodAndBeverages),
    netFoodAndBeveragesRevenue: mv(bucket.netFoodAndBeverages),
    grossOtherRevenue: mv(bucket.grossOther),
    netOtherRevenue: mv(bucket.netOther),
    grossAdr: mv(bucket.soldCount === 0 ? 0 : grossUnitRevenue / bucket.soldCount),
    netAdr: mv(bucket.soldCount === 0 ? 0 : netUnitRevenue / bucket.soldCount),
    revPar: mv(bucket.houseCount === 0 ? 0 : grossUnitRevenue / bucket.houseCount),
  };
}

api.op('ReportsReportsProperty-performanceGet', (req, res) => {
  const property = getProperty(requiredStringParam(req, 'propertyId'));
  const from = requiredDateParam(req, 'from');
  const to = requiredDateParam(req, 'to');
  if (to < from) throw unprocessable('`to` must not be before `from`.');
  const expand = new Set(arrayParam(req, 'expand'));
  const langs = languagesOf(arrayParam(req, 'languages'), property.id);
  const currency = property.currencyCode;
  const matches = reservationScope(req);

  // Reporting counts completed stays, otherwise any past night reads as empty.
  const snapshot = new AvailabilitySnapshot(property, from, addDays(to, 1), { includeCompleted: true });
  const groups = snapshot.unitGroups().filter((g) => {
    const unitGroupIds = arrayParam(req, 'unitGroupIds');
    const unitGroupTypes = arrayParam(req, 'unitGroupTypes');
    if (unitGroupIds.length && !unitGroupIds.includes(g.id)) return false;
    if (unitGroupTypes.length && !unitGroupTypes.includes(g.type)) return false;
    return true;
  });

  const reservations = db.reservations.all({ propertyId: property.id }).filter(matches);
  const chargesByDate = groupChargesByDate(property, reservations);

  const overall = emptyBucket();
  const businessDays = datesInclusive(from, to).map((date) => {
    const perGroup = groups.map((group) => {
      const bucket = bucketFor(snapshot, group.id, date, reservations, chargesByDate);
      return { group, bucket };
    });
    const dayBucket = emptyBucket();
    for (const { bucket } of perGroup) addBucket(dayBucket, bucket);
    addBucket(overall, dayBucket);
    return performanceBody(dayBucket, currency, {
      businessDay: date,
      unitGroups: expand.has('unitGroups')
        ? perGroup.map(({ group, bucket }) => performanceBody(bucket, currency, {
          unitGroup: embeddedUnitGroup(group.id, langs),
        }))
        : [],
    });
  });

  res.json(performanceBody(overall, currency, { businessDays }));
});

/** Build the reservation filter the report parameters describe. */
function reservationScope(req: Parameters<typeof arrayParam>[0]): (r: Reservation) => boolean {
  const companyIds = arrayParam(req, 'companyIds');
  const ratePlanIds = arrayParam(req, 'ratePlanIds');
  const channelCodes = arrayParam(req, 'channelCodes');
  const sources = arrayParam(req, 'sources');
  const marketSegmentIds = arrayParam(req, 'marketSegmentIds');
  const travelPurpose = stringParam(req, 'travelPurpose');
  const timeSliceDefinitionIds = arrayParam(req, 'timeSliceDefinitionIds');

  return (r) => {
    if (companyIds.length && (!r.companyId || !companyIds.includes(r.companyId))) return false;
    if (ratePlanIds.length && !ratePlanIds.includes(r.ratePlanId)) return false;
    if (channelCodes.length && !channelCodes.includes(r.channelCode)) return false;
    if (sources.length && (!r.source || !sources.includes(r.source))) return false;
    if (marketSegmentIds.length && (!r.marketSegmentId || !marketSegmentIds.includes(r.marketSegmentId))) return false;
    if (travelPurpose && r.travelPurpose !== travelPurpose) return false;
    if (timeSliceDefinitionIds.length) {
      const plan = db.ratePlans.get(r.ratePlanId);
      if (!plan || !timeSliceDefinitionIds.includes(plan.timeSliceDefinitionId)) return false;
    }
    return true;
  };
}

interface DateCharges {
  grossAccommodation: number;
  netAccommodation: number;
  grossFoodAndBeverages: number;
  netFoodAndBeverages: number;
  grossOther: number;
  netOther: number;
}

/** Posted revenue for the reservations in scope, keyed by unit group and date. */
function groupChargesByDate(property: Property, reservations: readonly Reservation[]) {
  const byReservation = new Map(reservations.map((r) => [r.id, r]));
  const out = new Map<string, DateCharges>();

  for (const charge of db.charges.all({ propertyId: property.id })) {
    if (!charge.reservationId) continue;
    const reservation = byReservation.get(charge.reservationId);
    if (!reservation) continue;
    const unitGroupId = reservation.timeSlices.find((t) => t.serviceDate === charge.serviceDate)?.unitGroupId
      ?? reservation.unitGroupId;
    const key = `${unitGroupId}|${charge.serviceDate}`;
    const entry = out.get(key) ?? {
      grossAccommodation: 0, netAccommodation: 0,
      grossFoodAndBeverages: 0, netFoodAndBeverages: 0,
      grossOther: 0, netOther: 0,
    };
    applyCharge(entry, charge);
    out.set(key, entry);
  }
  return out;
}

function applyCharge(entry: DateCharges, charge: Charge): void {
  switch (charge.serviceType) {
    case 'Accommodation':
      entry.grossAccommodation += charge.amount.grossAmount;
      entry.netAccommodation += charge.amount.netAmount;
      break;
    case 'FoodAndBeverages':
      entry.grossFoodAndBeverages += charge.amount.grossAmount;
      entry.netFoodAndBeverages += charge.amount.netAmount;
      break;
    default:
      entry.grossOther += charge.amount.grossAmount;
      entry.netOther += charge.amount.netAmount;
      break;
  }
}

function bucketFor(
  snapshot: AvailabilitySnapshot,
  unitGroupId: string,
  date: string,
  reservations: readonly Reservation[],
  chargesByDate: Map<string, DateCharges>,
): PerformanceBucket {
  const group = db.unitGroups.get(unitGroupId);
  const bucket = emptyBucket();
  if (!group) return bucket;

  const availability = snapshot.forGroup(group, date);
  bucket.houseCount = availability.houseCount;
  bucket.houseItemsCount = availability.houseCount;
  bucket.soldCount = availability.soldCount;
  bucket.soldItemsCount = availability.soldCount;
  bucket.unsoldCount = availability.sellableCount;
  bucket.unsoldItemsCount = availability.sellableCount;
  bucket.outOfOrderCount = availability.maintenance.outOfOrder + availability.maintenance.outOfService;
  bucket.outOfOrderItemsCount = bucket.outOfOrderCount;
  bucket.tentativelyBlockedCount = availability.block.tentative;
  bucket.tentativelyBlockedItemsCount = availability.block.tentative;
  bucket.definitelyBlockedCount = availability.block.definite;
  bucket.optionallyBlockedCount = availability.block.optional;

  for (const r of reservations) {
    const inGroup = r.unitGroupId === unitGroupId
      || r.timeSlices.some((t) => t.unitGroupId === unitGroupId);
    if (!inGroup) continue;
    if (r.arrivalDate === date && r.status !== 'Canceled' && r.status !== 'NoShow') bucket.arrivalsCount += 1;
    if (r.departureDate === date && (r.status === 'CheckedOut' || isActive(r))) bucket.departuresCount += 1;
    if (r.status === 'NoShow' && r.arrivalDate === date) bucket.noShowsCount += 1;
    if (r.status === 'Canceled' && r.cancellationTime?.slice(0, 10) === date) bucket.cancellationsCount += 1;
  }

  const charges = chargesByDate.get(`${unitGroupId}|${date}`);
  if (charges) {
    bucket.grossAccommodation = charges.grossAccommodation;
    bucket.netAccommodation = charges.netAccommodation;
    bucket.grossFoodAndBeverages = charges.grossFoodAndBeverages;
    bucket.netFoodAndBeverages = charges.netFoodAndBeverages;
    bucket.grossOther = charges.grossOther;
    bucket.netOther = charges.netOther;
  }
  return bucket;
}

/* ------------------------------------------------------------- revenues */

api.op('ReportsReportsRevenuesGet', (req, res) => {
  const property = getProperty(requiredStringParam(req, 'propertyId'));
  const from = requiredDateParam(req, 'from');
  const to = requiredDateParam(req, 'to');
  const langs = [stringParam(req, 'languageCode') ?? 'en'];
  const currency = property.currencyCode;

  // Roll postings up the chart of accounts so parents carry their children.
  const accounts = db.financeAccounts.all({ propertyId: property.id, scope: 'Global' });
  const direct = new Map<string, { gross: number; net: number }>();
  for (const charge of db.charges.all({ propertyId: property.id })) {
    if (charge.serviceDate < from || charge.serviceDate > to) continue;
    const number = charge.subAccountId ?? 'UNASSIGNED';
    const entry = direct.get(number) ?? { gross: 0, net: 0 };
    entry.gross += charge.amount.grossAmount;
    entry.net += charge.amount.netAmount;
    direct.set(number, entry);
  }

  const byNumber = new Map(accounts.map((a) => [a.number, a]));
  const childrenOf = new Map<string, string[]>();
  for (const a of accounts) {
    if (!a.parentNumber) continue;
    const list = childrenOf.get(a.parentNumber) ?? [];
    list.push(a.number);
    childrenOf.set(a.parentNumber, list);
  }

  const build = (number: string): { node: Record<string, unknown>; gross: number; net: number } => {
    const account = byNumber.get(number)!;
    const own = direct.get(number) ?? { gross: 0, net: 0 };
    let gross = own.gross;
    let net = own.net;
    const children = (childrenOf.get(number) ?? []).map((child) => {
      const built = build(child);
      gross += built.gross;
      net += built.net;
      return built.node;
    });
    return {
      gross,
      net,
      node: {
        account: {
          number: account.number,
          name: resolveLocalized(account.name, langs),
          type: account.type,
        },
        netAmount: money(net, currency),
        grossAmount: money(gross, currency),
        children: children.length ? children : undefined,
      },
    };
  };

  const roots = accounts.filter((a) => !a.parentNumber && a.type === 'Revenues');
  const trees = roots.map((a) => build(a.number).node);
  // The endpoint is documented as returning a single tree; revenue is the root.
  res.json(trees[0] ?? {
    account: { number: '1000', name: 'Revenues', type: 'Revenues' },
    netAmount: money(0, currency),
    grossAmount: money(0, currency),
    children: [],
  });
});

/* ---------------------------------------------------- company invoice VAT */

api.op('ReportsReportsCompany-invoices-vatGet', (req, res) => {
  const property = getProperty(requiredStringParam(req, 'propertyId'));
  const companyIds = arrayParam(req, 'companyIds');
  const dateFilters = arrayParam(req, 'dateFilter');
  const page = paging(req);
  const currency = property.currencyCode;

  const rows = db.invoices
    .all({ propertyId: property.id })
    .filter((invoice) => {
      // Cancellation documents net out against their original, so they are
      // reported alongside it rather than filtered away.
      const folio = db.folios.get(invoice.folioId);
      if (!folio?.companyId) return false;
      if (companyIds.length && !companyIds.includes(folio.companyId)) return false;
      return matchesDateExpressions(invoice.invoiceDate, dateFilters);
    })
    .map((invoice) => {
      const folio = db.folios.get(invoice.folioId);
      const company = folio?.companyId ? db.companies.get(folio.companyId) : undefined;
      const vatByRate = new Map<number, { net: number; tax: number }>();
      for (const item of invoice.lineItems) {
        const gross = item.price.amount;
        const net = gross / (1 + item.vatPercent / 100);
        const entry = vatByRate.get(item.vatPercent) ?? { net: 0, tax: 0 };
        entry.net += net;
        entry.tax += gross - net;
        vatByRate.set(item.vatPercent, entry);
      }
      return {
        invoiceNumber: invoice.number,
        invoiceDate: invoice.invoiceDate,
        company: company ? { id: company.id, code: company.code, name: company.name } : undefined,
        grossAmount: money(invoice.total, currency),
        netAmount: money(invoice.netTotal, currency),
        vat: [...vatByRate.entries()]
          .sort((a, b) => a[0] - b[0])
          .map(([vatPercent, v]) => ({
            vatPercent,
            net: money(v.net, currency),
            tax: money(v.tax, currency),
          })),
      };
    })
    .sort((a, b) => a.invoiceDate.localeCompare(b.invoiceDate));

  sendList(res, 'companyInvoices', rows.slice(page.offset, page.offset + page.pageSize), rows.length);
});

/** Shared `OP_VALUE` filter syntax, as used by the Logs API. */
function matchesDateExpressions(value: string, expressions: readonly string[]): boolean {
  if (!expressions.length) return true;
  return expressions.every((raw) => {
    const separator = raw.indexOf('_');
    if (separator === -1) throw unprocessable(`'${raw}' is not a valid filter expression.`);
    const op = raw.slice(0, separator);
    const other = raw.slice(separator + 1);
    const a = value.slice(0, other.length);
    switch (op) {
      case 'eq': return a === other;
      case 'neq': return a !== other;
      case 'lt': return a < other;
      case 'lte': return a <= other;
      case 'gt': return a > other;
      case 'gte': return a >= other;
      default: throw unprocessable(`'${op}' is not a supported operation.`);
    }
  });
}

export const reportsRouter = api.build();
