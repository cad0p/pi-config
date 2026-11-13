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
 * code 2021 "Insufficient balance", so it stays out of the rule; the bulletin's job is to name the route
 * that works, not to teach a caveat.
 *
 * Jev direct is now the default because the account carries credits and the route is better on paper:
 * 64,000-token context against Clef Flash's 24,576, no reseller fee, and ZDR by request on our own org.
 * On accuracy the two tie (6/8 on the same items, failing the same two), so the model choice is decided
 * by context and custody, not by the benchmark. Note that pi cannot price this call: the catalog has no
 * cost for TypeSafe's direct provider and modelOverrides applies to chat models only, so Jev spend is
 * invisible in the session footer. Clef Flash stays the fallback and is the priced, neuron-billed route.
 *
 * The wording is measured, not chosen: six runs per arm against opencode-go-11/deepseek-v4.1-flash:max
 * in an agent dir with no vault and no project instructions — no rule 0/6 named clef-flash, this rule
 * 6/6 named it and the provider, the longer "For classification tasks, use … from …" variant 6/6 and
 * 4/6. The two differ inside the noise (n=6), so the shorter one wins on length alone.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const BULLET = "For classification, use `jev-latest` from `typesafe` (ZDR).";

export default function (pi: ExtensionAPI): void {
  pi.on("before_agent_start", async (event) => {
    const rules = event.systemPromptOptions.promptGuidelines;
    if (!rules.includes(BULLET)) rules.push(BULLET);
  });
}
