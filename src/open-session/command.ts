import { promises as fs } from "node:fs";
import path from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { readJsonl, currentFile } from "./scan.js";
import { pickAction, pickPath, pickSession, pickDeleteFirst, type TopAction } from "./pickers.js";

// Minimal structural type for the withSession() callback param (the full type is
// ReplacedSessionContext, not re-exported from the package entry).
type Nctx = { ui: { notify(message: string, type?: "info" | "warning" | "error"): void } };

// Ask whether to delete the old session (shown before the operation so the user
// knows what will happen). Returns true to delete, false to keep, or null if
// the user cancelled (Esc) — the caller should abort the whole flow.
async function askDeleteOld(ctx: ExtensionCommandContext, oldFile: string | null): Promise<boolean | null> {
  if (!oldFile) return false;
  return pickDeleteFirst(ctx, oldFile);
}

// Delete the old session file (called in the withSession callback, after the
// switch succeeds). If the switch is cancelled, this never runs.
async function deleteOld(oldFile: string, nctx: Nctx): Promise<void> {
  try {
    await fs.unlink(oldFile);
    nctx.ui.notify("Deleted old session.", "info");
  } catch (e) {
    nctx.ui.notify(`Delete failed: ${(e as Error).message}`, "error");
  }
}

// A session file has a conversation when it contains at least one user or
// assistant message entry. pi only writes the file once such a message
// exists, so a file without one is a throwaway (header-only) session.
async function fileHasConversation(file: string): Promise<boolean> {
  return (await readJsonl(file)).hasConversation;
}

// A session is empty (nothing worth keeping or deleting) when it has no
// conversation. A fresh session has no file yet; a "new in directory" session
// has a header-only file. Both count as empty.
async function currentIsEmpty(file: string | null): Promise<boolean> {
  if (!file) return true;
  return !(await fileHasConversation(file));
}

// Delete a session file that has no conversation when its session ends. pi's
// /new never writes a file until the first message, so an empty session leaves
// no trace; our "new in directory" flow must write a header up front (so the
// switch can derive the cwd), which leaves a header-only file. This removes
// that file when the session ends without a conversation, matching /new. The
// event fires before the session is disposed, so ctx.sessionManager still
// points at the session being torn down.
export function registerEmptySessionCleanup(pi: ExtensionAPI): void {
  pi.on("session_shutdown", async (_event, ctx) => {
    const file = ctx.sessionManager?.getSessionFile?.();
    if (!file) return;
    if (await fileHasConversation(file)) return;
    await fs.unlink(file).catch(() => {});
  });
}

// Start a new session in a directory.
async function newSessionInDir(
  ctx: ExtensionCommandContext,
  target: string,
  oldFile: string | null,
  del: boolean,
): Promise<void> {
  const sm = SessionManager.create(target);
  const sessionFile = sm.newSession();
  if (!sessionFile) {
    ctx.ui.notify("Failed to create session.", "error");
    return;
  }
  // Persist the header so SessionManager.open (used by switchSession) can
  // derive the cwd from it. ctx.switchSession drops cwdOverride, and a fresh
  // session file has no header on disk yet, so without this the cwd falls
  // back to process.cwd() (the current directory).
  const header = sm.getHeader();
  if (header) {
    await fs.writeFile(sessionFile, JSON.stringify(header) + "\n");
  }
  await (ctx as unknown as {
    switchSession: (file: string, opts?: { cwdOverride?: string; withSession?: (n: Nctx) => Promise<void> }) => Promise<unknown>;
  }).switchSession(sessionFile, {
    cwdOverride: target,
    withSession: async (nctx) => {
      if (del && oldFile) await deleteOld(oldFile, nctx);
      nctx.ui.notify(`New session in ${target}.`, "info");
    },
  });
}

async function applyAction(
  ctx: ExtensionCommandContext,
  action: TopAction,
  cur: { file: string | null; cwd: string },
  prePickedPath?: string,
): Promise<void> {
  // Skip the delete prompt when the current session has not been saved yet.
  const oldFile = (await currentIsEmpty(cur.file)) ? null : cur.file;

  if (action === "new-here") {
    const del = await askDeleteOld(ctx, oldFile);
    if (del === null) return;
    await ctx.newSession({
      withSession: async (nctx) => {
        if (del && oldFile) await deleteOld(oldFile, nctx);
        nctx.ui.notify("New session started here.", "info");
      },
    });
    return;
  }

  if (action === "new-path") {
    const picked = prePickedPath || (await pickPath(ctx, cur.cwd));
    if (!picked) return;
    const target = picked;
    const exists = await fs
      .stat(target)
      .then((s) => s.isDirectory())
      .catch(() => false);
    if (!exists) {
      ctx.ui.notify(`Not a directory: ${target}`, "warning");
      return;
    }
    const del = await askDeleteOld(ctx, oldFile);
    if (del === null) return;
    await newSessionInDir(ctx, target, oldFile, del);
    return;
  }

  // open
  const picked = await pickSession(ctx, cur.file);
  if (!picked) return;
  const del = await askDeleteOld(ctx, oldFile);
  if (del === null) return;
  const targetCwd = path.dirname(picked);
  const meta = await readJsonl(picked);
  const switchTarget = meta.cwd ? path.resolve(meta.cwd) : targetCwd;
  await (ctx as unknown as {
    switchSession: (file: string, opts?: { cwdOverride?: string; withSession?: (n: Nctx) => Promise<void> }) => Promise<unknown>;
  }).switchSession(picked, {
    cwdOverride: switchTarget,
    withSession: async (nctx) => {
      if (del && oldFile) await deleteOld(oldFile, nctx);
      nctx.ui.notify("Switched sessions.", "info");
    },
  });
}

export function registerOpenSession(pi: ExtensionAPI): void {
  pi.registerCommand("open", {
    description: "Manage sessions: new here, new in a directory, or open an existing one (deletes current first)",
    handler: async (args, c) => {
      const arg = (args ?? "").trim();
      if (arg === "new" || arg === "here") {
        const curFile = currentFile(c);
        await applyAction(c, "new-here", { file: curFile, cwd: c.cwd });
        return;
      }
      if (arg === "open") {
        const curFile = currentFile(c);
        await applyAction(c, "open", { file: curFile, cwd: c.cwd });
        return;
      }
      if (arg.startsWith("new ") || arg === "new") {
        const rest = arg.slice(4).trim();
        const curFile = currentFile(c);
        const pickedPath = rest || (await pickPath(c, c.cwd));
        if (!pickedPath) return;
        await applyAction(c, "new-path", { file: curFile, cwd: c.cwd }, pickedPath);
        return;
      }
      const action = await pickAction(c);
      if (!action) return;
      const curFile = currentFile(c);
      await applyAction(c, action, { file: curFile, cwd: c.cwd });
    },
  });
}
