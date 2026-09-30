import { nextSeq, transact } from '../core/db';
import { nowIso } from '../core/dates';
import { money, round } from '../core/money';
import { resolveLocalized } from '../core/localized';
import { unprocessable } from '../core/errors';
import { db } from './repo';
import { closeFolio, folioTotals } from './folios';
import { ACCOUNTS, post } from './accounts';
import { logFolio } from './audit';
import type {
  CancellationReasonCode, Folio, Invoice, InvoiceLineItem, Property,
} from './types';

/**
 * Invoicing. An invoice is a *snapshot* of a folio at the moment it is
 * issued: the line items are copied, not referenced, so later corrections to
 * the folio cannot silently rewrite a document a guest already holds. That is
 * also why cancelling an invoice issues a cancellation document rather than
 * deleting the original.
 */

/**
 * Expand a number pattern like `MUC-{yyyy}-{00000}`. `{yyyy}`/`{yy}`/`{MM}`
 * come from the invoice date; a run of zeroes is a zero-padded counter that
 * restarts each year.
 */
export function formatInvoiceNumber(pattern: string, date: string, propertyId: string): string {
  const [year, month] = date.split('-');
  return pattern.replace(/\{([^}]+)\}/g, (_match, token: string) => {
    if (token === 'yyyy') return year!;
    if (token === 'yy') return year!.slice(2);
    if (token === 'MM') return month!;
    if (/^0+$/.test(token)) {
      const next = nextSeq(`invoice:${propertyId}:${year}`);
      return String(next).padStart(token.length, '0');
    }
    return token;
  });
}

function invoicePattern(propertyId: string): string {
  const features = db.featureSettings.all({ propertyId })[0];
  return features?.invoiceNumberPattern ?? `${propertyId}-{yyyy}-{00000}`;
}

/** Turn the folio's charges into invoice line items. */
export function lineItemsFor(folio: Folio, languageCode: string): InvoiceLineItem[] {
  const charges = db.charges.all({ folioId: folio.id })
    .sort((a, b) => a.serviceDate.localeCompare(b.serviceDate) || a.id.localeCompare(b.id));
  const allowances = db.allowances.all({ folioId: folio.id });
  const transitory = db.transitoryCharges.all({ folioId: folio.id });
  const reservation = folio.reservationId ? db.reservations.get(folio.reservationId) : undefined;
  const guestName = reservation?.primaryGuest
    ? [reservation.primaryGuest.firstName, reservation.primaryGuest.lastName].filter(Boolean).join(' ')
    : undefined;

  const items: InvoiceLineItem[] = charges.map((charge) => ({
    chargeId: charge.id,
    date: charge.serviceDate,
    description: resolveLocalized(charge.name, [languageCode]) ?? charge.id,
    price: money(charge.amount.grossAmount, charge.amount.currency),
    vatType: charge.amount.vatType,
    vatPercent: charge.amount.vatPercent,
    isNoShowFee: charge.serviceType === 'NoShow',
    quantity: charge.quantity,
    guest: guestName,
  }));

  for (const t of transitory) {
    items.push({
      date: t.serviceDate,
      description: resolveLocalized(t.name, [languageCode]) ?? t.id,
      price: money(t.amount.grossAmount, t.amount.currency),
      vatType: t.amount.vatType,
      vatPercent: t.amount.vatPercent,
      isNoShowFee: false,
      quantity: t.quantity,
      guest: guestName,
    });
  }

  // Allowances appear as negative lines so the document sums to the balance.
  for (const a of allowances) {
    items.push({
      date: a.serviceDate,
      description: a.reason
        ? `${resolveLocalized(a.name, [languageCode]) ?? 'Allowance'} - ${a.reason}`
        : resolveLocalized(a.name, [languageCode]) ?? 'Allowance',
      price: money(-a.amount.grossAmount, a.amount.currency),
      vatType: a.amount.vatType,
      vatPercent: a.amount.vatPercent,
      isNoShowFee: false,
      quantity: 1,
      guest: guestName,
    });
  }

  return items.sort((a, b) => a.date.localeCompare(b.date));
}

export interface CreateInvoiceInput {
  folio: Folio;
  property: Property;
  languageCode: string;
  type?: Invoice['type'];
  relatedInvoiceNumber?: string;
}

