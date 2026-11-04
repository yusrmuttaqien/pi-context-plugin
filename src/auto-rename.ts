/**
 * Session auto-rename: retitle the session from its live context.
 *
 * The automatic retitle rides on `agent_before_settle` and reuses the model's
 * existing context (`event.context.llmMessages`) as a prefix-cache hit: the
 * whole conversation is sent as-is and only the trailing title instruction is
 * new input, so the call is cheap and writes nothing back into the session
 * (only `pi.setSessionName`, which is metadata, not a message).
 *
 * The per-session `/auto-rename` toggle and the on-demand `/rename` live here
 * too. `/rename` is a cold call over a re-sampled slice of the user messages
 * (it has no live context to reuse), and works even when `/auto-rename` is
 * off, since it is an explicit user action.
 *
 * The title uses a two-section format — `main topic: latest context` — so a
 * single chat that progresses to new topics keeps a name that tracks where the
 * conversation is now. The naming call re-runs every `autoname.refreshTurns`
 * turns (0 = one-shot), and the model may respond NO_CHANGE when the current
 * title still fits.
 */

import type {
	ExtensionAPI,
	ExtensionContext,
	SessionEntry,
} from "@earendil-works/pi-coding-agent";
import type { Message } from "@earendil-works/pi-ai";
import { loadSettings } from "./settings";
import { buildRenamePrompt, buildTitleInstruction, RENAME_NO_CHANGE } from "./prompts";

// --- Per-session toggle state (custom entry) ---

/** customType used to tag the per-session autoname state entry. */
const AUTONAME_ENTRY_TYPE = "pi-context-autoname";

/** Shape of the data stored on the autoname custom entry. */
interface AutonameEntryData {
	enabled: boolean;
	at: number;
}

/**
 * Read the current auto-rename state for this session from the active branch.
 * Returns the most recent autoname entry's `enabled` flag; defaults to true
 * (enabled) when the session has no such entry yet or the entry is malformed.
 *
 * Uses `getBranch()` (the full structural path, root -> leaf) rather than
 * `buildContextEntries()`, so the entry is found even when it predates a
 * compaction boundary. Branching to a point before the entry correctly
 * reverts to the default (enabled) for that earlier context.
 */
function readAutonameState(sm: { getBranch(): SessionEntry[] }): boolean {
	const branch = sm.getBranch();
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry.type === "custom" && entry.customType === AUTONAME_ENTRY_TYPE) {
			const data = entry.data as AutonameEntryData | undefined;
			return data && typeof data.enabled === "boolean" ? data.enabled : true;
		}
	}
	return true;
}

/** Persist a new auto-rename state as a custom entry (per-session, reload-safe). */
function writeAutonameState(pi: ExtensionAPI, enabled: boolean): void {
	const data: AutonameEntryData = { enabled, at: Date.now() };
	pi.appendEntry(AUTONAME_ENTRY_TYPE, data);
}

/**
 * Reflect the current state in the footer status bar. Only shows an indicator
 * when auto-rename is disabled (enabled is the default and unremarkable).
 * No-op in modes without UI (e.g. `print`).
 */
function reflectStatus(ctx: ExtensionContext, enabled: boolean): void {
	if (!ctx.hasUI) return;
	ctx.ui.setStatus("autoname", enabled ? undefined : "autoname: off");
}

// --- Naming ---

/** Per-message cap for the naming call — titles only need a slice of each message. */
const TITLE_MESSAGE_CAP = 500;

/**
 * Select the user messages the cold naming call sees: the first, up to three
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

/** Extract the user messages from the transcript (for the cold /rename path). */
function extractUserMessages(ctx: ExtensionContext): string[] {
	const entries = ctx.sessionManager.buildContextEntries();
	const userMessages: string[] = [];
	for (const entry of entries) {
		if (entry.type !== "message" || entry.message.role !== "user") continue;
		const raw = entry.message.content;
		const text = (
			typeof raw === "string"
				? raw
				: raw
						.filter((block): block is { type: "text"; text: string } => block.type === "text")
						.map((block) => block.text)
						.join(" ")
		).trim();
		if (!text) continue;
		userMessages.push(
			text.length > TITLE_MESSAGE_CAP
				? `${text.slice(0, 400)}\n...\n${text.slice(-100)}`
				: text,
		);
	}
	return userMessages;
}

