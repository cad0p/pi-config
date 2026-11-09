// SPDX-License-Identifier: MIT
/**
 * secret-file-read-guard — a bash command that would PRINT a known
 * secret file into the session transcript is refused.
 *
 * Incident: an agent ran `cat ~/.npmrc` and the live npm auth token
 * landed in the session transcript. The briefs already said "never
 * cat secret files"; advisories do not hold for agents, so the read
 * shape is enforced here instead.
 *
 * Known secret files (matched by path shape; absolute, `~`/$HOME and
 * relative forms all count):
 *   ~/.npmrc ~/.netrc ~/.pypirc ~/.git-credentials
 *   ~/.docker/config.json ~/.config/gh/hosts.yml ~/.aws/credentials
 *   ~/.config/rclone/rclone.conf ~/.config/restic/password
 *   restic password files (`.config/restic/password`, `restic/password`)
 *   *.env / .env / .env.* anywhere (incl. .local/*.env; see
 *   ~/.config/restic/b2.env on this host)
 *   *.pem / *.key private keys
 *   ~/.ssh/id_* (not *.pub)
 *
 * Refused: a printing consumer whose operand is one of those files —
 *   cat tac less more most bat batcat nl head tail strings xxd od
 *   hexdump base64 jq yq diff;
 *   cp when a destination is a terminal/stdout target (/dev/stdout,
 *   /dev/stderr, /dev/fd/1, /dev/tty, -);
 *   dd with a secret `if=` and no non-stdout `of=`;
 *   grep/rg that print matching lines (no -c/-q/-l/-L; commands that
 *   only count/query/list file names are fine);
 *   sed that prints (no -i and no substitution that masks values);
 *   awk whose program prints.
 *
 * Allowed: existence/permission checks (test -f, stat, ls -l), hashes
 * (sha256sum), silent compares (cmp -s), counting/querying/listing
 * (grep -c/-q/-l, rg -c), masked views done BY the masking tool
 * (`sed -E 's/(=|: ).*\1<redacted>/' FILE`), source / `. ` into a
 * shell, and every write/copy that does not target stdout.
 * `cat ~/.bw-session` stays allowed: the Bitwarden session file is not
 * one of the secret-file classes here (the guide's recipe reads it into
 * BW_SESSION); echoing the variable is refused by bw-cli-guard.
 *
 * Deliberately conservative on ONE pipe shape: a masked read PIPED
 * from a printer (`cat FILE | sed -E 's/…/<redacted>/'`) is refused,
 * because pi-steering evaluates each command ref on its own —
 * `input.command` is the flattened basename + args of that ref, and a
 * pipeline peer is a separate ref it cannot see. Do the mask with the
 * tool that reads the file (`sed … FILE`). A false refusal costs one
 * retry; a missed print costs a rotation.
 *
 * Known gaps (pinned in the test file):
 *   - the READ tool: pi-steering 0.2.0 gates only bash / write / edit
 *     (Rule.tool union; evaluator has no read branch), so `read` on a
 *     secret path cannot be refused from a steering config. The bash
 *     surface above is the enforceable half.
 *   - a copy under a different name (`cp ~/.npmrc /tmp/x`, then
 *     `cat /tmp/x`) — the guard is path-class based.
 *   - python/node -c, arbitrary scripts, and key-material printers that
 *     do not take the file as a plain operand (openssl -in, gpg
 *     --export-secret-keys) — out of scope per the brief.
 *   - env-var dumps (`env`, `set`, `printenv`) can print exported
 *     secrets; only `echo/printf $BW_SESSION` is guarded (bw rule).
 */

import { definePredicate, unwrapBooleanLeafArg } from "@cad0p/pi-steering";
import type {
	BooleanLeafArgs,
	Plugin,
	PredicateShape,
} from "@cad0p/pi-steering";
import { homedir } from "node:os";

declare global {
	interface PiSteeringPredicates {
		/**
		 * `when.printsSecretFile` — this bash ref is a printing
		 * consumer whose operand is a known secret file. Boolean leaf.
		 */
		printsSecretFile: PredicateShape<boolean>;
	}
}

/** Targets that send bytes into the transcript. */
const STDOUT_TARGETS = new Set([
	"/dev/stdout",
	"/dev/stderr",
	"/dev/fd/1",
	"/dev/fd/2",
	"/dev/tty",
	"/proc/self/fd/1",
	"/proc/self/fd/2",
	"-",
]);

