import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export interface SessionRow {
  file: string;
  name: string | null;
  cwd: string;
  id: string;
  created: number;
  date: string;
}

export async function readJsonl(file: string): Promise<{
  cwd: string | null;
  id: string;
  created: number;
  name: string | null;
}> {
  let text: string;
  try {
    text = await fs.readFile(file, "utf8");
  } catch {
    return { cwd: null, id: "", created: 0, name: null };
  }
  let cwd: string | null = null;
  let id = "";
  let created = 0;
  let name: string | null = null;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let e: unknown;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    const o = e as { type?: string; version?: string; id?: string; created_at?: string; cwd?: string; name?: string };
    if (o.type === "session" && typeof o.id === "string") {
      id = o.id;
      if (o.created_at) created = Date.parse(o.created_at);
      if (typeof o.cwd === "string") cwd = o.cwd;
    }
    const info = e as { type?: string; name?: string };
    if (info.type === "session_info" && typeof info.name === "string") name = info.name;
  }
  return { cwd, id, created, name };
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
        cwd: meta.cwd,
        id: meta.id,
        created: meta.created || 0,
        date: meta.created ? new Date(meta.created).toISOString().slice(0, 10) : "—",
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
