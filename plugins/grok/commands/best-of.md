---
description: Spawn N parallel code-task sub-agents in worktrees and apply the winner's diff (code/file-change tasks only)
argument-hint: '<N> [--model <model>] [--effort <low|medium|high|xhigh|max>] [--check] [--no-web-search] [--timeout <duration>] <prompt>'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

Wraps Grok's native `--best-of-n N` flag. Grok spawns N parallel sub-agents in isolated git worktrees, evaluates them on **Correctness · Code Quality · Safety**, and applies the winner's diff back to the workspace.

## When to use

**Code / file-change tasks only.** This is grok's `/best-of-n` skill — its evaluator scores worktree changes, not response text. Examples that fit:
- "Refactor src/auth/middleware.ts to use the new session API"
- "Add a unit test for the rate-limit hook"
- "Fix the off-by-one in pagination.ts and add a regression test"

## When NOT to use (and what to use instead)

- **Research / market analysis / summarization** → use `/grok:research` (single-call with `--effort max` + `--check` self-verification + web search)
- **General question / quick answer** → use `/grok:ask`
- **Multi-LLM consensus / code review** → use `/grok:aggregate-review`

For text-only prompts, `--best-of-n` returns an evaluation table of worktree-diff candidates (often empty diffs, so essentially empty stdout). The reporter of [issue #8](https://github.com/LovelaceLoom/grok-plugin-cc/issues/8) hit this: a research prompt with `--best-of-n=3` returned 1 byte (just a newline) while the same prompt without `--best-of-n` returned 8.5KB of structured output.

## Cost

Each of the N branches is a full token-spend, so `best-of 5` costs ~5× a regular `/grok:ask`. The plugin caps N at 8.

## Argument shapes

- `/grok:best-of 5 <code task prompt>`
- `/grok:best-of --best-of-n 5 <code task prompt>`

Combine with `--effort max` for the highest-quality runs, or `--check` to add per-branch self-verification.

Raw user input:
`$ARGUMENTS`

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/companion.mjs" best-of "$ARGUMENTS"
```

Output rules:
- Return the companion's stdout verbatim.
- If `$ARGUMENTS` is empty, ask the user for N and a code-task prompt instead of running.
- A `[grok-plugin]` stderr banner reminds the caller that `--best-of-n` is code-task-only. This is informational, not an error — surface it only if the user asks about it.
