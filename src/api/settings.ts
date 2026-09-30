import { ApiBuilder } from '../core/router';
import {
  arrayParam, paging, sendCreated, sendList, sendNoContent, stringParam,
  requiredStringParam,
} from '../core/http';
import { conflict, notFound, unprocessable } from '../core/errors';
import { applyPatch, rejectImmutablePaths, type PatchOperation } from '../core/patch';
import { normalizeLocalized, resolveLocalized } from '../core/localized';
import { scoped } from '../core/ids';
import { transact } from '../core/db';
import {
  db, languagesOf, property as getProperty,
} from '../domain/repo';
import { LANGUAGE_CODES } from '../domain/reference';
import type {
  CapturePolicy, CityTax, FeatureSettings, InvoiceAddress, LanguageSetting, MarketSegment,
  SubAccount, TimeSliceDefinition,
} from '../domain/types';

/**
 * Settings API - the configuration that sits beside the commercial setup:
 * city taxes, market segments, the custom part of the chart of accounts,
 * time slice definitions, invoice addresses, languages and feature flags.
 */

const api = new ApiBuilder('settings-v1');

/* ------------------------------------------------------------- city tax */

function cityTaxBody(t: CityTax) {
  return {
    id: t.id,
    code: t.code,
    name: t.name,
    description: t.description,
    propertyId: t.propertyId,
    type: t.type,
    taxHandlingType: t.taxHandlingType,
    value: t.value,
    limit: t.limit,
    subcategories: t.subcategories.length ? t.subcategories : undefined,
    pricingRules: t.pricingRules.length ? t.pricingRules : undefined,
    vatType: t.vatType,
    priority: t.priority,
    includeCityTaxInRateAmount: t.includeCityTaxInRateAmount,
    ignoredFor: t.ignoredFor.length ? t.ignoredFor : undefined,
  };
}

api.op('SettingsCity-taxGet', (req, res) => {
  const propertyId = stringParam(req, 'propertyId');
  const langs = languagesOf(arrayParam(req, 'languages'), propertyId);
  const taxes = db.cityTaxes.all({ propertyId }).sort((a, b) => a.priority - b.priority);
  sendList(res, 'cityTaxes', taxes.map((t) => ({
    ...cityTaxBody(t),
    name: resolveLocalized(t.name, langs),
    description: resolveLocalized(t.description, langs),
  })), taxes.length);
});

api.op('SettingsCity-taxPost', (req, res) => {
  const body = req.body as Record<string, any>;
  const property = getProperty(body.propertyId);
  const code = String(body.code ?? 'CITYTAX').toUpperCase();
  const id = scoped(property.id, code);
  if (db.cityTaxes.exists(id)) {
    throw conflict(`A city tax with code '${code}' already exists in property '${property.id}'.`);
  }
  validateCityTax(body);
  const tax: CityTax = {
    id,
    propertyId: property.id,
    code,
    name: normalizeLocalized(body.name),
    description: normalizeLocalized(body.description),
    type: body.type,
    taxHandlingType: body.taxHandlingType,
    value: body.value,
    limit: body.limit,
    subcategories: (body.subcategories ?? []).map((sc: any) => ({
      name: normalizeLocalized(sc.name),
      value: sc.value,
      age: sc.age,
    })),
    pricingRules: body.pricingRules ?? [],
    vatType: body.vatType,
    priority: body.priority ?? nextPriority(property.id),
    includeCityTaxInRateAmount: body.includeCityTaxInRateAmount ?? false,
    ignoredFor: body.ignoredFor ?? [],
  };
  db.cityTaxes.put(tax);
  sendCreated(res, `/settings/v1/city-tax/${id}`, { id });
});

function nextPriority(propertyId: string): number {
  const taxes = db.cityTaxes.all({ propertyId });
  return taxes.length ? Math.max(...taxes.map((t) => t.priority)) + 1 : 1;
}

