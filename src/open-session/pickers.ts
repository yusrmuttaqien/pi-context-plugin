import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  Input,
  SelectList,
  type Component,
} from "@earendil-works/pi-tui";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { scanSessions, buildGroups } from "./scan.js";
import { Panel, GroupedList, WithHeader, selectTheme, type ListRow, type ListStyles } from "./ui.js";

export type TopAction = "new-here" | "new-path" | "open";

export async function pickAction(ctx: ExtensionContext): Promise<TopAction | null> {
  const options: TopAction[] = ["new-here", "new-path", "open"];
  const labels: Record<TopAction, string> = {
    "new-here": "New session here",
    "new-path": "New session in…",
    open: "Open a session…",
  };
  if (ctx.hasUI) {
    return await ctx.ui.custom<TopAction | null>((_tui, theme, _kb, done) => {
      const list = new SelectList(options.map((o) => ({ value: o, label: labels[o] })), 10, selectTheme(theme));
      list.onSelect = (item) => done(item.value as TopAction);
      list.onCancel = () => done(null);
      return new Panel(list, (t) => theme.fg("accent", t));
    }, { overlay: true, overlayOptions: { anchor: "center", width: 40, margin: 2 } });
  }
  const sel = await ctx.ui.select("New session", options.map((o) => labels[o]));
  if (sel === undefined) return null;
  const idx = options.findIndex((o) => labels[o] === sel);
  return idx === -1 ? null : options[idx];
}

export async function pickPath(ctx: ExtensionContext, cwd: string): Promise<string | null> {
  // Resolve a user-typed path: ~ → home, relative → against cwd, absolute → as-is.
  const resolve = (raw: string): string => {
    const p = raw.trim();
    if (p === "~") return os.homedir();
    if (p.startsWith("~")) return os.homedir() + p.slice(1);
    if (path.isAbsolute(p)) return p;
    return path.resolve(cwd, p);
  };
  if (ctx.hasUI) {
    return await ctx.ui.custom<string | null>((tui, theme, keybindings, done) => {
      const input = new Input();
      input.focused = true;
      // Start empty; cursor is at the end (position 0).
      let suggestions: string[] = [];
      let selectedSuggestion = -1;
      const refresh = () => {
        const raw = input.getValue().trim();
        // Resolve to absolute path.
        let abs: string;
        if (raw === "" || raw === "." || raw === "./") {
          abs = cwd;
        } else if (raw === "~") {
          abs = os.homedir();
        } else if (raw.startsWith("~")) {
          abs = os.homedir() + raw.slice(1);
        } else if (path.isAbsolute(raw)) {
          abs = raw;
        } else {
          abs = path.resolve(cwd, raw);
        }
        // Split on last "/".
        const lastSlash = abs.lastIndexOf("/");
        const base = abs.slice(0, lastSlash + 1) || "/";
        const filter = abs.slice(lastSlash + 1);
        fs
          .readdir(base, { withFileTypes: true })
          .then((entries) => {
            const dirs = entries
              .filter((e) => e.isDirectory() && !e.name.startsWith("."))
              .map((e) => e.name)
              .filter((n) => n.startsWith(filter))
              .sort()
              .slice(0, 8);
            suggestions = dirs.map((n) => base + n);
            selectedSuggestion = suggestions.length > 0 ? 0 : -1;
            tui.requestRender();
          })
          .catch(() => {
            suggestions = [];
            selectedSuggestion = -1;
            tui.requestRender();
          });
      };
      const complete = () => {
        if (selectedSuggestion >= 0 && suggestions[selectedSuggestion]) {
          const val = suggestions[selectedSuggestion] + "/";
          input.setValue(val);
          (input as unknown as { cursor: number }).cursor = val.length;
          refresh();
        }
      };
      const render = (width: number): string[] => {
        const lines: string[] = [];
        lines.push(...input.render(width));
        if (suggestions.length > 0) {
          lines.push("");
          for (let i = 0; i < suggestions.length; i++) {
            const marker = i === selectedSuggestion ? "→ " : "  ";
            const styled = i === selectedSuggestion ? theme.fg("accent", suggestions[i]) : theme.fg("dim", suggestions[i]);
            lines.push(marker + styled);
          }
        }
        return lines;
      };
      const handleInput = (data: string): void => {
        if (keybindings.matches(data, "tui.select.up")) {
          if (suggestions.length > 0) {
            selectedSuggestion = selectedSuggestion <= 0 ? suggestions.length - 1 : selectedSuggestion - 1;
            tui.requestRender();
          }
          return;
        }
        if (keybindings.matches(data, "tui.select.down")) {
          if (suggestions.length > 0) {
            selectedSuggestion = selectedSuggestion >= suggestions.length - 1 ? 0 : selectedSuggestion + 1;
            tui.requestRender();
          }
          return;
        }
        if (keybindings.matches(data, "tui.input.tab")) {
          complete();
          return;
        }
        if (keybindings.matches(data, "tui.select.confirm")) {
          complete();
          const p = input.getValue().trim();
          if (!p) { done(null); return; }
          done(resolve(p));
          return;
        }
        if (keybindings.matches(data, "tui.select.cancel")) {
          done(null);
          return;
        }
        input.handleInput(data);
        refresh();
      };
      const invalidate = (): void => {
        input.invalidate();
        tui.requestRender();
      };
      const inner: Component = { render, handleInput, invalidate };
      return new Panel(inner, (t) => theme.fg("accent", t));
    }, { overlay: true, overlayOptions: { anchor: "center", width: 60, margin: 2 } });
  }
  const p = await ctx.ui.input("New session directory (path):", cwd);
  if (!p) return null;
  return resolve(p);
}

