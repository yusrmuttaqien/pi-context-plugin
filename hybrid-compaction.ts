/**
 * Hybrid Compaction Extension
 *
 * Replaces pi's default compaction with a hybrid approach:
 * 1. Full rolling summary (covers the entire conversation, not just the turn prefix)
 * 2. Keeps the recent raw messages (via firstKeptEntryId — pi handles this automatically)
 * 3. Explicit trust signal: tells the model to prefer raw messages over the summary
 *    for recent content
 *
 * Key features:
 * - Uses the same model as the chat (ctx.model)
 * - Extracts the latest user message verbatim from branchEntries
 * - Branch-aware: uses branchEntries (current branch) for latest user message
 * - Fallback: if the summary LLM call fails, calls pi-vcc's algorithmic
 *   compile() function (via git submodule). If pi-vcc is not available,
 *   throws the error (same as pi's default compaction behavior).
 *
 * Usage:
 *   pi --extension ./hybrid-compaction.ts
 */

import { uuidv7 } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { convertToLlm, serializeConversation } from "@earendil-works/pi-coding-agent";

// Import pi-vcc's compile function from the git submodule.
// If the submodule is not present, piVccCompile will be null and we
// fall back to throwing the error (same as pi's default compaction).
let piVccCompile: ((input: { messages: any[]; previousSummary?: string; fileOps?: any }) => string) | null = null;
try {
	const mod = require("./vendor/pi-vcc/src/core/summarize");
 piVccCompile = mod.compile ?? null;
} catch {
 piVccCompile = null;
}

export default function (pi: ExtensionAPI) {
	pi.on("session_before_compact", async (event, ctx) => {
		const { preparation, branchEntries, signal } = event;
		const {
			messagesToSummarize,
			turnPrefixMessages,
			tokensBefore,
			firstKeptEntryId,
			previousSummary,
		} = preparation;

		// Use the same model as the chat
		const model = ctx.model;
		if (!model) {
			ctx.ui.notify("Hybrid compaction: no model available, using default", "warning");
			return;
		}

		ctx.ui.notify(
			`Hybrid compaction: summarizing ${messagesToSummarize.length + turnPrefixMessages.length} messages (${tokensBefore.toLocaleString()} tokens) with ${model.id}...`,
			"info",
		);

		// 1. Serialize the messages pi selected for summarization
		//    (history + turn prefix — covers [start → cut point])
		const allMessages = [...messagesToSummarize, ...turnPrefixMessages];
		const conversationText = serializeConversation(convertToLlm(allMessages));

		// 2. Extract the latest user message from branchEntries
		//    branchEntries is the current branch path — branch-aware by design.
		let latestUserMessage = "";
		for (let i = branchEntries.length - 1; i >= 0; i--) {
			const e = branchEntries[i];
			if (e.type === "message" && e.message.role === "user") {
				latestUserMessage = e.message.content
					.filter((b): b is { type: "text"; text: string } => b.type === "text")
					.map((b) => b.text)
					.join(" ");
				if (latestUserMessage) break;
			}
		}

		// 3. Build the hybrid summary prompt
		const prevCtx = previousSummary
			? `\nUpdate this existing summary with new information. Preserve all existing information, add new progress, and update the Progress section.\n\nPrevious summary:\n${previousSummary}\n`
			: "";

		const prompt = "<|think_off|>\n\n" + `You are a conversation summarizer. ${prevCtx}

Create a structured summary of this conversation. Use EXACTLY this format:

## Original Request
[What the user originally asked for — the first user message's intent]

## Progress
### Done
- [x] [Completed tasks, decisions, deliverables]

### In Progress
- [ ] [Current work based on the latest user message]

## Latest User Message
"${latestUserMessage}"

## Current Task
[What the model is currently working on, based on the latest user message and recent assistant work]

## Key Decisions
- **[Decision]**: [Rationale]

## Next Steps
1. [What should happen next]

## Critical Context
- [File paths, error messages, code snippets, data needed to continue]

## Note
Verbatim raw messages from the cut point onward follow this summary in the model's context. Trust the raw messages over this summary for recent tool outputs, file paths, code snippets, and exact values. This summary provides context and coherence; the raw messages are the ground truth for recent content.

<conversation>
${conversationText}
</conversation>`;

		// 4. Call the model
		try {
			const response = await ctx.modelRegistry.complete(
				model,
				{
					messages: [
						{
							role: "user" as const,
							content: [{ type: "text" as const, text: prompt }],
							timestamp: Date.now(),
						},
					],
				},
				{
					maxTokens: 8192,
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

			// 5. Return the summary — pi keeps the raw window via firstKeptEntryId
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
			}

			// All options exhausted: throw the error, matching pi's default
			// compaction behavior.
			ctx.ui.notify("Hybrid compaction: compaction failed", "error");
			throw error;
		}
	});
}
