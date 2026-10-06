/**
 * git-editor-env — keep git's message editor non-interactive for agent shells.
 *
 * Why: EDITOR is `omarchy-launch-editor --inline` → Zed (GUI). Any git command
 * that needs a message (commit/tag without -m, merge, rebase -i) pops a
 * detached Zed window mid-run, and git gets no blocking editor. Tests and lens
 * agents do this constantly in /tmp fixtures; there is nothing to edit.
 *
 * The bash/powershell tools spawn with `getShellEnv() = { ...process.env, PATH }`
 * resolved at command time, so setting process.env here covers every agent
 * shell, subagent, and process they spawn. Your interactive terminal is
 * unaffected: core.editor / $EDITOR still apply there.
 *
 * Precedence: only set when not already present, so `GIT_EDITOR=nvim pi` wins.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (_pi: ExtensionAPI): void {
  process.env.GIT_EDITOR ??= "true";
  process.env.GIT_SEQUENCE_EDITOR ??= "true";
}
