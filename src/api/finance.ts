import type { Request, Response } from 'express';
import { ApiBuilder } from '../core/router';
import {
  arrayParam, boolParam, dateParam, paging, requiredDateParam,
  requiredStringParam, sendCreated, sendList, sendNoContent, stringParam,
} from '../core/http';
import { notFound, unprocessable } from '../core/errors';
import { applyPatch, rejectImmutablePaths, type PatchOperation } from '../core/patch';
import { resolveLocalized } from '../core/localized';
import { datesInclusive, nowIso } from '../core/dates';
import { grossToAmount, money, round, type MonetaryValue } from '../core/money';
import { nextSeq, transact } from '../core/db';
import {
  db, embeddedCompany, embeddedProperty, languagesOf, folio as getFolio,
  invoice as getInvoice, property as getProperty, reservation as getReservation,
} from '../domain/repo';
import {
  closeFolio, folioTotals, moveCharges, movePayments, openFolio, postAllowance,
  postFolioCharge, postFolioPayment, postTransitoryCharge, reopenFolio, splitCharge, splitPayment,
} from '../domain/folios';
import { applyRoutings, routeCharge } from '../domain/routing';
import { cancelInvoice, createInvoice, isCancelled, lineItemsFor, outstandingOf, payInvoice } from '../domain/invoicing';
import { ACCOUNTS, accountForPaymentMethod, post } from '../domain/accounts';
import { logFolio } from '../domain/audit';
import { CURRENCY_CODES, PAYMENT_METHODS, SERVICE_TYPES, VAT_TYPES } from '../domain/reference';
import { DEFAULT_VAT_RATES } from '../core/money';
import type {
  Allowance, Charge, Folio, Invoice, Payment, Refund, Routing, TransitoryCharge,
} from '../domain/types';

/**
 * Finance API - folios, charges, payments, refunds, invoices, charge routing
 * and the accounting sub-ledger those all feed.
 */

const api = new ApiBuilder('finance-v1');

/* ------------------------------------------------------------ presenters */

function embeddedFolio(id: string | undefined) {
  if (!id) return undefined;
  const f = db.folios.get(id);
  return { id, debitor: f?.debitor.name };
}

function chargeBody(c: Charge, langs: readonly string[]) {
  return {
    id: c.id,
    serviceType: c.serviceType,
    name: resolveLocalized(c.name, langs) ?? c.id,
    translatedNames: c.name,
    isPosted: c.isPosted,
    serviceDate: c.serviceDate,
    created: c.created,
    movedFrom: embeddedFolio(c.movedFromFolioId),
    movedTo: c.movedToFolioId && c.movedToFolioId !== c.folioId ? embeddedFolio(c.movedToFolioId) : undefined,
    movedReason: c.movedReason,
    routedFrom: embeddedFolio(c.routedFromFolioId),
    routedTo: c.routedToFolioId && c.routedToFolioId !== c.folioId ? embeddedFolio(c.routedToFolioId) : undefined,
    amount: c.amount,
    receipt: c.receipt,
    subAccountId: c.subAccountId,
    quantity: c.quantity,
    type: c.type,
  };
}

function transitoryChargeBody(t: TransitoryCharge, langs: readonly string[]) {
  return {
    id: t.id,
    name: resolveLocalized(t.name, langs) ?? t.id,
    amount: money(t.amount.grossAmount, t.amount.currency),
    serviceType: t.serviceType,
    serviceDate: t.serviceDate,
    created: t.created,
    receipt: t.receipt,
    movedFrom: embeddedFolio(t.movedFromFolioId),
    movedTo: t.movedToFolioId ? embeddedFolio(t.movedToFolioId) : undefined,
    movedReason: t.movedReason,
    quantity: t.quantity,
  };
}

function allowanceBody(a: Allowance) {
  return {
    id: a.id,
    amount: a.amount,
    reason: a.reason,
    serviceType: a.serviceType,
    serviceDate: a.serviceDate,
    created: a.created,
    movedFrom: embeddedFolio(a.movedFromFolioId),
    movedTo: a.movedToFolioId ? embeddedFolio(a.movedToFolioId) : undefined,
    movedReason: a.movedReason,
    sourceChargeId: a.chargeId,
    subAccountId: a.subAccountId,
  };
}

function paymentBody(p: Payment) {
  return {
    id: p.id,
    method: p.method,
    amount: p.amount,
    externalReference: p.externalReference,
    receipt: p.receipt,
    paymentDate: p.paymentDate,
    movedFrom: embeddedFolio(p.movedFromFolioId),
    movedTo: p.movedToFolioId ? embeddedFolio(p.movedToFolioId) : undefined,
    movedReason: p.movedReason,
    sourcePaymentId: p.sourcePaymentId,
    businessDate: p.businessDate,
    status: p.status,
  };
}

function refundBody(r: Refund) {
  return {
    id: r.id,
    method: r.method,
    amount: r.amount,
    externalReference: r.externalReference,
    receipt: r.receipt,
    refundDate: r.refundDate,
    sourcePaymentId: r.sourcePaymentId,
    status: r.status,
    failureReason: r.failureReason,
    failureCode: r.failureCode,
    movedFrom: embeddedFolio(r.movedFromFolioId),
    movedTo: r.movedToFolioId ? embeddedFolio(r.movedToFolioId) : undefined,
    movedReason: r.movedReason,
    businessDate: r.businessDate,
    reason: r.reason,
  };
}

function folioStatus(f: Folio): 'Open' | 'Closed' | 'ClosedWithInvoice' {
  if (!f.isClosed) return 'Open';
  return f.invoiceId ? 'ClosedWithInvoice' : 'Closed';
}

function folioIsEmpty(f: Folio): boolean {
  return db.charges.count({ folioId: f.id }) === 0
    && db.payments.count({ folioId: f.id }) === 0
    && db.transitoryCharges.count({ folioId: f.id }) === 0
    && db.allowances.count({ folioId: f.id }) === 0;
}

/** Actions the folio currently permits, as flat strings. */
function folioAllowedActions(f: Folio): string[] {
  const actions: string[] = [];
  const totals = folioTotals(f);
  if (!f.isClosed) {
    actions.push('PostCharge', 'PostTransitoryCharge', 'PostPayment', 'MoveCharges', 'MovePayments');
    if (totals.charges.amount > 0) actions.push('PostAllowance', 'Correct');
    if (Math.abs(totals.balance.amount) < 1e-9) actions.push('Close');
    if (!folioIsEmpty(f)) actions.push('CreateInvoice');
  } else if (!f.invoiceId) {
    actions.push('Reopen');
  }
  if (folioIsEmpty(f) && !f.isMainFolio) actions.push('Delete');
  return actions;
}

/** The largest allowance the folio could still absorb. */
function maximumAllowance(f: Folio): number {
  const charged = db.charges.all({ folioId: f.id }).reduce((s, c) => s + c.amount.grossAmount, 0);
  const allowed = db.allowances.all({ folioId: f.id }).reduce((s, a) => s + a.amount.grossAmount, 0);
  return round(Math.max(0, charged - allowed), f.currency);
}

function folioWarnings(f: Folio): string[] {
  const warnings = [...f.warnings];
  const totals = folioTotals(f);
  if (f.isClosed && Math.abs(totals.balance.amount) > 1e-9) {
    warnings.push(`The folio was closed with an open balance of ${totals.balance.amount.toFixed(2)} ${f.currency}.`);
  }
  const reservation = f.reservationId ? db.reservations.get(f.reservationId) : undefined;
  if (reservation?.status === 'CheckedOut' && !f.isClosed) {
    warnings.push('The reservation has checked out but the folio is still open.');
  }
  return warnings;
}

function folioBody(f: Folio, langs: readonly string[], expand: ReadonlySet<string>, detail: boolean) {
  const totals = folioTotals(f);
  const reservation = f.reservationId ? db.reservations.get(f.reservationId) : undefined;
  const invoices = db.invoices.getMany(f.invoiceIds);
  const related = f.reservationId
    ? db.folios.all({ reservationId: f.reservationId }).filter((x) => x.id !== f.id)
    : [];

  const body: Record<string, unknown> = {
    id: f.id,
    created: f.created,
    updated: f.updated,
    type: f.type,
    debitor: f.debitor,
    closingDate: f.closedAt,
    isMainFolio: f.isMainFolio,
    isEmpty: folioIsEmpty(f),
    reservation: reservation ? { id: reservation.id, bookingId: reservation.bookingId } : undefined,
    bookingId: f.bookingId,
    company: embeddedCompany(f.companyId),
    balance: totals.balance,
    checkedOutOnAccountsReceivable: f.checkedOutOnAccountsReceivable,
    folioWarnings: folioWarnings(f),
    allowedActions: folioAllowedActions(f),
    relatedInvoices: invoices.map((i) => ({ id: i.id })),
    status: folioStatus(f),
  };

  if (detail || expand.has('charges')) {
    body.charges = db.charges.all({ folioId: f.id }).map((c) => chargeBody(c, langs));
  }
  if (detail || expand.has('transitoryCharges')) {
    body.transitoryCharges = db.transitoryCharges.all({ folioId: f.id }).map((t) => transitoryChargeBody(t, langs));
  }
  if (detail || expand.has('payments')) {
    body.payments = db.payments.all({ folioId: f.id })
      .filter((p) => p.status === 'Success')
      .map(paymentBody);
    body.pendingPayments = db.payments.all({ folioId: f.id })
      .filter((p) => p.status === 'Pending')
      .map((p) => ({ id: p.id, amount: p.amount, terminalId: p.terminalId }));
  }
  if (detail || expand.has('allowances')) {
    body.allowances = db.allowances.all({ folioId: f.id }).map(allowanceBody);
  }
  if (detail) {
    body.property = embeddedProperty(f.propertyId, langs);
    body.relatedFolios = related.map((x) => ({ id: x.id, debitor: x.debitor.name }));
    body.allowedPayment = Math.max(0, totals.balance.amount);
    body.maximumAllowance = maximumAllowance(f);
  }
  return body;
}

