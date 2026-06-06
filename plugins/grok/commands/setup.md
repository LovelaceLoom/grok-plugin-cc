---
description: Check whether the local Grok CLI is ready and optionally toggle the stop-time review gate
argument-hint: '[--enable-review-gate|--disable-review-gate] [--json]'
allowed-tools: Bash(node:*), Bash(curl:*), AskUserQuestion
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/companion.mjs" setup --json "$ARGUMENTS"
```

If the result says Grok is unavailable:
- Use `AskUserQuestion` exactly once to ask whether Claude should install Grok now.
- Put the install option first and suffix it with `(Recommended)`.
- Use these two options:
  - `Install Grok CLI (Recommended)`
  - `Skip for now`
- If the user chooses install, run:

```bash
curl -fsSL https://x.ai/cli/install.sh | bash
```

- Then rerun:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/companion.mjs" setup --json "$ARGUMENTS"
```

If Grok is already installed:
- Do not ask about installation.

If Grok is installed but not authenticated, the JSON `nextSteps` will spell out the two options. Present them to the user verbatim. The two valid options are:

1. Run `!grok login` and complete the browser OAuth flow.
2. Set `XAI_API_KEY` (get a key from https://console.x.ai) — either inline (`export XAI_API_KEY=...`) or in `~/.claude/settings.json` under `env`. (The legacy `GROK_CODE_XAI_API_KEY` still works as a fallback.)

Output rules:
- Present the parsed setup output as a short status block to the user.
- If `actionsTaken` is non-empty (review gate was toggled, or a fallback model was persisted), surface that.
- If `nextSteps` is non-empty, surface it.
- If `ready: true` and no actions/steps, just confirm success.
- If `capabilities.ok` is false, surface the missing flags and recommend `grok update`.
