import type { Request } from 'express';
import { ApiBuilder } from '../core/router';
import {
  arrayParam, boolParam, paging, requiredDateParam, sendCreated, sendList, sendNoContent, stringParam,
} from '../core/http';
import { conflict, notFound, unprocessable } from '../core/errors';
import { applyPatch, rejectImmutablePaths, type PatchOperation } from '../core/patch';
import { normalizeLocalized, resolveLocalized } from '../core/localized';
import { atLocalTime, addDays, dayOfWeek, datesInclusive, nowIso, toBusinessDate } from '../core/dates';
import { scoped } from '../core/ids';
import { transact } from '../core/db';
import { money } from '../core/money';
import {
  db, embeddedCancellationPolicy, embeddedMarketSegment, embeddedNoShowPolicy,
  embeddedProperty, embeddedService, embeddedTimeSliceDefinition, embeddedUnitGroup,
  languagesOf, property as getProperty, ratePlan as getRatePlan, unitGroup as getUnitGroup,
} from '../domain/repo';
import { configFor, putRate, resolvePrice, applyModifier } from '../domain/pricing';
import type {
  AgeCategory, CancellationPolicy, Company, NoShowPolicy, RatePlan, Rate, Service,
} from '../domain/types';
import { openRestrictions } from '../domain/types';

/**
 * Rate Plan API - the commercial configuration of a property: what is sold,
 * at what price, under which cancellation terms, and to whom.
 *
 * Age categories live under `/settings/v1/age-categories` even though they
 * are documented in this spec; the router binds by operation id, so the paths
 * come out right regardless.
 */

const api = new ApiBuilder('rateplan-v1');

/* ------------------------------------------------------------ presenters */

function ratesRangeOf(ratePlanId: string): { from: string; to: string } | undefined {
  const rates = db.rates.all({ ratePlanId });
  if (!rates.length) return undefined;
  const dates = rates.map((r) => r.date).sort();
  return { from: dates[0]!, to: dates[dates.length - 1]! };
}

function isBookableNow(plan: RatePlan): boolean {
  if (plan.isArchived) return false;
  if (!plan.bookingPeriods.length) return true;
  const now = nowIso();
  return plan.bookingPeriods.some((p) => p.from <= now && now <= p.to);
}

function ratePlanBody(plan: RatePlan, langs: readonly string[]) {
  return {
    id: plan.id,
    code: plan.code,
    name: plan.name,
    description: plan.description,
    minGuaranteeType: plan.minGuaranteeType,
    priceCalculationMode: plan.priceCalculationMode,
    property: embeddedProperty(plan.propertyId, langs),
    unitGroup: embeddedUnitGroup(plan.unitGroupId, langs),
    cancellationPolicy: embeddedCancellationPolicy(plan.cancellationPolicyId, langs),
    noShowPolicy: embeddedNoShowPolicy(plan.noShowPolicyId, langs),
    channelCodes: plan.channelCodes,
    promoCodes: plan.promoCodes.length ? plan.promoCodes : undefined,
    timeSliceDefinition: embeddedTimeSliceDefinition(plan.timeSliceDefinitionId, langs),
    restrictions: plan.restrictions,
    bookingPeriods: plan.bookingPeriods.length ? plan.bookingPeriods : undefined,
    isBookable: isBookableNow(plan),
    isSubjectToCityTax: plan.isSubjectToCityTax,
    pricingRule: plan.pricingRule
      ? {
        baseRatePlan: {
          ...embeddedRatePlanFull(plan.pricingRule.baseRatePlanId, langs),
        },
        type: plan.pricingRule.type,
        value: plan.pricingRule.value,
      }
      : undefined,
    isDerived: plan.isDerived,
    derivationLevel: plan.derivationLevel,
    surcharges: plan.surcharges.length ? plan.surcharges : undefined,
    ageCategories: plan.ageCategories.length
      ? plan.ageCategories.map((a) => ({ id: a.ageCategoryId, surcharges: a.surcharges }))
      : undefined,
    includedServices: plan.includedServices.length
      ? plan.includedServices.map((s) => ({
        service: embeddedService(s.serviceId, langs),
        grossPrice: money(s.grossPrice, currencyOf(plan.propertyId)),
        pricingMode: s.pricingMode,
      }))
      : undefined,
    companies: plan.companies.length
      ? plan.companies.map((c) => {
        const company = db.companies.get(c.companyId);
        return {
          id: c.companyId,
          code: company?.code ?? c.companyId,
          name: company?.name ?? c.companyId,
          corporateCode: c.corporateCode,
        };
      })
      : undefined,
    ratesRange: ratesRangeOf(plan.id),
    accountingConfigs: plan.accountingConfigs,
    marketSegment: embeddedMarketSegment(plan.marketSegmentId, langs),
    isArchived: plan.isArchived,
  };
}

function embeddedRatePlanFull(id: string, langs: readonly string[]) {
  const r = db.ratePlans.get(id);
  if (!r) return { id };
  return {
    id: r.id,
    code: r.code,
    name: resolveLocalized(r.name, langs),
    description: resolveLocalized(r.description, langs),
    isSubjectToCityTax: r.isSubjectToCityTax,
  };
}

function ratePlanItem(plan: RatePlan, langs: readonly string[]) {
  return {
    ...ratePlanBody(plan, langs),
    name: resolveLocalized(plan.name, langs),
    description: resolveLocalized(plan.description, langs),
  };
}

function currencyOf(propertyId: string): string {
  return db.properties.get(propertyId)?.currencyCode ?? 'EUR';
}

function serviceBody(s: Service, langs: readonly string[], forDate = todayOf(s.propertyId)) {
  const config = configFor(s.accountingConfigs, forDate, 'Other');
  return {
    id: s.id,
    code: s.code,
    name: s.name,
    description: s.description,
    defaultGrossPrice: money(s.defaultGrossPrice, s.currency),
    pricingUnit: s.pricingUnit,
    postNextDay: s.postNextDay,
    serviceType: config.serviceType,
    vatType: config.vatType,
    subAccountId: config.subAccountId,
    availability: s.availability,
    accountingConfigs: s.accountingConfigs,
    property: embeddedProperty(s.propertyId, langs),
    channelCodes: s.channelCodes,
    ageCategoryId: s.ageCategoryId,
  };
}

function serviceItem(s: Service, langs: readonly string[]) {
  return {
    ...serviceBody(s, langs),
    name: resolveLocalized(s.name, langs),
    description: resolveLocalized(s.description, langs),
  };
}

function todayOf(propertyId: string): string {
  return db.properties.get(propertyId)?.businessDate ?? new Date().toISOString().slice(0, 10);
}

function cancellationPolicyBody(p: CancellationPolicy) {
  return {
    id: p.id,
    code: p.code,
    name: p.name,
    description: p.description,
    propertyId: p.propertyId,
    periodFromReference: p.periodFromReference,
    reference: p.reference,
    fee: p.fee,
  };
}