/* ----------------------------------------------------------------- folios */

function folioFilter(req: Request): (f: Folio) => boolean {
  const propertyIds = arrayParam(req, 'propertyIds');
  const companyIds = arrayParam(req, 'companyIds');
  const reservationIds = arrayParam(req, 'reservationIds');
  const bookingIds = arrayParam(req, 'bookingIds');
  const isEmpty = boolParam(req, 'isEmpty');
  const excludeClosed = boolParam(req, 'excludeClosed') ?? false;
  const hasInvoices = boolParam(req, 'hasInvoices');
  const createdFrom = dateParam(req, 'createdFrom');
  const createdTo = dateParam(req, 'createdTo');
  const updatedFrom = dateParam(req, 'updatedFrom');
  const updatedTo = dateParam(req, 'updatedTo');
  const onlyMain = boolParam(req, 'onlyMain');
  const type = stringParam(req, 'type');
  const status = stringParam(req, 'status');
  const externalFolioCode = stringParam(req, 'externalFolioCode');
  const textSearch = stringParam(req, 'textSearch')?.toLowerCase();
  const balanceFilters = arrayParam(req, 'balanceFilter');

  return (f) => {
    if (propertyIds.length && !propertyIds.includes(f.propertyId)) return false;
    if (companyIds.length && (!f.companyId || !companyIds.includes(f.companyId))) return false;
    if (reservationIds.length && (!f.reservationId || !reservationIds.includes(f.reservationId))) return false;
    if (bookingIds.length && (!f.bookingId || !bookingIds.includes(f.bookingId))) return false;
    if (isEmpty !== undefined && folioIsEmpty(f) !== isEmpty) return false;
    if (excludeClosed && f.isClosed) return false;
    if (hasInvoices !== undefined && (f.invoiceIds.length > 0) !== hasInvoices) return false;
    if (createdFrom && f.created.slice(0, 10) < createdFrom) return false;
    if (createdTo && f.created.slice(0, 10) > createdTo) return false;
    if (updatedFrom && f.updated.slice(0, 10) < updatedFrom) return false;
    if (updatedTo && f.updated.slice(0, 10) > updatedTo) return false;
    if (onlyMain !== undefined && f.isMainFolio !== onlyMain) return false;
    if (type && f.type !== type) return false;
    if (status && folioStatus(f) !== status && !(status === 'Closed' && folioStatus(f) === 'ClosedWithInvoice')) return false;
    if (externalFolioCode && f.externalCode !== externalFolioCode) return false;
    if (textSearch) {
      const haystack = [f.id, f.debitor.name, f.debitor.firstName, f.debitor.email, f.reservationId]
        .filter(Boolean).join(' ').toLowerCase();
      if (!haystack.includes(textSearch)) return false;
    }
    if (balanceFilters.length) {
      const balance = folioTotals(f).balance.amount;
      const matches = balanceFilters.some((x) =>
        (x === 'Zero' && Math.abs(balance) < 1e-9)
        || (x === 'Positive' && balance > 0)
        || (x === 'Negative' && balance < 0));
      if (!matches) return false;
    }
    return true;
  };
}

api.op('FinanceFoliosGet', (req, res) => {
  const langs = arrayParam(req, 'languages');
  const expand = new Set(arrayParam(req, 'expand'));
  const page = paging(req);
  const sort = arrayParam(req, 'sort');
  const { items, count } = db.folios.query({
    filter: folioFilter(req),
    sort: folioSorter(sort),
    offset: page.offset,
    limit: page.pageSize,
  });
  sendList(res, 'folios', items.map((f) => folioBody(f, langs, expand, false)), count);
});

function folioSorter(keys: readonly string[]) {
  const comparators: Record<string, (a: Folio, b: Folio) => number> = {
    'created:asc': (a, b) => a.created.localeCompare(b.created),
    'created:desc': (a, b) => b.created.localeCompare(a.created),
    'updated:asc': (a, b) => a.updated.localeCompare(b.updated),
    'updated:desc': (a, b) => b.updated.localeCompare(a.updated),
    'id:asc': (a, b) => a.id.localeCompare(b.id),
    'id:desc': (a, b) => b.id.localeCompare(a.id),
  };
  const active = keys.filter((k) => comparators[k]);
  if (!active.length) return comparators['created:desc']!;
  return (a: Folio, b: Folio) => {
    for (const key of active) {
      const result = comparators[key]!(a, b);
      if (result !== 0) return result;
    }
    return a.id.localeCompare(b.id);
  };
}

api.op('FinanceFolios$countGet', (req, res) => {
  res.json({ count: db.folios.all().filter(folioFilter(req)).length });
});

api.op('FinanceFoliosPost', (req, res) => {
  const body = req.body as Record<string, any>;
  const created = transact(() => {
    const reservation = body.reservationId ? getReservation(body.reservationId) : undefined;
    const company = body.companyId ? db.companies.get(body.companyId) : undefined;
    if (body.companyId && !company) throw unprocessable(`Company '${body.companyId}' does not exist.`);
    const propertyId = reservation?.propertyId ?? company?.propertyId ?? body.propertyId;
    if (!propertyId) {
      throw unprocessable('A `reservationId`, `companyId` or `propertyId` is required.');
    }
    getProperty(propertyId);

    const folio = openFolio(propertyId, {
      reservationId: reservation?.id,
      bookingId: reservation?.bookingId,
      companyId: company?.id,
      type: body.type ?? (company ? 'Booking' : reservation ? 'Guest' : 'External'),
      debitor: body.debitor,
      isMainFolio: false,
    });
    if (body.code) {
      folio.externalCode = body.code;
      db.folios.put(folio);
    }
    return folio;
  });
  sendCreated(res, `/finance/v1/folios/${created.id}`, { id: created.id });
});

api.op('FinanceFoliosByIdGet', (req, res) => {
  const f = getFolio(req.params.id!);
  const langs = languagesOf(arrayParam(req, 'languages'), f.propertyId);
  res.json(folioBody(f, langs, new Set(arrayParam(req, 'expand')), true));
});

api.op('FinanceFoliosByIdHead', (req, res) => {
  res.status(db.folios.exists(req.params.id!) ? 200 : 404).end();
});

api.op('FinanceFoliosByIdPatch', (req, res) => {
  const f = getFolio(req.params.id!);
  if (f.isClosed) throw unprocessable(`Folio '${f.id}' is closed.`);
  const ops = req.body as PatchOperation[];
  rejectImmutablePaths(ops, ['/id', '/created', '/balance', '/charges', '/payments', '/status']);
  const view = { debitor: f.debitor, type: f.type };
  const patched = applyPatch(view, ops) as typeof view;
  f.debitor = patched.debitor;
  f.type = patched.type;
  f.updated = nowIso();
  db.folios.put(f);
  logFolio(f.id, {
    propertyId: f.propertyId,
    action: 'DebitorChanged',
    message: `Debitor changed to ${f.debitor.name ?? 'unnamed'}.`,
  });
  sendNoContent(res);
});

api.op('FinanceFoliosByIdDelete', (req, res) => {
  const f = getFolio(req.params.id!);
  if (!folioIsEmpty(f)) throw unprocessable(`Folio '${f.id}' is not empty.`);
  if (f.isMainFolio) throw unprocessable('The main folio of a reservation cannot be deleted.');
  db.folios.delete(f.id);
  logFolio(f.id, { propertyId: f.propertyId, action: 'Deleted', message: `Folio ${f.id} deleted.` });
  sendNoContent(res);
});

/* --------------------------------------------------------- folio actions */

function requireOpenFolio(id: string): Folio {
  const f = getFolio(id);
  if (f.isClosed) throw unprocessable(`Folio '${f.id}' is closed.`);
  return f;
}

function businessDateOf(f: Folio): string {
  return db.properties.get(f.propertyId)?.businessDate ?? nowIso().slice(0, 10);
}

api.op('FinanceFolio-actionsByFolioIdChargesPost', (req, res) => {
  const folio = requireOpenFolio(req.params.folioId!);
  const body = req.body as Record<string, any>;
  const created = transact(() => {
    const charge = postFolioCharge(folio, {
      serviceType: body.serviceType,
      chargeType: 'Direct',
      subAccountId: body.subAccountId,
      name: body.name,
      amount: grossToAmount(body.amount.amount, body.vatType, body.amount.currency ?? folio.currency),
      quantity: body.quantity ?? 1,
      serviceDate: body.businessDate ?? businessDateOf(folio),
      receipt: body.receipt,
    });
    return routeCharge(charge);
  });
  sendCreated(res, `/finance/v1/folios/${created.folioId}`, { id: created.id });
});

api.op('FinanceFolio-actionsByFolioIdTransitory-chargesPost', (req, res) => {
  const folio = requireOpenFolio(req.params.folioId!);
  const body = req.body as Record<string, any>;
  const created = postTransitoryCharge(folio, {
    name: body.name,
    amount: grossToAmount(body.amount.amount, 'Null', body.amount.currency ?? folio.currency),
    quantity: body.quantity ?? 1,
    serviceDate: body.businessDate ?? businessDateOf(folio),
    serviceType: body.serviceType,
    receipt: body.receipt,
  });
  sendCreated(res, `/finance/v1/folios/${folio.id}`, { id: created.id });
});

