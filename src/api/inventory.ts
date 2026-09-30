import type { Request } from 'express';
import { ApiBuilder } from '../core/router';
import {
  arrayParam, boolParam, paging, sendList, sendCreated, sendNoContent, stringParam,
} from '../core/http';
import { conflict, notFound, unprocessable } from '../core/errors';
import { applyPatch, rejectImmutablePaths, type PatchOperation } from '../core/patch';
import { mergeLocalized, normalizeLocalized, resolveLocalized } from '../core/localized';
import { isValidTimeZone, nowIso, today } from '../core/dates';
import { scoped, unitId as mintUnitId } from '../core/ids';
import { transact } from '../core/db';
import { db, embeddedProperty, embeddedUnitGroup, languagesOf, physicalCount, property as getProperty, unit as getUnit, unitGroup as getUnitGroup } from '../domain/repo';
import type { Property, Unit, UnitAttributeDefinition, UnitGroup } from '../domain/types';
import { COUNTRY_CODES } from '../domain/reference';
import { bootstrapChartOfAccounts } from '../domain/accounts';
import { putRate } from '../domain/pricing';
import { unitIsOccupied, activeMaintenanceFor } from '../domain/operations';

/**
 * Inventory API - properties, unit groups, units and unit attributes.
 * This is the root of the data model: nothing else can exist without a
 * property, and availability is ultimately a count of the units declared here.
 */

const api = new ApiBuilder('inventory-v1');

/* ------------------------------------------------------------ presenters */

function propertyActions(p: Property) {
  const hasUnits = db.units.count({ propertyId: p.id }) > 0;
  const hasReservations = db.reservations.count({ propertyId: p.id }) > 0;
  return [
    {
      action: 'Delete',
      isAllowed: p.status === 'Test' && !hasReservations,
      reasons: p.status === 'Live'
        ? [{ code: 'PropertyIsLive', message: 'A live property cannot be deleted.' }]
        : hasReservations
          ? [{ code: 'PropertyHasReservations', message: 'The property has reservations.' }]
          : undefined,
    },
    {
      action: 'Archive',
      isAllowed: !p.isArchived,
      reasons: p.isArchived
        ? [{ code: 'PropertyIsArchived', message: 'The property is already archived.' }]
        : undefined,
    },
    {
      action: 'SetLive',
      isAllowed: p.status === 'Test' && hasUnits,
      reasons: p.status === 'Live'
        ? [{ code: 'PropertyIsLive', message: 'The property is already live.' }]
        : !hasUnits
          ? [{ code: 'PropertyHasNoUnits', message: 'The property has no units.' }]
          : undefined,
    },
    {
      action: 'Reset',
      isAllowed: p.status === 'Test',
      reasons: p.status === 'Live'
        ? [{ code: 'PropertyIsLive', message: 'A live property cannot be reset.' }]
        : undefined,
    },
  ];
}

function propertyDetail(p: Property, withActions: boolean) {
  return {
    id: p.id,
    code: p.code,
    propertyTemplateId: p.propertyTemplateId,
    isTemplate: p.isTemplate,
    name: p.name,
    description: p.description,
    companyName: p.companyName,
    managingDirectors: p.managingDirectors,
    commercialRegisterEntry: p.commercialRegisterEntry,
    taxId: p.taxId,
    location: p.location,
    bankAccount: p.bankAccount,
    paymentTerms: p.paymentTerms,
    timeZone: p.timeZone,
    currencyCode: p.currencyCode,
    created: p.created,
    status: p.status,
    isArchived: p.isArchived,
    ...(withActions ? { actions: propertyActions(p) } : {}),
  };
}

function propertyItem(p: Property, langs: readonly string[], withActions: boolean) {
  return {
    ...propertyDetail(p, withActions),
    name: resolveLocalized(p.name, langs),
    description: resolveLocalized(p.description, langs),
    paymentTerms: resolveLocalized(p.paymentTerms, langs),
  };
}

function unitGroupDetail(g: UnitGroup, langs: readonly string[]) {
  return {
    id: g.id,
    code: g.code,
    property: embeddedProperty(g.propertyId, langs),
    name: g.name,
    description: g.description,
    memberCount: physicalCount(g.id),
    maxPersons: g.maxPersons,
    rank: g.rank,
    type: g.type,
    connectedUnitGroups: g.connectedUnitGroups?.length
      ? g.connectedUnitGroups.map((c) => ({
        unitGroup: embeddedUnitGroup(c.unitGroupId, langs),
        memberCount: c.memberCount,
      }))
      : undefined,
  };
}

function unitGroupItem(g: UnitGroup, langs: readonly string[]) {
  return {
    ...unitGroupDetail(g, langs),
    name: resolveLocalized(g.name, langs),
    description: resolveLocalized(g.description, langs),
  };
}

