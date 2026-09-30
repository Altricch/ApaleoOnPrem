import { nowIso } from '../core/dates';
import { chargeId as mintChargeId, folioId as mintFolioId, type ChargeKind } from '../core/ids';
import { grossToAmount, money, round, type AmountModel, type MonetaryValue } from '../core/money';
import { resolveLocalized } from '../core/localized';
import { unprocessable } from '../core/errors';
import { nextSeq } from '../core/db';
import { db } from './repo';
import {
  ACCOUNTS, accountForPaymentMethod, accountForServiceType, ensureExternalAccount,
  ensureGuestAccount, postCharge, postPayment, postTransfer,
} from './accounts';
import { logFolio } from './audit';
import type {
  Allowance, Charge, ChargeType, Debitor, Folio, Payment, PaymentMethod, Reservation, ServiceType, TransitoryCharge,
} from './types';

/**
 * Folios are the guest's running account. A reservation gets one main folio at
 * creation; extra folios can be opened to split a bill (a company paying the
 * room while the guest pays extras, for instance).
 *
 * Every posting here does two things: it appends to the folio, and it writes
 * balanced entries into the sub-ledger. Keeping those together is what makes
 * the Finance API's exports reconcile against the folio balances.
 */

export interface OpenFolioOptions {
  reservationId?: string;
  bookingId?: string;
  companyId?: string;
  type?: Folio['type'];
  debitor?: Debitor;
  isMainFolio?: boolean;
}

export function openFolio(propertyId: string, options: OpenFolioOptions = {}): Folio {
  const property = db.properties.get(propertyId);
  if (!property) throw unprocessable(`Property '${propertyId}' does not exist.`);

  const reservation = options.reservationId ? db.reservations.get(options.reservationId) : undefined;
  const owner = reservation?.id ?? options.bookingId ?? `${propertyId}-F`;
  const ordinal = reservation
    ? reservation.nextFolioOrdinal
    : nextSeq(`folio:${propertyId}`);
  const id = mintFolioId(owner, ordinal);

  if (reservation) {
    reservation.nextFolioOrdinal += 1;
    db.reservations.put(reservation);
  }

  const folio: Folio = {
    id,
    propertyId,
    reservationId: options.reservationId,
    bookingId: options.bookingId ?? reservation?.bookingId,
    companyId: options.companyId,
    type: options.type ?? (options.companyId ? 'Booking' : 'Guest'),
    created: nowIso(),
    updated: nowIso(),
    debitor: options.debitor ?? debitorFromReservation(reservation),
    isMainFolio: options.isMainFolio ?? (!!reservation && reservation.nextFolioOrdinal === 2),
    isClosed: false,
    checkedOutOnAccountsReceivable: false,
    currency: property.currencyCode,
    nextChargeOrdinal: 1,
    nextPaymentOrdinal: 1,
    invoiceIds: [],
    warnings: [],
  };
  db.folios.put(folio);

  if (reservation) {
    ensureGuestAccount(propertyId, reservation.id, guestName(reservation));
  } else {
    ensureExternalAccount(propertyId, folio.id, folio.debitor.name ?? folio.id);
  }

  logFolio(folio.id, {
    propertyId,
    action: 'Created',
    message: `Folio ${folio.id} opened${reservation ? ` for reservation ${reservation.id}` : ''}.`,
  });
  return folio;
}

function debitorFromReservation(r: Reservation | undefined): Debitor {
  if (!r) return {};
  const g = r.primaryGuest;
  return {
    type: 'PrimaryGuest',
    title: g?.title,
    firstName: g?.firstName,
    name: g?.lastName,
    email: g?.email,
    phone: g?.phone,
    address: g?.address,
    personalTaxId: g?.personalTaxId,
    company: g?.company?.name ? { name: g.company.name, taxId: g.company.taxId } : undefined,
  };
}

function guestName(r: Reservation): string {
  const g = r.primaryGuest;
  return [g?.firstName, g?.lastName].filter(Boolean).join(' ') || r.id;
}

