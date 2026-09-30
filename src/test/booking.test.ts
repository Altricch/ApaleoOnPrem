import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  book, createFixture, daysFromNow, expectStatus, startApi, type TestApi,
} from './helpers';

/**
 * End-to-end tests over the booking surface: offers, availability, the
 * reservation state machine and the money that follows from each transition.
 */
describe('booking', () => {
  let api: TestApi;
  before(async () => { api = await startApi(); });
  after(async () => { await api.close(); });

  test('offers price a stay and report availability', async () => {
    const f = await createFixture(api, { units: 2, price: 100 });
    const arrival = daysFromNow(10);
    const departure = daysFromNow(13);

    const offers = await expectStatus(await api.get(
      `/booking/v1/offers?propertyId=${f.propertyId}&arrival=${arrival}&departure=${departure}&adults=1&channelCode=Direct`,
    ), 200);

    assert.equal(offers.offers.length, 1);
    const offer = offers.offers[0];
    assert.equal(offer.ratePlan.id, f.ratePlanId);
    assert.equal(offer.availableUnits, 2);
    assert.equal(offer.totalGrossAmount.amount, 300);
    assert.equal(offer.timeSlices.length, 3);
    // Cancellation fee is 100% of the first night under the fixture policy.
    assert.equal(offer.cancellationFee.fee.amount, 100);
  });

  test('a second adult picks up the configured surcharge', async () => {
    const f = await createFixture(api, { units: 2, price: 100 });
    const offers = await expectStatus(await api.get(
      `/booking/v1/offers?propertyId=${f.propertyId}&arrival=${daysFromNow(10)}&departure=${daysFromNow(11)}&adults=2&channelCode=Direct`,
    ), 200);
    assert.equal(offers.offers[0].totalGrossAmount.amount, 120);
  });

  test('occupancy beyond the unit group capacity is reported, not priced away', async () => {
    const f = await createFixture(api, { units: 1 });
    const offers = await expectStatus(await api.get(
      `/booking/v1/offers?propertyId=${f.propertyId}&arrival=${daysFromNow(10)}&departure=${daysFromNow(11)}`
      + '&adults=5&channelCode=Direct&includeUnavailable=true',
    ), 200);
    const codes = offers.offers[0].validationMessages.map((m: any) => m.code);
    assert.ok(codes.includes('UnitGroupCapacityExceeded'));
  });

  test('booking reduces availability and a sold-out stay is refused', async () => {
    const f = await createFixture(api, { units: 1 });
    const arrival = daysFromNow(20);
    const departure = daysFromNow(22);

    await book(api, f, { arrival, departure });

    const availability = await expectStatus(await api.get(
      `/availability/v1/unit-groups?propertyId=${f.propertyId}&from=${arrival}&to=${departure}`,
    ), 200);
    assert.equal(availability.timeSlices[0].unitGroups[0].soldCount, 1);
    assert.equal(availability.timeSlices[0].unitGroups[0].availableCount, 0);

    const refused = await api.post('/booking/v1/bookings', {
      booker: { lastName: 'Second' },
      reservations: [{
        arrival, departure, adults: 1, channelCode: 'Direct',
        timeSlices: [{ ratePlanId: f.ratePlanId }, { ratePlanId: f.ratePlanId }],
      }],
    });
    assert.equal(refused.status, 422);
    const body = await refused.json() as { messages: string[] };
    assert.ok(body.messages[0].includes('No availability'));
  });

  test('$force books past a sold-out stay and records the validation message', async () => {
    const f = await createFixture(api, { units: 1 });
    const arrival = daysFromNow(30);
    const departure = daysFromNow(31);
    await book(api, f, { arrival, departure });

    const forced = await expectStatus(await api.post('/booking/v1/bookings/$force', {
      booker: { lastName: 'Forced' },
      reservations: [{
        arrival, departure, adults: 1, channelCode: 'Direct',
        timeSlices: [{ ratePlanId: f.ratePlanId }],
      }],
    }), 201);

    const reservation = await api.json<any>(`/booking/v1/reservations/${forced.reservationIds[0].id}`);
    assert.ok(reservation.validationMessages.some((m: any) => m.code === 'UnitGroupFullyBooked'));
  });

  test('a reservation walks the full lifecycle', async () => {
    const f = await createFixture(api, { units: 2, price: 100 });
    // Arriving today and departing tomorrow: check-in is permitted against
    // the business date, and check-out is not "more than one day away".
    const arrival = daysFromNow(0);
    const departure = daysFromNow(1);
    const { reservationId } = await book(api, f, { arrival, departure, lastName: 'Lifecycle' });

    let r = await api.json<any>(`/booking/v1/reservations/${reservationId}?expand=actions`);
    assert.equal(r.status, 'Confirmed');
    assert.equal(r.balance.amount, 0);
    // Check-in is blocked until a unit is assigned.
    assert.equal(r.actions.find((a: any) => a.action === 'CheckIn').isAllowed, false);

    await expectStatus(await api.put(`/booking/v1/reservation-actions/${reservationId}/assign-unit`), 204);
    r = await api.json<any>(`/booking/v1/reservations/${reservationId}?expand=actions`);
    assert.ok(r.unit?.id);
    assert.equal(r.actions.find((a: any) => a.action === 'CheckIn').isAllowed, true);

    await expectStatus(await api.put(`/booking/v1/reservation-actions/${reservationId}/checkin`), 204);
    r = await api.json<any>(`/booking/v1/reservations/${reservationId}`);
    assert.equal(r.status, 'InHouse');
    // The first night is posted at check-in, so the folio now owes money.
    assert.ok(r.balance.amount > 0, `expected a positive balance, got ${r.balance.amount}`);

    // The unit is dirty once occupied.
    const unit = await api.json<any>(`/inventory/v1/units/${r.unit.id}`);
    assert.equal(unit.status.condition, 'Dirty');
    assert.equal(unit.status.isOccupied, true);

    // Checking out with an open balance is refused.
    const blocked = await api.put(`/booking/v1/reservation-actions/${reservationId}/checkout`);
    assert.equal(blocked.status, 422);

    const folios = await api.json<any>(`/finance/v1/folios?reservationIds=${reservationId}`);
    const folio = folios.folios[0];
    const owed = folio.balance.amount;
    await expectStatus(await api.post(`/finance/v1/folios/${folio.id}/payments`, {
      method: 'Cash',
      amount: { amount: owed, currency: 'EUR' },
    }), 201);

    await expectStatus(await api.put(`/booking/v1/reservation-actions/${reservationId}/checkout`), 204);
    r = await api.json<any>(`/booking/v1/reservations/${reservationId}`);
    assert.equal(r.status, 'CheckedOut');
    assert.equal(r.balance.amount, 0);
  });

  test('cancelling posts the cancellation fee and frees the unit', async () => {
    const f = await createFixture(api, { units: 1, price: 100 });
    const arrival = daysFromNow(40);
    const departure = daysFromNow(42);
    const { reservationId } = await book(api, f, { arrival, departure });
    await expectStatus(await api.put(`/booking/v1/reservation-actions/${reservationId}/assign-unit`), 204);

    await expectStatus(await api.put(`/booking/v1/reservation-actions/${reservationId}/cancel`), 204);
    const r = await api.json<any>(`/booking/v1/reservations/${reservationId}`);
    assert.equal(r.status, 'Canceled');
    assert.equal(r.unit, undefined);
    // 100% of the first night.
    assert.equal(r.balance.amount, 100);

    // The unit is back in inventory.
    const availability = await api.json<any>(
      `/availability/v1/unit-groups?propertyId=${f.propertyId}&from=${arrival}&to=${departure}`,
    );
    assert.equal(availability.timeSlices[0].unitGroups[0].availableCount, 1);
  });

  test('cancelling twice is refused', async () => {
    const f = await createFixture(api, { units: 1 });
    const { reservationId } = await book(api, f, { arrival: daysFromNow(50), departure: daysFromNow(51) });
    await expectStatus(await api.put(`/booking/v1/reservation-actions/${reservationId}/cancel`), 204);
    const second = await api.put(`/booking/v1/reservation-actions/${reservationId}/cancel`);
    assert.equal(second.status, 422);
  });

  test('amending the stay re-prices it', async () => {
    const f = await createFixture(api, { units: 2, price: 100 });
    const arrival = daysFromNow(60);
    const { reservationId } = await book(api, f, { arrival, departure: daysFromNow(62) });

    let r = await api.json<any>(`/booking/v1/reservations/${reservationId}`);
    assert.equal(r.totalGrossAmount.amount, 200);

    await expectStatus(await api.put(`/booking/v1/reservation-actions/${reservationId}/amend`, {
      arrival,
      departure: daysFromNow(63),
      adults: 1,
      timeSlices: [
        { ratePlanId: f.ratePlanId }, { ratePlanId: f.ratePlanId }, { ratePlanId: f.ratePlanId },
      ],
    }), 204);

    r = await api.json<any>(`/booking/v1/reservations/${reservationId}`);
    assert.equal(r.totalGrossAmount.amount, 300);
    assert.equal(r.timeSlices.length, 3);
  });

  test('a specific unit cannot be double-assigned', async () => {
    const f = await createFixture(api, { units: 2 });
    const arrival = daysFromNow(70);
    const departure = daysFromNow(72);
    const first = await book(api, f, { arrival, departure, lastName: 'First' });
    const second = await book(api, f, { arrival, departure, lastName: 'Second' });

    await expectStatus(
      await api.put(`/booking/v1/reservation-actions/${first.reservationId}/assign-unit/${f.unitIds[0]}`), 204,
    );
    const clash = await api.put(
      `/booking/v1/reservation-actions/${second.reservationId}/assign-unit/${f.unitIds[0]}`,
    );
    assert.equal(clash.status, 409);
  });

  test('locking the unit assignment blocks reassignment', async () => {
    const f = await createFixture(api, { units: 2 });
    const { reservationId } = await book(api, f, { arrival: daysFromNow(80), departure: daysFromNow(81) });
    await expectStatus(await api.put(`/booking/v1/reservation-actions/${reservationId}/assign-unit`), 204);
    await expectStatus(await api.put(`/booking/v1/reservation-actions/${reservationId}/lock-unit`), 204);

    const blocked = await api.put(`/booking/v1/reservation-actions/${reservationId}/unassign-units`);
    assert.equal(blocked.status, 422);

    await expectStatus(await api.put(`/booking/v1/reservation-actions/${reservationId}/unlock-unit`), 204);
    await expectStatus(await api.put(`/booking/v1/reservation-actions/${reservationId}/unassign-units`), 204);
  });

  test('reservation lists filter and page', async () => {
    const f = await createFixture(api, { units: 5 });
    for (let i = 0; i < 4; i++) {
      await book(api, f, {
        arrival: daysFromNow(90 + i),
        departure: daysFromNow(91 + i),
        lastName: `Guest${i}`,
      });
    }
    const page1 = await api.json<any>(
      `/booking/v1/reservations?propertyIds=${f.propertyId}&dateFilter=Arrival`
      + `&from=${daysFromNow(90)}&to=${daysFromNow(93)}&pageSize=2&pageNumber=1&sort=arrival:asc`,
    );
    assert.equal(page1.reservations.length, 2);
    assert.equal(page1.count, 4);

    const page3 = await api.get(
      `/booking/v1/reservations?propertyIds=${f.propertyId}&dateFilter=Arrival`
      + `&from=${daysFromNow(90)}&to=${daysFromNow(93)}&pageSize=2&pageNumber=3`,
    );
    // Past the end of the collection the API answers 204, as apaleo does.
    assert.equal(page3.status, 204);

    const search = await api.json<any>(
      `/booking/v1/reservations?propertyIds=${f.propertyId}&textSearch=Guest2`,
    );
    assert.equal(search.count, 1);
  });

  test('booking a service adds it to the reservation and the total', async () => {
    const f = await createFixture(api, { units: 2, price: 100 });
    const service = await expectStatus(await api.post('/rateplan/v1/services', {
      code: 'BRKF',
      propertyId: f.propertyId,
      name: { en: 'Breakfast' },
      description: { en: 'Breakfast buffet' },
      defaultGrossPrice: { amount: 15, currency: 'EUR' },
      pricingUnit: 'Person',
      postNextDay: false,
      availability: { mode: 'Daily' },
      accountingConfigs: [{ vatType: 'Reduced', serviceType: 'FoodAndBeverages', validFrom: '1970-01-01' }],
    }), 201);

    const arrival = daysFromNow(100);
    const { reservationId } = await book(api, f, { arrival, departure: daysFromNow(102) });
    await expectStatus(await api.put(`/booking/v1/reservation-actions/${reservationId}/book-service`, {
      serviceId: service.id,
    }), 204);

    const r = await api.json<any>(`/booking/v1/reservations/${reservationId}`);
    // Two nights of breakfast for one guest.
    assert.equal(r.services.length, 1);
    assert.equal(r.services[0].totalAmount.grossAmount, 30);
    assert.equal(r.totalGrossAmount.amount, 230);

    await expectStatus(
      await api.del(`/booking/v1/reservations/${reservationId}/services?serviceId=${service.id}`), 204,
    );
    const after = await api.json<any>(`/booking/v1/reservations/${reservationId}`);
    assert.equal(after.totalGrossAmount.amount, 200);
  });

  test('no-show marks the reservation and posts nothing without a policy', async () => {
    const f = await createFixture(api, { units: 1 });
    const { reservationId } = await book(api, f, { arrival: daysFromNow(0), departure: daysFromNow(1) });
    await expectStatus(await api.put(`/booking/v1/reservation-actions/${reservationId}/noshow`), 204);
    const r = await api.json<any>(`/booking/v1/reservations/${reservationId}`);
    assert.equal(r.status, 'NoShow');
    assert.equal(r.balance.amount, 0);
  });
});
