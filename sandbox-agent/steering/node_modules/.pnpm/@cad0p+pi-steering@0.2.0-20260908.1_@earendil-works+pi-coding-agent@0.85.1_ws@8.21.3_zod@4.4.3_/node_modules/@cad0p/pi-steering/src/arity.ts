// SPDX-License-Identifier: MIT
// Part of pi-steering.

/**
 * Core CLI-descriptor fallback map (issue #106).
 *
 * Core seeds NOTHING: per-binary argv knowledge lives in the
 * owning plugin via its `Plugin.cliDescriptors` slot (see
 * `src/plugins/git/descriptors.ts` for the exemplar). The map is
 * kept — plus the merger's fallback fill and `resolveDescriptor` —
 * as dormant machinery for any future core-seeded basename.
 *
 * Imports ONLY the `CLIDescriptor` type from schema — no edge to any
 * plugin barrel, so the merger can import this module without a
 * cycle.
 */

import type { PositionPolicy } from "@cad0p/unbash-walker";
import { DEFAULT_POSITION_POLICIES } from "@cad0p/unbash-walker";
import type { CLIDescriptor, CLIFlag } from "./schema.ts";

/**
 * Core fallback map: basename → descriptor. Currently EMPTY — core
 * seeds nothing (per-binary facts live in their owning plugins).
 * The merger still fills absent basenames from this map AFTER the
 * plugin loop (pure fallback, no WARN); a no-op in practice while
 * the map is empty.
 */
export const CORE_CLI_DESCRIPTORS: Record<string, CLIDescriptor> = {};

/**
 * Valid `positionPolicy` values. Mirrors the leaf-side
 * `VALID_POSITION_POLICIES` in `evaluator-internals/predicates.ts` —
 * kept local so this module stays dependency-free (no core→leaf
 * edge).
 */
const VALID_DESCRIPTOR_POLICIES: ReadonlySet<string> = new Set([
  "globals-anywhere",
  "globals-before-only",
  "globals-after-only",
]);

/**
 * Basenames already warned for post-merge descriptor malformation.
 * Module-level one-shot set: the merged `cliDescriptors` map is
 * mutable post-merge by plain-JS callers, so resolution-time
 * re-validation warns once per basename (tagged
 * `[invalid-descriptor]`, NOT the diagnostic pipeline — never
 * escalates via `failOnWarnings`, never fires per-tool_call
 * per-ref).
 */
const warnedBasenames = new Set<string>();

function warnInvalidDescriptorOnce(basename: string, detail: string): void {
  if (warnedBasenames.has(basename)) return;
  warnedBasenames.add(basename);
  console.warn(
    `[pi-steering] [invalid-descriptor] CLI descriptor for basename ` +
      `${JSON.stringify(basename)} ${detail}; falling back to strict default`,
  );
}

/**
 * Named error thrown when the merged registry has NO entry for a ref's
 * basename (issue #107, absent-descriptor goes loud).
 *
 * Carries the `basename` (set at the throw site in
 * {@link resolveDescriptor}); the evaluator's `runPredicateChain`
 * attaches `ruleName`/`source` on the rule path before rethrowing to
 * the top-level fail-closed catch (explicit passthrough — unknown
 * predicate keys take the opposite road since issue #75: rejected at
 * load by `validateWhenClauseKeys`, projected `"unknown"`
 * fail-closed at runtime — because a missing descriptor is a
 * fail-CLOSED config hole, not a buggy predicate, swallowing it here
 * would fail OPEN).
 *
 * Present-but-empty descriptors (`{ npm: {} }`) are EXPLICIT strict
 * and never throw — only a wholly absent entry does.
 */
export class MissingDescriptorError extends Error {
  /** Ref basename with no registry entry. */
  readonly basename: string;
  /** Attaching rule (set by the evaluator on the rule path). */
  ruleName?: string;
  /** Attaching rule source (set alongside {@link ruleName}). */
  source?: string;

  constructor(basename: string) {
    super(`[pi-steering] ${missingDescriptorRemedy(basename)}`);
    this.name = "MissingDescriptorError";
    this.basename = basename;
  }
}

/**
 * Actionable remedy for a missing descriptor, shared by the throw-site
 * error message and the agent-facing block reason. Names the basename
 * plus both fixes: declare per-binary argv knowledge via the owning
 * plugin's `Plugin.cliDescriptors` slot, or an explicit-strict empty
 * entry (`{ "<basename>": {} }`, nothing consumes).
 */
export function missingDescriptorRemedy(basename: string): string {
  const slot = /^[A-Za-z_$][\w$]*$/.test(basename)
    ? `Plugin.cliDescriptors.${basename}`
    : `Plugin.cliDescriptors[${JSON.stringify(basename)}]`;
  return (
    `No CLI descriptor for basename ${JSON.stringify(basename)}. ` +
    `Declare per-binary argv knowledge via ${slot}, ` +
    `or { ${JSON.stringify(basename)}: {} } for explicit strict ` +
    `(nothing consumes).`
  );
}

