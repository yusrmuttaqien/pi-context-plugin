/**
 * Hybrid compaction.
 *
 * Replaces pi's default compaction with a hybrid approach:
 * 1. Full rolling summary (covers the entire conversation, not just the
 *    turn prefix)
 * 2. Keeps the recent raw messages (via firstKeptEntryId — pi handles this
 *    automatically)
 * 3. Explicit trust signal: tells the model to prefer raw messages over the
 *    summary for recent content
 *
 * Key features:
 * - Uses the same model as the chat (ctx.model)
 * - Extracts the latest *meaningful* user message verbatim from branchEntries
 *   (branch-aware); bare continuations like "continue" or "ok" are skipped in
 *   favor of the most recent substantive message, with a fallback to the
 *   latest message when none is substantive
 * - Lossy summary: keeps active work lossless, compresses dormant content,
 *   and demotes pruned detail into verbatim Recall Keys for vcc_recall.
 * - Length control: word target (injected into the prompt) + auto-sized
 *   token cap (API backstop).
 * - Fallback: if the summary LLM call fails, calls pi-vcc's algorithmic
 *   compile() function (via git submodule). If pi-vcc is not available,
 *   throws the error (same as pi's default compaction behavior).
 */

import { uuidv7 } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { convertToLlm, serializeConversation } from "@earendil-works/pi-coding-agent";
import { buildSummaryPrompt } from "./prompts";
import { piVccCompile, PI_VCC_COMPACT_INSTRUCTION, loadPiVccSettings } from "./pi-vcc";
import { loadSettings } from "./settings";

// Look back at most this many user messages when selecting the latest
// meaningful one (skipping bare continuations like "continue" / "ok").
const LATEST_USER_LOOKBACK = 5;

// Bare acknowledgment/continuation tokens. A short message made up entirely
// of these carries no new intent.
const CONTINUATION_TOKENS = new Set([
	"continue", "cont", "keep", "going", "go", "ahead", "proceed", "ok",
	"okay", "yes", "yeah", "yep", "yup", "no", "nope", "sure", "alright",
	"cool", "next", "done", "great", "thanks", "thank", "you", "please",
	"lgtm", "hm", "hmm", "fine", "good", "sounds", "lets", "carry", "onward",
]);

// A message is a continuation if it is short (<= 4 words, <= 25 chars) and
// made up entirely of continuation tokens (e.g. "continue", "ok",
// "keep going", "yes please").
function isContinuation(text: string): boolean {
	const cleaned = text.toLowerCase().replace(/[^a-z0-9\s]/g, " ").trim();
	if (!cleaned) return true;
	if (cleaned.length > 25) return false;
	const words = cleaned.split(/\s+/);
	if (words.length > 4) return false;
	return words.every((w) => CONTINUATION_TOKENS.has(w));
}

