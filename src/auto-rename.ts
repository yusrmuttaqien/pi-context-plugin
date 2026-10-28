/**
 * Auto-rename handler.
 *
 * After the first settled agent turn, generates a short session title from
 * the conversation and sets it via `pi.setSessionName`. Best-effort; failures
 * are silent.
 *
 * The title uses a two-section format — `main topic: latest context`
 * — so a single chat that progresses to new topics keeps a name that tracks
 * where the conversation is now, not where it started. Both parts update as
 * the conversation moves. To support that, the naming call re-runs every
 * `autoname.refreshTurns` settled turns (0 = one-shot), and the model may
 * respond NO_CHANGE when the current title still fits.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { buildRenamePrompt, RENAME_NO_CHANGE } from "./prompts";
import { loadSettings } from "./settings";
import { readAutonameState } from "./autoname-toggle";

/** Per-message cap for the naming call — titles only need a slice of each message. */
const TITLE_MESSAGE_CAP = 500;

/**
 * Select the user messages the naming call sees: the first, up to three
 * evenly sampled from the middle, and the last three. The main topic must
 * be derivable from the whole conversation, not just the first message —
 * topics can shift mid-conversation.
 */
function selectMessagesForTitle(userMessages: string[]): string[] {
	const n = userMessages.length;
	if (n <= 5) return [...userMessages];

	const first = userMessages[0];
	const recent = userMessages.slice(-3);
	const middle = userMessages.slice(1, n - 3);
	const count = Math.min(3, middle.length);
	const sampled: string[] = [];
	for (let i = 0; i < count; i++) {
		const idx = Math.min(
			middle.length - 1,
			Math.floor(((i + 0.5) * middle.length) / count),
		);
		if (!sampled.includes(middle[idx])) sampled.push(middle[idx]);
	}
	return [first, ...sampled, ...recent];
}

export function registerAutoRename(pi: ExtensionAPI): void {
	let settledCount = 0;
	let currentTitle: string | null = null;
	let wasEnabled = true; // mirrors the persisted state; used to detect re-enable

	pi.on("agent_settled", async (_event, ctx) => {
		settledCount++;

		// Auto-rename is a per-session, user-toggleable feature. Read the
		// persisted state (custom entry) each turn; when disabled, skip
		// naming entirely. Re-enabling forces one immediate rename so the
		// title doesn't sit stale until the next refreshTurns boundary.
		const enabled = readAutonameState(ctx.sessionManager);
		const isReEnable = enabled && !wasEnabled;
		wasEnabled = enabled;
		if (!enabled) return;

		const { autoname } = loadSettings();
		const isFirst = currentTitle === null;
		const due =
			isFirst ||
			isReEnable ||
			(autoname.refreshTurns > 0 && settledCount % autoname.refreshTurns === 0);
		if (!due) return;

		const model = ctx.model;
		if (!model) return;

		// Extract user messages from the transcript.
		const entries = ctx.sessionManager.buildContextEntries();
		const userMessages: string[] = [];
		for (const entry of entries) {
			if (entry.type !== "message" || entry.message.role !== "user") continue;
			let text = entry.message.content
				.filter((b): b is { type: "text"; text: string } => b.type === "text")
				.map((b) => b.text)
				.join(" ")
				.trim();
			if (!text) continue;
			if (text.length > TITLE_MESSAGE_CAP) {
				text = `${text.slice(0, 400)}\n...\n${text.slice(-100)}`;
			}
			userMessages.push(text);
		}

		if (userMessages.length === 0) return;

		const prompt = buildRenamePrompt({
			messages: selectMessagesForTitle(userMessages),
			currentTitle: currentTitle ?? undefined,
		});

		const systemPrompt = autoname.systemPromptPrefix.trim()
			? `${autoname.systemPromptPrefix.trim()}\n\nYou generate short session titles. Respond with only the title.`
			: "You generate short session titles. Respond with only the title.";

		// Call the LLM.
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

			if (name && name.toUpperCase() !== RENAME_NO_CHANGE.toUpperCase()) {
				pi.setSessionName(name);
				currentTitle = name;
			}
		} catch {
			// Silently fail — naming is best-effort.
		}
	});
}
