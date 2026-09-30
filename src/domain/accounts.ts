import { nextSeq } from '../core/db';
import { nowIso } from '../core/dates';
import { money, type MonetaryValue } from '../core/money';
import { db } from './repo';
import type {
  AccountingCommand, AccountingTransaction, FinanceAccount, FinanceAccountType, Property,
} from './types';

/**
 * The property's chart of accounts and its double-entry journal.
 *
 * apaleo keeps a real sub-ledger: every charge, payment and transfer produces
 * balanced transactions between numbered accounts, which is what the Finance
 * API's export endpoints hand to a bookkeeping system. Posting through here
 * rather than only mutating folio totals is what makes those exports add up.
 */

/**
 * The default chart. Numbers follow the shape apaleo's demo account uses:
 * a small tree, parents ending in 000, leaves underneath.
 */
const DEFAULT_CHART: { number: string; name: string; type: FinanceAccountType; parent?: string }[] = [
  { number: '1000', name: 'Revenues', type: 'Revenues' },
  { number: '1100', name: 'Accommodation revenue', type: 'Revenues', parent: '1000' },
  { number: '1200', name: 'Food and beverage revenue', type: 'Revenues', parent: '1000' },
  { number: '1300', name: 'Other revenue', type: 'Revenues', parent: '1000' },
  { number: '1400', name: 'Cancellation fees', type: 'Revenues', parent: '1000' },
  { number: '1500', name: 'No-show fees', type: 'Revenues', parent: '1000' },

  { number: '2000', name: 'Payments', type: 'Payments' },
  { number: '2100', name: 'Cash', type: 'Payments', parent: '2000' },
  { number: '2200', name: 'Credit card', type: 'Payments', parent: '2000' },
  { number: '2300', name: 'Bank transfer', type: 'Payments', parent: '2000' },
  { number: '2400', name: 'Other payment methods', type: 'Payments', parent: '2000' },

  { number: '3000', name: 'Liabilities', type: 'Liabilities' },
  { number: '3100', name: 'Prepayments', type: 'Liabilities', parent: '3000' },
  { number: '3200', name: 'VAT on liabilities', type: 'VatOnLiabilities', parent: '3000' },

  { number: '4000', name: 'Receivables', type: 'Receivables' },
  { number: '4100', name: 'Accounts receivable', type: 'AccountsReceivable', parent: '4000' },
  { number: '4200', name: 'Loss of accounts receivable', type: 'LossOfAccountsReceivable', parent: '4000' },

  { number: '5000', name: 'VAT', type: 'Vat' },

  { number: '6000', name: 'City taxes', type: 'CityTaxes' },
  { number: '6100', name: 'Second city tax', type: 'SecondCityTax', parent: '6000' },
  { number: '6200', name: 'Guest levies', type: 'GuestLevies', parent: '6000' },

  { number: '7000', name: 'Transitory items', type: 'TransitoryItems' },

  { number: '9000', name: 'House', type: 'House' },
];

/** Well-known account numbers the posting logic reaches for by name. */
export const ACCOUNTS = {
  accommodationRevenue: '1100',
  foodAndBeverageRevenue: '1200',
  otherRevenue: '1300',
  cancellationFees: '1400',
  noShowFees: '1500',
  cash: '2100',
  creditCard: '2200',
  bankTransfer: '2300',
  otherPayment: '2400',
  prepayments: '3100',
  accountsReceivable: '4100',
  lossOfAccountsReceivable: '4200',
  vat: '5000',
  cityTax: '6000',
  secondCityTax: '6100',
  transitory: '7000',
  house: '9000',
} as const;

export const accountId = (propertyId: string, number: string) => `${propertyId}-${number}`;

/** Install the default chart of accounts for a new property. */
export function bootstrapChartOfAccounts(property: Property): void {
  for (const entry of DEFAULT_CHART) {
    db.financeAccounts.put({
      id: accountId(property.id, entry.number),
      propertyId: property.id,
      number: entry.number,
      name: { en: entry.name },
      type: entry.type,
      parentNumber: entry.parent,
      scope: 'Global',
      isArchived: false,
    });
  }
}

export function account(propertyId: string, number: string): FinanceAccount | undefined {
  return db.financeAccounts.get(accountId(propertyId, number));
}

/** Map a payment method onto the payment account that receives it. */
export function accountForPaymentMethod(method: string): string {
  switch (method) {
    case 'Cash':
      return ACCOUNTS.cash;
    case 'BankTransfer':
      return ACCOUNTS.bankTransfer;
    case 'CreditCard': case 'Amex': case 'VisaCredit': case 'VisaDebit': case 'MasterCard':
    case 'MasterCardDebit': case 'Maestro': case 'GiroCard': case 'DiscoverCard': case 'Diners':
    case 'Jcb': case 'VPay': case 'ChinaUnionPay':
      return ACCOUNTS.creditCard;
    default:
      return ACCOUNTS.otherPayment;
  }
}

/** Map a service type onto the revenue account it credits. */
export function accountForServiceType(serviceType: string): string {
  switch (serviceType) {
    case 'Accommodation':
      return ACCOUNTS.accommodationRevenue;
    case 'FoodAndBeverages':
      return ACCOUNTS.foodAndBeverageRevenue;
    case 'CancellationFees':
      return ACCOUNTS.cancellationFees;
    case 'NoShow':
      return ACCOUNTS.noShowFees;
    case 'CityTax':
      return ACCOUNTS.cityTax;
    case 'SecondCityTax':
      return ACCOUNTS.secondCityTax;
    default:
      return ACCOUNTS.otherRevenue;
  }
}

