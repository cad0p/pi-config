/**
 * classification-guideline — the classifier rule lives in the system prompt's <rules>, not in AGENTS.md.
 *
 * Why here: AGENTS.md is for how to behave in a repository, this is how to use harness tooling, so it
 * belongs to the prompt Pi builds rather than to a project's instructions. before_agent_start exposes
 * the structured options Pi renders, and promptGuidelines is its "<rules>" collection: mutating it is
 * the documented way to add a rule, and Pi diffs the resulting sections, so only the rules section is
 * patched instead of the whole prompt being replaced (a cache miss).
 *
 * Why the rule exists at all: `models.classify()` is the only LLM path inside a codemode script, and
 * the same model name is reachable through several providers. Bare `typesafe/jev` exists only on
 * cloudflare-workers-ai, but the OpenRouter rows (`typesafe/jev-1.13`, `jev-1.14`, `~typesafe/jev-latest`)
 * are listed first and look identical while carrying no retention commitment of ours. Workers AI is
 * the route whose data-usage page commits to zero data retention for standard inference.
 *
 * Why clef-flash specifically: it is Cloudflare-hosted (no third party in the path), billed in Workers
 * AI neurons so the free 10,000-a-day allocation covers it (~2.9M input tokens/day), and at $0.038/M
 * input with free output it is the cheapest of the family. `typesafe/jev` is the better model on paper
 * (32k context, calibrated probabilities, the same $0.042/M TypeSafe charges direct) but it is a
 * third-party row billed through AI Gateway Unified Billing: until credits are loaded it answers 402
 * code 2021 "Insufficient balance", so naming it as the default would send every first call into an error.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const BULLET =
  "Classification: `@cf/cloudflare/clef-flash` on `cloudflare-workers-ai` (ZDR); `typesafe/jev` needs AI Gateway credits.";

export default function (pi: ExtensionAPI): void {
  pi.on("before_agent_start", async (event) => {
    const rules = event.systemPromptOptions.promptGuidelines;
    if (!rules.includes(BULLET)) rules.push(BULLET);
  });
}
