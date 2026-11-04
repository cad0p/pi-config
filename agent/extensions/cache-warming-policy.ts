/**
 * cache-warming-policy — replace pi's hard-coded warming rule.
 *
 * Why: pi's cache-warmer warms when p·missCost − warmCost ≥ $0.05, with
 * p = IDLE_CONTINUATION_PROBABILITY = 0.15 while idle and p = 1 during a run
 * (both constants, no setting). On Opus 5.5 idle warming only fires above ~96k
 * prompt tokens, so 50–95k contexts eat a full cache rewrite (~$0.34 at 71k)
 * after 5 min idle, while a warm is ~$0.015. On cheaper models the $0.05 floor
 * also inverts the two phases: on Haiku a mid-run warm (next request certain)
 * needs ~45k tokens while an idle warm under P = 0.4 needs ~28k.
 *
 * Policy: warm when p·missCost − warmCost ≥ MIN, with p = P while idle (pi passes
 * p < 1) and pi's own p = 1 during a run. pi's 30-min idle and 1-h caps still apply.
 *
 * Tunables (env): PI_CACHE_WARM_P (default 0.4), PI_CACHE_WARM_MIN (default 0.01 $).
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const P = Number(process.env.PI_CACHE_WARM_P ?? 0.4);
const MIN = Number(process.env.PI_CACHE_WARM_MIN ?? 0.01);

export default function (pi: ExtensionAPI): void {
  pi.on("cache_warming_decision", (event) => {
    if (!(event.missCost > 0)) return undefined; // economics unavailable
    const p = event.continuationProbability >= 1 ? 1 : P;
    return { action: p * event.missCost - event.warmCost >= MIN ? "warm" : "stop" };
  });
}
