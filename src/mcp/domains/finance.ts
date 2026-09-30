import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { arg, register, requireConfirmation } from '../core/define';
import { ToolError } from '../core/errors';
import { addDays, call, callList, callVoid, resolveProperty, window } from '../core/context';
import { capped, day, facts, money, sections, table } from '../core/render';

/**
 * The money side: folios, what is posted to them, and the documents that come
 * out the other end.
 *
 * Everything here writes to a double-entry sub-ledger, so the tools are
 * deliberately explicit about which of them move money and which only read.
 */

const PAYMENT_METHODS = [
  'Cash', 'CreditCard', 'BankTransfer', 'Amex', 'VisaCredit', 'VisaDebit',
  'MasterCard', 'Maestro', 'PayPal', 'Voucher', 'Cheque', 'Other',
] as const;

const SERVICE_TYPES = ['Other', 'Accommodation', 'FoodAndBeverages', 'CityTax'] as const;

const VAT_TYPES = ['Null', 'VeryReduced', 'Reduced', 'Normal', 'Without'] as const;

/* --------------------------------------------------------------- reading */

const findFolios = {
  name: 'finance_find_folios',
  title: 'Find folios',
  doc: {
    summary: 'List folios, filtered by open balance, status, or guest.',
    use: [
      'Answering "who still owes money" or "what is unpaid".',
      'Finding a folio id to post against when you only know the guest.',
      'Reviewing what is ready to be invoiced.',
    ],
    avoid: [
      'One folio in detail - use finance_get_folio.',
      'Revenue totals - use insight_revenue.',
    ],
    returns: 'One row per folio: id, debitor, type, status, balance, and the reservation it belongs to.',
    notes: ['A reservation gets one main folio automatically; extra folios exist to split a bill.'],
  },
  input: {
    propertyId: arg.optionalPropertyId,
    reservationId: z.string().optional().describe('Only folios belonging to this reservation.'),
    status: z.enum(['Open', 'Closed']).optional().describe('Open folios can still be posted to.'),
    balance: z.enum(['Any', 'Owing', 'Settled', 'InCredit']).default('Any')
      .describe('Owing = the guest still owes; InCredit = the property owes the guest.'),
    search: z.string().optional().describe('Free text over folio id, debitor name and reservation id.'),
    limit: arg.limit(25, 200),
  },
  annotations: { readOnly: true },
  async handler(args: any) {
    const property = await resolveProperty(args.propertyId);
    const balanceFilter = { Any: undefined, Owing: 'Positive', Settled: 'Zero', InCredit: 'Negative' }[
      args.balance as 'Any' | 'Owing' | 'Settled' | 'InCredit'
    ];

    const { items, count } = await callList<any>({
      method: 'GET',
      path: '/finance/v1/folios',
      query: {
        propertyIds: property.id,
        reservationIds: args.reservationId,
        status: args.status,
        balanceFilter,
        textSearch: args.search,
        pageSize: Math.min(args.limit, 200),
      },
    }, 'folios');

    if (!items.length) {
      return { text: `No folios at ${property.name} match those filters.`, data: { count: 0, folios: [] } };
    }

    const { shown, note } = capped(items, count, args.limit);
    const rows = shown.map((f) => ({
      id: f.id,
      debitor: [f.debitor?.firstName, f.debitor?.name].filter(Boolean).join(' ') || f.debitor?.company?.name || '',
      type: f.type,
      status: f.status,
      reservation: f.reservation?.id ?? '',
      balance: f.balance,
    }));
    const owing = items
      .filter((f: any) => f.balance.amount > 0)
      .reduce((sum: number, f: any) => sum + f.balance.amount, 0);

    return {
      text: sections(
        `${count} folio(s) at ${property.name}`,
        table(rows, [
          { header: 'folioId', value: (r) => r.id },
          { header: 'debitor', value: (r) => r.debitor },
          { header: 'type', value: (r) => r.type },
          { header: 'status', value: (r) => r.status },
          { header: 'reservation', value: (r) => r.reservation },
          { header: 'balance', value: (r) => money(r.balance), align: 'right' },
        ]) + note,
        owing > 0 ? `Outstanding across these folios: ${money({ amount: owing, currency: property.currencyCode })}.` : null,
      ),
      data: { count, folios: rows },
    };
  },
};

