import { nextSeq } from './db';

/**
 * apaleo ids are human-readable and structural rather than opaque UUIDs:
 *
 *   property          MUC                      (the caller-chosen code)
 *   unit group        MUC-DBL                  property + code
 *   unit              MUC-MTA                  property + generated token
 *   rate plan         MUC-NONREF-DBL           property + code
 *   booking           XPGMSXGF                 8 random letters
 *   reservation       XPGMSXGF-1               booking + ordinal
 *   folio             XPGMSXGF-1-1             reservation + ordinal
 *   charge            XPGMSXGF-1-1-TS-1        folio + kind + ordinal
 *   block             MUC-QJNXJR               property + generated token
 *
 * Reproducing that matters: clients slice these ids apart, and support staff
 * read them out loud. `I` and `O` are excluded so nobody confuses them with 1/0.
 */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ';

let randomSource: () => number = Math.random;

/** Test hook: make id generation deterministic. */
export function setRandomSource(fn: () => number): void {
  randomSource = fn;
}

export function token(length: number): string {
  let out = '';
  for (let i = 0; i < length; i++) {
    out += ALPHABET[Math.floor(randomSource() * ALPHABET.length)];
  }
  return out;
}

/** Generate a token that is not already taken, per `exists`. */
export function uniqueToken(length: number, exists: (candidate: string) => boolean): string {
  for (let attempt = 0; attempt < 200; attempt++) {
    const t = token(length);
    if (!exists(t)) return t;
  }
  // Astronomically unlikely; fall back to a counter suffix rather than loop forever.
  return `${token(length)}${nextSeq('id-collision')}`;
}

export const bookingId = (exists: (id: string) => boolean) => uniqueToken(8, exists);
export const groupId = (exists: (id: string) => boolean) => uniqueToken(8, exists);
export const paymentAccountId = (exists: (id: string) => boolean) => uniqueToken(8, exists);
export const authorizationId = (exists: (id: string) => boolean) => uniqueToken(8, exists);

export const unitId = (propertyId: string, exists: (id: string) => boolean) =>
  `${propertyId}-${uniqueToken(3, (t) => exists(`${propertyId}-${t}`))}`;

export const blockId = (propertyId: string, exists: (id: string) => boolean) =>
  `${propertyId}-${uniqueToken(6, (t) => exists(`${propertyId}-${t}`))}`;

/** `MUC` + `DBL` -> `MUC-DBL`. Used by every code-addressed config entity. */
export const scoped = (propertyId: string, code: string) => `${propertyId}-${code}`;

export const reservationId = (booking: string, ordinal: number) => `${booking}-${ordinal}`;
export const folioId = (owner: string, ordinal: number) => `${owner}-${ordinal}`;

/** Charge ids carry the kind so the source of a posting is readable. */
export type ChargeKind = 'TS' | 'ES' | 'CT' | 'CF' | 'NF' | 'MA' | 'TR';
export const chargeId = (folio: string, kind: ChargeKind, ordinal: number) => `${folio}-${kind}-${ordinal}`;

/** Sequence-backed ids for things the guest never reads out (logs, payments). */
export function sequential(prefix: string, counter: string): string {
  return `${prefix}-${nextSeq(counter)}`;
}