api.op('FinanceFolio-actionsByFolioIdCancellation-feePost', (req, res) => {
  const folio = requireOpenFolio(req.params.folioId!);
  const reservation = folio.reservationId ? db.reservations.get(folio.reservationId) : undefined;
  if (!reservation) throw unprocessable('A cancellation fee can only be posted to a reservation folio.');
  const fee = reservation.cancellationFee.fee;
  if (!fee || fee.amount <= 0) throw unprocessable('The reservation has no cancellation fee to post.');
  const policy = reservation.cancellationFee.id
    ? db.cancellationPolicies.get(reservation.cancellationFee.id)
    : undefined;
  const created = postFolioCharge(folio, {
    serviceType: 'CancellationFees',
    chargeType: 'CancellationFee',
    name: `Cancellation fee (${reservation.cancellationFee.code ?? 'policy'})`,
    amount: grossToAmount(fee.amount, policy?.fee.vatType ?? 'Normal', fee.currency),
    serviceDate: businessDateOf(folio),
    reservationId: reservation.id,
    kind: 'CF',
  });
  sendCreated(res, `/finance/v1/folios/${folio.id}`, { id: created.id });
});

api.op('FinanceFolio-actionsByFolioIdNo-show-feePost', (req, res) => {
  const folio = requireOpenFolio(req.params.folioId!);
  const reservation = folio.reservationId ? db.reservations.get(folio.reservationId) : undefined;
  if (!reservation) throw unprocessable('A no-show fee can only be posted to a reservation folio.');
  const fee = reservation.noShowFee.fee;
  if (!fee || fee.amount <= 0) throw unprocessable('The reservation has no no-show fee to post.');
  const policy = reservation.noShowFee.id ? db.noShowPolicies.get(reservation.noShowFee.id) : undefined;
  const created = postFolioCharge(folio, {
    serviceType: 'NoShow',
    chargeType: 'NoShowFee',
    name: `No-show fee (${reservation.noShowFee.code ?? 'policy'})`,
    amount: grossToAmount(fee.amount, policy?.fee.vatType ?? 'Normal', fee.currency),
    serviceDate: businessDateOf(folio),
    reservationId: reservation.id,
    kind: 'NF',
  });
  sendCreated(res, `/finance/v1/folios/${folio.id}`, { id: created.id });
});

api.op('FinanceFolio-actionsByFolioIdClosePut', (req, res) => {
  const folio = getFolio(req.params.folioId!);
  closeFolio(folio);
  sendNoContent(res);
});

api.op('FinanceFolio-actionsByFolioIdReopenPut', (req, res) => {
  const folio = getFolio(req.params.folioId!);
  reopenFolio(folio);
  sendNoContent(res);
});

api.op('FinanceFolio-actionsByFolioIdPost-chargesPut', (req, res) => {
  // Marks pending charges as posted; everything this clone writes is posted
  // immediately, so the call reports how many were already settled.
  const folio = requireOpenFolio(req.params.folioId!);
  const pending = db.charges.all({ folioId: folio.id }).filter((c) => !c.isPosted);
  transact(() => {
    for (const charge of pending) {
      charge.isPosted = true;
      db.charges.put(charge);
    }
  });
  sendNoContent(res);
});

api.op('FinanceFolio-actionsByFolioIdMove-chargesPut', (req, res) => {
  const source = getFolio(req.params.folioId!);
  const body = req.body as { targetFolioId: string; reason: string; chargeIds?: string[]; allowanceIds?: string[]; transitoryChargeIds?: string[] };
  const target = getFolio(body.targetFolioId);
  transact(() => moveItems(source, target, body, body.reason));
  sendNoContent(res);
});

function moveItems(
  source: Folio,
  target: Folio,
  selection: { chargeIds?: string[]; allowanceIds?: string[]; transitoryChargeIds?: string[] },
  reason: string,
): void {
  if (source.id === target.id) throw unprocessable('The source and target folio are the same.');
  if (selection.chargeIds?.length) moveCharges(source, target, selection.chargeIds, reason);
  for (const id of selection.allowanceIds ?? []) {
    const allowance = db.allowances.get(id);
    if (!allowance || allowance.folioId !== source.id) {
      throw unprocessable(`Allowance '${id}' is not on folio '${source.id}'.`);
    }
    allowance.movedFromFolioId = source.id;
    allowance.movedToFolioId = target.id;
    allowance.movedReason = reason;
    allowance.folioId = target.id;
    db.allowances.put(allowance);
  }
  for (const id of selection.transitoryChargeIds ?? []) {
    const charge = db.transitoryCharges.get(id);
    if (!charge || charge.folioId !== source.id) {
      throw unprocessable(`Transitory charge '${id}' is not on folio '${source.id}'.`);
    }
    charge.movedFromFolioId = source.id;
    charge.movedToFolioId = target.id;
    charge.movedReason = reason;
    charge.folioId = target.id;
    db.transitoryCharges.put(charge);
  }
}

api.op('FinanceFolio-actionsByFolioIdMove-all-chargesPut', (req, res) => {
  const source = getFolio(req.params.folioId!);
  const body = req.body as { targetFolioId: string; reason: string };
  const target = getFolio(body.targetFolioId);
  transact(() => {
    moveItems(source, target, {
      chargeIds: db.charges.all({ folioId: source.id }).map((c) => c.id),
      allowanceIds: db.allowances.all({ folioId: source.id }).map((a) => a.id),
      transitoryChargeIds: db.transitoryCharges.all({ folioId: source.id }).map((t) => t.id),
    }, body.reason);
  });
  sendNoContent(res);
});

api.op('FinanceFolio-actionsBulk-movePut', (req, res) => {
  const body = req.body as { reason: string; items: { sourceFolioId: string; targetFolioId: string; chargeIds?: string[]; allowanceIds?: string[]; transitoryChargeIds?: string[] }[] };
  transact(() => {
    for (const item of body.items) {
      const source = getFolio(item.sourceFolioId);
      const target = getFolio(item.targetFolioId);
      moveItems(source, target, item, body.reason);
    }
  });
  sendNoContent(res);
});

api.op('FinanceFolio-actionsByFolioIdMove-paymentsPut', (req, res) => {
  const source = getFolio(req.params.folioId!);
  const body = req.body as { targetFolioId: string; reason: string; paymentIds?: string[] };
  const target = getFolio(body.targetFolioId);
  const ids = body.paymentIds?.length
    ? body.paymentIds
    : db.payments.all({ folioId: source.id }).map((p) => p.id);
  transact(() => movePayments(source, target, ids, body.reason));
  sendNoContent(res);
});

api.op('FinanceFolio-actionsByFolioIdChargesByChargeIdAllowancesPost', (req, res) => {
  const folio = requireOpenFolio(req.params.folioId!);
  const charge = db.charges.get(req.params.chargeId!);
  if (!charge || charge.folioId !== folio.id) {
    throw notFound(`Charge '${req.params.chargeId}' was not found on folio '${folio.id}'.`);
  }
  const body = req.body as Record<string, any>;
  const created = postAllowance(folio, {
    chargeId: charge.id,
    amount: money(body.amount.amount, body.amount.currency ?? folio.currency),
    reason: body.reason,
    serviceDate: body.businessDate,
  });
  sendCreated(res, `/finance/v1/folios/${folio.id}`, { id: created.id });
});

api.op('FinanceFolio-actionsByFolioIdAllowancesPost', (req, res) => {
  const folio = requireOpenFolio(req.params.folioId!);
  const body = req.body as Record<string, any>;
  const created = postAllowance(folio, {
    amount: money(body.amount.amount, body.amount.currency ?? folio.currency),
    reason: body.reason,
    serviceType: body.serviceType,
    vatType: body.vatType,
    subAccountId: body.subAccountId,
    serviceDate: body.businessDate,
  });
  sendCreated(res, `/finance/v1/folios/${folio.id}`, { id: created.id });
});

api.op('FinanceFolio-actionsByFolioIdBulk-allowancesPost', (req, res) => {
  const folio = requireOpenFolio(req.params.folioId!);
  const body = req.body as { allowances: Record<string, any>[] };
  const ids = transact(() => (body.allowances ?? []).map((a) => postAllowance(folio, {
    chargeId: a.chargeId,
    amount: money(a.amount.amount, a.amount.currency ?? folio.currency),
    reason: a.reason,
    serviceType: a.serviceType,
    vatType: a.vatType,
    subAccountId: a.subAccountId,
    serviceDate: a.businessDate,
  }).id));
  res.status(201).json({ ids: ids.map((id) => ({ id })) });
});

api.op('FinanceFolio-actionsByFolioIdCorrectPost', (req, res) => {
  const folio = requireOpenFolio(req.params.folioId!);
  const body = req.body as { reason: string; chargeIds?: string[]; allowanceIds?: string[]; transitoryChargeIds?: string[] };
  /**
   * Correcting a folio moves the named items onto a fresh correction folio
   * and allows them off the original, so the guest's document is clean while
   * the history stays intact.
   */
  const created = transact(() => {
    const correction = openFolio(folio.propertyId, {
      reservationId: folio.reservationId,
      bookingId: folio.bookingId,
      type: folio.type,
      debitor: folio.debitor,
      isMainFolio: false,
    });
    moveItems(folio, correction, body, body.reason);
    correction.warnings.push(`Correction of folio ${folio.id}: ${body.reason}`);
    db.folios.put(correction);
    return correction;
  });
  sendCreated(res, `/finance/v1/folios/${created.id}`, { id: created.id });
});

api.op('FinanceFolio-actionsByFolioIdChargesByChargeIdSplitPost', (req, res) => {
  const folio = requireOpenFolio(req.params.folioId!);
  const charge = db.charges.get(req.params.chargeId!);
  if (!charge || charge.folioId !== folio.id) {
    throw notFound(`Charge '${req.params.chargeId}' was not found on folio '${folio.id}'.`);
  }
  const amount = splitAmount(req.body, charge.amount.grossAmount, folio.currency);
  const created = splitCharge(charge, amount);
  sendCreated(res, `/finance/v1/folios/${folio.id}`, { id: created.id });
});