const getFolio = {
  name: 'finance_get_folio',
  title: 'Read a folio',
  doc: {
    summary: 'Read one folio: every charge, allowance, payment and refund, with the balance.',
    use: [
      'Explaining a bill line by line.',
      'Checking what is still owed before check-out or invoicing.',
      'Finding a chargeId to discount with finance_post_allowance.',
    ],
    avoid: [
      'Scanning many folios - use finance_find_folios.',
      'The issued document - use finance_get_invoice.',
    ],
    returns: 'Header facts, the posting lines in date order, the balance, and the actions currently allowed.',
    notes: ['Charges carry the VAT rate they were posted at; the tax breakdown is derived from those.'],
  },
  input: { folioId: arg.folioId },
  annotations: { readOnly: true },
  async handler(args: any) {
    const f = await call<any>(
      { method: 'GET', path: `/finance/v1/folios/${encodeURIComponent(args.folioId)}` },
      { subject: `Folio '${args.folioId}'`, discoverWith: 'finance_find_folios' },
    );

    const lines = [
      ...(f.charges ?? []).map((c: any) => ({
        date: c.serviceDate, kind: 'charge', id: c.id, name: c.name,
        amount: { amount: c.amount.grossAmount, currency: c.amount.currency },
        vat: `${c.amount.vatPercent}%`,
      })),
      ...(f.transitoryCharges ?? []).map((c: any) => ({
        date: c.serviceDate, kind: 'transitory', id: c.id, name: c.name, amount: c.amount, vat: '',
      })),
      ...(f.allowances ?? []).map((a: any) => ({
        date: a.serviceDate, kind: 'allowance', id: a.id, name: a.reason,
        amount: { amount: -a.amount.grossAmount, currency: a.amount.currency },
        vat: `${a.amount.vatPercent}%`,
      })),
      ...(f.payments ?? []).map((p: any) => ({
        date: p.businessDate, kind: 'payment', id: p.id, name: p.method,
        amount: { amount: -p.amount.amount, currency: p.amount.currency }, vat: '',
      })),
    ].sort((a, b) => String(a.date).localeCompare(String(b.date)));

    return {
      text: sections(
        facts({
          folio: f.id,
          status: f.status,
          type: f.type,
          debitor: [f.debitor?.firstName, f.debitor?.name].filter(Boolean).join(' ') || f.debitor?.company?.name,
          reservation: f.reservation?.id,
          balance: money(f.balance),
          maxAllowance: f.maximumAllowance ? money({ amount: f.maximumAllowance, currency: f.balance.currency }) : undefined,
        }),
        lines.length ? table(lines, [
          { header: 'date', value: (l) => l.date },
          { header: 'kind', value: (l) => l.kind },
          { header: 'id', value: (l) => l.id },
          { header: 'description', value: (l) => l.name },
          { header: 'vat', value: (l) => l.vat, align: 'right' },
          { header: 'amount', value: (l) => money(l.amount), align: 'right' },
        ]) : 'Nothing posted yet.',
        `Balance ${money(f.balance)}`,
        f.allowedActions?.length ? `ALLOWED NOW: ${f.allowedActions.join(', ')}` : null,
        f.folioWarnings?.length ? `WARNINGS\n${f.folioWarnings.map((w: string) => `- ${w}`).join('\n')}` : null,
      ),
      data: { folio: f.id, status: f.status, balance: f.balance, lines, allowedActions: f.allowedActions },
    };
  },
};

/* --------------------------------------------------------------- posting */