function noShowPolicyBody(p: NoShowPolicy) {
  return {
    id: p.id,
    code: p.code,
    name: p.name,
    description: p.description,
    propertyId: p.propertyId,
    fee: p.fee,
  };
}

function companyBody(c: Company) {
  return {
    id: c.id,
    code: c.code,
    propertyId: c.propertyId,
    name: c.name,
    invoicingEmail: c.invoicingEmail,
    phone: c.phone,
    taxId: c.taxId,
    additionalTaxId: c.additionalTaxId,
    additionalTaxId2: c.additionalTaxId2,
    invoiceNetworkIdentity: c.invoiceNetworkIdentity,
    address: c.address,
    canCheckOutOnAr: c.canCheckOutOnAr,
    ratePlans: c.ratePlans.map((r) => {
      const plan = db.ratePlans.get(r.ratePlanId);
      return {
        id: r.ratePlanId,
        code: plan?.code ?? r.ratePlanId,
        name: resolveLocalized(plan?.name, ['en']) ?? r.ratePlanId,
        corporateCode: r.corporateCode,
      };
    }),
  };
}

/* ------------------------------------------------------------ rate plans */

function ratePlanFilter(req: Request): (p: RatePlan) => boolean {
  const propertyId = stringParam(req, 'propertyId');
  const codes = arrayParam(req, 'ratePlanCodes');
  const includedServiceIds = arrayParam(req, 'includedServiceIds');
  const channelCodes = arrayParam(req, 'channelCodes');
  const promoCodes = arrayParam(req, 'promoCodes');
  const companyIds = arrayParam(req, 'companyIds');
  const baseRatePlanIds = arrayParam(req, 'baseRatePlanIds');
  const unitGroupIds = arrayParam(req, 'unitGroupIds');
  const timeSliceDefinitionIds = arrayParam(req, 'timeSliceDefinitionIds');
  const unitGroupTypes = arrayParam(req, 'unitGroupTypes');
  const timeSliceTemplate = stringParam(req, 'timeSliceTemplate');
  const minGuaranteeTypes = arrayParam(req, 'minGuaranteeTypes');
  const cancellationPolicyIds = arrayParam(req, 'cancellationPolicyIds');
  const noShowPolicyIds = arrayParam(req, 'noShowPolicyIds');
  const isDerived = boolParam(req, 'isDerived');
  const derivationLevels = arrayParam(req, 'derivationLevelFilter').map(Number);
  const includeArchived = boolParam(req, 'includeArchived') ?? false;

  return (p) => {
    if (!includeArchived && p.isArchived) return false;
    if (propertyId && p.propertyId !== propertyId) return false;
    if (codes.length && !codes.includes(p.code)) return false;
    if (includedServiceIds.length
      && !includedServiceIds.some((s) => p.includedServices.some((i) => i.serviceId === s))) return false;
    if (channelCodes.length && !channelCodes.some((c) => p.channelCodes.includes(c as any))) return false;
    if (promoCodes.length && !promoCodes.some((c) => p.promoCodes.includes(c))) return false;
    if (companyIds.length && !companyIds.some((c) => p.companies.some((x) => x.companyId === c))) return false;
    if (baseRatePlanIds.length && (!p.pricingRule || !baseRatePlanIds.includes(p.pricingRule.baseRatePlanId))) return false;
    if (unitGroupIds.length && !unitGroupIds.includes(p.unitGroupId)) return false;
    if (timeSliceDefinitionIds.length && !timeSliceDefinitionIds.includes(p.timeSliceDefinitionId)) return false;
    if (unitGroupTypes.length) {
      const g = db.unitGroups.get(p.unitGroupId);
      if (!g || !unitGroupTypes.includes(g.type)) return false;
    }
    if (timeSliceTemplate) {
      const t = db.timeSliceDefinitions.get(p.timeSliceDefinitionId);
      if (!t || t.template !== timeSliceTemplate) return false;
    }
    if (minGuaranteeTypes.length && !minGuaranteeTypes.includes(p.minGuaranteeType)) return false;
    if (cancellationPolicyIds.length && (!p.cancellationPolicyId || !cancellationPolicyIds.includes(p.cancellationPolicyId))) return false;
    if (noShowPolicyIds.length && (!p.noShowPolicyId || !noShowPolicyIds.includes(p.noShowPolicyId))) return false;
    if (isDerived !== undefined && p.isDerived !== isDerived) return false;
    if (derivationLevels.length && !derivationLevels.includes(p.derivationLevel)) return false;
    return true;
  };
}

api.op('RateplanRate-plansGet', (req, res) => {
  const langs = languagesOf(arrayParam(req, 'languages'), stringParam(req, 'propertyId'));
  const page = paging(req);
  const { items, count } = db.ratePlans.query({
    filter: ratePlanFilter(req),
    sort: (a, b) => a.propertyId.localeCompare(b.propertyId) || a.code.localeCompare(b.code),
    offset: page.offset,
    limit: page.pageSize,
  });
  sendList(res, 'ratePlans', items.map((p) => ratePlanItem(p, langs)), count);
});

api.op('RateplanRate-plans$countGet', (req, res) => {
  res.json({ count: db.ratePlans.all().filter(ratePlanFilter(req)).length });
});

api.op('RateplanRate-plansPost', (req, res) => {
  const body = req.body as Record<string, any>;
  const property = getProperty(body.propertyId);
  const group = getUnitGroup(body.unitGroupId);
  if (group.propertyId !== property.id) {
    throw unprocessable(`Unit group '${group.id}' does not belong to property '${property.id}'.`);
  }
  const code = String(body.code).toUpperCase();
  const id = scoped(property.id, code);
  if (db.ratePlans.exists(id)) {
    throw conflict(`A rate plan with code '${code}' already exists in property '${property.id}'.`);
  }
  if (!db.timeSliceDefinitions.exists(body.timeSliceDefinitionId)) {
    throw unprocessable(`Time slice definition '${body.timeSliceDefinitionId}' does not exist.`);
  }
  if (!db.cancellationPolicies.exists(body.cancellationPolicyId)) {
    throw unprocessable(`Cancellation policy '${body.cancellationPolicyId}' does not exist.`);
  }
  if (body.noShowPolicyId && !db.noShowPolicies.exists(body.noShowPolicyId)) {
    throw unprocessable(`No-show policy '${body.noShowPolicyId}' does not exist.`);
  }

  const { isDerived, derivationLevel, pricingRule } = resolveDerivation(body.pricingRule, property.id);

  const plan: RatePlan = {
    id,
    code,
    propertyId: property.id,
    unitGroupId: group.id,
    name: normalizeLocalized(body.name),
    description: normalizeLocalized(body.description),
    minGuaranteeType: body.minGuaranteeType,
    priceCalculationMode: body.priceCalculationMode ?? 'Truncate',
    timeSliceDefinitionId: body.timeSliceDefinitionId,
    cancellationPolicyId: body.cancellationPolicyId,
    noShowPolicyId: body.noShowPolicyId,
    channelCodes: body.channelCodes ?? [],
    promoCodes: body.promoCodes ?? [],
    restrictions: body.restrictions,
    bookingPeriods: body.bookingPeriods ?? [],
    includedServices: normalizeIncludedServices(body.includedServices, property.id),
    companies: normalizeCompanies(body.companies, id),
    ageCategories: (body.ageCategories ?? []).map((a: any) => ({
      ageCategoryId: a.id,
      surcharges: a.surcharges ?? [],
    })),
    surcharges: body.surcharges ?? [],
    accountingConfigs: body.accountingConfigs?.length
      ? body.accountingConfigs
      : [{ vatType: 'Normal', serviceType: 'Accommodation', validFrom: '1970-01-01' }],
    isSubjectToCityTax: body.isSubjectToCityTax ?? true,
    isDerived,
    derivationLevel,
    pricingRule,
    marketSegmentId: body.marketSegmentId,
    isArchived: false,
    created: nowIso(),
    updated: nowIso(),
  };
  transact(() => {
    db.ratePlans.put(plan);
    linkCompanies(plan);
  });
  sendCreated(res, `/rateplan/v1/rate-plans/${id}`, { id });
});

