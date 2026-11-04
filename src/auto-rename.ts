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
 * too. Both flows reuse the model's live context as a prefix-cache hit; `/rename`
 * reconstructs that context from the session (it has no settle event to ride
 * on) and works even when `/auto-rename` is off, since it is an explicit user
 * action.
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
import { convertToLlm } from "@earendil-works/pi-coding-agent";
import type { Message } from "@earendil-works/pi-ai";
import { loadSettings } from "./settings";
import { buildTitleInstruction, RENAME_NO_CHANGE } from "./prompts";

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
	ctx.ui.setStatus("auto-rename", enabled ? undefined : "auto-rename: off");
}

// --- Naming ---

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
	 * Both flows reuse the model's live context as a prefix-cache hit: the whole
	 * conversation is sent as-is and only the trailing title instruction is new
	 * input. The automatic path gets `llmMessages` from the settle event; the
	 * on-demand /rename path reconstructs the same context from the session.
	 */
	async function runRename(ctx: ExtensionContext, llmMessages?: Message[]): Promise<RenameOutcome> {
		const model = ctx.model;
		if (!model) return { status: "error" };

		const { autoname } = loadSettings();
		const title = ctx.sessionManager.getSessionName() ?? currentTitle ?? undefined;

		const context =
			llmMessages ?? convertToLlm(ctx.sessionManager.buildSessionProjection().messages);
		// Nothing to title yet: no conversation (only the system message, if any).
		if (!context.some((m) => m.role !== "system")) return { status: "nothing" };

		const prefix = autoname.systemPromptPrefix.trim();
		const instruction = prefix
			? `${prefix}\n\n${buildTitleInstruction(title)}`
			: buildTitleInstruction(title);

		const messages: Message[] = [
			...context,
			{ role: "user", content: instruction, timestamp: Date.now() },
		];

		try {
			const response = await ctx.modelRegistry
				.streamSimple(model, { messages }, {
					maxTokens: 100,
					timeoutMs: 10_000,
					// Reuse the main conversation's warm prefix cache: the context is
					// byte-identical to the last turn's request, so only the trailing
					// instruction is new input.
					sessionId: ctx.sessionManager.getSessionId(),
				})
				.result();

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
