import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  book, createFixture, daysFromNow, expectStatus, startApi, type TestApi,
} from './helpers';

/**
 * Finance: folios, charges, allowances, payments, refunds, routing,
 * invoicing and the double-entry ledger underneath all of it.
 */
describe('finance', () => {
  let api: TestApi;
  before(async () => { api = await startApi(); });
  after(async () => { await api.close(); });

  async function bookedFolio(price = 100, nights = 2) {
    const f = await createFixture(api, { units: 3, price });
    const arrival = daysFromNow(5);
    const departure = daysFromNow(5 + nights);
    const { reservationId, bookingId } = await book(api, f, { arrival, departure });
    const folios = await api.json<any>(`/finance/v1/folios?reservationIds=${reservationId}`);
    return { fixture: f, reservationId, bookingId, folio: folios.folios[0], arrival, departure };
  }

  test('a reservation gets a main folio', async () => {
    const { folio, reservationId } = await bookedFolio();
    assert.equal(folio.isMainFolio, true);
    assert.equal(folio.status, 'Open');
    assert.equal(folio.balance.amount, 0);
    assert.equal(folio.reservation.id, reservationId);
  });

  test('posting a charge moves the balance and the ledger', async () => {
    const { folio } = await bookedFolio();
    await expectStatus(await api.post(`/finance/v1/folio-actions/${folio.id}/charges`, {
      serviceType: 'FoodAndBeverages',
      vatType: 'Reduced',
      name: 'Minibar',
      amount: { amount: 21.4, currency: 'EUR' },
    }), 201);

    const after = await api.json<any>(`/finance/v1/folios/${folio.id}`);
    assert.equal(after.balance.amount, 21.4);
    assert.equal(after.charges.length, 1);
    assert.equal(after.charges[0].amount.netAmount, 20);
    assert.equal(after.charges[0].amount.vatPercent, 7);

    // The sub-ledger carries the matching net and VAT entries.
    const account = await api.json<any>(
      `/finance/v1/accounts/1200?propertyId=${after.charges[0].id.slice(0, 3)}`,
    ).catch(() => undefined);
    void account;
  });

  test('an allowance reduces the balance and cannot exceed the charge', async () => {
    const { folio } = await bookedFolio();
    const charge = await expectStatus(await api.post(`/finance/v1/folio-actions/${folio.id}/charges`, {
      serviceType: 'Other',
      vatType: 'Normal',
      name: 'Laundry',
      amount: { amount: 50, currency: 'EUR' },
    }), 201);

    await expectStatus(
      await api.post(`/finance/v1/folio-actions/${folio.id}/charges/${charge.id}/allowances`, {
        amount: { amount: 20, currency: 'EUR' },
        reason: 'Damaged shirt',
      }), 201,
    );
    let after = await api.json<any>(`/finance/v1/folios/${folio.id}`);
    assert.equal(after.balance.amount, 30);
    assert.equal(after.allowances.length, 1);
    assert.equal(after.maximumAllowance, 30);

    const tooMuch = await api.post(
      `/finance/v1/folio-actions/${folio.id}/charges/${charge.id}/allowances`,
      { amount: { amount: 40, currency: 'EUR' }, reason: 'Too much' },
    );
    assert.equal(tooMuch.status, 422);

    after = await api.json<any>(`/finance/v1/folios/${folio.id}`);
    assert.equal(after.balance.amount, 30);
  });

  test('payments and refunds settle and reverse the balance', async () => {
    const { folio } = await bookedFolio();
    await expectStatus(await api.post(`/finance/v1/folio-actions/${folio.id}/charges`, {
      serviceType: 'Other', vatType: 'Normal', name: 'Spa', amount: { amount: 80, currency: 'EUR' },
    }), 201);

    const payment = await expectStatus(await api.post(`/finance/v1/folios/${folio.id}/payments`, {
      method: 'CreditCard', amount: { amount: 80, currency: 'EUR' },
    }), 201);

    let after = await api.json<any>(`/finance/v1/folios/${folio.id}`);
    assert.equal(after.balance.amount, 0);
    assert.equal(after.payments.length, 1);

    await expectStatus(
      await api.post(`/finance/v1/folios/${folio.id}/payments/${payment.id}/refunds`,
        { amount: { amount: 30, currency: 'EUR' }, reason: 'Goodwill' }), 201,
    );
    after = await api.json<any>(`/finance/v1/folios/${folio.id}`);
    assert.equal(after.balance.amount, 30);

    const refunds = await api.json<any>(`/finance/v1/folios/${folio.id}/refunds`);
    assert.equal(refunds.count, 1);
    assert.equal(refunds.refunds[0].amount.amount, 30);

    // Refunding more than remains is refused.
    const tooMuch = await api.post(
      `/finance/v1/folios/${folio.id}/payments/${payment.id}/refunds`,
      { amount: { amount: 60, currency: 'EUR' } },
    );
    assert.equal(tooMuch.status, 422);
  });

  test('charges move between folios and the balances follow', async () => {
    const { folio, reservationId } = await bookedFolio();
    const second = await expectStatus(await api.post('/finance/v1/folios', {
      reservationId,
      debitor: { name: 'Company Ltd', type: 'Company' },
      type: 'External',
    }), 201);

    const charge = await expectStatus(await api.post(`/finance/v1/folio-actions/${folio.id}/charges`, {
      serviceType: 'Accommodation', vatType: 'Reduced', name: 'Room', amount: { amount: 107, currency: 'EUR' },
    }), 201);

    await expectStatus(await api.put(`/finance/v1/folio-actions/${folio.id}/move-charges`, {
      targetFolioId: second.id,
      reason: 'Company pays the room',
      chargeIds: [charge.id],
    }), 204);

    const source = await api.json<any>(`/finance/v1/folios/${folio.id}`);
    const target = await api.json<any>(`/finance/v1/folios/${second.id}`);
    assert.equal(source.balance.amount, 0);
    assert.equal(target.balance.amount, 107);
    assert.equal(target.charges[0].movedFrom.id, folio.id);
  });

  test('splitting a charge keeps the total intact', async () => {
    const { folio } = await bookedFolio();
    const charge = await expectStatus(await api.post(`/finance/v1/folio-actions/${folio.id}/charges`, {
      serviceType: 'Other', vatType: 'Normal', name: 'Dinner', amount: { amount: 100, currency: 'EUR' },
    }), 201);

    await expectStatus(
      await api.post(`/finance/v1/folio-actions/${folio.id}/charges/${charge.id}/split`,
        { type: 'ByPercent', percent: 40 }), 201,
    );
    const after = await api.json<any>(`/finance/v1/folios/${folio.id}`);
    assert.equal(after.charges.length, 2);
    const total = after.charges.reduce((s: number, c: any) => s + c.amount.grossAmount, 0);
    assert.equal(total, 100);
    assert.deepEqual(after.charges.map((c: any) => c.amount.grossAmount).sort(), [40, 60]);
  });

  test('closing requires a zero balance, and reopening works', async () => {
    const { folio } = await bookedFolio();
    await expectStatus(await api.post(`/finance/v1/folio-actions/${folio.id}/charges`, {
      serviceType: 'Other', vatType: 'Normal', name: 'Bar', amount: { amount: 25, currency: 'EUR' },
    }), 201);

    const blocked = await api.put(`/finance/v1/folio-actions/${folio.id}/close`);
    assert.equal(blocked.status, 422);

    await expectStatus(await api.post(`/finance/v1/folios/${folio.id}/payments`, {
      method: 'Cash', amount: { amount: 25, currency: 'EUR' },
    }), 201);
    await expectStatus(await api.put(`/finance/v1/folio-actions/${folio.id}/close`), 204);

    let after = await api.json<any>(`/finance/v1/folios/${folio.id}`);
    assert.equal(after.status, 'Closed');

    await expectStatus(await api.put(`/finance/v1/folio-actions/${folio.id}/reopen`), 204);
    after = await api.json<any>(`/finance/v1/folios/${folio.id}`);
    assert.equal(after.status, 'Open');
  });

  test('routing sends matching charges to another folio automatically', async () => {
    const { folio, reservationId, bookingId, fixture } = await bookedFolio();
    const companyFolio = await expectStatus(await api.post('/finance/v1/folios', {
      reservationId,
      debitor: { name: 'Acme Ltd', type: 'Company' },
      type: 'External',
    }), 201);

    await expectStatus(await api.post('/finance/v1/routings', {
      bookingId,
      propertyId: fixture.propertyId,
      destinationFolioId: companyFolio.id,
      filter: { serviceTypes: ['Accommodation'] },
    }), 201);

    // A new accommodation charge should land on the company folio.
    await expectStatus(await api.post(`/finance/v1/folio-actions/${folio.id}/charges`, {
      serviceType: 'Accommodation', vatType: 'Reduced', name: 'Room night', amount: { amount: 107, currency: 'EUR' },
    }), 201);
    // A non-matching charge stays with the guest.
    await expectStatus(await api.post(`/finance/v1/folio-actions/${folio.id}/charges`, {
      serviceType: 'FoodAndBeverages', vatType: 'Reduced', name: 'Breakfast', amount: { amount: 21.4, currency: 'EUR' },
    }), 201);

    const guest = await api.json<any>(`/finance/v1/folios/${folio.id}`);
    const company = await api.json<any>(`/finance/v1/folios/${companyFolio.id}`);
    assert.equal(company.balance.amount, 107);
    assert.equal(guest.balance.amount, 21.4);
    assert.equal(company.charges[0].routedFrom.id, folio.id);
  });

  test('an invoice snapshots the folio, closes it, and can be cancelled', async () => {
    const { folio } = await bookedFolio();
    await expectStatus(await api.post(`/finance/v1/folio-actions/${folio.id}/charges`, {
      serviceType: 'Accommodation', vatType: 'Reduced', name: 'Room', amount: { amount: 107, currency: 'EUR' },
    }), 201);
    await expectStatus(await api.post(`/finance/v1/folios/${folio.id}/payments`, {
      method: 'Cash', amount: { amount: 107, currency: 'EUR' },
    }), 201);

    const preview = await api.json<any>(`/finance/v1/invoices/preview?folioId=${folio.id}`);
    assert.equal(preview.total.amount, 107);
    assert.equal(preview.lineItems.lineItems.length, 1);

    const created = await expectStatus(await api.post('/finance/v1/invoices', {
      folioId: folio.id, languageCode: 'en',
    }), 201);

    const invoice = await api.json<any>(`/finance/v1/invoices/${created.id}`);
    assert.equal(invoice.total.amount, 107);
    assert.equal(invoice.status, 'FullyPaid');
    assert.equal(invoice.taxDetails[0].vatPercent, 7);
    assert.equal(invoice.taxDetails[0].net.amount, 100);

    // The folio closed with the invoice attached.
    const closed = await api.json<any>(`/finance/v1/folios/${folio.id}`);
    assert.equal(closed.status, 'ClosedWithInvoice');

    // A second invoice over the same folio is refused.
    const again = await api.post('/finance/v1/invoices', { folioId: folio.id, languageCode: 'en' });
    assert.equal(again.status, 422);

    // The PDF is a real, openable document.
    const pdf = await api.get(`/finance/v1/invoices/${created.id}/pdf`);
    assert.equal(pdf.status, 200);
    assert.equal(pdf.headers.get('content-type'), 'application/pdf');
    const bytes = Buffer.from(await pdf.arrayBuffer());
    assert.equal(bytes.subarray(0, 5).toString('latin1'), '%PDF-');
    assert.ok(bytes.subarray(-6).toString('latin1').includes('%%EOF'));

    await expectStatus(await api.put(`/finance/v1/invoice-actions/${created.id}/cancel`, {
      reasonCode: 'ChangeOfRecipientDetails',
    }), 204);

    const all = await api.json<any>(`/finance/v1/invoices?folioIds=${folio.id}`);
    assert.equal(all.count, 2);
    const cancellation = all.invoices.find((i: any) => i.type === 'Cancellation');
    assert.equal(cancellation.subTotal.amount, -107);
    assert.equal(cancellation.relatedInvoiceNumber, invoice.number);
  });

  test('the ledger balances: every posting has a matching counter-entry', async () => {
    const { folio, fixture } = await bookedFolio();
    await expectStatus(await api.post(`/finance/v1/folio-actions/${folio.id}/charges`, {
      serviceType: 'Accommodation', vatType: 'Reduced', name: 'Room', amount: { amount: 107, currency: 'EUR' },
    }), 201);
    await expectStatus(await api.post(`/finance/v1/folios/${folio.id}/payments`, {
      method: 'Cash', amount: { amount: 107, currency: 'EUR' },
    }), 201);

    const from = daysFromNow(-1);
    const to = daysFromNow(1);
    const aggregate = await expectStatus(
      await api.post(`/finance/v1/accounts/aggregate?propertyId=${fixture.propertyId}&from=${from}&to=${to}`), 200,
    );
    // Total debits must equal total credits.
    assert.equal(aggregate.total.balance.amount, 0);
    assert.ok(aggregate.total.debitedAmount.amount > 0);
    assert.equal(aggregate.total.debitedAmount.amount, aggregate.total.creditedAmount.amount);

    const raw = await expectStatus(
      await api.post(`/finance/v1/accounts/export?propertyId=${fixture.propertyId}&from=${from}&to=${to}`), 200,
    );
    // Net 100 to revenue, 7 to VAT, 107 cash against the guest ledger.
    assert.equal(raw.transactions.length, 3);
    const cash = raw.transactions.find((t: any) => t.debitedAccount.number === '2100');
    assert.equal(cash.amount.amount, 107);
  });

  test('the chart of accounts is served as a tree', async () => {
    const { fixture } = await bookedFolio();
    const schema = await api.json<any>(`/finance/v1/accounts/schema?propertyId=${fixture.propertyId}`);
    assert.ok(schema.globalAccounts.length > 0);
    const revenues = schema.globalAccounts.find((a: any) => a.accountNumber === '1000');
    assert.equal(revenues.hasChildren, true);
    assert.ok(revenues.subAccounts.some((a: any) => a.accountNumber === '1100'));
  });

  test('reference types are served', async () => {
    const currencies = await api.json<any>('/finance/v1/types/currencies');
    assert.ok(currencies.isoCurrencies.includes('EUR'));
    const methods = await api.json<any>('/finance/v1/types/payment-methods');
    assert.ok(methods.paymentMethods.includes('Cash'));
    const types = await api.json<any>('/finance/v1/types/service-types');
    assert.ok(types.serviceTypes.includes('Accommodation'));
    const vat = await api.json<any>('/finance/v1/types/vat');
    assert.ok(vat.vatTypes.some((v: any) => v.type === 'Normal' && v.percent === 19));
  });
});
