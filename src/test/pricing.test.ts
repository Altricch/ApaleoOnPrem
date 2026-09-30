import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  createProperty, daysFromNow, expectStatus, startApi, type TestApi,
} from './helpers';

/**
 * Pricing behaviour that is easy to get subtly wrong: derived rate plans,
 * the Truncate/Round calculation mode, age category surcharges, city tax
 * types and rate restrictions.
 */
describe('pricing', () => {
  let api: TestApi;
  before(async () => { api = await startApi(); });
  after(async () => { await api.close(); });

  /** A property with a unit group and a cancellation policy, nothing else. */
  async function base(): Promise<{ propertyId: string; unitGroupId: string; policyId: string }> {
    const propertyId = await createProperty(api);
    const group = await expectStatus(await api.post('/inventory/v1/unit-groups', {
      code: 'DBL', propertyId, name: { en: 'Double' }, description: { en: 'Double' }, maxPersons: 4,
    }), 201);
    for (let i = 0; i < 3; i++) {
      await expectStatus(await api.post('/inventory/v1/units', {
        propertyId, unitGroupId: group.id, name: `20${i}`, description: { en: 'Double' }, maxPersons: 4,
      }), 201);
    }
    const policy = await expectStatus(await api.post('/rateplan/v1/cancellation-policies', {
      code: 'NONREF', propertyId, name: { en: 'Non refundable' }, description: { en: 'No refund' },
      periodFromReference: { days: 365 }, reference: 'PriorToArrival',
      fee: { vatType: 'Normal', percentValue: { percent: 100 } },
    }), 201);
    return { propertyId, unitGroupId: group.id, policyId: policy.id };
  }

  async function makePlan(
    ctx: { propertyId: string; unitGroupId: string; policyId: string },
    code: string,
    extra: Record<string, unknown> = {},
  ): Promise<string> {
    const plan = await expectStatus(await api.post('/rateplan/v1/rate-plans', {
      code,
      propertyId: ctx.propertyId,
      unitGroupId: ctx.unitGroupId,
      cancellationPolicyId: ctx.policyId,
      timeSliceDefinitionId: `${ctx.propertyId}-NIGHT`,
      name: { en: code },
      description: { en: code },
      minGuaranteeType: 'PM6Hold',
      channelCodes: ['Direct'],
      accountingConfigs: [{ vatType: 'Reduced', serviceType: 'Accommodation', validFrom: '1970-01-01' }],
      ...extra,
    }), 201);
    return plan.id;
  }

  /** `RateRestrictionsModel` requires all three closed flags to be present. */
  async function setRate(planId: string, price: number, restrictions?: Record<string, unknown>) {
    await expectStatus(await api.put(`/rateplan/v1/rate-plans/${planId}/rates`, {
      rates: [{
        from: `${daysFromNow(-10)}T00:00:00Z`,
        to: `${daysFromNow(100)}T00:00:00Z`,
        price: { amount: price, currency: 'EUR' },
        restrictions: restrictions
          ? { closed: false, closedOnArrival: false, closedOnDeparture: false, ...restrictions }
          : undefined,
      }],
    }), 204);
  }

  async function quote(planId: string, opts: { adults?: number; childrenAges?: number[]; nights?: number } = {}) {
    const nights = opts.nights ?? 1;
    const query = new URLSearchParams({
      ratePlanId: planId,
      arrival: daysFromNow(7),
      departure: daysFromNow(7 + nights),
      adults: String(opts.adults ?? 1),
      includeUnavailable: 'true',
    });
    for (const age of opts.childrenAges ?? []) query.append('childrenAges', String(age));
    const result = await expectStatus(await api.get(`/booking/v1/rate-plan-offers?${query}`), 200);
    return result.offers[0];
  }

  test('a derived plan prices off its base', async () => {
    const ctx = await base();
    const basePlan = await makePlan(ctx, 'BASE');
    await setRate(basePlan, 200);

    const derived = await makePlan(ctx, 'DERIVED', {
      pricingRule: { baseRatePlanId: basePlan, type: 'Percent', value: -10 },
    });

    const offer = await quote(derived);
    assert.equal(offer.totalGrossAmount.amount, 180);

    // The derived plan reports its lineage.
    const plan = await api.json<any>(`/rateplan/v1/rate-plans/${derived}`);
    assert.equal(plan.isDerived, true);
    assert.equal(plan.derivationLevel, 1);
    assert.equal(plan.pricingRule.baseRatePlan.id, basePlan);

    // Rates cannot be set directly on a derived plan.
    const blocked = await api.put(`/rateplan/v1/rate-plans/${derived}/rates`, {
      rates: [{ from: `${daysFromNow(1)}T00:00:00Z`, to: `${daysFromNow(2)}T00:00:00Z`, price: { amount: 1, currency: 'EUR' } }],
    });
    assert.equal(blocked.status, 422);
  });

  test('Truncate and Round differ on a fractional surcharge', async () => {
    const ctx = await base();
    // 125.99 + 10% -> Truncate keeps 12, Round keeps 12.60.
    const truncate = await makePlan(ctx, 'TRUNC', {
      priceCalculationMode: 'Truncate',
      surcharges: [{ adults: 2, type: 'Percent', value: 10 }],
    });
    const round = await makePlan(ctx, 'ROUND', {
      priceCalculationMode: 'Round',
      surcharges: [{ adults: 2, type: 'Percent', value: 10 }],
    });
    await setRate(truncate, 125.99);
    await setRate(round, 125.99);

    assert.equal((await quote(truncate, { adults: 2 })).totalGrossAmount.amount, 137.99);
    assert.equal((await quote(round, { adults: 2 })).totalGrossAmount.amount, 138.59);
  });

  test('an unconfigured occupancy is reported rather than silently priced', async () => {
    const ctx = await base();
    const plan = await makePlan(ctx, 'SINGLE', { surcharges: [{ adults: 2, type: 'Absolute', value: 30 }] });
    await setRate(plan, 100);

    assert.equal((await quote(plan, { adults: 2 })).totalGrossAmount.amount, 130);

    const three = await quote(plan, { adults: 3 });
    assert.ok(three.validationMessages.some((m: any) => m.code === 'RatePlanSurchargesNotSet'));
  });

  test('children are charged by age category', async () => {
    const ctx = await base();
    for (const [code, name, minAge, maxAge] of [
      ['BABY', 'Baby', 0, 2], ['CHILD', 'Child', 3, 11],
    ] as const) {
      await expectStatus(await api.post('/settings/v1/age-categories', {
        code, propertyId: ctx.propertyId, name: { en: name }, minAge, maxAge,
      }), 201);
    }

    const plan = await makePlan(ctx, 'FAMILY', {
      ageCategories: [
        { id: `${ctx.propertyId}-BABY`, surcharges: [{ adults: 1, value: 0 }] },
        { id: `${ctx.propertyId}-CHILD`, surcharges: [{ adults: 1, value: 25 }] },
      ],
    });
    await setRate(plan, 100);

    assert.equal((await quote(plan, { adults: 1, childrenAges: [1] })).totalGrossAmount.amount, 100);
    assert.equal((await quote(plan, { adults: 1, childrenAges: [5] })).totalGrossAmount.amount, 125);
    assert.equal((await quote(plan, { adults: 1, childrenAges: [5, 8] })).totalGrossAmount.amount, 150);
  });

  test('city tax is calculated per type', async () => {
    const ctx = await base();
    const plan = await makePlan(ctx, 'TAXED');
    await setRate(plan, 107); // net 100 at 7% VAT

    await expectStatus(await api.post('/settings/v1/city-tax', {
      code: 'PCT', propertyId: ctx.propertyId,
      name: { en: 'City tax' }, description: { en: '5% of net' },
      type: 'PercentOfNet', taxHandlingType: 'AfterTax', value: 5, vatType: 'Without',
    }), 201);

    let offer = await quote(plan);
    assert.equal(offer.cityTaxes.length, 1);
    assert.equal(offer.cityTaxes[0].totalGrossAmount.amount, 5);
    assert.equal(offer.totalGrossAmount.amount, 112);

    // Swap it for a per-person tax with a child exemption.
    await expectStatus(await api.del(`/settings/v1/city-tax/${ctx.propertyId}-PCT`), 204);
    await expectStatus(await api.post('/settings/v1/city-tax', {
      code: 'PP', propertyId: ctx.propertyId,
      name: { en: 'Per person' }, description: { en: '3 per adult' },
      type: 'PerPersonPerNight', taxHandlingType: 'AfterTax', value: 3, vatType: 'Without',
      subcategories: [{ name: { en: 'Children' }, value: 0, age: { min: 0, max: 17 } }],
    }), 201);

    offer = await quote(plan, { adults: 2, nights: 2 });
    // Two adults, two nights, three each. The surcharge for two adults is not
    // configured, so only the tax is asserted here.
    assert.equal(offer.cityTaxes[0].totalGrossAmount.amount, 12);
  });

  test('a city tax limit caps the number of taxed nights', async () => {
    const ctx = await base();
    const plan = await makePlan(ctx, 'CAPPED');
    await setRate(plan, 100);
    await expectStatus(await api.post('/settings/v1/city-tax', {
      code: 'CAP', propertyId: ctx.propertyId,
      name: { en: 'Capped' }, description: { en: 'First 3 nights only' },
      type: 'PerRoomPerNight', taxHandlingType: 'AfterTax', value: 2, vatType: 'Without', limit: 3,
    }), 201);

    const offer = await quote(plan, { nights: 5 });
    assert.equal(offer.cityTaxes[0].dates.length, 3);
    assert.equal(offer.cityTaxes[0].totalGrossAmount.amount, 6);
  });

  test('rate restrictions surface as validation messages', async () => {
    const ctx = await base();
    const plan = await makePlan(ctx, 'RESTRICTED');
    await setRate(plan, 100, { closedOnArrival: true, minLengthOfStay: 3 });

    const offer = await quote(plan, { nights: 1 });
    const messages = offer.validationMessages.map((m: any) => m.message);
    assert.ok(messages.some((m: string) => m.includes('closed to arrival')));
    assert.ok(messages.some((m: string) => m.includes('minimum stay of 3')));

    // Three nights, and no longer an arrival-day problem if it is open again.
    await setRate(plan, 100, { minLengthOfStay: 3 });
    const ok = await quote(plan, { nights: 3 });
    assert.equal(ok.validationMessages.length, 0);
  });

  test('a missing rate is reported rather than priced as zero', async () => {
    const ctx = await base();
    const plan = await makePlan(ctx, 'NORATES');
    const offer = await quote(plan);
    assert.ok(offer.validationMessages.some((m: any) => m.code === 'RatesNotSet'));
    assert.equal(offer.totalGrossAmount.amount, 0);
  });

  test('included services are carved out of the room rate', async () => {
    const ctx = await base();
    const service = await expectStatus(await api.post('/rateplan/v1/services', {
      code: 'BRKF', propertyId: ctx.propertyId,
      name: { en: 'Breakfast' }, description: { en: 'Breakfast' },
      defaultGrossPrice: { amount: 20, currency: 'EUR' },
      pricingUnit: 'Room', postNextDay: false, availability: { mode: 'Daily' },
      accountingConfigs: [{ vatType: 'Reduced', serviceType: 'FoodAndBeverages', validFrom: '1970-01-01' }],
    }), 201);

    const plan = await makePlan(ctx, 'BBR', {
      includedServices: [{ serviceId: service.id, grossPrice: { amount: 20, currency: 'EUR' }, pricingMode: 'Included' }],
    });
    await setRate(plan, 120);

    const offer = await quote(plan);
    // The guest still pays 120, but only 100 of it is accommodation revenue.
    assert.equal(offer.totalGrossAmount.amount, 120);
    assert.equal(offer.timeSlices[0].baseAmount.grossAmount, 100);
    assert.equal(offer.timeSlices[0].includedServices[0].totalAmount.grossAmount, 20);
  });

  test('rates can be patched across a date range by weekday', async () => {
    const ctx = await base();
    const plan = await makePlan(ctx, 'WEEKEND');
    await setRate(plan, 100);

    const from = daysFromNow(1);
    const to = daysFromNow(15);
    await expectStatus(await api.patch(
      `/rateplan/v1/rates?ratePlanIds=${plan}&from=${from}&to=${to}&weekDays=Friday&weekDays=Saturday`,
      [{ op: 'replace', path: '/price/amount', value: 150 }],
    ), 204);

    const rates = await api.json<any>(`/rateplan/v1/rate-plans/${plan}/rates?from=${from}&to=${to}`);
    const prices = new Set(rates.rates.map((r: any) => r.price.amount));
    assert.ok(prices.has(150), 'weekend rates should be raised');
    assert.ok(prices.has(100), 'weekday rates should be untouched');
  });

  test('a promo-coded rate plan is hidden until the code is supplied', async () => {
    const ctx = await base();
    const plan = await makePlan(ctx, 'SECRET', { promoCodes: ['SPRING24'] });
    await setRate(plan, 80);
    const open = await makePlan(ctx, 'PUBLIC');
    await setRate(open, 100);

    const withoutCode = await api.json<any>(
      `/booking/v1/offers?propertyId=${ctx.propertyId}&arrival=${daysFromNow(7)}`
      + `&departure=${daysFromNow(8)}&adults=1&channelCode=Direct`,
    );
    assert.deepEqual(withoutCode.offers.map((o: any) => o.ratePlan.id), [open]);

    const withCode = await api.json<any>(
      `/booking/v1/offers?propertyId=${ctx.propertyId}&arrival=${daysFromNow(7)}`
      + `&departure=${daysFromNow(8)}&adults=1&channelCode=Direct&promoCode=SPRING24`,
    );
    assert.equal(withCode.offers.length, 2);
    assert.equal(withCode.offers[0].ratePlan.id, plan);
  });
});
