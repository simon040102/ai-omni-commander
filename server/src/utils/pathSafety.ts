/**
 * Path parameter validation shared by HTTP routes that build filesystem paths
 * from request input (project IDs, task IDs, filenames used as one segment).
 */

/**
 * True when the value is safe to use as a SINGLE path segment:
 * non-empty, no `..`, no `/` or `\` separators.
 */
export function isSafePathParam(v: string): boolean {
  return v.length > 0 && !v.includes('..') && !v.includes('/') && !v.includes('\\');
}