/** Fixed relative path suffixes that are always secret material. */
const SECRET_SUFFIXES = [
	".npmrc",
	".netrc",
	".pypirc",
	".git-credentials",
	".docker/config.json",
	".config/gh/hosts.yml",
	".aws/credentials",
	".config/rclone/rclone.conf",
	".config/restic/password",
	"restic/password",
] as const;

/** A replacement that visibly masks the value it replaces. */
const MASK_MARKER = /(?:redacted|hidden|\*{2,}|x{4,}|<[^>]*>|\[[^\]]*\]|•+)/i;

/** `s<delim>pattern<delim>replacement<delim>` with a mask replacement. */
const SUBSTITUTION = /\bs(\S)((?:\\.|(?!\1).)*)\1((?:\\.|(?!\1).)*)\1/g;

/** Consumers that pass file contents (or a decoded form) to stdout. */
export const SECRET_PRINT_CONSUMERS = [
	"cat",
	"tac",
	"less",
	"more",
	"most",
	"bat",
	"batcat",
	"nl",
	"head",
	"tail",
	"strings",
	"xxd",
	"od",
	"hexdump",
	"base64",
	"jq",
	"yq",
	"diff",
	"cmp",
	"grep",
	"rg",
	"sed",
	"awk",
	"cp",
	"dd",
] as const;

/** Basenames whose descriptors already exist in this config. */
const DECLARED_ELSEWHERE = new Set(["cp", "dd", "sed", "awk"]);

/** Expand the home spellings the walker may leave unresolved. */
function expandHome(p: string): string {
	return p
		.replace(/^~(?=$|\/)/, homedir())
		.replace(/^\${HOME\}(?=$|\/)/, homedir())
		.replace(/^\$HOME(?=$|\/)/, homedir());
}

