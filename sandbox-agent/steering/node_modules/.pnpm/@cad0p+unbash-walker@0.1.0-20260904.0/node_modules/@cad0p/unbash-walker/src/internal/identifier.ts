// SPDX-License-Identifier: MIT
// Part of unbash-walker (internal helpers).

/**
 * Shared bash-identifier predicate. The env tracker and resolveWord
 * both need to decide whether a parsed `$NAME` / `${NAME}` /
 * `NAME=VALUE` fragment is a valid shell variable identifier; keeping
 * the rule in one place prevents them from drifting.
 *
 * Not exported from the package root \u2014 callers outside
 * `unbash-walker/src/**` shouldn't depend on this helper (use
 * `resolveWord` for word-level resolution).
 */

/**
 * Accept only bash-identifier names (`[A-Za-z_][A-Za-z0-9_]*`).
 * Rejects positional parameters (`1`, `2`, \u2026) and special
 * parameters (`@`, `*`, `#`, `?`, `$`, `!`, `-`). Those are
 * intractable for static-resolution purposes even if the parser
 * hands them to us under SimpleExpansion / ParameterExpansion.
 */
export function isIdentifierName(name: string): boolean {
  if (name.length === 0) return false;
  const first = name.charCodeAt(0);
  if (!isIdentStart(first)) return false;
  for (let i = 1; i < name.length; i++) {
    if (!isIdentCont(name.charCodeAt(i))) return false;
  }
  return true;
}

function isIdentStart(c: number): boolean {
  return (
    (c >= 65 /* A */ && c <= 90) /* Z */ ||
    (c >= 97 /* a */ && c <= 122) /* z */ ||
    c === 95 /* _ */
  );
}

function isIdentCont(c: number): boolean {
  return isIdentStart(c) || (c >= 48 /* 0 */ && c <= 57) /* 9 */;
}
