// SPDX-License-Identifier: MIT
/**
 * Shared plumbing for the h4-orchestration brief gates (E1 / E4 / E5a).
 *
 * Briefs live in `<state>/briefs/*.md` (state defaults to
 * `~/.local/state/h4-orchestration`, overridable with
 * `PI_H4_STATE_DIR` for tests). Every write into that directory -
 * the write / edit tools, `tee`, and a `bash -c` / `sh -c` payload
 * that redirects or tees into it - must carry a minimal header:
 *
 *   pr: cad0p/pc-host#650
 *   round: 3
 *   kind: lens|fold|impl
 *   lens: red-team|trust-model|...        (optional)
 *   split-of: cad0p/pc-host#611            (optional: this brief is a
 *                                           split piece of that PR)
 *   session: b55c1bf4                      (optional: the writing pi
 *                                           session's id8, the LAST 8 hex
 *                                           of PI_SESSION_ID, or the full
 *                                           PI_SESSION_ID, reduced to it;
 *                                           read by the open-work gate.
 *                                           Missing or malformed = every
 *                                           session. pi ids are UUIDv7:
 *                                           the first 8 hex are a
 *                                           timestamp sessions started
 *                                           within ~65 s share, so the
 *                                           id8 is the random tail, as in
 *                                           pc-host tools/open-work.sh)
 *   Threat model: <section>                (required for red-team /
 *                                           trust-model lens briefs)
 *
 * The header is read from the leading block only: either YAML
 * frontmatter (`---` ... `---`) or the leading `key: value` lines.
 * A brief with no readable header is refused by the first gate
 * (`design-check-gate`), whose message names the contract.
 *
 * Known gap (pinned here, tested as a gap): pi-steering bash rules
 * see ONE extracted command ref at a time - `ctx.input.command` is
 * `cat`, not `cat > brief.md` - so a TOP-LEVEL redirect target is
 * invisible. `tee <path>` (the path is an argument) and a
 * `bash -c` / `sh -c` payload (the payload is an argument) ARE
 * visible and are gated; a bare `cat > brief.md` is not. Write
 * briefs with the write tool (or through a wrapper) and the gate
 * sees them.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";
import type { PredicateContext } from "@cad0p/pi-steering";
import { wrapperPayload } from "./primary-checkout-guard.ts";

/** Default state root; tests override it with `PI_H4_STATE_DIR`. */
export const DEFAULT_STATE_DIR = join(
	process.env.HOME ?? homedir(),
	".local",
	"state",
	"h4-orchestration",
);

/** The state root, resolved per call so a test override takes effect. */
export function stateDir(): string {
	const override = process.env.PI_H4_STATE_DIR;
	return override !== undefined && override !== ""
		? resolve(override)
		: DEFAULT_STATE_DIR;
}

export function briefsDir(): string {
	return join(stateDir(), "briefs");
}

export function designChecksDir(): string {
	return join(stateDir(), "design-checks");
}

export function criticalPathFile(): string {
	return join(stateDir(), "critical-path.json");
}

/** The open-work ledger (pc-host #703, written by tools/open-work.sh). */
export function openWorkFile(): string {
	return join(stateDir(), "open-work.json");
}

/** The stale-ledger ack (`open-work.sh ack-stale`). */
export function openWorkAckFile(): string {
	return join(stateDir(), "open-work-ack.json");
}

/** One file write a tool call performs, with the content when known. */
export interface BriefWrite {
	/** Absolute target path. */
	path: string;
	/** Full resulting content, or null when the shell hides it. */
	content: string | null;
	/** The write appends (`>>`, `tee -a`) instead of replacing. */
	append: boolean;
}