api.op('FinanceFolio-actionsByFolioIdPaymentsByPaymentIdSplitPost', (req, res) => {
  const folio = requireOpenFolio(req.params.folioId!);
  const payment = db.payments.get(req.params.paymentId!);
  if (!payment || payment.folioId !== folio.id) {
    throw notFound(`Payment '${req.params.paymentId}' was not found on folio '${folio.id}'.`);
  }
  const amount = splitAmount(req.body, payment.amount.amount, folio.currency);
  const created = splitPayment(payment, amount);
  created.sourcePaymentId = payment.id;
  db.payments.put(created);
  sendCreated(res, `/finance/v1/folios/${folio.id}`, { id: created.id });
});

function splitAmount(body: any, total: number, currency: string): number {
  if (body?.type === 'ByPercent') {
    const percent = Number(body.percent);
    if (!Number.isFinite(percent) || percent <= 0 || percent >= 100) {
      throw unprocessable('`percent` must be greater than 0 and less than 100.');
    }
    return round((total * percent) / 100, currency);
  }
  const amount = Number(body?.amount?.amount);
  if (!Number.isFinite(amount)) throw unprocessable('`amount` is required for a split by amount.');
  return round(amount, currency);
}

/* --------------------------------------------------------------- payments */

api.op('FinanceFoliosByFolioIdPaymentsGet', (req, res) => {
  const folio = getFolio(req.params.folioId!);
  const statusCodes = arrayParam(req, 'statusCodes');
  const page = paging(req);
  const all = db.payments.all({ folioId: folio.id })
    .filter((p) => !statusCodes.length || statusCodes.includes(p.status));
  sendList(res, 'payments', all.slice(page.offset, page.offset + page.pageSize).map(paymentBody), all.length);
});

api.op('FinanceFoliosByFolioIdPaymentsByPaymentIdGet', (req, res) => {
  const folio = getFolio(req.params.folioId!);
  const payment = db.payments.get(req.params.paymentId!);
  if (!payment || payment.folioId !== folio.id) {
    throw notFound(`Payment '${req.params.paymentId}' was not found on folio '${folio.id}'.`);
  }
  res.json(paymentBody(payment));
});

api.op('FinanceFoliosByFolioIdPaymentsPost', (req, res) => {
  const folio = requireOpenFolio(req.params.folioId!);
  const body = req.body as Record<string, any>;
  const created = postFolioPayment(folio, {
    method: body.method,
    amount: money(body.amount.amount, body.amount.currency ?? folio.currency),
    businessDate: body.businessDate ?? businessDateOf(folio),
    receipt: body.receipt,
    paidChargeIds: (body.paidCharges ?? []).map((c: any) => c.chargeId ?? c.id).filter(Boolean),
  });
  sendCreated(res, `/finance/v1/folios/${folio.id}/payments/${created.id}`, { id: created.id });
});

api.op('FinanceFoliosByFolioIdPaymentsBy-terminalPost', (req, res) => {
  const folio = requireOpenFolio(req.params.folioId!);
  const body = req.body as Record<string, any>;
  // A terminal payment starts pending: the card device confirms it later.
  const created = postFolioPayment(folio, {
    method: 'CreditCard',
    amount: money(body.amount.amount, body.amount.currency ?? folio.currency),
    businessDate: businessDateOf(folio),
    status: 'Pending',
    terminalId: body.terminalId,
    paidChargeIds: (body.paidCharges ?? []).map((c: any) => c.chargeId ?? c.id).filter(Boolean),
  });
  sendCreated(res, `/finance/v1/folios/${folio.id}/payments/${created.id}`, { id: created.id });
});

api.op('FinanceFoliosByFolioIdPaymentsBy-authorizationPost', (req, res) => {
  const folio = requireOpenFolio(req.params.folioId!);
  const body = req.body as Record<string, any>;
  const authorization = db.authorizations.get(body.authorizationId);
  if (!authorization) throw unprocessable(`Authorization '${body.authorizationId}' does not exist.`);
  if (authorization.status !== 'Success') {
    throw unprocessable('Only a successful authorization can be captured.');
  }
  const amount = money(
    body.amount?.amount ?? authorization.remainingBalance.amount,
    body.amount?.currency ?? authorization.amount.currency,
  );
  if (amount.amount > authorization.remainingBalance.amount + 1e-9) {
    throw unprocessable(
      `The authorization only has ${authorization.remainingBalance.amount.toFixed(2)} ${authorization.amount.currency} left.`,
    );
  }
  const created = transact(() => {
    const payment = postFolioPayment(folio, {
      method: 'CreditCard',
      amount,
      businessDate: businessDateOf(folio),
      externalReference: { pspReference: authorization.externalReference?.transactionReference },
    });
    authorization.remainingBalance = money(
      authorization.remainingBalance.amount - amount.amount,
      authorization.amount.currency,
    );
    authorization.updated = nowIso();
    db.authorizations.put(authorization);
    return payment;
  });
  sendCreated(res, `/finance/v1/folios/${folio.id}/payments/${created.id}`, { id: created.id });
});

api.op('FinanceFoliosByFolioIdPaymentsBy-payment-accountPost', (req, res) => {
  const folio = requireOpenFolio(req.params.folioId!);
  const body = req.body as Record<string, any>;
  const account = body.paymentAccountId ? db.paymentAccounts.get(body.paymentAccountId) : undefined;
  if (body.paymentAccountId && !account) {
    throw unprocessable(`Payment account '${body.paymentAccountId}' does not exist.`);
  }
  const created = postFolioPayment(folio, {
    method: (account?.paymentMethod as Payment['method']) ?? 'CreditCard',
    amount: money(body.amount.amount, body.amount.currency ?? folio.currency),
    businessDate: businessDateOf(folio),
    externalReference: { merchantReference: account?.payerReference },
  });
  sendCreated(res, `/finance/v1/folios/${folio.id}/payments/${created.id}`, { id: created.id });
});

api.op('FinanceFoliosByFolioIdPaymentsBy-linkPost', (req, res) => {
  const folio = requireOpenFolio(req.params.folioId!);
  const body = req.body as Record<string, any>;
  const created = postFolioPayment(folio, {
    method: 'CreditCard',
    amount: money(body.amount.amount, body.amount.currency ?? folio.currency),
    businessDate: businessDateOf(folio),
    status: 'Pending',
    expiresAt: body.expiresAt,
  });
  created.paymentLinkUrl = `${req.protocol}://${req.get('host')}/pay/folio/${created.id}`;
  db.payments.put(created);
  sendCreated(res, `/finance/v1/folios/${folio.id}/payments/${created.id}`, {
    id: created.id,
    paymentLinkUrl: created.paymentLinkUrl,
  });
});

api.op('FinanceFoliosByFolioIdPaymentsByPaymentIdCancelPut', (req, res) => {
  const folio = getFolio(req.params.folioId!);
  const payment = db.payments.get(req.params.paymentId!);
  if (!payment || payment.folioId !== folio.id) {
    throw notFound(`Payment '${req.params.paymentId}' was not found on folio '${folio.id}'.`);
  }
  if (payment.status !== 'Pending') {
    throw unprocessable('Only a pending payment can be cancelled.');
  }
  payment.status = 'Canceled';
  payment.paymentLinkUrl = undefined;
  db.payments.put(payment);
  logFolio(folio.id, {
    propertyId: folio.propertyId,
    action: 'PaymentCanceled',
    message: `Payment ${payment.id} cancelled.`,
    relatedEntityId: payment.id,
    amount: payment.amount,
  });
  sendNoContent(res);
});

/* ---------------------------------------------------------------- refunds */

api.op('FinanceFoliosByFolioIdRefundsGet', (req, res) => {
  const folio = getFolio(req.params.folioId!);
  const statusCodes = arrayParam(req, 'statusCodes');
  const page = paging(req);
  const all = db.refunds.all({ folioId: folio.id })
    .filter((r) => !statusCodes.length || statusCodes.includes(r.status));
  sendList(res, 'refunds', all.slice(page.offset, page.offset + page.pageSize).map(refundBody), all.length);
});

api.op('FinanceFoliosByFolioIdRefundsByRefundIdGet', (req, res) => {
  const folio = getFolio(req.params.folioId!);
  const refund = db.refunds.get(req.params.refundId!);
  if (!refund || refund.folioId !== folio.id) {
    throw notFound(`Refund '${req.params.refundId}' was not found on folio '${folio.id}'.`);
  }
  res.json(refundBody(refund));
});

api.op('FinanceFoliosByFolioIdRefundsPost', (req, res) => {
  const folio = requireOpenFolio(req.params.folioId!);
  const body = req.body as Record<string, any>;
  const created = createRefund(folio, {
    method: body.method,
    amount: money(body.amount.amount, body.amount.currency ?? folio.currency),
    businessDate: body.businessDate ?? businessDateOf(folio),
    receipt: body.receipt,
    reason: body.reason,
  });
  sendCreated(res, `/finance/v1/folios/${folio.id}/refunds/${created.id}`, { id: created.id });
});

