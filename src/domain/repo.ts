import { store } from '../core/db';
import { notFound, unprocessable } from '../core/errors';
import { resolveLocalized } from '../core/localized';
import type * as T from './types';

/** Typed handles onto every collection. */
export const db = {
  accounts: store<T.Account>('accounts'),
  users: store<T.User>('users'),

  properties: store<T.Property>('properties'),
  unitGroups: store<T.UnitGroup>('unitGroups'),
  units: store<T.Unit>('units'),
  unitAttributes: store<T.UnitAttributeDefinition>('unitAttributes'),

  ageCategories: store<T.AgeCategory>('ageCategories'),
  timeSliceDefinitions: store<T.TimeSliceDefinition>('timeSliceDefinitions'),
  ratePlans: store<T.RatePlan>('ratePlans'),
  rates: store<T.Rate>('rates'),
  cancellationPolicies: store<T.CancellationPolicy>('cancellationPolicies'),
  noShowPolicies: store<T.NoShowPolicy>('noShowPolicies'),
  capturePolicies: store<T.CapturePolicy>('capturePolicies'),
  services: store<T.Service>('services'),
  companies: store<T.Company>('companies'),

  cityTaxes: store<T.CityTax>('cityTaxes'),
  marketSegments: store<T.MarketSegment>('marketSegments'),
  subAccounts: store<T.SubAccount>('subAccounts'),
  financeAccounts: store<T.FinanceAccount>('financeAccounts'),
  accountingTransactions: store<T.AccountingTransaction>('accountingTransactions'),
  invoiceAddresses: store<T.InvoiceAddress>('invoiceAddresses'),
  propertySettings: store<T.PropertySettings>('propertySettings'),
  featureSettings: store<T.FeatureSettings>('featureSettings'),
  languageSettings: store<{ id: string; languages: T.LanguageSetting[] }>('languageSettings'),

  bookings: store<T.Booking>('bookings'),
  reservations: store<T.Reservation>('reservations'),
  blocks: store<T.Block>('blocks'),
  groups: store<T.Group>('groups'),
  overbookings: store<T.Overbooking>('overbookings'),
  paymentAccounts: store<T.PaymentAccount>('paymentAccounts'),
  authorizations: store<T.Authorization>('authorizations'),

  folios: store<T.Folio>('folios'),
  charges: store<T.Charge>('charges'),
  payments: store<T.Payment>('payments'),
  refunds: store<T.Refund>('refunds'),
  allowances: store<T.Allowance>('allowances'),
  transitoryCharges: store<T.TransitoryCharge>('transitoryCharges'),
  invoices: store<T.Invoice>('invoices'),
  routings: store<T.Routing>('routings'),

  maintenances: store<T.Maintenance>('maintenances'),
  nightAuditLogs: store<T.NightAuditLog>('nightAuditLogs'),
  reservationLogs: store<T.AuditLogEntry>('reservationLogs'),
  folioLogs: store<T.AuditLogEntry>('folioLogs'),
  transactionExportLogs: store<T.TransactionExportLog>('transactionExportLogs'),
};

/* -------------------------------------------------------------- lookups */

export function property(id: string): T.Property {
  const p = db.properties.get(id);
  if (!p) throw notFound(`Property '${id}' was not found.`);
  return p;
}

export function unitGroup(id: string): T.UnitGroup {
  const g = db.unitGroups.get(id);
  if (!g) throw notFound(`Unit group '${id}' was not found.`);
  return g;
}

export function unit(id: string): T.Unit {
  const u = db.units.get(id);
  if (!u) throw notFound(`Unit '${id}' was not found.`);
  return u;
}

export function ratePlan(id: string): T.RatePlan {
  const r = db.ratePlans.get(id);
  if (!r) throw notFound(`Rate plan '${id}' was not found.`);
  return r;
}

export function reservation(id: string): T.Reservation {
  const r = db.reservations.get(id);
  if (!r) throw notFound(`Reservation '${id}' was not found.`);
  return r;
}

export function booking(id: string): T.Booking {
  const b = db.bookings.get(id);
  if (!b) throw notFound(`Booking '${id}' was not found.`);
  return b;
}

export function block(id: string): T.Block {
  const b = db.blocks.get(id);
  if (!b) throw notFound(`Block '${id}' was not found.`);
  return b;
}

export function group(id: string): T.Group {
  const g = db.groups.get(id);
  if (!g) throw notFound(`Group '${id}' was not found.`);
  return g;
}

export function folio(id: string): T.Folio {
  const f = db.folios.get(id);
  if (!f) throw notFound(`Folio '${id}' was not found.`);
  return f;
}

export function invoice(id: string): T.Invoice {
  const i = db.invoices.get(id);
  if (!i) throw notFound(`Invoice '${id}' was not found.`);
  return i;
}