/** A parsed brief header. `complete` is the gate's header contract. */
export interface BriefHeader {
	/** `owner/repo#N` as written, or null. */
	pr: string | null;
	/** Lowercased `owner/repo#N` for matching. */
	prKey: string | null;
	owner: string | null;
	repo: string | null;
	number: number | null;
	round: number | null;
	/** Lowercased kind (`lens`, `fold`, `impl`, ...). */
	kind: string | null;
	/** Lowercased lens name, dashes normalized (`red-team`). */
	lens: string | null;
	/** Value of the `split-of:` line as written, or null. */
	splitOf: string | null;
	/** Lowercased `owner/repo#n` from `split-of:`, or null. */
	splitOfKey: string | null;
	/** `split-of` absent, or a well-formed `owner/repo#n` ref. */
	splitOfValid: boolean;
	/** Value of the `Threat model:` / `threat-model:` line, or null. */
	threatModel: string | null;
	/** Value of the `session:` line as written, or null. */
	sessionRaw: string | null;
	/** Lowercased id8 (the last 8 hex, see sessionId8) from `session:`; null when absent or malformed. */
	session: string | null;
	/** pr + round + kind all parsed. */
	complete: boolean;
}

function stripQuotes(value: string): string {
	if (value.length >= 2) {
		const first = value[0];
		const last = value[value.length - 1];
		if (
			(first === '"' && last === '"') ||
			(first === "'" && last === "'")
		) {
			return value.slice(1, -1);
		}
	}
	return value;
}

/** Normalize a header key: lowercase, whitespace/underscores to dashes. */
function normalizeKey(key: string): string {
	return key.trim().toLowerCase().replace(/[\s_]+/g, "-");
}

/** The leading header block: YAML frontmatter or leading `key: value` lines. */
function headerBlock(content: string): string[] {
	const lines = content.split(/\r?\n/);
	if (lines[0]?.trim() === "---") {
		const block: string[] = [];
		for (let i = 1; i < lines.length; i += 1) {
			if (lines[i]?.trim() === "---") break;
			block.push(lines[i] ?? "");
		}
		return block;
	}
	const block: string[] = [];
	for (const line of lines) {
		if (!/^[A-Za-z][A-Za-z0-9 _-]*:/.test(line)) break;
		block.push(line);
	}
	return block;
}

/**
 * A pi session's id8: the LAST 8 hex of its id, lowercased (pc-host
 * tools/open-work.sh's session_id8). Takes a full PI_SESSION_ID
 * (hex and dashes) or a bare id8; anything else is null. pi ids are
 * UUIDv7, whose first 8 hex are a timestamp that sessions started
 * within ~65 s share, so the prefix never names one session.
 */
export function sessionId8(value: string): string | null {
	const trimmed = value.trim();
	if (!/^[0-9A-Fa-f-]+$/.test(trimmed)) return null;
	const hex = trimmed.replace(/-/g, "").toLowerCase();
	return hex.length >= 8 ? hex.slice(-8) : null;
}

/** Parse the minimal brief header contract. Never throws. */
export function parseBriefHeader(content: string): BriefHeader {
	const values = new Map<string, string>();
	for (const line of headerBlock(content)) {
		const match = /^([A-Za-z][A-Za-z0-9 _-]*):\s*(.*)$/.exec(line);
		if (match === null) continue;
		const key = normalizeKey(match[1] ?? "");
		const value = stripQuotes((match[2] ?? "").trim());
		if (!values.has(key)) values.set(key, value);
	}
	const pr = values.get("pr") ?? null;
	const prMatch =
		pr === null
			? null
			: /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)#(\d+)$/.exec(pr);
	const roundRaw = values.get("round") ?? "";
	const round = /^\d+$/.test(roundRaw) ? Number.parseInt(roundRaw, 10) : null;
	const kindRaw = (values.get("kind") ?? "").trim().toLowerCase();
	const kind = kindRaw === "" ? null : kindRaw;
	const lensRaw = (values.get("lens") ?? "").trim().toLowerCase();
	const lens = lensRaw === "" ? null : lensRaw.replace(/[\s_]+/g, "-");
	const splitOfRaw = (values.get("split-of") ?? "").trim();
	const splitOf = splitOfRaw === "" ? null : splitOfRaw;
	const splitOfMatch =
		splitOf === null
			? null
			: /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)#(\d+)$/.exec(splitOf);
	const splitOfKey =
		splitOfMatch === null || splitOf === null ? null : splitOf.toLowerCase();
	// The Threat model line may live in the body, not only the header.
	const threatMatch = /^threat[ -]model:\s*(.*)$/im.exec(content);
	const threatModel =
		threatMatch === null ? null : stripQuotes((threatMatch[1] ?? "").trim());
	const sessionRawValue = (values.get("session") ?? "").trim();
	const sessionRaw = sessionRawValue === "" ? null : sessionRawValue;
	const session = sessionRaw === null ? null : sessionId8(sessionRaw);
	return {
		pr,
		prKey: pr?.toLowerCase() ?? null,
		owner: prMatch?.[1]?.toLowerCase() ?? null,
		repo: prMatch?.[2]?.toLowerCase() ?? null,
		number: prMatch === null ? null : Number.parseInt(prMatch[3] ?? "", 10),
		round,
		kind,
		lens,
		splitOf,
		splitOfKey,
		splitOfValid: splitOf === null || splitOfMatch !== null,
		threatModel,
		sessionRaw,
		session,
		complete: prMatch !== null && round !== null && kind !== null,
	};
}

