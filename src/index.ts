/**
 * pi-context-plugin entry point.
 *
 * Registers:
 * - Hybrid compaction (src/compaction.ts)
 * - Session auto-rename (src/auto-rename.ts), with a per-session
 *   /autoname toggle (src/autoname-toggle.ts)
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
import { registerAutonameToggle } from "./autoname-toggle";
import { registerCompaction } from "./compaction";
import { piVccExtension } from "./pi-vcc";
import { scaffoldSettings } from "./settings";

export default function (pi: ExtensionAPI) {
	scaffoldSettings();
	registerAutoRename(pi);
	registerAutonameToggle(pi);
	registerCompaction(pi);
	piVccExtension(pi);
}