/**
 * A derived plan sits one level below its base. Tracking the level explicitly
 * lets the list endpoint filter on it and stops a chain from being made
 * circular.
 */
function resolveDerivation(rule: any, propertyId: string) {
  if (!rule?.baseRatePlanId) {
    return { isDerived: false, derivationLevel: 0, pricingRule: undefined };
  }
  const base = db.ratePlans.get(rule.baseRatePlanId);
  if (!base) throw unprocessable(`Base rate plan '${rule.baseRatePlanId}' does not exist.`);
  if (base.propertyId !== propertyId) {
    throw unprocessable('The base rate plan must belong to the same property.');
  }
  return {
    isDerived: true,
    derivationLevel: base.derivationLevel + 1,
    pricingRule: { baseRatePlanId: base.id, type: rule.type, value: rule.value },
  };
}

function normalizeIncludedServices(input: any[] | undefined, propertyId: string) {
  return (input ?? []).map((s) => {
    const service = db.services.get(s.serviceId);
    if (!service) throw unprocessable(`Service '${s.serviceId}' does not exist.`);
    if (service.propertyId !== propertyId) {
      throw unprocessable(`Service '${s.serviceId}' belongs to a different property.`);
    }
    return {
      serviceId: s.serviceId,
      grossPrice: s.grossPrice?.amount ?? service.defaultGrossPrice,
      pricingMode: s.pricingMode ?? 'Included',
    };
  });
}

function normalizeCompanies(input: any[] | undefined, ratePlanId: string) {
  return (input ?? []).map((c) => {
    const company = db.companies.get(c.id);
    if (!company) throw unprocessable(`Company '${c.id}' does not exist.`);
    return { companyId: c.id, corporateCode: c.corporateCode ?? `${company.code}-${ratePlanId}` };
  });
}

/** Keep the reverse pointer on each company in step with the rate plan. */
function linkCompanies(plan: RatePlan): void {
  for (const company of db.companies.all({ propertyId: plan.propertyId })) {
    const shouldHave = plan.companies.find((c) => c.companyId === company.id);
    const has = company.ratePlans.findIndex((r) => r.ratePlanId === plan.id);
    if (shouldHave && has === -1) {
      company.ratePlans.push({ ratePlanId: plan.id, corporateCode: shouldHave.corporateCode });
      db.companies.put(company);
    } else if (shouldHave && has >= 0) {
      company.ratePlans[has] = { ratePlanId: plan.id, corporateCode: shouldHave.corporateCode };
      db.companies.put(company);
    } else if (!shouldHave && has >= 0) {
      company.ratePlans.splice(has, 1);
      db.companies.put(company);
    }
  }
}

api.op('RateplanRate-plansByIdGet', (req, res) => {
  const plan = getRatePlan(req.params.id!);
  res.json(ratePlanBody(plan, languagesOf(arrayParam(req, 'languages'), plan.propertyId)));
});

api.op('RateplanRate-plansByIdHead', (req, res) => {
  res.status(db.ratePlans.exists(req.params.id!) ? 200 : 404).end();
});

api.op('RateplanRate-plansByIdPut', (req, res) => {
  const plan = getRatePlan(req.params.id!);
  const body = req.body as Record<string, any>;
  plan.name = normalizeLocalized(body.name);
  plan.description = normalizeLocalized(body.description);
  plan.minGuaranteeType = body.minGuaranteeType;
  plan.priceCalculationMode = body.priceCalculationMode ?? plan.priceCalculationMode;
  plan.channelCodes = body.channelCodes ?? [];
  plan.promoCodes = body.promoCodes ?? [];
  if (body.isSubjectToCityTax !== undefined) plan.isSubjectToCityTax = body.isSubjectToCityTax;
  if (!db.cancellationPolicies.exists(body.cancellationPolicyId)) {
    throw unprocessable(`Cancellation policy '${body.cancellationPolicyId}' does not exist.`);
  }
  plan.cancellationPolicyId = body.cancellationPolicyId;
  plan.noShowPolicyId = body.noShowPolicyId;
  plan.bookingPeriods = body.bookingPeriods ?? [];
  plan.restrictions = body.restrictions;
  plan.includedServices = normalizeIncludedServices(body.includedServices, plan.propertyId);
  plan.companies = normalizeCompanies(body.companies, plan.id);
  plan.surcharges = body.surcharges ?? [];
  plan.ageCategories = (body.ageCategories ?? []).map((a: any) => ({
    ageCategoryId: a.id,
    surcharges: a.surcharges ?? [],
  }));
  if (body.accountingConfigs?.length) plan.accountingConfigs = body.accountingConfigs;
  plan.marketSegmentId = body.marketSegmentId;
  const derivation = resolveDerivation(body.pricingRule, plan.propertyId);
  if (derivation.pricingRule?.baseRatePlanId === plan.id) {
    throw unprocessable('A rate plan cannot be derived from itself.');
  }
  plan.isDerived = derivation.isDerived;
  plan.derivationLevel = derivation.derivationLevel;
  plan.pricingRule = derivation.pricingRule;
  plan.updated = nowIso();
  transact(() => {
    db.ratePlans.put(plan);
    linkCompanies(plan);
  });
  sendNoContent(res);
});

api.op('RateplanRate-plansPatch', (req, res) => {
  const ids = arrayParam(req, 'ratePlanIds');
  if (!ids.length) throw unprocessable('`ratePlanIds` must contain at least one id.');
  const ops = req.body as PatchOperation[];
  rejectImmutablePaths(ops, ['/id', '/code', '/property', '/unitGroup', '/isDerived', '/derivationLevel']);
  transact(() => ids.forEach((id) => patchRatePlan(id, ops)));
  sendNoContent(res);
});