const postCharge = {
  name: 'finance_post_charge',
  title: 'Post a charge',
  doc: {
    summary: 'Put an ad-hoc charge on a folio, such as a minibar item or a damage fee.',
    use: [
      'Charging for something with no configured service behind it.',
      'Recovering a cost from the guest during their stay.',
    ],
    avoid: [
      'A configured extra like breakfast - use booking_manage_services so it prices correctly.',
      'Reducing a charge already posted - use finance_post_allowance.',
    ],
    returns: 'The charge id and the folio balance afterwards.',
    notes: [
      'The amount is gross - VAT is derived from vatType, not added on top.',
      'Charges cannot be deleted. A mistake is corrected with an allowance, which keeps the audit trail.',
      'The folio must be open.',
    ],
  },
  input: {
    folioId: arg.folioId,
    description: z.string().min(1).describe('What the guest is being charged for. Appears on the invoice.'),
    amount: z.number().positive().describe('Gross amount including VAT, in the property currency.'),
    serviceType: z.enum(SERVICE_TYPES).default('Other')
      .describe('Revenue category. Drives which ledger account the revenue lands in.'),
    vatType: z.enum(VAT_TYPES).default('Normal')
      .describe('VAT band. Normal is the standard rate, Reduced typically applies to food and accommodation.'),
    quantity: z.number().int().min(1).default(1).describe('Units charged. The amount is the total, not per unit.'),
  },
  annotations: { destructive: false, idempotent: false },
  async handler(args: any) {
    const folio = await call<any>(
      { method: 'GET', path: `/finance/v1/folios/${encodeURIComponent(args.folioId)}` },
      { subject: `Folio '${args.folioId}'`, discoverWith: 'finance_find_folios' },
    );
    const created = await call<any>({
      method: 'POST',
      path: `/finance/v1/folio-actions/${encodeURIComponent(args.folioId)}/charges`,
      body: {
        name: args.description,
        serviceType: args.serviceType,
        vatType: args.vatType,
        quantity: args.quantity,
        amount: { amount: args.amount, currency: folio.balance.currency },
      },
    }, { subject: `Folio '${args.folioId}'` });

    const after = await call<any>({ method: 'GET', path: `/finance/v1/folios/${encodeURIComponent(args.folioId)}` });
    return {
      text: `Posted ${money({ amount: args.amount, currency: folio.balance.currency })} `
        + `"${args.description}" to ${args.folioId} as ${created.id}. Balance is now ${money(after.balance)}.`,
      data: { chargeId: created.id, folioId: args.folioId, balance: after.balance },
    };
  },
};

const postPayment = {
  name: 'finance_post_payment',
  title: 'Take a payment',
  doc: {
    summary: 'Record a payment against a folio.',
    use: [
      'The guest pays at the desk, by card or in cash.',
      'Settling a folio so check-out can complete.',
    ],
    avoid: [
      'Giving money back - use finance_post_refund.',
      'Writing off a charge - use finance_post_allowance.',
    ],
    returns: 'The payment id and the folio balance afterwards.',
    notes: [
      'Omit amount to settle the balance exactly - the usual case at check-out.',
      'This records money already taken; it does not authorise a card.',
    ],
  },
  input: {
    folioId: arg.folioId,
    method: z.enum(PAYMENT_METHODS).default('CreditCard').describe('How the guest paid.'),
    amount: z.number().positive().optional()
      .describe('Amount received. Omit to pay off the folio balance in full.'),
    receipt: z.string().optional().describe('Receipt or terminal reference to record against the payment.'),
  },
  annotations: { destructive: false, idempotent: false },
  async handler(args: any) {
    const folio = await call<any>(
      { method: 'GET', path: `/finance/v1/folios/${encodeURIComponent(args.folioId)}` },
      { subject: `Folio '${args.folioId}'`, discoverWith: 'finance_find_folios' },
    );
    const amount = args.amount ?? folio.balance.amount;
    if (amount <= 0) {
      throw new ToolError(
        `Folio ${args.folioId} has a balance of ${money(folio.balance)}; there is nothing to pay. `
        + 'Pass an explicit amount to record a payment anyway.',
      );
    }

    const created = await call<any>({
      method: 'POST',
      path: `/finance/v1/folios/${encodeURIComponent(args.folioId)}/payments`,
      body: { method: args.method, receipt: args.receipt, amount: { amount, currency: folio.balance.currency } },
    }, { subject: `Folio '${args.folioId}'` });

    const after = await call<any>({ method: 'GET', path: `/finance/v1/folios/${encodeURIComponent(args.folioId)}` });
    return {
      text: `Recorded ${money({ amount, currency: folio.balance.currency })} by ${args.method} on ${args.folioId} `
        + `as ${created.id}. Balance is now ${money(after.balance)}.`,
      data: { paymentId: created.id, folioId: args.folioId, amount, balance: after.balance },
    };
  },
};

