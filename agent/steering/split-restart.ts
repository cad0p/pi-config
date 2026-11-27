// SPDX-License-Identifier: MIT
/**
 * The split-piece restart freeze (owner decision 2026-11-27: "a split pr
 * should restart at round one that's the whole point").
 *
 * The strictly-smaller test is evaluated ONCE, at the split, on the piece's
 * first reviewed head. If the piece passes there, its rounds count from 1
 * for its whole life, whatever paths later folds add; if it fails there,
 * it inherits its parent's count. The verdict is recorded under
 * `<h4 state>/split-restarts/`, so a later round reads the record and never
 * recomputes the diff.
 *
 * For a piece whose first round is already counted, the first head is the
 * first head in merge-pr.sh's `rounds` list. For a piece being briefed for
 * round 1, it is the `head:` named by that round-1 lens brief. In that
 * case the current `gh pr diff` is the same diff (the lens gate has already
 * required `head:` to be the PR's current head), so the comparison does
 * not need the repo clone; the clone reconstruction is only for legacy
 * pieces whose branch moved on before this rule existed.
 */

import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { BriefHeader } from "./brief-gates.ts";
import { stateDir } from "./brief-gates.ts";
import {
	pieceComparison,
	pieceIsSmallerAtHead,
	repoKey,
	roundsList,
	splitPr,
	type SplitComparison,
} from "./base-rules.ts";

/** The durable verdict of the one strictly-smaller test. */
interface SplitRestartRecord {
	version: 1;
	pr: string;
	splitOf: string;
	basis: "first-reviewed-head";
	head: string;
	source: "round-1-lens-brief" | "first-counted-round";
	smaller: boolean;
	outside: string[];
	piecePaths: string[];
	pieceLines: number;
	parentPaths: string[];
	parentLines: number;
	recordedAt: string;
}

export type SplitShrinkVerdict =
	| { ok: true; comparison: SplitComparison; recordPath: string }
	| { ok: false; err: string };

/** The per-PR freeze record path, or null when the ref is not a PR. */
export function splitRestartRecordPath(ref: string): string | null {
	const parts = splitPr(ref);
	if (parts === null) return null;
	return join(
		stateDir(),
		"split-restarts",
		`${repoKey(parts.repo.toLowerCase())}-${parts.number}.json`,
	);
}

function stringArray(value: unknown): value is string[] {
	return (
		Array.isArray(value) &&
		value.every((entry) => typeof entry === "string")
	);
}

function nonNegativeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/** Parse and validate a freeze record; malformed state is never a pass. */
function parseRecord(
	text: string,
	path: string,
): { ok: true; record: SplitRestartRecord } | { ok: false; err: string } {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch (error) {
		return {
			ok: false,
			err: `the split-restart record ${path} is not JSON (${(error as Error).message}); the frozen verdict cannot be read (fail closed)`,
		};
	}
	const record = value as Partial<SplitRestartRecord> | null;
	if (
		record === null ||
		typeof record !== "object" ||
		record.version !== 1 ||
		typeof record.pr !== "string" ||
		typeof record.splitOf !== "string" ||
		record.basis !== "first-reviewed-head" ||
		typeof record.head !== "string" ||
		!/^[0-9a-f]{40}$/.test(record.head) ||
		(record.source !== "round-1-lens-brief" &&
			record.source !== "first-counted-round") ||
		typeof record.smaller !== "boolean" ||
		!stringArray(record.outside) ||
		!stringArray(record.piecePaths) ||
		!nonNegativeInteger(record.pieceLines) ||
		!stringArray(record.parentPaths) ||
		!nonNegativeInteger(record.parentLines)
	) {
		return {
			ok: false,
			err: `the split-restart record ${path} is malformed; the frozen verdict cannot be read (fail closed)`,
		};
	}
	return { ok: true, record: record as SplitRestartRecord };
}

function comparisonOf(record: SplitRestartRecord): SplitComparison {
	return {
		smaller: record.smaller,
		outside: [...record.outside],
		piecePaths: [...record.piecePaths],
		pieceLines: record.pieceLines,
		parentPaths: [...record.parentPaths],
		parentLines: record.parentLines,
	};
}

