import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  createFixture, createProperty, daysFromNow, expectStatus, nextPropertyCode, startApi, type TestApi,
} from './helpers';

/**
 * Inventory and configuration: properties and their lifecycle, unit groups,
 * units, and the referential integrity between them.
 */
describe('inventory', () => {
  let api: TestApi;
  before(async () => { api = await startApi(); });
  after(async () => { await api.close(); });

  test('creating a property bootstraps what a booking needs', async () => {
    const code = await createProperty(api);

    const property = await api.json<any>(`/inventory/v1/properties/${code}`);
    assert.equal(property.status, 'Test');
    assert.equal(property.isArchived, false);
    assert.deepEqual(property.name, { en: `${code} Hotel` });

    // A night time slice definition, feature settings and the chart of
    // accounts are all in place without a second call.
    const slices = await api.json<any>(`/settings/v1/properties/${code}/time-slice-definitions`);
    assert.equal(slices.count, 1);
    assert.equal(slices.timeSliceDefinitions[0].template, 'OverNight');

    const schema = await api.json<any>(`/finance/v1/accounts/schema?propertyId=${code}`);
    assert.ok(schema.globalAccounts.length > 0);

    const features = await api.json<any>(`/settings/v1/features/${code}`);
    assert.ok(features.invoiceNumberPattern.includes(code));
  });

  test('duplicate property codes are refused', async () => {
    const code = nextPropertyCode();
    await createProperty(api, code);
    const again = await api.post('/inventory/v1/properties', {
      code,
      name: { en: 'Clash' },
      description: { en: 'x' },
      companyName: 'x',
      commercialRegisterEntry: 'x',
      taxId: 'x',
      location: { addressLine1: 'a', postalCode: '1', city: 'c', countryCode: 'DE' },
      paymentTerms: { en: 'x' },
      timeZone: 'Europe/Berlin',
      currencyCode: 'EUR',
      defaultCheckInTime: '15:00',
      defaultCheckOutTime: '11:00',
    });
    assert.equal(again.status, 409);
  });

  test('an unrecognised time zone is rejected', async () => {
    const res = await api.post('/inventory/v1/properties', {
      code: nextPropertyCode(),
      name: { en: 'Bad zone' },
      description: { en: 'x' },
      companyName: 'x',
      commercialRegisterEntry: 'x',
      taxId: 'x',
      location: { addressLine1: 'a', postalCode: '1', city: 'c', countryCode: 'DE' },
      paymentTerms: { en: 'x' },
      timeZone: 'Mars/Olympus_Mons',
      currencyCode: 'EUR',
      defaultCheckInTime: '15:00',
      defaultCheckOutTime: '11:00',
    });
    assert.equal(res.status, 422);
  });

  test('set-live needs units, and a live property cannot be deleted', async () => {
    const code = await createProperty(api);
    const early = await api.put(`/inventory/v1/property-actions/${code}/set-live`);
    assert.equal(early.status, 422);

    const group = await expectStatus(await api.post('/inventory/v1/unit-groups', {
      code: 'SGL', propertyId: code, name: { en: 'Single' }, description: { en: 'Single' }, maxPersons: 1,
    }), 201);
    await expectStatus(await api.post('/inventory/v1/units', {
      propertyId: code, unitGroupId: group.id, name: '101', description: { en: 'Single' }, maxPersons: 1,
    }), 201);

    await expectStatus(await api.put(`/inventory/v1/property-actions/${code}/set-live`), 204);
    const live = await api.json<any>(`/inventory/v1/properties/${code}`);
    assert.equal(live.status, 'Live');

    const deletion = await api.del(`/inventory/v1/properties/${code}`);
    assert.equal(deletion.status, 422);
  });

  test('reset clears configuration but keeps the property', async () => {
    const f = await createFixture(api, { units: 2 });
    await expectStatus(await api.put(`/inventory/v1/property-actions/${f.propertyId}/reset`), 204);

    const units = await api.get(`/inventory/v1/units?propertyId=${f.propertyId}`);
    assert.equal(units.status, 204);
    assert.ok(await api.json<any>(`/inventory/v1/properties/${f.propertyId}`));
    // The bootstrap runs again, so the property is immediately usable.
    const slices = await api.json<any>(`/settings/v1/properties/${f.propertyId}/time-slice-definitions`);
    assert.equal(slices.count, 1);
  });

  test('cloning copies configuration but not bookings', async () => {
    const f = await createFixture(api, { units: 2, price: 90 });
    const cloneCode = nextPropertyCode();
    // The clone endpoint takes a full CreatePropertyModel, per the spec.
    await expectStatus(await api.post(`/inventory/v1/property-actions/${f.propertyId}/clone`, {
      code: cloneCode,
      name: { en: 'Clone Hotel' },
      description: { en: 'A copy' },
      companyName: 'Clone GmbH',
      commercialRegisterEntry: 'HRB 2',
      taxId: 'DE987654321',
      location: { addressLine1: 'Second street 2', postalCode: '20000', city: 'Cloneville', countryCode: 'DE' },
      paymentTerms: { en: 'Due on departure' },
      timeZone: 'Europe/Berlin',
      currencyCode: 'EUR',
      defaultCheckInTime: '15:00',
      defaultCheckOutTime: '11:00',
    }), 201);

    const groups = await api.json<any>(`/inventory/v1/unit-groups?propertyId=${cloneCode}`);
    assert.equal(groups.count, 1);
    assert.equal(groups.unitGroups[0].id, `${cloneCode}-DBL`);

    const units = await api.json<any>(`/inventory/v1/units?propertyId=${cloneCode}`);
    assert.equal(units.count, 2);

    const plans = await api.json<any>(`/rateplan/v1/rate-plans?propertyId=${cloneCode}`);
    assert.equal(plans.count, 1);
    assert.equal(plans.ratePlans[0].unitGroup.id, `${cloneCode}-DBL`);

    // Rates came across too.
    const rates = await api.json<any>(
      `/rateplan/v1/rate-plans/${cloneCode}-STD/rates?from=${daysFromNow(1)}&to=${daysFromNow(3)}`,
    );
    assert.equal(rates.rates[0].price.amount, 90);

    const clone = await api.json<any>(`/inventory/v1/properties/${cloneCode}`);
    assert.equal(clone.status, 'Test');
    assert.equal(clone.propertyTemplateId, f.propertyId);
  });

  test('duplicate unit names in one property are refused', async () => {
    const f = await createFixture(api, { units: 1 });
    const clash = await api.post('/inventory/v1/units', {
      propertyId: f.propertyId,
      unitGroupId: f.unitGroupId,
      name: '101',
      description: { en: 'Double' },
      maxPersons: 2,
    });
    assert.equal(clash.status, 409);
  });

  test('a unit group with units cannot be deleted', async () => {
    const f = await createFixture(api, { units: 1 });
    const blocked = await api.del(`/inventory/v1/unit-groups/${f.unitGroupId}`);
    assert.equal(blocked.status, 422);

    await expectStatus(await api.del(`/inventory/v1/units/${f.unitIds[0]}`), 204);
    // Still blocked: a rate plan references the group.
    const stillBlocked = await api.del(`/inventory/v1/unit-groups/${f.unitGroupId}`);
    assert.equal(stillBlocked.status, 422);
  });

  test('units sort naturally and filter by attribute', async () => {
    const propertyId = await createProperty(api);
    const group = await expectStatus(await api.post('/inventory/v1/unit-groups', {
      code: 'STD', propertyId, name: { en: 'Standard' }, description: { en: 'Standard' }, maxPersons: 2,
    }), 201);
    const attribute = await expectStatus(await api.post('/inventory/v1/unit-attributes', {
      name: 'Balcony', description: 'Has a balcony',
    }), 201);

    await expectStatus(await api.post('/inventory/v1/units/bulk', {
      units: [
        { propertyId, unitGroupId: group.id, name: '1001', description: { en: 'x' }, maxPersons: 2 },
        { propertyId, unitGroupId: group.id, name: '101', description: { en: 'x' }, maxPersons: 2, attributes: [{ id: attribute.id }] },
        { propertyId, unitGroupId: group.id, name: '102', description: { en: 'x' }, maxPersons: 2 },
      ],
    }), 201);

    const units = await api.json<any>(`/inventory/v1/units?propertyId=${propertyId}`);
    assert.deepEqual(units.units.map((u: any) => u.name), ['101', '102', '1001']);

    const withBalcony = await api.json<any>(
      `/inventory/v1/units?propertyId=${propertyId}&unitAttributeIds=${attribute.id}`,
    );
    assert.equal(withBalcony.count, 1);
    assert.equal(withBalcony.units[0].name, '101');

    // An attribute in use cannot be deleted.
    const blocked = await api.del(`/inventory/v1/unit-attributes/${attribute.id}`);
    assert.equal(blocked.status, 422);
  });

  test('archiving hides a unit unless asked for', async () => {
    const f = await createFixture(api, { units: 2 });
    await expectStatus(await api.put(`/inventory/v1/unit-actions/${f.unitIds[0]}/archive`), 204);

    const visible = await api.json<any>(`/inventory/v1/units?propertyId=${f.propertyId}`);
    assert.equal(visible.count, 1);

    const all = await api.json<any>(`/inventory/v1/units?propertyId=${f.propertyId}&includeArchived=true`);
    assert.equal(all.count, 2);

    // Archived units no longer count towards availability.
    const availability = await api.json<any>(
      `/availability/v1/unit-groups?propertyId=${f.propertyId}&from=${daysFromNow(1)}&to=${daysFromNow(2)}`,
    );
    assert.equal(availability.timeSlices[0].unitGroups[0].physicalCount, 1);
  });

  test('countries and currencies are served', async () => {
    const countries = await api.json<any>('/inventory/v1/types/countries');
    assert.ok(countries.countryCodes.includes('DE'));
    assert.ok(countries.countryCodes.includes('JP'));
  });

  test('localized text resolves per language', async () => {
    const propertyId = nextPropertyCode();
    await expectStatus(await api.post('/inventory/v1/properties', {
      code: propertyId,
      name: { en: 'Seaside Hotel', de: 'Strandhotel' },
      description: { en: 'By the sea', de: 'Am Meer' },
      companyName: 'Seaside GmbH',
      commercialRegisterEntry: 'HRB 9',
      taxId: 'DE9',
      location: { addressLine1: 'Beach 1', postalCode: '20000', city: 'Hamburg', countryCode: 'DE' },
      paymentTerms: { en: 'On departure', de: 'Bei Abreise' },
      timeZone: 'Europe/Berlin',
      currencyCode: 'EUR',
      defaultCheckInTime: '15:00',
      defaultCheckOutTime: '11:00',
    }), 201);

    // The detail endpoint returns the whole dictionary.
    const detail = await api.json<any>(`/inventory/v1/properties/${propertyId}`);
    assert.deepEqual(detail.name, { en: 'Seaside Hotel', de: 'Strandhotel' });

    // The list endpoint resolves to one language.
    const german = await api.json<any>('/inventory/v1/properties?languages=de&pageSize=500');
    const entry = german.properties.find((p: any) => p.id === propertyId);
    assert.equal(entry.name, 'Strandhotel');

    const english = await api.json<any>('/inventory/v1/properties?languages=en&pageSize=500');
    assert.equal(english.properties.find((p: any) => p.id === propertyId).name, 'Seaside Hotel');
  });

  test('HEAD reports existence without a body', async () => {
    const f = await createFixture(api, { units: 1 });
    const found = await fetch(`${api.base}/inventory/v1/properties/${f.propertyId}`, { method: 'HEAD' });
    assert.equal(found.status, 200);
    const missing = await fetch(`${api.base}/inventory/v1/properties/NOPE`, { method: 'HEAD' });
    assert.equal(missing.status, 404);
  });
});
