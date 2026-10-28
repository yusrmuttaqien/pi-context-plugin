/**
 * Per-session auto-rename toggle.
 *
 * The user can disable auto-rename for the current session with the
 * `/autoname` command. The state is persisted in the session itself as a
 * custom entry (`type: "custom"`, `customType: "pi-context-autoname"`).
 * Storing it as a custom entry means it:
 *   - is scoped to this session (each session has its own entry stream),
 *   - survives pi restarts and session resume,
 *   - is NOT sent to the LLM (custom entries are ignored by the context builder),
 *   - is still reachable after compaction, because we read it from the raw
 *     branch path (`getBranch()`), which is not filtered by compaction.
 *
 * Default is enabled. The state is read on every settled turn to gate the
 * auto-rename handler, and re-enabling forces one immediate rename so the
 * title doesn't sit stale until the next `refreshTurns` boundary.
 */

import type {
	ExtensionAPI,
	ExtensionContext,
	SessionEntry,
} from "@earendil-works/pi-coding-agent";

/** customType used to tag the per-session autoname state entry. */
export const AUTONAME_ENTRY_TYPE = "pi-context-autoname";

/** Shape of the data stored on the autoname custom entry. */
export interface AutonameEntryData {
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
export function readAutonameState(sm: { getBranch(): SessionEntry[] }): boolean {
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
export function writeAutonameState(pi: ExtensionAPI, enabled: boolean): void {
	const data: AutonameEntryData = { enabled, at: Date.now() };
	pi.appendEntry(AUTONAME_ENTRY_TYPE, data);
}

/**
 * Reflect the current state in the footer status bar. Only shows an indicator
 * when auto-rename is disabled (enabled is the default and unremarkable).
 * No-op in modes without UI (e.g. `print`).
 */
export function reflectStatus(ctx: ExtensionContext, enabled: boolean): void {
	if (!ctx.hasUI) return;
	ctx.ui.setStatus("autoname", enabled ? undefined : "autoname: off");
}

/**
 * Register the `/autoname` command and restore the status indicator on
 * session start/resume.
 *
 * Arguments:
 *   - (none)    -> toggle
 *   - on        -> enable for this session
 *   - off       -> disable for this session
 *   - status    -> show the current state (no change)
 *   - anything else -> usage hint, no change
 */
export function registerAutonameToggle(pi: ExtensionAPI): void {
	pi.registerCommand("autoname", {
		description:
			"Toggle auto-rename for this session. No argument toggles; `on`/`off` set it; `status` shows the current state.",
		handler: async (args, ctx) => {
			const arg = args.trim().toLowerCase();
			const current = readAutonameState(ctx.sessionManager);

			if (arg === "status") {
				reflectStatus(ctx, current);
				ctx.ui.notify(
					`Auto-rename is ${current ? "on" : "off"} for this session.`,
					"info",
				);
				return;
			}

			let next: boolean;
			if (arg === "on") next = true;
			else if (arg === "off") next = false;
			else if (arg === "") next = !current; // no argument -> toggle
			else {
				ctx.ui.notify(
					"Usage: /autoname [on|off|status]  (no argument toggles)",
					"info",
				);
				return;
			}

			writeAutonameState(pi, next);
			reflectStatus(ctx, next);
			ctx.ui.notify(
				`Auto-rename is now ${next ? "on" : "off"} for this session.`,
				"info",
			);
		},
	});

	// On session start/resume, reflect the persisted state in the status bar.
	pi.on("session_start", (_event, ctx) => {
		reflectStatus(ctx, readAutonameState(ctx.sessionManager));
	});
}
