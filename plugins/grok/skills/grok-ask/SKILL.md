---
name: grok-ask
description: Ask xAI Grok a one-off question with optional live web search. Use when the user wants Grok's opinion or a quick answer that benefits from Grok's distinct training (recent web/X awareness, code-focused models). Read-only by default. Returns Grok's stdout verbatim.
---

# Grok — Ask

Use this skill when the user asks Grok a question directly, or when you need a second opinion / cross-check from a different model than the one you're running in. The companion script wraps the local `grok` CLI with environment scrubbing, ANSI sanitization, capability probing, and prompt-injection defenses.

## When to use

- The user explicitly asks "ask grok…", "what would grok say about…", "double-check this with grok".
- You want a second perspective from a model with different training (xAI vs OpenAI/Anthropic).
- The question benefits from Grok's strengths: live web/X search awareness, code-focused models, current events.

Do **not** use this skill for:
- Long-form rescue / multi-step delegation → use the `grok-rescue` skill instead.
- Image generation → use `grok-imagine`.
- Deep research that benefits from `--effort max + --check` self-verification → use `grok-research`.

## How to invoke

Run **exactly one** bash command:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/companion.mjs" ask "<the user's question, properly quoted>"
```

The `CLAUDE_PLUGIN_ROOT` env var is set by both Claude Code and Codex CLI. The companion accepts the full argument string and parses its own flags.

### Common flags (append to the argument string before the question)

- `--model <name>` — override default Grok model. Available models (run `/grok:models`): `grok-build` (default), `grok-composer-2.5-fast`.
- `--effort <low|medium|high|xhigh|max>` — reasoning effort. **Note:** the current default model (`grok-build`) declares no reasoning-effort support, so the companion silently strips `--effort` (with a stderr warning) to avoid a 400 from upstream. It only takes effect on a model that advertises `supports_reasoning_effort`.
- `--timeout <duration>` — e.g., `90s`, `5m`, `0` to disable. Default unbounded.
- `--no-web-search` — disable Grok's live web search (on by default).
- `--check` — append Grok's self-verification loop to the answer.
- `--rules <text|@file>` — extra system rules.
- `--sandbox <profile>` — restrict tool/filesystem access.

## Output rules

- Return the companion's stdout **verbatim**. Do not paraphrase, summarize, or wrap in additional commentary.
- If stderr contains a `[hint: ...]` line about authentication, surface it and tell the user to run `grok login` or set `XAI_API_KEY`.
- If the user's request is ambiguous about what to ask Grok, clarify with the user *before* invoking — do not ask Grok yourself.