api.op('FinanceFoliosByFolioIdPaymentsByPaymentIdRefundsPost', (req, res) => {
  const folio = requireOpenFolio(req.params.folioId!);
  const payment = db.payments.get(req.params.paymentId!);
  if (!payment || payment.folioId !== folio.id) {
    throw notFound(`Payment '${req.params.paymentId}' was not found on folio '${folio.id}'.`);
  }
  if (payment.status !== 'Success') throw unprocessable('Only a settled payment can be refunded.');
  const body = (req.body ?? {}) as Record<string, any>;
  const alreadyRefunded = db.refunds.all({ folioId: folio.id })
    .filter((r) => r.sourcePaymentId === payment.id && r.status !== 'Canceled')
    .reduce((s, r) => s + r.amount.amount, 0);
  const remaining = round(payment.amount.amount - alreadyRefunded, folio.currency);
  const amount = money(body.amount?.amount ?? remaining, folio.currency);
  if (amount.amount > remaining + 1e-9) {
    throw unprocessable(`Only ${remaining.toFixed(2)} ${folio.currency} of that payment can still be refunded.`);
  }
  const created = createRefund(folio, {
    method: payment.method,
    amount,
    businessDate: body.businessDate ?? businessDateOf(folio),
    receipt: body.receipt,
    reason: body.reason,
    sourcePaymentId: payment.id,
  });
  sendCreated(res, `/finance/v1/folios/${folio.id}/refunds/${created.id}`, { id: created.id });
});

function createRefund(
  folio: Folio,
  input: {
    method: string; amount: MonetaryValue; businessDate: string;
    receipt?: string; reason?: string; sourcePaymentId?: string;
  },
): Refund {
  if (input.amount.amount <= 0) throw unprocessable('A refund amount must be greater than zero.');
  return transact(() => {
    const refund: Refund = {
      id: `${folio.id}-R-${nextSeq(`refund:${folio.id}`)}`,
      folioId: folio.id,
      propertyId: folio.propertyId,
      method: input.method as Refund['method'],
      amount: input.amount,
      created: nowIso(),
      refundDate: nowIso(),
      businessDate: input.businessDate,
      receipt: input.receipt ?? String(nextSeq(`receipt:${folio.propertyId}`)).padStart(8, '0'),
      status: 'Success',
      sourcePaymentId: input.sourcePaymentId,
      reason: input.reason,
    };
    db.refunds.put(refund);

    // A refund is a payment in reverse: the payment account gives money back.
    post(
      {
        propertyId: folio.propertyId,
        date: input.businessDate,
        command: 'PostPayment',
        reference: folio.reservationId ?? folio.id,
        referenceType: folio.reservationId ? 'Guest' : 'External',
      },
      [{
        debitedAccount: folio.reservationId ? `G-${folio.reservationId}` : `E-${folio.id}`,
        creditedAccount: accountForPaymentMethod(input.method),
        amount: refund.amount,
        receipt: refund.receipt,
      }],
    );

    folio.updated = nowIso();
    db.folios.put(folio);
    logFolio(folio.id, {
      propertyId: folio.propertyId,
      action: 'RefundPosted',
      message: `${input.method} refund of ${refund.amount.amount.toFixed(2)} ${refund.amount.currency}`,
      relatedEntityId: refund.id,
      amount: refund.amount,
      serviceDate: refund.businessDate,
    });
    return refund;
  });
}

/* --------------------------------------------------------------- invoices */

function invoiceBody(i: Invoice, langs: readonly string[]) {
  const property = db.properties.get(i.propertyId);
  const payments = db.payments.getMany(i.paymentIds).filter((p) => p.status === 'Success');
  const vatByRate = new Map<number, { vatType: string; net: number; tax: number }>();
  for (const item of i.lineItems) {
    const gross = item.price.amount;
    const net = gross / (1 + item.vatPercent / 100);
    const entry = vatByRate.get(item.vatPercent) ?? { vatType: item.vatType, net: 0, tax: 0 };
    entry.net += net;
    entry.tax += gross - net;
    vatByRate.set(item.vatPercent, entry);
  }

  return {
    id: i.id,
    number: i.number,
    type: i.type,
    series: i.series,
    to: {
      name: i.recipient.name,
      address: i.recipient.address,
      companyName: i.recipient.company?.name,
      companyTaxId: i.recipient.company?.taxId,
      reference: i.recipient.reference,
      personalTaxId: i.recipient.personalTaxId,
    },
    paymentSettled: i.paymentSettled,
    status: i.status,
    created: i.created,
    relatedInvoiceNumber: i.relatedInvoiceNumber,
    writeOffReason: i.writeOffReason,
    cancellationReasonCode: i.cancellationReasonCode,
    allowedActions: invoiceAllowedActions(i),
    invoiceDate: i.invoiceDate,
    folioId: i.folioId,
    from: property
      ? {
        name: property.companyName,
        address: property.location,
      }
      : undefined,
    commercialInformation: property
      ? {
        registerEntry: property.commercialRegisterEntry,
        taxId: property.taxId,
        managingDirectors: property.managingDirectors,
      }
      : undefined,
    bankAccount: property?.bankAccount,
    paymentTerms: i.paymentTerms,
    lineItems: {
      lineItems: i.lineItems.map((item) => ({
        date: item.date,
        description: item.description,
        price: item.price,
        vatType: item.vatType,
        vatPercent: item.vatPercent,
        isNoShowFee: item.isNoShowFee,
        quantity: item.quantity,
        guest: item.guest,
        includedLineItems: item.includedLineItems,
      })),
      subTotal: money(i.total, i.currency),
    },
    payments: payments.map((p) => ({
      id: p.id,
      method: p.method,
      methodName: p.method,
      amount: p.amount,
      paymentDate: p.paymentDate,
      businessDate: p.businessDate,
    })),
    outstandingPayment: money(outstandingOf(i), i.currency),
    taxDetails: [...vatByRate.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([vatPercent, v]) => ({
        vatType: v.vatType,
        vatPercent,
        net: money(v.net, i.currency),
        tax: money(v.tax, i.currency),
      })),
    total: money(i.total, i.currency),
    stayInfo: i.stayInfo,
    propertyId: i.propertyId,
    propertyCountryCode: property?.location.countryCode,
    languageCode: i.languageCode,
    company: embeddedCompany(i.companyId),
  };
}

function invoiceAllowedActions(i: Invoice): string[] {
  const actions: string[] = [];
  if (!isCancelled(i) && i.type !== 'Cancellation') {
    actions.push('Cancel');
    if (i.status !== 'FullyPaid') actions.push('Pay', 'WriteOff');
  }
  actions.push('DownloadPdf');
  return actions;
}

function invoiceItem(i: Invoice) {
  const reservation = i.reservationId ? db.reservations.get(i.reservationId) : undefined;
  return {
    id: i.id,
    number: i.number,
    type: i.type,
    series: i.series,
    languageCode: i.languageCode,
    folioId: i.folioId,
    reservationId: i.reservationId,
    bookingId: i.bookingId,
    propertyId: i.propertyId,
    relatedInvoiceNumber: i.relatedInvoiceNumber,
    writeOffReason: i.writeOffReason,
    cancellationReasonCode: i.cancellationReasonCode,
    subTotal: money(i.total, i.currency),
    outstandingPayment: money(outstandingOf(i), i.currency),
    paymentSettled: i.paymentSettled,
    status: i.status,
    created: i.created,
    guestName: i.stayInfo?.guestName
      ?? [reservation?.primaryGuest?.firstName, reservation?.primaryGuest?.lastName].filter(Boolean).join(' '),
    guestCompany: i.recipient.company?.name,
    allowedActions: invoiceAllowedActions(i),
    company: embeddedCompany(i.companyId),
  };
}

api.op('FinanceInvoicesGet', (req, res) => {
  const number = stringParam(req, 'number');
  const status = stringParam(req, 'status');
  const propertyIds = arrayParam(req, 'propertyIds');
  const reservationIds = arrayParam(req, 'reservationIds');
  const bookingIds = arrayParam(req, 'bookingIds');
  const folioIds = arrayParam(req, 'folioIds');
  const companyIds = arrayParam(req, 'companyIds');
  const nameSearch = stringParam(req, 'nameSearch')?.toLowerCase();
  const paymentSettled = boolParam(req, 'paymentSettled');
  const recipientType = stringParam(req, 'recipientType');
  const dateFilters = arrayParam(req, 'dateFilter');
  const outstandingFilters = arrayParam(req, 'outstandingPaymentFilter');
  const page = paging(req);

  const { items, count } = db.invoices.query({
    filter: (i) => {
      if (number && i.number !== number) return false;
      if (status && i.status !== status) return false;
      if (propertyIds.length && !propertyIds.includes(i.propertyId)) return false;
      if (reservationIds.length && (!i.reservationId || !reservationIds.includes(i.reservationId))) return false;
      if (bookingIds.length && (!i.bookingId || !bookingIds.includes(i.bookingId))) return false;
      if (folioIds.length && !folioIds.includes(i.folioId)) return false;
      if (companyIds.length && (!i.companyId || !companyIds.includes(i.companyId))) return false;
      if (paymentSettled !== undefined && i.paymentSettled !== paymentSettled) return false;
      if (recipientType === 'Company' && !i.recipient.company?.name) return false;
      if (recipientType === 'Person' && i.recipient.company?.name) return false;
      if (nameSearch) {
        const haystack = [i.recipient.name, i.recipient.company?.name, i.stayInfo?.guestName]
          .filter(Boolean).join(' ').toLowerCase();
        if (!haystack.includes(nameSearch)) return false;
      }
      if (!matchesExpressions(i.invoiceDate, dateFilters)) return false;
      if (outstandingFilters.length
        && !matchesNumericExpressions(outstandingOf(i), outstandingFilters)) return false;
      return true;
    },
    sort: (a, b) => b.created.localeCompare(a.created),
    offset: page.offset,
    limit: page.pageSize,
  });
  sendList(res, 'invoices', items.map(invoiceItem), count);
});

function matchesExpressions(value: string, expressions: readonly string[]): boolean {
  return expressions.every((raw) => {
    const at = raw.indexOf('_');
    if (at === -1) throw unprocessable(`'${raw}' is not a valid filter expression.`);
    const op = raw.slice(0, at);
    const other = raw.slice(at + 1);
    const a = value.slice(0, other.length);
    return compare(a, other, op);
  });
}

