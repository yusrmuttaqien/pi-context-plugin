# pi-context-plugin

Hybrid compaction extension for [pi](https://github.com/badlogic/pi-mono).

## What it does

Replaces pi's default compaction with a hybrid approach:

1. **Full rolling summary** — covers the entire conversation, not just the turn prefix
2. **Keeps recent raw messages** — via `firstKeptEntryId` (pi handles this automatically)
3. **Explicit trust signal** — tells the model to prefer raw messages over the summary for recent content

## Why

Pi's default compaction uses a `TURN_PREFIX_SUMMARIZATION_PROMPT` that captures only the "Original Request" (first user message of the turn). In long conversations with multiple follow-ups, this creates a stale anchor that biases the model toward the first task, causing confabulation (inventing questions the user never asked).

This extension fixes that by:
- Including the **latest user message verbatim** in the summary
- Describing the **current task** based on the latest state
- Adding a **trust signal** that tells the model which to prefer: raw messages for recent content, summary for coherence

## How it works

```
Compaction triggers
    ↓
LLM call (same model as chat)
    ↓
┌─────────────────────┬─────────────────────┐
│ Success             │ Failure             │
│ → Return hybrid     │ → Call pi-vcc's     │
│   summary           │   compile()        │
│   (with trust       │   (algorithmic,     │
│   signal)            │   no LLM)          │
│                     │ → If pi-vcc fails  │
│                     │   or not available │
│                     │   → Throw error    │
│                     │   (same as pi's   │
│                     │   default)         │
└─────────────────────┴─────────────────────┘
```

## Files

```
pi-context-plugin/
├── hybrid-compaction.ts   # The extension
├── prompts.ts             # Prompt templates
└── vendor/
    └── pi-vcc/            # Git submodule → github.com/sting8k/pi-vcc
```

## Install

```bash
# Clone the repo
git clone https://github.com/yusrmuttaqien/pi-context-plugin.git
cd pi-context-plugin

# Initialize the submodule
git submodule update --init

# Load the extension
pi --extension ./hybrid-compaction.ts
```

## Update pi-vcc

```bash
cd vendor/pi-vcc
git pull
cd ../..
git add vendor/pi-vcc
git commit -m "Update pi-vcc submodule"
git push
```

## Summary format

The generated summary has this structure:

```
## Original Request
[What the user originally asked for]

## Progress
### Done
- [x] [Completed tasks]

### In Progress
- [ ] [Current work]

## Latest User Message
"[verbatim quote]"

## Current Task
[What the model is working on now]

## Key Decisions
- **[Decision]**: [Rationale]

## Next Steps
1. [What should happen next]

## Critical Context
- [File paths, errors, code snippets]

## Note
Verbatim raw messages from the cut point onward follow this summary.
Trust the raw messages over this summary for recent content.
```

## Fallback chain

1. **LLM call succeeds** → return hybrid summary
2. **LLM call fails, pi-vcc available** → call `pi-vcc`'s `compile()` (algorithmic, no LLM)
3. **LLM call fails, pi-vcc unavailable** → throw error (same as pi's default compaction)

## Notes

- Uses the **same model as the chat** (`ctx.model`) for summarization
- **Branch-aware**: uses `branchEntries` (current branch path) for the latest user message
- **Rolling summary**: if a previous summary exists, the prompt includes it for merging
- The `firstKeptEntryId` is passed through from pi's preparation — pi automatically keeps the raw recent window
