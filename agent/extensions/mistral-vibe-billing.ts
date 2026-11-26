/**
 * mistral-vibe-billing — bill Mistral requests to the organisation's Vibe budget.
 *
 * Mistral charges a /v1/chat/completions call to the org's API budget unless the body carries
 * `metadata.call_source: "vibe_code"`, which is what the Vibe CLI (3.1.5) sends. Found 2026-11-26 by
 * capturing the CLI with mitmproxy: same endpoint, same key (its browser sign-in returned the key pi
 * already had), and only this field moved the charge. Live probe, deepseek-v4-1-flash-1017, the
 * dev/dev2/dev3 orgs (API budget 100 %, Vibe budget left): without it 402 billing_api_budget_exhausted,
 * with it 200; `client_name` alone does not do it, headers (user-agent, x-affinity) do not matter.
 *
 * pi's mistral-conversations provider spreads the payload onto the wire (toMistralWirePayload), so the
 * field reaches Mistral unchanged. Applies to `mistral` and every `mistral-<n>-…` alias slot.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const MISTRAL_PROVIDER = /^mistral(-|$)/;

export default function mistralVibeBilling(pi: ExtensionAPI) {
  pi.on("before_provider_request", (event, ctx) => {
    const provider = ctx.model?.provider;
    if (typeof provider !== "string" || !MISTRAL_PROVIDER.test(provider)) return undefined;
    const payload = event.payload;
    if (!payload || typeof payload !== "object" || !("messages" in payload)) return undefined;
    const current = (payload as { metadata?: unknown }).metadata;
    const metadata = { ...(current && typeof current === "object" ? current : {}), call_source: "vibe_code" };
    return { ...(payload as Record<string, unknown>), metadata };
  });
}