export interface PostingLine {
  debitedAccount: string;
  creditedAccount: string;
  amount: MonetaryValue;
  receipt?: string;
}

export interface PostingContext {
  propertyId: string;
  date: string;
  command: AccountingCommand;
  reference: string;
  referenceType: 'House' | 'Guest' | 'External' | 'Booking';
}

/**
 * Post a balanced set of lines as one journal entry. Lines posted together
 * share an entry group so the export can reconstruct the original operation.
 */
export function post(ctx: PostingContext, lines: readonly PostingLine[]): AccountingTransaction[] {
  const entryGroupNumber = String(nextSeq(`entryGroup:${ctx.propertyId}`)).padStart(8, '0');
  const timestamp = nowIso();
  const out: AccountingTransaction[] = [];

  for (const line of lines) {
    if (line.amount.amount === 0) continue;
    const entryNumber = String(nextSeq(`entry:${ctx.propertyId}`)).padStart(10, '0');
    const tx: AccountingTransaction = {
      id: `${ctx.propertyId}-TX-${entryNumber}`,
      propertyId: ctx.propertyId,
      timestamp,
      date: ctx.date,
      debitedAccount: line.debitedAccount,
      creditedAccount: line.creditedAccount,
      command: ctx.command,
      amount: line.amount,
      receipt: line.receipt,
      entryNumber,
      entryGroupNumber,
      reference: ctx.reference,
      referenceType: ctx.referenceType,
    };
    db.accountingTransactions.put(tx);
    out.push(tx);
  }
  return out;
}

/**
 * Posting a charge: the guest owes the house, so the guest ledger is debited
 * and revenue plus VAT are credited.
 */
export function postCharge(
  ctx: Omit<PostingContext, 'command'>,
  args: {
    guestAccount: string;
    revenueAccount: string;
    grossAmount: number;
    netAmount: number;
    currency: string;
    receipt?: string;
  },
): AccountingTransaction[] {
  const vat = args.grossAmount - args.netAmount;
  return post({ ...ctx, command: 'PostCharge' }, [
    {
      debitedAccount: args.guestAccount,
      creditedAccount: args.revenueAccount,
      amount: money(args.netAmount, args.currency),
      receipt: args.receipt,
    },
    ...(vat !== 0
      ? [{
        debitedAccount: args.guestAccount,
        creditedAccount: ACCOUNTS.vat,
        amount: money(vat, args.currency),
        receipt: args.receipt,
      }]
      : []),
  ]);
}

/** Posting a payment: the payment account receives, the guest ledger clears. */
export function postPayment(
  ctx: Omit<PostingContext, 'command'>,
  args: { guestAccount: string; paymentAccount: string; amount: number; currency: string; receipt?: string },
): AccountingTransaction[] {
  return post({ ...ctx, command: 'PostPayment' }, [
    {
      debitedAccount: args.paymentAccount,
      creditedAccount: args.guestAccount,
      amount: money(args.amount, args.currency),
      receipt: args.receipt,
    },
  ]);
}

/** Moving a line item between folios moves it between their guest accounts. */
export function postTransfer(
  ctx: Omit<PostingContext, 'command'>,
  args: { fromAccount: string; toAccount: string; amount: number; currency: string; receipt?: string },
): AccountingTransaction[] {
  return post({ ...ctx, command: 'MoveLineItem' }, [
    {
      debitedAccount: args.toAccount,
      creditedAccount: args.fromAccount,
      amount: money(args.amount, args.currency),
      receipt: args.receipt,
    },
  ]);
}

/**
 * The per-reservation guest account. Created lazily so the chart only grows
 * with reservations that actually post something.
 */
export function guestAccountNumber(reservationId: string): string {
  return `G-${reservationId}`;
}

export function externalAccountNumber(folioId: string): string {
  return `E-${folioId}`;
}

export function ensureGuestAccount(propertyId: string, reservationId: string, name: string): string {
  const number = guestAccountNumber(reservationId);
  const id = accountId(propertyId, number);
  if (!db.financeAccounts.exists(id)) {
    db.financeAccounts.put({
      id,
      propertyId,
      number,
      name: { en: name },
      type: 'Receivables',
      parentNumber: ACCOUNTS.accountsReceivable,
      scope: 'Guest',
      reference: reservationId,
      isArchived: false,
    });
  }
  return number;
}

export function ensureExternalAccount(propertyId: string, folioId: string, name: string): string {
  const number = externalAccountNumber(folioId);
  const id = accountId(propertyId, number);
  if (!db.financeAccounts.exists(id)) {
    db.financeAccounts.put({
      id,
      propertyId,
      number,
      name: { en: name },
      type: 'Receivables',
      parentNumber: ACCOUNTS.accountsReceivable,
      scope: 'External',
      reference: folioId,
      isArchived: false,
    });
  }
  return number;
}

/** Net movement on an account over a date range. */
export function balanceOf(propertyId: string, accountNumber: string, from?: string, to?: string): number {
  let total = 0;
  for (const tx of db.accountingTransactions.all({ propertyId })) {
    if (from && tx.date < from) continue;
    if (to && tx.date > to) continue;
    if (tx.debitedAccount === accountNumber) total += tx.amount.amount;
    if (tx.creditedAccount === accountNumber) total -= tx.amount.amount;
  }
  return Math.round(total * 100) / 100;
}
