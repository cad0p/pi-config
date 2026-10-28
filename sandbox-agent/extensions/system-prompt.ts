/**
 * system-prompt — capitalize "pi" as a word in pi's system prompt.
 *
 * Why: the default prompt is rendered in before_agent_start, and the `sections`
 * API can't override the default preamble. So this extension rewrites the
 * rendered prompt instead. replaceWord only matches FROM as a standalone word,
 * so paths and package names such as /home/.../.pi/ and
 * @earendil-works/pi-coding-agent stay intact, because the agent reads files at
 * those paths.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const FROM = "pi";
const TO = "Pi";

/** Replace every standalone occurrence of `word`: not preceded or followed by path or identifier characters. */
function replaceWord(text: string, word: string, replacement: string): string {
	const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return text.replace(new RegExp(`(?<![\\w./@-])${escaped}(?![\\w/-]|\\.[\\w/])`, "g"), () => replacement);
}

export default function (pi: ExtensionAPI): void {
	pi.on("before_agent_start", async (event) => {
		return { systemPrompt: replaceWord(event.systemPrompt, FROM, TO) };
	});
}