function unitStatus(u: Unit, langs: readonly string[]) {
  const maintenance = activeMaintenanceFor(u.id);
  return {
    isOccupied: unitIsOccupied(u.id),
    condition: u.condition,
    ...(maintenance
      ? {
        maintenance: {
          id: maintenance.id,
          from: maintenance.from,
          to: maintenance.to,
          type: maintenance.type,
          description: maintenance.description,
        },
      }
      : {}),
  };
}

function unitActions(u: Unit) {
  const hasFutureReservations = db.reservations
    .all({ unitId: u.id })
    .some((r) => r.status === 'Confirmed' || r.status === 'InHouse');
  return [
    {
      action: 'Delete',
      isAllowed: !hasFutureReservations && !u.isArchived,
      reasons: hasFutureReservations
        ? [{ code: 'UnitHasReservations', message: 'The unit has active reservations.' }]
        : undefined,
    },
    {
      action: 'Archive',
      isAllowed: !u.isArchived,
      reasons: u.isArchived
        ? [{ code: 'UnitIsArchived', message: 'The unit is already archived.' }]
        : undefined,
    },
  ];
}

function attributesOf(u: Unit) {
  return u.attributes
    .map((id) => db.unitAttributes.get(id))
    .filter((a): a is UnitAttributeDefinition => !!a)
    .map((a) => ({ id: a.id, name: a.name, description: a.description }));
}

function connectedUnitsOf(u: Unit, langs: readonly string[]) {
  return u.connectedUnitIds
    .map((id) => db.units.get(id))
    .filter((c): c is Unit => !!c)
    .map((c) => ({
      id: c.id,
      name: c.name,
      description: resolveLocalized(c.description, langs) ?? '',
      unitGroupId: c.unitGroupId,
      condition: c.condition,
      maxPersons: c.maxPersons,
    }));
}

function unitDetail(u: Unit, langs: readonly string[], withActions: boolean) {
  return {
    id: u.id,
    name: u.name,
    description: u.description,
    property: embeddedProperty(u.propertyId, langs),
    unitGroup: embeddedUnitGroup(u.unitGroupId, langs),
    status: unitStatus(u, langs),
    maxPersons: u.maxPersons,
    created: u.created,
    archived: u.archived,
    isArchived: u.isArchived,
    attributes: attributesOf(u),
    connectedUnits: u.connectedUnitIds.length ? connectedUnitsOf(u, langs) : undefined,
    ...(withActions ? { actions: unitActions(u) } : {}),
  };
}

function unitItem(u: Unit, langs: readonly string[], withActions: boolean) {
  return { ...unitDetail(u, langs, withActions), description: resolveLocalized(u.description, langs) };
}

/* ------------------------------------------------------------ properties */

api.op('InventoryPropertiesGet', (req, res) => {
  const langs = arrayParam(req, 'languages');
  const expand = arrayParam(req, 'expand').includes('actions');
  const statuses = arrayParam(req, 'status');
  const countries = arrayParam(req, 'countryCode').map((c) => c.toUpperCase());
  const includeArchived = boolParam(req, 'includeArchived') ?? false;
  const page = paging(req);

  const { items, count } = db.properties.query({
    filter: (p) =>
      (includeArchived || !p.isArchived)
      && (statuses.length === 0 || statuses.includes(p.status))
      && (countries.length === 0 || countries.includes(p.location.countryCode.toUpperCase())),
    sort: (a, b) => a.code.localeCompare(b.code),
    offset: page.offset,
    limit: page.pageSize,
  });
  sendList(res, 'properties', items.map((p) => propertyItem(p, langs, expand)), count);
});

api.op('InventoryProperties$countGet', (req, res) => {
  const statuses = arrayParam(req, 'status');
  const countries = arrayParam(req, 'countryCode').map((c) => c.toUpperCase());
  const includeArchived = boolParam(req, 'includeArchived') ?? false;
  const count = db.properties.all().filter((p) =>
    (includeArchived || !p.isArchived)
    && (statuses.length === 0 || statuses.includes(p.status))
    && (countries.length === 0 || countries.includes(p.location.countryCode.toUpperCase()))).length;
  res.json({ count });
});

