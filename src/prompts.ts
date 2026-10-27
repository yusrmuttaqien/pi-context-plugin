/**
 * Prompt templates for pi-context-plugin.
 */

// --- Hybrid compaction ---

export interface SummaryPromptOptions {
	latestUserMessage: string;
	conversationText: string;
	previousSummary?: string;
	/** Word target injected into the prompt (the length the model should aim for). */
	targetWords: number;
	/** Maximum number of recall-key groups in the summary. */
	recallKeyBudget: number;
}

/**
 * Build the hybrid summary prompt.
 *
 * The summary is intentionally lossy: it carries intent (what's done, what's
 * open, what's decided) while dormant detail is demoted into verbatim Recall
 * Keys that can be retrieved on demand with vcc_recall. Active work
 * (Latest User Message, Current Task, user-stated constraints) stays lossless.
 *
 * Format (critical sections first; the expendable "Done" history last, so a
 * truncation hits the history, not the active state):
 * - ## Original Request — the first user message's intent
 * - ## Standing Notes — durable Pref / Lesson / Routine items
 * - ## Latest User Message — verbatim quote (lossless)
 * - ## Current Task — what the model is working on now (lossless)
 * - ## In Progress — work started but not finished (anything not verified-done)
 * - ## Key Decisions — decisions with rationale
 * - ## Next Steps — what should happen next
 * - ## Recall Keys — verbatim search terms for pruned content (with "use when" triggers)
 * - ## Note — trust hierarchy + nudge to recall rather than reconstruct
 * - ## Done — compressed, verifiable, capped history (last; sacrificed on truncation)
 */
export function buildSummaryPrompt(options: SummaryPromptOptions): string {
	const { latestUserMessage, conversationText, previousSummary, targetWords, recallKeyBudget } = options;

	const prevCtx = previousSummary
		? `
Update this existing summary by RE-COMPRESSING it, not by appending to it.
- Merge new work into an existing theme where it fits; add a Done bullet only for genuinely new work that fits no existing theme.
- Update existing Done bullets to their current state ("proposed X" becomes "X done, committed").
- Prune Done bullets no longer relevant to the current work; demote their key detail into Recall Keys.
- Keep Done at at most 6 bullets; if it exceeds 6, merge or prune until it fits.
- Keep Standing Notes and Recall Keys that are still relevant; prune obsolete ones.
- The result should be about the same length as the previous summary, not longer.

Previous summary:
${previousSummary}
`
		: "";

	return `You are a conversation summarizer. ${prevCtx}
Create a structured summary of this conversation.

Compression rules:
- Length: keep the whole summary to roughly ${targetWords} words (a target, not a hard limit; stay within ±20%).
- Lossless: keep the Latest User Message, the Current Task, and any user-stated preference or constraint the current work depends on, complete and intact.
- Lossy: compress finished work, superseded approaches, and background detail that is no longer actively referenced.
- Done: collapse finished work into at most 6 thematic bullets, each a complete verifiable claim: what was done plus a checkable outcome (a count, a committed/pushed/passing state, or a specific finding with its basis). State conclusions, not a list of steps. A bullet is "done" only if it is finished AND you can state how you know; if you can't, it is not done and belongs in In Progress. When in doubt, In Progress.
- Details that don't fit a bullet (file lists, histograms, PR numbers, flag names) become Recall Keys. You do NOT need to index everything — anything not in the summary is still recoverable with a free-form vcc_recall search, so index only the detail most likely to be needed again.
- Standing Notes: include only durable items (user preferences, lessons, routines) that still matter; prune obsolete ones. Record every user-stated constraint, even a minor one, as a Pref if it could affect future actions.
- Recall Keys: at most ${recallKeyBudget} groups. Each group is a short topic label, a "use when" trigger (1–5 words describing the need it answers — a menu label, not a search term), and 1–3 short verbatim phrases taken exactly from the conversation. Phrases must be punctuation-free and distinctive; a phrase that appears exactly in the conversation matches reliably.
- File paths, error messages, and snippets still needed for the current task stay inline (Current Task / Next Steps); older ones become Recall Keys.

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
- [x] [Theme]: [what was done + its checkable outcome: a count, a committed/pushed/passing state, or a specific finding with its basis]. One bullet per theme, not per step. Max 6 bullets.
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