function patchRatePlan(id: string, ops: PatchOperation[]): void {
  const plan = getRatePlan(id);
  const view = {
    name: plan.name,
    description: plan.description,
    minGuaranteeType: plan.minGuaranteeType,
    priceCalculationMode: plan.priceCalculationMode,
    channelCodes: plan.channelCodes,
    promoCodes: plan.promoCodes,
    isSubjectToCityTax: plan.isSubjectToCityTax,
    cancellationPolicyId: plan.cancellationPolicyId,
    noShowPolicyId: plan.noShowPolicyId,
    bookingPeriods: plan.bookingPeriods,
    restrictions: plan.restrictions,
    surcharges: plan.surcharges,
    marketSegmentId: plan.marketSegmentId,
    accountingConfigs: plan.accountingConfigs,
  };
  const patched = applyPatch(view, ops) as typeof view;
  plan.name = normalizeLocalized(patched.name);
  plan.description = normalizeLocalized(patched.description);
  plan.minGuaranteeType = patched.minGuaranteeType;
  plan.priceCalculationMode = patched.priceCalculationMode;
  plan.channelCodes = patched.channelCodes ?? [];
  plan.promoCodes = patched.promoCodes ?? [];
  plan.isSubjectToCityTax = patched.isSubjectToCityTax;
  plan.cancellationPolicyId = patched.cancellationPolicyId;
  plan.noShowPolicyId = patched.noShowPolicyId;
  plan.bookingPeriods = patched.bookingPeriods ?? [];
  plan.restrictions = patched.restrictions;
  plan.surcharges = patched.surcharges ?? [];
  plan.marketSegmentId = patched.marketSegmentId;
  if (patched.accountingConfigs?.length) plan.accountingConfigs = patched.accountingConfigs;
  plan.updated = nowIso();
  db.ratePlans.put(plan);
}

api.op('RateplanRate-plansByIdDelete', (req, res) => {
  deleteRatePlan(req.params.id!);
  sendNoContent(res);
});

api.op('RateplanRate-plansDelete', (req, res) => {
  const ids = arrayParam(req, 'ratePlanIds');
  if (!ids.length) throw unprocessable('`ratePlanIds` must contain at least one id.');
  transact(() => ids.forEach(deleteRatePlan));
  sendNoContent(res);
});

function deleteRatePlan(id: string): void {
  const plan = getRatePlan(id);
  const used = db.reservations.all({ propertyId: plan.propertyId })
    .filter((r) => r.ratePlanId === id && r.status !== 'Canceled').length;
  if (used) throw unprocessable(`The rate plan is used by ${used} reservation(s); archive it instead.`);
  const derived = db.ratePlans.all({ propertyId: plan.propertyId })
    .filter((p) => p.pricingRule?.baseRatePlanId === id);
  if (derived.length) {
    throw unprocessable(`The rate plan is the base for ${derived.length} derived rate plan(s).`);
  }
  db.rates.deleteWhere({ ratePlanId: id });
  db.ratePlans.delete(id);
  for (const company of db.companies.all({ propertyId: plan.propertyId })) {
    const before = company.ratePlans.length;
    company.ratePlans = company.ratePlans.filter((r) => r.ratePlanId !== id);
    if (company.ratePlans.length !== before) db.companies.put(company);
  }
}

api.op('RateplanRate-plan-actionsByIdArchivePut', (req, res) => {
  const plan = getRatePlan(req.params.id!);
  if (plan.isArchived) throw unprocessable('The rate plan is already archived.');
  plan.isArchived = true;
  plan.updated = nowIso();
  db.ratePlans.put(plan);
  sendNoContent(res);
});

/* ----------------------------------------------------------------- rates */

function rateItem(plan: RatePlan, rate: Rate, property: { timeZone: string }, tsd: { checkInTime: string; checkOutTime: string }) {
  const includedPrice = plan.includedServices
    .filter((s) => s.pricingMode === 'Included')
    .reduce((sum, s) => sum + s.grossPrice, 0);

  // Prices for higher occupancies, so a channel manager can publish them all.
  const calculatedPrices = plan.surcharges
    .slice()
    .sort((a, b) => a.adults - b.adults)
    .map((s) => ({
      adults: s.adults,
      price: money(applyModifier(rate.price, s.type, s.value, plan.priceCalculationMode), rate.currency),
      includedServicesPrice: money(includedPrice, rate.currency),
    }));

  return {
    from: atLocalTime(rate.date, tsd.checkInTime, property.timeZone),
    to: atLocalTime(addDays(rate.date, 1), tsd.checkOutTime, property.timeZone),
    price: money(rate.price, rate.currency),
    includedServicesPrice: includedPrice ? money(includedPrice, rate.currency) : undefined,
    calculatedPrices: calculatedPrices.length ? calculatedPrices : undefined,
    restrictions: rate.restrictions,
  };
}

api.op('RateplanRate-plansByIdRatesGet', (req, res) => {
  const plan = getRatePlan(req.params.id!);
  const property = getProperty(plan.propertyId);
  const tsd = db.timeSliceDefinitions.get(plan.timeSliceDefinitionId)
    ?? { checkInTime: property.defaultCheckInTime, checkOutTime: property.defaultCheckOutTime };
  const from = requiredDateParam(req, 'from');
  const to = requiredDateParam(req, 'to');
  const page = paging(req);

  // Derived plans have no stored rates; compute them from the base chain so
  // the endpoint answers for every plan the way the real API does.
  const dates = datesInclusive(from, to);
  const all = dates
    .map((date) => {
      const stored = db.rates.get(`${plan.id}|${date}`);
      if (stored) return stored;
      const price = resolvePrice(plan, date);
      if (price === undefined) return undefined;
      return {
        id: `${plan.id}|${date}`,
        ratePlanId: plan.id,
        propertyId: plan.propertyId,
        date,
        price,
        currency: property.currencyCode,
        restrictions: openRestrictions(),
      } satisfies Rate;
    })
    .filter((r): r is Rate => !!r);

  const pageItems = all.slice(page.offset, page.offset + page.pageSize);
  sendList(res, 'rates', pageItems.map((r) => rateItem(plan, r, property, tsd)), all.length);
});

api.op('RateplanRate-plansByIdRates$countGet', (req, res) => {
  const plan = getRatePlan(req.params.id!);
  const from = requiredDateParam(req, 'from');
  const to = requiredDateParam(req, 'to');
  const count = datesInclusive(from, to).filter((d) => resolvePrice(plan, d) !== undefined).length;
  res.json({ count });
});