api.op('InventoryPropertiesPost', (req, res) => {
  const body = req.body as Record<string, any>;
  const code = String(body.code).toUpperCase();
  if (!/^[A-Z0-9]{3,10}$/.test(code)) {
    throw unprocessable('`code` must be 3-10 alphanumeric characters.');
  }
  if (db.properties.exists(code)) {
    throw conflict(`A property with code '${code}' already exists.`);
  }
  if (!isValidTimeZone(body.timeZone)) {
    throw unprocessable(`'${body.timeZone}' is not a recognised IANA time zone.`);
  }
  if (!/^[A-Z]{3}$/.test(String(body.currencyCode).toUpperCase())) {
    throw unprocessable('`currencyCode` must be a three-letter ISO 4217 code.');
  }
  assertTime(body.defaultCheckInTime, 'defaultCheckInTime');
  assertTime(body.defaultCheckOutTime, 'defaultCheckOutTime');

  const timeZone = body.timeZone as string;
  const created: Property = {
    id: code,
    code,
    isTemplate: false,
    name: normalizeLocalized(body.name),
    description: normalizeLocalized(body.description),
    companyName: body.companyName,
    managingDirectors: body.managingDirectors,
    commercialRegisterEntry: body.commercialRegisterEntry,
    taxId: body.taxId,
    location: {
      addressLine1: body.location.addressLine1,
      addressLine2: body.location.addressLine2,
      postalCode: body.location.postalCode,
      city: body.location.city,
      regionCode: body.location.regionCode,
      countryCode: String(body.location.countryCode).toUpperCase(),
    },
    bankAccount: body.bankAccount,
    paymentTerms: normalizeLocalized(body.paymentTerms),
    timeZone,
    currencyCode: String(body.currencyCode).toUpperCase(),
    created: nowIso(),
    status: 'Test',
    isArchived: false,
    defaultCheckInTime: body.defaultCheckInTime,
    defaultCheckOutTime: body.defaultCheckOutTime,
    businessDate: today(timeZone),
  };
  db.properties.put(created);
  bootstrapProperty(created);
  sendCreated(res, `/inventory/v1/properties/${created.id}`, { id: created.id });
});

/**
 * A brand new property is not usable until it has the entities every booking
 * touches. apaleo does the same on creation, so we seed the default night
 * time-slice definition, the standard sub-accounts and a default market
 * segment rather than making callers discover the gap at booking time.
 */
function bootstrapProperty(p: Property): void {
  db.timeSliceDefinitions.put({
    id: scoped(p.id, 'NIGHT'),
    propertyId: p.id,
    name: { en: 'Night' },
    template: 'OverNight',
    checkInTime: p.defaultCheckInTime,
    checkOutTime: p.defaultCheckOutTime,
  });
  const languages = Object.keys(p.name).length ? Object.keys(p.name) : ['en'];
  db.propertySettings.put({
    id: scoped(p.id, 'SETTINGS'),
    propertyId: p.id,
    overbookingByUnitGroup: {},
    globalOverbooking: 0,
    languages,
    defaultLanguage: languages[0] ?? 'en',
  });
  db.featureSettings.put({
    id: scoped(p.id, 'FEATURES'),
    propertyId: p.id,
    areCustomRevenueSubAccountsEnabled: false,
    performAccountingForOpenInvoiceActions: true,
    showRecipientForEachLineItemOnTheInvoice: false,
    invoiceNumberPattern: `${p.id}-{yyyy}-{00000}`,
    advanceInvoiceNumberPattern: `${p.id}-A-{yyyy}-{00000}`,
  });
  db.capturePolicies.put({
    id: scoped(p.id, 'DEFAULT'),
    propertyId: p.id,
    code: 'DEFAULT',
    captureNoShowFee: false,
    captureCancellationFee: false,
    capturePrepayment: false,
    postOtaBankTransferOnCheckOut: false,
    capturePayment: 'Manual',
  });
  bootstrapChartOfAccounts(p);

  // Every property needs at least one market segment to report against.
  const direct = db.marketSegments.get('DIRECT');
  if (direct) {
    if (!direct.propertyIds.includes(p.id)) {
      direct.propertyIds.push(p.id);
      db.marketSegments.put(direct);
    }
  } else {
    db.marketSegments.put({
      id: 'DIRECT',
      code: 'DIRECT',
      name: 'Direct',
      description: 'Guests booking directly with the property',
      propertyIds: [p.id],
    });
  }
}

function assertTime(value: unknown, field: string): void {
  if (typeof value !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/.test(value)) {
    throw unprocessable(`\`${field}\` must be a time in the format HH:mm.`);
  }
}

api.op('InventoryPropertiesByIdGet', (req, res) => {
  const p = getProperty(req.params.id!);
  res.json(propertyDetail(p, arrayParam(req, 'expand').includes('actions')));
});

api.op('InventoryPropertiesByIdHead', (req, res) => {
  res.status(db.properties.exists(req.params.id!) ? 200 : 404).end();
});

api.op('InventoryPropertiesByIdPatch', (req, res) => {
  const p = getProperty(req.params.id!);
  const ops = req.body as PatchOperation[];
  rejectImmutablePaths(ops, ['/id', '/code', '/created', '/status', '/isArchived', '/currencyCode']);
  const patched = applyPatch({ ...p }, ops) as Property;
  patched.name = normalizeLocalized(patched.name);
  patched.description = normalizeLocalized(patched.description);
  patched.paymentTerms = normalizeLocalized(patched.paymentTerms);
  if (patched.timeZone !== p.timeZone && !isValidTimeZone(patched.timeZone)) {
    throw unprocessable(`'${patched.timeZone}' is not a recognised IANA time zone.`);
  }
  // Preserve fields the wire model never exposes.
  patched.businessDate = p.businessDate;
  patched.id = p.id;
  patched.code = p.code;
  db.properties.put(patched);
  sendNoContent(res);
});