function matchesNumericExpressions(value: number, expressions: readonly string[]): boolean {
  return expressions.every((raw) => {
    const at = raw.indexOf('_');
    if (at === -1) throw unprocessable(`'${raw}' is not a valid filter expression.`);
    const op = raw.slice(0, at);
    const other = Number(raw.slice(at + 1));
    if (!Number.isFinite(other)) throw unprocessable(`'${raw}' does not carry a numeric value.`);
    return compare(value, other, op);
  });
}

function compare<T>(a: T, b: T, op: string): boolean {
  switch (op) {
    case 'eq': return a === b;
    case 'neq': return a !== b;
    case 'lt': return a < b;
    case 'lte': return a <= b;
    case 'gt': return a > b;
    case 'gte': return a >= b;
    default: throw unprocessable(`'${op}' is not a supported operation.`);
  }
}

api.op('FinanceInvoicesPost', (req, res) => {
  const body = req.body as { folioId: string; languageCode: string };
  const folio = getFolio(body.folioId);
  const property = getProperty(folio.propertyId);
  const created = transact(() => createInvoice({
    folio,
    property,
    languageCode: body.languageCode,
  }));
  sendCreated(res, `/finance/v1/invoices/${created.id}`, { id: created.id, number: created.number });
});

api.op('FinanceInvoicesByIdGet', (req, res) => {
  const i = getInvoice(req.params.id!);
  res.json(invoiceBody(i, languagesOf(arrayParam(req, 'languages'), i.propertyId)));
});

api.op('FinanceInvoicesPreviewGet', (req, res) => {
  const folio = getFolio(requiredStringParam(req, 'folioId'));
  const property = getProperty(folio.propertyId);
  const langs = languagesOf(arrayParam(req, 'languages'), folio.propertyId);
  const languageCode = langs[0] ?? 'en';
  const lineItems = lineItemsFor(folio, languageCode);
  const total = round(lineItems.reduce((s, x) => s + x.price.amount, 0), folio.currency);

  // A preview is the document that *would* be issued; nothing is persisted.
  const preview: Invoice = {
    id: 'PREVIEW',
    propertyId: property.id,
    number: 'PREVIEW',
    type: 'Proforma',
    status: 'Unpaid',
    created: nowIso(),
    invoiceDate: property.businessDate,
    folioId: folio.id,
    reservationId: folio.reservationId,
    bookingId: folio.bookingId,
    companyId: folio.companyId,
    languageCode,
    recipient: folio.debitor,
    currency: folio.currency,
    lineItems,
    total,
    netTotal: round(lineItems.reduce((s, x) => s + x.price.amount / (1 + x.vatPercent / 100), 0), folio.currency),
    paidAmount: 0,
    paymentSettled: false,
    paymentIds: [],
    paymentTerms: resolveLocalized(property.paymentTerms, langs),
  };
  res.json(invoiceBody(preview, langs));
});

api.op('FinanceInvoicesByIdPdfGet', (req, res) => {
  const i = getInvoice(req.params.id!);
  sendInvoicePdf(res, i, i.number);
});

api.op('FinanceInvoicesPreview-pdfGet', (req, res) => {
  const folio = getFolio(requiredStringParam(req, 'folioId'));
  const property = getProperty(folio.propertyId);
  const langs = languagesOf(arrayParam(req, 'languages'), folio.propertyId);
  const lineItems = lineItemsFor(folio, langs[0] ?? 'en');
  const total = round(lineItems.reduce((s, x) => s + x.price.amount, 0), folio.currency);
  sendInvoicePdf(res, {
    number: 'PREVIEW',
    invoiceDate: property.businessDate,
    currency: folio.currency,
    lineItems,
    total,
    recipient: folio.debitor,
    propertyId: property.id,
  } as Invoice, `preview-${folio.id}`);
});

/**
 * Render the invoice as a small but genuinely valid PDF, so a client that
 * downloads it gets a file its viewer will open rather than a stub.
 */
function sendInvoicePdf(res: Response, invoice: Invoice, filename: string): void {
  const property = db.properties.get(invoice.propertyId);
  const lines: string[] = [];
  lines.push(property?.companyName ?? 'Invoice');
  if (property) {
    lines.push(`${property.location.addressLine1}, ${property.location.postalCode} ${property.location.city}`);
    lines.push(`Tax ID ${property.taxId}`);
  }
  lines.push('');
  lines.push(`Invoice ${invoice.number}`);
  lines.push(`Date ${invoice.invoiceDate}`);
  if (invoice.recipient?.name) lines.push(`To ${invoice.recipient.name}`);
  if (invoice.recipient?.company?.name) lines.push(invoice.recipient.company.name);
  lines.push('');
  for (const item of invoice.lineItems) {
    const amount = `${item.price.amount.toFixed(2)} ${item.price.currency}`;
    lines.push(`${item.date}  ${truncate(item.description, 40).padEnd(42)}${amount.padStart(14)}`);
  }
  lines.push('');
  lines.push(`${'Total'.padEnd(52)}${`${invoice.total.toFixed(2)} ${invoice.currency}`.padStart(14)}`);

  const pdf = buildPdf(lines);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}.pdf"`);
  res.setHeader('Content-Length', String(pdf.length));
  res.status(200).send(pdf);
}

const truncate = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);

/** Minimal single-page PDF writer: enough for a readable invoice. */
function buildPdf(lines: readonly string[]): Buffer {
  const escape = (s: string) => s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)')
    // The base-14 Courier encoding is Latin-1; drop anything outside it.
    .replace(/[^\x20-\x7E]/g, '?');

  const content = [
    'BT',
    '/F1 10 Tf',
    '12 TL',
    '56 780 Td',
    ...lines.map((line) => `(${escape(line)}) Tj T*`),
    'ET',
  ].join('\n');

  const objects: string[] = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>',
  ];

  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, index) => {
    offsets.push(Buffer.byteLength(pdf, 'latin1'));
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefOffset = Buffer.byteLength(pdf, 'latin1');
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  return Buffer.from(pdf, 'latin1');
}

api.op('FinanceInvoice-actionsByIdPayPut', (req, res) => {
  const i = getInvoice(req.params.id!);
  const body = req.body as { paymentMethod: string; receipt: string };
  transact(() => payInvoice(i, body.paymentMethod, body.receipt));
  sendNoContent(res);
});

api.op('FinanceInvoice-actionsByIdCancelPut', (req, res) => {
  const i = getInvoice(req.params.id!);
  const body = req.body as { reasonCode: Invoice['cancellationReasonCode'] };
  cancelInvoice(i, body.reasonCode!);
  sendNoContent(res);
});

/* --------------------------------------------------------------- routings */

function routingBody(r: Routing) {
  const target = db.folios.get(r.targetFolioId);
  return {
    id: r.id,
    bookingId: r.bookingId,
    propertyId: r.propertyId,
    filter: {
      folioIds: r.filter.folioIds.length ? r.filter.folioIds : undefined,
      subAccounts: r.filter.subAccountIds.length
        ? r.filter.subAccountIds.map((id) => ({ id }))
        : undefined,
      serviceTypes: r.filter.serviceTypes.length ? r.filter.serviceTypes : undefined,
      services: r.filter.serviceIds.length
        ? r.filter.serviceIds.map((id) => {
          const service = db.services.get(id);
          return { id, code: service?.code, name: resolveLocalized(service?.name, ['en']) };
        })
        : undefined,
      from: r.filter.from,
      to: r.filter.to,
    },
    destinationFolio: { id: r.targetFolioId, debitorType: target?.debitor.type },
    actions: [{ action: 'Delete', isAllowed: true }],
  };
}

api.op('FinanceRoutingsPost', (req, res) => {
  const body = req.body as Record<string, any>;
  const property = getProperty(body.propertyId);
  const booking = db.bookings.get(body.bookingId);
  if (!booking) throw unprocessable(`Booking '${body.bookingId}' does not exist.`);
  const target = getFolio(body.destinationFolioId);
  if (target.propertyId !== property.id) {
    throw unprocessable('The destination folio belongs to a different property.');
  }
  if (target.isClosed) throw unprocessable('The destination folio is closed.');

  const created = transact(() => {
    const routing: Routing = {
      id: `${property.id}-RT-${nextSeq(`routing:${property.id}`)}`,
      propertyId: property.id,
      bookingId: booking.id,
      targetFolioId: target.id,
      filter: {
        folioIds: body.filter?.folioIds ?? [],
        subAccountIds: body.filter?.subAccountIds ?? [],
        serviceTypes: body.filter?.serviceTypes ?? [],
        serviceIds: body.filter?.serviceIds ?? [],
        from: body.filter?.from,
        to: body.filter?.to,
      },
      created: nowIso(),
      createdBy: req.principal?.clientId,
    };
    db.routings.put(routing);
    // Sweep up anything already posted that the new rule claims.
    applyRoutings(booking.id);
    return routing;
  });
  sendCreated(res, `/finance/v1/routings/${created.id}`, { id: created.id });
});

api.op('FinanceRoutingsGet', (req, res) => {
  const routingIds = arrayParam(req, 'routingIds');
  const bookingIds = arrayParam(req, 'bookingIds');
  const propertyIds = arrayParam(req, 'propertyIds');
  const sourceFolioIds = arrayParam(req, 'sourceFolioIds');
  const destinationFolioIds = arrayParam(req, 'destinationFolioIds');
  const page = paging(req);

  const { items, count } = db.routings.query({
    filter: (r) => {
      if (routingIds.length && !routingIds.includes(r.id)) return false;
      if (bookingIds.length && !bookingIds.includes(r.bookingId)) return false;
      if (propertyIds.length && !propertyIds.includes(r.propertyId)) return false;
      if (destinationFolioIds.length && !destinationFolioIds.includes(r.targetFolioId)) return false;
      if (sourceFolioIds.length && !sourceFolioIds.some((id) => r.filter.folioIds.includes(id))) return false;
      return true;
    },
    sort: (a, b) => a.created.localeCompare(b.created),
    offset: page.offset,
    limit: page.pageSize,
  });
  sendList(res, 'routings', items.map(routingBody), count);
});

