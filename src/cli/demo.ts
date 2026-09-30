/**
 * A narrated walk through one guest's stay, from shopping for a rate to the
 * invoice and the resulting ledger entries. Run with `npm run demo` after
 * seeding. It boots the server on an ephemeral port and drives it over HTTP,
 * so it demonstrates the API rather than the internals.
 */
import type { AddressInfo } from 'net';
import { createServer } from '../server';
import { getDb } from '../core/db';
import { addDays, today } from '../core/dates';
import { db } from '../domain/repo';

const pad = (value: unknown, width = 30) => String(value).padEnd(width);
const rjust = (value: unknown, width = 10) => String(value).padStart(width);
const money = (m: { amount: number; currency: string } | undefined) =>
  (m ? `${m.amount.toFixed(2)} ${m.currency}` : '-');

function heading(title: string): void {
  // eslint-disable-next-line no-console
  console.log(`\n\x1b[1m── ${title} ${'─'.repeat(Math.max(0, 62 - title.length))}\x1b[0m`);
}

function line(...parts: unknown[]): void {
  // eslint-disable-next-line no-console
  console.log('  ', ...parts);
}

async function main(): Promise<void> {
  getDb();
  const property = db.properties.get('MUC');
  if (!property) {
    // eslint-disable-next-line no-console
    console.error('No demo data found. Run `npm run seed` first.');
    process.exit(1);
  }

  const app = createServer();
  const server = await new Promise<import('http').Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  async function call(method: string, path: string, body?: unknown): Promise<any> {
    const res = await fetch(base + path, {
      method,
      headers: body ? { 'content-type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 204) return undefined;
    const type = res.headers.get('content-type') ?? '';
    const payload = type.includes('json') ? await res.json() : await res.text();
    if (res.status >= 400) {
      const detail = typeof payload === 'string' ? payload : JSON.stringify(payload);
      throw Object.assign(new Error(`${method} ${path} -> ${res.status} ${detail}`), { status: res.status, payload });
    }
    return payload;
  }
  const get = (p: string) => call('GET', p);
  const post = (p: string, b?: unknown) => call('POST', p, b);
  const put = (p: string, b?: unknown) => call('PUT', p, b);

  const businessDate = property.businessDate;
  const arrival = businessDate;
  const departure = addDays(businessDate, 2);

  try {
    heading('1. What can we sell for these dates?');
    const offers = await get(
      `/booking/v1/offers?propertyId=MUC&arrival=${arrival}&departure=${departure}&adults=2&channelCode=Direct`,
    );
    for (const offer of offers.offers) {
      line(pad(offer.ratePlan.id, 18), 'available', rjust(offer.availableUnits, 2),
        '·', pad(money(offer.totalGrossAmount), 12),
        '· cancellation fee', money(offer.cancellationFee.fee));
    }

    heading('2. Take the booking');
    const created = await post('/booking/v1/bookings', {
      booker: { firstName: 'Robin', lastName: 'Sorensen', email: 'robin@example.com' },
      comment: 'Arriving late',
      reservations: [{
        arrival,
        departure,
        adults: 2,
        channelCode: 'Direct',
        source: 'Website',
        primaryGuest: {
          firstName: 'Robin',
          lastName: 'Sorensen',
          email: 'robin@example.com',
          nationalityCountryCode: 'NO',
          address: { addressLine1: 'Storgata 1', postalCode: '0155', city: 'Oslo', countryCode: 'NO' },
        },
        timeSlices: [{ ratePlanId: 'MUC-FLEX-DBL' }, { ratePlanId: 'MUC-FLEX-DBL' }],
        services: [{ serviceId: 'MUC-BRKF' }],
        travelPurpose: 'Leisure',
        marketSegmentId: 'DIRECT',
      }],
    });
    const reservationId: string = created.reservationIds[0].id;
    line('booking', created.id, '· reservation', reservationId);

    let reservation = await get(`/booking/v1/reservations/${reservationId}`);
    line('nights  ', reservation.timeSlices.map((t: any) => `${t.serviceDate} ${t.totalGrossAmount.amount}`).join('   '));
    line('services', reservation.services.map((s: any) => `${s.service.code} x${s.dates.length} = ${s.totalAmount.grossAmount}`).join(', '));
    line('total   ', money(reservation.totalGrossAmount), '(accommodation + services + city tax)');

    heading('3. Assign a room and check in');
    const free = await get(`/availability/v1/reservations/${reservationId}/units`);
    line('free rooms:', free.units.map((u: any) => `${u.name}(${u.status.condition})`).join(' '));
    await put(`/booking/v1/reservation-actions/${reservationId}/assign-unit/${free.units[0].id}`);
    await put(`/booking/v1/reservation-actions/${reservationId}/checkin`);
    reservation = await get(`/booking/v1/reservations/${reservationId}`);
    line('status', reservation.status, '· room', reservation.unit.name, '· balance', money(reservation.balance));

    heading('4. Post an extra and settle the first night');
    const folios = await get(`/finance/v1/folios?reservationIds=${reservationId}`);
    const folioId: string = folios.folios[0].id;
    await post(`/finance/v1/folio-actions/${folioId}/charges`, {
      serviceType: 'FoodAndBeverages',
      vatType: 'Reduced',
      name: 'Bar - two glasses of Riesling',
      amount: { amount: 24, currency: 'EUR' },
      quantity: 2,
    });
    let folio = await get(`/finance/v1/folios/${folioId}`);
    for (const charge of folio.charges) {
      line(pad(charge.serviceDate, 12), pad(charge.name, 32), rjust(charge.amount.grossAmount.toFixed(2)),
        `  net ${charge.amount.netAmount.toFixed(2)} · VAT ${charge.amount.vatPercent}%`);
    }
    line('balance', money(folio.balance));
    await post(`/finance/v1/folios/${folioId}/payments`, {
      method: 'CreditCard',
      amount: { amount: folio.balance.amount, currency: 'EUR' },
    });
    line('after payment:', money((await get(`/finance/v1/folios/${folioId}`)).balance));

    heading('5. Run the night audit');
    await put('/operations/v1/night-audit?propertyId=MUC');
    const auditLog = await get('/logs/v1/finance/night-audit?propertyIds=MUC');
    const entry = auditLog.logEntries[0];
    line('closed business date', entry.businessDate, '· status', entry.status);
    line('now operating on   ', (await get('/inventory/v1/properties/MUC')) && db.properties.get('MUC')!.businessDate);

    heading('6. Check out');
    // Check-out posts whatever is still outstanding, then refuses until it is
    // settled - so the first call tells the desk what to collect.
    try {
      await put(`/booking/v1/reservation-actions/${reservationId}/checkout`);
    } catch (err) {
      line('refused:', (err as any).payload.messages[0]);
    }
    folio = await get(`/finance/v1/folios/${folioId}`);
    if (folio.balance.amount > 0) {
      line('collecting', money(folio.balance));
      await post(`/finance/v1/folios/${folioId}/payments`, {
        method: 'Cash',
        amount: { amount: folio.balance.amount, currency: 'EUR' },
      });
      await put(`/booking/v1/reservation-actions/${reservationId}/checkout`);
    }
    reservation = await get(`/booking/v1/reservations/${reservationId}`);
    line('status', reservation.status, '· balance', money(reservation.balance));

    heading('7. Issue the invoice');
    await put(`/finance/v1/folio-actions/${folioId}/reopen`);
    const invoiceRef = await post('/finance/v1/invoices', { folioId, languageCode: 'en' });
    const invoice = await get(`/finance/v1/invoices/${invoiceRef.id}`);
    line(invoice.number, '·', invoice.status, '·', money(invoice.total));
    for (const item of invoice.lineItems.lineItems) {
      line(pad(item.date, 12), pad(item.description, 34), rjust(item.price.amount.toFixed(2)));
    }
    line('VAT:', invoice.taxDetails.map((t: any) => `${t.vatPercent}% net ${t.net.amount} tax ${t.tax.amount}`).join('  |  '));

    heading('8. The books balance');
    const aggregate = await post(
      `/finance/v1/accounts/aggregate?propertyId=MUC&from=${addDays(businessDate, -60)}&to=${addDays(businessDate, 5)}`,
    );
    line('debits', money(aggregate.total.debitedAmount),
      '· credits', money(aggregate.total.creditedAmount),
      '· difference', money(aggregate.total.balance));
    for (const row of aggregate.aggregations.filter((a: any) => /^\d/.test(a.account.number))) {
      if (Math.abs(row.debitedAmount.amount) < 0.005 && Math.abs(row.creditedAmount.amount) < 0.005) continue;
      line(pad(row.account.number, 7), pad(row.account.name, 28),
        'Dr', rjust(row.debitedAmount.amount.toFixed(2)),
        'Cr', rjust(row.creditedAmount.amount.toFixed(2)));
    }

    heading('9. Yesterday in numbers');
    const performance = await get(
      `/reports/v1/reports/property-performance?propertyId=MUC&from=${addDays(businessDate, -1)}&to=${businessDate}`,
    );
    line('house', performance.houseCount, '· sold', performance.soldCount,
      '· occupancy', `${performance.occupancyPercentage}%`);
    line('ADR', money(performance.grossAdr), '· RevPAR', money(performance.revPar),
      '· room revenue', money(performance.grossAccommodationRevenue));
    // eslint-disable-next-line no-console
    console.log();
  } finally {
    server.close();
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

export { today };