/**
 * Test-only reset for the one-shot WARN set. Lets
 * `invalid-policy/flags one-shot` pins assert re-WARN behavior
 * without cross-test pollution.
 */
export function __resetDescriptorWarningsForTests(): void {
  warnedBasenames.clear();
}

/**
 * Resolved per-binary argv knowledge (issue #110).
 *
 * Derived spellings taking a separate value (table aliases where
 * `takesValue`) plus derived glue letters (single-char-short aliases
 * of `takesValue` entries). Longs never glue; bool shorts bundle, never
 * glue.
 */
export interface ResolvedArity {
  readonly positionPolicy: PositionPolicy;
  /** Derived spellings taking a separate value (table aliases where takesValue). */
  readonly valueConsumingFlags: ReadonlySet<string>;
  /** Derived glue letters (single-char-short aliases of takesValue entries). */
  readonly gluedShorts: ReadonlySet<string>;
}

/** Shared frozen empty arity for nameless refs (never throw, §2). */
export const EMPTY_ARITY: ResolvedArity = Object.freeze({
  positionPolicy: "globals-anywhere",
  valueConsumingFlags: Object.freeze(new Set<string>()),
  gluedShorts: Object.freeze(new Set<string>()),
}) as ResolvedArity;

/** True for `--long` (length > 2) or `-x` (length === 2) spellings. */
function isWellFormedSpelling(spelling: unknown): spelling is string {
  if (typeof spelling !== "string") return false;
  if (spelling.startsWith("--")) return spelling.length > 2;
  if (spelling.startsWith("-") && !spelling.startsWith("--")) {
    return spelling.length === 2;
  }
  return false;
}

function isSingleCharShort(alias: string): boolean {
  return alias.length === 2 && alias[0] === "-" && alias[1] !== "-";
}

/**
 * PURE TOTAL table→sets derivation. SOLE site: called ONLY by
 * `resolveDescriptor` (and `arityOf` through it). Longs contribute to
 * `valueConsumingFlags` but NEVER to `gluedShorts`; multi-char `-xy`
 * contributes to neither glue set (fail-open ignored ⇒ no glue).
 * Malformed entries never reach here (merger skipped them; resolver
 * re-validation guards plain-JS post-merge mutation first).
 *
 * Derivation rules (pinned): single-char-short of a `takesValue` entry
 * glues (`{aliases:["-R","--repo"],takesValue:true}` ⇒ consuming
 * `{"-R","--repo"}`, glue `{"R"}`); longs never glue (even `takesValue`);
 * bool shorts bundle never glue (`takesValue:false` ⇒ contributes to neither
 * set).
 *
 * getopt-`::` edge: optional-arg "glue-only never separate" shape is NOT
 * modeled — declared `takesValue` consumes separate too; exotic,
 * documented, ignored.
 */
export function deriveFlagSets(
  flags: Readonly<Record<string, CLIFlag>> | undefined,
): Pick<ResolvedArity, "valueConsumingFlags" | "gluedShorts"> {
  const valueConsumingFlags = new Set<string>();
  const gluedShorts = new Set<string>();
  if (flags === undefined) return { valueConsumingFlags, gluedShorts };
  if (flags === null || typeof flags !== "object" || Array.isArray(flags)) {
    return { valueConsumingFlags, gluedShorts };
  }
  for (const entry of Object.values(flags)) {
    if (entry === null || typeof entry !== "object") continue;
    const { aliases, takesValue } = entry as Partial<CLIFlag>;
    if (!Array.isArray(aliases) || aliases.length === 0) continue;
    if (typeof takesValue !== "boolean") continue;
    if (!aliases.every(isWellFormedSpelling)) continue;
    if (!takesValue) continue;
    for (const alias of aliases as readonly string[]) {
      valueConsumingFlags.add(alias);
      if (isSingleCharShort(alias)) {
        gluedShorts.add(alias[1]!);
      }
    }
  }
  return { valueConsumingFlags, gluedShorts };
}

/**
 * Per-tool_call hoisted resolution. `cache` is a call-scoped Map — created
 * ONCE per tool_call in `evaluateEventInner` (stored on `SharedEvalContext`;
 * per `mockContext` call on the test path); dies with the call;
 * O(distinct basenames), in practice 1 entry. `runPredicateChain` (per
 * rule×candidate) and `evaluateBashRule`'s per-ref loop only THREAD it,
 * never create. `basename === undefined` → `EMPTY_ARITY` (no Map write,
 * never throw).
 */
export function arityOf(
  basename: string | undefined,
  descriptors: Record<string, CLIDescriptor> | undefined,
  cache: Map<string, ResolvedArity>,
): ResolvedArity {
  if (basename === undefined) return EMPTY_ARITY;
  const cached = cache.get(basename);
  if (cached !== undefined) return cached;
  const resolved = resolveDescriptor(basename, descriptors);
  cache.set(basename, resolved);
  return resolved;
}