api.op('InventoryPropertiesByIdDelete', (req, res) => {
  const p = getProperty(req.params.id!);
  if (p.status === 'Live') throw unprocessable('A live property cannot be deleted.');
  if (db.reservations.count({ propertyId: p.id }) > 0) {
    throw unprocessable('The property has reservations and cannot be deleted.');
  }
  transact(() => {
    purgePropertyData(p.id);
    db.properties.delete(p.id);
  });
  sendNoContent(res);
});

/** Remove everything scoped to a property. Used by delete and reset. */
function purgePropertyData(propertyId: string): void {
  const scopedCollections = [
    db.unitGroups, db.units, db.ageCategories, db.timeSliceDefinitions, db.ratePlans,
    db.rates, db.cancellationPolicies, db.noShowPolicies, db.capturePolicies, db.services,
    db.cityTaxes, db.subAccounts, db.invoiceAddresses, db.propertySettings,
    db.featureSettings, db.financeAccounts, db.accountingTransactions, db.overbookings,
    db.reservations, db.blocks, db.groups, db.folios, db.charges, db.payments,
    db.allowances, db.transitoryCharges, db.invoices, db.routings, db.maintenances,
    db.nightAuditLogs, db.reservationLogs, db.folioLogs, db.authorizations,
  ];
  for (const c of scopedCollections) c.deleteWhere({ propertyId });
  db.companies.deleteWhere({ propertyId });
  // Market segments are shared across the account, so detach rather than drop.
  for (const m of db.marketSegments.all()) {
    if (!m.propertyIds.includes(propertyId)) continue;
    m.propertyIds = m.propertyIds.filter((id) => id !== propertyId);
    db.marketSegments.put(m);
  }
}

api.op('InventoryProperty-actionsByIdArchivePut', (req, res) => {
  const p = getProperty(req.params.id!);
  if (p.isArchived) throw unprocessable('The property is already archived.');
  const inHouse = db.reservations.all({ propertyId: p.id, status: 'InHouse' }).length;
  if (inHouse > 0) throw unprocessable(`The property has ${inHouse} in-house reservation(s).`);
  p.isArchived = true;
  db.properties.put(p);
  sendNoContent(res);
});

api.op('InventoryProperty-actionsByIdSet-livePut', (req, res) => {
  const p = getProperty(req.params.id!);
  if (p.status === 'Live') throw unprocessable('The property is already live.');
  if (db.units.count({ propertyId: p.id, isArchived: false }) === 0) {
    throw unprocessable('The property has no units and cannot be set live.');
  }
  p.status = 'Live';
  db.properties.put(p);
  sendNoContent(res);
});

api.op('InventoryProperty-actionsByIdResetPut', (req, res) => {
  const p = getProperty(req.params.id!);
  if (p.status === 'Live') throw unprocessable('A live property cannot be reset.');
  transact(() => {
    purgePropertyData(p.id);
    p.businessDate = today(p.timeZone);
    db.properties.put(p);
    bootstrapProperty(p);
  });
  sendNoContent(res);
});

api.op('InventoryProperty-actionsByIdClonePost', (req, res) => {
  const source = getProperty(req.params.id!);
  const body = req.body as Record<string, any>;
  const code = String(body.code).toUpperCase();
  if (db.properties.exists(code)) throw conflict(`A property with code '${code}' already exists.`);

  transact(() => {
    const clone: Property = {
      ...structuredClone(source),
      id: code,
      code,
      propertyTemplateId: source.id,
      name: normalizeLocalized(body.name ?? source.name),
      status: 'Test',
      isArchived: false,
      created: nowIso(),
      businessDate: today(body.timeZone ?? source.timeZone),
      timeZone: body.timeZone ?? source.timeZone,
      currencyCode: (body.currencyCode ?? source.currencyCode).toUpperCase(),
      location: body.location
        ? { ...body.location, countryCode: String(body.location.countryCode).toUpperCase() }
        : structuredClone(source.location),
    };
    db.properties.put(clone);
    cloneConfiguration(source.id, code);
  });
  sendCreated(res, `/inventory/v1/properties/${code}`, { id: code });
});

/**
 * Copy the *configuration* of a property - unit groups, units, rate plans,
 * services, policies - but never its bookings or financials. The ids are
 * rewritten from the source prefix to the target prefix so the clone is
 * self-contained.
 */
