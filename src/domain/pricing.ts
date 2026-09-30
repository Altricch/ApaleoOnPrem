import { addDays, atLocalTime, dayOfWeek, diffDays, nightsBetween } from '../core/dates';
import {
  DEFAULT_VAT_RATES, grossToAmount, money, round, type AmountModel, type MonetaryValue, type VatType,
} from '../core/money';
import { resolveLocalized } from '../core/localized';
import { db } from './repo';
import type {
  AccountingConfig, AgeCategory, CancellationPolicy, CityTax, FeeDetails, NoShowPolicy,
  Period, PriceCalculationMode, Property, RatePlan, Rate, Service, ServiceType,
  TimeSliceDefinition, UnitGroup,
} from './types';

/**
 * The pricing engine: turns a rate plan plus a stay into the priced time
 * slices, services, taxes and policy fees that a quote or a reservation needs.
 *
 * The order of operations matters and mirrors apaleo:
 *
 *   1. resolve the nightly rate (walking the derivation chain if the plan is
 *      derived from another one)
 *   2. add the occupancy surcharge for the adult count, then per-child
 *      surcharges from the age categories
 *   3. split out the price of services whose pricing mode is `Included`, so
 *      accommodation revenue is not overstated
 *   4. add `Additional` services on top
 *   5. compute city tax on the resulting base
 *   6. derive the cancellation and no-show fees from the policies
 */

export type ValidationCode =
  | 'UnitGroupFullyBooked'
  | 'UnitGroupCapacityExceeded'
  | 'RatePlanRestrictionsViolated'
  | 'RatePlanSurchargesNotSet'
  | 'RateRestrictionsViolated'
  | 'RatePlanChannelNotSet'
  | 'RatesNotSet'
  | 'BlockFullyBooked'
  | 'IncludedServicesAmountExceededRateAmount'
  | 'ServiceFullyBooked';

export interface ValidationMessage {
  code: ValidationCode;
  message: string;
}

export interface PricedIncludedService {
  serviceId: string;
  amount: AmountModel;
  count: number;
}

export interface PricedTimeSlice {
  serviceDate: string;
  from: string;
  to: string;
  ratePlanId: string;
  unitGroupId: string;
  /** Accommodation revenue after included services are carved out. */
  baseAmount: AmountModel;
  /** What the guest is charged for the night in total. */
  totalGrossAmount: MonetaryValue;
  includedServices: PricedIncludedService[];
}

export interface PricedServiceDate {
  serviceDate: string;
  amount: AmountModel;
  count: number;
  isMandatory: boolean;
  isDefaultDate: boolean;
}

export interface PricedService {
  serviceId: string;
  count: number;
  totalAmount: AmountModel;
  dates: PricedServiceDate[];
}

export interface PricedCityTax {
  cityTaxId: string;
  code: string;
  name: string;
  totalGrossAmount: MonetaryValue;
  dates: { serviceDate: string; amount: AmountModel }[];
}

export interface TaxDetail {
  vatType: VatType;
  vatPercent: number;
  net: MonetaryValue;
  tax: MonetaryValue;
}

export interface PriceRequest {
  property: Property;
  ratePlan: RatePlan;
  arrival: string;
  departure: string;
  adults: number;
  childrenAges: number[];
  channelCode?: string;
  promoCode?: string;
  corporateCode?: string;
  companyId?: string;
  /** Per-date manual overrides, as the rate-plan-offers endpoint allows. */
  overridePrices?: Map<string, number>;
  /** Skip city tax, e.g. when a reservation has had it removed. */
  withoutCityTax?: boolean;
  /** Extra services the guest booked on top of the rate plan. */
  extraServices?: { serviceId: string; dates?: string[] }[];
}

export interface PricedStay {
  ratePlan: RatePlan;
  unitGroup: UnitGroup;
  timeSliceDefinition: TimeSliceDefinition;
  arrival: string;
  departure: string;
  arrivalDateTime: string;
  departureDateTime: string;
  currency: string;
  timeSlices: PricedTimeSlice[];
  services: PricedService[];
  cityTaxes: PricedCityTax[];
  totalGrossAmount: MonetaryValue;
  taxDetails: TaxDetail[];
  cancellationFee: { policy?: CancellationPolicy; dueDateTime?: string; fee: MonetaryValue };
  noShowFee: { policy?: NoShowPolicy; fee: MonetaryValue };
  prePaymentAmount: MonetaryValue;
  validationMessages: ValidationMessage[];
}

