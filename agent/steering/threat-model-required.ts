// SPDX-License-Identifier: MIT
/**
 * E5 threat model before implementation - two gates.
 *
 * (a) BRIEF SIDE. A `kind: lens` brief with `lens: red-team` or
 * `lens: trust-model` must carry a `Threat model:` line naming the
 * model section (verification-base "Threat models"). Findings outside
 * that model are LOW / follow-up by rule (owner decision 2026-11-07,
 * ruling 6). Refused on the same three surfaces as the design-check
 * gate (write / edit / tee + wrapper payload).
 *
 * (b) BODY SIDE. Issue and PR bodies come from vault notes through the
 * pinned perl substitution (`--body-file <(perl ... VAULTFILE)`),
 * enforced by the shipped `issue-body-from-vault-file` /
 * `pr-body-from-vault-file` rules in @cad0p/pi-steering-github. That
 * package is installed read-only, so this rule re-reads the SAME
 * command pattern (its exported `findBodyFileValue` /
 * `parseBodyFileArg` / `resolveAgainstCwd` helpers) and additionally
 * requires the vault note's frontmatter to carry a `threat-model:`
 * key whose value names a section or starts with `n/a:` (copy /
 * docs-only notes). A missing key blocks; an unresolvable path or
 * unreadable file allows, because the body-file rule owns that
 * failure and already renders the better diagnostic.
 */

import { readFileSync } from "node:fs";
import type { PredicateContext } from "@cad0p/pi-steering";
import {
	findBodyFileValue,
	missingVaultBodyFile,
	parseBodyFileArg,
	resolveAgainstCwd,
} from "@cad0p/pi-steering-github";
import {
	briefContent,
	briefWrites,
	firstBriefWrite,
	headerReason,
	parseBriefHeader,
	unverifiableReason,
} from "./brief-gates.ts";

declare global {
	interface PiSteeringPredicates {
		briefNeedsThreatModel: import("@cad0p/pi-steering").PredicateShape<boolean>;
		vaultBodyNeedsThreatModel: import("@cad0p/pi-steering").PredicateShape<boolean>;
	}
}

/** `red-team` / `trust-model` lens briefs need the Threat model line. */
function lensNeedsThreatModel(ctx: PredicateContext): boolean {
	for (const write of briefWrites(ctx)) {
		const content = briefContent(write);
		if (content === null) continue; // header gate owns unverifiable writes
		const header = parseBriefHeader(content);
		if (!header.complete || header.kind !== "lens") continue;
		if (header.lens !== "red-team" && header.lens !== "trust-model") continue;
		if (header.threatModel === null || header.threatModel === "") return true;
	}
	return false;
}

const THREAT_MODEL_REASON =
	"red-team / trust-model lens briefs need a 'Threat model:' line naming the model section (verification-base 'Threat models'); findings outside it are LOW / follow-up.";

function briefReason(ctx: PredicateContext): string {
	const write = firstBriefWrite(ctx);
	if (write === null) return THREAT_MODEL_REASON;
	const content = briefContent(write);
	if (content === null) return unverifiableReason(write);
	if (!parseBriefHeader(content).complete) return headerReason(write);
	return THREAT_MODEL_REASON;
}

/** The vault note's `threat-model:` frontmatter value, or null. */
export function frontmatterThreatModel(
	content: string,
): { present: boolean; value: string | null } {
	const lines = content.split(/\r?\n/);
	if (lines[0]?.trim() !== "---") return { present: false, value: null };
	const end = lines.findIndex(
		(line, index) => index > 0 && line.trim() === "---",
	);
	if (end === -1) return { present: false, value: null };
	for (const line of lines.slice(1, end)) {
		const match = /^threat-model:\s*(.*)$/.exec(line);
		if (match === null) continue;
		let value = (match[1] ?? "").trim();
		if (value.length >= 2) {
			const first = value[0];
			const last = value[value.length - 1];
			if (
				(first === '"' && last === '"') ||
				(first === "'" && last === "'")
			) {
				value = value.slice(1, -1);
			}
		}
		return { present: true, value };
	}
	return { present: false, value: null };
}

/** The vault note path the command's `--body-file` names, when readable. */
function bodyFilePath(ctx: PredicateContext): string | null {
	const parsed = parseBodyFileArg(findBodyFileValue(ctx));
	if (parsed === null || parsed.kind !== "substitution") return null;
	return resolveAgainstCwd(ctx, parsed.path, parsed.quoted);
}

async function bodyNeedsThreatModel(
	ctx: PredicateContext,
): Promise<boolean> {
	// The shipped body-file rule owns invalid / unplaceable body files:
	// reuse its verdict (same predicate, no duplicated placement logic)
	// so its richer diagnostic keeps first say on those commands.
	const section = ctx.command.positionals()[0] === "pr" ? "prs" : "issues";
	if (await missingVaultBodyFile({ section }, ctx)) return false;
	const path = bodyFilePath(ctx);
	if (path === null) return false;
	let content: string;
	try {
		content = readFileSync(path, "utf8");
	} catch {
		return false; // unreadable: the body-file rule owns the diagnostic
	}
	const threat = frontmatterThreatModel(content);
	return !threat.present || threat.value === null || threat.value === "";
}

function bodyReason(ctx: PredicateContext): string {
	const path = bodyFilePath(ctx) ?? "the vault note";
	return `vault note ${path} has no 'threat-model:' frontmatter key: add 'threat-model: <section>' (or 'n/a: <reason>' for copy/docs-only) before filing.`;
}

export const threatModelRequiredPlugin = {
	name: "brief-threat-model",
	predicates: {
		briefNeedsThreatModel: (args: unknown, ctx: PredicateContext) => {
			if (args !== true) return false;
			return lensNeedsThreatModel(ctx);
		},
		vaultBodyNeedsThreatModel: async (
			args: unknown,
			ctx: PredicateContext,
		) => {
			if (args !== true) return false;
			return bodyNeedsThreatModel(ctx);
		},
	},
};

export const threatModelRules = [
	{
		name: "threat-model-required",
		tool: "write" as const,
		field: "path" as const,
		pattern: /^/,
		when: { briefNeedsThreatModel: true },
		reason: briefReason,
	},
	{
		name: "threat-model-required-edit",
		tool: "edit" as const,
		field: "path" as const,
		pattern: /^/,
		when: { briefNeedsThreatModel: true },
		reason: briefReason,
	},
	{
		name: "threat-model-required-bash",
		tool: "bash" as const,
		command: ["tee", "bash", "sh"] as const,
		when: { briefNeedsThreatModel: true },
		reason: briefReason,
	},
	{
		name: "threat-model-required-body",
		tool: "bash" as const,
		command: "gh" as const,
		when: {
			subcommand: {
				anyOf: [
					["issue", "create"],
					["issue", "edit"],
					["pr", "create"],
					["pr", "new"],
					["pr", "edit"],
				],
				onUnknown: "allow" as const,
			},
			vaultBodyNeedsThreatModel: true,
		},
		reason: bodyReason,
	},
];