function cloneConfiguration(fromId: string, toId: string): void {
  const remap = (id: string | undefined) =>
    id && id.startsWith(`${fromId}-`) ? `${toId}-${id.slice(fromId.length + 1)}` : id;

  for (const g of db.unitGroups.all({ propertyId: fromId })) {
    db.unitGroups.put({
      ...structuredClone(g),
      id: remap(g.id)!,
      propertyId: toId,
      connectedUnitGroups: g.connectedUnitGroups.map((c) => ({ ...c, unitGroupId: remap(c.unitGroupId)! })),
    });
  }
  for (const u of db.units.all({ propertyId: fromId })) {
    db.units.put({
      ...structuredClone(u),
      id: remap(u.id)!,
      propertyId: toId,
      unitGroupId: remap(u.unitGroupId),
      connectedUnitIds: u.connectedUnitIds.map((c) => remap(c)!),
      created: nowIso(),
      isArchived: false,
      archived: undefined,
      condition: 'Clean',
    });
  }
  for (const a of db.ageCategories.all({ propertyId: fromId })) {
    db.ageCategories.put({ ...structuredClone(a), id: remap(a.id)!, propertyId: toId });
  }
  for (const t of db.timeSliceDefinitions.all({ propertyId: fromId })) {
    db.timeSliceDefinitions.put({ ...structuredClone(t), id: remap(t.id)!, propertyId: toId });
  }
  for (const c of db.cancellationPolicies.all({ propertyId: fromId })) {
    db.cancellationPolicies.put({ ...structuredClone(c), id: remap(c.id)!, propertyId: toId });
  }
  for (const n of db.noShowPolicies.all({ propertyId: fromId })) {
    db.noShowPolicies.put({ ...structuredClone(n), id: remap(n.id)!, propertyId: toId });
  }
  for (const s of db.subAccounts.all({ propertyId: fromId })) {
    db.subAccounts.put({ ...structuredClone(s), id: remap(s.id)!, propertyId: toId });
  }
  for (const a of db.financeAccounts.all({ propertyId: fromId, scope: 'Global' })) {
    db.financeAccounts.put({ ...structuredClone(a), id: `${toId}-${a.number}`, propertyId: toId });
  }
  for (const s of db.services.all({ propertyId: fromId })) {
    db.services.put({
      ...structuredClone(s),
      id: remap(s.id)!,
      propertyId: toId,
      accountingConfigs: s.accountingConfigs.map((c) => ({ ...c, subAccountId: remap(c.subAccountId) })),
    });
  }
  for (const t of db.cityTaxes.all({ propertyId: fromId })) {
    db.cityTaxes.put({ ...structuredClone(t), id: remap(t.id)!, propertyId: toId });
  }
  for (const m of db.marketSegments.all()) {
    if (!m.propertyIds.includes(fromId) || m.propertyIds.includes(toId)) continue;
    m.propertyIds.push(toId);
    db.marketSegments.put(m);
  }
  for (const r of db.ratePlans.all({ propertyId: fromId })) {
    db.ratePlans.put({
      ...structuredClone(r),
      id: remap(r.id)!,
      propertyId: toId,
      unitGroupId: remap(r.unitGroupId)!,
      timeSliceDefinitionId: remap(r.timeSliceDefinitionId)!,
      cancellationPolicyId: remap(r.cancellationPolicyId),
      noShowPolicyId: remap(r.noShowPolicyId),
      pricingRule: r.pricingRule
        ? { ...r.pricingRule, baseRatePlanId: remap(r.pricingRule.baseRatePlanId)! }
        : undefined,
      marketSegmentId: remap(r.marketSegmentId),
      accountingConfigs: r.accountingConfigs.map((c) => ({ ...c, subAccountId: remap(c.subAccountId) })),
      includedServices: r.includedServices.map((s) => ({ ...s, serviceId: remap(s.serviceId)! })),
      ageCategories: r.ageCategories.map((a) => ({ ...a, ageCategoryId: remap(a.ageCategoryId)! })),
      companies: [],
    });
  }
  for (const rate of db.rates.all({ propertyId: fromId })) {
    // Rate ids are derived from the plan and date, so they have to be minted
    // through `putRate` rather than string-patched.
    putRate({
      ...structuredClone(rate),
      ratePlanId: remap(rate.ratePlanId)!,
      propertyId: toId,
    });
  }
  const settings = db.propertySettings.all({ propertyId: fromId })[0];
  if (settings) {
    db.propertySettings.put({
      ...structuredClone(settings),
      id: scoped(toId, 'SETTINGS'),
      propertyId: toId,
      overbookingByUnitGroup: Object.fromEntries(
        Object.entries(settings.overbookingByUnitGroup).map(([k, v]) => [remap(k)!, v]),
      ),
    });
  }
}

/* ----------------------------------------------------------- unit groups */

api.op('InventoryUnit-groupsGet', (req, res) => {
  const propertyId = stringParam(req, 'propertyId');
  const types = arrayParam(req, 'unitGroupTypes');
  const langs = languagesOf(arrayParam(req, 'languages'), propertyId);
  const page = paging(req);
  const { items, count } = db.unitGroups.query({
    where: { propertyId },
    filter: (g) => types.length === 0 || types.includes(g.type),
    sort: byRankThenCode,
    offset: page.offset,
    limit: page.pageSize,
  });
  sendList(res, 'unitGroups', items.map((g) => unitGroupItem(g, langs)), count);
});

