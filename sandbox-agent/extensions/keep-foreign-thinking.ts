/**
 * Keeps earlier thinking on model switch for compatible models.
 * By default pi discards it, which degrades performance.
 *
 * IMPORTANT: pi's context runner compares the returned array with the input by
 * element identity (runner.js: sameMessages). Editing messages in place therefore
 * looks like "no change", the result is dropped, and the thinking is never sent.
 * The handler must return { messages }.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const CLOSED_MODEL_PREFIXES = ["claude-", "gemini", "gpt-", "grok-", "muse-"];

export default function (pi: ExtensionAPI) {
    pi.on("context", (event, ctx) => {
        const target = ctx.model;
        if (!target) return;
        // openai-completions replays the field named by thinkingSignature.
        // anthropic-messages needs a real opaque signature blob and rejects forgeries.
        if (!["openai-completions", "openai-responses"].includes(target.api)) return;
        if (CLOSED_MODEL_PREFIXES.some((prefix) => target.id.toLowerCase().startsWith(prefix))) return;

        let changed = false;
        for (const msg of event.messages) {
            if (msg.role !== "assistant") continue;
            if (!Array.isArray(msg.content)) continue;
            if (msg.provider === target.provider && msg.api === target.api && msg.model === target.id) continue;

            msg.provider = target.provider;
            msg.api = target.api;
            msg.model = target.id;
            changed = true;

            for (const block of msg.content) {
                if (block.type !== "thinking") continue;
                block.thinkingSignature =
                    target.api === "openai-responses"
                        ? JSON.stringify({ type: "reasoning", summary: [], content: [{ type: "reasoning_text", text: block.thinking }] })
                        : "reasoning_content";
            }
        }
        if (changed) return { messages: event.messages };
    });
}
