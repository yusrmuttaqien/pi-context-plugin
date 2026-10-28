/**
 * Extension settings.
 *
 * Structurally mirrors pi-vcc's settings module (vendor/pi-vcc/src/core/settings.ts):
 * a JSON file in pi's agent dir, env-var path override, scaffoldSettings()
 * to create/fill the file, and loadSettings() merging with defaults.
 *
 * The config is namespaced by feature:
 *   {
 *     "autoname":   { systemPromptPrefix, refreshTurns },
 *     "compaction": { systemPromptPrefix, maxTokens, ceilings: { ... } }
 *   }
 *
 * loadSettings() and scaffoldSettings() transparently migrate the old flat
 * format (autonameSystemPromptPrefix, autonameRefreshTurns,
 * compactionSystemPromptPrefix, compactionMaxTokens, recallKeyBudget,
 * compactionTargetWords, tokensPerWord, padding) into this nested structure.
 * The old word-target knobs (compactionTargetWords, tokensPerWord, padding) are
 * dropped: length control is now per-section item ceilings plus a fixed
 * maxTokens backstop.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export const SETTINGS_PATH_DEFAULT = join(getAgentDir(), "pi-context-plugin-config.json");
const settingsPath = (): string =>
	process.env.PI_CONTEXT_PLUGIN_CONFIG_PATH ?? SETTINGS_PATH_DEFAULT;
/** Backwards-compat export. Resolves at access time, not import time. */
export const SETTINGS_PATH = settingsPath();

export interface AutonameSettings {
	/**
	 * Injected at the start of the auto-rename system prompt.
	 * Empty string = no injection (default).
	 */
	systemPromptPrefix: string;
	/**
	 * Re-evaluate the session title every N settled turns.
	 * 0 = one-shot (name only after the first settled turn).
	 */
	refreshTurns: number;
}

/** Per-section item ceilings for the lossy summary sections. */
export interface CompactionCeilings {
	/** Max standing-note items (Pref / Lesson / Routine). */
	standingNotes: number;
	/** Max key-decision items. */
	keyDecisions: number;
	/** Max in-progress items. */
	inProgress: number;
	/** Max next-step items. */
	nextSteps: number;
	/** Max done (thematic) bullets. */
	done: number;
	/** Max recall-key groups. */
	recallKeys: number;
}

export interface CompactionSettings {
	/**
	 * Injected at the start of the compaction system prompt.
	 * Empty string = no system prompt sent (default).
	 */
	systemPromptPrefix: string;
	/**
	 * Hard API maxTokens for the summary call — a backstop against runaway
	 * generation, not a length target. The per-section ceilings are the real
	 * length control.
	 */
	maxTokens: number;
	/** Per-section item ceilings for the lossy summary sections. */
	ceilings: CompactionCeilings;
}

export interface ContextPluginSettings {
	autoname: AutonameSettings;
	compaction: CompactionSettings;
}

export const DEFAULT_CEILINGS: CompactionCeilings = {
	standingNotes: 10,
	keyDecisions: 10,
	inProgress: 5,
	nextSteps: 5,
	done: 6,
	recallKeys: 10,
};

export const DEFAULT_SETTINGS: ContextPluginSettings = {
	autoname: {
		systemPromptPrefix: "",
		refreshTurns: 5,
	},
	compaction: {
		systemPromptPrefix: "",
		maxTokens: 4000,
		// Copy, not a reference to DEFAULT_CEILINGS, so mutating one can't
		// alias the other.
		ceilings: { ...DEFAULT_CEILINGS },
	},
};

const readJson = (path: string): Record<string, unknown> | null => {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return null;
	}
};

/** Coerce to string, failing closed to `fallback`. */
const coerceString = (v: unknown, fallback: string): string =>
	typeof v === "string" ? v : fallback;

/** Coerce to a non-negative integer, failing closed to `fallback`. */
const coerceNonNegativeInt = (v: unknown, fallback: number): number =>
	typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : fallback;

/** Coerce to a positive integer, failing closed to `fallback`. */
const coercePositiveInt = (v: unknown, fallback: number): number =>
	typeof v === "number" && Number.isSafeInteger(v) && v > 0 ? v : fallback;

