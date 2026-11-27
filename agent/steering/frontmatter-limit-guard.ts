// SPDX-License-Identifier: MIT
/**
 * Frontmatter limit guard — a file states its own limits, and every
 * agent write or edit of it is checked against them before it lands.
 *
 * Owner ruling 2026-11-27: no git hooks (./commit-hook-guard.ts); a file
 * that must stay readable carries its limit in its frontmatter, and steering
 * enforces it whenever the file is modified. Generic: any file, any repo.
 *
 * Frontmatter keys (top-level, in the leading `---` block):
 *   limit-lines: <n>        at most n lines
 *   limit-bytes: <n>        at most n bytes (UTF-8)
 *   limit-line-chars: <n>   no line longer than n characters
 *   steering-check: <path>  a script, relative to the file's git root, run on
 *                           the candidate content (passed as a temp file path,
 *                           argv[1]); exit 0 = pass, anything else refuses
 *                           with the script's output. .py runs under python3,
 *                           .sh under bash; 10 s bound.
 * The keys are read from the current file AND the candidate, so dropping a key
 * in the same write does not escape it.
 *
 * Shell writers of such a file (sed -i, perl -i, tee, the destination of
 * cp/mv/rsync/install/ln, truncate, dd of=) are refused: use the write or edit
 * tool, which runs the check. Known gap (as ./dev-shm-guard.ts): a bare
 * redirect (`> file`) and interpreter writes (python3/node/awk) are not seen.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { PredicateShape } from "@cad0p/pi-steering";

declare global {
	interface PiSteeringPredicates {
		breaksFrontmatterLimit: PredicateShape<boolean>;
		shellWritesLimitedFile: PredicateShape<boolean>;
	}
}

export const LIMIT_KEYS = ["limit-lines", "limit-bytes", "limit-line-chars", "steering-check"] as const;
type Limits = Partial<Record<(typeof LIMIT_KEYS)[number], string>>;

/** Top-level keys of a leading frontmatter block. */
export function readLimits(text: string): Limits {
	const out: Limits = {};
	const m = /^(?:\uFEFF)?---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
	if (!m) return out;
	for (const line of (m[1] ?? "").split(/\r?\n/)) {
		const kv = /^([a-z-]+):\s*(.*?)\s*$/.exec(line);
		if (!kv) continue;
		const k = kv[1] as (typeof LIMIT_KEYS)[number];
		if ((LIMIT_KEYS as readonly string[]).includes(k)) out[k] = (kv[2] ?? "").replace(/^["']|["']$/g, "");
	}
	return out;
}

function readHead(p: string): string {
	try {
		if (!existsSync(p) || !statSync(p).isFile()) return "";
		return readFileSync(p, "utf8");
	} catch {
		return "";
	}
}

function gitRoot(p: string): string | undefined {
	let d = dirname(p);
	for (;;) {
		if (existsSync(join(d, ".git"))) return d;
		const up = dirname(d);
		if (up === d) return undefined;
		d = up;
	}
}

const cache = new Map<string, string | null>();

/** null = passes; otherwise the refusal text. */
export function checkCandidate(path: string, current: string, candidate: string): string | null {
	const lim: Limits = { ...readLimits(current), ...readLimits(candidate) };
	if (Object.keys(lim).length === 0) return null;
	const key = createHash("sha256").update(path + "\0" + JSON.stringify(lim) + "\0" + candidate).digest("hex");
	if (cache.has(key)) return cache.get(key) ?? null;
	const errs: string[] = [];
	const lines = candidate.split("\n");
	const n = (v?: string) => (v && /^\d+$/.test(v) ? Number(v) : undefined);
	const maxL = n(lim["limit-lines"]);
	const maxB = n(lim["limit-bytes"]);
	const maxC = n(lim["limit-line-chars"]);
	if (maxL !== undefined && lines.length > maxL) errs.push(`${lines.length} lines (limit-lines: ${maxL})`);
	const bytes = Buffer.byteLength(candidate, "utf8");
	if (maxB !== undefined && bytes > maxB) errs.push(`${bytes} bytes (limit-bytes: ${maxB})`);
	if (maxC !== undefined)
		lines.forEach((l, i) => {
			if (l.length > maxC) errs.push(`line ${i + 1} is ${l.length} characters (limit-line-chars: ${maxC})`);
		});
	const script = lim["steering-check"];
	if (script) {
		const root = gitRoot(path);
		const sp = root ? resolve(root, script) : undefined;
		if (!root || !sp || relative(root, sp).startsWith("..") || isAbsolute(script) || !existsSync(sp)) {
			errs.push(`steering-check: ${script} is not a file inside this file's git root`);
		} else {
			const dir = mkdtempSync(join(tmpdir(), "fm-check-"));
			const cand = join(dir, basename(path));
			try {
				writeFileSync(cand, candidate);
				const [cmd, args] = sp.endsWith(".py") ? ["python3", [sp, cand]] : sp.endsWith(".sh") ? ["bash", [sp, cand]] : [sp, [cand]];
				execFileSync(cmd as string, args as string[], { cwd: root, timeout: 10_000, stdio: ["ignore", "pipe", "pipe"] });
			} catch (e) {
				const x = e as { stdout?: Buffer; stderr?: Buffer; message?: string };
				const out = `${x.stdout?.toString() ?? ""}${x.stderr?.toString() ?? ""}`.trim() || (x.message ?? "failed");
				errs.push(`steering-check ${script} refused:\n${out.slice(-2500)}`);
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		}
	}
	const res = errs.length ? errs.join("\n") : null;
	cache.set(key, res);
	return res;
}

type EditInput = { path?: string; content?: string; edits?: ReadonlyArray<{ oldText: string; newText: string }> };

/** The full path and candidate content of a write/edit, or undefined if it cannot be built. */
export function candidateOf(input: EditInput, cwd: string): { path: string; current: string; candidate: string } | undefined {
	if (typeof input?.path !== "string") return undefined;
	const path = resolve(cwd || process.cwd(), input.path.replace(/^~(?=\/)/, process.env.HOME ?? "~"));
	const current = readHead(path);
	if (typeof input.content === "string") return { path, current, candidate: input.content };
	if (Array.isArray(input.edits)) {
		let s = current;
		for (const e of input.edits) {
			const i = s.indexOf(e.oldText);
			if (i < 0) return undefined; // the edit tool refuses it itself
			s = s.slice(0, i) + e.newText + s.slice(i + e.oldText.length);
		}
		return { path, current, candidate: s };
	}
	return undefined;
}

function hasLimits(p: string): boolean {
	return Object.keys(readLimits(readHead(p))).length > 0;
}

type Ctx = {
	cwd?: string;
	input?: EditInput & { basename?: string; args?: ReadonlyArray<{ value?: string; text?: string }> };
	walkerState?: { cwd?: unknown };
};

export const frontmatterLimitPlugin = {
	name: "frontmatter-limit-guard",
	// sed/perl/tee/cp/mv/rsync/install/ln/truncate/dd are declared by other plugins.
	predicates: {
		breaksFrontmatterLimit: (args: unknown, ctx: Ctx) => {
			if (args !== true) return false;
			const c = candidateOf(ctx.input ?? {}, ctx.cwd ?? "");
			if (!c) return false;
			return checkCandidate(c.path, c.current, c.candidate) !== null;
		},
		shellWritesLimitedFile: (args: unknown, ctx: Ctx) => {
			if (args !== true) return false;
			const ws = ctx.walkerState?.cwd;
			const cwd = typeof ws === "string" && ws !== "unknown" ? ws : ctx.cwd ?? "";
			const words = (ctx.input?.args ?? []).map((w) => w?.value ?? w?.text ?? "");
			const bin = ctx.input?.basename ?? "";
			const abs = (w: string) => resolve(cwd, w.replace(/^~(?=\/)/, process.env.HOME ?? "~"));
			let targets: string[] = [];
			if (bin === "sed" || bin === "perl") {
				if (!words.some((w) => /^-[a-zA-Z]*i/.test(w) || w.startsWith("--in-place"))) return false;
				targets = words.filter((w) => !w.startsWith("-"));
			} else if (bin === "tee" || bin === "truncate") {
				targets = words.filter((w) => !w.startsWith("-"));
			} else if (bin === "dd") {
				targets = words.filter((w) => w.startsWith("of=")).map((w) => w.slice(3));
			} else if (["cp", "mv", "rsync", "install", "ln"].includes(bin)) {
				const pos = words.filter((w) => !w.startsWith("-"));
				targets = pos.length ? [pos[pos.length - 1] as string] : [];
			}
			return targets.some((t) => t && hasLimits(abs(t)));
		},
	},
};

async function editReason(ctx: Ctx): Promise<string> {
	const c = candidateOf(ctx.input ?? {}, ctx.cwd ?? "");
	const why = c ? checkCandidate(c.path, c.current, c.candidate) : null;
	return `This file's frontmatter sets limits (limit-lines / limit-bytes / limit-line-chars / steering-check) and this change breaks them:\n${why ?? "(re-check failed)"}\nShorten the content and write it again; the check runs on every write and edit.`;
}

const SHELL_REASON =
	"This file's frontmatter sets limits (limit-lines / limit-bytes / limit-line-chars / steering-check). Modify it with the write or edit tool, which runs the check; shell writers bypass it.";

export const frontmatterLimitRules = [
	{ name: "frontmatter-limit-write", tool: "write" as const, field: "path" as const, pattern: /./, when: { breaksFrontmatterLimit: true }, reason: editReason },
	{ name: "frontmatter-limit-edit", tool: "edit" as const, field: "path" as const, pattern: /./, when: { breaksFrontmatterLimit: true }, reason: editReason },
	{
		name: "frontmatter-limit-shell",
		tool: "bash" as const,
		command: ["sed", "perl", "tee", "cp", "mv", "rsync", "install", "ln", "truncate", "dd"],
		when: { shellWritesLimitedFile: true },
		reason: SHELL_REASON,
	},
];
