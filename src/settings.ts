/**
 * Extension settings.
 *
 * Structurally mirrors pi-vcc's settings module (vendor/pi-vcc/src/core/settings.ts):
 * a JSON file in pi's agent dir, env-var path override, scaffoldSettings()
 * to create/fill the file, and loadSettings() merging with defaults.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export const SETTINGS_PATH_DEFAULT = join(getAgentDir(), "pi-context-plugin-config.json");
const settingsPath = (): string =>
	process.env.PI_CONTEXT_PLUGIN_CONFIG_PATH ?? SETTINGS_PATH_DEFAULT;
/** Backwards-compat export. Resolves at access time, not import time. */
export const SETTINGS_PATH = settingsPath();

export interface ContextPluginSettings {
	/**
	 * Injected at the start of the auto-rename system prompt.
	 * Empty string = no injection (default).
	 */
	autonameSystemPromptPrefix: string;
	/**
	 * Injected at the start of the compaction system prompt.
	 * Empty string = no system prompt sent (default).
	 */
	compactionSystemPromptPrefix: string;
	/**
	 * Re-evaluate the session title every N settled turns.
	 * 0 = one-shot (name only after the first settled turn).
	 */
	autonameRefreshTurns: number;
}

export const DEFAULT_SETTINGS: ContextPluginSettings = {
	autonameSystemPromptPrefix: "",
	compactionSystemPromptPrefix: "",
	autonameRefreshTurns: 5,
};

const readJson = (path: string): Record<string, unknown> | null => {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return null;
	}
};

/** Coerce a setting value to string, failing closed to "". */
const coerceString = (v: unknown): string =>
	typeof v === "string" ? v : "";

/** Coerce a setting value to a non-negative integer, failing closed to 0 (one-shot). */
const coerceNonNegativeInt = (v: unknown): number =>
	typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : 0;

export function loadSettings(): ContextPluginSettings {
	const parsed = readJson(settingsPath());
	if (!parsed || typeof parsed !== "object") return { ...DEFAULT_SETTINGS };
	const merged = { ...DEFAULT_SETTINGS, ...(parsed as Partial<ContextPluginSettings>) };
	merged.autonameSystemPromptPrefix = coerceString(parsed.autonameSystemPromptPrefix);
	merged.compactionSystemPromptPrefix = coerceString(parsed.compactionSystemPromptPrefix);
	merged.autonameRefreshTurns = coerceNonNegativeInt(parsed.autonameRefreshTurns);
	return merged;
}

/**
 * Ensure the config file (Pi's agent dir, or PI_CONTEXT_PLUGIN_CONFIG_PATH)
 * exists with default keys.
 * - File missing → create with full default block.
 * - File exists but invalid JSON → no-op (don't clobber user file).
 * - File exists and valid → fill in missing default keys, preserve existing values.
 */
export function scaffoldSettings(): void {
	try {
		const path = settingsPath();
		const dir = dirname(path);
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

		if (!existsSync(path)) {
			writeFileSync(path, `${JSON.stringify(DEFAULT_SETTINGS, null, 2)}\n`);
			return;
		}

		const parsed = readJson(path);
		if (!parsed || typeof parsed !== "object") return; // don't clobber

		let changed = false;
		const next: Record<string, unknown> = { ...parsed };
		for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
			if (!(key in next)) {
				next[key] = value;
				changed = true;
			}
		}
		if (changed) writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`);
	} catch {
		// best-effort; never crash extension load
	}
}