/** The account a folio's postings run through. */
export function ledgerAccountOf(folio: Folio): string {
  if (folio.reservationId) {
    const r = db.reservations.get(folio.reservationId);
    return ensureGuestAccount(folio.propertyId, folio.reservationId, r ? guestName(r) : folio.reservationId);
  }
  if (folio.companyId) return ACCOUNTS.accountsReceivable;
  return ensureExternalAccount(folio.propertyId, folio.id, folio.debitor.name ?? folio.id);
}

export function mainFolioOf(reservationId: string): Folio | undefined {
  const folios = db.folios.all({ reservationId });
  return folios.find((f) => f.isMainFolio) ?? folios[0];
}

/** Open the main folio for a reservation if it does not have one yet. */
export function ensureMainFolio(reservation: Reservation): Folio {
  const existing = mainFolioOf(reservation.id);
  if (existing) return existing;
  const folio = openFolio(reservation.propertyId, {
    reservationId: reservation.id,
    bookingId: reservation.bookingId,
  });
  folio.isMainFolio = true;
  db.folios.put(folio);
  return folio;
}

/* ---------------------------------------------------------------- charges */

export interface PostChargeInput {
  serviceType: ServiceType;
  /** How the charge arose, which the folio view reports as `type`. */
  chargeType?: ChargeType;
  serviceId?: string;
  subAccountId?: string;
  name: string;
  amount: AmountModel;
  quantity?: number;
  serviceDate: string;
  receipt?: string;
  reservationId?: string;
  kind?: ChargeKind;
  /** Skip the sub-ledger posting, used when replaying an existing charge. */
  skipAccounting?: boolean;
}

export function postFolioCharge(folio: Folio, input: PostChargeInput): Charge {
  assertOpen(folio);
  const ordinal = folio.nextChargeOrdinal;
  folio.nextChargeOrdinal += 1;

  // Resolve the revenue account once and store it on the charge, so the
  // charge, the ledger entry and the revenue report all agree on where the
  // money landed.
  const subAccountId = input.subAccountId ?? accountForServiceType(input.serviceType);

  const charge: Charge = {
    id: mintChargeId(folio.id, input.kind ?? 'MA', ordinal),
    folioId: folio.id,
    propertyId: folio.propertyId,
    reservationId: input.reservationId ?? folio.reservationId,
    serviceType: input.serviceType,
    type: input.chargeType ?? chargeTypeFor(input.kind),
    serviceId: input.serviceId,
    subAccountId,
    name: { en: input.name },
    amount: input.amount,
    quantity: input.quantity ?? 1,
    created: nowIso(),
    serviceDate: input.serviceDate,
    receipt: input.receipt ?? nextReceipt(folio.propertyId),
    isPosted: true,
    allowanceIds: [],
  };
  db.charges.put(charge);
  folio.updated = nowIso();
  db.folios.put(folio);

  if (!input.skipAccounting) {
    postCharge(
      {
        propertyId: folio.propertyId,
        date: input.serviceDate,
        reference: folio.reservationId ?? folio.id,
        referenceType: folio.reservationId ? 'Guest' : 'External',
      },
      {
        guestAccount: ledgerAccountOf(folio),
        revenueAccount: subAccountId,
        grossAmount: charge.amount.grossAmount,
        netAmount: charge.amount.netAmount,
        currency: charge.amount.currency,
        receipt: charge.receipt,
      },
    );
  }

  logFolio(folio.id, {
    propertyId: folio.propertyId,
    action: 'ChargePosted',
    message: `${input.name}: ${charge.amount.grossAmount.toFixed(2)} ${charge.amount.currency}`,
    relatedEntityId: charge.id,
    amount: money(charge.amount.grossAmount, charge.amount.currency),
    serviceDate: charge.serviceDate,
  });
  return charge;
}

/** Map the id-kind marker onto the documented charge type. */
function chargeTypeFor(kind: ChargeKind | undefined): ChargeType {
  switch (kind) {
    case 'TS': return 'TimeSlice';
    case 'ES': return 'ExtraService';
    case 'CT': return 'CityTax';
    case 'CF': return 'CancellationFee';
    case 'NF': return 'NoShowFee';
    default: return 'Direct';
  }
}

