---
description: Deep research with Grok (effort=max, --check self-verification, web search enabled)
argument-hint: '[--model <model>] [--stream] [--no-check] [--no-web-search] [--no-web-fetch] [--timeout <duration>] <question>'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

Forward the user's research question to Grok in deep-research mode and return the answer verbatim.

This command exists to exploit Grok's distinctive strengths:
- **Live web search** is on by default (pass `--no-web-search` to turn it off).
- **web_fetch** is on by default (v1.2.0) — Grok can fetch a specific URL, not just search (pass `--no-web-fetch` to turn it off).
- **`--effort max`** is requested by default but only applies on models that support reasoning effort; the current default `grok-build` does not, so it is stripped with a warning. (No action needed — web search + `--check` do the heavy lifting.)
- **`--check`** is on by default — Grok appends a self-verification loop to its own answer (pass `--no-check` to turn it off).
- **`--stream`** (v1.2.0) streams the answer live as Grok produces it (uses `--output-format streaming-json`) — useful for long runs where you'd otherwise wait minutes for the buffered result.

Raw user input:
`$ARGUMENTS`

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/companion.mjs" research "$ARGUMENTS"
```

Output rules:
- Return the companion's stdout verbatim. Do not paraphrase or summarize.
- If stderr contains a `[hint: ...]` line about auth, also surface that hint and suggest `/grok:setup`.
- If `$ARGUMENTS` is empty, ask the user what they want Grok to research instead of running the command.