/* --------------------------------------------------------------- rates */

const rateId = (ratePlanId: string, date: string) => `${ratePlanId}|${date}`;

export function rateFor(ratePlanId: string, date: string): Rate | undefined {
  return db.rates.get(rateId(ratePlanId, date));
}

export function putRate(rate: Omit<Rate, 'id'>): Rate {
  const full: Rate = { ...rate, id: rateId(rate.ratePlanId, rate.date) };
  db.rates.put(full);
  return full;
}

/**
 * Resolve a nightly price, following the derivation chain when the rate plan
 * takes its prices from another one. A cycle or a missing base price yields
 * `undefined`, which surfaces to the caller as `RatesNotSet`.
 */
export function resolvePrice(ratePlan: RatePlan, date: string, seen = new Set<string>()): number | undefined {
  if (seen.has(ratePlan.id)) return undefined;
  seen.add(ratePlan.id);

  const own = rateFor(ratePlan.id, date);
  if (own) return own.price;

  if (ratePlan.isDerived && ratePlan.pricingRule) {
    const base = db.ratePlans.get(ratePlan.pricingRule.baseRatePlanId);
    if (!base) return undefined;
    const basePrice = resolvePrice(base, date, seen);
    if (basePrice === undefined) return undefined;
    return applyModifier(basePrice, ratePlan.pricingRule.type, ratePlan.pricingRule.value, ratePlan.priceCalculationMode);
  }
  return undefined;
}

/** The effective restrictions for a date, inherited from the base plan. */
export function resolveRestrictions(ratePlan: RatePlan, date: string, seen = new Set<string>()) {
  if (seen.has(ratePlan.id)) return undefined;
  seen.add(ratePlan.id);
  const own = rateFor(ratePlan.id, date);
  if (own) return own.restrictions;
  if (ratePlan.isDerived && ratePlan.pricingRule) {
    const base = db.ratePlans.get(ratePlan.pricingRule.baseRatePlanId);
    if (base) return resolveRestrictions(base, date, seen);
  }
  return undefined;
}

/**
 * Apply a percent or absolute modifier.
 *
 * `Truncate` drops the fractional part of the *modifier* (apaleo's documented
 * example: 125.99 + 10% becomes 125.99 + 12 = 137.99), while `Round` keeps it
 * to the currency's precision (125.99 + 12.60 = 138.59).
 */
export function applyModifier(
  base: number,
  type: 'Absolute' | 'Percent',
  value: number,
  mode: PriceCalculationMode,
): number {
  const raw = type === 'Percent' ? (base * value) / 100 : value;
  const delta = mode === 'Round' ? Math.round(raw * 100) / 100 : Math.trunc(raw);
  return Math.round((base + delta) * 100) / 100;
}

/* ------------------------------------------------------- accounting config */

/** The accounting config in force on a date - the latest one that has started. */
export function configFor(configs: readonly AccountingConfig[], date: string, fallback: ServiceType): AccountingConfig {
  const applicable = configs
    .filter((c) => c.validFrom <= date)
    .sort((a, b) => b.validFrom.localeCompare(a.validFrom));
  return applicable[0] ?? { vatType: 'Normal', serviceType: fallback, validFrom: '1970-01-01' };
}

export function vatRatesFor(_property: Property): Record<VatType, number> {
  // Per-country VAT tables would live here; the German rates apaleo's demo
  // data uses are the default.
  return DEFAULT_VAT_RATES;
}

/* ------------------------------------------------------------ surcharges */

/**
 * Surcharge for a total adult count. apaleo requires an explicit entry for
 * each occupancy a rate plan is sold at; single occupancy never carries one.
 */
export function surchargeFor(ratePlan: RatePlan, adults: number): { value: number; type: 'Absolute' | 'Percent' } | undefined | 'missing' {
  if (adults <= 1) return undefined;
  const exact = ratePlan.surcharges.find((s) => s.adults === adults);
  if (exact) return { value: exact.value, type: exact.type };
  const lower = ratePlan.surcharges
    .filter((s) => s.adults < adults)
    .sort((a, b) => b.adults - a.adults)[0];
  return lower ? 'missing' : 'missing';
}

/** Which age category a child's age falls into, for the property. */
export function ageCategoryFor(propertyId: string, age: number): AgeCategory | undefined {
  return db.ageCategories
    .all({ propertyId })
    .find((c) => age >= c.minAge && age <= c.maxAge);
}

