import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export interface SessionRow {
  file: string;
  name: string | null;
  /** Snippet of the latest assistant reply text; list fallback when no name is set. */
  preview: string | null;
  cwd: string;
  id: string;
  created: number;
  date: string;
  hasConversation: boolean;
}

/** Marks a fallback label as extracted, so it reads distinctly from a real session name. */
export const PREVIEW_PREFIX = "[from last reply] ";

const PREVIEW_MAX = 72;

// content[] of a pi message is text parts plus thinking/toolCall parts; the
// fallback uses plain text only.
function assistantTextParts(message: unknown): string[] {
  const m = message as { role?: string; content?: unknown };
  if (m?.role !== "assistant" || !Array.isArray(m.content)) return [];
  return m.content
    .filter((p) => p && typeof p === "object" && (p as { type?: string }).type === "text")
    .map((p) => (p as { text?: unknown }).text)
    .filter((t): t is string => typeof t === "string" && t.trim().length > 0);
}

function extractPreview(text: string): string | null {
  let last = "";
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as { type?: string; message?: unknown };
      if (e.type === "message") {
        for (const t of assistantTextParts(e.message)) last = t;
      }
    } catch {
      // skip
    }
  }
  const cleaned = last.replace(/\s+/g, " ").trim();
  if (!cleaned) return null;
  return cleaned.length > PREVIEW_MAX ? cleaned.slice(0, PREVIEW_MAX - 1).trimEnd() + "…" : cleaned;
}

/** Name when set; otherwise the last-reply snippet with its marker; else untitled. */
export function sessionLabel(row: Pick<SessionRow, "name" | "preview">): string {
  if (row.name) return row.name;
  if (row.preview) return PREVIEW_PREFIX + row.preview;
  return "(untitled)";
}

export async function readJsonl(file: string): Promise<{
  cwd: string | null;
  id: string;
  created: number;
  name: string | null;
  preview: string | null;
  hasConversation: boolean;
}> {
  let text: string;
  try {
    text = await fs.readFile(file, "utf8");
  } catch {
    return { cwd: null, id: "", created: 0, name: null, preview: null, hasConversation: false };
  }
  let cwd: string | null = null;
  let id = "";
  let created = 0;
  let name: string | null = null;
  let hasConversation = false;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let e: unknown;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    const o = e as { type?: string; version?: string; id?: string; created_at?: string; timestamp?: string; cwd?: string; name?: string; message?: { role?: string } };
    if (o.type === "session" && typeof o.id === "string") {
      id = o.id;
      const ts = o.created_at ?? o.timestamp;
      if (ts) created = Date.parse(ts);
      if (typeof o.cwd === "string") cwd = o.cwd;
    }
    const info = e as { type?: string; name?: string };
    if (info.type === "session_info" && typeof info.name === "string") name = info.name;
    if (o.type === "message" && (o.message?.role === "user" || o.message?.role === "assistant")) {
      hasConversation = true;
    }
  }
  return { cwd, id, created, name, preview: extractPreview(text), hasConversation };
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function formatSessionDate(created: number): string {
  if (!created) return "—";
  const d = new Date(created);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${WEEKDAYS[d.getDay()]}, ${pad(d.getDate())} ${MONTHS[d.getMonth()]} ${d.getFullYear()}, ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export async function scanSessions(): Promise<SessionRow[]> {
  const root = path.join(os.homedir(), ".pi", "agent", "sessions");
  const rows: SessionRow[] = [];
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!ent.name.endsWith(".jsonl")) continue;
      const meta = await readJsonl(full);
      if (!meta.cwd) continue;
      rows.push({
        file: full,
        name: meta.name,
        preview: meta.preview,
        cwd: meta.cwd,
        id: meta.id,
        created: meta.created || 0,
        date: formatSessionDate(meta.created || 0),
        hasConversation: meta.hasConversation,
      });
    }
  }
  return rows;
}

export interface SessionGroup {
  cwd: string;
  sessions: SessionRow[];
}

export function buildGroups(rows: SessionRow[], currentFile: string | null): SessionGroup[] {
  const byDir = new Map<string, SessionRow[]>();
  for (const r of rows) {
    const list = byDir.get(r.cwd) ?? [];
    list.push(r);
    byDir.set(r.cwd, list);
  }
  const groups: SessionGroup[] = [];
  for (const [cwd, sessions] of byDir) {
    sessions.sort((a, b) => {
      const ac = a.file === currentFile ? 1 : 0;
      const bc = b.file === currentFile ? 1 : 0;
      if (ac !== bc) return ac - bc;
      return b.created - a.created;
    });
    groups.push({ cwd, sessions });
  }
  groups.sort((a, b) => {
    const ac = a.sessions.some((s) => s.file === currentFile) ? 1 : 0;
    const bc = b.sessions.some((s) => s.file === currentFile) ? 1 : 0;
    if (ac !== bc) return bc - ac;
    return a.cwd.localeCompare(b.cwd);
  });
  return groups;
}

export function currentFile(ctx: ExtensionContext): string | null {
  return ctx.sessionManager?.getSessionFile?.() ?? null;
}
