/**
 * File-name matching for `pattern` arguments.
 *
 * The upstream script documents its `-f` flag as a regular expression; it is
 * actually a glob. Rather than inherit that confusion, this module defines the
 * contract explicitly: comma-separated entries, each either a glob with `*` and
 * `?`, or — when it contains no wildcard — a case-insensitive suffix or exact
 * name match.
 */

/**
 * Compile one entry to a predicate.
 * @param entry - one pattern entry.
 * @returns a matcher over file names.
 */
function compile(entry: string): (name: string) => boolean {
  const pattern = entry.trim().toLowerCase()
  if (pattern === '') return () => false
  if (!pattern.includes('*') && !pattern.includes('?')) {
    return name => {
      const lower = name.toLowerCase()
      return lower === pattern || lower.endsWith(pattern)
    }
  }
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/gu, '\\$&')
  const source = escaped.replaceAll('*', '.*').replaceAll('?', '.')
  const matcher = new RegExp(`^${source}$`, 'u')
  return name => matcher.test(name.toLowerCase())
}

/**
 * Build a predicate from the `pattern` argument.
 * @param pattern - comma-separated entries; empty or missing matches everything.
 * @returns a matcher over file names.
 */
export function nameMatcher(pattern: string | undefined): (name: string) => boolean {
  if (pattern === undefined || pattern.trim() === '') return () => true
  const predicates = pattern.split(',').map(compile).filter(predicate => predicate !== undefined)
  if (predicates.length === 0) return () => true
  return name => predicates.some(predicate => predicate(name))
}