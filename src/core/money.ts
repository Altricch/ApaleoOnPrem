/**
 * apaleo posts everything gross-first: a charge carries a gross amount, a VAT
 * type and the derived net/VAT split. Rounding is to the currency's minor unit
 * and happens at every boundary, so we centralise it here rather than letting
 * floating point drift through the folio.
 */

export interface MonetaryValue {
  amount: number;
  currency: string;
}

export interface AmountModel {
  grossAmount: number;
  netAmount: number;
  vatType: VatType;
  vatPercent: number;
  currency: string;
}

export type VatType =
  | 'Null'
  | 'VeryReduced'
  | 'Reduced'
  | 'Normal'
  | 'Without'
  | 'Special'
  | 'ReducedCovid19'
  | 'NormalCovid19';

/**
 * VAT percentages are per-country in the real product. We keep a per-property
 * override table and fall back to the German rates apaleo's demo data uses.
 */
export const DEFAULT_VAT_RATES: Record<VatType, number> = {
  Null: 0,
  Without: 0,
  VeryReduced: 5,
  Reduced: 7,
  Normal: 19,
  Special: 10.7,
  ReducedCovid19: 5,
  NormalCovid19: 16,
};

/** Currencies whose minor unit is not 1/100. */
const MINOR_UNITS: Record<string, number> = {
  JPY: 0, KRW: 0, VND: 0, CLP: 0, ISK: 0, HUF: 0, TWD: 0,
  BHD: 3, JOD: 3, KWD: 3, OMR: 3, TND: 3,
};

export function minorUnits(currency: string): number {
  return MINOR_UNITS[currency?.toUpperCase()] ?? 2;
}

export function round(amount: number, currency: string): number {
  const digits = minorUnits(currency);
  const factor = 10 ** digits;
  // Round half away from zero, matching how money is normally rounded, and
  // nudge by an epsilon so 1.005 does not fall foul of binary representation.
  const scaled = amount * factor;
  const rounded = Math.sign(scaled) * Math.round(Math.abs(scaled) + Number.EPSILON * Math.abs(scaled));
  return rounded / factor;
}

export function money(amount: number, currency: string): MonetaryValue {
  return { amount: round(amount, currency), currency };
}

export function addMoney(a: MonetaryValue, b: MonetaryValue): MonetaryValue {
  if (a.currency !== b.currency) {
    throw new Error(`Cannot add ${a.currency} to ${b.currency}`);
  }
  return money(a.amount + b.amount, a.currency);
}

export function sumMoney(values: readonly MonetaryValue[], currency: string): MonetaryValue {
  return money(values.reduce((acc, v) => acc + (v?.amount ?? 0), 0), currency);
}

export function negate(v: MonetaryValue): MonetaryValue {
  return { amount: round(-v.amount, v.currency), currency: v.currency };
}

/** Split a gross amount into net + VAT for the given VAT type. */
export function grossToAmount(gross: number, vatType: VatType, currency: string, rates = DEFAULT_VAT_RATES): AmountModel {
  const vatPercent = rates[vatType] ?? 0;
  const net = gross / (1 + vatPercent / 100);
  return {
    grossAmount: round(gross, currency),
    netAmount: round(net, currency),
    vatType,
    vatPercent,
    currency,
  };
}

export function netToAmount(net: number, vatType: VatType, currency: string, rates = DEFAULT_VAT_RATES): AmountModel {
  const vatPercent = rates[vatType] ?? 0;
  return {
    grossAmount: round(net * (1 + vatPercent / 100), currency),
    netAmount: round(net, currency),
    vatType,
    vatPercent,
    currency,
  };
}

export const vatOf = (a: AmountModel): number => round(a.grossAmount - a.netAmount, a.currency);

export function zeroAmount(currency: string, vatType: VatType = 'Null'): AmountModel {
  return { grossAmount: 0, netAmount: 0, vatType, vatPercent: 0, currency };
}

/**
 * Distribute `total` across `parts` slices so the parts sum back to exactly
 * `total`. Used when a nightly rate does not divide evenly across a stay or a
 * package price is broken out into its components.
 */
export function distribute(total: number, parts: number, currency: string): number[] {
  if (parts <= 0) return [];
  const digits = minorUnits(currency);
  const factor = 10 ** digits;
  const totalMinor = Math.round(total * factor);
  const base = Math.trunc(totalMinor / parts);
  let remainder = totalMinor - base * parts;
  const step = Math.sign(remainder) || 1;
  const out: number[] = [];
  for (let i = 0; i < parts; i++) {
    let v = base;
    if (remainder !== 0) {
      v += step;
      remainder -= step;
    }
    out.push(v / factor);
  }
  return out;
}

/** Proportionally split `total` using `weights`, preserving the exact sum. */
export function distributeByWeight(total: number, weights: readonly number[], currency: string): number[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (sum === 0) return distribute(total, weights.length, currency);
  const digits = minorUnits(currency);
  const factor = 10 ** digits;
  const totalMinor = Math.round(total * factor);
  const raw = weights.map((w) => (totalMinor * w) / sum);
  const floored = raw.map((r) => Math.floor(r));
  let remainder = totalMinor - floored.reduce((a, b) => a + b, 0);
  // Hand the leftover minor units to the largest fractional parts first.
  const order = raw
    .map((r, i) => ({ i, frac: r - Math.floor(r) }))
    .sort((a, b) => b.frac - a.frac);
  for (const { i } of order) {
    if (remainder <= 0) break;
    floored[i]! += 1;
    remainder -= 1;
  }
  return floored.map((v) => v / factor);
}