function nextReceipt(propertyId: string): string {
  return String(nextSeq(`receipt:${propertyId}`)).padStart(8, '0');
}

function assertOpen(folio: Folio): void {
  if (folio.isClosed) throw unprocessable(`Folio '${folio.id}' is closed.`);
}

/* --------------------------------------------------------------- payments */

export interface PostPaymentInput {
  method: string;
  amount: MonetaryValue;
  businessDate: string;
  receipt?: string;
  settlementDate?: string;
  status?: Payment['status'];
  externalReference?: Payment['externalReference'];
  sourcePaymentId?: string;
  paidChargeIds?: string[];
  paymentLinkUrl?: string;
  terminalId?: string;
  expiresAt?: string;
}

export function postFolioPayment(folio: Folio, input: PostPaymentInput): Payment {
  assertOpen(folio);
  const ordinal = folio.nextPaymentOrdinal;
  folio.nextPaymentOrdinal += 1;

  const payment: Payment = {
    id: `${folio.id}-P-${ordinal}`,
    folioId: folio.id,
    propertyId: folio.propertyId,
    method: input.method as PaymentMethod,
    amount: input.amount,
    created: nowIso(),
    paymentDate: nowIso(),
    businessDate: input.businessDate,
    settlementDate: input.settlementDate,
    receipt: input.receipt ?? nextReceipt(folio.propertyId),
    status: input.status ?? 'Success',
    externalReference: input.externalReference,
    sourcePaymentId: input.sourcePaymentId,
    paidChargeIds: input.paidChargeIds ?? [],
    paymentLinkUrl: input.paymentLinkUrl,
    terminalId: input.terminalId,
    expiresAt: input.expiresAt,
  };
  db.payments.put(payment);
  folio.updated = nowIso();
  db.folios.put(folio);

  // Only a settled payment moves money in the ledger.
  if (payment.status !== 'Success') {
    logFolio(folio.id, {
      propertyId: folio.propertyId,
      action: 'PaymentAdded',
      message: `${input.method} payment of ${payment.amount.amount.toFixed(2)} ${payment.amount.currency} is pending.`,
      relatedEntityId: payment.id,
      amount: payment.amount,
      serviceDate: payment.businessDate,
    });
    return payment;
  }

  postPayment(
    {
      propertyId: folio.propertyId,
      date: input.businessDate,
      reference: folio.reservationId ?? folio.id,
      referenceType: folio.reservationId ? 'Guest' : 'External',
    },
    {
      guestAccount: ledgerAccountOf(folio),
      paymentAccount: accountForPaymentMethod(input.method),
      amount: payment.amount.amount,
      currency: payment.amount.currency,
      receipt: payment.receipt,
    },
  );

  logFolio(folio.id, {
    propertyId: folio.propertyId,
    action: 'PaymentPosted',
    message: `${input.method}: ${payment.amount.amount.toFixed(2)} ${payment.amount.currency}`,
    relatedEntityId: payment.id,
    amount: payment.amount,
    serviceDate: payment.businessDate,
  });
  return payment;
}

/* ------------------------------------------------------------- allowances */

export interface PostAllowanceInput {
  chargeId?: string;
  amount: MonetaryValue;
  reason: string;
  serviceDate?: string;
  name?: string;
  subAccountId?: string;
  serviceType?: ServiceType;
  vatType?: Charge['amount']['vatType'];
}

/**
 * An allowance reverses part or all of a charge. It is posted as its own line
 * rather than by editing the charge, so the original stays auditable.
 */