/** Per-child surcharge from the rate plan's age category configuration. */
function childSurcharge(ratePlan: RatePlan, propertyId: string, age: number, adults: number): number {
  const category = ageCategoryFor(propertyId, age);
  if (!category) return 0;
  const config = ratePlan.ageCategories.find((a) => a.ageCategoryId === category.id);
  if (!config) return 0;
  const exact = config.surcharges.find((s) => s.adults === adults);
  if (exact) return exact.value;
  const lower = config.surcharges.filter((s) => s.adults <= adults).sort((a, b) => b.adults - a.adults)[0];
  return lower?.value ?? 0;
}

/* -------------------------------------------------------------- services */

/** Is a service deliverable on this date given its availability mode? */
export function serviceAppliesOn(
  service: Service,
  date: string,
  arrival: string,
  departure: string,
): boolean {
  const { mode, daysOfWeek } = service.availability;
  if (daysOfWeek?.length && !daysOfWeek.includes(dayOfWeek(date))) return false;
  switch (mode) {
    case 'Arrival':
      return date === arrival;
    case 'Departure':
      return date === departure;
    case 'Daily':
    default:
      return date >= arrival && date < departure;
  }
}

/** Dates a service is offered on by default across a stay. */
export function serviceDates(service: Service, arrival: string, departure: string): string[] {
  const candidates = service.availability.mode === 'Departure'
    ? [departure]
    : [...nightsBetween(arrival, departure)];
  return candidates.filter((d) => serviceAppliesOn(service, d, arrival, departure));
}

/** How many units of a service a stay consumes on a date. */
export function serviceCount(service: Service, adults: number, childrenAges: readonly number[]): number {
  if (service.pricingUnit === 'Room') return 1;
  // Person pricing: an age-category-specific service only counts matching
  // children, otherwise every occupant is counted.
  if (service.ageCategoryId) {
    return childrenAges.filter((age) => {
      const cat = ageCategoryFor(service.propertyId, age);
      return cat?.id === service.ageCategoryId;
    }).length;
  }
  return adults + childrenAges.length;
}

/* ------------------------------------------------------------- city tax */

/**
 * Should this tax be skipped for the booking's channel/source?
 * `ignoredFor` lists channel configurations the tax does not apply to - the
 * usual case being an OTA that remits the tax itself.
 */
function taxIsIgnored(tax: CityTax, channelCode?: string, source?: string): boolean {
  return tax.ignoredFor.some((rule) => {
    const dc = rule.distributionChannel;
    if (!dc) return false;
    if (dc.channelCode !== channelCode) return false;
    if (dc.sources?.length) return !!source && dc.sources.includes(source);
    return true;
  });
}

/** The nightly amount a single guest's tax is computed from. */
function perPersonBase(tax: CityTax, slice: PricedTimeSlice, persons: number): number {
  if (persons <= 0) return 0;
  const gross = tax.type === 'PerPersonPerNightBasedOnNetPrice'
    ? slice.baseAmount.netAmount
    : slice.baseAmount.grossAmount;
  return gross / persons;
}

/**
 * Pricing rules give a flat tax for room prices up to a threshold - the
 * banded structure many German and Italian city taxes use. The first band
 * whose `maxPrice` covers the price wins.
 */
function bandedValue(tax: CityTax, price: number): number | undefined {
  const band = [...tax.pricingRules]
    .sort((a, b) => a.maxPrice - b.maxPrice)
    .find((r) => price <= r.maxPrice);
  return band?.value;
}

/** A reduced flat rate for a guest of a given age, if one is configured. */
function subcategoryValue(tax: CityTax, age: number): number | undefined {
  return tax.subcategories.find((sc) => age >= sc.age.min && age <= sc.age.max)?.value;
}

/**
 * Compute city taxes for a stay.
 *
 * The base is the accommodation charge for the night - services are not part
 * of it, which is why the v1 city tax model has no service configuration.
 * Taxes are evaluated in `priority` order so the lower-numbered ones are
 * listed and posted first.
 */
