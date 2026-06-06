---
name: grok-research
description: Deep research with xAI Grok using effort=max, live web search, and Grok's self-verification --check loop. Use when the user wants a thorough investigation of a topic, recent events, or claims that need source-grounding. Returns Grok's research output verbatim.
---

# Grok — Deep Research

Use this skill for non-trivial investigation tasks that benefit from Grok's full reasoning + verification stack. The companion sets sane research defaults:

- `--effort max` — Grok's highest reasoning effort.
- Web search **enabled** by default — Grok queries the live web during reasoning.
- `--check` **enabled** by default — Grok appends a self-verification loop and revises its own answer.

Override any of these with the flags below if the user explicitly asks for a cheaper / faster / web-less run.

## When to use

- The user asks "research…", "investigate…", "find out…", "what's the current state of…", "is X still true as of <date>".
- Claims need verification against live sources.
- The task is research-shaped, not code-shaped (for coding tasks → `grok-rescue`).

Do **not** use this skill for:
- One-off questions or quick lookups → `grok-ask`.
- Long-form coding / fixing / refactoring → `grok-rescue`.
- Image generation → `grok-imagine`.

## How to invoke

Run **exactly one** bash command:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/companion.mjs" research "<the user's research question, properly quoted>"
```

`CLAUDE_PLUGIN_ROOT` is set by both Claude Code and Codex CLI.

### Common flags

- `--model <name>` — override default Grok model.
- `--effort <low|medium|high|xhigh|max>` — override the default `max`. Use `high` or lower for cheaper runs.
- `--no-check` — disable the self-verification loop (faster, less rigorous).
- `--no-web-search` — disable live web search (rare; usually leave on).
- `--timeout <duration>` — `0` for unbounded (default). `5m`, `30m`, etc.

## Output rules

- Return the companion's stdout **verbatim**. Grok's research includes citations and reasoning — preserve them.
- If stderr contains a `[hint: ...]` line about auth, surface it and direct the user to `grok login` / `XAI_API_KEY`.
- Do not editorialize on Grok's findings unless the user explicitly asks for your take.
