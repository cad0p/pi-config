/**
 * cache-warming-policy — replace pi's hard-coded idle continuation probability.
 *
 * Why: pi's cache-warmer uses IDLE_CONTINUATION_PROBABILITY = 0.15 (constant, no
 * setting) and requires p·missCost − warmCost ≥ $0.05. On Opus 5.5 that means
 * idle warming only fires above ~96k prompt tokens, so 50–95k contexts eat a
 * full cache rewrite (~$0.34 at 71k) after 5 min idle, while a warm is ~$0.015.
 *
 * Policy: during idle (pi passes p < 1), warm when P·missCost − warmCost ≥ MIN.
 * Streaming decisions (p = 1) are left to pi. pi's 30-min idle cap still applies.
 *
 * Tunables (env): PI_CACHE_WARM_P (default 0.4), PI_CACHE_WARM_MIN (default 0.01 $).
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const P = Number(process.env.PI_CACHE_WARM_P ?? 0.4);
const MIN = Number(process.env.PI_CACHE_WARM_MIN ?? 0.01);

export default function (pi: ExtensionAPI): void {
  pi.on("cache_warming_decision", (event) => {
    if (event.continuationProbability >= 1) return undefined; // streaming: pi decides
    if (!(event.missCost > 0)) return undefined; // economics unavailable
    return { action: P * event.missCost - event.warmCost >= MIN ? "warm" : "stop" };
  });
}
