import { nextSeq } from '../core/db';
import { nowIso } from '../core/dates';
import { db } from './repo';
import type { AuditLogEntry } from './types';

/**
 * Every mutation to a reservation or folio is journaled. The Logs API reads
 * these back, and they double as the audit trail a hotel needs when a guest
 * disputes a charge.
 */

export interface LogInput {
  propertyId: string;
  action: string;
  message: string;
  source?: string;
  changes?: { path: string; from: unknown; to: unknown }[];
  /** For folio events: the charge/payment/allowance the entry is about. */
  relatedEntityId?: string;
  amount?: { amount: number; currency: string };
  serviceDate?: string;
}

export function logReservation(reservationId: string, input: LogInput): AuditLogEntry {
  const entry: AuditLogEntry = {
    id: `RL-${nextSeq('reservationLog')}`,
    propertyId: input.propertyId,
    reservationId,
    created: nowIso(),
    action: input.action,
    source: input.source ?? 'system',
    message: input.message,
    changes: input.changes,
  };
  db.reservationLogs.put(entry);
  return entry;
}

export function logFolio(folioId: string, input: LogInput): AuditLogEntry {
  const entry: AuditLogEntry = {
    id: `FL-${nextSeq('folioLog')}`,
    propertyId: input.propertyId,
    folioId,
    created: nowIso(),
    action: input.action,
    source: input.source ?? 'system',
    message: input.message,
    changes: input.changes,
    relatedEntityId: input.relatedEntityId,
    amount: input.amount,
    serviceDate: input.serviceDate,
  };
  db.folioLogs.put(entry);
  return entry;
}

/** Diff two snapshots into log-friendly change records. */
export function diff(before: Record<string, any>, after: Record<string, any>, keys: readonly string[]) {
  const changes: { path: string; from: unknown; to: unknown }[] = [];
  for (const key of keys) {
    const a = before[key];
    const b = after[key];
    if (JSON.stringify(a) !== JSON.stringify(b)) changes.push({ path: `/${key}`, from: a, to: b });
  }
  return changes;
}