/** Read the frozen verdict, validating that the brief names the same lineage. */
function readFrozenVerdict(
	path: string,
	piece: string,
	parent: string,
): SplitShrinkVerdict | null {
	if (!existsSync(path)) return null;
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch (error) {
		return {
			ok: false,
			err: `the split-restart record ${path} cannot be read (${(error as Error).message}); the frozen verdict cannot be read (fail closed)`,
		};
	}
	const parsed = parseRecord(text, path);
	if (!parsed.ok) return { ok: false, err: parsed.err };
	if (parsed.record.pr !== piece || parsed.record.splitOf !== parent) {
		return {
			ok: false,
			err: `the split-restart record ${path} is for ${parsed.record.pr} split-of ${parsed.record.splitOf}, not ${piece} split-of ${parent}; a piece's lineage cannot change after its restart verdict is frozen (fail closed)`,
		};
	}
	return {
		ok: true,
		comparison: comparisonOf(parsed.record),
		recordPath: path,
	};
}

/** Atomically write the freeze record (no partial JSON is ever visible). */
function writeFrozenVerdict(
	path: string,
	piece: string,
	parent: string,
	head: string,
	source: SplitRestartRecord["source"],
	comparison: SplitComparison,
): { ok: true } | { ok: false; err: string } {
	const record: SplitRestartRecord = {
		version: 1,
		pr: piece,
		splitOf: parent,
		basis: "first-reviewed-head",
		head,
		source,
		smaller: comparison.smaller,
		outside: comparison.outside,
		piecePaths: comparison.piecePaths,
		pieceLines: comparison.pieceLines,
		parentPaths: comparison.parentPaths,
		parentLines: comparison.parentLines,
		recordedAt: new Date().toISOString(),
	};
	const scratch = `${path}.write-${process.pid}`;
	try {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(scratch, `${JSON.stringify(record, null, 2)}\n`);
		renameSync(scratch, path);
		return { ok: true };
	} catch (error) {
		try {
			rmSync(scratch, { force: true });
		} catch {
			// Best effort: the write failure below is the refusal either way.
		}
		return {
			ok: false,
			err: `the split-restart record ${path} could not be written (${(error as Error).message}); without the durable verdict a later round would recompute the split test (fail closed)`,
		};
	}
}

/**
 * The piece's frozen strictly-smaller verdict. With no record, the verdict
 * is evaluated once and written; with a record, the diff is never read
 * again. Every failure refuses closed because an unrecorded or unreadable
 * verdict is exactly the re-test the owner removed.
 */
export function splitShrinkVerdict(header: BriefHeader): SplitShrinkVerdict {
	const piece = header.prKey;
	const parent = header.splitOfKey;
	if (piece === null || parent === null) {
		return {
			ok: false,
			err: `not a split piece header: pr '${header.pr ?? "<none>"}', split-of '${header.splitOf ?? "<none>"}'`,
		};
	}
	const path = splitRestartRecordPath(piece);
	if (path === null) {
		return { ok: false, err: `not a PR ref: ${piece}` };
	}
	const frozen = readFrozenVerdict(path, piece, parent);
	if (frozen !== null) return frozen;

	const rounds = roundsList(piece);
	if (!rounds.ok) {
		return {
			ok: false,
			err: `the first review round of ${piece} could not be read (${rounds.err}); the split-restart verdict cannot be frozen (fail closed)`,
		};
	}
	let head = rounds.heads[0] ?? null;
	let source: SplitRestartRecord["source"] = "first-counted-round";
	if (head === null) {
		if (
			header.kind === "lens" &&
			header.round === 1 &&
			header.head !== null &&
			/^[0-9a-f]{40}$/.test(header.head)
		) {
			head = header.head;
			source = "round-1-lens-brief";
		} else {
			return {
				ok: false,
				err: `the split-restart verdict of ${piece} cannot be frozen: the helper counts no reviewed round and this brief is not its round-1 lens brief with a 40-hex head (fail closed)`,
			};
		}
	}

	// A round-1 lens brief reviews the PR's current head (the lens gate has
	// already enforced that before the round is computed), so the current PR
	// diff is that head's diff. Only a legacy first-counted head needs the
	// clone reconstruction: the branch may have moved on since that review.
	const compared =
		source === "round-1-lens-brief"
			? pieceComparison(piece, parent)
			: pieceIsSmallerAtHead(piece, parent, head);
	if (!compared.ok) {
		return {
			ok: false,
			err: `could not compare ${piece} at its first reviewed head ${head} with its split parent ${parent} (${compared.err}); the split-restart verdict cannot be frozen (fail closed)`,
		};
	}
	const written = writeFrozenVerdict(
		path,
		piece,
		parent,
		head,
		source,
		compared.comparison,
	);
	if (!written.ok) return { ok: false, err: written.err };
	return { ok: true, comparison: compared.comparison, recordPath: path };
}