export function service(id: string): T.Service {
  const s = db.services.get(id);
  if (!s) throw notFound(`Service '${id}' was not found.`);
  return s;
}

export function timeSliceDefinition(id: string): T.TimeSliceDefinition {
  const t = db.timeSliceDefinitions.get(id);
  if (!t) throw notFound(`Time slice definition '${id}' was not found.`);
  return t;
}

/** Validate that a referenced entity exists, reporting a 422 rather than 404. */
export function mustReference<E extends { id: string }>(
  collection: { get(id: string): E | undefined },
  id: string,
  label: string,
): E {
  const e = collection.get(id);
  if (!e) throw unprocessable(`${label} '${id}' does not exist.`);
  return e;
}

/* ------------------------------------------------------ embedded models */

export type Languages = readonly string[];

export function embeddedProperty(id: string, langs: Languages = []) {
  const p = db.properties.get(id);
  if (!p) return { id };
  return {
    id: p.id,
    code: p.code,
    name: resolveLocalized(p.name, langs),
    description: resolveLocalized(p.description, langs),
  };
}

export function embeddedUnitGroup(id: string | undefined, langs: Languages = []) {
  if (!id) return undefined;
  const g = db.unitGroups.get(id);
  if (!g) return { id };
  return {
    id: g.id,
    code: g.code,
    name: resolveLocalized(g.name, langs),
    description: resolveLocalized(g.description, langs),
    type: g.type,
  };
}

export function embeddedUnit(id: string | undefined, langs: Languages = []) {
  if (!id) return undefined;
  const u = db.units.get(id);
  if (!u) return { id };
  return {
    id: u.id,
    name: u.name,
    description: resolveLocalized(u.description, langs),
    unitGroupId: u.unitGroupId,
  };
}

export function embeddedRatePlan(id: string | undefined, langs: Languages = []) {
  if (!id) return undefined;
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

export function embeddedMarketSegment(id: string | undefined, langs: Languages = []) {
  if (!id) return undefined;
  const m = db.marketSegments.get(id);
  if (!m) return { id };
  return { id: m.id, code: m.code, name: m.name };
}

export function embeddedCompany(id: string | undefined) {
  if (!id) return undefined;
  const c = db.companies.get(id);
  if (!c) return { id };
  return { id: c.id, code: c.code, name: c.name, canCheckOutOnAr: c.canCheckOutOnAr };
}

export function embeddedService(id: string | undefined, langs: Languages = []) {
  if (!id) return undefined;
  const s = db.services.get(id);
  if (!s) return { id };
  return {
    id: s.id,
    code: s.code,
    name: resolveLocalized(s.name, langs),
    description: resolveLocalized(s.description, langs),
    pricingUnit: s.pricingUnit,
    defaultGrossPrice: { amount: s.defaultGrossPrice, currency: s.currency },
  };
}


export function embeddedCancellationPolicy(id: string | undefined, langs: Languages = []) {
  if (!id) return undefined;
  const c = db.cancellationPolicies.get(id);
  if (!c) return { id };
  return {
    id: c.id,
    code: c.code,
    name: resolveLocalized(c.name, langs),
    description: resolveLocalized(c.description, langs),
    periodFromReference: c.periodFromReference,
    reference: c.reference,
  };
}

export function embeddedNoShowPolicy(id: string | undefined, langs: Languages = []) {
  if (!id) return undefined;
  const n = db.noShowPolicies.get(id);
  if (!n) return { id };
  return {
    id: n.id,
    code: n.code,
    name: resolveLocalized(n.name, langs),
    description: resolveLocalized(n.description, langs),
  };
}

export function embeddedTimeSliceDefinition(id: string | undefined, langs: Languages = []) {
  if (!id) return undefined;
  const t = db.timeSliceDefinitions.get(id);
  if (!t) return { id };
  return {
    id: t.id,
    name: resolveLocalized(t.name, langs),
    template: t.template,
    checkInTime: t.checkInTime,
    checkOutTime: t.checkOutTime,
  };
}

/* ------------------------------------------------------------- utilities */

/** All non-archived units belonging to a unit group. */
export function unitsOfGroup(unitGroupId: string): T.Unit[] {
  return db.units.all({ unitGroupId, isArchived: false });
}

/** Physical inventory count for a unit group. */
export function physicalCount(unitGroupId: string): number {
  return db.units.count({ unitGroupId, isArchived: false });
}

export function ratePlansOfProperty(propertyId: string): T.RatePlan[] {
  return db.ratePlans.all({ propertyId });
}

/** Resolve the language preference list for a request. */
export function languagesOf(values: readonly string[], propertyId?: string): string[] {
  if (values.length) return [...values];
  if (propertyId) {
    const s = db.propertySettings.all({ propertyId })[0];
    if (s?.defaultLanguage) return [s.defaultLanguage];
  }
  return ['en'];
}