export function createInvoice(input: CreateInvoiceInput): Invoice {
  const { folio, property } = input;
  const existing = db.invoices.all({ folioId: folio.id })
    .filter((i) => i.type === 'Initial' && !isCancelled(i));
  if (existing.length && (input.type ?? 'Initial') === 'Initial') {
    throw unprocessable(`Folio '${folio.id}' already has invoice '${existing[0]!.number}'.`);
  }

  const lineItems = lineItemsFor(folio, input.languageCode);
  if (!lineItems.length && (input.type ?? 'Initial') === 'Initial') {
    throw unprocessable(`Folio '${folio.id}' has nothing to invoice.`);
  }

  const total = round(lineItems.reduce((s, i) => s + i.price.amount, 0), folio.currency);
  const netTotal = round(
    lineItems.reduce((s, i) => s + i.price.amount / (1 + i.vatPercent / 100), 0),
    folio.currency,
  );
  const payments = db.payments.all({ folioId: folio.id }).filter((p) => p.status === 'Success');
  const refunds = db.refunds.all({ folioId: folio.id }).filter((r) => r.status === 'Success');
  const paidAmount = round(
    payments.reduce((s, p) => s + p.amount.amount, 0) - refunds.reduce((s, r) => s + r.amount.amount, 0),
    folio.currency,
  );

  const reservation = folio.reservationId ? db.reservations.get(folio.reservationId) : undefined;
  const invoiceDate = property.businessDate;

  const invoice: Invoice = {
    id: `${property.id}-INV-${nextSeq(`invoiceId:${property.id}`)}`,
    propertyId: property.id,
    number: formatInvoiceNumber(invoicePattern(property.id), invoiceDate, property.id),
    type: input.type ?? 'Initial',
    status: paidAmount >= total - 1e-9 ? 'FullyPaid' : 'Unpaid',
    created: nowIso(),
    invoiceDate,
    folioId: folio.id,
    reservationId: folio.reservationId,
    bookingId: folio.bookingId,
    companyId: folio.companyId,
    languageCode: input.languageCode,
    recipient: folio.debitor,
    currency: folio.currency,
    lineItems,
    total,
    netTotal,
    paidAmount,
    paymentSettled: paidAmount >= total - 1e-9,
    paymentIds: payments.map((p) => p.id),
    relatedInvoiceNumber: input.relatedInvoiceNumber,
    paymentTerms: resolveLocalized(property.paymentTerms, [input.languageCode]),
    stayInfo: reservation
      ? {
        guestName: [reservation.primaryGuest?.firstName, reservation.primaryGuest?.lastName]
          .filter(Boolean).join(' ') || reservation.id,
        arrivalDate: reservation.arrivalDate,
        departureDate: reservation.departureDate,
        reservationId: reservation.id,
        roomNumber: reservation.unitId ? db.units.get(reservation.unitId)?.name : undefined,
      }
      : undefined,
  };

  db.invoices.put(invoice);
  folio.invoiceId = invoice.id;
  folio.invoiceIds.push(invoice.id);
  if (!folio.isClosed) {
    // Issuing an invoice closes the folio; an unsettled balance becomes a
    // receivable rather than blocking the document.
    const balance = folioTotals(folio).balance.amount;
    if (Math.abs(balance) > 1e-9) {
      folio.checkedOutOnAccountsReceivable = true;
      post(
        {
          propertyId: property.id,
          date: invoiceDate,
          command: 'PostToAccountsReceivables',
          reference: folio.reservationId ?? folio.id,
          referenceType: folio.reservationId ? 'Guest' : 'External',
        },
        [{
          debitedAccount: ACCOUNTS.accountsReceivable,
          creditedAccount: folio.reservationId ? `G-${folio.reservationId}` : `E-${folio.id}`,
          amount: money(balance, folio.currency),
          receipt: invoice.number,
        }],
      );
    }
    closeFolio(folio, { allowOpenBalance: true });
  } else {
    db.folios.put(folio);
  }

  logFolio(folio.id, {
    propertyId: property.id,
    action: 'InvoiceCreated',
    message: `Invoice ${invoice.number} created over folio ${folio.id}.`,
    relatedEntityId: invoice.id,
    amount: money(total, folio.currency),
    serviceDate: invoiceDate,
  });
  return invoice;
}

