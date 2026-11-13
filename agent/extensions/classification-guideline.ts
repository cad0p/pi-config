/**
 * classification-guideline — one <rules> bullet naming the ZDR classifier route.
 *
 * Not in AGENTS.md: that file is repo behaviour, this is harness tooling. Mutating
 * promptGuidelines is the documented way to add a <rules> bullet, and Pi diffs the
 * sections, so only <rules> is patched instead of the whole prompt.
 * Why this model, why the wording, and the eval behind it: pi-config#15.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const BULLET = "For classification, use `@cf/cloudflare/clef-flash` on `cloudflare-workers-ai` (ZDR).";

export default function (pi: ExtensionAPI): void {
  pi.on("before_agent_start", async (event) => {
    const rules = event.systemPromptOptions.promptGuidelines;
    if (!rules.includes(BULLET)) rules.push(BULLET);
  });
}