/** Is this operand one of the known secret files? */
export function isSecretPath(candidate: string): boolean {
	const raw = candidate.trim();
	if (raw === "" || raw.startsWith("-")) return false;
	let p = raw.replace(/^["']|["']$/g, "");
	p = expandHome(p).replace(/\/{2,}/g, "/").replace(/\/$/, "");
	if (p === "") return false;
	const base = p.slice(p.lastIndexOf("/") + 1);
	if (SECRET_SUFFIXES.some((s) => p === s || p.endsWith(`/${s}`))) {
		return true;
	}
	// ~/.ssh/id_* private keys; *.pub is the public half and is allowed.
	if (/\.ssh\/id_[^/]*$/.test(p) && !/\.pub$/.test(p)) return true;
	if (base === ".env" || base.startsWith(".env.") || base.endsWith(".env")) {
		return true;
	}
	return base.endsWith(".pem") || base.endsWith(".key");
}

/** The operand value a predicate should judge (already env-resolved). */
function wordValue(w: { value?: string; text?: string }): string {
	return (w.value ?? w.text ?? "").trim();
}

/** grep/rg output is safe only when it cannot print a matching line. */
function grepOnlyReports(operands: readonly string[]): boolean {
	const LONG_SAFE = [
		"--count",
		"--count-matches",
		"--quiet",
		"--silent",
		"--files-with-matches",
		"--files-without-match",
	];
	for (const op of operands) {
		if (!op.startsWith("-")) continue;
		if (LONG_SAFE.includes(op)) return true;
		// Short bundle: grep -c always counts, -l lists names, -q is silent.
		if (!op.startsWith("--") && /[cqLl]/.test(op)) return true;
	}
	return false;
}

/** cmp -s / --silent / --quiet compares without printing bytes. */
function cmpIsSilent(operands: readonly string[]): boolean {
	return operands.some(
		(op) => op === "-s" || op === "--silent" || op === "--quiet",
	);
}

/** sed -i writes in place and prints nothing. */
function sedIsInPlace(operands: readonly string[]): boolean {
	return operands.some(
		(op) =>
			op === "-i" ||
			/^-i[.A-Za-z0-9]*$/.test(op) ||
			op === "--in-place" ||
			op.startsWith("--in-place="),
	);
}

/** Does a sed script contain a substitution whose replacement masks? */
export function sedScriptMasks(script: string): boolean {
	for (const m of script.matchAll(SUBSTITUTION)) {
		const replacement = m[3] ?? "";
		if (MASK_MARKER.test(replacement)) return true;
	}
	return false;
}

/** Does sed mask, or write in place (both print nothing)? */
function sedPrints(operands: readonly string[]): boolean {
	if (sedIsInPlace(operands)) return false;
	// Every non-flag operand that is not the secret path is a candidate
	// script (`-e` values land here too): any masking script clears it.
	const scripts = operands.filter(
		(op) => !op.startsWith("-") && !isSecretPath(op),
	);
	return !scripts.some((s) => sedScriptMasks(s));
}

/**
 * Extract the awk program. `-v`/`-F`/`-f` take a value; a program
 * file means we cannot inspect it, so it counts as printing.
 */
function awkPrints(operands: readonly string[]): boolean {
	let program: string | undefined;
	let external = false;
	for (let i = 0; i < operands.length; i++) {
		const op = operands[i] ?? "";
		if (
			op === "-v" ||
			op === "--assign" ||
			op === "-F" ||
			op === "-f" ||
			op === "--file"
		) {
			if (op === "-f" || op === "--file") external = true;
			i++;
			continue;
		}
		if (op.startsWith("-")) continue;
		if (isSecretPath(op)) continue;
		if (program === undefined) program = op;
	}
	if (external || program === undefined) return true;
	return /\bprint(?:f)?\b/.test(program);
}

/** Does cp send the bytes to a terminal/stdout target? */
function cpWritesStdout(operands: readonly string[]): boolean {
	return operands.some((op) => STDOUT_TARGETS.has(op));
}

/** dd prints the input only when it is not redirected to a real file. */
function ddPrints(operands: readonly string[]): boolean {
	const secretInput = operands.some(
		(op) => op.startsWith("if=") && isSecretPath(op.slice(3)),
	);
	if (!secretInput) return false;
	return !operands.some((op) => {
		if (!op.startsWith("of=")) return false;
		const target = op.slice(3);
		return target !== "" && !STDOUT_TARGETS.has(target);
	});
}

/** Would this consumer ref print the secret anyway? */
function consumerPrints(
	basename: string,
	operands: readonly string[],
): boolean {
	switch (basename) {
		case "grep":
		case "rg":
			return !grepOnlyReports(operands);
		case "cmp":
			return !cmpIsSilent(operands);
		case "sed":
			return sedPrints(operands);
		case "awk":
			return awkPrints(operands);
		case "cp":
			return cpWritesStdout(operands);
		case "dd":
			return ddPrints(operands);
		default:
			return true;
	}
}

/**
 * `when.printsSecretFile` — the ref is a printing consumer and at
 * least one operand is a known secret file, unless the consumer's own
 * flags/mode make it print nothing (counts, silent compare, in-place
 * or masked sed, non-printing awk, dd with a real `of=`, cp to a
 * non-stdout destination).
 */
export const printsSecretFile = definePredicate<BooleanLeafArgs>(
	(args, ctx) => {
		const expected = unwrapBooleanLeafArg(args);
		if (expected === undefined) return false;
		if (ctx.input?.tool !== "bash") return false;
		const basename = ctx.input.basename;
		if (basename === undefined) return false;
		const words = ctx.input.args ?? [];
		const operands = words.map(wordValue).filter((w) => w !== "");
		const secretOperands = operands.filter(
			(op) =>
				isSecretPath(op) ||
				(op.startsWith("if=") && isSecretPath(op.slice(3))),
		);
		if (secretOperands.length === 0) return false === expected;
		return consumerPrints(basename, operands) === expected;
	},
);

/** Agent-facing message: what happened, and the non-printing ways. */
const REASON =
	"This command would print a known secret file (.npmrc, .netrc, .pypirc, .docker/config.json, .config/gh/hosts.yml, .aws/credentials, .git-credentials, *.env/.env*, *.pem/*.key, ~/.ssh/id_*, rclone.conf, restic password) into the session transcript — a printed token is a token that must be rotated (incident: a live npm auth token from `cat ~/.npmrc`). Do it without printing: hash it (sha256sum FILE), compare silently (cmp -s FILE OTHER), check existence/permissions (test -f, stat, ls -l), count matches (grep -c), or print a masked view with the tool that reads it (sed -E 's/(=|: ).*/\\1<redacted>/' FILE). For the Bitwarden session, read it into the environment (BW_SESSION=\"$(cat ~/.bw-session)\") and never echo it.";

export const secretFileReadGuardRules = [
	{
		name: "no-secret-file-print",
		tool: "bash" as const,
		command: [...SECRET_PRINT_CONSUMERS],
		when: { printsSecretFile: true },
		reason: REASON,
	},
];

export const secretFileReadGuardPlugin = {
	name: "secret-file-read-guard",
	cliDescriptors: Object.fromEntries(
		SECRET_PRINT_CONSUMERS.filter((b) => !DECLARED_ELSEWHERE.has(b)).map(
			(b) => [b, {}],
		),
	),
	predicates: { printsSecretFile },
} as const satisfies Plugin;