const byRankThenCode = (a: { rank?: number; code: string }, b: { rank?: number; code: string }) =>
  (a.rank ?? Number.MAX_SAFE_INTEGER) - (b.rank ?? Number.MAX_SAFE_INTEGER) || a.code.localeCompare(b.code);

api.op('InventoryUnit-groups$countGet', (req, res) => {
  const propertyId = stringParam(req, 'propertyId');
  const types = arrayParam(req, 'unitGroupTypes');
  const count = db.unitGroups.all({ propertyId }).filter((g) => types.length === 0 || types.includes(g.type)).length;
  res.json({ count });
});

api.op('InventoryUnit-groupsPost', (req, res) => {
  const body = req.body as Record<string, any>;
  const p = getProperty(body.propertyId);
  const code = String(body.code).toUpperCase();
  const id = scoped(p.id, code);
  if (db.unitGroups.exists(id)) {
    throw conflict(`A unit group with code '${code}' already exists in property '${p.id}'.`);
  }
  if (body.maxPersons < 1) throw unprocessable('`maxPersons` must be at least 1.');

  const group: UnitGroup = {
    id,
    code,
    propertyId: p.id,
    name: normalizeLocalized(body.name),
    description: normalizeLocalized(body.description),
    maxPersons: body.maxPersons,
    rank: body.rank,
    type: body.type ?? 'BedRoom',
    connectedUnitGroups: (body.connectedUnitGroups ?? []).map((c: any) => ({
      unitGroupId: c.unitGroupId,
      memberCount: c.memberCount ?? 0,
    })),
  };
  db.unitGroups.put(group);
  sendCreated(res, `/inventory/v1/unit-groups/${id}`, { id });
});

api.op('InventoryUnit-groupsByIdGet', (req, res) => {
  const g = getUnitGroup(req.params.id!);
  res.json(unitGroupDetail(g, languagesOf(arrayParam(req, 'languages'), g.propertyId)));
});

api.op('InventoryUnit-groupsByIdHead', (req, res) => {
  res.status(db.unitGroups.exists(req.params.id!) ? 200 : 404).end();
});

api.op('InventoryUnit-groupsByIdPut', (req, res) => {
  const g = getUnitGroup(req.params.id!);
  const body = req.body as Record<string, any>;
  g.name = normalizeLocalized(body.name);
  g.description = normalizeLocalized(body.description);
  if (body.maxPersons !== undefined) g.maxPersons = body.maxPersons;
  if (body.rank !== undefined) g.rank = body.rank;
  if (body.connectedUnitGroups) {
    g.connectedUnitGroups = body.connectedUnitGroups.map((c: any) => ({
      unitGroupId: c.unitGroupId,
      memberCount: c.memberCount ?? 0,
    }));
  }
  db.unitGroups.put(g);
  sendNoContent(res);
});

api.op('InventoryUnit-groupsByIdDelete', (req, res) => {
  const g = getUnitGroup(req.params.id!);
  const memberCount = db.units.count({ unitGroupId: g.id });
  if (memberCount > 0) {
    throw unprocessable(`The unit group still has ${memberCount} unit(s) assigned to it.`);
  }
  if (db.ratePlans.count({ unitGroupId: g.id }) > 0) {
    throw unprocessable('The unit group is referenced by at least one rate plan.');
  }
  db.unitGroups.delete(g.id);
  sendNoContent(res);
});

/* ----------------------------------------------------------------- units */

function unitFilter(req: Request) {
  const propertyId = stringParam(req, 'propertyId');
  const unitGroupIds = arrayParam(req, 'unitGroupId');
  const unitAttributeIds = arrayParam(req, 'unitAttributeIds');
  const conditions = arrayParam(req, 'unitCondition');
  const types = arrayParam(req, 'unitGroupTypes');
  const isOccupied = boolParam(req, 'isOccupied');
  const maintenanceTypes = arrayParam(req, 'maintenanceType');
  const includeArchived = boolParam(req, 'includeArchived') ?? false;
  const textSearch = stringParam(req, 'textSearch')?.toLowerCase();

  return (u: Unit): boolean => {
    if (!includeArchived && u.isArchived) return false;
    if (propertyId && u.propertyId !== propertyId) return false;
    if (unitGroupIds.length && (!u.unitGroupId || !unitGroupIds.includes(u.unitGroupId))) return false;
    if (conditions.length && !conditions.includes(u.condition)) return false;
    if (unitAttributeIds.length && !unitAttributeIds.every((a) => u.attributes.includes(a))) return false;
    if (types.length) {
      const g = u.unitGroupId ? db.unitGroups.get(u.unitGroupId) : undefined;
      if (!g || !types.includes(g.type)) return false;
    }
    if (isOccupied !== undefined && unitIsOccupied(u.id) !== isOccupied) return false;
    if (maintenanceTypes.length) {
      const m = activeMaintenanceFor(u.id);
      if (!m || !maintenanceTypes.includes(m.type)) return false;
    }
    if (textSearch && !u.name.toLowerCase().includes(textSearch)) return false;
    return true;
  };
}