export function priceCityTaxes(
  property: Property,
  slices: readonly PricedTimeSlice[],
  adults: number,
  childrenAges: readonly number[],
  langs: readonly string[],
  context: { channelCode?: string; source?: string } = {},
): PricedCityTax[] {
  const taxes = db.cityTaxes
    .all({ propertyId: property.id })
    .filter((t) => !taxIsIgnored(t, context.channelCode, context.source))
    .sort((a, b) => a.priority - b.priority);
  if (!taxes.length) return [];

  const currency = property.currencyCode;
  const out: PricedCityTax[] = [];

  for (const tax of taxes) {
    const dates: { serviceDate: string; amount: AmountModel }[] = [];

    slices.forEach((slice, index) => {
      if (tax.limit !== undefined && index >= tax.limit) return;

      const gross = grossForNight(tax, slice, adults, childrenAges);
      if (gross <= 0) return;

      // `BeforeTax` means the configured value excludes VAT, so VAT is added
      // on top; `AfterTax` means the value already contains it.
      const vatPercent = DEFAULT_VAT_RATES[tax.vatType] ?? 0;
      const amount = tax.taxHandlingType === 'BeforeTax'
        ? grossToAmount(gross * (1 + vatPercent / 100), tax.vatType, currency)
        : grossToAmount(gross, tax.vatType, currency);

      dates.push({ serviceDate: slice.serviceDate, amount });
    });

    if (!dates.length) continue;
    out.push({
      cityTaxId: tax.id,
      code: tax.code,
      name: resolveLocalized(tax.name, langs) ?? tax.code,
      totalGrossAmount: money(dates.reduce((a, d) => a + d.amount.grossAmount, 0), currency),
      dates,
    });
  }
  return out;
}

function grossForNight(
  tax: CityTax,
  slice: PricedTimeSlice,
  adults: number,
  childrenAges: readonly number[],
): number {
  switch (tax.type) {
    case 'PerRoomPerNight': {
      const banded = bandedValue(tax, slice.baseAmount.grossAmount);
      return banded ?? tax.value;
    }
    case 'PerPersonPerNight': {
      // Adults pay the headline value; children may fall into a subcategory.
      let total = adults * tax.value;
      for (const age of childrenAges) {
        const reduced = subcategoryValue(tax, age);
        total += reduced ?? tax.value;
      }
      return total;
    }
    case 'PerPersonPerNightBasedOnNetPrice':
    case 'PerPersonPerNightBasedOnGrossPrice': {
      const persons = adults + childrenAges.length;
      const base = perPersonBase(tax, slice, persons);
      const perAdult = bandedValue(tax, base) ?? (base * tax.value) / 100;
      let total = adults * perAdult;
      for (const age of childrenAges) {
        const reduced = subcategoryValue(tax, age);
        total += reduced ?? perAdult;
      }
      return total;
    }
    case 'PercentOfNet':
      return (slice.baseAmount.netAmount * tax.value) / 100;
    case 'PercentOfGross':
    default:
      return (slice.baseAmount.grossAmount * tax.value) / 100;
  }
}

/* ----------------------------------------------------------- policy fees */

function periodToHours(p: Period | undefined): number {
  if (!p) return 0;
  return (p.months ?? 0) * 24 * 30 + (p.days ?? 0) * 24 + (p.hours ?? 0);
}

/**
 * The instant from which a cancellation becomes chargeable.
 * `PriorToArrival` counts back from arrival; `AfterBooking` counts forward
 * from when the booking was made.
 */
export function cancellationDueDate(
  policy: CancellationPolicy,
  arrivalDateTime: string,
  bookedAt: string,
): string {
  const hours = periodToHours(policy.periodFromReference);
  const anchor = policy.reference === 'AfterBooking' ? new Date(bookedAt) : new Date(arrivalDateTime);
  const sign = policy.reference === 'AfterBooking' ? 1 : -1;
  return new Date(anchor.getTime() + sign * hours * 3600_000).toISOString();
}

/** Evaluate a fixed-or-percentage fee against the priced stay. */
export function evaluateFee(
  fee: FeeDetails | undefined,
  slices: readonly PricedTimeSlice[],
  services: readonly PricedService[],
  currency: string,
): MonetaryValue {
  if (!fee) return money(0, currency);
  if (fee.fixedValue) return money(fee.fixedValue.amount, fee.fixedValue.currency || currency);
  const pct = fee.percentValue;
  if (!pct) return money(0, currency);

  const considered = pct.limit ? slices.slice(0, pct.limit) : slices;
  let base = considered.reduce((sum, s) => sum + s.baseAmount.grossAmount, 0);
  if (pct.includeServiceIds.length) {
    const dates = new Set(considered.map((s) => s.serviceDate));
    for (const s of services) {
      if (!pct.includeServiceIds.includes(s.serviceId)) continue;
      for (const d of s.dates) {
        if (dates.has(d.serviceDate)) base += d.amount.grossAmount;
      }
    }
  }
  return money((base * pct.percent) / 100, currency);
}

