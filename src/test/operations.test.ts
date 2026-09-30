import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  book, createFixture, daysFromNow, expectStatus, startApi, type TestApi,
} from './helpers';

/**
 * Housekeeping, maintenance and the night audit - the daily operations that
 * move a property's business date forward.
 */
describe('operations', () => {
  let api: TestApi;
  before(async () => { api = await startApi(); });
  after(async () => { await api.close(); });

  test('maintenance takes a unit out of availability', async () => {
    const f = await createFixture(api, { units: 2 });
    const from = daysFromNow(10);
    const to = daysFromNow(12);

    let availability = await api.json<any>(
      `/availability/v1/unit-groups?propertyId=${f.propertyId}&from=${from}&to=${to}`,
    );
    assert.equal(availability.timeSlices[0].unitGroups[0].availableCount, 2);

    await expectStatus(await api.post('/operations/v1/maintenances', {
      unitId: f.unitIds[0],
      from: `${from}T00:00:00Z`,
      to: `${to}T00:00:00Z`,
      type: 'OutOfOrder',
      description: 'Leaking tap',
    }), 201);

    availability = await api.json<any>(
      `/availability/v1/unit-groups?propertyId=${f.propertyId}&from=${from}&to=${to}`,
    );
    const slice = availability.timeSlices[0].unitGroups[0];
    assert.equal(slice.availableCount, 1);
    assert.equal(slice.maintenance.outOfOrder, 1);
    // Out-of-order keeps the unit in the house count; out-of-inventory would not.
    assert.equal(slice.houseCount, 2);
  });

  test('out-of-inventory maintenance reduces the house count', async () => {
    const f = await createFixture(api, { units: 2 });
    const from = daysFromNow(20);
    const to = daysFromNow(21);
    await expectStatus(await api.post('/operations/v1/maintenances', {
      unitId: f.unitIds[0], from: `${from}T00:00:00Z`, to: `${to}T00:00:00Z`, type: 'OutOfInventory',
    }), 201);

    const availability = await api.json<any>(
      `/availability/v1/unit-groups?propertyId=${f.propertyId}&from=${from}&to=${to}`,
    );
    const slice = availability.timeSlices[0].unitGroups[0];
    assert.equal(slice.physicalCount, 2);
    assert.equal(slice.houseCount, 1);
    assert.equal(slice.availableCount, 1);
  });

  test('maintenance cannot be scheduled over an occupied unit', async () => {
    const f = await createFixture(api, { units: 1 });
    const arrival = daysFromNow(30);
    const departure = daysFromNow(32);
    const { reservationId } = await book(api, f, { arrival, departure });
    await expectStatus(
      await api.put(`/booking/v1/reservation-actions/${reservationId}/assign-unit/${f.unitIds[0]}`), 204,
    );

    const clash = await api.post('/operations/v1/maintenances', {
      unitId: f.unitIds[0],
      from: `${arrival}T00:00:00Z`,
      to: `${departure}T00:00:00Z`,
      type: 'OutOfService',
    });
    assert.equal(clash.status, 409);
  });

  test('overlapping maintenance windows are refused', async () => {
    const f = await createFixture(api, { units: 1 });
    await expectStatus(await api.post('/operations/v1/maintenances', {
      unitId: f.unitIds[0],
      from: `${daysFromNow(40)}T00:00:00Z`,
      to: `${daysFromNow(45)}T00:00:00Z`,
      type: 'OutOfOrder',
    }), 201);
    const overlap = await api.post('/operations/v1/maintenances', {
      unitId: f.unitIds[0],
      from: `${daysFromNow(43)}T00:00:00Z`,
      to: `${daysFromNow(47)}T00:00:00Z`,
      type: 'OutOfOrder',
    });
    assert.equal(overlap.status, 409);
  });

  test('housekeeping can set unit conditions in bulk', async () => {
    const f = await createFixture(api, { units: 3 });
    await expectStatus(await api.put('/operations/v1/units-condition', {
      unitsConditions: f.unitIds.map((id) => ({ id, condition: 'Dirty' })),
    }), 204);

    const dirty = await api.json<any>(
      `/inventory/v1/units?propertyId=${f.propertyId}&unitCondition=Dirty`,
    );
    assert.equal(dirty.count, 3);

    await expectStatus(await api.put('/operations/v1/units-condition', {
      unitsConditions: [{ id: f.unitIds[0], condition: 'Clean' }],
    }), 204);
    const clean = await api.json<any>(
      `/inventory/v1/units?propertyId=${f.propertyId}&unitCondition=Clean`,
    );
    assert.equal(clean.count, 1);
  });

  test('the night audit posts the day, no-shows arrivals and rolls the date', async () => {
    const f = await createFixture(api, { units: 3, price: 100 });
    const today = daysFromNow(0);

    // One guest in house, one arrival that never shows up.
    const staying = await book(api, f, { arrival: today, departure: daysFromNow(2), lastName: 'Staying' });
    await expectStatus(await api.put(`/booking/v1/reservation-actions/${staying.reservationId}/assign-unit`), 204);
    await expectStatus(await api.put(`/booking/v1/reservation-actions/${staying.reservationId}/checkin`), 204);

    const absent = await book(api, f, { arrival: today, departure: daysFromNow(1), lastName: 'Absent' });

    const before = await api.json<any>(`/settings/v1/properties/${f.propertyId}`);
    assert.ok(before.timeZone);

    await expectStatus(
      await api.put(`/operations/v1/night-audit?propertyId=${f.propertyId}`), 204,
    );

    const noShow = await api.json<any>(`/booking/v1/reservations/${absent.reservationId}`);
    assert.equal(noShow.status, 'NoShow');

    const inHouse = await api.json<any>(`/booking/v1/reservations/${staying.reservationId}`);
    assert.equal(inHouse.status, 'InHouse');
    // The first night is on the folio.
    assert.equal(inHouse.balance.amount, 100);

    const logs = await api.json<any>(`/logs/v1/finance/night-audit?propertyIds=${f.propertyId}`);
    assert.equal(logs.count, 1);
    assert.equal(logs.logEntries[0].businessDate, today);
    assert.equal(logs.logEntries[0].status, 'Success');

    // A second run posts the next night rather than repeating the first.
    await expectStatus(await api.put(`/operations/v1/night-audit?propertyId=${f.propertyId}`), 204);
    const after = await api.json<any>(`/booking/v1/reservations/${staying.reservationId}`);
    assert.equal(after.balance.amount, 200);
  });

  test('the night audit can be told to leave arrivals alone', async () => {
    const f = await createFixture(api, { units: 2 });
    const { reservationId } = await book(api, f, {
      arrival: daysFromNow(0), departure: daysFromNow(1), lastName: 'Late',
    });
    await expectStatus(
      await api.put(`/operations/v1/night-audit?propertyId=${f.propertyId}&setReservationsToNoShow=false`), 204,
    );
    const r = await api.json<any>(`/booking/v1/reservations/${reservationId}`);
    assert.equal(r.status, 'Confirmed');
  });

  test('overbooking raises the sellable count for the dates it covers', async () => {
    const f = await createFixture(api, { units: 1 });
    const from = daysFromNow(60);
    const to = daysFromNow(62);

    await expectStatus(await api.patch(
      `/availability/v1/unit-groups/${f.unitGroupId}?from=${from}&to=${to}&timeSliceTemplate=OverNight`,
      [{ op: 'replace', path: '/allowedOverbookingCount', value: 2 }],
    ), 204);

    const availability = await api.json<any>(
      `/availability/v1/unit-groups?propertyId=${f.propertyId}&from=${from}&to=${to}`,
    );
    const slice = availability.timeSlices[0].unitGroups[0];
    assert.equal(slice.allowedOverbookingCount, 2);
    assert.equal(slice.sellableCount, 1);
    assert.equal(slice.availableCount, 3);
  });

  test('reservation and folio logs record what happened', async () => {
    const f = await createFixture(api, { units: 2 });
    const { reservationId } = await book(api, f, {
      arrival: daysFromNow(0), departure: daysFromNow(1), lastName: 'Logged',
    });
    await expectStatus(await api.put(`/booking/v1/reservation-actions/${reservationId}/assign-unit`), 204);
    await expectStatus(await api.put(`/booking/v1/reservation-actions/${reservationId}/checkin`), 204);

    const logs = await api.json<any>(`/logs/v1/booking/reservation?reservationIds=${reservationId}`);
    const events = logs.logEntries.map((e: any) => e.eventType);
    assert.ok(events.includes('Created'));
    assert.ok(events.includes('UnitAssigned'));
    assert.ok(events.includes('CheckedIn'));

    const folios = await api.json<any>(`/finance/v1/folios?reservationIds=${reservationId}`);
    const folioLogs = await api.json<any>(`/logs/v1/finance/folio?folioIds=${folios.folios[0].id}`);
    const folioEvents = folioLogs.logEntries.map((e: any) => e.eventType);
    assert.ok(folioEvents.includes('Created'));
    assert.ok(folioEvents.includes('ChargePosted'));
  });

  test('the performance report counts stays that have already departed', async () => {
    const f = await createFixture(api, { units: 4, price: 100 });
    const arrival = daysFromNow(0);
    const departure = daysFromNow(1);
    const { reservationId } = await book(api, f, { arrival, departure, lastName: 'Departed' });
    await expectStatus(await api.put(`/booking/v1/reservation-actions/${reservationId}/assign-unit`), 204);
    await expectStatus(await api.put(`/booking/v1/reservation-actions/${reservationId}/checkin`), 204);

    // While in house the night counts, and revenue has been posted.
    let report = await api.json<any>(
      `/reports/v1/reports/property-performance?propertyId=${f.propertyId}&from=${arrival}&to=${arrival}`,
    );
    assert.equal(report.soldCount, 1);
    assert.equal(report.grossAccommodationRevenue.amount, 100);

    // Settle and check out; the night must still count for that date.
    const folios = await api.json<any>(`/finance/v1/folios?reservationIds=${reservationId}`);
    await expectStatus(await api.post(`/finance/v1/folios/${folios.folios[0].id}/payments`, {
      method: 'Cash', amount: { amount: folios.folios[0].balance.amount, currency: 'EUR' },
    }), 201);
    await expectStatus(await api.put(`/booking/v1/reservation-actions/${reservationId}/checkout`), 204);

    report = await api.json<any>(
      `/reports/v1/reports/property-performance?propertyId=${f.propertyId}&from=${arrival}&to=${arrival}`,
    );
    assert.equal(report.soldCount, 1, 'a departed stay still occupied its night');
    assert.ok(report.occupancyPercentage > 0);
    assert.equal(report.grossAdr.amount, 100);

    // Forward-looking availability must not count it, though: the room is free.
    const availability = await api.json<any>(
      `/availability/v1/unit-groups?propertyId=${f.propertyId}&from=${arrival}&to=${departure}`,
    );
    assert.equal(availability.timeSlices[0].unitGroups[0].soldCount, 0);
    assert.equal(availability.timeSlices[0].unitGroups[0].availableCount, 4);
  });

  test('log date filters use the documented expression syntax', async () => {
    const f = await createFixture(api, { units: 1 });
    await book(api, f, { arrival: daysFromNow(5), departure: daysFromNow(6) });

    const future = await api.get(`/logs/v1/booking/reservation?dateFilter=gte_${daysFromNow(1)}`);
    assert.equal(future.status, 204);

    const past = await api.json<any>(`/logs/v1/booking/reservation?dateFilter=gte_${daysFromNow(-1)}`);
    assert.ok(past.count >= 1);

    const bad = await api.get('/logs/v1/booking/reservation?dateFilter=nonsense');
    assert.equal(bad.status, 422);
  });
});