export function isCancelled(invoice: Invoice): boolean {
  return db.invoices
    .all({ propertyId: invoice.propertyId })
    .some((i) => i.type === 'Cancellation' && i.relatedInvoiceNumber === invoice.number);
}

/**
 * Cancel an invoice by issuing a cancellation document that mirrors it with
 * the signs flipped. The original stays on file, which is what tax law in
 * most of apaleo's markets requires.
 */
export function cancelInvoice(invoice: Invoice, reasonCode: CancellationReasonCode): Invoice {
  if (isCancelled(invoice)) throw unprocessable(`Invoice '${invoice.number}' has already been cancelled.`);
  if (invoice.type === 'Cancellation') throw unprocessable('A cancellation document cannot itself be cancelled.');
  const property = db.properties.get(invoice.propertyId);
  if (!property) throw unprocessable(`Property '${invoice.propertyId}' does not exist.`);

  return transact(() => {
    const cancellation: Invoice = {
      ...structuredClone(invoice),
      id: `${property.id}-INV-${nextSeq(`invoiceId:${property.id}`)}`,
      number: formatInvoiceNumber(invoicePattern(property.id), property.businessDate, property.id),
      type: 'Cancellation',
      created: nowIso(),
      invoiceDate: property.businessDate,
      lineItems: invoice.lineItems.map((i) => ({
        ...i,
        price: money(-i.price.amount, i.price.currency),
      })),
      total: round(-invoice.total, invoice.currency),
      netTotal: round(-invoice.netTotal, invoice.currency),
      paidAmount: 0,
      paymentSettled: true,
      status: 'FullyPaid',
      relatedInvoiceNumber: invoice.number,
      cancellationReasonCode: reasonCode,
    };
    db.invoices.put(cancellation);

    const folio = db.folios.get(invoice.folioId);
    if (folio) {
      folio.invoiceIds.push(cancellation.id);
      folio.invoiceId = undefined;
      db.folios.put(folio);
      logFolio(folio.id, {
        propertyId: property.id,
        action: 'InvoiceCanceled',
        message: `Invoice ${invoice.number} cancelled by ${cancellation.number} (${reasonCode}).`,
        relatedEntityId: cancellation.id,
        amount: money(cancellation.total, invoice.currency),
        serviceDate: cancellation.invoiceDate,
      });
    }
    return cancellation;
  });
}

/** Record a payment against an issued invoice. */
export function payInvoice(invoice: Invoice, paymentMethod: string, receipt: string): Invoice {
  if (invoice.status === 'FullyPaid') throw unprocessable(`Invoice '${invoice.number}' is already fully paid.`);
  if (isCancelled(invoice)) throw unprocessable(`Invoice '${invoice.number}' has been cancelled.`);
  const property = db.properties.get(invoice.propertyId);
  if (!property) throw unprocessable(`Property '${invoice.propertyId}' does not exist.`);

  const outstanding = round(invoice.total - invoice.paidAmount, invoice.currency);
  invoice.paidAmount = invoice.total;
  invoice.paymentSettled = true;
  invoice.status = 'FullyPaid';
  db.invoices.put(invoice);

  // Settling an AR invoice clears the receivable.
  post(
    {
      propertyId: property.id,
      date: property.businessDate,
      command: 'PostPayment',
      reference: invoice.reservationId ?? invoice.folioId,
      referenceType: invoice.reservationId ? 'Guest' : 'External',
    },
    [{
      debitedAccount: paymentAccountFor(paymentMethod),
      creditedAccount: ACCOUNTS.accountsReceivable,
      amount: money(outstanding, invoice.currency),
      receipt,
    }],
  );

  logFolio(invoice.folioId, {
    propertyId: property.id,
    action: 'InvoicePaid',
    message: `Invoice ${invoice.number} paid by ${paymentMethod}.`,
    relatedEntityId: invoice.id,
    amount: money(outstanding, invoice.currency),
    serviceDate: property.businessDate,
  });
  return invoice;
}

function paymentAccountFor(method: string): string {
  switch (method) {
    case 'Cash': return ACCOUNTS.cash;
    case 'BankTransfer': return ACCOUNTS.bankTransfer;
    default: return ACCOUNTS.creditCard;
  }
}

/** Outstanding amount on an invoice. */
export function outstandingOf(invoice: Invoice): number {
  return round(invoice.total - invoice.paidAmount, invoice.currency);
}

