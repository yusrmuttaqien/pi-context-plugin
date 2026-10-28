/**
 * Prompt templates for pi-context-plugin.
 */

import type { CompactionCeilings } from "./settings";

// --- Hybrid compaction ---

export interface SummaryPromptOptions {
	latestUserMessage: string;
	conversationText: string;
	previousSummary?: string;
	/** Per-section item ceilings for the lossy summary sections. */
	ceilings: CompactionCeilings;
}

/**
 * Build the hybrid summary prompt.
 *
 * The summary is intentionally lossy: it carries intent (what's done, what's
 * open, what's decided) while dormant detail is demoted into verbatim Recall
 * Keys that can be retrieved on demand with vcc_recall. The Latest User
 * Message and Current Task stay lossless; user-stated constraints are
 * preserved in Standing Notes and take priority there.
 *
 * Format (critical sections first; the expendable "Done" history last, so a
 * truncation hits the history, not the active state):
 * - ## Original Request — the first user message's intent
 * - ## Standing Notes — durable Pref / Lesson / Routine items (capped, lossy)
 * - ## Latest User Message — verbatim quote of the latest *meaningful* user
 *   message (lossless; bare continuations like "continue" are skipped)
 * - ## Current Task — what the model is working on now (lossless)
 * - ## In Progress — work started but not finished (capped, lossy)
 * - ## Key Decisions — decisions with rationale (capped, lossy)
 * - ## Next Steps — what should happen next (capped, lossy)
 * - ## Recall Keys — verbatim search terms for pruned content (capped by budget)
 * - ## Note — trust hierarchy + nudge to recall rather than reconstruct
 * - ## Done — compressed, verifiable, capped history (last; sacrificed on truncation)
 *
 * Length model: each lossy section has a hard item ceiling (the number of
 * items it may contain); the summary is kept concise overall, with the
 * Latest User Message and Current Task never compressed. There is no separate
 * word target — the ceilings plus terse-item guidance define the budget, and
 * detail that doesn't fit is demoted to Recall Keys. Cross-cutting rules:
 * re-compress on update (don't append), overflow/superseded detail demotes to
 * Recall Keys, and contradictions are resolved in favor of the most recent
 * statement.
 */