/** Is the absolute path a `.md` file inside the briefs directory? */
export function isBriefFile(path: string): boolean {
	const dir = briefsDir();
	if (!(path === dir || path.startsWith(dir + sep))) return false;
	return /\.md$/i.test(path);
}

/** Expand a leading `~` / `$HOME` and resolve against `base`. */
export function resolveTarget(raw: string, base: string | null): string | null {
	let path = stripQuotes(raw.trim());
	if (path === "") return null;
	const home = process.env.HOME ?? homedir();
	path = path
		.replace(/^\$\{HOME\}/, home)
		.replace(/^\$HOME(?=\/|$)/, home);
	if (path === "~") path = home;
	else if (path.startsWith("~/")) path = join(home, path.slice(2));
	if (isAbsolute(path)) return resolve(path);
	if (base === null) return null;
	return resolve(base, path);
}

/** Shell word split for a payload line (quotes stripped). */
function tokenize(line: string): string[] {
	return (line.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? []).map(stripQuotes);
}

/** Apply the payload's leading `cd <dir>` segments to the base cwd. */
function leadingCwd(payload: string, base: string | null): string | null {
	let cwd = base;
	for (const segment of payload.split(/&&|\|\||[;|\n]/)) {
		const words = tokenize(segment);
		if ((words[0] ?? "") !== "cd") break;
		const target = words[1] ?? "";
		if (target === "") break;
		cwd = resolveTarget(target, cwd);
		if (cwd === null) break;
	}
	return cwd;
}

/** The redirect target on a command line: `> f`, `>> f`, `&> f`, `2> f`. */
function redirectTarget(line: string): { path: string; append: boolean } | null {
	const match =
		/(?:^|[\s;&|])(\d?>>?|&>>?|>\|)\s*("[^"]*"|'[^']*'|[^\s;&|<>]+)/.exec(
			line,
		);
	if (match === null) return null;
	const raw = stripQuotes(match[2] ?? "");
	// `2>&1` duplicates a descriptor, it does not name a file.
	if (raw === "" || raw.startsWith("&")) return null;
	return { path: raw, append: (match[1] ?? "").includes(">>") };
}

/** The last `tee` target on a command line, with its append flag. */
function teeTarget(line: string): { path: string; append: boolean } | null {
	const match = /(?:^|[\s;&|])tee\b([^;&|]*)/.exec(line);
	if (match === null) return null;
	const words = tokenize(match[1] ?? "");
	const append = words.some((w) => w === "-a" || w === "--append");
	const targets = words.filter((w) => !w.startsWith("-"));
	const path = targets[targets.length - 1];
	return path === undefined || path === "" ? null : { path, append };
}

