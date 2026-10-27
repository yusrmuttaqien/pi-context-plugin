/**
 * Prompt templates for pi-context-plugin.
 */

// --- Hybrid compaction ---

export interface SummaryPromptOptions {
	latestUserMessage: string;
	conversationText: string;
	previousSummary?: string;
}

/**
 * Build the hybrid summary prompt.
 *
 * Format:
 * - ## Original Request — the first user message's intent
 * - ## Progress — Done / In Progress
 * - ## Latest User Message — verbatim quote
 * - ## Current Task — what the model is working on now
 * - ## Key Decisions — decisions with rationale
 * - ## Next Steps — what should happen next
 * - ## Critical Context — file paths, errors, code snippets
 * - ## Note — trust signal: raw messages > summary for recent content
 */
export function buildSummaryPrompt(options: SummaryPromptOptions): string {
	const { latestUserMessage, conversationText, previousSummary } = options;

	const prevCtx = previousSummary
		? `
Update this existing summary with new information. Preserve all existing information, add new progress, and update the Progress section.

Previous summary:
${previousSummary}
`
		: "";

	return `You are a conversation summarizer. ${prevCtx}
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