api.op('InventoryUnitsGet', (req, res) => {
  const langs = languagesOf(arrayParam(req, 'languages'), stringParam(req, 'propertyId'));
  const expand = arrayParam(req, 'expand').includes('actions');
  const page = paging(req);
  const { items, count } = db.units.query({
    filter: unitFilter(req),
    sort: (a, b) => a.propertyId.localeCompare(b.propertyId) || naturalCompare(a.name, b.name),
    offset: page.offset,
    limit: page.pageSize,
  });
  sendList(res, 'units', items.map((u) => unitItem(u, langs, expand)), count);
});

/** Sort `101, 102, 1001` rather than `1001, 101, 102`. */
function naturalCompare(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

api.op('InventoryUnits$countGet', (req, res) => {
  res.json({ count: db.units.all().filter(unitFilter(req)).length });
});

api.op('InventoryUnitsPost', (req, res) => {
  const created = createUnit(req.body);
  sendCreated(res, `/inventory/v1/units/${created.id}`, { id: created.id });
});

api.op('InventoryUnitsBulkPost', (req, res) => {
  const body = req.body as { units: any[] };
  const ids = transact(() => body.units.map((u) => createUnit(u).id));
  res.status(201).json({ ids: ids.map((id) => ({ id })) });
});

function createUnit(body: Record<string, any>): Unit {
  const p = getProperty(body.propertyId);
  if (body.unitGroupId) {
    const g = getUnitGroup(body.unitGroupId);
    if (g.propertyId !== p.id) {
      throw unprocessable(`Unit group '${g.id}' does not belong to property '${p.id}'.`);
    }
  }
  const name = String(body.name).trim();
  if (!name) throw unprocessable('`name` must not be empty.');
  const duplicate = db.units.all({ propertyId: p.id, name }).find((u) => !u.isArchived);
  if (duplicate) {
    throw conflict(`A unit named '${name}' already exists in property '${p.id}'.`);
  }
  for (const attr of body.attributes ?? []) {
    if (!db.unitAttributes.exists(attr.id)) {
      throw unprocessable(`Unit attribute '${attr.id}' does not exist.`);
    }
  }
  const unit: Unit = {
    id: mintUnitId(p.id, (id) => db.units.exists(id)),
    propertyId: p.id,
    unitGroupId: body.unitGroupId,
    name,
    description: normalizeLocalized(body.description),
    maxPersons: body.maxPersons,
    condition: body.condition ?? 'Clean',
    attributes: (body.attributes ?? []).map((a: any) => a.id),
    connectedUnitIds: (body.connectedUnits ?? []).map((c: any) => c.id).filter(Boolean),
    created: nowIso(),
    isArchived: false,
  };
  db.units.put(unit);
  return unit;
}

api.op('InventoryUnitsByIdGet', (req, res) => {
  const u = getUnit(req.params.id!);
  res.json(unitDetail(u, languagesOf(arrayParam(req, 'languages'), u.propertyId), arrayParam(req, 'expand').includes('actions')));
});

api.op('InventoryUnitsByIdHead', (req, res) => {
  res.status(db.units.exists(req.params.id!) ? 200 : 404).end();
});

api.op('InventoryUnitsByIdPatch', (req, res) => {
  const u = getUnit(req.params.id!);
  const ops = req.body as PatchOperation[];
  rejectImmutablePaths(ops, ['/id', '/property', '/created', '/isArchived']);
  // The wire model nests condition under `status`; accept both spellings.
  const view = {
    name: u.name,
    description: u.description,
    unitGroupId: u.unitGroupId,
    maxPersons: u.maxPersons,
    condition: u.condition,
    status: { condition: u.condition },
    attributes: attributesOf(u),
    connectedUnits: u.connectedUnitIds.map((id) => ({ id })),
  };
  const patched = applyPatch(view, ops) as typeof view;
  if (patched.name !== undefined && patched.name !== u.name) {
    const clash = db.units.all({ propertyId: u.propertyId, name: patched.name })
      .find((o) => o.id !== u.id && !o.isArchived);
    if (clash) throw conflict(`A unit named '${patched.name}' already exists in property '${u.propertyId}'.`);
    u.name = patched.name;
  }
  u.description = mergeLocalized({}, patched.description);
  if (patched.unitGroupId !== undefined) {
    if (patched.unitGroupId) {
      const g = getUnitGroup(patched.unitGroupId);
      if (g.propertyId !== u.propertyId) {
        throw unprocessable(`Unit group '${g.id}' does not belong to property '${u.propertyId}'.`);
      }
    }
    u.unitGroupId = patched.unitGroupId;
  }
  if (patched.maxPersons !== undefined) u.maxPersons = patched.maxPersons;
  const nextCondition = patched.status?.condition ?? patched.condition;
  if (nextCondition) u.condition = nextCondition;
  if (patched.attributes) u.attributes = patched.attributes.map((a: any) => a.id).filter(Boolean);
  if (patched.connectedUnits) u.connectedUnitIds = patched.connectedUnits.map((c: any) => c.id).filter(Boolean);
  db.units.put(u);
  sendNoContent(res);
});

api.op('InventoryUnitsPatch', (req, res) => {
  // Bulk patch: the same JSON Patch document applied to every matching unit.
  const ids = arrayParam(req, 'unitIds');
  if (!ids.length) throw unprocessable('`unitIds` must contain at least one unit id.');
  const ops = req.body as PatchOperation[];
  rejectImmutablePaths(ops, ['/id', '/name', '/property', '/created', '/isArchived']);
  transact(() => {
    for (const id of ids) {
      const u = getUnit(id);
      const view = { description: u.description, maxPersons: u.maxPersons, condition: u.condition, status: { condition: u.condition }, unitGroupId: u.unitGroupId };
      const patched = applyPatch(view, ops) as typeof view;
      u.description = mergeLocalized({}, patched.description);
      if (patched.maxPersons !== undefined) u.maxPersons = patched.maxPersons;
      const c = patched.status?.condition ?? patched.condition;
      if (c) u.condition = c;
      if (patched.unitGroupId !== undefined) u.unitGroupId = patched.unitGroupId;
      db.units.put(u);
    }
  });
  sendNoContent(res);
});

api.op('InventoryUnitsByIdDelete', (req, res) => {
  const u = getUnit(req.params.id!);
  const active = db.reservations.all({ unitId: u.id })
    .filter((r) => r.status === 'Confirmed' || r.status === 'InHouse');
  if (active.length) {
    throw unprocessable(`The unit is assigned to ${active.length} active reservation(s) and cannot be deleted.`);
  }
  db.units.delete(u.id);
  db.maintenances.deleteWhere({ unitId: u.id });
  sendNoContent(res);
});

api.op('InventoryUnit-actionsByIdArchivePut', (req, res) => {
  const u = getUnit(req.params.id!);
  if (u.isArchived) throw unprocessable('The unit is already archived.');
  if (unitIsOccupied(u.id)) throw unprocessable('The unit is currently occupied.');
  u.isArchived = true;
  u.archived = nowIso();
  db.units.put(u);
  sendNoContent(res);
});

/* ------------------------------------------------------- unit attributes */

api.op('InventoryUnit-attributesGet', (req, res) => {
  const page = paging(req);
  const { items, count } = db.unitAttributes.query({
    sort: (a, b) => a.name.localeCompare(b.name),
    offset: page.offset,
    limit: page.pageSize,
  });
  sendList(res, 'unitAttributes', items, count);
});

api.op('InventoryUnit-attributesPost', (req, res) => {
  const body = req.body as Record<string, any>;
  const name = String(body.name).trim();
  const id = name.toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50);
  if (!id) throw unprocessable('`name` must contain at least one alphanumeric character.');
  if (db.unitAttributes.exists(id)) throw conflict(`A unit attribute named '${name}' already exists.`);
  const created: UnitAttributeDefinition = { id, name, description: body.description };
  db.unitAttributes.put(created);
  sendCreated(res, `/inventory/v1/unit-attributes/${id}`, { id });
});