function validateCityTax(body: Record<string, any>): void {
  const percentTypes = ['PercentOfGross', 'PercentOfNet', 'PerPersonPerNightBasedOnNetPrice', 'PerPersonPerNightBasedOnGrossPrice'];
  if (percentTypes.includes(body.type) && (body.value < 0 || body.value > 100)) {
    throw unprocessable('For a percentage-based city tax, `value` must be between 0 and 100.');
  }
  if (body.value < 0) throw unprocessable('`value` must not be negative.');
  for (const sc of body.subcategories ?? []) {
    if (sc.age.min > sc.age.max) {
      throw unprocessable('A subcategory\'s `age.min` must not exceed `age.max`.');
    }
  }
  const seen = new Set<number>();
  for (const rule of body.pricingRules ?? []) {
    if (seen.has(rule.maxPrice)) {
      throw unprocessable(`Duplicate pricing rule for maxPrice ${rule.maxPrice}.`);
    }
    seen.add(rule.maxPrice);
  }
}

api.op('SettingsCity-taxByIdGet', (req, res) => {
  const t = db.cityTaxes.get(req.params.id!);
  if (!t) throw notFound(`City tax '${req.params.id}' was not found.`);
  res.json(cityTaxBody(t));
});

api.op('SettingsCity-taxByIdPatch', (req, res) => {
  const t = db.cityTaxes.get(req.params.id!);
  if (!t) throw notFound(`City tax '${req.params.id}' was not found.`);
  const ops = req.body as PatchOperation[];
  rejectImmutablePaths(ops, ['/id', '/propertyId']);
  const patched = applyPatch({ ...t }, ops) as CityTax;
  validateCityTax(patched as unknown as Record<string, any>);
  patched.name = normalizeLocalized(patched.name);
  patched.description = normalizeLocalized(patched.description);
  db.cityTaxes.put({ ...patched, id: t.id, propertyId: t.propertyId });
  sendNoContent(res);
});

api.op('SettingsCity-taxByIdDelete', (req, res) => {
  const id = req.params.id!;
  if (!db.cityTaxes.exists(id)) throw notFound(`City tax '${id}' was not found.`);
  db.cityTaxes.delete(id);
  sendNoContent(res);
});

/* ------------------------------------------------------- market segments */

function marketSegmentBody(m: MarketSegment) {
  return {
    id: m.id,
    code: m.code,
    name: m.name,
    description: m.description,
    propertyIds: m.propertyIds,
  };
}

function marketSegmentFilter(propertyIds: readonly string[]) {
  return (m: MarketSegment) => !propertyIds.length || propertyIds.some((p) => m.propertyIds.includes(p));
}

api.op('SettingsMarket-segmentsGet', (req, res) => {
  const propertyIds = arrayParam(req, 'propertyIds');
  const page = paging(req);
  const { items, count } = db.marketSegments.query({
    filter: marketSegmentFilter(propertyIds),
    sort: (a, b) => a.code.localeCompare(b.code),
    offset: page.offset,
    limit: page.pageSize,
  });
  sendList(res, 'marketSegments', items.map(marketSegmentBody), count);
});

api.op('SettingsMarket-segments$countGet', (req, res) => {
  const propertyIds = arrayParam(req, 'propertyIds');
  res.json({ count: db.marketSegments.all().filter(marketSegmentFilter(propertyIds)).length });
});

api.op('SettingsMarket-segmentsPost', (req, res) => {
  const body = req.body as Record<string, any>;
  const code = String(body.code).toUpperCase();
  if (db.marketSegments.exists(code)) {
    throw conflict(`A market segment with code '${code}' already exists.`);
  }
  for (const propertyId of body.propertyIds ?? []) getProperty(propertyId);
  const segment: MarketSegment = {
    id: code,
    code,
    name: body.name,
    description: body.description,
    propertyIds: body.propertyIds ?? [],
  };
  db.marketSegments.put(segment);
  sendCreated(res, `/settings/v1/market-segments/${code}`, { id: code });
});

api.op('SettingsMarket-segmentsByIdGet', (req, res) => {
  const m = db.marketSegments.get(req.params.id!);
  if (!m) throw notFound(`Market segment '${req.params.id}' was not found.`);
  res.json(marketSegmentBody(m));
});

api.op('SettingsMarket-segmentsByIdHead', (req, res) => {
  res.status(db.marketSegments.exists(req.params.id!) ? 200 : 404).end();
});

