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
 *
 * The same naming logic is exposed as the `/rename` command, which runs the
 * auto-rename on demand (it works even when `/autoname` is off, since it is an
 * explicit user action) and reports the outcome to the user.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
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

/** Outcome of a naming attempt, reported by the `/rename` command. */
type RenameOutcome =
	| { status: "renamed"; name: string }
	| { status: "no-change" }
	| { status: "nothing" }
	| { status: "error" };

export function registerAutoRename(pi: ExtensionAPI): void {
	let settledCount = 0;
	let currentTitle: string | null = null;
	let wasEnabled = true; // mirrors the persisted state; used to detect re-enable

	/**
	 * Run one naming pass: extract user messages, build the prompt, call the
	 * LLM, and set the session name. Shared by the `agent_settled` handler
	 * (silent) and the `/rename` command (reports the outcome). The current
	 * title is read from the session manager (authoritative, survives
	 * restarts) so the model can respond NO_CHANGE when the title still fits.
	 */
	async function runRename(ctx: ExtensionContext): Promise<RenameOutcome> {
		const model = ctx.model;
		if (!model) return { status: "error" };

		const { autoname } = loadSettings();

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

		if (userMessages.length === 0) return { status: "nothing" };

		const prompt = buildRenamePrompt({
			messages: selectMessagesForTitle(userMessages),
			currentTitle: ctx.sessionManager.getSessionName() ?? currentTitle ?? undefined,
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
				return { status: "renamed", name };
			}
			return { status: "no-change" };
		} catch {
			// Naming is best-effort; surface a failure for the command to report.
			return { status: "error" };
		}
	}

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

		// Silent — background naming is best-effort.
		await runRename(ctx);
	});

	pi.registerCommand("rename", {
		description:
			"Run the auto-rename now (LLM-generated title). Works even when /autoname is off.",
		handler: async (_args, ctx) => {
			const result = await runRename(ctx);
			if (!ctx.hasUI) return;
			switch (result.status) {
				case "renamed":
					ctx.ui.notify(`Session renamed to: ${result.name}`, "info");
					break;
				case "no-change":
					ctx.ui.notify("Auto-rename: no change (current title still fits)", "info");
					break;
				case "nothing":
					ctx.ui.notify("Auto-rename: nothing to rename yet", "info");
					break;
				case "error":
					ctx.ui.notify("Auto-rename: no title produced", "info");
					break;
			}
		},
	});
}