api.op('RateplanRate-plansByIdRatesPut', (req, res) => {
  const plan = getRatePlan(req.params.id!);
  if (plan.isDerived) {
    throw unprocessable('Rates cannot be set on a derived rate plan; change the base plan or its pricing rule.');
  }
  const property = getProperty(plan.propertyId);
  const body = req.body as { rates: any[] };
  transact(() => {
    for (const entry of body.rates) {
      const from = toBusinessDate(entry.from, property.timeZone);
      const to = toBusinessDate(entry.to, property.timeZone);
      // `to` is the end of the last night, so the final priced date is to - 1.
      const last = to > from ? addDays(to, -1) : from;
      for (const date of datesInclusive(from, last)) {
        putRate({
          ratePlanId: plan.id,
          propertyId: plan.propertyId,
          date,
          price: entry.price?.amount ?? 0,
          currency: entry.price?.currency ?? property.currencyCode,
          restrictions: { ...openRestrictions(), ...(entry.restrictions ?? {}) },
        });
      }
    }
  });
  sendNoContent(res);
});

api.op('RateplanRate-plansByIdRatesDelete', (req, res) => {
  const plan = getRatePlan(req.params.id!);
  const from = requiredDateParam(req, 'from');
  const to = requiredDateParam(req, 'to');
  transact(() => {
    for (const date of datesInclusive(from, to)) db.rates.delete(`${plan.id}|${date}`);
  });
  sendNoContent(res);
});

api.op('RateplanRate-plansByIdRatesPatch', (req, res) => {
  const plan = getRatePlan(req.params.id!);
  const body = req.body as { rates?: any[] };
  transact(() => {
    for (const entry of body.rates ?? []) patchRates([plan], entry.from, entry.to, entry.weekDays, entry.operations ?? []);
  });
  sendNoContent(res);
});

api.op('RateplanRatesPatch', (req, res) => {
  const ids = arrayParam(req, 'ratePlanIds');
  if (!ids.length) throw unprocessable('`ratePlanIds` must contain at least one id.');
  const from = requiredDateParam(req, 'from');
  const to = requiredDateParam(req, 'to');
  const weekDays = arrayParam(req, 'weekDays');
  const ops = req.body as PatchOperation[];
  const plans = ids.map(getRatePlan);
  transact(() => patchRates(plans, from, to, weekDays, ops));
  sendNoContent(res);
});

/**
 * Apply a JSON Patch to every rate in a date range. This is how a revenue
 * manager shifts a week of prices or closes a rate for arrivals in one call.
 */
function patchRates(
  plans: readonly RatePlan[],
  fromRaw: string,
  toRaw: string,
  weekDays: readonly string[],
  ops: readonly PatchOperation[],
): void {
  for (const plan of plans) {
    if (plan.isDerived) {
      throw unprocessable(`Rate plan '${plan.id}' is derived; its rates are computed from its base plan.`);
    }
    const property = getProperty(plan.propertyId);
    const from = toBusinessDate(fromRaw, property.timeZone);
    const to = toBusinessDate(toRaw, property.timeZone);
    for (const date of datesInclusive(from, to)) {
      if (weekDays.length && !weekDays.includes(dayOfWeek(date))) continue;
      const existing = db.rates.get(`${plan.id}|${date}`);
      const view = {
        price: { amount: existing?.price ?? 0, currency: existing?.currency ?? property.currencyCode },
        restrictions: existing?.restrictions ?? openRestrictions(),
      };
      const patched = applyPatch(view, ops as PatchOperation[]) as typeof view;
      putRate({
        ratePlanId: plan.id,
        propertyId: plan.propertyId,
        date,
        price: patched.price.amount,
        currency: patched.price.currency || property.currencyCode,
        restrictions: { ...openRestrictions(), ...patched.restrictions },
      });
    }
  }
}

/* ------------------------------------------------------------- policies */

api.op('RateplanCancellation-policiesGet', (req, res) => {
  const propertyId = stringParam(req, 'propertyId');
  const langs = languagesOf(arrayParam(req, 'languages'), propertyId);
  const page = paging(req);
  const { items, count } = db.cancellationPolicies.query({
    where: { propertyId },
    sort: (a, b) => a.code.localeCompare(b.code),
    offset: page.offset,
    limit: page.pageSize,
  });
  sendList(res, 'cancellationPolicies', items.map((p) => ({
    ...cancellationPolicyBody(p),
    name: resolveLocalized(p.name, langs),
    description: resolveLocalized(p.description, langs),
  })), count);
});

api.op('RateplanCancellation-policiesPost', (req, res) => {
  const body = req.body as Record<string, any>;
  const property = getProperty(body.propertyId);
  const code = String(body.code).toUpperCase();
  const id = scoped(property.id, code);
  if (db.cancellationPolicies.exists(id)) {
    throw conflict(`A cancellation policy with code '${code}' already exists in '${property.id}'.`);
  }
  assertFee(body.fee);
  const policy: CancellationPolicy = {
    id,
    propertyId: property.id,
    code,
    name: normalizeLocalized(body.name),
    description: normalizeLocalized(body.description),
    periodFromReference: body.periodFromReference ?? {},
    reference: body.reference ?? 'PriorToArrival',
    fee: normalizeFee(body.fee, property.currencyCode),
  };
  db.cancellationPolicies.put(policy);
  sendCreated(res, `/rateplan/v1/cancellation-policies/${id}`, { id });
});

function assertFee(fee: any): void {
  if (!fee) throw unprocessable('`fee` is required.');
  if (!fee.fixedValue && !fee.percentValue) {
    throw unprocessable('`fee` must specify either `fixedValue` or `percentValue`.');
  }
  if (fee.fixedValue && fee.percentValue) {
    throw unprocessable('`fee` must specify only one of `fixedValue` or `percentValue`.');
  }
  if (fee.percentValue && (fee.percentValue.percent < 0 || fee.percentValue.percent > 100)) {
    throw unprocessable('`fee.percentValue.percent` must be between 0 and 100.');
  }
}

function normalizeFee(fee: any, currency: string) {
  return {
    vatType: fee.vatType ?? 'Normal',
    fixedValue: fee.fixedValue
      ? { amount: fee.fixedValue.amount, currency: fee.fixedValue.currency ?? currency }
      : undefined,
    percentValue: fee.percentValue
      ? {
        percent: fee.percentValue.percent,
        limit: fee.percentValue.limit,
        includeServiceIds: fee.percentValue.includeServiceIds ?? [],
      }
      : undefined,
  };
}

api.op('RateplanCancellation-policiesByIdGet', (req, res) => {
  const p = db.cancellationPolicies.get(req.params.id!);
  if (!p) throw notFound(`Cancellation policy '${req.params.id}' was not found.`);
  res.json(cancellationPolicyBody(p));
});

api.op('RateplanCancellation-policiesByIdPatch', (req, res) => {
  const p = db.cancellationPolicies.get(req.params.id!);
  if (!p) throw notFound(`Cancellation policy '${req.params.id}' was not found.`);
  const ops = req.body as PatchOperation[];
  rejectImmutablePaths(ops, ['/id', '/code', '/propertyId']);
  const patched = applyPatch({ ...p }, ops) as CancellationPolicy;
  patched.name = normalizeLocalized(patched.name);
  patched.description = normalizeLocalized(patched.description);
  assertFee(patched.fee);
  db.cancellationPolicies.put({ ...patched, id: p.id, code: p.code, propertyId: p.propertyId });
  sendNoContent(res);
});