api.op('FinanceRoutingsByIdGet', (req, res) => {
  const r = db.routings.get(req.params.id!);
  if (!r) throw notFound(`Routing '${req.params.id}' was not found.`);
  res.json(routingBody(r));
});

api.op('FinanceRoutingsByIdPatch', (req, res) => {
  const r = db.routings.get(req.params.id!);
  if (!r) throw notFound(`Routing '${req.params.id}' was not found.`);
  const ops = req.body as PatchOperation[];
  rejectImmutablePaths(ops, ['/id', '/propertyId', '/bookingId']);
  const view = { filter: r.filter, destinationFolioId: r.targetFolioId };
  const patched = applyPatch(view, ops) as typeof view;
  if (patched.destinationFolioId !== r.targetFolioId) getFolio(patched.destinationFolioId);
  r.filter = {
    folioIds: patched.filter?.folioIds ?? [],
    subAccountIds: patched.filter?.subAccountIds ?? [],
    serviceTypes: patched.filter?.serviceTypes ?? [],
    serviceIds: patched.filter?.serviceIds ?? [],
    from: patched.filter?.from,
    to: patched.filter?.to,
  };
  r.targetFolioId = patched.destinationFolioId;
  transact(() => {
    db.routings.put(r);
    applyRoutings(r.bookingId);
  });
  sendNoContent(res);
});

api.op('FinanceRoutingsByIdDelete', (req, res) => {
  const id = req.params.id!;
  if (!db.routings.exists(id)) throw notFound(`Routing '${id}' was not found.`);
  db.routings.delete(id);
  sendNoContent(res);
});

/* --------------------------------------------------------- sub-ledger */

function exportAccount(propertyId: string, number: string, langs: readonly string[]) {
  const account = db.financeAccounts.get(`${propertyId}-${number}`);
  return {
    number,
    name: account ? resolveLocalized(account.name, langs) ?? number : number,
    parentNumber: account?.parentNumber,
    type: account?.type ?? 'House',
  };
}

function slimAccount(propertyId: string, number: string, langs: readonly string[], depth: number): Record<string, unknown> | undefined {
  const account = db.financeAccounts.get(`${propertyId}-${number}`);
  if (!account) return undefined;
  const children = db.financeAccounts.all({ propertyId, parentNumber: number });
  return {
    accountNumber: account.number,
    name: resolveLocalized(account.name, langs) ?? account.number,
    type: account.type,
    parentNumber: account.parentNumber,
    hasChildren: children.length > 0,
    isArchived: account.isArchived,
    subAccounts: depth > 0
      ? children.map((c) => slimAccount(propertyId, c.number, langs, depth - 1)).filter(Boolean)
      : undefined,
  };
}

api.op('FinanceAccountsSchemaGet', (req, res) => {
  const property = getProperty(requiredStringParam(req, 'propertyId'));
  const depth = Number(stringParam(req, 'depth') ?? 3);
  const includeArchived = boolParam(req, 'includeArchived') ?? false;
  const langs = [stringParam(req, 'languageCode') ?? 'en'];

  const all = db.financeAccounts.all({ propertyId: property.id })
    .filter((a) => includeArchived || !a.isArchived);
  const roots = all.filter((a) => a.scope === 'Global' && !a.parentNumber);

  res.json({
    globalAccounts: roots.map((a) => slimAccount(property.id, a.number, langs, depth)).filter(Boolean),
    guestAccounts: all.filter((a) => a.scope === 'Guest')
      .map((a) => slimAccount(property.id, a.number, langs, 0)).filter(Boolean),
    externalAccounts: all.filter((a) => a.scope === 'External')
      .map((a) => slimAccount(property.id, a.number, langs, 0)).filter(Boolean),
    bookingAccounts: all.filter((a) => a.scope === 'Booking')
      .map((a) => slimAccount(property.id, a.number, langs, 0)).filter(Boolean),
  });
});

api.op('FinanceGlobal-accountsGet', (req, res) => {
  const property = getProperty(requiredStringParam(req, 'propertyId'));
  const parent = requiredStringParam(req, 'parent');
  const includeArchived = boolParam(req, 'includeArchived') ?? false;
  const langs = [stringParam(req, 'languageCode') ?? 'en'];
  const page = paging(req);
  const all = db.financeAccounts.all({ propertyId: property.id, scope: 'Global', parentNumber: parent })
    .filter((a) => includeArchived || !a.isArchived);
  sendList(res, 'accounts',
    all.slice(page.offset, page.offset + page.pageSize)
      .map((a) => slimAccount(property.id, a.number, langs, 0)),
    all.length);
});

api.op('FinanceAccountsChild-accountsGet', (req, res) => {
  const property = getProperty(requiredStringParam(req, 'propertyId'));
  const parent = requiredStringParam(req, 'parent');
  const includeArchived = boolParam(req, 'includeArchived') ?? false;
  const langs = [stringParam(req, 'languageCode') ?? 'en'];
  const page = paging(req);
  const all = db.financeAccounts.all({ propertyId: property.id, parentNumber: parent })
    .filter((a) => includeArchived || !a.isArchived);
  sendList(res, 'accounts',
    all.slice(page.offset, page.offset + page.pageSize)
      .map((a) => slimAccount(property.id, a.number, langs, 0)),
    all.length);
});

api.op('FinanceGuest-accountsGet', (req, res) => {
  const property = getProperty(requiredStringParam(req, 'propertyId'));
  const reservationId = requiredStringParam(req, 'reservationId');
  const langs = [stringParam(req, 'languageCode') ?? 'en'];
  const page = paging(req);
  const all = db.financeAccounts.all({ propertyId: property.id, scope: 'Guest', reference: reservationId });
  sendList(res, 'accounts',
    all.slice(page.offset, page.offset + page.pageSize)
      .map((a) => slimAccount(property.id, a.number, langs, 0)),
    all.length);
});

api.op('FinanceExternal-accountsGet', (req, res) => {
  const property = getProperty(requiredStringParam(req, 'propertyId'));
  const folioId = requiredStringParam(req, 'folioId');
  const langs = [stringParam(req, 'languageCode') ?? 'en'];
  const page = paging(req);
  const all = db.financeAccounts.all({ propertyId: property.id, scope: 'External', reference: folioId });
  sendList(res, 'accounts',
    all.slice(page.offset, page.offset + page.pageSize)
      .map((a) => slimAccount(property.id, a.number, langs, 0)),
    all.length);
});

api.op('FinanceAccountsByNumberGet', (req, res) => {
  const property = getProperty(requiredStringParam(req, 'propertyId'));
  const number = req.params.number!;
  const account = db.financeAccounts.get(`${property.id}-${number}`);
  if (!account) throw notFound(`Account '${number}' was not found in property '${property.id}'.`);
  const langs = [stringParam(req, 'languageCode') ?? 'en'];
  const limit = Number(stringParam(req, 'transactionLimit') ?? 100);

  const transactions = db.accountingTransactions
    .all({ propertyId: property.id })
    .filter((t) => t.debitedAccount === number || t.creditedAccount === number)
    .sort((a, b) => b.entryNumber.localeCompare(a.entryNumber))
    .slice(0, limit);

  res.json({
    accountNumber: account.number,
    name: resolveLocalized(account.name, langs) ?? account.number,
    type: account.type,
    hasChildren: db.financeAccounts.count({ propertyId: property.id, parentNumber: number }) > 0,
    parentNumber: account.parentNumber,
    isArchived: account.isArchived,
    transactions: transactions.map((t) => transactionBody(t, property.id, langs)),
  });
});

function transactionBody(
  t: import('../domain/types').AccountingTransaction,
  propertyId: string,
  langs: readonly string[],
) {
  return {
    timestamp: t.timestamp,
    date: t.date,
    debitedAccount: exportAccount(propertyId, t.debitedAccount, langs),
    creditedAccount: exportAccount(propertyId, t.creditedAccount, langs),
    command: t.command,
    amount: { amount: t.amount.amount, currency: t.amount.currency },
    receipt: t.receipt ? { type: 'Custom', number: t.receipt } : undefined,
    entryNumber: t.entryNumber,
    reference: t.reference,
    referenceType: t.referenceType,
    entryGroupNumber: t.entryGroupNumber,
  };
}

/* ------------------------------------------------------------- exporting */

interface ExportScope {
  propertyId: string;
  from: string;
  to: string;
  accountNumber?: string;
  accountType?: string;
  langs: string[];
}

function exportScope(req: Request): ExportScope {
  const propertyId = requiredStringParam(req, 'propertyId');
  getProperty(propertyId);
  return {
    propertyId,
    from: requiredDateParam(req, 'from'),
    to: requiredDateParam(req, 'to'),
    accountNumber: stringParam(req, 'accountNumber'),
    accountType: stringParam(req, 'accountType'),
    langs: [stringParam(req, 'languageCode') ?? 'en'],
  };
}

function transactionsIn(scope: ExportScope) {
  return db.accountingTransactions
    .all({ propertyId: scope.propertyId })
    .filter((t) => {
      if (t.date < scope.from || t.date > scope.to) return false;
      if (scope.accountNumber
        && t.debitedAccount !== scope.accountNumber && t.creditedAccount !== scope.accountNumber) return false;
      if (scope.accountType) {
        const debited = db.financeAccounts.get(`${scope.propertyId}-${t.debitedAccount}`);
        const credited = db.financeAccounts.get(`${scope.propertyId}-${t.creditedAccount}`);
        if (debited?.type !== scope.accountType && credited?.type !== scope.accountType) return false;
      }
      return true;
    })
    .sort((a, b) => a.entryNumber.localeCompare(b.entryNumber));
}