function buildTitleSystemPrompt(prefix: string): string {
	return prefix.trim()
		? `${prefix.trim()}\n\nYou generate short session titles. Respond with only the title.`
		: "You generate short session titles. Respond with only the title.";
}

/** Outcome of a naming attempt, reported by the `/rename` command. */
type RenameOutcome =
	| { status: "renamed"; name: string }
	| { status: "no-change" }
	| { status: "nothing" }
	| { status: "error" };

export function registerAutoRename(pi: ExtensionAPI): void {
	let runCount = 0;
	let currentTitle: string | null = null;
	let wasEnabled = true; // mirrors the persisted state; used to detect re-enable

	/**
	 * Run one naming pass and set the session name.
	 *
	 * When `llmMessages` is provided (the automatic path), the live context is
	 * sent as-is and only the trailing instruction is new input, so the call is
	 * a prefix-cache hit. When it is not (the on-demand /rename path), a
	 * re-sampled slice of the user messages is built and the call is cold.
	 */
	async function runRename(ctx: ExtensionContext, llmMessages?: Message[]): Promise<RenameOutcome> {
		const model = ctx.model;
		if (!model) return { status: "error" };

		const { autoname } = loadSettings();
		const title = ctx.sessionManager.getSessionName() ?? currentTitle ?? undefined;
		const freePrefill = !!llmMessages && llmMessages.length > 0;

		let systemPrompt: string | undefined;
		let messages: Message[];
		if (freePrefill) {
			messages = [
				...llmMessages!,
				{ role: "user", content: buildTitleInstruction(title), timestamp: Date.now() },
			];
		} else {
			const userMessages = extractUserMessages(ctx);
			if (userMessages.length === 0) return { status: "nothing" };
			systemPrompt = buildTitleSystemPrompt(autoname.systemPromptPrefix);
			messages = [
				{
					role: "user",
					content: [
						{
							type: "text",
							text: buildRenamePrompt({
								messages: selectMessagesForTitle(userMessages),
								currentTitle: title,
							}),
						},
					],
					timestamp: Date.now(),
				},
			];
		}

		try {
			const response = await ctx.modelRegistry.complete(
				model,
				{ systemPrompt, messages },
				{
					maxTokens: 100,
					timeoutMs: 10_000,
					// Cold path: don't retain the cache. Free-prefill path: leave the
					// default so the main conversation's warm KV cache is reused.
					...(freePrefill ? {} : { cacheRetention: "none" as const }),
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

	// Automatic retitle: first run, then every refreshTurns runs. It rides on
	// agent_before_settle (not agent_settled) so it can reuse the live context
	// for a prefix-cache hit. Awaiting the short title call blocks settlement
	// for a few seconds — the price of the free prefill.
	pi.on("agent_before_settle", async (event, ctx) => {
		runCount++;

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
			(autoname.refreshTurns > 0 && runCount % autoname.refreshTurns === 0);
		if (!due) return;

		// Silent — background naming is best-effort.
		await runRename(ctx, event.context.llmMessages);
	});

	pi.registerCommand("auto-rename", {
		description:
			"Toggle auto-rename for this session. No argument toggles; `on`/`off` set it; `status` shows the current state.",
		handler: async (args, ctx) => {
			const arg = args.trim().toLowerCase();
			const current = readAutonameState(ctx.sessionManager);

			if (arg === "status") {
				reflectStatus(ctx, current);
				ctx.ui.notify(`Auto-rename is ${current ? "on" : "off"} for this session.`, "info");
				return;
			}

			let next: boolean;
			if (arg === "on") next = true;
			else if (arg === "off") next = false;
			else if (arg === "") next = !current; // no argument -> toggle
			else {
				ctx.ui.notify("Usage: /auto-rename [on|off|status]  (no argument toggles)", "info");
				return;
			}

			writeAutonameState(pi, next);
			reflectStatus(ctx, next);
			ctx.ui.notify(`Auto-rename is now ${next ? "on" : "off"} for this session.`, "info");
		},
	});

	pi.registerCommand("rename", {
		description:
			"Run the auto-rename now (LLM-generated title). Works even when /auto-rename is off.",
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

	// On session start/resume, reflect the persisted state in the status bar.
	pi.on("session_start", (_event, ctx) => {
		reflectStatus(ctx, readAutonameState(ctx.sessionManager));
	});
}