api.op('SettingsMarket-segmentsByIdPatch', (req, res) => {
  const m = db.marketSegments.get(req.params.id!);
  if (!m) throw notFound(`Market segment '${req.params.id}' was not found.`);
  const ops = req.body as PatchOperation[];
  rejectImmutablePaths(ops, ['/id', '/code']);
  const patched = applyPatch({ ...m }, ops) as MarketSegment;
  for (const propertyId of patched.propertyIds ?? []) getProperty(propertyId);
  db.marketSegments.put({ ...patched, id: m.id, code: m.code });
  sendNoContent(res);
});

api.op('SettingsMarket-segmentsByIdDelete', (req, res) => {
  const id = req.params.id!;
  if (!db.marketSegments.exists(id)) throw notFound(`Market segment '${id}' was not found.`);
  const used = db.reservations.all().filter((r) => r.marketSegmentId === id).length;
  if (used) throw unprocessable(`The market segment is used by ${used} reservation(s).`);
  db.marketSegments.delete(id);
  sendNoContent(res);
});

/* --------------------------------------------------- custom sub-accounts */

function subAccountBody(a: SubAccount) {
  return {
    id: a.id,
    propertyId: a.propertyId,
    code: a.code,
    name: a.name,
    type: a.type,
  };
}

api.op('SettingsSub-accountsGet', (req, res) => {
  const propertyId = requiredStringParam(req, 'propertyId');
  const page = paging(req);
  const { items, count } = db.subAccounts.query({
    where: { propertyId },
    filter: (a) => a.isCustom,
    sort: (a, b) => a.code.localeCompare(b.code),
    offset: page.offset,
    limit: page.pageSize,
  });
  sendList(res, 'subAccounts', items.map(subAccountBody), count);
});

api.op('SettingsSub-accounts$countGet', (req, res) => {
  const propertyId = requiredStringParam(req, 'propertyId');
  res.json({ count: db.subAccounts.all({ propertyId }).filter((a) => a.isCustom).length });
});

api.op('SettingsSub-accountsPost', (req, res) => {
  const body = req.body as Record<string, any>;
  const property = getProperty(body.propertyId);
  const code = String(body.code).toUpperCase();
  const id = scoped(property.id, code);
  if (db.subAccounts.exists(id)) {
    throw conflict(`A sub-account with code '${code}' already exists in property '${property.id}'.`);
  }
  // Custom codes must not collide with the built-in chart of accounts.
  if (db.financeAccounts.all({ propertyId: property.id }).some((a) => a.number === code)) {
    throw unprocessable(`'${code}' is a reserved account number.`);
  }
  const account: SubAccount = {
    id,
    propertyId: property.id,
    number: code,
    code,
    name: body.name,
    type: body.type,
    isCustom: true,
  };
  transact(() => {
    db.subAccounts.put(account);
    // Custom sub-accounts appear in the chart under their service type's parent.
    db.financeAccounts.put({
      id: `${property.id}-${code}`,
      propertyId: property.id,
      number: code,
      name: { en: body.name },
      type: 'Revenues',
      parentNumber: parentForServiceType(body.type),
      scope: 'Global',
      isArchived: false,
    });
  });
  sendCreated(res, `/settings/v1/sub-accounts/${id}`, { id });
});

function parentForServiceType(type: string): string {
  switch (type) {
    case 'Accommodation': return '1100';
    case 'FoodAndBeverages': return '1200';
    default: return '1300';
  }
}

api.op('SettingsSub-accountsByIdGet', (req, res) => {
  const a = db.subAccounts.get(req.params.id!);
  if (!a?.isCustom) throw notFound(`Sub-account '${req.params.id}' was not found.`);
  res.json(subAccountBody(a));
});

api.op('SettingsSub-accountsByIdHead', (req, res) => {
  const a = db.subAccounts.get(req.params.id!);
  res.status(a?.isCustom ? 200 : 404).end();
});

api.op('SettingsSub-accountsByIdPatch', (req, res) => {
  const a = db.subAccounts.get(req.params.id!);
  if (!a?.isCustom) throw notFound(`Sub-account '${req.params.id}' was not found.`);
  const ops = req.body as PatchOperation[];
  rejectImmutablePaths(ops, ['/id', '/code', '/propertyId']);
  const patched = applyPatch({ ...a }, ops) as SubAccount;
  transact(() => {
    db.subAccounts.put({ ...patched, id: a.id, code: a.code, number: a.number, propertyId: a.propertyId, isCustom: true });
    const account = db.financeAccounts.get(`${a.propertyId}-${a.number}`);
    if (account) {
      account.name = { en: patched.name };
      account.parentNumber = parentForServiceType(patched.type);
      db.financeAccounts.put(account);
    }
  });
  sendNoContent(res);
});

