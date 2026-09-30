import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import timezone from 'dayjs/plugin/timezone';
import customParseFormat from 'dayjs/plugin/customParseFormat';
import isSameOrBefore from 'dayjs/plugin/isSameOrBefore';

dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.extend(customParseFormat);
dayjs.extend(isSameOrBefore);

export { dayjs };

/** `YYYY-MM-DD`. apaleo calls this a "business date" or "service date". */
export type BusinessDate = string;
/** Full ISO 8601 instant with offset, e.g. `2024-05-01T15:00:00+02:00`. */
export type Instant = string;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isBusinessDate(v: unknown): v is BusinessDate {
  return typeof v === 'string' && DATE_RE.test(v) && dayjs(v, 'YYYY-MM-DD', true).isValid();
}

export function today(timeZone: string): BusinessDate {
  return dayjs().tz(timeZone).format('YYYY-MM-DD');
}

export function nowIso(): Instant {
  return dayjs().utc().toISOString();
}

/** Parse anything the API accepts (date or date-time) down to its local date. */
export function toBusinessDate(value: string, timeZone?: string): BusinessDate {
  if (isBusinessDate(value)) return value;
  const d = timeZone ? dayjs(value).tz(timeZone) : dayjs(value);
  return d.format('YYYY-MM-DD');
}

/**
 * Combine a business date with a wall-clock time in the property's zone and
 * render it as an offset-qualified instant, which is how apaleo returns
 * `arrival`, `departure`, `checkInTime` and friends.
 */
export function atLocalTime(date: BusinessDate, time: string, timeZone: string): Instant {
  const [h, m] = time.split(':').map((x) => Number.parseInt(x, 10));
  return dayjs.tz(`${date} ${pad(h)}:${pad(m ?? 0)}:00`, 'YYYY-MM-DD HH:mm:ss', timeZone).format();
}

const pad = (n: number) => String(n).padStart(2, '0');

export function addDays(date: BusinessDate, days: number): BusinessDate {
  return dayjs(date, 'YYYY-MM-DD').add(days, 'day').format('YYYY-MM-DD');
}

export function diffDays(from: BusinessDate, to: BusinessDate): number {
  return dayjs(to, 'YYYY-MM-DD').diff(dayjs(from, 'YYYY-MM-DD'), 'day');
}

/** Inclusive-exclusive list of dates: the nights between arrival and departure. */
export function nightsBetween(arrival: BusinessDate, departure: BusinessDate): BusinessDate[] {
  const out: BusinessDate[] = [];
  const n = diffDays(arrival, departure);
  for (let i = 0; i < n; i++) out.push(addDays(arrival, i));
  return out;
}

/** Inclusive on both ends. Used for availability grids and rate ranges. */
export function datesInclusive(from: BusinessDate, to: BusinessDate): BusinessDate[] {
  const out: BusinessDate[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

/** Do `[aFrom, aTo)` and `[bFrom, bTo)` overlap? */
export function rangesOverlap(aFrom: string, aTo: string, bFrom: string, bTo: string): boolean {
  return aFrom < bTo && bFrom < aTo;
}

/** 0 = Sunday .. 6 = Saturday, as apaleo's `Monday`..`Sunday` names. */
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;
export type DayOfWeek = (typeof DAY_NAMES)[number];

export function dayOfWeek(date: BusinessDate): DayOfWeek {
  return DAY_NAMES[dayjs(date, 'YYYY-MM-DD').day()]!;
}

/**
 * Parse an ISO 8601 duration of the shape apaleo uses in cancellation and
 * no-show policies (`P1D`, `PT24H`, `P2DT12H`) into hours.
 */
export function durationToHours(iso: string): number {
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?$/.exec(iso);
  if (!m) return 0;
  const [, d, h, min] = m;
  return (Number(d ?? 0) * 24) + Number(h ?? 0) + Number(min ?? 0) / 60;
}

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
