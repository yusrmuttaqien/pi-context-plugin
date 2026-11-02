import { Input, type Component } from "@earendil-works/pi-tui";
import {
	SessionManager,
	type ExtensionAPI,
	type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { stat, readdir, unlink, rename, mkdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";

/** The extension context passed to command handlers. */
type Ctx = Parameters<Parameters<ExtensionAPI["registerCommand"]>[1]["handler"]>[1];

/* ------------------------------------------------------------------ */
/* Session discovery                                                   */
/* ------------------------------------------------------------------ */

interface SessionRow {
	file: string;
	id: string;
	name: string;
	cwd: string;
	date: string;
	mtimeMs: number;
}

interface SessionGroup {
	dir: string;
	isCurrent: boolean;
	sessions: SessionRow[];
}

function getAgentDir(): string {
	return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

/** Scan all session files under the agent sessions root. */
async function scanSessions(): Promise<SessionRow[]> {
	const sessionsRoot = join(getAgentDir(), "sessions");
	if (!existsSync(sessionsRoot)) return [];
	const rows: SessionRow[] = [];
	let dirs: string[];
	try {
		dirs = (await readdir(sessionsRoot, { withFileTypes: true }))
			.filter((e) => e.isDirectory())
			.map((e) => e.name);
	} catch {
		return rows;
	}
	for (const dirName of dirs) {
		const dirPath = join(sessionsRoot, dirName);
		let files: string[];
		try {
			files = await readdir(dirPath);
		} catch {
			continue;
		}
		for (const file of files) {
			if (!file.endsWith(".jsonl")) continue;
			const filePath = join(dirPath, file);
			let st;
			try {
				st = await stat(filePath);
			} catch {
				continue;
			}
			if (!st.isFile()) continue;
			rows.push({
				file: filePath,
				id: basename(file, ".jsonl"),
				name: "",
				cwd: dirName,
				date: new Date(st.mtimeMs).toISOString().slice(0, 10),
				mtimeMs: st.mtimeMs,
			});
		}
	}
	for (const row of rows) {
		row.name = (await readSessionName(row.file)) || row.id.slice(0, 8);
	}
	return rows;
}

/** Read a session's name from its session_info entries (falls back to null). */
async function readSessionName(file: string): Promise<string | null> {
	try {
		const content = await readFile(file, "utf8");
		for (const line of content.split("\n")) {
			if (!line.trim()) continue;
			try {
				const entry = JSON.parse(line);
				if (entry.type === "session_info" && typeof entry.name === "string" && entry.name) {
					return entry.name;
				}
			} catch {
				/* skip malformed line */
			}
		}
	} catch {
		/* unreadable file */
	}
	return null;
}

/** Group sessions by directory (encoded cwd), newest first within each dir. */
function buildGroups(rows: SessionRow[], currentFile: string | null): SessionGroup[] {
	const byDir = new Map<string, SessionRow[]>();
	for (const r of rows) {
		if (!byDir.has(r.cwd)) byDir.set(r.cwd, []);
		byDir.get(r.cwd)!.push(r);
	}
	const groups: SessionGroup[] = [];
	for (const [dir, list] of byDir) {
		list.sort((a, b) => b.mtimeMs - a.mtimeMs);
		const isCurrent = list.some((s) => s.file === currentFile);
		groups.push({ dir, isCurrent, sessions: list });
	}
	groups.sort((a, b) => {
		if (a.isCurrent !== b.isCurrent) return a.isCurrent ? -1 : 1;
		return a.dir.localeCompare(b.dir);
	});
	return groups;
}

/** Directory path suggestions for live autocomplete. */
function dirSuggestions(input: string, cwd: string): string[] {
	const home = homedir();
	const roots = [home, cwd];
	const out = new Set<string>();
	for (const root of roots) {
		if (!root) continue;
		let dir = root;
		while (true) {
			if (dir.length >= input.length && dir.startsWith(input)) out.add(dir);
			const parent = resolve(dir, "..");
			if (parent === dir) break;
			dir = parent;
		}
	}
	return [...out].sort((a, b) => b.length - a.length).slice(0, 6);
}

/* ------------------------------------------------------------------ */
/* Actions (post-replacement work runs in withSession on the fresh ctx) */
/* ------------------------------------------------------------------ */

/**
 * Post-replacement work: optionally delete the old session file, then notify.
 * Runs inside `withSession` with the fresh ctx (the old ctx is stale by then).
 */
async function handlePost(
	sctx: ExtensionCommandContext,
	oldFile: string | null,
	deleteCurrent: boolean,
	baseMsg: string,
): Promise<void> {
	if (!deleteCurrent || !oldFile) {
		sctx.ui.notify(baseMsg, "info");
		return;
	}
	try {
		await unlink(oldFile);
		sctx.ui.notify(`${baseMsg} Old session deleted.`, "info");
	} catch {
		sctx.ui.notify(`${baseMsg} Old session kept.`, "error");
	}
}

/** New session in the current directory (same as /new). */
async function doNewHere(ctx: Ctx, deleteCurrent: boolean): Promise<void> {
	const ui = ctx.ui; // captured before replacement; safe to use after
	const oldFile = ctx.sessionManager.getSessionFile() ?? null;
	const res = await ctx.newSession({
		withSession: (sctx) => handlePost(sctx, oldFile, deleteCurrent, "New session started"),
	});
	if (res.cancelled) ui.notify("New session cancelled.", "info");
}

/** New session in a specific directory (create the session, then switch to it). */
async function doNewInPath(ctx: Ctx, abs: string, deleteCurrent: boolean): Promise<void> {
	const ui = ctx.ui;
	const oldFile = ctx.sessionManager.getSessionFile() ?? null;
	const sm = SessionManager.create(abs);
	const file = sm.getSessionFile();
	if (!file) {
		ui.notify("Could not create session.", "error");
		return;
	}
	const res = await ctx.switchSession(file, {
		cwdOverride: abs,
		withSession: (sctx) => handlePost(sctx, oldFile, deleteCurrent, `New session in ${abs}`),
	} as Parameters<typeof ctx.switchSession>[1]);
	if (res.cancelled) ui.notify("New session cancelled.", "info");
}

/** Switch to an existing session file. */
async function doOpen(ctx: Ctx, file: string, deleteCurrent: boolean): Promise<void> {
	const ui = ctx.ui;
	const oldFile = ctx.sessionManager.getSessionFile() ?? null;
	if (file === oldFile) {
		ui.notify("Already in this session.", "info");
		return;
	}
	const res = await ctx.switchSession(file, {
		withSession: (sctx) => handlePost(sctx, oldFile, deleteCurrent, "Switched to session"),
	});
	if (res.cancelled) ui.notify("Switch cancelled.", "info");
}

/** Move a file into ~/.pi/agent/sessions/.trash/ (kept for the /open delete -t path). */
async function moveToTrash(file: string): Promise<string> {
	const trashDir = join(getAgentDir(), "sessions", ".trash");
	await mkdir(trashDir, { recursive: true });
	const name = `${Date.now()}-${basename(file)}`;
	const dest = join(trashDir, name);
	await rename(file, dest);
	return dest;
}

/* ------------------------------------------------------------------ */
/* UI pickers                                                          */
/* ------------------------------------------------------------------ */

type TopAction = "new-here" | "new-path" | "open";

/** Step 0: pick which action to take. */
async function pickAction(ctx: Ctx): Promise<TopAction | null> {
	const options: TopAction[] = ["new-here", "new-path", "open"];
	const labels: Record<TopAction, string> = {
		"new-here": "New session here",
		"new-path": "New session in...",
		open: "Open session",
	};
	if (ctx.hasUI) {
		return await ctx.ui.custom<TopAction | null>((tui, theme, keybindings, done) => {
			let cursor = 0;
			const component: Component = {
				render: () => {
					const lines: string[] = [theme.fg("accent", theme.bold("Open a session")), ""];
					for (let i = 0; i < options.length; i++) {
						const marker = i === cursor ? theme.fg("accent", "> ") : "  ";
						lines.push(marker + labels[options[i]]);
					}
					lines.push("", theme.fg("dim", "↑↓ move · Enter select · Esc cancel"));
					return lines;
				},
				handleInput: (data) => {
					if (keybindings.matches(data, "tui.select.up")) {
						cursor = (cursor - 1 + options.length) % options.length;
						tui.requestRender();
						return;
					}
					if (keybindings.matches(data, "tui.select.down")) {
						cursor = (cursor + 1) % options.length;
						tui.requestRender();
						return;
					}
					if (keybindings.matches(data, "tui.select.confirm")) {
						done(options[cursor]);
						return;
					}
					if (keybindings.matches(data, "tui.select.cancel")) {
						done(null);
						return;
					}
				},
				invalidate: () => {
					/* no cached state */
				},
			};
			return component;
		});
	}
	const sel = await ctx.ui.select("Open a session", options.map((o) => labels[o]));
	const idx = Object.values(labels).indexOf(sel ?? "");
	return idx >= 0 ? options[idx] : null;
}

/**
 * Step for "New session in...": pick a directory. TUI uses a live-autocomplete
 * input; RPC falls back to a plain text input.
 */
async function pickPath(ctx: Ctx, cwd: string): Promise<string | null> {
	if (ctx.hasUI) {
		const result = await ctx.ui.custom<{ path: string } | null>((tui, theme, keybindings, done) => {
			const input = new Input();
			input.focused = true;
			input.setValue(cwd);
			let suggestions: string[] = [];
			let selIdx = -1;

			const refresh = () => {
				const base = input.getValue();
				suggestions = dirSuggestions(base, cwd);
				selIdx = -1;
			};
			refresh();

			const component: Component = {
				render: (width: number) => {
					const lines: string[] = [];
					lines.push(theme.fg("accent", theme.bold("New session in directory")));
					lines.push("");
					lines.push(...input.render(width));
					if (selIdx >= 0 && suggestions[selIdx]) {
						lines.push(theme.fg("accent", "  " + suggestions[selIdx]));
					} else {
						for (const s of suggestions.slice(0, 5)) {
							lines.push(theme.fg("dim", "  " + s));
						}
					}
					lines.push("");
					lines.push(theme.fg("dim", "↑↓ pick · Tab/Enter complete · Enter go · Esc cancel"));
					return lines;
				},
				handleInput: (data) => {
					if (keybindings.matches(data, "tui.select.up") && suggestions.length > 0) {
						selIdx = (selIdx - 1 + suggestions.length) % suggestions.length;
						tui.requestRender();
						return;
					}
					if (keybindings.matches(data, "tui.select.down") && suggestions.length > 0) {
						selIdx = selIdx < 0 ? 0 : (selIdx + 1) % suggestions.length;
						tui.requestRender();
						return;
					}
					if (keybindings.matches(data, "tui.input.tab") && selIdx >= 0 && suggestions[selIdx]) {
						input.setValue(suggestions[selIdx] + " ");
						refresh();
						tui.requestRender();
						return;
					}
					if (keybindings.matches(data, "tui.select.confirm")) {
						if (selIdx >= 0 && suggestions[selIdx]) {
							input.setValue(suggestions[selIdx] + " ");
							refresh();
							tui.requestRender();
							return;
						}
						const v = input.getValue().trim();
						done(v ? { path: v } : null);
						return;
					}
					if (keybindings.matches(data, "tui.select.cancel")) {
						done(null);
						return;
					}
					// Text editing goes to the embedded Input.
					input.handleInput(data);
					refresh();
					tui.requestRender();
				},
				invalidate: () => {
					input.invalidate();
				},
			};
			return component;
		});
		if (!result) return null;
		const p = result.path.trim();
		return p ? p : null;
	}
	const v = await ctx.ui.input("New session in directory", cwd);
	const p = v?.trim();
	return p ? p : null;
}

/** Step for "Open session": pick an existing session, grouped by directory. */
async function pickSession(
	ctx: Ctx,
	currentFile: string | null,
): Promise<string | null> {
	const rows = await scanSessions();
	const groups = buildGroups(rows, currentFile);
	const flat = groups.flatMap((g) => g.sessions);
	if (flat.length === 0) {
		ctx.ui.notify("No sessions found.", "info");
		return null;
	}
	// Map file -> flat index for O(1) cursor lookup during render.
	const idxByFile = new Map<string, number>();
	flat.forEach((s, i) => idxByFile.set(s.file, i));

	if (ctx.hasUI) {
		return await ctx.ui.custom<string | null>((tui, theme, keybindings, done) => {
			let cursor = 0;
			const component: Component = {
				render: () => {
					const lines: string[] = [];
					lines.push(theme.fg("accent", theme.bold("Open an existing session")));
					for (const group of groups) {
						// Directory group header: bold accent + folder glyph + spacing.
						lines.push("");
						const cur = group.isCurrent ? theme.fg("success", "  (current)") : "";
						lines.push(theme.fg("accent", theme.bold("▸ " + group.dir)) + cur);
						// Sessions under the dir: indented, dim metadata.
						for (const s of group.sessions) {
							const idx = idxByFile.get(s.file) ?? -1;
							const marker = idx === cursor ? theme.fg("accent", "> ") : "  ";
							lines.push(
								marker +
									"    " +
									s.name +
									theme.fg("dim", "  " + s.id.slice(0, 8) + "  " + s.date),
							);
						}
					}
					lines.push("");
					lines.push(theme.fg("dim", "↑↓ move · Enter select · Esc cancel"));
					return lines;
				},
				handleInput: (data) => {
					if (keybindings.matches(data, "tui.select.up")) {
						cursor = (cursor - 1 + flat.length) % flat.length;
						tui.requestRender();
						return;
					}
					if (keybindings.matches(data, "tui.select.down")) {
						cursor = (cursor + 1) % flat.length;
						tui.requestRender();
						return;
					}
					if (keybindings.matches(data, "tui.select.confirm")) {
						done(flat[cursor].file);
						return;
					}
					if (keybindings.matches(data, "tui.select.cancel")) {
						done(null);
						return;
					}
				},
				invalidate: () => {
					/* no cached state */
				},
			};
			return component;
		});
	}
	// RPC fallback: flat list of "name (dir)" labels.
	const labels = flat.map((s) => `${s.name}  (${s.cwd})`);
	const sel = await ctx.ui.select("Open an existing session", labels);
	const idx = labels.indexOf(sel ?? "");
	return idx >= 0 ? flat[idx].file : null;
}

/* ------------------------------------------------------------------ */
/* Orchestration                                                       */
/* ------------------------------------------------------------------ */

/**
 * The /open launcher. Flow:
 *   1. Pick an action (new here / new in... / open session).
 *   2. Step 1: ask whether to delete the current session.
 *   3. Do the action (with the delete applied in withSession).
 */
async function showLauncher(ctx: Ctx): Promise<void> {
	const cwd = ctx.cwd;
	const currentFile = ctx.sessionManager.getSessionFile() ?? null;

	const action = await pickAction(ctx);
	if (!action) return;

	const deleteCurrent = await ctx.ui.confirm(
		"Delete the current session?",
		`Current: ${currentFile ?? "(no session file)"}`,
	);

	if (action === "new-here") {
		await doNewHere(ctx, deleteCurrent);
	} else if (action === "new-path") {
		const abs = await pickPath(ctx, cwd);
		if (!abs) return;
		await doNewInPath(ctx, abs, deleteCurrent);
	} else {
		const file = await pickSession(ctx, currentFile);
		if (!file) return;
		await doOpen(ctx, file, deleteCurrent);
	}
}

/** Fast path: delete the current session and start a new one here (for /open delete). */
async function doDeleteAndNew(
	ctx: Ctx,
	opts: { skipConfirm?: boolean; useTrash?: boolean },
): Promise<void> {
	const ui = ctx.ui;
	const oldFile = ctx.sessionManager.getSessionFile() ?? null;
	if (!opts.skipConfirm) {
		const ok = await ctx.ui.confirm(
			"Start a fresh session?",
			`This opens a new chat and ${opts.useTrash ? "moves" : "deletes"} the current session file:\n${oldFile ?? "(no session file)"}`,
		);
		if (!ok) {
			ui.notify("Cancelled.", "info");
			return;
		}
	}
	const res = await ctx.newSession({
		withSession: async (sctx) => {
			let note = "New session started";
			if (oldFile) {
				try {
					if (opts.useTrash) {
						const dest = await moveToTrash(oldFile);
						note += `. Old session moved to ${dest}`;
					} else {
						await unlink(oldFile);
						note += ". Old session deleted";
					}
				} catch {
					note += ". Old session kept";
				}
			} else {
				note += ". No session file to remove";
			}
			sctx.ui.notify(note + ".", "info");
		},
	});
	if (res.cancelled) ui.notify("New session cancelled.", "info");
}

/* ------------------------------------------------------------------ */
/* Registration                                                        */
/* ------------------------------------------------------------------ */

export function registerOpenSession(pi: ExtensionAPI): void {
	pi.registerCommand("open", {
		description: "Open a session: new here, new in a directory, or open an existing one",
		handler: async (args, ctx) => {
			const argv = String(args ?? "").trim().split(/\s+/).filter(Boolean);
			const flags = new Set(argv.filter((a) => a.startsWith("-")));
			const positional = argv.filter((a) => !a.startsWith("-"));

			if (positional.length === 0) {
				await showLauncher(ctx);
				return;
			}
			if (positional[0] === "delete") {
				await doDeleteAndNew(ctx, {
					skipConfirm: flags.has("-y") || flags.has("--yes"),
					useTrash: flags.has("-t") || flags.has("--trash"),
				});
				return;
			}
			ctx.ui.notify(`Unknown /open action: ${positional[0]}`, "warning");
		},
	});
}