const postAllowance = {
  name: 'finance_post_allowance',
  title: 'Discount or void a charge',
  doc: {
    summary: 'Reduce or reverse a charge with an allowance, keeping the original on the record.',
    use: [
      'Goodwill after a complaint.',
      'Correcting a charge posted in error.',
    ],
    avoid: [
      'Refunding money already taken - use finance_post_refund.',
      'A negative charge - allowances exist so the audit trail survives.',
    ],
    returns: 'The allowance id and the folio balance afterwards.',
    notes: [
      'With a chargeId, the allowance inherits that charge\'s VAT and cannot exceed what is left on it.',
      'Without one, it is a folio-level credit and needs its own serviceType and vatType.',
      'A reason is required: it appears on the invoice.',
    ],
  },
  input: {
    folioId: arg.folioId,
    reason: z.string().min(1).describe('Why the credit is being given. Printed on the invoice.'),
    amount: z.number().positive().describe('Gross amount to credit.'),
    chargeId: z.string().optional()
      .describe('Charge to credit against, from finance_get_folio. Strongly preferred - it keeps VAT correct.'),
    serviceType: z.enum(SERVICE_TYPES).optional().describe('Required only when chargeId is omitted.'),
    vatType: z.enum(VAT_TYPES).optional().describe('Required only when chargeId is omitted.'),
  },
  annotations: { destructive: true, idempotent: false },
  async handler(args: any) {
    const folio = await call<any>(
      { method: 'GET', path: `/finance/v1/folios/${encodeURIComponent(args.folioId)}` },
      { subject: `Folio '${args.folioId}'`, discoverWith: 'finance_find_folios' },
    );
    const body = {
      reason: args.reason,
      amount: { amount: args.amount, currency: folio.balance.currency },
      ...(args.chargeId ? {} : { serviceType: args.serviceType ?? 'Other', vatType: args.vatType ?? 'Normal' }),
    };
    const path = args.chargeId
      ? `/finance/v1/folio-actions/${encodeURIComponent(args.folioId)}/charges/${encodeURIComponent(args.chargeId)}/allowances`
      : `/finance/v1/folio-actions/${encodeURIComponent(args.folioId)}/allowances`;

    const created = await call<any>({ method: 'POST', path, body }, { subject: `Folio '${args.folioId}'` });
    const after = await call<any>({ method: 'GET', path: `/finance/v1/folios/${encodeURIComponent(args.folioId)}` });
    return {
      text: `Credited ${money({ amount: args.amount, currency: folio.balance.currency })} on ${args.folioId} `
        + `(${args.reason}) as ${created.id}. Balance is now ${money(after.balance)}.`,
      data: { allowanceId: created.id, folioId: args.folioId, balance: after.balance },
    };
  },
};

const postRefund = {
  name: 'finance_post_refund',
  title: 'Refund a payment',
  doc: {
    summary: 'Give money back that was previously taken.',
    use: ['Returning a deposit, or reversing an overpayment.'],
    avoid: [
      'Reducing an unpaid charge - use finance_post_allowance.',
      'Cancelling a pending card payment - that is a different operation.',
    ],
    returns: 'The refund id and the folio balance afterwards.',
    notes: [
      'With a paymentId the refund is capped at what remains on that payment.',
      'Refunding raises the folio balance back up: the guest owes that money again unless a credit is also posted.',
    ],
  },
  input: {
    folioId: arg.folioId,
    amount: z.number().positive().describe('Amount to return.'),
    paymentId: z.string().optional()
      .describe('Original payment to refund against, from finance_get_folio. Preferred - it bounds the amount.'),
    method: z.enum(PAYMENT_METHODS).optional().describe('How the money is returned. Defaults to the original method.'),
    reason: z.string().optional().describe('Why the refund was given.'),
    confirm: arg.confirm,
  },
  annotations: { destructive: true, idempotent: false, requiresConfirmation: true },
  async handler(args: any) {
    const folio = await call<any>(
      { method: 'GET', path: `/finance/v1/folios/${encodeURIComponent(args.folioId)}` },
      { subject: `Folio '${args.folioId}'`, discoverWith: 'finance_find_folios' },
    );
    requireConfirmation(
      args.confirm,
      `Refunding ${money({ amount: args.amount, currency: folio.balance.currency })} on ${args.folioId} `
      + 'returns money to the guest and cannot be undone.',
    );

    const body = {
      amount: { amount: args.amount, currency: folio.balance.currency },
      method: args.method ?? 'CreditCard',
      reason: args.reason,
    };
    const path = args.paymentId
      ? `/finance/v1/folios/${encodeURIComponent(args.folioId)}/payments/${encodeURIComponent(args.paymentId)}/refunds`
      : `/finance/v1/folios/${encodeURIComponent(args.folioId)}/refunds`;

    const created = await call<any>({ method: 'POST', path, body }, { subject: `Folio '${args.folioId}'` });
    const after = await call<any>({ method: 'GET', path: `/finance/v1/folios/${encodeURIComponent(args.folioId)}` });
    return {
      text: `Refunded ${money({ amount: args.amount, currency: folio.balance.currency })} on ${args.folioId} `
        + `as ${created.id}. Balance is now ${money(after.balance)}.`,
      data: { refundId: created.id, folioId: args.folioId, balance: after.balance },
    };
  },
};