export function registerCompaction(pi: ExtensionAPI): void {
	pi.on("session_before_compact", async (event, ctx) => {
		const { preparation, branchEntries, signal } = event;
		const {
			messagesToSummarize,
			turnPrefixMessages,
			tokensBefore,
			firstKeptEntryId,
			previousSummary,
		} = preparation;

		// Skip when pi-vcc claims this compaction. pi-vcc's hook is registered
		// after ours and its result wins (pi's runner keeps the last non-null
		// result), so our LLM call would be wasted. pi-vcc claims when:
		// - explicit /pi-vcc marker in customInstructions, or
		// - overrideDefaultCompaction is true in pi-vcc's config.
		// Mirroring its gate keeps behaviour identical to pi-vcc standalone.
		if (
			loadPiVccSettings().overrideDefaultCompaction ||
			event.customInstructions?.includes(PI_VCC_COMPACT_INSTRUCTION)
		) {
			return;
		}

		// Extension settings for the compaction call.
		const settings = loadSettings();
		const systemPrompt = settings.compactionSystemPromptPrefix.trim() || undefined;

		// maxTokens for the summary call: an explicit override (validated), or
		// auto-sized from the word target with padding when null.
		const maxTokens =
			settings.compactionMaxTokens != null
				? settings.compactionMaxTokens
				: Math.ceil(settings.compactionTargetWords * settings.tokensPerWord * settings.padding);
		if (settings.compactionMaxTokens != null) {
			const minForTarget = settings.compactionTargetWords * settings.tokensPerWord;
			if (settings.compactionMaxTokens < minForTarget) {
				ctx.ui.notify(
					`Hybrid compaction: compactionMaxTokens (${settings.compactionMaxTokens}) is below the ~${Math.ceil(minForTarget)} tokens needed for the ${settings.compactionTargetWords}-word target — the cap may truncate the summary early`,
					"warning",
				);
			}
		}

		// Use the same model as the chat.
		const model = ctx.model;
		if (!model) {
			ctx.ui.notify("Hybrid compaction: no model available, using default", "warning");
			return;
		}

		ctx.ui.notify(
			`Hybrid compaction: summarizing ${messagesToSummarize.length + turnPrefixMessages.length} messages (${tokensBefore.toLocaleString()} tokens) with ${model.id}...`,
			"info",
		);

		// 1. Build the full conversation for the LLM: the messages being
		//    compacted + the recent raw messages (from firstKeptEntryId
		//    onwards) that pi will preserve verbatim after the summary.
		//    Giving the LLM the full context lets it write a better
		//    transition, even though those recent messages survive as-is.
		const keptIndex = branchEntries.findIndex((e) => e.id === firstKeptEntryId);
		const keptMessages = keptIndex >= 0
			? branchEntries
					.slice(keptIndex)
					.filter((e): e is typeof e & { type: "message" } => e.type === "message")
					.map((e) => e.message)
			: [];
		const allMessages = keptIndex >= 0
			? [...messagesToSummarize, ...keptMessages]
			: [...messagesToSummarize, ...turnPrefixMessages];
		const conversationText = serializeConversation(convertToLlm(allMessages));

		// 2. Extract the latest *meaningful* user message from branchEntries.
		//    branchEntries is the current branch path — branch-aware by design.
		//    A bare continuation ("continue", "ok", "yes", ...) carries no new
		//    intent, so we look back (up to LATEST_USER_LOOKBACK user messages)
		//    for the most recent one that does. If every recent message is a
		//    continuation, we fall back to the most recent one verbatim.
		const recentUserMessages: string[] = [];
		for (
			let i = branchEntries.length - 1;
			i >= 0 && recentUserMessages.length < LATEST_USER_LOOKBACK;
			i--
		) {
			const e = branchEntries[i];
			if (e.type === "message" && e.message.role === "user") {
				const text = e.message.content
					.filter((b): b is { type: "text"; text: string } => b.type === "text")
					.map((b) => b.text)
					.join(" ");
				if (text) recentUserMessages.push(text);
			}
		}
		let latestUserMessage = "";
		for (const text of recentUserMessages) {
			if (!isContinuation(text)) {
				latestUserMessage = text;
				break;
			}
		}
		if (!latestUserMessage) {
			latestUserMessage = recentUserMessages[0] ?? "";
		}

		// 3. Build the hybrid summary prompt.
		const prompt = buildSummaryPrompt({
			latestUserMessage,
			conversationText,
			previousSummary,
			targetWords: settings.compactionTargetWords,
			recallKeyBudget: settings.recallKeyBudget,
		});

		// 4. Call the model.
		try {
			const response = await ctx.modelRegistry.complete(
				model,
				{
					...(systemPrompt ? { systemPrompt } : {}),
					messages: [
						{
							role: "user" as const,
							content: [{ type: "text" as const, text: prompt }],
							timestamp: Date.now(),
						},
					],
				},
				{
					maxTokens,
					signal,
					cacheRetention: "none",
					sessionId: uuidv7(),
				},
			);

			const summary = response.content
				.filter((c): c is { type: "text"; text: string } => c.type === "text")
				.map((c) => c.text)
				.join("\n");

			if (!summary.trim()) {
				ctx.ui.notify("Hybrid compaction: empty summary, using default", "warning");
				return;
			}

			ctx.ui.notify("Hybrid compaction: summary generated", "info");

			// 5. Return the summary — pi keeps the raw window via firstKeptEntryId.
			return {
				compaction: {
					summary,
					firstKeptEntryId,
					tokensBefore,
					usage: response.usage,
				},
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			ctx.ui.notify(`Hybrid compaction LLM call failed: ${message}`, "error");

			// 6. Fallback: call pi-vcc's algorithmic compile() function.
			//    If pi-vcc is not available, throw the error (same as pi's
			//    default compaction behavior).
			if (piVccCompile) {
				try {
					const summary = piVccCompile({
						messages: allMessages,
						previousSummary,
						fileOps: preparation.fileOps,
					});

					if (summary.trim()) {
						ctx.ui.notify("Hybrid compaction: using pi-vcc algorithmic summary", "info");
						return {
							compaction: {
								summary,
								firstKeptEntryId,
								tokensBefore,
							},
						};
					}

					ctx.ui.notify("Hybrid compaction: pi-vcc returned empty summary", "warning");
				} catch (compileError) {
					const compileMessage = compileError instanceof Error ? compileError.message : String(compileError);
					ctx.ui.notify(`Hybrid compaction: pi-vcc compile failed: ${compileMessage}`, "warning");
				}
			} else {
				// piVccCompile is null: the top-level require of the vendored
				// summarize module failed at load time (submodule not checked out
				// or module resolution failed). Tier 2 is unavailable, so we fall
				// straight through to pi's default compaction. Surface it so this
				// silent skip is diagnosable.
				ctx.ui.notify(
					"Hybrid compaction: pi-vcc compile unavailable (vendored module did not load) — falling back to pi default",
					"warning",
				);
			}

			// All options exhausted: throw the error, matching pi's default
			// compaction behavior.
			ctx.ui.notify("Hybrid compaction: compaction failed", "error");
			throw error;
		}
	});
}
