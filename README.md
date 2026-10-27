# pi-context-plugin

Hybrid compaction, auto-rename, and built-in pi-vcc extension for [pi](https://github.com/badlogic/pi-mono).

## What it does

Three features:

1. **Hybrid compaction** — replaces pi's default compaction with a lossy summary plus on-demand recall:
   - a compact rolling summary covering the entire conversation (not just the turn prefix)
   - active work kept lossless: the latest user message, the current task, and user-stated constraints
   - dormant detail demoted into verbatim **Recall Keys**, retrievable on demand with `vcc_recall`
   - recent raw messages kept verbatim via `firstKeptEntryId` (pi handles this automatically)
   - an explicit trust hierarchy: raw messages > recalled text > summary > model memory

2. **Auto-rename** — after the first settled agent turn, generates a session title in `main topic: latest context` format and sets it via `pi.setSessionName`. Re-evaluated every `autonameRefreshTurns` settled turns (default 5) so the title tracks conversations that move to new topics. Best-effort; failures are silent.
3. **pi-vcc, built in** — registers everything the [pi-vcc](https://github.com/sting8k/pi-vcc) extension registers, from the vendored git submodule: the `vcc_recall` tool, the `/pi-vcc` and `/pi-vcc-recall` commands, and pi-vcc's settings scaffolding. No separate pi-vcc install needed.

## Why

Pi's default compaction uses a `TURN_PREFIX_SUMMARIZATION_PROMPT` that captures only the "Original Request" (first user message of the turn). In long conversations with multiple follow-ups, this creates a stale anchor that biases the model toward the first task, causing confabulation (inventing questions the user never asked).

The hybrid compaction fixes that by:

- Including the **latest user message verbatim** in the summary
- Describing the **current task** based on the latest state
- Adding a **trust signal** that tells the model which to prefer: raw messages for recent content, summary for coherence

The summary is intentionally **lossy**: it carries intent (what's done, what's open, what's decided) rather than a verbatim transcript. That is safe because `vcc_recall` provides full-fidelity recall of the pre-compaction conversation on demand — the summary is an index, `vcc_recall` is the archive.

- Active work (latest message, current task, user constraints) stays **lossless**
- Dormant detail is **demoted, not deleted**: important pruned detail becomes verbatim Recall Keys — an index, not an archive, since anything not indexed is still recoverable with a free-form `vcc_recall` search
- A **trust hierarchy** tells the model to recall before reconstructing: raw messages > recalled text > summary > its own memory
- When recalling pre-compaction content, the prompt tells the model to use `vcc_recall` with `scope: "all"` — that content is off the current conversation path, and the default `lineage` scope only auto-widens when nothing matches in the current context (so generic terms can be hijacked)

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

The summary the LLM produces is lossy by design: it keeps active work lossless, compresses dormant content, and demotes pruned detail into verbatim Recall Keys. Length is controlled by a word target (injected into the prompt) with an auto-sized token cap as a backstop — see Configuration for the knobs.

### Summary format

The sections are ordered so the ones the model needs most survive a truncation, with the expendable history last:

1. **Original Request** — the first user message's intent
2. **Standing Notes** — durable preferences, lessons, and routines
3. **Latest User Message** — verbatim (lossless)
4. **Current Task** — what the model is working on now (lossless)
5. **In Progress** — work started but not finished
6. **Key Decisions** — decisions with rationale
7. **Next Steps** — what should happen next
8. **Recall Keys** — verbatim search terms for pruned detail (with "use when" triggers)
9. **Note** — the trust hierarchy and recall guidance
10. **Done** — compressed history (last, so a truncation hits it first)

**Done** is the section most prone to bloat, so it is tightly constrained:
- Collapsed into **at most 6 thematic bullets** — one per theme, not per step.
- Each bullet is a **complete, verifiable claim**: what was done plus a checkable outcome (a count, a committed/pushed/passing state, or a specific finding with its basis).
- **Conclusions, not steps**: it records what was determined, not the sequence of actions.
- **Hard boundary**: a bullet is "done" only if it is finished *and* you can state how you know. Anything not finished-and-verified belongs in **In Progress** (bias to In Progress when in doubt) — this stops the model from spiraling back into re-investigating work it wrongly marked done.
- **Throttled on update**: on later compactions the model re-compresses rather than appends — it merges new work into existing themes, updates existing bullets to their current state, prunes obsolete ones, and keeps Done at ≤ 6 bullets and about the same length. The list stays bounded across many compactions instead of growing without limit.

### Auto-rename

```
First agent_settled, then every autonameRefreshTurns settled turns
    ↓
Select user messages: first + up to 3 sampled middle + last 3 (each capped at 500 chars)
    ↓
LLM call (main topic: latest context, max 14 words, 10s timeout)
    ↓
NO_CHANGE → keep current title
otherwise   → pi.setSessionName(title)
```

Both parts update as the conversation moves: the main topic is derived from the whole provided conversation (so a mid-conversation topic shift replaces the original anchor), and the latest context tracks the most recent work. On refresh runs the model sees the current title and can respond `NO_CHANGE` to leave it alone.

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
  "compactionSystemPromptPrefix": "",
  "autonameRefreshTurns": 5,
  "compactionTargetWords": 600,
  "compactionMaxTokens": null,
  "tokensPerWord": 1.3,
  "padding": 2.0,
  "recallKeyBudget": 10
}
```

- `autonameSystemPromptPrefix` — injected at the start of the auto-rename system prompt. Default `""` (no injection).
- `compactionSystemPromptPrefix` — injected as the system prompt for the compaction LLM call. Empty = no system prompt sent (the summary prompt itself is a user message). Default `""`.
- `autonameRefreshTurns` — re-evaluate the session title every N settled turns. `0` = one-shot (name only after the first settled turn). Default `5`.
- `compactionTargetWords` — target length (words) for the compaction summary, injected into the prompt so the model conditions on it. Default `600`.
- `compactionMaxTokens` — hard API `maxTokens` for the summary call. `null` (default) = auto-sized from `compactionTargetWords × tokensPerWord × padding`. Set a number to override; a warning fires if it would bind before the word target is reached.
- `tokensPerWord` — average tokens per word used to auto-size the cap. Raise for code-heavy sessions. Default `1.3`.
- `padding` — multiplier on the auto-sized cap (headroom for imprecision + runaway). Default `2.0`.
- `recallKeyBudget` — maximum number of Recall Key groups in the summary. Default `10`.

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
- The summary is lossy by design; `vcc_recall` is the fidelity layer. Recall Keys are verbatim search terms, so they match the raw JSONL regardless of which compaction tier wrote the summary — recall survives the tier-2/tier-3 fallback.
- If the summary LLM call fails, pi-vcc's algorithmic `compile()` runs as a fallback. If the submodule is not checked out, the extension throws, matching pi's default compaction behavior.
