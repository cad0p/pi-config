/**
 * codemode-workers — raise the process-wide codemode worker pool from 2 to 6.
 *
 * Why: every session and in-process subagent shares one pool (default 2). Two
 * subagents holding long scripts lock the parent out ("No codemode worker
 * became free within 60 seconds"). Stopgap until per-session fairness lands:
 * https://github.com/earendil-works/pi/issues/11350
 *
 * pi reads PI_CODEMODE_MAX_WORKERS on every admission (execute.ts
 * maxCodemodeWorkers(): "Read per call so SDK hosts can set it at runtime"),
 * so setting process.env at extension load is enough. Each worker's VM may use
 * up to 256 MB.
 *
 * Precedence: only set when not already present, so
 * `PI_CODEMODE_MAX_WORKERS=4 pi` wins.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (_pi: ExtensionAPI): void {
  process.env.PI_CODEMODE_MAX_WORKERS ??= "6";
}
