/**
 * pi-context-plugin entry point.
 *
 * Registers:
 * - /open-session (src/open-session): session launcher — switch to an
 *   existing session, start a new one (here or in another directory), or
 *   delete the current session and start fresh
 * - /close-session (src/open-session): close pi, deleting the current session
 *   first if it has a conversation
 * - empty-session cleanup (src/open-session): removes empty sessions
 * - pi-vcc (vendored submodule): vcc_recall tool, /pi-vcc and
 *   /pi-vcc-recall commands, settings scaffolding, and its own
 *   session_before_compact hook (opt-in compaction fallback, gated by
 *   overrideDefaultCompaction in the vendored config)
 *
 * The hybrid compaction (src/compaction.ts) and session auto-rename
 * (src/auto-rename.ts) modules were removed. pi's native compaction applies
 * unless pi-vcc claims a compaction (explicit /pi-vcc, or
 * overrideDefaultCompaction in its config).
 *
 * Usage:
 *   pi --extension ./src/index.ts
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerOpenSession, registerCloseSession, registerEmptySessionCleanup } from "./open-session";
import { piVccExtension } from "./pi-vcc";
import { scaffoldSettings } from "./settings";

export default function (pi: ExtensionAPI) {
	scaffoldSettings();
	registerOpenSession(pi);
	registerCloseSession(pi);
	registerEmptySessionCleanup(pi);
	piVccExtension(pi);
}