/** The heredoc body of a payload, when it has one. */
function heredocBody(payload: string): string | null {
	const match = /<<-?\s*(?:'([^']+)'|"([^"]+)"|([A-Za-z_][A-Za-z0-9_]*))/.exec(
		payload,
	);
	if (match === null) return null;
	const marker = match[1] ?? match[2] ?? match[3] ?? "";
	if (marker === "") return null;
	const after = payload.slice(match.index + match[0].length);
	const newline = after.indexOf("\n");
	if (newline === -1) return null;
	const body: string[] = [];
	for (const line of after.slice(newline + 1).split("\n")) {
		if (line.replace(/^\t+/, "") === marker) break;
		body.push(line);
	}
	return body.join("\n");
}

/** `echo` / `printf` argument text, when the payload is one of those. */
function literalContent(line: string): string | null {
	if (!/^(?:echo|printf)\b/.test(line.trim())) return null;
	const quoted = [...line.matchAll(/"([^"]*)"|'([^']*)'/g)].map(
		(m) => m[1] ?? m[2] ?? "",
	);
	if (quoted.length === 0) return null;
	return quoted.join("\n").replace(/\\n/g, "\n").replace(/\\t/g, "\t");
}

/**
 * The writes a `bash -c` / `sh -c` payload performs into a file the
 * gate can see: a redirect target or a `tee` target on the first
 * line, with the heredoc body (or the echo/printf literal) as content.
 * One write per payload - compound multi-write payloads are a known
 * gap, listed in the module header.
 */
export function parseShellWrites(
	payload: string,
	baseCwd: string | null,
): BriefWrite[] {
	const firstLine = payload.split("\n")[0] ?? "";
	const target = redirectTarget(firstLine) ?? teeTarget(firstLine);
	if (target === null) return [];
	const cwd = leadingCwd(payload, baseCwd);
	const path = resolveTarget(target.path, cwd);
	if (path === null) return [];
	const content = heredocBody(payload) ?? literalContent(firstLine);
	return [{ path, content, append: target.append }];
}

/** Apply the edit tool's patches to a base content; null when a patch misses. */
export function applyEdits(
	base: string,
	edits: ReadonlyArray<{ oldText: string; newText: string }>,
): string | null {
	let out = base;
	for (const edit of edits) {
		const at = out.indexOf(edit.oldText);
		if (at === -1) return null;
		out = out.slice(0, at) + edit.newText + out.slice(at + edit.oldText.length);
	}
	return out;
}

/** Read a file, or null. */
export function readOrNull(path: string): string | null {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return null;
	}
}

/** The session cwd, or null when the walker could not resolve it. */
export function effectiveCwd(ctx: PredicateContext): string | null {
	const cwd = ctx.cwd;
	return typeof cwd === "string" && cwd !== "" && cwd !== "unknown"
		? cwd
		: null;
}

/** Every file write this tool call performs (briefs dir filtered later). */
export function toolWrites(ctx: PredicateContext): BriefWrite[] {
	if (ctx.tool === "write") {
		const path = typeof ctx.input.path === "string" ? ctx.input.path : "";
		if (path === "") return [];
		const abs = resolveTarget(path, effectiveCwd(ctx));
		if (abs === null) return [];
		return [
			{
				path: abs,
				content:
					typeof ctx.input.content === "string" ? ctx.input.content : "",
				append: false,
			},
		];
	}
	if (ctx.tool === "edit") {
		const path = typeof ctx.input.path === "string" ? ctx.input.path : "";
		if (path === "") return [];
		const abs = resolveTarget(path, effectiveCwd(ctx));
		if (abs === null) return [];
		const edits = ctx.input.edits ?? [];
		const base = readOrNull(abs) ?? "";
		const patched = applyEdits(base, edits);
		return [
			{
				path: abs,
				content:
					patched ?? edits.map((e) => e.newText).join("\n"),
				append: false,
			},
		];
	}
	if (ctx.tool === "bash") {
		const basename = ctx.input.basename ?? "";
		const words = (ctx.input.args ?? []).map((w) => w.value ?? w.text ?? "");
		if (basename === "tee") {
			const append = words.some((w) => w === "-a" || w === "--append");
			const targets = words.filter((w) => !w.startsWith("-"));
			const cwd = effectiveCwd(ctx);
			return targets
				.map((target) => resolveTarget(target, cwd))
				.filter((p): p is string => p !== null)
				.map((p) => ({ path: p, content: null, append }));
		}
		if (basename === "bash" || basename === "sh") {
			const payload = wrapperPayload(words);
			if (payload === null) return [];
			return parseShellWrites(payload, effectiveCwd(ctx));
		}
	}
	return [];
}

