import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { listOperations, validateDefinition, V1_SPECS, getSpec } from '../core/spec';
import { coverage } from '../core/router';
import { createServer } from '../server';

describe('spec conformance', () => {
  test('all ten v1 specs are present', () => {
    for (const key of V1_SPECS) {
      assert.ok(getSpec(key), `spec ${key} should be loaded`);
    }
  });

  test('every documented v1 operation is implemented', () => {
    // Building the server registers every route.
    createServer();
    const c = coverage();
    assert.equal(
      c.missing.length,
      0,
      `unimplemented operations:\n${c.missing.map((o) => `${o.method} ${o.path}`).join('\n')}`,
    );
    assert.equal(c.implemented, c.total);
    assert.ok(c.total > 250, 'the v1 surface should be close to 290 operations');
  });

  test('operations carry their documented scopes', () => {
    const ops = listOperations();
    const create = ops.find((o) => o.operationId === 'InventoryPropertiesPost');
    assert.ok(create);
    assert.deepEqual(create.scopes.sort(), ['properties.create', 'setup.manage']);
  });

  test('validates a body against the real definition', () => {
    const errors = validateDefinition('inventory-v1', 'CreatePropertyModel', { code: 'AB' });
    assert.ok(errors.some((e) => e.includes('companyName')));
    assert.ok(errors.some((e) => e.includes('at least 3 character')));
  });

  test('accepts a valid body', () => {
    const errors = validateDefinition('inventory-v1', 'CreatePropertyModel', {
      code: 'MUC',
      name: { en: 'Hotel' },
      companyName: 'Hotel GmbH',
      commercialRegisterEntry: 'HRB 1',
      taxId: 'DE1',
      description: { en: 'x' },
      location: { addressLine1: 'a', postalCode: '1', city: 'c', countryCode: 'DE' },
      paymentTerms: { en: 'x' },
      timeZone: 'Europe/Berlin',
      defaultCheckInTime: '15:00',
      defaultCheckOutTime: '11:00',
      currencyCode: 'EUR',
    });
    assert.deepEqual(errors, []);
  });

  test('rejects a value outside an enum', () => {
    const errors = validateDefinition('booking-v1', 'CreateBookingModel', {
      booker: { lastName: 'X' },
      reservations: [{
        arrival: '2024-01-01', departure: '2024-01-02', adults: 1,
        channelCode: 'NotARealChannel', timeSlices: [{ ratePlanId: 'X' }],
      }],
    });
    assert.ok(errors.some((e) => e.includes('channelCode') && e.includes('must be one of')));
  });
});
