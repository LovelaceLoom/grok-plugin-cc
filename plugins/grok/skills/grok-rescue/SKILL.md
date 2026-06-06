---
name: grok-rescue
description: Delegate a long-form coding task, root-cause investigation, multi-file refactor, or open-ended fix to xAI Grok via the companion's `task` subcommand. Use when the work is too large or specialized to handle inline and benefits from Grok's distinct training (live web search, code-focused models, 512K context).
---

# Grok — Rescue (Long-Form Delegated Task)

Use this skill to hand off a substantial, open-ended task to Grok. The companion runs Grok in its full agentic mode (file reads/writes optionally enabled, web search, multi-turn reasoning) and streams the result back.

In Claude Code this skill is invoked via the `grok:grok-rescue` subagent for isolation. In Codex CLI (and inline in Claude Code when no subagent is available), invoke the companion directly.

## When to use

- The task is **substantial**: requires reading multiple files, planning across boundaries, or running for several minutes.
- You'd want a second implementation pass from a different model family.
- The work is **research-shaped + code-shaped**: e.g., "investigate this regression and propose a fix", "audit this module for security issues", "find a root cause for the failing test".
- The user explicitly says "ask grok to do this" / "delegate to grok" / "let grok handle this".

Do **not** use this skill for:
- One-off questions → `grok-ask`.
- Pure research (no code touch) → `grok-research`.
- Image generation → `grok-imagine`.
- Trivial tasks you can complete inline in under a minute.

## How to invoke

Run **exactly one** bash command. Default to read-only:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/companion.mjs" task "<the user's full task description, properly quoted>"
```

### Write mode (the model edits files)

Only add `--write` if the user **explicitly** asked for code changes. Write mode requires `GROK_PLUGIN_ALLOW_WRITE=1` in the environment as a safety gate:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/companion.mjs" task --write "<task>"
```

If the env var is missing the helper exits with code 2 and a `[hint:]` message. Surface the refusal verbatim and let the user decide whether to enable write mode.

### Common flags (forwarded to companion)

- `--model <name>` — only if user explicitly named one.
- `--effort <low|medium|high|xhigh|max>` — only if user explicitly chose one.
- `--session-id <id>` — resume a specific session.
- `--resume=<id>` — resume by id (note: requires `=`, not space).
- `--continue` — continue the most-recent session for cwd.
- `--timeout <duration>` — default unbounded for rescue work. `300s`, `5m`, `1h`, `0`.

### Background mode (Claude Code only)

In Claude Code, `--background` can run rescue via a background subagent. In Codex CLI there is currently no equivalent — strip `--background` and run foreground.

## Output rules

- Return the companion's stdout **verbatim**. Do not paraphrase, summarize, or add commentary before or after.
- Do not inspect files, monitor progress, poll status, fetch results, cancel jobs, or do follow-up work of your own — this skill is a **forwarder**.
- If the helper reports Grok is missing or unauthenticated, surface the message and direct the user to run `grok login` or set `XAI_API_KEY`.
- On timeout (exit 124), surface the timeout to the user rather than retrying with a longer window.