api.op('RateplanCancellation-policiesByIdDelete', (req, res) => {
  const id = req.params.id!;
  if (!db.cancellationPolicies.exists(id)) throw notFound(`Cancellation policy '${id}' was not found.`);
  const used = db.ratePlans.all().filter((p) => p.cancellationPolicyId === id).length;
  if (used) throw unprocessable(`The policy is used by ${used} rate plan(s).`);
  db.cancellationPolicies.delete(id);
  sendNoContent(res);
});

api.op('RateplanNo-show-policiesGet', (req, res) => {
  const propertyId = stringParam(req, 'propertyId');
  const langs = languagesOf(arrayParam(req, 'languages'), propertyId);
  const page = paging(req);
  const { items, count } = db.noShowPolicies.query({
    where: { propertyId },
    sort: (a, b) => a.code.localeCompare(b.code),
    offset: page.offset,
    limit: page.pageSize,
  });
  sendList(res, 'noShowPolicies', items.map((p) => ({
    ...noShowPolicyBody(p),
    name: resolveLocalized(p.name, langs),
    description: resolveLocalized(p.description, langs),
  })), count);
});

api.op('RateplanNo-show-policiesPost', (req, res) => {
  const body = req.body as Record<string, any>;
  const property = getProperty(body.propertyId);
  const code = String(body.code).toUpperCase();
  const id = scoped(property.id, code);
  if (db.noShowPolicies.exists(id)) {
    throw conflict(`A no-show policy with code '${code}' already exists in '${property.id}'.`);
  }
  assertFee(body.fee);
  const policy: NoShowPolicy = {
    id,
    propertyId: property.id,
    code,
    name: normalizeLocalized(body.name),
    description: normalizeLocalized(body.description),
    fee: normalizeFee(body.fee, property.currencyCode),
  };
  db.noShowPolicies.put(policy);
  sendCreated(res, `/rateplan/v1/no-show-policies/${id}`, { id });
});

api.op('RateplanNo-show-policiesByIdGet', (req, res) => {
  const p = db.noShowPolicies.get(req.params.id!);
  if (!p) throw notFound(`No-show policy '${req.params.id}' was not found.`);
  res.json(noShowPolicyBody(p));
});

api.op('RateplanNo-show-policiesByIdPatch', (req, res) => {
  const p = db.noShowPolicies.get(req.params.id!);
  if (!p) throw notFound(`No-show policy '${req.params.id}' was not found.`);
  const ops = req.body as PatchOperation[];
  rejectImmutablePaths(ops, ['/id', '/code', '/propertyId']);
  const patched = applyPatch({ ...p }, ops) as NoShowPolicy;
  patched.name = normalizeLocalized(patched.name);
  patched.description = normalizeLocalized(patched.description);
  assertFee(patched.fee);
  db.noShowPolicies.put({ ...patched, id: p.id, code: p.code, propertyId: p.propertyId });
  sendNoContent(res);
});

api.op('RateplanNo-show-policiesByIdDelete', (req, res) => {
  const id = req.params.id!;
  if (!db.noShowPolicies.exists(id)) throw notFound(`No-show policy '${id}' was not found.`);
  const used = db.ratePlans.all().filter((p) => p.noShowPolicyId === id).length;
  if (used) throw unprocessable(`The policy is used by ${used} rate plan(s).`);
  db.noShowPolicies.delete(id);
  sendNoContent(res);
});

/* ------------------------------------------------------------- services */

api.op('RateplanServicesGet', (req, res) => {
  const propertyId = stringParam(req, 'propertyId');
  const langs = languagesOf(arrayParam(req, 'languages'), propertyId);
  const textSearch = stringParam(req, 'textSearch')?.toLowerCase();
  const onlySoldAsExtras = boolParam(req, 'onlySoldAsExtras');
  const channelCodes = arrayParam(req, 'channelCodes');
  const serviceTypes = arrayParam(req, 'serviceTypes');
  const page = paging(req);

  const includedSomewhere = new Set(
    db.ratePlans.all(propertyId ? { propertyId } : undefined)
      .flatMap((p) => p.includedServices.map((s) => s.serviceId)),
  );

  const { items, count } = db.services.query({
    where: { propertyId },
    filter: (s) => {
      if (textSearch) {
        const haystack = [s.code, ...Object.values(s.name), ...Object.values(s.description)]
          .join(' ').toLowerCase();
        if (!haystack.includes(textSearch)) return false;
      }
      if (onlySoldAsExtras && includedSomewhere.has(s.id)) return false;
      if (channelCodes.length && s.channelCodes.length
        && !channelCodes.some((c) => s.channelCodes.includes(c as any))) return false;
      if (serviceTypes.length) {
        const t = configFor(s.accountingConfigs, todayOf(s.propertyId), 'Other').serviceType;
        if (!serviceTypes.includes(t)) return false;
      }
      return true;
    },
    sort: (a, b) => a.code.localeCompare(b.code),
    offset: page.offset,
    limit: page.pageSize,
  });
  sendList(res, 'services', items.map((s) => serviceItem(s, langs)), count);
});

api.op('RateplanServices$countGet', (req, res) => {
  res.json({ count: db.services.count({ propertyId: stringParam(req, 'propertyId') }) });
});

api.op('RateplanServicesPost', (req, res) => {
  const body = req.body as Record<string, any>;
  const property = getProperty(body.propertyId);
  const code = String(body.code).toUpperCase();
  const id = scoped(property.id, code);
  if (db.services.exists(id)) {
    throw conflict(`A service with code '${code}' already exists in property '${property.id}'.`);
  }
  if (body.ageCategoryId && !db.ageCategories.exists(body.ageCategoryId)) {
    throw unprocessable(`Age category '${body.ageCategoryId}' does not exist.`);
  }
  const service: Service = {
    id,
    code,
    propertyId: property.id,
    name: normalizeLocalized(body.name),
    description: normalizeLocalized(body.description),
    defaultGrossPrice: body.defaultGrossPrice.amount,
    currency: body.defaultGrossPrice.currency ?? property.currencyCode,
    pricingUnit: body.pricingUnit,
    postNextDay: body.postNextDay ?? false,
    availability: {
      mode: body.availability?.mode ?? 'Daily',
      quantity: body.availability?.quantity,
      daysOfWeek: body.availability?.daysOfWeek,
    },
    channelCodes: body.channelCodes ?? [],
    accountingConfigs: body.accountingConfigs?.length
      ? body.accountingConfigs
      : [{ vatType: 'Normal', serviceType: 'Other', validFrom: '1970-01-01' }],
    ageCategoryId: body.ageCategoryId,
  };
  db.services.put(service);
  sendCreated(res, `/rateplan/v1/services/${id}`, { id });
});