export function buildSummaryPrompt(options: SummaryPromptOptions): string {
	const { latestUserMessage, conversationText, previousSummary, ceilings } = options;

	const prevCtx = previousSummary
		? `
Update this existing summary by RE-COMPRESSING it, not by appending to it.
- Merge new work into an existing theme; update existing bullets to their current state ("proposed X" becomes "X done, committed").
- Prune obsolete and superseded items; resolve contradictions in favor of the current (most recent) state.
- Keep every section within its ceiling, and keep the total about the same length as the previous summary, not longer.
- Demote dropped or overflowing detail into Recall Keys; keep Standing Notes and Recall Keys that are still relevant.

Previous summary:
${previousSummary}
`
		: "";

	return `You are a conversation summarizer. ${prevCtx}
Create a structured summary of this conversation.

Length and allocation:
- Keep the summary concise: write only what's needed, keep each item terse, and never exceed a section's item ceiling.
- Never compress the Latest User Message or the Current Task — they anchor the current work and get as much space as they need.
- Item ceilings: Standing Notes ≤ ${ceilings.standingNotes}, Key Decisions ≤ ${ceilings.keyDecisions}, Done ≤ ${ceilings.done}, In Progress ≤ ${ceilings.inProgress}, Next Steps ≤ ${ceilings.nextSteps}, Recall Keys ≤ ${ceilings.recallKeys} groups. Fill each as needed, up to its ceiling. User-stated constraints that the current work depends on go in Standing Notes and take priority there.

Content rules:
- Done: at most ${ceilings.done} thematic bullets, each a complete verifiable claim: what was done plus a checkable outcome (a count, a committed/pushed/passing state, or a specific finding with its basis). Conclusions, not steps. A bullet is "done" only if it is finished AND you can state how you know; if you can't, it is not done and belongs in In Progress. When in doubt, In Progress.
- Standing Notes: durable preferences, lessons, and routines only. Merge related items; prune obsolete ones. User-stated constraints that the current work depends on take priority here.
- Key Decisions: each states the decision plus a terse why. Merge related decisions; prune superseded ones.
- Contradictions: if two statements conflict, keep the most recent and drop the one it supersedes; demote the dropped history to Recall Keys if worth keeping.
- Overflow: anything that exceeds a ceiling or is dropped becomes a verbatim Recall Key (an index, not an archive — anything not indexed is still recoverable with a free-form vcc_recall search).
- Recall Keys: at most ${ceilings.recallKeys} groups. Each group is a short topic label, a "use when" trigger (1–5 words describing the need it answers — a menu label, not a search term), and 1–3 short verbatim phrases taken exactly from the conversation. Phrases must be punctuation-free and distinctive.
- Inline detail: file paths, error messages, and snippets still needed for the current task stay inline (Current Task / Next Steps); older ones become Recall Keys.

Use EXACTLY this format:

## Original Request
[What the user originally asked for — the first user message's intent]

## Standing Notes
- Pref: [user-stated preference or constraint]
- Lesson: [what was learned, and why it matters]
- Routine: [repeated procedure worth remembering]
(If none apply, write "None".)

## Latest User Message
"${latestUserMessage}"

## Current Task
[What the model is currently working on — keep complete and lossless]

## In Progress
- [ ] [Work that is started but not finished; you will continue it. Anything not definitively finished-and-verified belongs here, not in Done.]

## Key Decisions
- **[Decision]**: [terse rationale]

## Next Steps
1. [What should happen next]

## Recall Keys
- **[topic]** (use when [1–5 word trigger]): "verbatim phrase", "verbatim phrase"

## Note
Fresh raw messages follow this summary — trust them for recent content.
For older detail not in the fresh messages:
- Check the Recall Keys first. If a key matches what you need, call vcc_recall with that exact phrase and scope:'all' (keys point to pre-compaction content, which is off the current conversation path) and use the recalled text. Do NOT reconstruct it from memory or reasoning — a recalled fact beats a remembered one; the recalled text is the ground truth.
- For other pre-compaction detail a key doesn't cover, search vcc_recall with scope:'all' using distinctive words from the conversation.
- Answer from your own knowledge only if no key, raw message, or recall covers it, and say so explicitly.

## Done
- [x] [Theme]: [what was done + its checkable outcome: a count, a committed/pushed/passing state, or a specific finding with its basis]. One bullet per theme, not per step. Max ${ceilings.done} bullets.
(A bullet is "done" only if it is finished AND you can state how you know. If you can't, it is not done and belongs in In Progress. When in doubt, In Progress.)

<conversation>
${conversationText}
</conversation>`;
}

// --- Auto-rename ---

export const RENAME_NO_CHANGE = "NO_CHANGE";

export interface RenamePromptOptions {
	/** Selected user messages in chronological order (first, sampled middle, recent). */
	messages: string[];
	/** Current session title; present on refresh runs. */
	currentTitle?: string;
}

/**
 * Build the session-title prompt.
 *
 * The main topic must be derivable from the whole conversation, not
 * just the first message — topics can shift mid-conversation.
 */
export function buildRenamePrompt(options: RenamePromptOptions): string {
	const { messages, currentTitle } = options;

	const current = currentTitle
		? `\nCurrent title: "${currentTitle}"\nIf the current title still fits the conversation, respond ${RENAME_NO_CHANGE}.\n`
		: "";

	return `Generate a short title for this conversation.${current}

The title has two parts separated by ": ":
- Main topic: the overall topic the conversation is currently about. Derive it from the whole conversation below — if the topic has shifted mid-conversation, use the new topic, not the original one.
- Latest context: what is being worked on right now, from the most recent messages.

Example of a good title: "Auth module refactor: fixing the token refresh bug"
If the conversation is a single simple topic, use just a short title with no ": " separator.

Conversation (user messages, chronological):
${messages.map((m, i) => `${i + 1}. ${m}`).join("\n")}

Respond with ONLY the title (or ${RENAME_NO_CHANGE}), max 14 words, with no angle brackets, field labels, numbering, or other text.`;
}