/* ------------------------------------------------------------- tax split */

/** Roll charges up into the per-VAT-rate breakdown apaleo reports. */
export function taxDetailsOf(amounts: readonly AmountModel[], currency: string): TaxDetail[] {
  const byType = new Map<string, { vatType: VatType; vatPercent: number; net: number; tax: number }>();
  for (const a of amounts) {
    if (!a) continue;
    const key = `${a.vatType}|${a.vatPercent}`;
    const entry = byType.get(key) ?? { vatType: a.vatType, vatPercent: a.vatPercent, net: 0, tax: 0 };
    entry.net += a.netAmount;
    entry.tax += a.grossAmount - a.netAmount;
    byType.set(key, entry);
  }
  return [...byType.values()]
    .map((e) => ({
      vatType: e.vatType,
      vatPercent: e.vatPercent,
      net: money(e.net, currency),
      tax: money(e.tax, currency),
    }))
    .filter((d) => d.net.amount !== 0 || d.tax.amount !== 0)
    .sort((a, b) => a.vatPercent - b.vatPercent);
}

/* ------------------------------------------------------------ main entry */

/**
 * Price a stay. Always returns a result: when something is wrong (no rates
 * loaded, restrictions violated, occupancy over capacity) the problem is
 * reported through `validationMessages` rather than as an error, which is what
 * lets the offers endpoint return unavailable offers on request.
 */