/* -------------------------------------------------------------- invoices */

const createInvoice = {
  name: 'finance_create_invoice',
  title: 'Issue an invoice',
  doc: {
    summary: 'Issue an invoice over a folio, snapshotting its charges and closing it.',
    use: ['The guest or a company asks for an invoice for a settled or settling folio.'],
    avoid: [
      'Previewing what it would say - use finance_preview_invoice, which changes nothing.',
      'Correcting an issued invoice - use finance_cancel_invoice, which issues a reversal.',
    ],
    returns: 'The invoice number, total, VAT breakdown and payment status.',
    notes: [
      'The line items are copied, not referenced, so later folio changes cannot rewrite a document the guest holds.',
      'Issuing closes the folio. An unsettled balance becomes a receivable rather than blocking the document.',
      'A folio can carry only one live invoice.',
    ],
  },
  input: {
    folioId: arg.folioId,
    languageCode: z.string().length(2).default('en').describe('Language for the document text, e.g. "de".'),
  },
  annotations: { destructive: false, idempotent: false },
  async handler(args: any) {
    const created = await call<any>({
      method: 'POST',
      path: '/finance/v1/invoices',
      body: { folioId: args.folioId, languageCode: args.languageCode },
    }, { subject: `Folio '${args.folioId}'`, discoverWith: 'finance_find_folios' });

    const invoice = await call<any>({ method: 'GET', path: `/finance/v1/invoices/${encodeURIComponent(created.id)}` });
    return { text: renderInvoice(invoice), data: { invoiceId: invoice.id, number: invoice.number, total: invoice.total } };
  },
};

const previewInvoice = {
  name: 'finance_preview_invoice',
  title: 'Preview an invoice',
  doc: {
    summary: 'Show what an invoice over a folio would contain, without issuing anything.',
    use: [
      'Checking a bill with the guest before issuing it.',
      'Confirming the VAT split is right.',
    ],
    avoid: ['Actually issuing it - use finance_create_invoice.'],
    returns: 'The line items, totals and VAT breakdown the document would carry.',
    notes: ['Nothing is persisted and the folio stays open.'],
  },
  input: { folioId: arg.folioId },
  annotations: { readOnly: true },
  async handler(args: any) {
    const invoice = await call<any>(
      { method: 'GET', path: '/finance/v1/invoices/preview', query: { folioId: args.folioId } },
      { subject: `Folio '${args.folioId}'`, discoverWith: 'finance_find_folios' },
    );
    return { text: `PREVIEW ONLY - nothing issued.\n\n${renderInvoice(invoice)}`, data: { preview: true, invoice } };
  },
};