export function postAllowance(folio: Folio, input: PostAllowanceInput): Allowance {
  assertOpen(folio);
  const charge = input.chargeId ? db.charges.get(input.chargeId) : undefined;
  if (input.chargeId && !charge) throw unprocessable(`Charge '${input.chargeId}' does not exist.`);
  if (charge && charge.folioId !== folio.id) {
    throw unprocessable(`Charge '${input.chargeId}' does not belong to folio '${folio.id}'.`);
  }
  if (charge) {
    const alreadyAllowed = db.allowances.all({ folioId: folio.id })
      .filter((a) => a.chargeId === charge.id)
      .reduce((s, a) => s + a.amount.grossAmount, 0);
    const remaining = round(charge.amount.grossAmount - alreadyAllowed, folio.currency);
    if (input.amount.amount > remaining + 1e-9) {
      throw unprocessable(
        `The allowance (${input.amount.amount}) exceeds the ${remaining} still open on charge '${charge.id}'.`,
      );
    }
  }

  const ordinal = nextSeq(`allowance:${folio.id}`);
  const amount = grossToAmount(
    input.amount.amount,
    input.vatType ?? charge?.amount.vatType ?? 'Normal',
    folio.currency,
  );

  const allowance: Allowance = {
    id: `${folio.id}-A-${ordinal}`,
    folioId: folio.id,
    propertyId: folio.propertyId,
    chargeId: charge?.id,
    amount,
    reason: input.reason,
    created: nowIso(),
    serviceDate: input.serviceDate ?? charge?.serviceDate ?? businessDateOf(folio.propertyId),
    serviceType: input.serviceType ?? charge?.serviceType ?? 'Other',
    name: { en: input.name ?? (charge ? `Allowance for ${resolveLocalized(charge.name, ['en'])}` : 'Allowance') },
    subAccountId: input.subAccountId ?? charge?.subAccountId,
  };
  db.allowances.put(allowance);

  if (charge) {
    charge.allowanceIds.push(allowance.id);
    db.charges.put(charge);
  }

  // An allowance is a charge with the sign flipped: revenue is debited back.
  postCharge(
    {
      propertyId: folio.propertyId,
      date: allowance.serviceDate,
      reference: folio.reservationId ?? folio.id,
      referenceType: folio.reservationId ? 'Guest' : 'External',
    },
    {
      guestAccount: ledgerAccountOf(folio),
      revenueAccount: allowance.subAccountId ?? accountForServiceType(charge?.serviceType ?? 'Other'),
      grossAmount: -allowance.amount.grossAmount,
      netAmount: -allowance.amount.netAmount,
      currency: folio.currency,
    },
  );

  folio.updated = nowIso();
  db.folios.put(folio);
  logFolio(folio.id, {
    propertyId: folio.propertyId,
    action: 'AllowancePosted',
    message: `Allowance ${allowance.amount.grossAmount.toFixed(2)} ${folio.currency}${input.reason ? ` (${input.reason})` : ''}`,
    relatedEntityId: allowance.id,
    amount: money(allowance.amount.grossAmount, folio.currency),
    serviceDate: allowance.serviceDate,
  });
  return allowance;
}

function businessDateOf(propertyId: string): string {
  return db.properties.get(propertyId)?.businessDate ?? nowIso().slice(0, 10);
}

/* ---------------------------------------------------- transitory charges */

/**
 * A transitory charge is money collected on someone else's behalf (a theatre
 * ticket, say). It hits the transitory account rather than revenue.
 */
export function postTransitoryCharge(
  folio: Folio,
  input: {
    name: string; amount: AmountModel; quantity?: number; serviceDate?: string;
    subAccountId?: string; serviceType?: ServiceType; receipt?: string;
  },
): TransitoryCharge {
  assertOpen(folio);
  const ordinal = nextSeq(`transitory:${folio.id}`);
  const charge: TransitoryCharge = {
    id: `${folio.id}-T-${ordinal}`,
    folioId: folio.id,
    propertyId: folio.propertyId,
    name: { en: input.name },
    amount: input.amount,
    serviceType: input.serviceType ?? 'Other',
    quantity: input.quantity ?? 1,
    created: nowIso(),
    serviceDate: input.serviceDate ?? businessDateOf(folio.propertyId),
    subAccountId: input.subAccountId ?? ACCOUNTS.transitory,
    receipt: input.receipt ?? nextReceipt(folio.propertyId),
  };
  db.transitoryCharges.put(charge);

  postCharge(
    {
      propertyId: folio.propertyId,
      date: charge.serviceDate,
      reference: folio.reservationId ?? folio.id,
      referenceType: folio.reservationId ? 'Guest' : 'External',
    },
    {
      guestAccount: ledgerAccountOf(folio),
      revenueAccount: charge.subAccountId!,
      grossAmount: charge.amount.grossAmount,
      netAmount: charge.amount.netAmount,
      currency: folio.currency,
    },
  );

  folio.updated = nowIso();
  db.folios.put(folio);
  return charge;
}