api.op('SettingsSub-accountsByIdDelete', (req, res) => {
  const a = db.subAccounts.get(req.params.id!);
  if (!a?.isCustom) throw notFound(`Sub-account '${req.params.id}' was not found.`);
  const posted = db.accountingTransactions.all({ propertyId: a.propertyId })
    .some((t) => t.creditedAccount === a.number || t.debitedAccount === a.number);
  if (posted) throw unprocessable('The sub-account already has postings and cannot be deleted.');
  transact(() => {
    db.subAccounts.delete(a.id);
    db.financeAccounts.delete(`${a.propertyId}-${a.number}`);
  });
  sendNoContent(res);
});

/* -------------------------------------------------- time slice definitions */

function timeSliceDefinitionBody(t: TimeSliceDefinition, langs: readonly string[]) {
  const isUsed = db.ratePlans.all({ propertyId: t.propertyId })
    .some((p) => p.timeSliceDefinitionId === t.id);
  return {
    id: t.id,
    name: resolveLocalized(t.name, langs),
    template: t.template,
    checkInTime: t.checkInTime,
    checkOutTime: t.checkOutTime,
    isUsed,
    actions: [
      { action: 'ModifyCheckInCheckOutTime', isAllowed: true },
      {
        action: 'Delete',
        isAllowed: !isUsed,
        reasons: isUsed
          ? [{ code: 'TimeSliceDefinitionIsUsed', message: 'The time slice definition is used by a rate plan.' }]
          : undefined,
      },
    ],
  };
}

api.op('SettingsPropertiesByPropertyIdTime-slice-definitionsGet', (req, res) => {
  const property = getProperty(req.params.propertyId!);
  const langs = languagesOf(arrayParam(req, 'languages'), property.id);
  const items = db.timeSliceDefinitions.all({ propertyId: property.id });
  sendList(res, 'timeSliceDefinitions', items.map((t) => timeSliceDefinitionBody(t, langs)), items.length);
});

api.op('SettingsPropertiesByPropertyIdTime-slice-definitionsPost', (req, res) => {
  const property = getProperty(req.params.propertyId!);
  const body = req.body as Record<string, any>;
  assertTime(body.checkInTime, 'checkInTime');
  assertTime(body.checkOutTime, 'checkOutTime');
  const code = String(body.name).toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 20);
  const id = scoped(property.id, code || 'SLICE');
  if (db.timeSliceDefinitions.exists(id)) {
    throw conflict(`A time slice definition named '${body.name}' already exists in '${property.id}'.`);
  }
  const definition: TimeSliceDefinition = {
    id,
    propertyId: property.id,
    name: normalizeLocalized(body.name),
    template: body.template,
    checkInTime: body.checkInTime,
    checkOutTime: body.checkOutTime,
  };
  db.timeSliceDefinitions.put(definition);
  sendCreated(res, `/settings/v1/properties/${property.id}/time-slice-definitions/${id}`, { id });
});

function assertTime(value: unknown, field: string): void {
  if (typeof value !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/.test(value)) {
    throw unprocessable(`\`${field}\` must be a time in the format HH:mm.`);
  }
}

api.op('SettingsPropertiesByPropertyIdTime-slice-definitionsByIdGet', (req, res) => {
  const t = lookupTimeSliceDefinition(req.params.propertyId!, req.params.id!);
  res.json(timeSliceDefinitionBody(t, languagesOf(arrayParam(req, 'languages'), t.propertyId)));
});

function lookupTimeSliceDefinition(propertyId: string, id: string): TimeSliceDefinition {
  const t = db.timeSliceDefinitions.get(id);
  if (!t || t.propertyId !== propertyId) {
    throw notFound(`Time slice definition '${id}' was not found in property '${propertyId}'.`);
  }
  return t;
}