/**
 * Resolve per-binary argv knowledge for one ref basename (issues
 * #106/#107, registry-only; #110 table derivation).
 *
 * Absent entry → throws {@link MissingDescriptorError} (loud:
 * basename + remedy). Present-but-empty (`{ npm: {} }`) is EXPLICIT
 * strict → silent verdicts (empty sets, policy table fallback).
 * Missing/empty `flags` key ≡ `{flags:{}}` ≡ valid empty arity.
 *
 *   - `valueConsumingFlags` + `gluedShorts`: derived via
 *     {@link deriveFlagSets} from the `flags` table ONLY (sole source).
 *   - `positionPolicy`: registry (when valid) >
 *     `DEFAULT_POSITION_POLICIES` table > strict `"globals-anywhere"`
 *     (table stays the fallback when registry absent).
 *
 * Re-validates at resolution time (not just merge time):
 * `ResolvedPluginState.cliDescriptors` is mutable post-merge by
 * plain-JS callers. Invalid registry flags/policy → treat as absent
 * + one-shot WARN (module-level set, tagged `[invalid-descriptor]`).
 * Invalid present NEVER throws — only ABSENT throws.
 */
export function resolveDescriptor(
  basename: string,
  descriptors?: Record<string, CLIDescriptor>,
): ResolvedArity {
  const registryEntry =
    descriptors?.[basename] ?? CORE_CLI_DESCRIPTORS[basename];

  // Absent entry → LOUD (fail-closed config hole, never silent
  // strict). Present-but-empty (`{ npm: {} }`) is explicit strict →
  // silent verdicts below.
  if (registryEntry === undefined) {
    throw new MissingDescriptorError(basename);
  }

  // Flags: table derivation ONLY (sole source). Unknown keys on the
  // registry entry (including a stale pre-#110 `valueConsumingFlags`
  // key) are ignored — the `flags` table is the sole arity source.
  const derived = deriveFlagSets(registryEntry?.flags);
  const valueConsumingFlags = new Set<string>(derived.valueConsumingFlags);
  const gluedShorts = new Set<string>(derived.gluedShorts);
  // Re-validate the table shape for WARN parity (derive skips silently;
  // resolution warns once per basename on deformed tables).
  const rawFlags: unknown = registryEntry?.flags;
  if (rawFlags !== undefined) {
    if (
      rawFlags === null ||
      typeof rawFlags !== "object" ||
      Array.isArray(rawFlags)
    ) {
      warnInvalidDescriptorOnce(
        basename,
        "has malformed flags table (expected Record<name, { aliases, takesValue }>)",
      );
    } else {
      for (const [key, entry] of Object.entries(
        rawFlags as Record<string, unknown>,
      )) {
        if (
          entry === null ||
          typeof entry !== "object" ||
          Array.isArray(entry)
        ) {
          warnInvalidDescriptorOnce(
            basename,
            `flag ${JSON.stringify(key)} has malformed entry ` +
              `(expected { aliases: ("--long"|"-x")[], takesValue: boolean })`,
          );
          continue;
        }
        const { aliases, takesValue } = entry as {
          aliases?: unknown;
          takesValue?: unknown;
        };
        const aliasesOk =
          Array.isArray(aliases) &&
          aliases.length > 0 &&
          aliases.every(isWellFormedSpelling);
        if (!aliasesOk || typeof takesValue !== "boolean") {
          warnInvalidDescriptorOnce(
            basename,
            `flag ${JSON.stringify(key)} has malformed entry ` +
              `(expected { aliases: ("--long"|"-x")[], takesValue: boolean })`,
          );
        }
      }
    }
  }
  // Policy: registry (valid) > table > strict default.
  const rawRegistryPolicy = registryEntry?.positionPolicy;
  let positionPolicy: PositionPolicy;
  if (typeof rawRegistryPolicy === "string") {
    if (VALID_DESCRIPTOR_POLICIES.has(rawRegistryPolicy)) {
      positionPolicy = rawRegistryPolicy as PositionPolicy;
    } else {
      warnInvalidDescriptorOnce(
        basename,
        `has invalid positionPolicy ${JSON.stringify(rawRegistryPolicy)}`,
      );
      positionPolicy = "globals-anywhere";
    }
  } else if (rawRegistryPolicy !== undefined) {
    warnInvalidDescriptorOnce(
      basename,
      `has invalid positionPolicy ${JSON.stringify(rawRegistryPolicy)}`,
    );
    positionPolicy = "globals-anywhere";
  } else {
    const tablePolicy: unknown =
      basename !== undefined
        ? (DEFAULT_POSITION_POLICIES as Record<string, unknown>)[basename]
        : undefined;
    if (
      typeof tablePolicy === "string" &&
      VALID_DESCRIPTOR_POLICIES.has(tablePolicy)
    ) {
      positionPolicy = tablePolicy as PositionPolicy;
    } else {
      positionPolicy = "globals-anywhere";
    }
  }
  return { positionPolicy, valueConsumingFlags, gluedShorts };
}
