/**
 * Local patches auto-apply.
 *
 * pi installs each version into ~/.pi/agent/install/releases/<version>/, so local source
 * patches (see ../*.patch.sh) are lost on every upgrade. This extension reconciles them at
 * session start: the running process keeps the modules it already imported, so a patch applied
 * here takes effect on the NEXT launch — the point is to make that next launch already patched
 * instead of a manual step, and to say so out loud when it happens.
 *
 * Also adds /patches: show state, apply now, or dry-run.
 */
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const run = promisify(execFile);
const SCRIPT = fileURLToPath(new URL("../../apply.sh", import.meta.url));

async function apply(args: string[]): Promise<{ ok: boolean; out: string }> {
	try {
		const { stdout, stderr } = await run("sh", [SCRIPT, ...args], { timeout: 30_000 });
		return { ok: true, out: (stdout + stderr).trim() };
	} catch (error) {
		const e = error as { stdout?: string; stderr?: string; message?: string };
		return { ok: false, out: ((e.stdout ?? "") + (e.stderr ?? "")).trim() || (e.message ?? "patch run failed") };
	}
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		const { ok, out } = await apply(["--quiet"]);
		const patched = /restart pi to load them/.test(out);
		if (!ok) {
			ctx.ui.notify(`local patches: apply.sh failed\n${out}`, "error");
			return;
		}
		if (patched) ctx.ui.notify(`${out}\nRun /patches for detail.`, "warning");
		else pi.appendEntry("local-patches", { status: "up-to-date", at: Date.now() });
	});

	pi.registerCommand("patches", {
		description: "Local pi source patches: apply (default), or args: status | dry | all",
		handler: async (args, ctx) => {
			const flags: string[] = [];
			for (const word of (args ?? "").trim().split(/\s+/).filter(Boolean)) {
				if (word === "status") flags.push("--status");
				else if (word === "dry" || word === "--dry-run") flags.push("--dry-run");
				else if (word === "all") flags.push("--all");
			}
			const { ok, out } = await apply(flags);
			ctx.ui.notify(out, ok ? "info" : "error");
		},
	});
}
