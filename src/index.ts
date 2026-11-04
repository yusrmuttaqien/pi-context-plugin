/**
 * pi-context-plugin entry point.
 *
 * Registers:
 * - Hybrid compaction (src/compaction.ts)
 * - Session auto-rename (src/auto-rename.ts): automatic retitle from the
 *   live context, a per-session /auto-rename toggle, and on-demand /rename
 * - /open-session (src/open-session): session launcher — switch to an
 *   existing session, start a new one (here or in another directory), or
 *   delete the current session and start fresh
 * - /close-session (src/open-session): close pi, deleting the current session
 *   first if it has a conversation
 * - pi-vcc (vendored submodule): vcc_recall tool, /pi-vcc and
 *   /pi-vcc-recall commands, settings scaffolding, and its own
 *   session_before_compact hook
 *
 * Order matters: our compaction handler is registered before pi-vcc's,
 * because pi's runner keeps the last non-null session_before_compact
 * result. pi-vcc therefore wins when it claims a compaction (explicit
 * /pi-vcc, or overrideDefaultCompaction in its config), and our hybrid
 * summary applies otherwise.
 *
 * Usage:
 *   pi --extension ./src/index.ts
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerAutoRename } from "./auto-rename";
import { registerCompaction } from "./compaction";
import { registerOpenSession, registerCloseSession, registerEmptySessionCleanup } from "./open-session";
import { piVccExtension } from "./pi-vcc";
import { scaffoldSettings } from "./settings";

export default function (pi: ExtensionAPI) {
	scaffoldSettings();
	registerAutoRename(pi);
	registerCompaction(pi);
	registerOpenSession(pi);
	registerCloseSession(pi);
	registerEmptySessionCleanup(pi);
	piVccExtension(pi);
}