/** Journal an export run so the Logs API can report it. */
function recordExport(req: Request, scope: ExportScope, type: 'Raw' | 'Aggregate' | 'AggregatePairs'): void {
  db.transactionExportLogs.put({
    id: `${scope.propertyId}-EX-${nextSeq(`export:${scope.propertyId}`)}`,
    propertyId: scope.propertyId,
    periodStart: scope.from,
    periodEnd: scope.to,
    type,
    clientId: req.principal?.clientId ?? 'unknown',
    subjectId: req.principal?.subject ?? 'unknown',
    created: nowIso(),
  });
}

api.op('FinanceAccountsExportPost', (req, res) => {
  const scope = exportScope(req);
  recordExport(req, scope, 'Raw');
  res.json({
    transactions: transactionsIn(scope).map((t) => transactionBody(t, scope.propertyId, scope.langs)),
  });
});

api.op('FinanceAccountsExport-dailyPost', (req, res) => {
  const scope = exportScope(req);
  const reference = stringParam(req, 'reference');
  recordExport(req, scope, 'Raw');
  // Daily export collapses each account pair into one entry per business day.
  const byKey = new Map<string, { date: string; debited: string; credited: string; amount: number; currency: string }>();
  for (const t of transactionsIn(scope)) {
    const key = `${t.date}|${t.debitedAccount}|${t.creditedAccount}|${t.amount.currency}`;
    const entry = byKey.get(key)
      ?? { date: t.date, debited: t.debitedAccount, credited: t.creditedAccount, amount: 0, currency: t.amount.currency };
    entry.amount += t.amount.amount;
    byKey.set(key, entry);
  }
  const transactions = [...byKey.values()]
    .sort((a, b) => a.date.localeCompare(b.date) || a.debited.localeCompare(b.debited))
    .map((e, index) => ({
      timestamp: `${e.date}T00:00:00Z`,
      date: e.date,
      debitedAccount: exportAccount(scope.propertyId, e.debited, scope.langs),
      creditedAccount: exportAccount(scope.propertyId, e.credited, scope.langs),
      command: 'System',
      amount: { amount: round(e.amount, e.currency), currency: e.currency },
      entryNumber: String(index + 1).padStart(10, '0'),
      entryGroupNumber: e.date.replace(/-/g, ''),
      reference: reference ?? e.date,
      referenceType: 'House',
    }));
  res.json({ transactions });
});

api.op('FinanceAccountsExport-gross-dailyPost', (req, res) => {
  const propertyId = requiredStringParam(req, 'propertyId');
  const property = getProperty(propertyId);
  const from = requiredDateParam(req, 'from');
  const to = requiredDateParam(req, 'to');
  const reference = stringParam(req, 'reference');
  const langs = ['en'];
  recordExport(req, { propertyId, from, to, langs }, 'Raw');

  // The gross export keeps charges whole, with their VAT alongside rather
  // than as a separate line - which is what most bookkeeping imports want.
  const rows: Record<string, unknown>[] = [];
  for (const date of datesInclusive(from, to)) {
    const charges = db.charges.all({ propertyId, serviceDate: date });
    const byAccount = new Map<string, { gross: number; net: number; taxes: Map<string, { percent: number; amount: number }> }>();
    for (const charge of charges) {
      const account = charge.subAccountId ?? ACCOUNTS.otherRevenue;
      const entry = byAccount.get(account) ?? { gross: 0, net: 0, taxes: new Map() };
      entry.gross += charge.amount.grossAmount;
      entry.net += charge.amount.netAmount;
      const tax = entry.taxes.get(charge.amount.vatType) ?? { percent: charge.amount.vatPercent, amount: 0 };
      tax.amount += charge.amount.grossAmount - charge.amount.netAmount;
      entry.taxes.set(charge.amount.vatType, tax);
      byAccount.set(account, entry);
    }
    for (const [account, entry] of byAccount) {
      rows.push({
        timestamp: `${date}T00:00:00Z`,
        date,
        debitedAccount: exportAccount(propertyId, ACCOUNTS.accountsReceivable, langs),
        creditedAccount: exportAccount(propertyId, account, langs),
        command: 'PostCharge',
        currency: property.currencyCode,
        grossAmount: round(entry.gross, property.currencyCode),
        netAmount: round(entry.net, property.currencyCode),
        taxes: [...entry.taxes.entries()].map(([type, t]) => ({
          type,
          percent: t.percent,
          amount: round(t.amount, property.currencyCode),
        })),
        receipt: { type: 'Custom', number: reference ?? date },
        sourceEntryNumber: date.replace(/-/g, ''),
        reference: reference ?? date,
        referenceType: 'House',
      });
    }
  }
  res.json({ transactions: rows });
});

api.op('FinanceAccountsAggregatePost', (req, res) => {
  const scope = exportScope(req);
  recordExport(req, scope, 'Aggregate');
  res.json(aggregate(scope, transactionsIn(scope)));
});

api.op('FinanceAccountsAggregate-dailyPost', (req, res) => {
  const scope = exportScope(req);
  recordExport(req, scope, 'Aggregate');
  // Same shape, but the aggregation runs per business day.
  const all = transactionsIn(scope);
  const currency = db.properties.get(scope.propertyId)?.currencyCode ?? 'EUR';
  const aggregations: Record<string, unknown>[] = [];
  const totals = { debited: 0, credited: 0 };
  for (const date of datesInclusive(scope.from, scope.to)) {
    const perDay = all.filter((t) => t.date === date);
    if (!perDay.length) continue;
    const result = aggregate(scope, perDay);
    for (const row of result.aggregations) {
      aggregations.push({ ...row, date });
    }
    totals.debited += result.total.debitedAmount.amount;
    totals.credited += result.total.creditedAmount.amount;
  }
  res.json({
    aggregations,
    total: {
      debitedAmount: { amount: round(totals.debited, currency), currency },
      creditedAmount: { amount: round(totals.credited, currency), currency },
      balance: { amount: round(totals.debited - totals.credited, currency), currency },
    },
  });
});

function aggregate(scope: ExportScope, transactions: readonly import('../domain/types').AccountingTransaction[]) {
  const currency = db.properties.get(scope.propertyId)?.currencyCode ?? 'EUR';
  const byAccount = new Map<string, { debited: number; credited: number }>();
  for (const t of transactions) {
    const debited = byAccount.get(t.debitedAccount) ?? { debited: 0, credited: 0 };
    debited.debited += t.amount.amount;
    byAccount.set(t.debitedAccount, debited);
    const credited = byAccount.get(t.creditedAccount) ?? { debited: 0, credited: 0 };
    credited.credited += t.amount.amount;
    byAccount.set(t.creditedAccount, credited);
  }
  let totalDebited = 0;
  let totalCredited = 0;
  const aggregations = [...byAccount.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([number, v]) => {
      totalDebited += v.debited;
      totalCredited += v.credited;
      return {
        account: exportAccount(scope.propertyId, number, scope.langs),
        debitedAmount: { amount: round(v.debited, currency), currency },
        creditedAmount: { amount: round(v.credited, currency), currency },
        balance: { amount: round(v.debited - v.credited, currency), currency },
      };
    });
  return {
    aggregations,
    total: {
      debitedAmount: { amount: round(totalDebited, currency), currency },
      creditedAmount: { amount: round(totalCredited, currency), currency },
      balance: { amount: round(totalDebited - totalCredited, currency), currency },
    },
  };
}

api.op('FinanceAccountsAggregate-pairs-dailyPost', (req, res) => {
  const scope = exportScope(req);
  recordExport(req, scope, 'AggregatePairs');
  // Pairs keep the debit/credit relationship rather than flattening per account.
  const currency = db.properties.get(scope.propertyId)?.currencyCode ?? 'EUR';
  const byPair = new Map<string, { debited: string; credited: string; amount: number }>();
  for (const t of transactionsIn(scope)) {
    const key = `${t.debitedAccount}|${t.creditedAccount}`;
    const entry = byPair.get(key) ?? { debited: t.debitedAccount, credited: t.creditedAccount, amount: 0 };
    entry.amount += t.amount.amount;
    byPair.set(key, entry);
  }
  res.json({
    transactions: [...byPair.values()]
      .sort((a, b) => a.debited.localeCompare(b.debited) || a.credited.localeCompare(b.credited))
      .map((e) => ({
        debitedAccount: exportAccount(scope.propertyId, e.debited, scope.langs),
        creditedAccount: exportAccount(scope.propertyId, e.credited, scope.langs),
        amount: { amount: round(e.amount, currency), currency },
      })),
  });
});

/* ----------------------------------------------------------------- types */

api.op('FinanceTypesCurrenciesGet', (_req, res) => {
  res.json({ isoCurrencies: CURRENCY_CODES });
});

api.op('FinanceTypesPayment-methodsGet', (_req, res) => {
  res.json({ paymentMethods: PAYMENT_METHODS });
});

api.op('FinanceTypesService-typesGet', (_req, res) => {
  res.json({ serviceTypes: SERVICE_TYPES });
});

api.op('FinanceTypesVatGet', (req, res) => {
  const countryCode = stringParam(req, 'countryCode');
  res.json({
    vatTypes: VAT_TYPES.map((type) => ({
      type,
      percent: DEFAULT_VAT_RATES[type],
      countryCode: countryCode ?? 'DE',
    })),
  });
});

export const financeRouter = api.build();
