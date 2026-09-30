/**
 * apaleo stores descriptive text as a language dictionary
 * (`{ "en": "Double room", "de": "Doppelzimmer" }`). Detail endpoints return
 * the whole dictionary; list endpoints and embedded references return a single
 * resolved string, chosen by the caller's `languages` parameter.
 */
export type LocalizedText = Record<string, string>;

export const DEFAULT_LANGUAGE = 'en';

export function normalizeLocalized(input: unknown): LocalizedText {
  if (!input) return {};
  if (typeof input === 'string') return { [DEFAULT_LANGUAGE]: input };
  if (typeof input !== 'object') return {};
  const out: LocalizedText = {};
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (typeof v === 'string' && v.length) out[k.toLowerCase()] = v;
  }
  return out;
}

/**
 * Resolve to one string. Tries each preferred language in order, then English,
 * then whatever is there, so a caller always gets something displayable.
 */
export function resolveLocalized(
  text: LocalizedText | undefined,
  preferred: readonly string[] = [],
): string | undefined {
  if (!text) return undefined;
  for (const lang of preferred) {
    const hit = text[lang.toLowerCase()];
    if (hit) return hit;
  }
  if (text[DEFAULT_LANGUAGE]) return text[DEFAULT_LANGUAGE];
  const first = Object.values(text)[0];
  return first;
}

/** Merge a partial update into an existing dictionary. */
export function mergeLocalized(current: LocalizedText, update: unknown): LocalizedText {
  return { ...current, ...normalizeLocalized(update) };
}