api.op('RateplanServicesByIdGet', (req, res) => {
  const s = db.services.get(req.params.id!);
  if (!s) throw notFound(`Service '${req.params.id}' was not found.`);
  res.json(serviceBody(s, languagesOf(arrayParam(req, 'languages'), s.propertyId)));
});

api.op('RateplanServicesByIdHead', (req, res) => {
  res.status(db.services.exists(req.params.id!) ? 200 : 404).end();
});

api.op('RateplanServicesByIdPatch', (req, res) => {
  const s = db.services.get(req.params.id!);
  if (!s) throw notFound(`Service '${req.params.id}' was not found.`);
  const ops = req.body as PatchOperation[];
  rejectImmutablePaths(ops, ['/id', '/code', '/property', '/propertyId']);
  const view = {
    name: s.name,
    description: s.description,
    defaultGrossPrice: { amount: s.defaultGrossPrice, currency: s.currency },
    pricingUnit: s.pricingUnit,
    postNextDay: s.postNextDay,
    availability: s.availability,
    channelCodes: s.channelCodes,
    accountingConfigs: s.accountingConfigs,
    ageCategoryId: s.ageCategoryId,
  };
  const patched = applyPatch(view, ops) as typeof view;
  s.name = normalizeLocalized(patched.name);
  s.description = normalizeLocalized(patched.description);
  s.defaultGrossPrice = patched.defaultGrossPrice.amount;
  s.currency = patched.defaultGrossPrice.currency || s.currency;
  s.pricingUnit = patched.pricingUnit;
  s.postNextDay = patched.postNextDay;
  s.availability = patched.availability;
  s.channelCodes = patched.channelCodes ?? [];
  if (patched.accountingConfigs?.length) s.accountingConfigs = patched.accountingConfigs;
  s.ageCategoryId = patched.ageCategoryId;
  db.services.put(s);
  sendNoContent(res);
});

api.op('RateplanServicesByIdDelete', (req, res) => {
  const id = req.params.id!;
  const s = db.services.get(id);
  if (!s) throw notFound(`Service '${id}' was not found.`);
  const inPlans = db.ratePlans.all().filter((p) => p.includedServices.some((i) => i.serviceId === id)).length;
  if (inPlans) throw unprocessable(`The service is included in ${inPlans} rate plan(s).`);
  const booked = db.reservations.all({ propertyId: s.propertyId })
    .filter((r) => r.status !== 'Canceled' && r.services.some((x) => x.serviceId === id)).length;
  if (booked) throw unprocessable(`The service is booked on ${booked} reservation(s).`);
  db.services.delete(id);
  sendNoContent(res);
});

/* ------------------------------------------------------------ companies */

api.op('RateplanCompaniesGet', (req, res) => {
  const propertyId = stringParam(req, 'propertyId');
  const ratePlanIds = arrayParam(req, 'ratePlanIds');
  const corporateCodes = arrayParam(req, 'corporateCodes');
  const textSearch = stringParam(req, 'textSearch')?.toLowerCase();
  const page = paging(req);
  const { items, count } = db.companies.query({
    where: { propertyId },
    filter: (c) => {
      if (ratePlanIds.length && !c.ratePlans.some((r) => ratePlanIds.includes(r.ratePlanId))) return false;
      if (corporateCodes.length && !c.ratePlans.some((r) => corporateCodes.includes(r.corporateCode))) return false;
      if (textSearch && !`${c.code} ${c.name}`.toLowerCase().includes(textSearch)) return false;
      return true;
    },
    sort: (a, b) => a.name.localeCompare(b.name),
    offset: page.offset,
    limit: page.pageSize,
  });
  sendList(res, 'companies', items.map(companyBody), count);
});

api.op('RateplanCompaniesPost', (req, res) => {
  const body = req.body as Record<string, any>;
  const property = getProperty(body.propertyId);
  const code = String(body.code).toUpperCase();
  const id = scoped(property.id, code);
  if (db.companies.exists(id)) {
    throw conflict(`A company with code '${code}' already exists in property '${property.id}'.`);
  }
  const company: Company = {
    id,
    code,
    propertyId: property.id,
    name: body.name,
    invoicingEmail: body.invoicingEmail,
    phone: body.phone,
    taxId: body.taxId,
    additionalTaxId: body.additionalTaxId,
    additionalTaxId2: body.additionalTaxId2,
    invoiceNetworkIdentity: body.invoiceNetworkIdentity,
    address: { ...body.address, countryCode: String(body.address.countryCode).toUpperCase() },
    canCheckOutOnAr: body.canCheckOutOnAr ?? false,
    ratePlans: (body.ratePlans ?? []).map((r: any) => ({
      ratePlanId: r.id,
      corporateCode: r.corporateCode ?? `${code}-${r.id}`,
    })),
  };
  transact(() => {
    db.companies.put(company);
    syncRatePlansOfCompany(company);
  });
  sendCreated(res, `/rateplan/v1/companies/${id}`, { id });
});

/** Mirror a company's rate plan list onto each rate plan's company list. */
function syncRatePlansOfCompany(company: Company): void {
  const wanted = new Map(company.ratePlans.map((r) => [r.ratePlanId, r.corporateCode]));
  for (const plan of db.ratePlans.all({ propertyId: company.propertyId })) {
    const idx = plan.companies.findIndex((c) => c.companyId === company.id);
    const corporateCode = wanted.get(plan.id);
    if (corporateCode && idx === -1) {
      plan.companies.push({ companyId: company.id, corporateCode });
      db.ratePlans.put(plan);
    } else if (corporateCode && idx >= 0) {
      plan.companies[idx] = { companyId: company.id, corporateCode };
      db.ratePlans.put(plan);
    } else if (!corporateCode && idx >= 0) {
      plan.companies.splice(idx, 1);
      db.ratePlans.put(plan);
    }
  }
}

api.op('RateplanCompaniesByIdGet', (req, res) => {
  const c = db.companies.get(req.params.id!);
  if (!c) throw notFound(`Company '${req.params.id}' was not found.`);
  res.json(companyBody(c));
});

