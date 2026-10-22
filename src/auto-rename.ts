/**
 * Session auto-rename.
 *
 * Renames the session once after the first agent_settled event, using a
 * short LLM-generated title. Best-effort: failures are silent.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { buildRenamePrompt } from "./prompts";
import { loadSettings } from "./settings";

export function registerAutoRename(pi: ExtensionAPI): void {
	// --- Auto-rename: rename the session once after the first agent_settled ---
	let autoRenamed = false;

	pi.on("agent_settled", async (_event, ctx) => {
		if (autoRenamed) return;

		const model = ctx.model;
		if (!model) return;

		// Extract user messages from the transcript.
		const entries = ctx.sessionManager.buildContextEntries();
		const userMessages: string[] = [];
		for (const entry of entries) {
			if (entry.type !== "message" || entry.message.role !== "user") continue;
			const text = entry.message.content
				.filter((b): b is { type: "text"; text: string } => b.type === "text")
				.map((b) => b.text)
				.join(" ")
				.trim();
			if (text) {
				// Cap oversized messages (pasted logs, dumps).
				if (text.length > 2000) {
					text = text.slice(0, 1500) + "\n\n[truncated]\n\n" + text.slice(-500);
				}
				userMessages.push(text);
			}
		}

		if (userMessages.length === 0) return;

		// Build the naming prompt.
		const first = userMessages[0];
		const recent = userMessages.slice(-3);
		const prompt = buildRenamePrompt({ firstMessage: first, recentMessages: recent });

		// Call the LLM.
			const { autonameSystemPromptPrefix } = loadSettings();
			const systemPrompt =
				autonameSystemPromptPrefix.trim()
					? `${autonameSystemPromptPrefix.trim()}

You generate short session titles. Respond with only the title.`
					: "You generate short session titles. Respond with only the title.";

		try {
			const response = await ctx.modelRegistry.complete(
				model,
				{
					systemPrompt,
					messages: [
						{
							role: "user" as const,
							content: [{ type: "text" as const, text: prompt }],
							timestamp: Date.now(),
						},
					],
				},
				{
					maxTokens: 100,
					timeoutMs: 10_000,
					cacheRetention: "none",
				},
			);

			const name = response.content
				.filter((c): c is { type: "text"; text: string } => c.type === "text")
				.map((c) => c.text)
				.join("")
				.trim();

			if (name) {
				pi.setSessionName(name);
				autoRenamed = true;
			}
		} catch {
			// Silently fail — naming is best-effort.
		}
	});
}
