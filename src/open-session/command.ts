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

// Ask whether to delete the old session (shown before the operation so the user
// knows what will happen). Returns true if the user wants it deleted.
async function askDeleteOld(ctx: ExtensionCommandContext, oldFile: string | null): Promise<boolean> {
  if (!oldFile) return false;
  const del = await pickDeleteFirst(ctx, oldFile);
  return del === true;
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
  if (action === "new-here") {
    const del = await askDeleteOld(ctx, cur.file);
    await ctx.newSession({
      withSession: async (nctx) => {
        if (del && cur.file) await deleteOld(cur.file, nctx);
        nctx.ui.notify("New session started here.", "info");
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
    const del = await askDeleteOld(ctx, cur.file);
    await newSessionInDir(ctx, target, cur.file, del);
    return;
  }

  // open
  const picked = await pickSession(ctx, cur.file);
  if (!picked) return;
  const del = await askDeleteOld(ctx, cur.file);
  const targetCwd = path.dirname(picked);
  const meta = await readJsonl(picked);
  const switchTarget = meta.cwd ? path.resolve(meta.cwd) : targetCwd;
  await (ctx as unknown as {
    switchSession: (file: string, opts?: { cwdOverride?: string; withSession?: (n: Nctx) => Promise<void> }) => Promise<unknown>;
  }).switchSession(picked, {
    cwdOverride: switchTarget,
    withSession: async (nctx) => {
      if (del && cur.file) await deleteOld(cur.file, nctx);
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