export function priceStay(req: PriceRequest): PricedStay {
  const { property, ratePlan, arrival, departure, adults, childrenAges } = req;
  const currency = property.currencyCode;
  const langs = ['en'];
  const messages: ValidationMessage[] = [];

  const unitGroup = db.unitGroups.get(ratePlan.unitGroupId);
  const tsd = db.timeSliceDefinitions.get(ratePlan.timeSliceDefinitionId);
  const checkInTime = tsd?.checkInTime ?? property.defaultCheckInTime;
  const checkOutTime = tsd?.checkOutTime ?? property.defaultCheckOutTime;

  const nights = nightsBetween(arrival, departure);
  const lengthOfStay = Math.max(1, diffDays(arrival, departure));

  if (unitGroup && adults + childrenAges.length > unitGroup.maxPersons) {
    messages.push({
      code: 'UnitGroupCapacityExceeded',
      message: `The unit group '${unitGroup.id}' holds at most ${unitGroup.maxPersons} person(s).`,
    });
  }
  if (req.channelCode && ratePlan.channelCodes.length && !ratePlan.channelCodes.includes(req.channelCode as any)) {
    messages.push({
      code: 'RatePlanChannelNotSet',
      message: `The rate plan is not sold through channel '${req.channelCode}'.`,
    });
  }
  checkBookingRestrictions(ratePlan, arrival, messages);

  const surcharge = surchargeFor(ratePlan, adults);
  if (surcharge === 'missing') {
    messages.push({
      code: 'RatePlanSurchargesNotSet',
      message: `The rate plan has no surcharge configured for ${adults} adults.`,
    });
  }

  const accommodationConfig = configFor(ratePlan.accountingConfigs, arrival, 'Accommodation');

  /* --- 1-3: nightly rate, surcharges, included services ---------------- */

  const includedServiceDefs = ratePlan.includedServices
    .map((s) => ({ config: s, service: db.services.get(s.serviceId) }))
    .filter((x): x is { config: typeof x.config; service: Service } => !!x.service);

  const timeSlices: PricedTimeSlice[] = [];
  let missingRates = false;

  for (const date of nights) {
    const override = req.overridePrices?.get(date);
    const listPrice = override ?? resolvePrice(ratePlan, date);
    if (listPrice === undefined) {
      missingRates = true;
      continue;
    }
    const restrictions = resolveRestrictions(ratePlan, date);
    checkRateRestrictions(restrictions, date, arrival, departure, lengthOfStay, messages);

    // Occupancy surcharges.
    let total = listPrice;
    if (surcharge && surcharge !== 'missing') {
      total = applyModifier(listPrice, surcharge.type, surcharge.value, ratePlan.priceCalculationMode);
    }
    for (const age of childrenAges) {
      total += childSurcharge(ratePlan, property.id, age, adults);
    }
    total = round(total, currency);

    // Carve out services that are priced as part of the rate.
    const included: PricedIncludedService[] = [];
    let includedTotal = 0;
    for (const { config, service } of includedServiceDefs) {
      if (config.pricingMode !== 'Included') continue;
      if (!serviceAppliesOn(service, date, arrival, departure)) continue;
      const count = serviceCount(service, adults, childrenAges);
      if (count === 0) continue;
      const gross = round(config.grossPrice * count, currency);
      const svcConfig = configFor(service.accountingConfigs, date, 'Other');
      included.push({
        serviceId: service.id,
        count,
        amount: grossToAmount(gross, svcConfig.vatType, currency),
      });
      includedTotal += gross;
    }

    if (includedTotal > total) {
      messages.push({
        code: 'IncludedServicesAmountExceededRateAmount',
        message: `Included services (${includedTotal}) exceed the rate for ${date} (${total}).`,
      });
      includedTotal = total;
    }

    const accommodationGross = round(total - includedTotal, currency);
    timeSlices.push({
      serviceDate: date,
      from: atLocalTime(date, checkInTime, property.timeZone),
      to: atLocalTime(addDays(date, 1), checkOutTime, property.timeZone),
      ratePlanId: ratePlan.id,
      unitGroupId: ratePlan.unitGroupId,
      baseAmount: grossToAmount(accommodationGross, accommodationConfig.vatType, currency),
      totalGrossAmount: money(total, currency),
      includedServices: included,
    });
  }

  if (missingRates) {
    messages.push({ code: 'RatesNotSet', message: 'No rates are defined for part of the requested stay.' });
  }

  /* --- 4: additional services ------------------------------------------ */

  const services: PricedService[] = [];

  for (const { config, service } of includedServiceDefs) {
    if (config.pricingMode !== 'Additional') continue;
    const priced = priceService(service, arrival, departure, adults, childrenAges, currency, config.grossPrice, true);
    if (priced) services.push(priced);
  }
  for (const extra of req.extraServices ?? []) {
    const service = db.services.get(extra.serviceId);
    if (!service) continue;
    if (services.some((s) => s.serviceId === service.id)) continue;
    const priced = priceService(
      service, arrival, departure, adults, childrenAges, currency, service.defaultGrossPrice, false, extra.dates,
    );
    if (priced) services.push(priced);
  }

  /* --- 5: city tax ------------------------------------------------------ */

  const cityTaxes = req.withoutCityTax || !ratePlan.isSubjectToCityTax
    ? []
    : priceCityTaxes(property, timeSlices, adults, childrenAges, langs, {
      channelCode: req.channelCode,
    });

  /* --- 6: policy fees --------------------------------------------------- */

  const arrivalDateTime = atLocalTime(arrival, checkInTime, property.timeZone);
  const departureDateTime = atLocalTime(departure, checkOutTime, property.timeZone);

  const cancellationPolicy = ratePlan.cancellationPolicyId
    ? db.cancellationPolicies.get(ratePlan.cancellationPolicyId)
    : undefined;
  const noShowPolicy = ratePlan.noShowPolicyId ? db.noShowPolicies.get(ratePlan.noShowPolicyId) : undefined;

  const cancellationFee = {
    policy: cancellationPolicy,
    dueDateTime: cancellationPolicy
      ? cancellationDueDate(cancellationPolicy, arrivalDateTime, new Date().toISOString())
      : undefined,
    fee: evaluateFee(cancellationPolicy?.fee, timeSlices, services, currency),
  };
  const noShowFee = {
    policy: noShowPolicy,
    fee: evaluateFee(noShowPolicy?.fee, timeSlices, services, currency),
  };

  /* --- totals ----------------------------------------------------------- */

  const accommodationTotal = timeSlices.reduce((sum, s) => sum + s.totalGrossAmount.amount, 0);
  const serviceTotal = services.reduce((sum, s) => sum + s.totalAmount.grossAmount, 0);
  const cityTaxTotal = cityTaxes.reduce((sum, t) => sum + t.totalGrossAmount.amount, 0);
  const totalGrossAmount = money(accommodationTotal + serviceTotal + cityTaxTotal, currency);

  const allAmounts: AmountModel[] = [
    ...timeSlices.map((s) => s.baseAmount),
    ...timeSlices.flatMap((s) => s.includedServices.map((i) => i.amount)),
    ...services.flatMap((s) => s.dates.map((d) => d.amount)),
    ...cityTaxes.flatMap((t) => t.dates.map((d) => d.amount)),
  ];

  return {
    ratePlan,
    unitGroup: unitGroup!,
    timeSliceDefinition: tsd!,
    arrival,
    departure,
    arrivalDateTime,
    departureDateTime,
    currency,
    timeSlices,
    services,
    cityTaxes,
    totalGrossAmount,
    taxDetails: taxDetailsOf(allAmounts, currency),
    cancellationFee,
    noShowFee,
    prePaymentAmount: ratePlan.minGuaranteeType === 'Prepayment'
      ? totalGrossAmount
      : money(0, currency),
    validationMessages: messages,
  };
}

