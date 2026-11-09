// SPDX-License-Identifier: MIT
/**
 * bw-cli-guard — Bitwarden CLI use that prints a vault secret (or
 * invalidates the cached session) is refused.
 *
 * Source: Goldmine personal/guides/2026-10-07-bitwarden-cli-session-scoping.md
 * (read in full; line references below are to that file).
 *
 * Refused:
 *   - `bw get password|totp|notes|item|attachment` — the value goes
 *     to stdout, i.e. into the transcript.
 *   - `bw list items` (the item JSON carries every secret field;
 *     steering cannot see a downstream `| jq …` projection, so the
 *     filtered form is refused too — see the pipe gap below).
 *   - `bw export` (whole-vault export).
 *   - `bw unlock` / `bw login` in every form: an unlock mints a
 *     fresh session key and the guide's shims print it (L55); the
 *     session is a full-vault bearer token (L30, L73). The owner
 *     refreshes `~/.bw-session` himself.
 *   - `echo` / `printf` of `BW_SESSION` — the key is a full-vault
 *     bearer token; exporting it shell-wide is the leak class the
 *     guide names (L73).
 *   - `bwbio <cmd>` with no BW_SESSION (and no BW_NOINTERACTION=true):
 *     bare `bwbio` silently rotates the stored user key and invalidates
 *     every cached session, including `~/.bw-session` (L19, L42, L46).
 *     Allowed without a session: empty argv (usage), the fork's
 *     passthrough allowlist `login|logout|lock|config|update|completion|
 *     status|serve`, and the help/version/nointeraction flags (L56).
 *     With BW_SESSION set, `bwbio` is a pure passthrough to `bw` (L42), so
 *     only the print rules above apply.
 *
 * Guide footguns encoded here: the `> ~/.bw-session` redirect on an
 * unlock truncates the cached key before the shim runs (L25), the
 * shims refuse non-capture unlock and quiet `--raw` unlock (L25,
 * L56), and the POST-shim `bwbio unlock --raw` is still a print. The
 * guide's sanctioned shapes stay allowed: `bw status`, `bw sync`,
 * `bw list folders`, `bw get username|uri`, the repo recipe
 * `export BW_SESSION="$(cat ~/.bw-session)" && bw status` (L23, L26),
 * reading `~/.bw-session` itself, and `BW_SESSION=… bwbio status`.
 *
 * Known gap (pinned in the test file): pi-steering evaluates each
 * command ref on its own — `input.command` is that ref's flattened
 * basename + args, and a pipeline peer or a `$(…)` capture wrapper is a
 * separate ref the predicate cannot see. So `VAR=$(bw get password X)` and
 * `bw get password X | some-cmd --password-stdin` are indistinguishable
 * from a bare print here and are REFUSED (fail-closed: a missed print
 * costs a rotation, a false refusal costs one retry). Do the read
 * inside a helper script (or the repo tooling: tools/pm.sh consumes
 * BW_SESSION and never prints a value), or ask the owner.
 */

import { definePredicate, unwrapBooleanLeafArg } from "@cad0p/pi-steering";
import type {
	BooleanLeafArgs,
	Plugin,
	PredicateShape,
} from "@cad0p/pi-steering";

declare global {
	interface PiSteeringPredicates {
		/** `when.bwPrintsSecret` — a bw ref that prints vault secrets. */
		bwPrintsSecret: PredicateShape<boolean>;
		/** `when.bwMintsSession` — `bw unlock` / `bw login`. */
		bwMintsSession: PredicateShape<boolean>;
		/** `when.bwbioImplicitRotation` — bwbio that rotates the key. */
		bwbioImplicitRotation: PredicateShape<boolean>;
		/** `when.echoesBwSession` — echo/printf of BW_SESSION. */
		echoesBwSession: PredicateShape<boolean>;
	}
}

/** `bw get <class>` values that are secrets (guide L23, L46). */
const SECRET_GET_CLASSES = new Set([
	"password",
	"totp",
	"notes",
	"note",
	"item",
	"attachment",
]);

/**
 * The fork's own passthrough path with no cached session (guide L56):
 * empty argv, these subcommands, or a help/version flag.
 */
const BWBIO_PASSTHROUGH = new Set([
	"login",
	"logout",
	"lock",
	"config",
	"update",
	"completion",
	"status",
	"serve",
	"help",
	"version",
]);

/** Flags that make a call informational (never a secret print). */
const HELP_FLAGS = new Set([
	"--help",
	"-h",
	"--version",
	"-v",
	"--bwbio-version",
]);

/** `--nointeraction` suppresses the biometric prompt (guide L56). */
const NOINTERACTION_FLAGS = new Set(["--nointeraction"]);

/** Flags of bw/bwbio that consume the next word. */
const VALUE_FLAGS = new Set([
	"--session",
	"--search",
	"--organizationid",
	"--folderid",
	"--itemid",
	"--output",
	"--format",
	"--passwordenv",
	"--passwordfile",
]);