/** The writes this tool call performs into the briefs directory. */
export function briefWrites(ctx: PredicateContext): BriefWrite[] {
	return toolWrites(ctx).filter((w) => isBriefFile(w.path));
}

/**
 * The content the gate reads for a write: the tool-provided content,
 * or - for an append whose payload hides the content - the existing
 * file. A truncating write with hidden content returns null
 * (unverifiable, refused by the gate).
 */
export function briefContent(write: BriefWrite): string | null {
	if (write.content !== null) return write.content;
	if (!write.append) return null;
	return readOrNull(write.path);
}

/** The first brief write of the tool call, for the block message. */
export function firstBriefWrite(ctx: PredicateContext): BriefWrite | null {
	return briefWrites(ctx)[0] ?? null;
}

/** `lens` / `fold` briefs at round >= 3 are the design-check surface. */
export function isGatedKind(kind: string | null): boolean {
	return kind === "lens" || kind === "fold";
}

/** The latest odd round <= `round` that needs a design check. */
export function requiredDesignCheckRound(round: number): number {
	return round % 2 === 1 ? round : round - 1;
}

/** The design-check file path for a PR + round. */
export function designCheckPath(
	header: BriefHeader,
	round: number,
): string {
	return join(
		designChecksDir(),
		`${header.owner ?? "owner"}--${header.repo ?? "repo"}-${header.number ?? 0}-r${round}.md`,
	);
}

/** The three answers + verdict a design-check file must carry. */
export interface DesignCheckStatus {
	exists: boolean;
	/** Missing keys (`file` when the file does not exist). */
	missing: string[];
	verdict: string | null;
	/** Value of the `causing:` line (trimmed), or null. */
	causing: string | null;
}

/**
 * Line-key check (deliberately not a YAML parser): `scope:`,
 * `design:`, `class:` each with a non-empty value, plus
 * `verdict: continue|cut|redesign`.
 */
export function designCheckStatus(path: string): DesignCheckStatus {
	const content = readOrNull(path);
	if (content === null) {
		return { exists: false, missing: ["file"], verdict: null, causing: null };
	}
	const missing: string[] = [];
	for (const key of ["scope", "design", "class"]) {
		const match = new RegExp(`^${key}:\\s*(\\S.*)$`, "im").exec(content);
		if (match === null) missing.push(key);
	}
	const verdict = /^verdict:\s*(continue|cut|redesign)\s*$/im.exec(content);
	if (verdict === null) missing.push("verdict");
	const causing = /^causing:\s*(\S.*)$/im.exec(content);
	return {
		exists: true,
		missing,
		verdict: verdict?.[1]?.toLowerCase() ?? null,
		causing: causing === null ? null : (causing[1] ?? "").trim(),
	};
}

/** The header-contract message every brief gate falls back to. */
export function headerReason(write: BriefWrite | null): string {
	const where = write?.path ?? "the brief";
	return `briefs need a header: the first lines must be 'pr: <owner>/<repo>#<n>', 'round: <n>', 'kind: lens|fold|impl' (optional 'lens: red-team|trust-model' and 'Threat model: <section>'). Add it to ${where}.`;
}

/** The "shell hides the content" message (tee / truncating redirects). */
export function unverifiableReason(write: BriefWrite | null): string {
	const where = write?.path ?? "the brief";
	return `cannot verify the brief header through this shell write: use the write tool for ${where}, or 'tee -a' an existing brief that already has the header.`;
}