/* --------------------------------------------------------------- moving */

/** Move charges between folios, keeping the sub-ledger in step. */
export function moveCharges(
  source: Folio,
  target: Folio,
  chargeIds: readonly string[],
  reason?: string,
): Charge[] {
  assertOpen(target);
  if (source.propertyId !== target.propertyId) {
    throw unprocessable('Charges can only be moved between folios of the same property.');
  }
  const moved: Charge[] = [];
  for (const id of chargeIds) {
    const charge = db.charges.get(id);
    if (!charge) throw unprocessable(`Charge '${id}' does not exist.`);
    if (charge.folioId !== source.id) {
      throw unprocessable(`Charge '${id}' is not on folio '${source.id}'.`);
    }
    charge.movedFromFolioId = source.id;
    charge.movedToFolioId = target.id;
    charge.movedReason = reason;
    charge.folioId = target.id;
    db.charges.put(charge);
    moved.push(charge);

    postTransfer(
      {
        propertyId: source.propertyId,
        date: charge.serviceDate,
        reference: target.reservationId ?? target.id,
        referenceType: target.reservationId ? 'Guest' : 'External',
      },
      {
        fromAccount: ledgerAccountOf(source),
        toAccount: ledgerAccountOf(target),
        amount: charge.amount.grossAmount,
        currency: charge.amount.currency,
        receipt: charge.receipt,
      },
    );
  }
  touch(source, target);
  logFolio(source.id, {
    propertyId: source.propertyId,
    action: 'ChargeMovedFromFolio',
    message: `${moved.length} charge(s) moved to folio ${target.id}.`,
  });
  return moved;
}

export function movePayments(
  source: Folio,
  target: Folio,
  paymentIds: readonly string[],
  reason?: string,
): Payment[] {
  assertOpen(target);
  const moved: Payment[] = [];
  for (const id of paymentIds) {
    const payment = db.payments.get(id);
    if (!payment) throw unprocessable(`Payment '${id}' does not exist.`);
    if (payment.folioId !== source.id) {
      throw unprocessable(`Payment '${id}' is not on folio '${source.id}'.`);
    }
    payment.movedFromFolioId = source.id;
    payment.movedToFolioId = target.id;
    payment.movedReason = reason;
    payment.folioId = target.id;
    db.payments.put(payment);
    moved.push(payment);

    postTransfer(
      {
        propertyId: source.propertyId,
        date: payment.businessDate,
        reference: target.reservationId ?? target.id,
        referenceType: target.reservationId ? 'Guest' : 'External',
      },
      {
        fromAccount: ledgerAccountOf(target),
        toAccount: ledgerAccountOf(source),
        amount: payment.amount.amount,
        currency: payment.amount.currency,
        receipt: payment.receipt,
      },
    );
  }
  touch(source, target);
  return moved;
}

function touch(...folios: Folio[]): void {
  for (const f of folios) {
    f.updated = nowIso();
    db.folios.put(f);
  }
}

/** Split a charge into two, so part of it can be moved or allowed separately. */
export function splitCharge(charge: Charge, amount: number): Charge {
  const folio = db.folios.get(charge.folioId);
  if (!folio) throw unprocessable(`Folio '${charge.folioId}' does not exist.`);
  if (amount <= 0 || amount >= charge.amount.grossAmount) {
    throw unprocessable(`The split amount must be between 0 and ${charge.amount.grossAmount}.`);
  }
  const currency = charge.amount.currency;
  const remainder = round(charge.amount.grossAmount - amount, currency);

  const ordinal = folio.nextChargeOrdinal;
  folio.nextChargeOrdinal += 1;
  const created: Charge = {
    ...structuredClone(charge),
    id: mintChargeId(folio.id, 'MA', ordinal),
    type: charge.type,
    amount: grossToAmount(amount, charge.amount.vatType, currency),
    sourceChargeId: charge.id,
    allowanceIds: [],
    created: nowIso(),
  };
  charge.amount = grossToAmount(remainder, charge.amount.vatType, currency);

  db.charges.put(charge);
  db.charges.put(created);
  touch(folio);
  return created;
}