function priceService(
  service: Service,
  arrival: string,
  departure: string,
  adults: number,
  childrenAges: readonly number[],
  currency: string,
  grossPrice: number,
  isMandatory: boolean,
  explicitDates?: readonly string[],
): PricedService | undefined {
  const defaults = serviceDates(service, arrival, departure);
  const dates = explicitDates?.length ? [...explicitDates] : defaults;
  const count = serviceCount(service, adults, childrenAges);
  if (count === 0 || dates.length === 0) return undefined;

  const priced = dates.map((date) => {
    const config = configFor(service.accountingConfigs, date, 'Other');
    return {
      serviceDate: date,
      amount: grossToAmount(round(grossPrice * count, currency), config.vatType, currency),
      count,
      isMandatory,
      isDefaultDate: defaults.includes(date),
    };
  });

  const totalGross = priced.reduce((s, d) => s + d.amount.grossAmount, 0);
  const vatType = priced[0]!.amount.vatType;
  return {
    serviceId: service.id,
    count,
    totalAmount: grossToAmount(totalGross, vatType, currency),
    dates: priced,
  };
}

function checkBookingRestrictions(ratePlan: RatePlan, arrival: string, messages: ValidationMessage[]): void {
  const r = ratePlan.restrictions;
  if (!r) return;
  const today = new Date().toISOString().slice(0, 10);
  const daysAhead = diffDays(today, arrival);
  const minDays = Math.ceil(periodToHours(r.minAdvance) / 24);
  const maxDays = Math.floor(periodToHours(r.maxAdvance) / 24);
  if (r.minAdvance && daysAhead < minDays) {
    messages.push({
      code: 'RatePlanRestrictionsViolated',
      message: `The rate plan must be booked at least ${minDays} day(s) in advance.`,
    });
  }
  if (r.maxAdvance && daysAhead > maxDays) {
    messages.push({
      code: 'RatePlanRestrictionsViolated',
      message: `The rate plan cannot be booked more than ${maxDays} day(s) in advance.`,
    });
  }
  if (ratePlan.bookingPeriods.length) {
    const now = new Date().toISOString();
    const open = ratePlan.bookingPeriods.some((p) => p.from <= now && now <= p.to);
    if (!open) {
      messages.push({
        code: 'RatePlanRestrictionsViolated',
        message: 'The rate plan is outside its booking period.',
      });
    }
  }
}

function checkRateRestrictions(
  restrictions: { closed: boolean; closedOnArrival: boolean; closedOnDeparture: boolean; minLengthOfStay?: number; maxLengthOfStay?: number } | undefined,
  date: string,
  arrival: string,
  departure: string,
  lengthOfStay: number,
  messages: ValidationMessage[],
): void {
  if (!restrictions) return;
  const add = (message: string) => {
    if (!messages.some((m) => m.code === 'RateRestrictionsViolated' && m.message === message)) {
      messages.push({ code: 'RateRestrictionsViolated', message });
    }
  };
  if (restrictions.closed) add(`The rate is closed on ${date}.`);
  if (restrictions.closedOnArrival && date === arrival) add(`The rate is closed to arrival on ${date}.`);
  if (restrictions.closedOnDeparture && date === departure) add(`The rate is closed to departure on ${date}.`);
  if (restrictions.minLengthOfStay && lengthOfStay < restrictions.minLengthOfStay) {
    add(`The rate requires a minimum stay of ${restrictions.minLengthOfStay} night(s).`);
  }
  if (restrictions.maxLengthOfStay && lengthOfStay > restrictions.maxLengthOfStay) {
    add(`The rate allows a maximum stay of ${restrictions.maxLengthOfStay} night(s).`);
  }
}

