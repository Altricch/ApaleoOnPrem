/** Presentation helpers shared across views. */

export const DAY_MS = 86400000;

export function money(value, { sign = false } = {}) {
  if (!value) return '—';
  const amount = typeof value === 'number' ? value : value.amount;
  const currency = typeof value === 'number' ? 'EUR' : value.currency;
  const text = new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency: currency || 'EUR',
    minimumFractionDigits: 2,
  }).format(amount);
  return sign && amount > 0 ? `+${text}` : text;
}

export function number(value, digits = 0) {
  if (value === null || value === undefined) return '—';
  return new Intl.NumberFormat(undefined, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value);
}

export function percent(value) {
  if (value === null || value === undefined) return '—';
  return `${number(value, 1)}%`;
}

/** `2026-09-30` -> `30 Sep 2026`. Accepts date-times too. */
export function date(value, opts = { day: '2-digit', month: 'short', year: 'numeric' }) {
  if (!value) return '—';
  const d = new Date(value.length === 10 ? `${value}T00:00:00` : value);
  if (Number.isNaN(d.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, opts).format(d);
}

export function shortDate(value) {
  return date(value, { day: '2-digit', month: 'short' });
}

export function dateTime(value) {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
  }).format(d);
}

export function time(value) {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }).format(d);
}

/** Business dates are plain `YYYY-MM-DD`; keep the arithmetic away from zones. */
export function isoDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function parseDate(value) {
  const [y, m, d] = String(value).slice(0, 10).split('-').map(Number);
  return new Date(y, m - 1, d);
}

export function addDays(value, days) {
  const d = parseDate(value);
  d.setDate(d.getDate() + days);
  return isoDate(d);
}

export function diffDays(from, to) {
  return Math.round((parseDate(to) - parseDate(from)) / DAY_MS);
}

export function eachDay(from, to) {
  const out = [];
  for (let d = from; d < to; d = addDays(d, 1)) out.push(d);
  return out;
}

export function dayOfWeek(value) {
  return parseDate(value).getDay();
}

export function isWeekend(value) {
  const day = dayOfWeek(value);
  return day === 0 || day === 6;
}

export function dayName(value) {
  return new Intl.DateTimeFormat(undefined, { weekday: 'short' }).format(parseDate(value));
}

export function nights(arrival, departure) {
  const n = diffDays(arrival.slice(0, 10), departure.slice(0, 10));
  return `${n} night${n === 1 ? '' : 's'}`;
}

export function guestName(guest) {
  if (!guest) return 'Guest';
  return [guest.firstName, guest.lastName].filter(Boolean).join(' ') || 'Guest';
}

/**
 * apaleo's folio debitor splits the surname into `name` and the given name
 * into `firstName`, so neither field alone reads as a person.
 */
export function debitorName(debitor) {
  if (!debitor) return '—';
  const person = [debitor.firstName, debitor.name].filter(Boolean).join(' ');
  return person || debitor.company?.name || '—';
}

export function initials(name) {
  return String(name || '?')
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('') || '?';
}

/** Status -> chip colour, shared by every list and the calendar. */
export const STATUS_TONE = {
  Confirmed: 'accent',
  InHouse: 'ok',
  CheckedOut: '',
  NoShow: 'bad',
  Canceled: 'bad',
  Tentative: 'warn',
  Definite: 'violet',
  Optional: 'info',
  Open: 'accent',
  Closed: '',
  ClosedWithInvoice: 'ok',
  Clean: 'ok',
  Dirty: 'bad',
  CleanToBeInspected: 'warn',
  FullyPaid: 'ok',
  Unpaid: 'warn',
  WrittenOff: 'bad',
};

export const STATUS_LABEL = {
  InHouse: 'In house',
  CheckedOut: 'Checked out',
  NoShow: 'No show',
  CleanToBeInspected: 'Inspect',
  ClosedWithInvoice: 'Invoiced',
  FullyPaid: 'Paid',
};

export const label = (value) => STATUS_LABEL[value] ?? value;
export const tone = (value) => STATUS_TONE[value] ?? '';