export async function pickSession(ctx: ExtensionContext, currentFile: string | null): Promise<string | null> {
  const rows = await scanSessions();
  const groups = buildGroups(rows, currentFile);
  const flat = groups.flatMap((g) => g.sessions).filter((s) => s.file !== currentFile);
  if (flat.length === 0) {
    ctx.ui.notify("No other sessions to open.", "info");
    return null;
  }
  if (ctx.hasUI) {
    const listRows: ListRow[] = [];
    let pushed = false;
    for (const g of groups) {
      const isCurrentGroup = g.sessions.some((s) => s.file === currentFile);
      const otherSessions = g.sessions.filter((s) => s.file !== currentFile);
      // Skip the current directory if it has no other sessions to show.
      if (isCurrentGroup && otherSessions.length === 0) continue;
      if (pushed) listRows.push({ kind: "spacer" });
      listRows.push({ kind: "header", text: `▸ ${g.cwd}${isCurrentGroup ? "  (current)" : ""}` });
      for (const s of otherSessions) {
        listRows.push({
          kind: "item",
          value: s.file,
          label: s.name ?? "(untitled)",
          description: `${s.id.slice(0, 8)} · ${s.date}`,
        });
      }
      pushed = true;
    }
    return await ctx.ui.custom<string | null>((tui, theme, keybindings, done) => {
      const maxVisible = Math.max(5, Math.floor(tui.terminal.rows * 0.8) - 5);
      const styles: ListStyles = {
        header: (t) => theme.bold(theme.fg("muted", t)),
        selected: (t) => theme.fg("accent", t),
        dim: (t) => theme.fg("dim", t),
        noMatch: (t) => theme.fg("warning", t),
        scroll: (t) => theme.fg("dim", t),
      };
      const list = new GroupedList(listRows, maxVisible, styles, keybindings, (value) => done(value), () => done(null));
      return new Panel(list, (t) => theme.fg("accent", t));
    }, { overlay: true, overlayOptions: { anchor: "center", width: "70%", maxHeight: "80%", margin: 2 } });
  }
  const labels2 = flat.map((s) => `${s.name ?? "(untitled)"} — ${s.cwd} · ${s.id.slice(0, 8)} · ${s.date}`);
  const sel = await ctx.ui.select("Open session", labels2);
  if (sel === undefined) return null;
  const idx = labels2.indexOf(sel);
  return idx === -1 ? null : flat[idx].file;
}

// Ask whether to delete the current session, as an overlay (yes / no / esc).
export async function pickDeleteFirst(ctx: ExtensionContext, file: string): Promise<boolean | null> {
  if (ctx.hasUI) {
    return await ctx.ui.custom<boolean | null>((_tui, theme, _kb, done) => {
      const list = new SelectList(
        [
          { value: "no", label: "No, keep it" },
          { value: "yes", label: "Yes, delete it" },
        ],
        10,
        selectTheme(theme),
      );
      list.onSelect = (item) => done(item.value === "yes");
      list.onCancel = () => done(null);
      const header = ["Delete this session?", theme.fg("dim", file), ""];
      return new Panel(new WithHeader(header, list), (t) => theme.fg("accent", t));
    }, { overlay: true, overlayOptions: { anchor: "center", width: 50, margin: 2 } });
  }
  return ctx.ui.confirm(`Delete this session? ${file}`, "Yes, delete");
}
