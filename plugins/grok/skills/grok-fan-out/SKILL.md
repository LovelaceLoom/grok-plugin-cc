---
name: grok-fan-out
description: Run a multi-angle Grok analysis in a single call — Grok analyzes the task from several expert angles (security, review, research, tests) and synthesizes one consolidated answer with a section per angle plus a verdict. Use when the user wants a thorough, multi-perspective audit/review/analysis of something ("find everything wrong with…", "review this from all angles", "deep multi-angle look at…") that benefits from more coverage than a single-shot question. Read-only by default.
---

# Grok — Fan-Out (Multi-Angle Analysis)

Use this skill when one angle isn't enough — when the user wants something looked at from **multiple specialties at once** (correctness, security, tests, architecture, research) and a single consolidated verdict. Grok sweeps each angle in one call and synthesizes them, so you get broad coverage and real depth from a single delegation (deeper than a plain `grok-ask`).

## When to use

- "Audit / review this from every angle", "find everything wrong with X", "do a thorough multi-perspective analysis".
- A question that genuinely spans specialties: e.g. "is this auth module correct, secure, and well-tested?".
- You want a deeper second opinion than `grok-ask` gives, without orchestrating multiple calls yourself.

Do **not** use this skill for:
- A simple one-off question → `grok-ask`.
- Pure source-grounded research on a topic → `grok-research`.
- Long-form coding / fixing / refactoring → `grok-rescue`.
- Image generation → `grok-imagine`.

## How to invoke

Run **exactly one** bash command. Default to read-only (the subagents analyze; they don't edit):

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/companion.mjs" fan-out "<the user's task, properly quoted>"
```

`CLAUDE_PLUGIN_ROOT` is set by both Claude Code and Codex CLI.

### Choosing the angles

- Default angles (no flag): `researcher`, `reviewer`, `security-auditor`, `test-writer`.
- `--personas a,b,c` — pick a subset of the built-in angle names (`researcher`, `reviewer`, `security-auditor`, `test-writer`, `implementer`, `design-doc-writer`, `design-doc-reviewer`). **Keep it to 3–4 angles** unless the user explicitly asks for more — each angle adds analysis depth (and tokens). The plugin caps the total.
- `--agents-json '<json array>'` — advanced: name custom angles via a JSON array (each object needs a `name`). Only use when the built-in angle names don't fit the task.

### Other flags

- `--write` — only if the user explicitly asked the fan-out to make changes. Requires `GROK_PLUGIN_ALLOW_WRITE=1` (the helper refuses otherwise — surface the refusal verbatim).
- `--no-web-fetch` — opt out of the default-on web_fetch grounding.
- `--model <name>` / `--timeout <duration>` — as for the other Grok commands.

## Output rules

- Return the companion's stdout **verbatim** — it is Grok's consolidated multi-angle report (per-angle sections + a consolidated verdict). Do not paraphrase or re-summarize.
- If stderr contains a `[hint: ...]` line about auth, surface it and direct the user to `grok login` / `XAI_API_KEY`.
- Fan-out is heavier than a single ask: prefer it for substantial, multi-faceted tasks, and don't fan out trivial questions.
