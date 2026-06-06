---
description: Analyze a task from several expert angles in one Grok call, then synthesize one consolidated answer
argument-hint: '[--personas a,b,c | --agents-json <json>] [--model <model>] [--no-web-fetch] [--write] [--timeout <duration>] <task>'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

Fan a task out across several **parallel** Grok calls — one per expert angle — then run a synthesis call that reconciles them into one consolidated answer (a section per angle plus a `## Consolidated verdict`). This is the "use Grok in many directions in one shot" command: it makes N+1 real Grok calls (the angles run concurrently), so it covers far more ground and depth than a plain `/grok:ask`.

How it works:
- **Default angles**: `researcher`, `reviewer`, `security-auditor`, `test-writer`. Grok analyzes the task as each specialist would, then synthesizes the findings.
- **`--personas a,b,c`**: pick a subset of built-in angle names (`researcher`, `reviewer`, `security-auditor`, `test-writer`, `implementer`, `design-doc-writer`, `design-doc-reviewer`).
- **`--agents-json '<json>'`**: name custom angles via a JSON array (advanced). Each object needs a `name`; the plugin validates a safety envelope and uses the names as analysis lenses.
- Read-only by default. **`--write`** opens it up for change-making runs and requires `GROK_PLUGIN_ALLOW_WRITE=1` in the environment.
- Web-fetch grounding is **on** by default (pass `--no-web-fetch` to opt out).

Note: the plugin orchestrates the parallelism itself (separate `grok -p` calls), rather than relying on Grok's internal subagent dispatch — that proved unreliable headless. So each angle is a genuine independent Grok analysis, and they run at the same time.

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