api.op('RateplanCompaniesByIdPatch', (req, res) => {
  const c = db.companies.get(req.params.id!);
  if (!c) throw notFound(`Company '${req.params.id}' was not found.`);
  const ops = req.body as PatchOperation[];
  rejectImmutablePaths(ops, ['/id', '/code', '/propertyId']);
  const view = {
    name: c.name,
    invoicingEmail: c.invoicingEmail,
    phone: c.phone,
    taxId: c.taxId,
    additionalTaxId: c.additionalTaxId,
    additionalTaxId2: c.additionalTaxId2,
    invoiceNetworkIdentity: c.invoiceNetworkIdentity,
    address: c.address,
    canCheckOutOnAr: c.canCheckOutOnAr,
    ratePlans: c.ratePlans.map((r) => ({ id: r.ratePlanId, corporateCode: r.corporateCode })),
  };
  const patched = applyPatch(view, ops) as typeof view;
  Object.assign(c, {
    name: patched.name,
    invoicingEmail: patched.invoicingEmail,
    phone: patched.phone,
    taxId: patched.taxId,
    additionalTaxId: patched.additionalTaxId,
    additionalTaxId2: patched.additionalTaxId2,
    invoiceNetworkIdentity: patched.invoiceNetworkIdentity,
    address: patched.address,
    canCheckOutOnAr: patched.canCheckOutOnAr,
    ratePlans: (patched.ratePlans ?? []).map((r: any) => ({
      ratePlanId: r.id,
      corporateCode: r.corporateCode ?? `${c.code}-${r.id}`,
    })),
  });
  transact(() => {
    db.companies.put(c);
    syncRatePlansOfCompany(c);
  });
  sendNoContent(res);
});

api.op('RateplanCompaniesByIdDelete', (req, res) => {
  const id = req.params.id!;
  const c = db.companies.get(id);
  if (!c) throw notFound(`Company '${id}' was not found.`);
  const used = db.reservations.all({ propertyId: c.propertyId })
    .filter((r) => r.companyId === id && r.status !== 'Canceled').length;
  if (used) throw unprocessable(`The company is referenced by ${used} reservation(s).`);
  transact(() => {
    c.ratePlans = [];
    syncRatePlansOfCompany(c);
    db.companies.delete(id);
  });
  sendNoContent(res);
});

/* ------------------------------------------------------- promo/corporate */

api.op('RateplanPromo-codesCodesGet', (req, res) => {
  const propertyId = stringParam(req, 'propertyId');
  const page = paging(req);
  const byCode = new Map<string, string[]>();
  for (const plan of db.ratePlans.all({ propertyId })) {
    for (const code of plan.promoCodes) {
      const list = byCode.get(code) ?? [];
      list.push(plan.id);
      byCode.set(code, list);
    }
  }
  const all = [...byCode.entries()]
    .map(([code, relatedRateplanIds]) => ({ code, relatedRateplanIds }))
    .sort((a, b) => a.code.localeCompare(b.code));
  sendList(res, 'promoCodes', all.slice(page.offset, page.offset + page.pageSize), all.length);
});

api.op('RateplanCorporate-codesCodesGet', (req, res) => {
  const propertyId = stringParam(req, 'propertyId');
  const page = paging(req);
  const all: Record<string, string>[] = [];
  for (const plan of db.ratePlans.all({ propertyId })) {
    for (const link of plan.companies) {
      const company = db.companies.get(link.companyId);
      if (!company) continue;
      all.push({
        code: link.corporateCode,
        companyId: company.id,
        companyCode: company.code,
        companyName: company.name,
        ratePlanId: plan.id,
      });
    }
  }
  all.sort((a, b) => a.code!.localeCompare(b.code!));
  sendList(res, 'corporateCodes', all.slice(page.offset, page.offset + page.pageSize), all.length);
});

/* -------------------------------------------------------- age categories */

function ageCategoryBody(a: AgeCategory) {
  return {
    id: a.id,
    code: a.code,
    propertyId: a.propertyId,
    name: a.name,
    minAge: a.minAge,
    maxAge: a.maxAge,
  };
}

api.op('SettingsAge-categoriesGet', (req, res) => {
  const propertyId = stringParam(req, 'propertyId');
  const langs = languagesOf(arrayParam(req, 'languages'), propertyId);
  const page = paging(req);
  const { items, count } = db.ageCategories.query({
    where: { propertyId },
    sort: (a, b) => a.minAge - b.minAge,
    offset: page.offset,
    limit: page.pageSize,
  });
  sendList(res, 'ageCategories', items.map((a) => ({
    ...ageCategoryBody(a),
    name: resolveLocalized(a.name, langs),
  })), count);
});

api.op('SettingsAge-categoriesPost', (req, res) => {
  const body = req.body as Record<string, any>;
  const property = getProperty(body.propertyId);
  const code = String(body.code).toUpperCase();
  const id = scoped(property.id, code);
  if (db.ageCategories.exists(id)) {
    throw conflict(`An age category with code '${code}' already exists in '${property.id}'.`);
  }
  if (body.minAge > body.maxAge) throw unprocessable('`minAge` must not be greater than `maxAge`.');
  const overlapping = db.ageCategories.all({ propertyId: property.id })
    .find((c) => body.minAge <= c.maxAge && c.minAge <= body.maxAge);
  if (overlapping) {
    throw unprocessable(`The age range overlaps the existing category '${overlapping.code}' (${overlapping.minAge}-${overlapping.maxAge}).`);
  }
  const category: AgeCategory = {
    id,
    propertyId: property.id,
    code,
    name: normalizeLocalized(body.name),
    minAge: body.minAge,
    maxAge: body.maxAge,
  };
  db.ageCategories.put(category);
  sendCreated(res, `/settings/v1/age-categories/${id}`, { id });
});

api.op('SettingsAge-categoriesByIdGet', (req, res) => {
  const a = db.ageCategories.get(req.params.id!);
  if (!a) throw notFound(`Age category '${req.params.id}' was not found.`);
  res.json(ageCategoryBody(a));
});

api.op('SettingsAge-categoriesByIdPatch', (req, res) => {
  const a = db.ageCategories.get(req.params.id!);
  if (!a) throw notFound(`Age category '${req.params.id}' was not found.`);
  const ops = req.body as PatchOperation[];
  rejectImmutablePaths(ops, ['/id', '/code', '/propertyId']);
  const patched = applyPatch({ ...a }, ops) as AgeCategory;
  patched.name = normalizeLocalized(patched.name);
  if (patched.minAge > patched.maxAge) throw unprocessable('`minAge` must not be greater than `maxAge`.');
  const overlapping = db.ageCategories.all({ propertyId: a.propertyId })
    .find((c) => c.id !== a.id && patched.minAge <= c.maxAge && c.minAge <= patched.maxAge);
  if (overlapping) {
    throw unprocessable(`The age range overlaps the existing category '${overlapping.code}'.`);
  }
  db.ageCategories.put({ ...patched, id: a.id, code: a.code, propertyId: a.propertyId });
  sendNoContent(res);
});

api.op('SettingsAge-categoriesByIdDelete', (req, res) => {
  const id = req.params.id!;
  const a = db.ageCategories.get(id);
  if (!a) throw notFound(`Age category '${id}' was not found.`);
  const used = db.ratePlans.all({ propertyId: a.propertyId })
    .filter((p) => p.ageCategories.some((x) => x.ageCategoryId === id)).length;
  if (used) throw unprocessable(`The age category is used by ${used} rate plan(s).`);
  db.ageCategories.delete(id);
  sendNoContent(res);
});

export const ratePlanRouter = api.build();