api.op('InventoryUnit-attributesByIdGet', (req, res) => {
  const a = db.unitAttributes.get(req.params.id!);
  if (!a) throw notFound(`Unit attribute '${req.params.id}' was not found.`);
  res.json(a);
});

api.op('InventoryUnit-attributesByIdHead', (req, res) => {
  res.status(db.unitAttributes.exists(req.params.id!) ? 200 : 404).end();
});

api.op('InventoryUnit-attributesByIdPatch', (req, res) => {
  const a = db.unitAttributes.get(req.params.id!);
  if (!a) throw notFound(`Unit attribute '${req.params.id}' was not found.`);
  const ops = req.body as PatchOperation[];
  rejectImmutablePaths(ops, ['/id']);
  db.unitAttributes.put(applyPatch(a, ops));
  sendNoContent(res);
});

api.op('InventoryUnit-attributesByIdDelete', (req, res) => {
  const id = req.params.id!;
  if (!db.unitAttributes.exists(id)) throw notFound(`Unit attribute '${id}' was not found.`);
  const inUse = db.units.all().filter((u) => u.attributes.includes(id)).length;
  if (inUse) throw unprocessable(`The attribute is assigned to ${inUse} unit(s).`);
  db.unitAttributes.delete(id);
  sendNoContent(res);
});

/* ----------------------------------------------------------------- types */

api.op('InventoryTypesCountriesGet', (_req, res) => {
  res.json({ countryCodes: COUNTRY_CODES });
});

export const inventoryRouter = api.build();