const findInvoices = {
  name: 'finance_find_invoices',
  title: 'Find invoices',
  doc: {
    summary: 'List issued invoices, filtered by status, recipient or folio.',
    use: [
      'Answering "which invoices are unpaid".',
      'Finding an invoice number for a guest or company.',
    ],
    avoid: ['Reading one in detail - use finance_get_invoice.'],
    returns: 'One row per invoice: number, type, recipient, date, status, total and outstanding amount.',
    notes: ['Cancellation documents appear alongside the invoices they reverse.'],
  },
  input: {
    propertyId: arg.optionalPropertyId,
    status: z.enum(['Unpaid', 'FullyPaid', 'WrittenOff']).optional(),
    recipient: z.string().optional().describe('Free text over the guest or company name.'),
    folioId: z.string().optional().describe('Only invoices raised over this folio.'),
    limit: arg.limit(25, 200),
  },
  annotations: { readOnly: true },
  async handler(args: any) {
    const property = await resolveProperty(args.propertyId);
    const { items, count } = await callList<any>({
      method: 'GET',
      path: '/finance/v1/invoices',
      query: {
        propertyIds: property.id,
        status: args.status,
        nameSearch: args.recipient,
        folioIds: args.folioId,
        pageSize: Math.min(args.limit, 200),
      },
    }, 'invoices');

    if (!items.length) return { text: `No invoices at ${property.name} match those filters.`, data: { count: 0, invoices: [] } };
    const { shown, note } = capped(items, count, args.limit);
    return {
      text: sections(
        `${count} invoice(s) at ${property.name}`,
        table(shown, [
          { header: 'id', value: (i: any) => i.id },
          { header: 'number', value: (i: any) => i.number },
          { header: 'type', value: (i: any) => i.type },
          { header: 'recipient', value: (i: any) => i.guestName ?? i.guestCompany ?? '' },
          { header: 'date', value: (i: any) => day(i.created) },
          { header: 'status', value: (i: any) => i.status },
          { header: 'total', value: (i: any) => money(i.subTotal), align: 'right' },
          { header: 'outstanding', value: (i: any) => money(i.outstandingPayment), align: 'right' },
        ]) + note,
      ),
      data: { count, invoices: shown },
    };
  },
};

const getInvoice = {
  name: 'finance_get_invoice',
  title: 'Read an invoice',
  doc: {
    summary: 'Read one invoice in full: line items, VAT breakdown and payment status.',
    use: ['Answering a question about a specific document.'],
    avoid: ['Scanning many - use finance_find_invoices.'],
    returns: 'The full document contents.',
    notes: ['The PDF is at GET /finance/v1/invoices/{id}/pdf on the HTTP API.'],
  },
  input: { invoiceId: z.string().describe('Invoice id from finance_find_invoices.') },
  annotations: { readOnly: true },
  async handler(args: any) {
    const invoice = await call<any>(
      { method: 'GET', path: `/finance/v1/invoices/${encodeURIComponent(args.invoiceId)}` },
      { subject: `Invoice '${args.invoiceId}'`, discoverWith: 'finance_find_invoices' },
    );
    return { text: renderInvoice(invoice), data: { invoice } };
  },
};

const cancelInvoice = {
  name: 'finance_cancel_invoice',
  title: 'Cancel an invoice',
  doc: {
    summary: 'Cancel an issued invoice by raising a cancellation document that reverses it.',
    use: ['The recipient, the amounts or the payment method on an issued invoice were wrong.'],
    avoid: ['A document not yet issued - preview instead of issuing.'],
    returns: 'The cancellation document number.',
    notes: [
      'The original is never deleted. A reversing document is issued, which is what tax law in '
      + 'apaleo\'s markets requires.',
      'A cancellation cannot itself be cancelled.',
    ],
  },
  input: {
    invoiceId: z.string().describe('Invoice id from finance_find_invoices.'),
    reasonCode: z.enum([
      'ChangeOfRecipientDetails', 'ChangeOfInvoiceRecipient',
      'ChangeOfPaymentMethod', 'ChangeOfInvoiceTransactions', 'Other',
    ]).describe('Why the invoice is being cancelled. Recorded on the reversing document.'),
    confirm: arg.confirm,
  },
  annotations: { destructive: true, idempotent: false, requiresConfirmation: true },
  async handler(args: any) {
    const invoice = await call<any>(
      { method: 'GET', path: `/finance/v1/invoices/${encodeURIComponent(args.invoiceId)}` },
      { subject: `Invoice '${args.invoiceId}'`, discoverWith: 'finance_find_invoices' },
    );
    requireConfirmation(
      args.confirm,
      `Cancelling invoice ${invoice.number} (${money(invoice.total)}) issues a permanent reversing document.`,
    );
    await callVoid({
      method: 'PUT',
      path: `/finance/v1/invoice-actions/${encodeURIComponent(args.invoiceId)}/cancel`,
      body: { reasonCode: args.reasonCode },
    }, { subject: `Invoice '${args.invoiceId}'` });
    return {
      text: `Invoice ${invoice.number} cancelled (${args.reasonCode}). A reversing document has been issued; `
        + 'find it with finance_find_invoices.',
      data: { invoiceId: args.invoiceId, number: invoice.number, reasonCode: args.reasonCode },
    };
  },
};