export function splitPayment(payment: Payment, amount: number): Payment {
  const folio = db.folios.get(payment.folioId);
  if (!folio) throw unprocessable(`Folio '${payment.folioId}' does not exist.`);
  if (amount <= 0 || amount >= payment.amount.amount) {
    throw unprocessable(`The split amount must be between 0 and ${payment.amount.amount}.`);
  }
  const currency = payment.amount.currency;
  const ordinal = folio.nextPaymentOrdinal;
  folio.nextPaymentOrdinal += 1;
  const created: Payment = {
    ...structuredClone(payment),
    id: `${folio.id}-P-${ordinal}`,
    amount: money(amount, currency),
    created: nowIso(),
  };
  payment.amount = money(payment.amount.amount - amount, currency);
  db.payments.put(payment);
  db.payments.put(created);
  touch(folio);
  return created;
}

/* --------------------------------------------------------------- balance */

export interface FolioTotals {
  charges: MonetaryValue;
  allowances: MonetaryValue;
  payments: MonetaryValue;
  refunds: MonetaryValue;
  balance: MonetaryValue;
  transitory: MonetaryValue;
}

/**
 * What the guest still owes:
 *
 *   charges + transitory items - allowances - settled payments + refunds
 *
 * Pending payments (a card terminal that has not confirmed, an unopened
 * payment link) are excluded: the money is not there yet.
 */
export function folioTotals(folio: Folio): FolioTotals {
  const currency = folio.currency;
  const charges = db.charges.all({ folioId: folio.id }).reduce((s, c) => s + c.amount.grossAmount, 0);
  const allowances = db.allowances.all({ folioId: folio.id }).reduce((s, a) => s + a.amount.grossAmount, 0);
  const payments = db.payments
    .all({ folioId: folio.id })
    .filter((p) => p.status === 'Success')
    .reduce((s, p) => s + p.amount.amount, 0);
  const refunds = db.refunds
    .all({ folioId: folio.id })
    .filter((r) => r.status === 'Success')
    .reduce((s, r) => s + r.amount.amount, 0);
  const transitory = db.transitoryCharges.all({ folioId: folio.id }).reduce((s, t) => s + t.amount.grossAmount, 0);
  return {
    charges: money(charges, currency),
    allowances: money(allowances, currency),
    payments: money(payments, currency),
    refunds: money(refunds, currency),
    transitory: money(transitory, currency),
    balance: money(charges + transitory - allowances - payments + refunds, currency),
  };
}

/** Close a folio. A non-zero balance has to be settled or routed away first. */
export function closeFolio(folio: Folio, options: { allowOpenBalance?: boolean } = {}): Folio {
  if (folio.isClosed) throw unprocessable(`Folio '${folio.id}' is already closed.`);
  const totals = folioTotals(folio);
  if (!options.allowOpenBalance && Math.abs(totals.balance.amount) > 1e-9) {
    throw unprocessable(
      `Folio '${folio.id}' has an open balance of ${totals.balance.amount.toFixed(2)} ${folio.currency}.`,
    );
  }
  folio.isClosed = true;
  folio.closedAt = nowIso();
  folio.updated = folio.closedAt;
  db.folios.put(folio);
  logFolio(folio.id, {
    propertyId: folio.propertyId,
    action: 'Closed',
    message: `Folio ${folio.id} closed.`,
  });
  return folio;
}

export function reopenFolio(folio: Folio): Folio {
  if (!folio.isClosed) throw unprocessable(`Folio '${folio.id}' is not closed.`);
  if (folio.invoiceId) {
    throw unprocessable(`Folio '${folio.id}' has invoice '${folio.invoiceId}' and cannot be reopened.`);
  }
  folio.isClosed = false;
  folio.closedAt = undefined;
  folio.updated = nowIso();
  db.folios.put(folio);
  logFolio(folio.id, {
    propertyId: folio.propertyId,
    action: 'Reopened',
    message: `Folio ${folio.id} reopened.`,
  });
  return folio;
}
