# pi-context-plugin

Hybrid compaction, auto-rename, a session launcher, and built-in pi-vcc for [pi](https://github.com/badlogic/pi-mono).

## Usage

Install from git:

```bash
pi install git:github.com/yusrmuttaqien/pi-context-plugin
```

Or clone and run directly:

```bash
git clone <repo>
cd pi-context-plugin
npm install        # postinstall: checks out vendor/pi-vcc + flips overrideDefaultCompaction
pi --extension ./src/index.ts
```

Both run the `postinstall` script, which checks out the `vendor/pi-vcc` submodule **and** flips `overrideDefaultCompaction` to `false` in the vendored source (so the hybrid summary handles automatic compactions rather than pi-vcc). The pi-vcc integration needs that submodule, so if you skip the install step and check out the submodule manually with `git submodule update --init --recursive`, make that same edit yourself — pi-vcc's upstream default is `true`, so it would otherwise claim every compaction.

## What it does

Four features:

1. **Hybrid compaction** — replaces pi's default compaction with a lossy summary plus on-demand recall:
   - a compact rolling summary covering the entire conversation (not just the turn prefix)
   - lossless anchors: the latest *meaningful* user message and the current task (never compressed); user-stated constraints are preserved in Standing Notes and take priority there
   - per-section ceilings keep the summary bounded (defaults in Configuration)
   - dormant detail demoted into verbatim **Recall Keys**, retrievable on demand with `vcc_recall`
   - recent raw messages kept verbatim via `firstKeptEntryId` (pi handles this automatically)
   - an explicit trust hierarchy: raw messages > recalled text > summary > model memory

2. **Auto-rename** — after the first settled agent turn, generates a session title in `main topic: latest context` format and sets it via `pi.setSessionName`. Re-evaluated every `autoname.refreshTurns` settled turns (default 5) so the title tracks conversations that move to new topics. Best-effort; failures are silent. Toggle off per session with `/autoname`, run on demand with `/rename`.

3. **pi-vcc, built in** — registers everything the [pi-vcc](https://github.com/sting8k/pi-vcc) extension registers, from the vendored git submodule: the `vcc_recall` tool, the `/pi-vcc` and `/pi-vcc-recall` commands, and pi-vcc's settings scaffolding. No separate pi-vcc install needed.

4. **Session launcher** — `/open` starts a new session (here or in a directory you type), opens an existing session, or deletes the current session and starts fresh.

## Why

Pi's session handling has three gaps this plugin fills:

- **Compaction drifts.** Pi's default compaction summarizes only the turn prefix, so in long multi-topic conversations it anchors on the first request and the model confabulates follow-ups that were never asked. The hybrid summary covers the whole conversation, keeps the latest meaningful user message and current task lossless, and adds a trust hierarchy so the model recalls rather than reconstructs.
- **Sessions are nameless and unmanageable.** Pi gives sessions auto-generated filenames and has no single command to start one in a chosen directory or delete the current one. Auto-rename gives every session a `main topic: latest context` title; `/open` is a unified launcher for new / switch / delete.
- **Recall needs a second install.** pi-vcc's `vcc_recall` tool is what makes compressed content recoverable, but installing pi-vcc separately would double-register the tool. This plugin vendors pi-vcc and registers it directly.

## How it works

### Hybrid compaction

On `session_before_compact`, the plugin calls the chat's own model to summarize the whole conversation (the messages being compacted plus the recent raw window pi keeps verbatim). The output is a structured summary with ordered sections — critical state first, expendable "Done" history last — so a truncation hits history, not active work.

- **Lossless anchors.** The latest *meaningful* user message (bare continuations like "continue" / "ok" are skipped, looking back up to 5 user messages) and the current task are never compressed.
- **Bounded length.** Every other section has a hard per-item ceiling (defaults in Configuration); overflow and superseded detail are demoted to verbatim **Recall Keys**. `compaction.maxTokens` is only a runaway backstop, not a length target.
- **Trust hierarchy.** The summary tells the model to prefer raw messages for recent content, `vcc_recall` (with `scope: "all"`, since pre-compaction content is off the current branch) for older detail, and its own memory only as a last resort.
- **Fallback.** If the LLM call fails, it runs pi-vcc's algorithmic `compile()`; if that's unavailable (submodule not checked out), it throws — pi's default behavior.

The full section list, the re-compress / overflow / contradiction rules, and the "Done = verifiable claim" rule live in the summary prompt ([src/prompts.ts](src/prompts.ts)).

### Auto-rename

After the first settled turn — and every `autoname.refreshTurns` turns after — it calls the model with a slice of user messages (first + up to 3 sampled from the middle + last 3, each capped at 500 chars) to produce a `main topic: latest context` title, set via `pi.setSessionName`. The model may answer `NO_CHANGE` to keep the current title, which is read from the session (authoritative across restarts).

- **`/rename`** runs the same pass on demand and reports the outcome (renamed / no change / nothing yet / no title produced). It works even when auto-rename is off.
- **`/autoname`** toggles the feature per session (`on` / `off` / `status`; no argument flips). State is stored as a per-session custom entry, so it survives restarts and `pi --resume`, is never sent to the LLM, and is still readable after compaction. While off, the footer shows `autoname: off`.

### pi-vcc integration

pi-vcc is vendored as a submodule and registered by calling its default export with the same `ExtensionAPI`, so `vcc_recall`, `/pi-vcc`, `/pi-vcc-recall`, and pi-vcc's own `session_before_compact` hook all work without a separate install.

The two before-compact hooks coexist because pi's runner keeps the **last non-null** result. This plugin registers its handler *before* pi-vcc, so:

- pi-vcc wins when it claims a compaction (explicit `/pi-vcc`, or `overrideDefaultCompaction: true` in its config);
- the hybrid summary applies otherwise;
- the hybrid handler mirrors pi-vcc's claim gate, so it never wastes an LLM call pi-vcc would discard.

This plugin's `postinstall` sets `overrideDefaultCompaction: false` in the vendored copy, so automatic compactions use the hybrid summary while `/pi-vcc` still does manual algorithmic compaction. pi-vcc's own settings live in `~/.pi/agent/pi-vcc-config.json` (override with `PI_VCC_CONFIG_PATH`). Don't also install pi-vcc as a separate pi package — the `vcc_recall` tool would register twice.

### `/open` — session launcher

`/open` is one entry point for session operations. It picks an action, asks **delete the old session?** (so you know what's coming), then acts:

- **New session here** — new chat in the current directory (like pi's `/new`).
- **New session in…** — new chat in a directory you type (live directory autocomplete in the TUI). The session file is created there and the runtime switches via `ctx.switchSession` with `cwdOverride`.
- **Open a session** — switch to an existing session, listed grouped by working directory (current directory first, newest first). Each row shows its id + date (toggle with `i`); empty sessions are dimmed. Press `d` to delete a listed session inline (y/n confirm).

The actual file removal happens in the post-switch `withSession` callback, after the new session is live. **Esc cancels the whole flow** at any step (action picker, path input, list, or delete prompt) — it's never "No, keep it"; the delete prompt has an explicit "No, keep it" for that.

**Empty sessions.** A session is "empty" when it has no user/assistant messages. Pi only writes a file once such a message exists, but the "new in directory" flow writes a header-only file up front (so the switch can derive the cwd). Empty sessions skip the delete prompt, and a `session_shutdown` cleanup removes any header-only file so throwaway sessions leave no trace on disk.

**Arguments:** `/open` (picker) · `/open new` or `/open here` (new here) · `/open open` (open existing) · `/open new <path>` (new in `<path>`).

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

## File layout

```
pi-context-plugin/
├── src/
│   ├── index.ts          # entry point, registers all features (order matters)
│   ├── compaction.ts     # hybrid compaction handler
│   ├── auto-rename.ts    # session auto-rename handler + /rename command
│   ├── autoname-toggle.ts  # /autoname command + per-session on/off state
│   ├── open-session/     # /open: session launcher (new here / new in dir / open existing / delete+new)
│   │   ├── index.ts      #   re-exports the command + empty-session cleanup
│   │   ├── command.ts    #   /open command + empty-session session_shutdown cleanup
│   │   ├── pickers.ts    #   action / path / session / delete pickers
│   │   ├── scan.ts       #   session scanning, grouping, date formatting
│   │   └── ui.ts         #   GroupedList, Panel, WithHeader
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
