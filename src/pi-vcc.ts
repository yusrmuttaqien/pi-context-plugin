/**
 * pi-vcc integration.
 *
 * pi-vcc is vendored as a git submodule (vendor/pi-vcc) and is a standard
 * pi extension: its default export takes the ExtensionAPI and registers
 * the vcc_recall tool, the /pi-vcc and /pi-vcc-recall commands, the
 * settings scaffolding, and its own session_before_compact hook.
 *
 * Calling piVccExtension(pi) from our extension makes all of that
 * available without installing pi-vcc separately.
 *
 * Registration order matters: pi's runner keeps the LAST non-null
 * session_before_compact result, so our compaction handler must be
 * registered BEFORE pi-vcc's. That way pi-vcc wins when it claims a
 * compaction (explicit /pi-vcc marker, or overrideDefaultCompaction),
 * and our hybrid summary applies otherwise.
 *
 * The algorithmic compile() function is also exposed directly for use
 * as a fallback in our compaction handler. If the submodule is not
 * checked out or fails to load, piVccCompile is null and the caller
 * falls back to throwing, matching pi's default compaction behavior.
 */

import piVccExtension from "../vendor/pi-vcc/index";
import { PI_VCC_COMPACT_INSTRUCTION } from "../vendor/pi-vcc/src/core/compact-args";
import { loadSettings as loadPiVccSettings } from "../vendor/pi-vcc/src/core/settings";

export type PiVccCompile = (input: {
	messages: unknown[];
	previousSummary?: string;
	fileOps?: unknown;
}) => string;

let piVccCompile: PiVccCompile | null = null;
try {
	const mod = require("../vendor/pi-vcc/src/core/summarize");
	piVccCompile = mod.compile ?? null;
} catch {
	piVccCompile = null;
}

export { piVccCompile, piVccExtension, PI_VCC_COMPACT_INSTRUCTION, loadPiVccSettings };
