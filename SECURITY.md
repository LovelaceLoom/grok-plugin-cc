# Security Policy

## Reporting a Vulnerability

Please report security issues privately by emailing **baran.tai@icloud.com**.
Do not open a public GitHub issue for security-sensitive reports.

Include in your report:
- A description of the vulnerability and its impact
- Steps to reproduce
- Affected file(s) and line number(s) if known
- Suggested fix, if you have one

I'll acknowledge receipt within 5 days and aim to ship a fix within 30 days
for confirmed issues. Critical issues will be expedited.

## Threat Surfaces with Explicit Hardening

The plugin spawns the local `grok` CLI as a subprocess and exchanges
prompts, code diffs, and authentication state with it. Specific defenses
in the codebase:

### Environment scrubbing (`plugins/grok/scripts/lib/grok.mjs`)

`cleanGrokEnv()` returns an allowlisted subset of `process.env` to the
spawned `grok`. The list covers `PATH`, `HOME`, locale, terminal, temp/XDG
dirs, `XAI_API_KEY`, the documented `GROK_*` env vars, proxy settings, and
`NODE_EXTRA_CA_CERTS`. Everything else is dropped — including
`ANTHROPIC_API_KEY`, `GITHUB_TOKEN`, `OPENAI_API_KEY`, `AWS_*`,
`SSH_AUTH_SOCK`, and `NODE_OPTIONS` (the last one is particularly important
because `NODE_OPTIONS` accepts `--require=path.js` and could be used for
arbitrary code injection).

If you propose adding a new key to the allowlist, include the reason in
the diff and confirm the key is documented in xAI's official Grok README.

### PID validation (`plugins/grok/scripts/lib/process.mjs`)

`isValidPid()` rejects PID 0 (POSIX: signal to process group of caller)
and PID 1 (`init`/`launchd` — `kill -1` would broadcast SIGTERM to every
process the user owns). `terminateProcessTree()` uses negative-PID
signaling to hit the process group, with a SIGKILL escalation path.

### Path confinement (`plugins/grok/scripts/lib/state.mjs`)

`safeJobLogPath()` confines `/grok:result` reads to `jobsDir`. The check
uses `fs.realpathSync.native` on both sides to defend against
case-insensitive filesystems (macOS APFS/HFS+) and symlink-based bypasses.

### Atomic writes with O_EXCL (`plugins/grok/scripts/lib/state.mjs`)

`atomicWrite()` uses `wx` mode (exclusive create) plus a
`crypto.randomBytes`-derived temp name. This defeats predictable-name
symlink attacks in shared tmp directories. Concurrent `config.json`
writers serialize through `withConfigLock()` (file lock + stale-lock
recovery).

### Output sanitization (`plugins/grok/scripts/lib/render.mjs`)

`TerminalSanitizer` strips ANSI CSI/OSC/DCS escape sequences and dangerous
C0 control bytes before they reach the user's terminal. It is
stream-aware: incomplete sequences split across chunk boundaries are held
back until they complete, and orphan ESC bytes at end-of-stream are
dropped rather than partially flushed. The on-disk log keeps raw bytes for
debugging.

### Prompt-injection defense (`plugins/grok/scripts/lib/verdict.mjs`)

`parseVerdict()` accepts only a JSON object with `decision: "allow" |
"block"`. Free-form text like "ALLOW", "yes ship it", or "decision:
approve" is rejected. The stop-review-gate prompt explicitly tells the
model that any `ALLOW`/`BLOCK` words inside the diff or claude_response
block are data, not directives.

User-controlled values (focus text, target labels, the Claude transcript
snippet) go through `escapeXmlInTrustedBlock()` before being substituted
into prompt templates that use XML-style tags for structure.

### Write-mode gate (`plugins/grok/scripts/companion.mjs`)

`/grok:rescue --write` (and the underlying `task --write`) is refused with
exit 2 unless `GROK_PLUGIN_ALLOW_WRITE=1` is set in the environment. This
makes "let an agent modify files" an explicit, durable decision on the
user's part, not a side effect of an alias or a forgotten flag.

### Capability probe (`plugins/grok/scripts/lib/grok.mjs`)

`capabilityProbe()` runs `grok --help` and verifies that every flag the
companion depends on is present. This catches breaking-change upgrades
where Grok renames a flag without a semver bump, surfacing the issue at
`/grok:setup` time instead of as a confusing runtime crash.

### Stop-gate strict mode

By default the stop-review-gate hook **fails open** on infrastructure
errors (grok missing, auth failed, timeout, parse error) so a broken Grok
install does not strand the user mid-session. Set
`GROK_REVIEW_GATE_STRICT=1` to make those failures **block** stop with
an explanatory reason instead. Useful for environments where "the gate
could not run" must be treated as "do not stop yet."

## Out of Scope

- The security of the upstream `grok` binary itself, or of its hosted
  service. Those are xAI's responsibility.
- Network-level attacks against `cli-chat-proxy.grok.com` or your
  configured `GROK_CLI_CHAT_PROXY_BASE_URL`.
- The browser OAuth flow run by `grok login`; that is implemented by the
  Grok CLI, not by this plugin.