function renderInvoice(invoice: any): string {
  const items = invoice.lineItems?.lineItems ?? [];
  return sections(
    facts({
      number: invoice.number,
      type: invoice.type,
      status: invoice.status,
      date: invoice.invoiceDate,
      recipient: invoice.to?.name ?? invoice.to?.companyName,
      folio: invoice.folioId,
      total: money(invoice.total),
      outstanding: invoice.outstandingPayment?.amount ? money(invoice.outstandingPayment) : 'nil',
    }),
    items.length ? table(items, [
      { header: 'date', value: (i: any) => i.date },
      { header: 'description', value: (i: any) => i.description },
      { header: 'qty', value: (i: any) => String(i.quantity ?? 1), align: 'right' },
      { header: 'vat', value: (i: any) => `${i.vatPercent}%`, align: 'right' },
      { header: 'amount', value: (i: any) => money(i.price), align: 'right' },
    ]) : null,
    (invoice.taxDetails ?? []).length
      ? `VAT\n${table(invoice.taxDetails, [
        { header: 'rate', value: (t: any) => `${t.vatPercent}%`, align: 'right' },
        { header: 'net', value: (t: any) => money(t.net), align: 'right' },
        { header: 'tax', value: (t: any) => money(t.tax), align: 'right' },
      ])}`
      : null,
  );
}

/* ---------------------------------------------------------- the ledger */

const ledger = {
  name: 'finance_ledger',
  title: 'Read the sub-ledger',
  doc: {
    summary: 'Read the double-entry sub-ledger for a period, by account.',
    use: [
      'Reconciling revenue, VAT, payments or city tax for a date range.',
      'Checking the books balance before an export.',
      'Answering "how much came in by cash last week".',
    ],
    avoid: [
      'What a guest owes - use finance_get_folio.',
      'Occupancy or ADR - use insight_performance.',
    ],
    returns: 'Debit and credit totals per account, plus the overall balance, which must be zero.',
    notes: [
      'Every posting writes balanced entries, so a non-zero total is a bug, not a rounding artefact.',
      'Guest ledger accounts are prefixed G-, external folios E-.',
    ],
  },
  input: {
    propertyId: arg.optionalPropertyId,
    from: arg.optionalDate('Period start. Defaults to 30 days before the business date.'),
    to: arg.optionalDate('Period end, inclusive. Defaults to the business date.'),
    accountsOnly: z.boolean().default(true)
      .describe('Keep only numbered house accounts. Set false to include per-guest ledger accounts.'),
  },
  annotations: { readOnly: true },
  async handler(args: any) {
    const property = await resolveProperty(args.propertyId);
    const range = await window(property, args.from, args.to, 0);
    const from = args.from ?? addDays(range.to, -30);

    const result = await call<any>({
      method: 'POST',
      path: '/finance/v1/accounts/aggregate',
      query: { propertyId: property.id, from, to: range.to },
    });

    const rows = (result.aggregations ?? [])
      .filter((a: any) => !args.accountsOnly || /^\d/.test(a.account.number))
      .filter((a: any) => Math.abs(a.debitedAmount.amount) > 0.004 || Math.abs(a.creditedAmount.amount) > 0.004)
      .sort((a: any, b: any) => String(a.account.number).localeCompare(String(b.account.number)));

    const balanced = Math.abs(result.total.balance.amount) < 0.005;
    return {
      text: sections(
        `${property.name} · ${from} to ${range.to}`,
        rows.length ? table(rows, [
          { header: 'account', value: (a: any) => a.account.number },
          { header: 'name', value: (a: any) => a.account.name },
          { header: 'type', value: (a: any) => a.account.type },
          { header: 'debit', value: (a: any) => money(a.debitedAmount), align: 'right' },
          { header: 'credit', value: (a: any) => money(a.creditedAmount), align: 'right' },
        ]) : 'No postings in this period.',
        `Debits ${money(result.total.debitedAmount)} · credits ${money(result.total.creditedAmount)} · `
        + (balanced ? 'balanced.' : `OUT BY ${money(result.total.balance)} - this indicates a defect.`),
      ),
      data: { from, to: range.to, balanced, total: result.total, accounts: rows },
    };
  },
};

export function registerFinance(server: McpServer): void {
  for (const spec of [
    findFolios, getFolio, postCharge, postPayment, postAllowance, postRefund,
    previewInvoice, createInvoice, findInvoices, getInvoice, cancelInvoice, ledger,
  ]) {
    register(server, spec as never);
  }
}
