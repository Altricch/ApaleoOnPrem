/**
 * Compact rendering.
 *
 * Tool output is read by a model with a finite context, so every result is
 * rendered as the smallest text that still answers the question: aligned
 * tables rather than JSON, ids kept, nulls dropped, long lists truncated with
 * an explicit count so the model knows to narrow its filter rather than
 * assuming it saw everything.
 */

export interface Column<T> {
  header: string;
  /** Return '' for "nothing here"; the column is dropped if every row is empty. */
  value: (row: T) => string;
  align?: 'left' | 'right';
}

/** A fixed-width table. Columns that are empty for every row are omitted. */
export function table<T>(rows: readonly T[], columns: readonly Column<T>[]): string {
  if (!rows.length) return '(none)';

  const cells = rows.map((row) => columns.map((c) => c.value(row) ?? ''));
  const keep = columns
    .map((_, i) => cells.some((r) => r[i] !== '' && r[i] !== undefined))
    .map((used, i) => (used ? i : -1))
    .filter((i) => i >= 0);

  const widths = keep.map((i) =>
    Math.max(columns[i]!.header.length, ...cells.map((r) => String(r[i] ?? '').length)));

  const line = (values: string[]) => keep
    .map((columnIndex, position) => {
      const text = String(values[columnIndex] ?? '');
      const width = widths[position]!;
      return columns[columnIndex]!.align === 'right' ? text.padStart(width) : text.padEnd(width);
    })
    .join('  ')
    .trimEnd();

  return [
    line(columns.map((c) => c.header)),
    keep.map((_, position) => '-'.repeat(widths[position]!)).join('  '),
    ...cells.map(line),
  ].join('\n');
}

/** `key: value` lines, skipping anything empty. */
export function facts(entries: Record<string, unknown>): string {
  const pairs = Object.entries(entries).filter(([, v]) => v !== undefined && v !== null && v !== '');
  if (!pairs.length) return '(no detail)';
  const width = Math.max(...pairs.map(([k]) => k.length));
  return pairs.map(([k, v]) => `${k.padEnd(width)}  ${v}`).join('\n');
}

export function money(value: { amount: number; currency: string } | undefined | null): string {
  if (!value) return '';
  return `${value.amount.toFixed(2)} ${value.currency}`;
}

/** Trim a date-time down to the date; leave plain dates alone. */
export function day(value: string | undefined | null): string {
  return value ? String(value).slice(0, 10) : '';
}

export function percent(value: number | undefined | null): string {
  return value === undefined || value === null ? '' : `${value.toFixed(1)}%`;
}

export function person(guest: { firstName?: string; lastName?: string } | undefined): string {
  if (!guest) return '';
  return [guest.firstName, guest.lastName].filter(Boolean).join(' ');
}

/** Cap a list and say how much was held back, so nothing looks complete when it is not. */
export function capped<T>(items: readonly T[], total: number, limit: number): {
  shown: T[];
  note: string;
} {
  const shown = items.slice(0, limit);
  if (total <= shown.length) return { shown, note: '' };
  return {
    shown,
    note: `\n\nShowing ${shown.length} of ${total}. Narrow the filters or raise `
      + `\`limit\` to see more.`,
  };
}

/** Join sections, dropping the empty ones. */
export function sections(...parts: (string | null | undefined | false)[]): string {
  return parts.filter((p): p is string => typeof p === 'string' && p.trim() !== '').join('\n\n');
}

export function bullets(items: readonly string[]): string {
  return items.map((item) => `- ${item}`).join('\n');
}
