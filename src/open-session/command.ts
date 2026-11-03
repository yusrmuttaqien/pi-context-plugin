import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { readJsonl, currentFile } from "./scan.js";
import { pickAction, pickPath, pickSession, pickDeleteFirst, type TopAction } from "./pickers.js";

// Minimal structural type for the withSession() callback param (the full type is
// ReplacedSessionContext, not re-exported from the package entry).
type Nctx = { ui: { notify(message: string, type?: "info" | "warning" | "error"): void } };

// Start a new session in a directory, optionally deleting the current one first.
// newSession() uses the runtime's current cwd, so to land in a different dir we
// create the session file in the target's session dir, then switchSession() to it
// with cwdOverride (the only API that accepts a cwd override).
async function newSessionInDir(ctx: ExtensionCommandContext, target: string, del: boolean | null): Promise<void> {
  const sm = SessionManager.create(target);
  const sessionFile = sm.newSession();
  if (!sessionFile) {
    ctx.ui.notify("Failed to create session.", "error");
    return;
  }
  await (ctx as unknown as {
    switchSession: (file: string, opts?: { cwdOverride?: string; withSession?: (n: Nctx) => Promise<void> }) => Promise<unknown>;
  }).switchSession(sessionFile, {
    cwdOverride: target,
    withSession: async (nctx) => {
      if (del) nctx.ui.notify(`New session in ${target}.`, "info");
    },
  });
}

async function applyAction(
  ctx: ExtensionCommandContext,
  action: TopAction,
  cur: { file: string | null; cwd: string },
  prePickedPath?: string,
): Promise<void> {
  const doDelete = async (): Promise<boolean | null> => {
    if (!cur.file) return false;
    const del = await pickDeleteFirst(ctx, cur.file);
    if (del === null) return null;
    if (!del) return false;
    try {
      await fs.unlink(cur.file);
      ctx.ui.notify("Deleted current session.", "info");
      return true;
    } catch (e) {
      ctx.ui.notify(`Delete failed: ${(e as Error).message}`, "error");
      return false;
    }
  };

  if (action === "new-here") {
    const del = await doDelete();
    if (del === null) return;
    await ctx.newSession({
      withSession: async (nctx) => {
        if (del) nctx.ui.notify("New session started here.", "info");
      },
    });
    return;
  }

  if (action === "new-path") {
    const picked = prePickedPath || (await pickPath(ctx, cur.cwd));
    if (!picked) return;
    const target = path.resolve(os.homedir(), picked);
    const exists = await fs
      .stat(target)
      .then((s) => s.isDirectory())
      .catch(() => false);
    if (!exists) {
      ctx.ui.notify(`Not a directory: ${target}`, "warning");
      return;
    }
    const del = await doDelete();
    if (del === null) return;
    await newSessionInDir(ctx, target, del);
    return;
  }

  // open
  const del = await doDelete();
  if (del === null) return;
  const picked = await pickSession(ctx, cur.file);
  if (!picked) return;
  const targetCwd = path.dirname(picked);
  const meta = await readJsonl(picked);
  const switchTarget = meta.cwd ? path.resolve(meta.cwd) : targetCwd;
  await (ctx as unknown as {
    switchSession: (file: string, opts?: { cwdOverride?: string; withSession?: (n: Nctx) => Promise<void> }) => Promise<unknown>;
  }).switchSession(picked, {
    cwdOverride: switchTarget,
    withSession: async (nctx) => {
      if (del) nctx.ui.notify("Switched sessions.", "info");
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
