---
description: Fan out one Grok call across several parallel subagents (multi-angle analysis), then synthesize one consolidated answer
argument-hint: '[--personas a,b,c | --agents-json <json>] [--model <model>] [--no-web-fetch] [--write] [--timeout <duration>] <task>'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

Run a single Grok call that dispatches several subagents **in parallel** — each analyzing the task from a different specialty angle — and returns one synthesized, consolidated answer. This is the "use Grok in many directions in one shot" command: more coverage and depth per call than a plain `/grok:ask`.

How it works:
- **Default**: Grok dispatches built-in personas via its `task` tool — `researcher`, `reviewer`, `security-auditor`, `test-writer` — each analyzing the task independently, then Grok synthesizes their findings.
- **`--personas a,b,c`**: pick a subset of built-in personas (`researcher`, `reviewer`, `security-auditor`, `test-writer`, `implementer`, `design-doc-writer`, `design-doc-reviewer`).
- **`--agents-json '<json>'`**: supply custom inline subagent definitions as a JSON array (advanced). Each object needs a `name`; the plugin validates a safety envelope and passes the rest through to `grok --agents`.
- Read-only by default (the subagents analyze, they don't edit). **`--write`** opens it up for change-making fan-outs and requires `GROK_PLUGIN_ALLOW_WRITE=1` in the environment.
- Web-fetch grounding is **on** by default (pass `--no-web-fetch` to opt out).

Raw user input:
`$ARGUMENTS`

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/companion.mjs" fan-out "$ARGUMENTS"
```

Output rules:
- Return the companion's stdout verbatim — it is Grok's consolidated, multi-angle report. Do not paraphrase or re-summarize.
- If stderr contains a `[hint: ...]` line about auth, surface it and suggest `/grok:setup`.
- If `$ARGUMENTS` is empty, ask the user what they want Grok to analyze instead of running the command.
- Fan-out spawns several child sessions, so it costs more tokens and runs longer than `/grok:ask`. Prefer it for substantial, multi-faceted tasks (audits, design reviews, "find everything wrong with X").