api.op('SettingsPropertiesByPropertyIdTime-slice-definitionsByIdPatch', (req, res) => {
  const t = lookupTimeSliceDefinition(req.params.propertyId!, req.params.id!);
  const ops = req.body as PatchOperation[];
  rejectImmutablePaths(ops, ['/id', '/template', '/isUsed']);
  const view = { name: resolveLocalized(t.name, ['en']), checkInTime: t.checkInTime, checkOutTime: t.checkOutTime };
  const patched = applyPatch(view, ops) as typeof view;
  assertTime(patched.checkInTime, 'checkInTime');
  assertTime(patched.checkOutTime, 'checkOutTime');
  t.name = normalizeLocalized(patched.name);
  t.checkInTime = patched.checkInTime;
  t.checkOutTime = patched.checkOutTime;
  db.timeSliceDefinitions.put(t);
  sendNoContent(res);
});

api.op('SettingsPropertiesByPropertyIdTime-slice-definitionsByIdDelete', (req, res) => {
  const t = lookupTimeSliceDefinition(req.params.propertyId!, req.params.id!);
  const used = db.ratePlans.all({ propertyId: t.propertyId })
    .filter((p) => p.timeSliceDefinitionId === t.id).length;
  if (used) throw unprocessable(`The time slice definition is used by ${used} rate plan(s).`);
  db.timeSliceDefinitions.delete(t.id);
  sendNoContent(res);
});

/* ----------------------------------------------------- property settings */

api.op('SettingsPropertiesByIdGet', (req, res) => {
  const property = getProperty(req.params.id!);
  res.json({ timeZone: property.timeZone, currency: property.currencyCode });
});

/* ------------------------------------------------------ invoice addresses */

function invoiceAddressBody(a: InvoiceAddress) {
  return {
    propertyId: a.propertyId,
    addressLine1: a.addressLine1,
    addressLine2: a.addressLine2,
    postalCode: a.postalCode,
    city: a.city,
    regionCode: a.regionCode,
    countryCode: a.countryCode,
  };
}

api.op('SettingsInvoice-addressGet', (req, res) => {
  const propertyIds = arrayParam(req, 'propertyIds');
  const all = db.invoiceAddresses.all()
    .filter((a) => !propertyIds.length || propertyIds.includes(a.propertyId));
  sendList(res, 'addresses', all.map(invoiceAddressBody), all.length);
});

api.op('SettingsInvoice-addressPut', (req, res) => {
  const propertyId = requiredStringParam(req, 'propertyId');
  const property = getProperty(propertyId);
  const body = req.body as Record<string, any>;
  db.invoiceAddresses.put({
    id: property.id,
    propertyId: property.id,
    addressLine1: body.addressLine1,
    addressLine2: body.addressLine2,
    postalCode: body.postalCode,
    city: body.city,
    regionCode: body.regionCode,
    countryCode: String(body.countryCode).toUpperCase(),
  });
  sendNoContent(res);
});

api.op('SettingsInvoice-addressPatch', (req, res) => {
  const propertyId = requiredStringParam(req, 'propertyId');
  const property = getProperty(propertyId);
  const existing = db.invoiceAddresses.get(property.id);
  if (!existing) throw notFound(`No invoice address is configured for property '${property.id}'.`);
  const ops = req.body as PatchOperation[];
  rejectImmutablePaths(ops, ['/propertyId']);
  const patched = applyPatch({ ...existing }, ops) as InvoiceAddress;
  db.invoiceAddresses.put({ ...patched, id: property.id, propertyId: property.id });
  sendNoContent(res);
});

/* -------------------------------------------------------------- languages */

const LANGUAGE_SETTINGS_ID = 'ACCOUNT';

function currentLanguages(): LanguageSetting[] {
  return db.languageSettings.get(LANGUAGE_SETTINGS_ID)?.languages
    ?? [{ code: 'en', default: true, mandatory: true }];
}

api.op('SettingsLanguagesGet', (_req, res) => {
  res.json({ languages: currentLanguages() });
});

