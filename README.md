# pi-context-plugin

Hybrid compaction, auto-rename, and built-in pi-vcc extension for [pi](https://github.com/badlogic/pi-mono).

## What it does

Three features:

1. **Hybrid compaction** — replaces pi's default compaction with:
   - a full rolling summary covering the entire conversation (not just the turn prefix)
   - recent raw messages kept verbatim via `firstKeptEntryId` (pi handles this automatically)
   - an explicit trust signal telling the model to prefer raw messages over the summary for recent content

2. **Auto-rename** — after the first settled agent turn, generates a short session title from the conversation and sets it via `pi.setSessionName`. Best-effort; failures are silent.
3. **pi-vcc, built in** — registers everything the [pi-vcc](https://github.com/sting8k/pi-vcc) extension registers, from the vendored git submodule: the `vcc_recall` tool, the `/pi-vcc` and `/pi-vcc-recall` commands, and pi-vcc's settings scaffolding. No separate pi-vcc install needed.

## Why

Pi's default compaction uses a `TURN_PREFIX_SUMMARIZATION_PROMPT` that captures only the "Original Request" (first user message of the turn). In long conversations with multiple follow-ups, this creates a stale anchor that biases the model toward the first task, causing confabulation (inventing questions the user never asked).

The hybrid compaction fixes that by:

- Including the **latest user message verbatim** in the summary
- Describing the **current task** based on the latest state
- Adding a **trust signal** that tells the model which to prefer: raw messages for recent content, summary for coherence

## How it works

### Hybrid compaction

```
Compaction triggers
    ↓
LLM call (same model as chat)
    ↓
┌─────────────────────┬─────────────────────┐
│ Success             │ Failure             │
│ → Return hybrid     │ → Call pi-vcc's     │
│   summary           │   compile()         │
│   (with trust        │   (algorithmic,     │
│   signal)            │   no LLM)          │
│                     │ → If pi-vcc fails   │
│                     │   or is missing    │
│                     │   → Throw error    │
│                     │   (same as pi's   │
│                     │   default)         │
└─────────────────────┴─────────────────────┘
```

### Auto-rename

```
First agent_settled
    ↓
Collect user messages (each capped at 2000 chars, head + tail)
    ↓
LLM call (max 10-word title, 10s timeout)
    ↓
pi.setSessionName(title)
```

### pi-vcc integration

pi-vcc is a standard pi extension, so this plugin calls its default export with the same `ExtensionAPI`. Everything pi-vcc registers becomes available through this one extension:

- `vcc_recall` — model tool for recalling pre-compaction content
- `/pi-vcc` — manual compaction with pi-vcc's algorithmic summary
- `/pi-vcc-recall` — manual recall command
- pi-vcc's own `session_before_compact` hook

The two before-compact hooks coexist because pi's runner keeps the **last non-null** result. This plugin registers its compaction handler *before* calling pi-vcc, so:

- pi-vcc wins when it claims a compaction (explicit `/pi-vcc`, or `overrideDefaultCompaction: true` in its config)
- the hybrid LLM summary applies otherwise
- the hybrid handler mirrors pi-vcc's claim gate (marker or `overrideDefaultCompaction`), so it never makes an LLM call that pi-vcc would discard

**Config:** pi-vcc writes its settings to `~/.pi/agent/pi-vcc-config.json` (overridable via `PI_VCC_CONFIG_PATH`). Note that `overrideDefaultCompaction` defaults to `true` on fresh installs, meaning pi-vcc handles *all* compactions and the hybrid LLM path never runs. Set it to `false` if you want the hybrid summary for automatic compactions while keeping `/pi-vcc` for manual algorithmic compaction.

**Do not also install pi-vcc as a separate pi package** — the `vcc_recall` tool and commands would be registered twice.

## Configuration

This extension reads `~/.pi/agent/pi-context-plugin-config.json` (overridable via `PI_CONTEXT_PLUGIN_CONFIG_PATH`), structurally identical to pi-vcc's config: created on first load, missing keys filled in, existing values preserved.

```json
{
  "autonameSystemPromptPrefix": "",
  "compactionSystemPromptPrefix": ""
}
```

- `autonameSystemPromptPrefix` — injected at the start of the auto-rename system prompt.
- `compactionSystemPromptPrefix` — injected as the system prompt for the compaction LLM call. Empty = no system prompt sent (the summary prompt itself is a user message).

Both default to `""` (no injection).

## Usage

```bash
git clone <repo>
cd pi-context-plugin
git submodule update --init --recursive   # vendor/pi-vcc (pi-vcc integration)
pi --extension ./src/index.ts
```

## File layout

```
pi-context-plugin/
├── src/
│   ├── index.ts          # entry point, registers all features (order matters)
│   ├── compaction.ts     # hybrid compaction handler
│   ├── auto-rename.ts    # session auto-rename handler
│   ├── pi-vcc.ts         # pi-vcc integration: full extension + compile() fallback
│   ├── prompts.ts        # prompt builders (summary + rename)
│   └── settings.ts       # extension settings (mirrors pi-vcc's settings structure)
├── vendor/
│   └── pi-vcc/           # git submodule → github.com/sting8k/pi-vcc
├── package.json
└── README.md
```

## Notes

- The summary uses the same model as the chat (`ctx.model`).
- The latest user message is extracted from `branchEntries`, so compaction is branch-aware.
- If the summary LLM call fails, pi-vcc's algorithmic `compile()` runs as a fallback. If the submodule is not checked out, the extension throws, matching pi's default compaction behavior.
