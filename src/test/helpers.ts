import type { AddressInfo } from 'net';
import type { Server } from 'http';
import { createServer } from '../server';
import { resetDb } from '../core/db';
import { setRandomSource } from '../core/ids';

/**
 * Test harness: boots the real server on an ephemeral port against an
 * in-memory database, so tests exercise the HTTP surface rather than calling
 * handlers directly.
 */

export interface TestApi {
  base: string;
  close(): Promise<void>;
  get(path: string): Promise<Response>;
  post(path: string, body?: unknown): Promise<Response>;
  put(path: string, body?: unknown): Promise<Response>;
  patch(path: string, body: unknown): Promise<Response>;
  del(path: string): Promise<Response>;
  json<T = any>(path: string): Promise<T>;
}

let seed = 1;
let propertyCounter = 0;

export async function startApi(): Promise<TestApi> {
  resetDb();
  // Deterministic ids keep failures reproducible.
  seed = 987654321;
  propertyCounter = 0;
  setRandomSource(() => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 0x100000000;
  });

  const app = createServer();
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;

  const send = (method: string) => async (path: string, body?: unknown) =>
    fetch(base + path, {
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  return {
    base,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    get: (path) => fetch(base + path),
    post: send('POST'),
    put: send('PUT'),
    patch: (path, body) => send('PATCH')(path, body),
    del: send('DELETE'),
    async json<T>(path: string): Promise<T> {
      const res = await fetch(base + path);
      if (res.status === 204) return undefined as T;
      return res.json() as Promise<T>;
    },
  };
}

/** Assert a response has the expected status, reporting the body when not. */
export async function expectStatus(res: Response, status: number): Promise<any> {
  if (res.status !== status) {
    const text = await res.text();
    throw new Error(`Expected ${status} but got ${res.status}: ${text}`);
  }
  if (res.status === 204 || res.headers.get('content-length') === '0') return undefined;
  const type = res.headers.get('content-type') ?? '';
  if (!type.includes('json')) return res.text();
  return res.json();
}

export const iso = (date: Date) => date.toISOString().slice(0, 10);
export const daysFromNow = (n: number) => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return iso(d);
};

/** A fresh property code per fixture, so tests never collide. */
export function nextPropertyCode(): string {
  propertyCounter += 1;
  return `T${String(propertyCounter).padStart(2, '0')}`;
}

/** Create a property with the minimum a booking needs. */
export async function createProperty(api: TestApi, code = nextPropertyCode()): Promise<string> {
  await expectStatus(await api.post('/inventory/v1/properties', {
    code,
    name: { en: `${code} Hotel` },
    description: { en: 'Test property' },
    companyName: `${code} GmbH`,
    commercialRegisterEntry: 'HRB 1',
    taxId: 'DE123456789',
    location: { addressLine1: 'Main street 1', postalCode: '10000', city: 'Testville', countryCode: 'DE' },
    paymentTerms: { en: 'Due on departure' },
    timeZone: 'Europe/Berlin',
    currencyCode: 'EUR',
    defaultCheckInTime: '15:00',
    defaultCheckOutTime: '11:00',
  }), 201);
  return code;
}

export interface Fixture {
  propertyId: string;
  unitGroupId: string;
  unitIds: string[];
  ratePlanId: string;
}

/**
 * A property with one unit group, a few units, a cancellation policy, a rate
 * plan and rates loaded over the next 90 days.
 */
export async function createFixture(api: TestApi, opts: { units?: number; price?: number } = {}): Promise<Fixture> {
  const propertyId = await createProperty(api);
  const unitCount = opts.units ?? 3;
  const price = opts.price ?? 100;

  const group = await expectStatus(await api.post('/inventory/v1/unit-groups', {
    code: 'DBL',
    propertyId,
    name: { en: 'Double' },
    description: { en: 'Double room' },
    maxPersons: 2,
    type: 'BedRoom',
  }), 201);

  const units: string[] = [];
  for (let i = 0; i < unitCount; i++) {
    const unit = await expectStatus(await api.post('/inventory/v1/units', {
      propertyId,
      unitGroupId: group.id,
      name: `10${i + 1}`,
      description: { en: 'Double room' },
      maxPersons: 2,
    }), 201);
    units.push(unit.id);
  }

  const policy = await expectStatus(await api.post('/rateplan/v1/cancellation-policies', {
    code: 'FLEX',
    propertyId,
    name: { en: 'Flexible' },
    description: { en: 'Free until the day of arrival' },
    periodFromReference: { hours: 6 },
    reference: 'PriorToArrival',
    fee: { vatType: 'Normal', percentValue: { percent: 100, limit: 1 } },
  }), 201);

  const plan = await expectStatus(await api.post('/rateplan/v1/rate-plans', {
    code: 'STD',
    propertyId,
    unitGroupId: group.id,
    cancellationPolicyId: policy.id,
    timeSliceDefinitionId: `${propertyId}-NIGHT`,
    name: { en: 'Standard' },
    description: { en: 'Standard rate' },
    minGuaranteeType: 'PM6Hold',
    channelCodes: ['Direct'],
    surcharges: [{ adults: 2, type: 'Absolute', value: 20 }],
    accountingConfigs: [{ vatType: 'Reduced', serviceType: 'Accommodation', validFrom: '1970-01-01' }],
  }), 201);

  await expectStatus(await api.put(`/rateplan/v1/rate-plans/${plan.id}/rates`, {
    rates: [{
      from: `${daysFromNow(-30)}T00:00:00Z`,
      to: `${daysFromNow(120)}T00:00:00Z`,
      price: { amount: price, currency: 'EUR' },
    }],
  }), 204);

  return { propertyId, unitGroupId: group.id, unitIds: units, ratePlanId: plan.id };
}

/** Book a stay on the fixture's rate plan. */
export async function book(
  api: TestApi,
  fixture: Fixture,
  opts: { arrival: string; departure: string; adults?: number; lastName?: string; services?: string[] },
): Promise<{ bookingId: string; reservationId: string }> {
  const nights = Math.round(
    (Date.parse(opts.departure) - Date.parse(opts.arrival)) / 86400000,
  );
  const created = await expectStatus(await api.post('/booking/v1/bookings', {
    booker: { firstName: 'Test', lastName: opts.lastName ?? 'Booker', email: 'booker@example.com' },
    reservations: [{
      arrival: opts.arrival,
      departure: opts.departure,
      adults: opts.adults ?? 1,
      channelCode: 'Direct',
      primaryGuest: { firstName: 'Test', lastName: opts.lastName ?? 'Guest' },
      timeSlices: Array.from({ length: nights }, () => ({ ratePlanId: fixture.ratePlanId })),
      services: opts.services?.map((serviceId) => ({ serviceId })),
    }],
  }), 201);
  return { bookingId: created.id, reservationId: created.reservationIds[0].id };
}