api.op('SettingsLanguagesPut', (req, res) => {
  const body = req.body as { languages: { code: string; mandatory: boolean }[] };
  if (!body.languages.length) throw unprocessable('At least one language must be configured.');
  for (const l of body.languages) {
    if (!(LANGUAGE_CODES as readonly string[]).includes(l.code.toLowerCase())) {
      throw unprocessable(`'${l.code}' is not a supported language code.`);
    }
  }
  // The first entry becomes the account default, matching how the UI presents it.
  const languages: LanguageSetting[] = body.languages.map((l, i) => ({
    code: l.code.toLowerCase(),
    default: i === 0,
    mandatory: l.mandatory,
  }));
  db.languageSettings.put({ id: LANGUAGE_SETTINGS_ID, languages });
  sendNoContent(res);
});

/* --------------------------------------------------------------- features */

function featureSettingsOf(propertyId: string): FeatureSettings {
  const existing = db.featureSettings.all({ propertyId })[0];
  if (existing) return existing;
  const created: FeatureSettings = {
    id: scoped(propertyId, 'FEATURES'),
    propertyId,
    areCustomRevenueSubAccountsEnabled: false,
    performAccountingForOpenInvoiceActions: true,
    showRecipientForEachLineItemOnTheInvoice: false,
    invoiceNumberPattern: `${propertyId}-{yyyy}-{00000}`,
    advanceInvoiceNumberPattern: `${propertyId}-A-{yyyy}-{00000}`,
  };
  db.featureSettings.put(created);
  return created;
}

function featureBody(f: FeatureSettings) {
  return {
    areCustomRevenueSubAccountsEnabled: f.areCustomRevenueSubAccountsEnabled,
    performAccountingForOpenInvoiceActions: f.performAccountingForOpenInvoiceActions,
    showRecipientForEachLineItemOnTheInvoice: f.showRecipientForEachLineItemOnTheInvoice,
    maxAmountForMinimalInvoices: f.maxAmountForMinimalInvoices,
    invoiceNumberPattern: f.invoiceNumberPattern,
    advanceInvoiceNumberPattern: f.advanceInvoiceNumberPattern,
  };
}

api.op('SettingsFeaturesByPropertyIdGet', (req, res) => {
  const property = getProperty(req.params.propertyId!);
  res.json(featureBody(featureSettingsOf(property.id)));
});

api.op('SettingsFeaturesByPropertyIdPatch', (req, res) => {
  const property = getProperty(req.params.propertyId!);
  const current = featureSettingsOf(property.id);
  const ops = req.body as PatchOperation[];
  const patched = applyPatch(featureBody(current) as Record<string, any>, ops);
  db.featureSettings.put({ ...current, ...patched, id: current.id, propertyId: property.id });
  sendNoContent(res);
});

/* -------------------------------------------------------- capture policies */

function capturePolicyBody(p: CapturePolicy) {
  return {
    id: p.id,
    code: p.code,
    propertyId: p.propertyId,
    captureNoShowFee: p.captureNoShowFee,
    captureCancellationFee: p.captureCancellationFee,
    capturePrepayment: p.capturePrepayment,
    postOtaBankTransferOnCheckOut: p.postOtaBankTransferOnCheckOut,
    capturePayment: p.capturePayment,
  };
}

api.op('SettingsCapture-policiesGet', (req, res) => {
  const propertyId = stringParam(req, 'propertyId');
  const page = paging(req);
  const { items, count } = db.capturePolicies.query({
    where: { propertyId },
    sort: (a, b) => a.id.localeCompare(b.id),
    offset: page.offset,
    limit: page.pageSize,
  });
  sendList(res, 'capturePolicies', items.map(capturePolicyBody), count);
});

api.op('SettingsCapture-policiesByIdGet', (req, res) => {
  const p = db.capturePolicies.get(req.params.id!);
  if (!p) throw notFound(`Capture policy '${req.params.id}' was not found.`);
  res.json(capturePolicyBody(p));
});

api.op('SettingsCapture-policiesByIdPatch', (req, res) => {
  const p = db.capturePolicies.get(req.params.id!);
  if (!p) throw notFound(`Capture policy '${req.params.id}' was not found.`);
  const ops = req.body as PatchOperation[];
  rejectImmutablePaths(ops, ['/id', '/propertyId', '/code']);
  const patched = applyPatch({ ...p }, ops) as CapturePolicy;
  db.capturePolicies.put({ ...patched, id: p.id, code: p.code, propertyId: p.propertyId });
  sendNoContent(res);
});

export const settingsRouter = api.build();
