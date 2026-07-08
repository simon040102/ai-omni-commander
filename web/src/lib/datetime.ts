/**
 * Server timestamp parsing.
 *
 * SQLite's datetime('now') returns "YYYY-MM-DD HH:MM:SS" — UTC but with no
 * 'T' separator and no 'Z' suffix, so `new Date()` would misparse it as
 * local time (off by the timezone offset, e.g. +8h in Taipei).
 *
 * Use parseServerDate() for ANY timestamp string that may originate from the
 * server; ISO strings (client-generated `toISOString()`) pass through intact.
 */
export function parseServerDate(s: string): Date {
  if (!s) return new Date(NaN);
  // Normalize SQLite "YYYY-MM-DD HH:MM:SS" → "YYYY-MM-DDTHH:MM:SS"
  let normalized = s.includes('T') ? s : s.replace(' ', 'T');
  const hasTime = normalized.includes('T');
  // Missing timezone designator → the value is UTC, append 'Z'
  const hasTz = /(?:Z|[+-]\d{2}:?\d{2})$/.test(normalized);
  if (hasTime && !hasTz) normalized += 'Z';
  return new Date(normalized);
}
