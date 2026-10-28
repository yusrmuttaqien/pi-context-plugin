# pi-context-plugin

Hybrid compaction, auto-rename, and built-in pi-vcc extension for [pi](https://github.com/badlogic/pi-mono).

## What it does

Three features:

1. **Hybrid compaction** — replaces pi's default compaction with a lossy summary plus on-demand recall:
   - a compact rolling summary covering the entire conversation (not just the turn prefix)
   - lossless anchors: the latest *meaningful* user message and the current task (never compressed); user-stated constraints are preserved in Standing Notes and take priority there
   - per-section ceilings keep the summary bounded (see Summary format)
   - dormant detail demoted into verbatim **Recall Keys**, retrievable on demand with `vcc_recall`
   - recent raw messages kept verbatim via `firstKeptEntryId` (pi handles this automatically)
   - an explicit trust hierarchy: raw messages > recalled text > summary > model memory

2. **Auto-rename** — after the first settled agent turn, generates a session title in `main topic: latest context` format and sets it via `pi.setSessionName`. Re-evaluated every `autoname.refreshTurns` settled turns (default 5) so the title tracks conversations that move to new topics. Best-effort; failures are silent. Can be toggled off per session with `/autoname`, and run on demand with `/rename`.
3. **pi-vcc, built in** — registers everything the [pi-vcc](https://github.com/sting8k/pi-vcc) extension registers, from the vendored git submodule: the `vcc_recall` tool, the `/pi-vcc` and `/pi-vcc-recall` commands, and pi-vcc's settings scaffolding. No separate pi-vcc install needed.

## Why

Pi's default compaction uses a `TURN_PREFIX_SUMMARIZATION_PROMPT` that captures only the "Original Request" (first user message of the turn). In long conversations with multiple follow-ups, this creates a stale anchor that biases the model toward the first task, causing confabulation (inventing questions the user never asked).

The hybrid compaction fixes that by:

- Including the **latest user message verbatim** in the summary
- Describing the **current task** based on the latest state
- Adding a **trust signal** that tells the model which to prefer: raw messages for recent content, summary for coherence

The summary is intentionally **lossy**: it carries intent (what's done, what's open, what's decided) rather than a verbatim transcript. That is safe because `vcc_recall` provides full-fidelity recall of the pre-compaction conversation on demand — the summary is an index, `vcc_recall` is the archive.

- The latest *meaningful* user message and the current task stay **lossless**; user-stated constraints are preserved in Standing Notes (capped, but prioritized there)
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

The summary the LLM produces is lossy by design: it keeps the lossless anchors (latest meaningful user message, current task) intact, compresses dormant content, and demotes pruned detail into verbatim Recall Keys. Length is controlled by per-section item ceilings (hard caps) plus a fixed `maxTokens` backstop against runaway — there is no separate word target. See Configuration and Summary format for the details.

### Summary format

The sections are ordered so the ones the model needs most survive a truncation, with the expendable history last. Lossy sections carry a hard ceiling; the two lossless anchors are marked:

1. **Original Request** — the first user message's intent
2. **Standing Notes** — durable preferences, lessons, and routines (≤ 10)
3. **Latest User Message** — verbatim quote of the latest *meaningful* user message (lossless)
4. **Current Task** — what the model is working on now (lossless)
5. **In Progress** — work started but not finished (≤ 5)
6. **Key Decisions** — decisions with rationale (≤ 10)
7. **Next Steps** — what should happen next (≤ 5)
8. **Recall Keys** — verbatim search terms for pruned detail, with "use when" triggers (≤ 10 groups)
9. **Note** — the trust hierarchy and recall guidance
10. **Done** — compressed history (≤ 6, last, so a truncation hits it first)

**Length model.** There is no separate word target. Each lossy section has a hard **item ceiling** (a cap on how many items it may hold — the numbers in the list above are the defaults, configurable via `compaction.ceilings`), and the prompt tells the model to keep items terse and the whole summary concise. The two lossless anchors (Latest User Message, Current Task) are uncapped. `compaction.maxTokens` is a separate API backstop that only bounds runaway generation — it is not a length target. Detail that doesn't fit a section is demoted to Recall Keys, where it stays retrievable with `vcc_recall`. Because the budget is per-section, there is no single global number to tune — raise a ceiling (or `maxTokens`) to let a section hold more.

**Lossless anchors.** The Latest User Message and Current Task are never compressed — they anchor the current work and get as much space as they need. User-stated constraints that the current work depends on are preserved in Standing Notes and take priority there.

**Latest *meaningful* user message.** A bare continuation ("continue", "ok", "yes") carries no intent, so the extractor skips it and uses the most recent substantive user message (looking back up to 5 user messages). If every recent message is a continuation, it falls back to the most recent one verbatim.

**Cross-cutting rules.**
- **Re-compress, don't append** — on later compactions the model merges new work into existing themes, updates existing bullets to their current state, prunes obsolete items, and keeps every section within its ceiling (the total stays about the same length, not longer).
- **Overflow → Recall Keys** — anything that exceeds a ceiling or is dropped becomes a verbatim Recall Key (an index, not an archive; anything not indexed is still recoverable with a free-form `vcc_recall` search).
- **Contradictions resolve to the latest** — if two statements conflict, the most recent wins and the superseded one is demoted to Recall Keys if worth keeping.

**Done** is the section most prone to bloat, so each bullet is a **complete, verifiable claim** (what was done plus a checkable outcome), written as **conclusions, not steps**, with a **hard boundary**: a bullet is "done" only if it is finished *and* you can state how you know — anything not finished-and-verified belongs in **In Progress** (bias to In Progress when in doubt). This stops the model from spiraling back into re-investigating work it wrongly marked done.

### Auto-rename

```
First agent_settled, then every autoname.refreshTurns settled turns
    ↓
Select user messages: first + up to 3 sampled middle + last 3 (each capped at 500 chars)
    ↓
LLM call (main topic: latest context, max 14 words, 10s timeout)
    ↓
NO_CHANGE → keep current title
otherwise   → pi.setSessionName(title)
```

Both parts update as the conversation moves: the main topic is derived from the whole provided conversation (so a mid-conversation topic shift replaces the original anchor), and the latest context tracks the most recent work. On refresh runs the model sees the current title and can respond `NO_CHANGE` to leave it alone.

### `/autoname` — per-session toggle

Auto-rename is on by default. Turn it off for the current session and back on again with the `/autoname` command:

- `/autoname` — toggle (no argument flips the current state)
- `/autoname off` — disable for this session
- `/autoname on` — re-enable (forces one immediate rename so the title doesn't sit stale until the next refresh boundary)
- `/autoname status` — show the current state

The state is stored as a per-session custom entry, so it survives restarts and `pi --resume`, is never sent to the LLM, and is still readable after compaction. While disabled, a footer status reads `autoname: off` (cleared when re-enabled). Each session has its own state, so toggling here doesn't affect other sessions.

### `/rename` — run the auto-rename now

`/rename` runs the LLM naming pass on demand, without waiting for the next `autoname.refreshTurns` boundary. It works even when `/autoname` is off, since it is an explicit user action. It reuses the exact same naming logic as the background handler (same prompt, same message selection, same `NO_CHANGE` handling) and reports the outcome:

- renamed → `Session renamed to: <title>`
- `NO_CHANGE` (the current title still fits) → `Auto-rename: no change`
- no user messages yet → `Auto-rename: nothing to rename yet`
- LLM failure → `Auto-rename: no title produced`

The current title is read from the session (authoritative, survives restarts), so the model can keep a good name instead of overwriting it.

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

This extension reads `~/.pi/agent/pi-context-plugin-config.json` (overridable via `PI_CONTEXT_PLUGIN_CONFIG_PATH`): created on first load, missing keys filled in, existing values preserved. Settings are namespaced by feature. Old flat keys (`compactionTargetWords`, `compactionMaxTokens`, `recallKeyBudget`, `autonameSystemPromptPrefix`, `autonameRefreshTurns`, `compactionSystemPromptPrefix`, `tokensPerWord`, `padding`) are migrated into this structure automatically; the removed word-target knobs (`compactionTargetWords`, `tokensPerWord`, `padding`) are dropped.

```json
{
  "autoname": {
    "systemPromptPrefix": "",
    "refreshTurns": 5
  },
  "compaction": {
    "systemPromptPrefix": "",
    "maxTokens": 4000,
    "ceilings": {
      "standingNotes": 10,
      "keyDecisions": 10,
      "inProgress": 5,
      "nextSteps": 5,
      "done": 6,
      "recallKeys": 10
    }
  }
}
```

### `autoname`

- `autoname.systemPromptPrefix` — injected at the start of the auto-rename system prompt. Default `""` (no injection).
- `autoname.refreshTurns` — re-evaluate the session title every N settled turns. `0` = one-shot (name only after the first settled turn). Default `5`.

### `compaction`

- `compaction.systemPromptPrefix` — injected as the system prompt for the compaction LLM call. Empty = no system prompt sent (the summary prompt itself is a user message). Default `""`.
- `compaction.maxTokens` — hard API `maxTokens` for the summary call. A backstop against runaway generation, not a length target — the per-section ceilings are the real length control. Default `4000`.
- `compaction.ceilings` — per-section **item** ceilings (max items per lossy section). Defaults:

| Ceiling | Default | Section |
|---|---|---|
| `ceilings.standingNotes` | `10` | Standing Notes (Pref / Lesson / Routine items) |
| `ceilings.keyDecisions` | `10` | Key Decisions |
| `ceilings.inProgress` | `5` | In Progress |
| `ceilings.nextSteps` | `5` | Next Steps |
| `ceilings.done` | `6` | Done (thematic bullets) |
| `ceilings.recallKeys` | `10` | Recall Keys (groups) |

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
│   ├── auto-rename.ts    # session auto-rename handler + /rename command
│   ├── autoname-toggle.ts  # /autoname command + per-session on/off state
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
- The latest user message is extracted from `branchEntries` (branch-aware) and is the latest *meaningful* one — bare continuations like "continue" or "ok" are skipped in favor of the most recent substantive message, with a fallback to the latest message when none is substantive.
- The summary is lossy by design; `vcc_recall` is the fidelity layer. Recall Keys are verbatim search terms, so they match the raw JSONL regardless of which compaction tier wrote the summary — recall survives the tier-2/tier-3 fallback.
- If the summary LLM call fails, pi-vcc's algorithmic `compile()` runs as a fallback. If the submodule is not checked out, the extension throws, matching pi's default compaction behavior.