/** Treat a value as a plain object, or an empty object if it isn't. */
const asRecord = (v: unknown): Record<string, unknown> =>
	(typeof v === "object" && v !== null ? v : {}) as Record<string, unknown>;

/**
 * Normalize a raw config object (old flat or new nested) into the nested
 * structure, coercing each value and filling missing keys with defaults.
 * New-format values take precedence over old flat keys. The removed
 * word-target knobs (compactionTargetWords, tokensPerWord, padding) are
 * ignored. A null old compactionMaxTokens (the old "auto" default) maps to
 * the new fixed default.
 */
function normalize(raw: Record<string, unknown>): ContextPluginSettings {
	const autonameRaw = asRecord(raw.autoname);
	const compactionRaw = asRecord(raw.compaction);
	const ceilingsRaw = asRecord(compactionRaw.ceilings);

	return {
		autoname: {
			systemPromptPrefix: coerceString(
				autonameRaw.systemPromptPrefix ?? raw.autonameSystemPromptPrefix,
				DEFAULT_SETTINGS.autoname.systemPromptPrefix,
			),
			refreshTurns: coerceNonNegativeInt(
				autonameRaw.refreshTurns ?? raw.autonameRefreshTurns,
				DEFAULT_SETTINGS.autoname.refreshTurns,
			),
		},
		compaction: {
			systemPromptPrefix: coerceString(
				compactionRaw.systemPromptPrefix ?? raw.compactionSystemPromptPrefix,
				DEFAULT_SETTINGS.compaction.systemPromptPrefix,
			),
			maxTokens: coercePositiveInt(
				compactionRaw.maxTokens ?? raw.compactionMaxTokens,
				DEFAULT_SETTINGS.compaction.maxTokens,
			),
			ceilings: {
				standingNotes: coercePositiveInt(ceilingsRaw.standingNotes, DEFAULT_CEILINGS.standingNotes),
				keyDecisions: coercePositiveInt(ceilingsRaw.keyDecisions, DEFAULT_CEILINGS.keyDecisions),
				inProgress: coercePositiveInt(ceilingsRaw.inProgress, DEFAULT_CEILINGS.inProgress),
				nextSteps: coercePositiveInt(ceilingsRaw.nextSteps, DEFAULT_CEILINGS.nextSteps),
				done: coercePositiveInt(ceilingsRaw.done, DEFAULT_CEILINGS.done),
				recallKeys: coercePositiveInt(
					ceilingsRaw.recallKeys ?? raw.recallKeyBudget,
					DEFAULT_CEILINGS.recallKeys,
				),
			},
		},
	};
}

export function loadSettings(): ContextPluginSettings {
	const parsed = readJson(settingsPath());
	if (!parsed || typeof parsed !== "object") return normalize({});
	return normalize(parsed);
}

/** Top-level keys the migration folds into the nested structure or drops. */
const MIGRATED_OR_REMOVED_KEYS = new Set([
	"autoname",
	"compaction",
	"autonameSystemPromptPrefix",
	"autonameRefreshTurns",
	"compactionSystemPromptPrefix",
	"compactionMaxTokens",
	"recallKeyBudget",
	"compactionTargetWords",
	"tokensPerWord",
	"padding",
]);

/**
 * Ensure the config file (Pi's agent dir, or PI_CONTEXT_PLUGIN_CONFIG_PATH)
 * exists in the nested structure.
 * - File missing → create with the full default block.
 * - File exists but invalid JSON → no-op (don't clobber user file).
 * - File exists and valid → migrate old flat keys into the nested structure,
 *   fill in missing keys, drop removed word-target knobs, preserve any other
 *   top-level keys, and write back (only if changed).
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
		const raw = parsed as Record<string, unknown>;

		const next = normalize(raw) as Record<string, unknown>;

		// Old flat keys and removed knobs are already folded into `next` (or
		// dropped); preserve any other top-level keys the user added.
		for (const key of Object.keys(raw)) {
			if (!MIGRATED_OR_REMOVED_KEYS.has(key)) next[key] = raw[key];
		}

		const nextStr = JSON.stringify(next, null, 2);
		if (nextStr !== JSON.stringify(raw, null, 2)) {
			writeFileSync(path, `${nextStr}\n`);
		}
	} catch {
		// best-effort; never crash extension load
	}
}
