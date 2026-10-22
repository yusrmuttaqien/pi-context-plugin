/**
 * Prompt templates for hybrid compaction.
 */

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
		? `\nUpdate this existing summary with new information. Preserve all existing information, add new progress, and update the Progress section.\n\nPrevious summary:\n${previousSummary}\n`
		: "";

	return "<|think_off|>\n\n" + `You are a conversation summarizer. ${prevCtx}

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