/**
 * Subcommand + operands of the ref. Flags are skipped (a glued
 * `--flag=value` is one word), and the value of a known value-taking
 * flag is skipped too, so `bw --session KEY get password X` reads as
 * [get, password, X].
 */
function positionals(ctx: {
	input?: { args?: ReadonlyArray<{ value?: string; text?: string }> };
}): string[] {
	const out: string[] = [];
	const words = ctx.input?.args ?? [];
	for (let i = 0; i < words.length; i++) {
		const value = (words[i]?.value ?? words[i]?.text ?? "").trim();
		if (value === "") continue;
		if (value.startsWith("-")) {
			if (VALUE_FLAGS.has(value)) i++;
			continue;
		}
		out.push(value);
	}
	return out;
}

/** Does the ref carry any flag from the set? */
function hasAnyFlag(
	ctx: { input?: { args?: ReadonlyArray<{ value?: string; rawText?: string }> } },
	flags: ReadonlySet<string>,
): boolean {
	for (const w of ctx.input?.args ?? []) {
		const value = (w.value ?? "").trim();
		const raw = (w.rawText ?? "").trim().replace(/^["']|["']$/g, "");
		if (flags.has(value) || flags.has(raw)) return true;
	}
	return false;
}

/** Help/version anywhere in the ref means no secret is printed. */
function informational(ctx: {
	input?: { args?: ReadonlyArray<{ value?: string; rawText?: string }> };
}): boolean {
	if (hasAnyFlag(ctx, HELP_FLAGS)) return true;
	const ops = positionals(ctx);
	return ops[0] === "help" || ops[0] === "version";
}

/**
 * Read an environment value visible at this ref: a chain `export` lands
 * in the walker env, a same-command prefix in envAssignments (bash
 * applies prefixes to the direct child only).
 */
function envValue(
	ctx: {
		input?: { envAssignments?: ReadonlyArray<{ text?: string; value?: string }> };
		walkerState?: { env?: ReadonlyMap<string, string> };
	},
	name: string,
): string | undefined {
	const fromEnv = ctx.walkerState?.env?.get?.(name);
	if (typeof fromEnv === "string" && fromEnv.trim() !== "") return fromEnv;
	const prefix = new RegExp("^" + name + "=(.*)$");
	for (const w of ctx.input?.envAssignments ?? []) {
		const token = (w.text ?? w.value ?? "").trim();
		const m = prefix.exec(token);
		if (m === null) continue;
		const value = (m[1] ?? "").replace(/^["']|["']$/g, "").trim();
		if (value !== "") return value;
	}
	return undefined;
}

/**
 * `when.bwPrintsSecret` — `bw get <secret class>`, `bw list items` or
 * `bw export`, on `bw` or `bwbio`. Help/version flags are exempt.
 */
export const bwPrintsSecret = definePredicate<BooleanLeafArgs>((args, ctx) => {
	const expected = unwrapBooleanLeafArg(args);
	if (expected === undefined) return false;
	if (ctx.input?.tool !== "bash") return false;
	const basename = ctx.input.basename;
	if (basename !== "bw" && basename !== "bwbio") return false;
	if (informational(ctx)) return false === expected;
	const ops = positionals(ctx);
	const sub = ops[0] ?? "";
	const second = ops[1] ?? "";
	const hit =
		(sub === "get" && SECRET_GET_CLASSES.has(second)) ||
		(sub === "list" && second === "items") ||
		sub === "export";
	return hit === expected;
});

/**
 * `when.bwMintsSession` — `bw unlock` / `bw login`. Every form mints or
 * prints a session key (guide L25, L30, L55); the owner does the refresh.
 */
export const bwMintsSession = definePredicate<BooleanLeafArgs>((args, ctx) => {
	const expected = unwrapBooleanLeafArg(args);
	if (expected === undefined) return false;
	if (ctx.input?.tool !== "bash") return false;
	const basename = ctx.input.basename;
	if (basename !== "bw" && basename !== "bwbio") return false;
	if (informational(ctx)) return false === expected;
	const sub = positionals(ctx)[0] ?? "";
	return (sub === "unlock" || sub === "login") === expected;
});

/**
 * `when.bwbioImplicitRotation` — `bwbio <cmd>` with no BW_SESSION and no
 * BW_NOINTERACTION=true, i.e. an implicit biometric unlock that rotates
 * the stored user key and kills every cached session (guide L19, L42,
 * L46, L56).
 */
export const bwbioImplicitRotation = definePredicate<BooleanLeafArgs>(
	(args, ctx) => {
		const expected = unwrapBooleanLeafArg(args);
		if (expected === undefined) return false;
		if (ctx.input?.tool !== "bash") return false;
		if (ctx.input.basename !== "bwbio") return false;
		if (informational(ctx)) return false === expected;
		// With a session (or the no-interaction marker) the fork is a pure
		// passthrough and rotates nothing (guide L42, L56).
		if (envValue(ctx, "BW_SESSION") !== undefined) return false === expected;
		if (envValue(ctx, "BW_NOINTERACTION") === "true") {
			return false === expected;
		}
		if (hasAnyFlag(ctx, NOINTERACTION_FLAGS)) return false === expected;
		const ops = positionals(ctx);
		if (ops.length === 0) return false === expected;
		if (BWBIO_PASSTHROUGH.has(ops[0] ?? "")) return false === expected;
		return true === expected;
	},
);

/**
 * `when.echoesBwSession` — echo/printf whose words mention BW_SESSION
 * (raw or env-resolved). The resolved value alone is not enough: a
 * shell-wide export resolves the word before the predicate sees it, so
 * the raw token is checked too.
 */
export const echoesBwSession = definePredicate<BooleanLeafArgs>((args, ctx) => {
	const expected = unwrapBooleanLeafArg(args);
	if (expected === undefined) return false;
	if (ctx.input?.tool !== "bash") return false;
	const basename = ctx.input.basename;
	if (basename !== "echo" && basename !== "printf") return false;
	const mentions = (ctx.input.args ?? []).some((w) =>
		[w.rawText, w.text, w.value].some(
			(s) => typeof s === "string" && s.includes("BW_SESSION"),
		),
	);
	return mentions === expected;
});

const PRINT_REASON =
	"This command would print a Bitwarden vault secret into the session transcript (bw get password|totp|notes|item|attachment, bw list items, bw export). A printed value must be rotated. pi-steering sees each command ref without its pipe/capture wrapper, so it cannot prove the value stays out of the transcript and refuses the printing shapes; do the read inside a helper script or the repo tooling (tools/pm.sh consumes BW_SESSION and never prints a value), or ask the owner. For non-secret fields use bw get username|uri or bw list folders.";

const MINT_REASON =
	"bw unlock / bw login mints a full-vault bearer session key and prints it (the guide: the session is a bearer token, never an agent boundary; the shims refuse non-capture unlock and quiet --raw unlock). Agents must not mint or print one. Ask the owner to refresh ~/.bw-session in his own terminal, then read it into the environment for one command: BW_SESSION=\"$(cat ~/.bw-session)\" bw status. Never echo BW_SESSION.";

const BWBIO_REASON =
	"bare bwbio without BW_SESSION rotates the CLI's stored user key and invalidates every cached session, including ~/.bw-session (guide 2026-10-07, verified 2026-10-08). Set the session for the single process: BW_SESSION=\"$(cat ~/.bw-session)\" bwbio <cmd> (then bwbio is a pure passthrough to bw), use bw, or ask the owner. Bare bwbio (usage), status/lock/logout/config/update/completion/serve and --help/--version are fine.";

const ECHO_REASON =
	"Do not echo/printf BW_SESSION: the Bitwarden session key is a full-vault bearer token and the transcript keeps it (guide: never export it shell-wide). Capture it into one process instead: BW_SESSION=\"$(cat ~/.bw-session)\" bw <cmd>, or rely on the ~/.local/bin shims, which inject it per invocation.";

export const bwCliGuardRules = [
	{
		name: "no-bw-session-mint",
		tool: "bash" as const,
		command: ["bw", "bwbio"] as const,
		when: { bwMintsSession: true },
		reason: MINT_REASON,
	},
	{
		name: "no-bwbio-implicit-rotation",
		tool: "bash" as const,
		command: "bwbio" as const,
		when: { bwbioImplicitRotation: true },
		reason: BWBIO_REASON,
	},
	{
		name: "no-bw-secret-print",
		tool: "bash" as const,
		command: ["bw", "bwbio"] as const,
		when: { bwPrintsSecret: true },
		reason: PRINT_REASON,
	},
	{
		name: "no-bw-session-echo",
		tool: "bash" as const,
		command: ["echo", "printf"] as const,
		when: { echoesBwSession: true },
		reason: ECHO_REASON,
	},
];

export const bwCliGuardPlugin = {
	name: "bw-cli-guard",
	cliDescriptors: {
		// Value-taking flags are declared so positionals() reads the
		// subcommand, not a flag value (bw --session KEY get password X).
		bw: {
			flags: {
				session: { aliases: ["--session"], takesValue: true },
				search: { aliases: ["--search"], takesValue: true },
				organizationid: { aliases: ["--organizationid"], takesValue: true },
				folderid: { aliases: ["--folderid"], takesValue: true },
				passwordenv: { aliases: ["--passwordenv"], takesValue: true },
				passwordfile: { aliases: ["--passwordfile"], takesValue: true },
			},
		},
		bwbio: {
			flags: {
				session: { aliases: ["--session"], takesValue: true },
				search: { aliases: ["--search"], takesValue: true },
				organizationid: { aliases: ["--organizationid"], takesValue: true },
				folderid: { aliases: ["--folderid"], takesValue: true },
				passwordenv: { aliases: ["--passwordenv"], takesValue: true },
				passwordfile: { aliases: ["--passwordfile"], takesValue: true },
			},
		},
		echo: {},
		printf: {},
	},
	predicates: {
		bwPrintsSecret,
		bwMintsSession,
		bwbioImplicitRotation,
		echoesBwSession,
	},
} as const satisfies Plugin;
