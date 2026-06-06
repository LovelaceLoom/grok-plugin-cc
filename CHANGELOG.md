# Changelog

All notable changes to **grok-plugin-cc** are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.2.0] - 2026-06-06

**Tracks the xAI Grok CLI 0.2.22 surface, fixes a silent API-key auth break, and
adds a fan-out primitive plus grounding/context levers so Claude can pull more
power out of Grok per call.**

### Fixed (critical)

- **Every read-only command (`/grok:ask`, `/grok:review`, `/grok:research`)
  was broken on Grok CLI 0.2.22** — `grok -p` failed at agent build with
  "Requirements unsatisfied". On 0.2.22 the agent builder auto-includes the
  subagent-control tools (`get_task_output` / `wait_tasks` / `kill_task`)
  whenever subagents are enabled, and those tools require a background-capable
  bash tool (`run_terminal_cmd`). Read-only mode strips `run_terminal_cmd`, so
  leaving subagents (`Agent`) enabled made the whole agent build fail. Fix:
  `Agent` is now in `READ_ONLY_DISALLOWED_TOOLS` — read-only commands are
  single-shot and don't need subagents; web grounding is unaffected.
  (This was caught by real end-to-end verification; a static audit missed it.)

### Added

- **`/grok:fan-out` + the `grok-fan-out` skill — multi-angle analysis in one
  call.** One Grok agent analyzes the task from several expert angles in turn
  (default: `researcher`, `reviewer`, `security-auditor`, `test-writer`) and
  synthesizes a single consolidated report with a section per angle plus a
  consolidated verdict — deeper coverage than a plain `/grok:ask`. Read-only by
  default; `--write` is gated by `GROK_PLUGIN_ALLOW_WRITE=1`. Pick angles with
  `--personas a,b,c`, or name custom angles with `--agents-json '<json>'`
  (validated: count cap, name sanity, recursive control-byte scrub, depth cap,
  ARG_MAX size cap). NOTE: this does not spawn parallel `task`-tool subagents —
  that proved unreliable headless (a subagent's denied tool call cancels the
  turn → empty output); a single multi-angle pass always returns text. True
  plugin-orchestrated parallel fan-out is a possible future enhancement.
- **web_fetch grounding ON by default** for `/grok:research`, `/grok:ask`, and
  `/grok:fan-out` (`GROK_WEB_FETCH=1`) — Grok can fetch a pasted URL, not just
  search. Opt out with `--no-web-fetch`; a user-set `GROK_WEB_FETCH` or
  `--no-web-search` is respected. `cleanGrokEnv(parent, overrides)` applies
  allowlisted-only overrides.
- **`/grok:research --stream`** — live answer via `--output-format
  streaming-json` (`createStreamingJsonParser` + `runStreamingGrok`).
- **Context compaction passthrough** — `--compaction-mode` / `--compaction-detail`
  in `grokBaseArgs`; `/grok:research` defaults to `--compaction-mode segments`.

### Fixed

- **`XAI_API_KEY` was silently filtered by the env allowlist** (it is 0.2.22's
  documented API-key variable), so API-key / CI auth fell back to interactive
  OAuth and failed under `-p`. Added to the allowlist; `GROK_CODE_XAI_API_KEY`
  kept as a fallback. `detectAuthSource` / `classifyAuthBlob` and the setup /
  skill hints now recognise it.
- **`GROK_TELEMETRY_ENABLED`** replaces the non-existent `GROK_DISABLE_TELEMETRY`
  in the allowlist.
- **`authProbe`** parses via the hardened `parseGrokJson` (not a bare
  `JSON.parse`), so a stray Rust tracing line around the envelope no longer
  reports an authenticated account as "probe failed".
- **`parseGrokJson`** reconstructs `streaming-json` (NDJSON) instead of
  degrading to `unknown`.
- **Docs:** `grok-ask` advertised non-existent model ids (`grok-4`,
  `grok-code-fast-1`); corrected to the real catalog (`grok-build`,
  `grok-composer-2.5-fast`). `--effort` hints now state that `grok-build`
  declares no reasoning-effort support, so it is stripped with a warning.

### Changed

- `capabilityProbe`'s required-flag list is now the exported
  `CAPABILITY_REQUIRED_FLAGS`, and includes `--agents` and `--prompt-json`.
- New flags in `lib/args.mjs`: `no-web-fetch`, `stream`, `personas`,
  `agents-json`, `compaction-mode`, `compaction-detail`.

## [1.1.0] - 2026-05-18

**Codex CLI support — the plugin now installs in both Claude Code and OpenAI's
Codex CLI from a single repo.** No changes to `companion.mjs` were needed:
Codex sets `CLAUDE_PLUGIN_ROOT` for backward-compatibility with CC's plugin
contract, so the existing commands/agents/hooks layout already runs inside
Codex. v1.1.0 ships the manifest and skill metadata that make the plugin
**discoverable** by Codex's marketplace + skill router.

### Added

- **`plugins/grok/.codex-plugin/plugin.json`** — native Codex plugin manifest
  with `interface` block (displayName, category, capabilities, defaultPrompt)
  so Codex's UI surfaces the plugin properly. The CC manifest at
  `plugins/grok/.claude-plugin/plugin.json` is unchanged and remains the
  source of truth for CC installs.
- **`.agents/plugins/marketplace.json`** — Codex marketplace manifest at the
  repo root. Users install with:
  ```
  codex plugin marketplace add taibaran/grok-plugin-cc
  ```
  or for a local checkout:
  ```
  codex plugin marketplace add /path/to/grok-plugin-cc
  ```
  The existing `.claude-plugin/marketplace.json` continues to serve CC
  installs via `/plugin marketplace add taibaran/grok-plugin-cc`.
- **Four user-facing skills** under `plugins/grok/skills/`, each with a model-
  oriented `description:` that lets Codex's (and CC's) router auto-invoke
  them at the right time. All four shell out to the same `companion.mjs`:
  - `grok-ask/SKILL.md` — one-off questions with optional live web search.
  - `grok-research/SKILL.md` — deep research (effort=max + web search + `--check`).
  - `grok-imagine/SKILL.md` — image generation via Grok Imagine.
  - `grok-rescue/SKILL.md` — long-form delegated tasks (read-only by default;
    `--write` gated by `GROK_PLUGIN_ALLOW_WRITE=1`).
- **README** Codex install section with the exact `codex plugin marketplace add`
  command and a comparison table of what's exposed where (slash commands in
  CC vs. model-invoked skills in Codex).

### Notes

- Existing CC users keep the full slash-command surface (`/grok:ask`,
  `/grok:research`, `/grok:imagine`, `/grok:rescue`, `/grok:review`, etc.).
  Slash commands are CC-specific; Codex users get equivalent functionality
  via the auto-invoked skills above.
- The internal-only skills (`grok-cli-runtime`, `grok-prompting`,
  `grok-result-handling`) remain `user-invocable: false` and are used by
  the `grok-rescue` subagent in CC. They are inert in Codex (no subagents),
  which is harmless.
- No behavior change to `companion.mjs`, hooks, or the existing slash
  commands. v1.0.6 fixes carry forward.

## [1.0.6] - 2026-05-16

Two-part patch for issue #10 (eyalRonen1): `companion.mjs task`
returned "completed exit 0" with empty stdout+stderr log files,
breaking the `grok-rescue` subagent. Triaged with codex + gemini
in parallel; both confirmed the same diagnostic-gate bug AND
identified a related cross-plugin state-dir collision.

### Fixed

- **runJob diagnostic-gate bug**: in v1.0.1 we shipped
  `diagnoseEmptySpawnFailure` to surface silent failures. v1.0.5
  tightened the check to `isWhitespaceOnly(stdout) && isWhitespace
  Only(stderr)`. But the call site inside `runJob`'s close handler
  was nested inside `(code !== 0 || grokInternalError)`. **Exit 0
  with empty output AND no parseable JSON error envelope fell into
  the `else` branch (status=completed), and the diagnostic was
  silently skipped.** Reporter's `companion.mjs task` showed
  "Job xxx completed (exit 0)" with 0-byte logs — they had no way
  to know what went wrong.
  - **Fix**: `runJob` now sets `meta.no_output = true` whenever
    both buffers are whitespace-only on close. A new
    `else if (meta.no_output && status !== "cancelled")` branch
    after the existing error gate fires the diagnostic on exit 0
    too.
  - `cmdResult` now also surfaces a warning when `meta.no_output`
    is true, so users who discover the empty output later via
    `/grok:result` get the same recovery hints (mentions `/grok:
    rescue --write` for tool-using tasks, `/grok:setup` for broken
    binary, and the issue-#9/#10 upstream silent-abort pattern).
  - The job status itself stays `completed` for exit 0 — `no_output`
    is the structured signal, not a status change. Downstream
    subagents (`grok-rescue`, `grok-aggregate-review`) can route on
    `meta.no_output` to retry or fall back rather than relying on
    text-matching the diagnostic.

- **Cross-plugin state-dir collision**: the reporter's grok job
  state landed under `~/.claude/plugins/data/codex-openai-codex/
  state/...`. Root cause: Claude Code's harness sets
  `CLAUDE_PLUGIN_DATA` to the calling plugin's data dir, which is
  inherited by child processes. When grok-plugin-cc is invoked
  from a parent subagent of a DIFFERENT plugin (e.g. codex-rescue
  delegating to grok-rescue), our `state.mjs` saw the parent's
  data dir and wrote our state into their namespace. Not strictly
  a bug in our code, but a real surprise for operators auditing
  data dirs.
  - **Fix**: `stateDir()` now prefixes the env-backed base with
    `grok-plugin-cc/`, mirroring the `/tmp/grok-plugin-cc/`
    namespace baked into `FALLBACK_STATE_ROOT`. Paths become
    `$CLAUDE_PLUGIN_DATA/grok-plugin-cc/state/<slug>-<hash>/`
    regardless of which plugin owns the env-set base dir.
  - **Back-compat note**: pre-v1.0.6 job state at
    `$CLAUDE_PLUGIN_DATA/state/<slug>-<hash>/` becomes inaccessible
    after upgrade. Job logs are ephemeral (pruned at `MAX_JOBS=50`),
    configs are recreated by `/grok:setup`. Acceptable for a patch
    release; users can manually move old state if they want
    historical jobs preserved.

### Investigated but NOT changed

- Codex's secondary hypothesis was that `--permission-mode plan`
  (set by `cmdTask` for read-only mode) suppresses tool execution
  in headless `-p` mode, leading to empty output for prompts that
  need `web_search`. **A/B test refuted this**: both `--permission-
  mode plan` and `--permission-mode default` produced legitimate
  output (real weather data via web_search) for the same prompt.
  `cmdTask`'s default permission-mode stays `plan` for read-only.
  The reporter's specific case is probably the same upstream
  silent-abort pattern as issue #9 (prompt content containing
  tool-error-like text confusing the model).

### Tests

- 10 new behavioral tests in `tests/v1-0-6-issue-10.test.mjs`:
  - `stateDir` / `jobsDir` namespacing under `grok-plugin-cc/`.
  - Fallback path (no env) still works.
  - `/grok:task` with exit 0 + empty output triggers diagnostic
    (the actual issue-#10 case).
  - `/grok:task` with exit 1 + empty output still triggers (regression
    guard for the pre-v1.0.6 behavior).
  - `meta.no_output = true` is persisted to disk on the empty case.
  - `/grok:result` surfaces the warning when reading a `no_output`
    job, with `--write` hint.
  - Source-grep guards on all three code-level invariants.
- One v0.4.0 test (B5 cmdResult source-grep) had its slice size
  bumped from 2500 → 5000 chars because the cmdResult function grew
  with the new `no_output` warning block.
- Total: 396 tests (391 passing + 5 integration skipped).

### Credit

Thanks to @eyalRonen1 for the detailed repro, including the smoking-
gun observation about `codex-openai-codex/state/...` paths — that's
what made the cross-plugin namespace collision obvious.

## [1.0.5] - 2026-05-16

Diagnostic-tightening patch driven by issue #9, filed by external
reviewer @eyalRonen1 while real-world-testing the v1.0.4 bash
workaround from issue #8 (the deferred `--aggregate-of-n` stand-in).
Triaged with the codex + gemini + grok multi-agent pipeline; **gemini
nailed the root-cause hypothesis** in the first pass.

### The bug

The reporter followed the recommended bash workaround:
1. Two parallel `grok --prompt-file research.txt --output-format=plain`
   calls → 8KB + 9KB of legitimate Hebrew research output ✓
2. Synthesis call: built `synth_prompt.txt` = header + sample_a +
   sample_b + "Now produce the consolidated response." (~18KB total)
3. `grok --prompt-file synth_prompt.txt --output-format=plain` →
   **1 byte** of output (just a newline), exit 0, empty stderr.

The plugin's v1.0.1 `diagnoseEmptySpawnFailure` was supposed to catch
this class of silent failure, but the check was `if (!r.stdout &&
!r.stderr)` — and `"\n"` is truthy in JS, so the 1-byte case slipped
past it. Same upstream behavior would also reach the plugin via
`/grok:research`, `/grok:ask`, and `/grok:imagine`, all of which hit
the same fallback branch without firing the diagnostic.

### Gemini's root-cause hypothesis

The bash workaround inadvertently performs **prompt injection by tool-
error patterns**: the parallel sample outputs contained `browser_tab
failed` / `execution_failure` text (Grok recovering from tool errors
via `web_search`), and those patterns LOOK LIKE grok's own internal
tool-call meta-syntax. When concatenated into the synthesis prompt,
the model's instruction parser likely treats them as live tool calls,
triggers an early stop sequence, and cleanly aborts.

A synthetic 28KB English test prompt with the same SAMPLE A / SAMPLE
B structure (but WITHOUT the embedded tool-error patterns) produced
815 bytes of legitimate synthesized output — confirming length isn't
the trigger; the pattern is.

### Fixed

- **companion.mjs `isWhitespaceOnly()`**: new helper. Treats `null`,
  `""`, and any string that trims to empty as "empty for diagnostic
  purposes".
- All three `diagnoseEmptySpawnFailure` call sites updated to use
  `isWhitespaceOnly(...) && isWhitespaceOnly(...)` instead of
  `!r.stdout && !r.stderr`:
  - `runHeadlessGrok` (used by `/grok:ask`, `/grok:research`,
    `/grok:models`, `/grok:best-of`, `/grok:inspect`)
  - `cmdImagine` (used by `/grok:imagine`, `/grok:imagine-video`)
  - `runJob` close handler (used by `/grok:rescue`, `/grok:task`,
    long-running `/grok:review`)
- Banner text expanded: in addition to the broken-binary recovery
  hints (kept from v1.0.1), it now mentions the issue-#9 upstream
  silent-abort path and points at the eventual `/grok:aggregate-of-n`
  v1.1.0 fix.

### Upstream

Submitted to xAI via grok's built-in `/feedback` channel with the
reproduction details and Gemini's hypothesis. Submission id:
`94e62200-3fa5-495c-bf4a-e18b107a0b34` (session
`019e30bc-0d61-77d0-8397-ba5e5be56ca2`). This is xAI's bug to fix
at the model / API layer — the plugin can only surface it to the
user, not prevent it.

### Why we didn't ship `--aggregate-of-n` here

Gemini argued for accelerating `--aggregate-of-n` to v1.0.5 (the
native version would wrap each sample in `<sample>...</sample>` blocks
and avoid the injection entirely). Decided to keep v1.0.5 small and
focused — semver-honest patch release — and ship `--aggregate-of-n`
in v1.1.0 as a real feature. Issue #9 stays open as the tracker for
that feature.

### Credit

Thanks to @eyalRonen1 for real-world-testing the v1.0.4 bash
workaround and surfacing both the upstream silent-abort path AND the
detector gap in our v1.0.1 fix.

### Tests

- 6 new behavioral tests in `tests/v1-0-5-issue-9.test.mjs`:
  - 1-byte newline triggers diagnostic via `/grok:ask` at both exit 0
    and exit 1.
  - Same triggering via `/grok:imagine` (cmdImagine path).
  - Same triggering via `/grok:research` (runHeadlessGrok path with
    subcommand label).
  - Banner mentions the upstream silent-abort + aggregate-of-n future.
  - Source-grep guard on `isWhitespaceOnly` + 3 call-site usages.
- One v1.0.1 test relaxed: banner phrasing changed from "possible bad
  auto-update" to "binary may be broken, OR ...synthesis...prompt..."
  — test now matches either form.
- Total: 386 tests (381 passing + 5 integration skipped).

## [1.0.4] - 2026-05-16

Security + correctness patch driven by a deep-research review of
v1.0.3 conducted by the codex + gemini + grok multi-agent pipeline.
Codex caught two real P0 regressions plus one P1 inconsistency that
the other two reviewers (and I) missed. Patched same day.

### Fixed

- **Codex P0-A — `--effort` gate bypass in `cmdReview` + `cmdImagine`.**
  v1.0.3 added the per-model `--effort` gate (`modelSupportsReasoning
  Effort`) but only enforced it inside `grokBaseArgs`. Two call sites
  appended `--effort` outside that helper:
  - `cmdReview` (companion.mjs ~line 838): called `grokBaseArgs`
    *without* `effort` and then `args.push("--effort", effort)` after.
  - `cmdImagine` (companion.mjs ~line 1049): doesn't use
    `grokBaseArgs` at all — hand-builds the argv including `--effort`.
  Both paths re-introduced the 4× 400 cascade on `grok-build` for
  `/grok:review --effort high`, `/grok:adversarial-review --effort high`,
  `/grok:imagine --effort high`, and `/grok:imagine-video --effort high`.
  **Fix**: new `effortFlagForModel({effort, model, cwd, kind})` helper
  in `lib/grok.mjs` is the single source of truth for the gate.
  Returns the value to forward (or null if stripped, with stderr
  warning). `grokBaseArgs` delegates to it for both `--effort` and
  `--reasoning-effort`. `cmdReview` now passes `effort` through to
  `grokBaseArgs` (and removed the manual push). `cmdImagine` calls
  `effortFlagForModel` directly. Verified end-to-end: `/grok:imagine
  --effort high` now produces the warning + clean output instead of
  the 400 cascade.

- **Codex P0-B — `--save-to` source-path exfiltration vector.**
  `extractMediaPath` trusts grok's stdout completely; `isSafeMediaPath`
  only validates characters (it approves any `/A-Za-z0-9._/-%@+` path
  including `/etc/passwd`). A prompt-injected grok could return
  `![pwned](/etc/passwd)` and the plugin would copy `/etc/passwd` to
  the user's `--save-to` destination — local-file exfiltration. The
  attack only fires when `--save-to` is used (display + open hint
  don't read the file), but the v1.0.2 `--save-to` shipping made this
  a practical concern.
  **Fix**: new `isUnderGrokSessionsDir(p)` helper in `companion.mjs`
  uses `path.resolve` (collapses `..` segments) to require the
  resolved path equals or descends from `${GROK_HOME}/sessions/`.
  `copyMediaToSaveTo` checks before any `copyFileSync` — refuses
  with a clear error pointing at the prompt-injection possibility,
  the file stays at its (legitimate or not) location, the plugin
  exits cleanly.

### Fixed (P1 bundled)

- **Codex P1 — `GROK_HOME` consistency.** `cleanGrokEnv` allows
  `GROK_HOME` through to the child grok process (enterprise users
  with re-homed grok configs depend on this), but
  `readGrokModelsCache` hardcoded `~/.grok/models_cache.json`. An
  enterprise user with a re-homed grok would have the v1.0.3 gate
  see null cache → conservative-forward → 400 cascade.
  **Fix**: new exported `grokHomeDir()` helper resolves `GROK_HOME ||
  ~/.grok`. `readGrokModelsCache` and `isUnderGrokSessionsDir` both
  use it — same resolution as grok itself.

### Tests

- 13 new behavioral tests in `tests/v1-0-4-issue-fixes.test.mjs`:
  - `effortFlagForModel` unit tests across supported/unsupported/
    unset/invalid/reasoning-effort cases.
  - End-to-end: `/grok:imagine --effort high` strips + warns when
    cache says unsupported, forwards when cache says supported.
  - End-to-end: `--save-to` refuses to copy `/etc/hosts` (injection
    rejection), allows copy from legitimate session-dir source.
  - `grokHomeDir` returns `GROK_HOME` or falls back to `~/.grok`.
  - The gate reads cache from `GROK_HOME`, not hardcoded `~/.grok`.
  - Source-grep guards on helper export, call-site count, and the
    `copyMediaToSaveTo` confinement check.
- Existing v1-0-2-save-to.test.mjs updated to put fake session-dir
  fixtures under `${GROK_HOME}/sessions/` so the new gate accepts
  them (using a per-test fakeHome and `GROK_HOME` on the subprocess).
- One v1-0-3 source-grep test relaxed (call count dropped from 3 to
  2 because `grokBaseArgs` no longer calls `modelSupportsReasoning
  Effort` directly — it delegates via `effortFlagForModel`). The
  invariant is now guarded by the v1.0.4 test instead.
- Total: 380 tests (375 passing + 5 integration skipped).

## [1.0.3] - 2026-05-16

Bug + docs release for two issues filed by external reviewer
@eyalRonen1. Triaged with codex + gemini + grok agents in parallel
— 3/3 confirmed the diagnoses, with one dissent on remediation
style for #7 (resolved in favor of the 2/3 lenient approach).

### Fixed

- **#7 — `--effort` triggers cryptic 400 cascade on grok-build**.
  Today's only public model (`grok-build`) declares
  `supports_reasoning_effort: false` in `~/.grok/models_cache.json`,
  but the plugin's `/grok:research` always emits `--effort max` by
  default. Result: every research call to the default model produced
  a 4× repeated `Internal error: { ... 400 ... }` cascade on stderr,
  with exit 0 leaking through. **Fix**: new
  `modelSupportsReasoningEffort()` helper in `lib/grok.mjs` reads the
  models cache once per call. In `grokBaseArgs`, before emitting
  `--effort` or `--reasoning-effort`, the gate checks the
  **resolved** model (after env/config/default fallback). If the
  model declares no support, the flag is stripped with a clear
  stderr warning that names the model, points at the cache, and
  suggests `grok models` to refresh or `--model <id>` to override.
  Cache-miss or unknown-model is treated conservatively (forward the
  flag — never silently strip when we lack data). Verified end-to-end:
  `/grok:ask --effort high` now returns the answer + warning instead
  of the 400 cascade.

  **Reviewer convergence**: Codex + Gemini + me chose
  lenient-strip-with-warning (preserves the flagship `/grok:research`
  command on the default model); Grok dissented in favor of strict
  abort (would have made `/grok:research` dead-on-arrival until the
  user discovers `--model`). The reporter explicitly accepted either
  option in their proposal. 2/3 vote + the dissenter's concern fully
  mitigated by the very visible 4-line stderr warning.

### Docs + UX

- **#8 — `--best-of-n` is implicitly code-task-only**. grok's native
  `/best-of-n` skill spawns N parallel subagents in isolated git
  worktrees and evaluates them on Correctness · Code Quality ·
  Safety. For text or research prompts the diff evaluator has
  nothing to score, so the user gets an evaluation table over empty
  diffs (essentially empty stdout). Reporter lost ~5× token spend
  on a research prompt that returned 1 byte before realizing.
  **Fix**: `commands/best-of.md` rewritten to lead with "CODE /
  FILE-CHANGE tasks only" and direct text/research users to
  `/grok:research` or `/grok:ask`. `cmdBestOf` in `companion.mjs`
  also writes a one-line stderr banner on every invocation
  reminding callers of the constraint. The banner is suppressed in
  `--json` mode (parseable pipelines) and when
  `GROK_PLUGIN_QUIET_BANNERS=1` is set (power-user opt-out).

### Deferred (with reason)

- **#8 — `--aggregate-of-n` (run N times + synthesize one answer)**.
  Reporter's secondary request. This is the feature most text/research
  users actually want from "best of N" — but it requires a new
  synthesis prompt + parallel-run orchestrator + result aggregation
  (essentially a smaller cousin of `/grok:aggregate-review`).
  Medium-to-large feature, wrong scope for a patch release. 2/3
  reviewers (Gemini + Grok) recommended defer; Codex argued for v1.0.3
  inclusion. Added to v1.1.0 roadmap. Tracking in the open #8 thread.

### Internal

- New env var `GROK_PLUGIN_DISABLE_EFFORT_GATE=1` bypasses the per-
  model `--effort` gate entirely. Primarily for test isolation —
  pre-v1.0.3 unit tests assume `--effort` always forwards, which the
  gate would otherwise break on machines where `~/.grok/models_cache.json`
  has been populated. Three test files set it in their before/after
  hooks. End-users can also set it if they want to roll back the gate
  while keeping the rest of v1.0.3, but the gate's strip-with-warning
  is the recommended path.

- New env var `GROK_PLUGIN_QUIET_BANNERS=1` suppresses informational
  stderr banners (today: just the `/grok:best-of` code-task reminder).
  For users who already know what `--best-of-n` does and don't want
  the line on every invocation.

### Tests

- 11 new behavioral tests (`tests/v1-0-3-issue-fixes.test.mjs`):
  - `modelSupportsReasoningEffort()` returns true/false/null across
    cache-present, cache-missing, model-missing, field-missing,
    null/empty input cases.
  - `grokBaseArgs` strips `--effort` and `--reasoning-effort` with
    stderr warning when cache says unsupported.
  - `grokBaseArgs` forwards both when cache says supported.
  - `grokBaseArgs` forwards both when cache is missing (conservative).
  - `cmdBestOf` prints the code-task banner to stderr, suppresses it
    in `--json` mode, and suppresses it when
    `GROK_PLUGIN_QUIET_BANNERS=1`.
  - Source-grep guards on the helper export, call-site count, and the
    `best-of.md` doc rewrite.
- Total: 367 tests (362 passing + 5 integration skipped).

## [1.0.2] - 2026-05-16

Feature + triage release driven by two more issues filed by external
reviewer @eyalRonen1. Both triaged with the codex + gemini + grok
multi-agent pipeline; **3/3 reviewers converged** on the same plan
this time around.

### Added

- **#5 — `--save-to <path>` on `/grok:imagine` and `/grok:imagine-video`**.
  Before v1.0.2 every imagine / imagine-video invocation forced the
  user to parse the `Video: <internal grok session path>` stdout line
  and `cp` to wherever the artifact actually belonged. For an 8-clip
  commercial shoot that meant 8x parse + 8x cp on top of the actual
  generation. The reporter described 60+ repetitions of this pattern
  in a single session.
  **Fix**: `--save-to <path>` flag. The plugin copies the generated
  media from grok's internal session dir to the user-specified path
  (creates parent dirs via mkdirp, follows POSIX `cp source dir/`
  semantics when the destination ends with `/` or names an existing
  directory). The internal session copy is preserved so `grok -r
  <session-id>` resume / audit still works. On copy failure (perm
  denied, disk full, source missing) the file remains at the internal
  session path and the error is surfaced on stderr — generation
  doesn't fail.
  - `--json` output now exposes `path` (where the file IS NOW —
    savedTo if successful, else internal), `sessionPath` (always the
    internal grok session-dir path), `savedTo` (non-null only when
    --save-to succeeded), and `saveError` (non-null only when
    --save-to failed). Old callers reading `.path` keep working.

### Deferred (with reason — not closed)

- **#6 — `--shot-list` YAML batch mode**. Once `--save-to` ships, the
  bash one-liner `for n in beat1 beat2 ...; do /grok:imagine-video
  --save-to "assets/${n}.mp4" "..." & done; wait` covers the core
  parallelism need without any plugin code. The declarative YAML
  surface adds real value for non-bash users and CI pipelines, but
  3/3 reviewers (codex, gemini, grok) agreed the scope cost (YAML
  parser dependency violating the zero-dep plugin model, semaphore
  worker pool, partial-failure aggregation, summary table renderer)
  is not justified once #5 ships. Will revisit if user feedback
  indicates the bash workaround isn't enough.

### Security

- `copyMediaToSaveTo()` refuses control bytes in the user-supplied
  `--save-to` path (defends against terminal-attack via the `open --`
  echo). Path traversal via `..` is allowed — the user is explicitly
  typing an absolute or relative destination and is trusted with
  their own filesystem (this is user input, not model output).

### Tests

- 9 new behavioral tests (`tests/v1-0-2-save-to.test.mjs`):
  end-to-end copy via a fake-grok stub with a real on-disk source
  file (asserts dest exists, contents match, session copy preserved,
  display path reflects dest); directory semantics (existing dir,
  trailing slash, mkdirp); control-byte refusal; `--json` shape
  (savedTo / sessionPath / saveError) both with and without
  --save-to; source-grep guards on COMMON_VALUE_FLAGS registration
  and on the .md doc updates.
- Total: 356 tests (351 passing + 5 integration skipped).

## [1.0.1] - 2026-05-16

Bug-fix release driven by two issues filed against v1.0.0 by external
reviewer @eyalRonen1. Both issues triaged with the codex + gemini +
grok multi-agent pipeline; 2/3 reviewers converged on fix-now within
minutes and the third agreed. Two additional feature-request issues
(#3, #4) were investigated and deferred — the underlying Grok CLI's
builtin `/imagine`/`/imagine-video` slash commands take only a text
prompt and do not accept the requested flags (`--init-image`,
`--aspect-ratio`); shipping a plugin flag that the CLI cannot honor
would be cargo-cult UX.

### Fixed

- **#1 — `grok` 0.1.211 auto-update silently breaks all plugin calls**.
  The 0.1.211 release of the upstream `grok` binary returns exit 0
  with empty stdout/stderr for every command including `--version`.
  v1.0.0 had no diagnostic — the user saw `exit 1` (or no output) and
  had to test `grok --version` manually to find the broken binary.
  **Fix**: `grokVersion()` in `lib/grok.mjs` now distinguishes three
  states (null = couldn't run / "" = exit 0 with empty output / "grok
  X.Y.Z" = real version). `cmdSetup` checks for the empty case and
  surfaces a 3-step recovery path: try `grok update` → roll back via
  `~/.grok/downloads/` → reinstall. The JSON output (`/grok:setup
  --json`) also sets `grok.broken: true` so hooks can route on it.

- **#2 — `companion.mjs` swallows underlying grok errors**. When the
  spawned `grok` child exited with both stdout AND stderr empty (the
  exact #1 failure mode, plus any other "silent crash" case), the
  plugin printed nothing — the operator got an opaque non-zero exit
  with no diagnostic. **Fix**: new `diagnoseEmptySpawnFailure()`
  helper in `companion.mjs` prints the exit code, the shell-quoted
  argv (paste-back ready), and the same 3-step recovery hints from
  #1. Called from all three subprocess paths: `runHeadlessGrok` (ask,
  research, models, best-of, mcp/memory/sessions/worktree
  subcommands), `cmdImagine` (imagine + imagine-video), and `runJob`
  (background tasks for rescue + task + the long-running review
  paths). The diagnostic fires for empty output regardless of exit
  code — exit 0 with no output is also anomalous.

### Deferred (with reason — not closed)

- **#3 — `--init-image` for image-to-video**. Verified locally that
  `grok -p "/imagine-video --help"` is interpreted as a video-of-text
  prompt by the builtin slash command (the CLI returns a video of
  the literal string `"--help"`). The xAI REST API may support
  image-to-video via `image_url`, but the local `grok` CLI does not
  expose that parameter to its builtin slash commands. Will revisit
  when upstream `github.com/xai-org/grok` adds CLI-level support.

- **#4 — `--aspect-ratio` for imagine/imagine-video**. Same finding
  as #3: the builtin `/imagine` and `/imagine-video` slash commands
  consume their entire input as the description text and do not
  parse flags. Will revisit when upstream adds flag support to these
  slash commands.

### Tests

- 8 new behavioral tests (`tests/v1-0-1-issue-fixes.test.mjs`):
  cmdImagine + runHeadlessGrok + cmdSetup diagnostics across exit-0
  and exit-1 empty-output cases, plus source-grep guards on the
  helper and the three-state contract on `grokVersion`.
- Total: 347 tests (342 passing + 5 integration skipped).

## [1.0.0] - 2026-05-15

**First stable release.** No code changes from v0.9.13 — this is a
purely declarative cut.

The plugin has been hardened through 13 rounds of multi-LLM
`/grok:aggregate-review` against the v0.9.x line. v0.9.13 is the
last revision the round-13 reviewers identified a (non-triggerable,
theoretical) finding for; the v0.9.13 patch closes that finding and
the resulting code surface is what ships as v1.0.0.

### What's included

20 slash commands wrapping the official xAI Grok CLI
(github.com/xai-org, x.ai/cli):

- `/grok:ask`, `/grok:research`, `/grok:rescue`
- `/grok:review`, `/grok:adversarial-review`, `/grok:aggregate-review`
- `/grok:imagine`, `/grok:imagine-video`
- `/grok:best-of`, `/grok:models`
- `/grok:worktree`, `/grok:sessions`, `/grok:memory`, `/grok:mcp`
- `/grok:inspect`, `/grok:status`, `/grok:result`, `/grok:cancel`,
  `/grok:purge`
- `/grok:setup`

### Security baseline (v1.0.0)

- Env scrubbing allowlist for the spawned `grok` child.
- ANSI escape sanitization (4 KiB pending-escape cap).
- TOCTOU/symlink defenses on job state reads (O_NOFOLLOW, fstat,
  0700 chmod chain, realpath-on-fd, root-only safe-boundary check).
- POSIX `--` terminator for literal positionals.
- Refusal of unknown flag-like positionals by default.
- Capability-probe gating for `--worktree`/`--continue`/`--resume`/
  `--no-memory`/`--experimental-memory` so older grok CLIs degrade
  cleanly instead of silently dropping flags.
- Prompt-injection defenses for reviewer-style commands.

### Stability promise

v1.x will not break any of the 20 command surfaces. Internal helpers
(`commandUsesJsonOutput`, `getSessionProvenance`, ANSI sanitizer,
TOCTOU helpers) are not part of the public surface and may continue
to evolve.

### Tests

339 tests (334 passing + 5 real-grok integration smoke tests
skipped by default; opt-in via `GROK_INTEGRATION_TEST=1`).

## [0.9.13] - 2026-05-15

`/goal` round-13 — **Gemini SHIP** ("No material regressions"), Codex
P2 ("scanner needs to distinguish actual option positions from values
of other options"), Grok **Medium** ("argv scanner consumes value
token of the space form but does not advance past it"). Both findings
point at the same robustness gap. Fixed here.

### Robustness

- **Grok Medium + Codex P2 round-13 — value-token re-interpretation in
  `commandUsesJsonOutput`**.
  The v0.9.12 helper scanned every argv token independently. After
  recognising the space form `--output-format <val>` it peeked at
  `argv[i+1]` for the value but did not advance `i`. A value that
  happened to match an inline pattern (e.g. the literal string
  `--output-format=json` passed by some future caller as the VALUE of
  the space-form flag) would then be re-scanned on the next iteration
  and flip `result` to `true`, even though semantically the
  output-format value was the literal `"--output-format=json"` string
  (not `"json"`). Not exploitable today because every existing call
  site of `grokBaseArgs` only emits `"json"` or `"plain"` as the
  value, but a real robustness gap in a helper meant to be a robust
  last-wins parser for any future caller.
  **Fix**: consume the value token when the space form is seen (`i++`
  if the value is a string), so its contents are never re-scanned as a
  candidate flag.

### Tests

- 7 new assertions on `commandUsesJsonOutput` covering:
  - Space-form value that resembles the inline pattern (the exact
    Grok-Medium scenario).
  - Same with a benign tail flag.
  - Space-form value that resembles the inline pattern with a
    non-json suffix.
  - Mixed-form last-wins, both directions (space→inline,
    inline→space), with both `json` and `plain` as the winning value.
- Total: 339 tests (334 passing + 5 integration skipped).

## [0.9.12] - 2026-05-15

`/goal` round-12 — **3/3 SHIP**: Codex "no regressions", Gemini
"solid refinement", Grok **"Recommendation: Ship."** 1 LOW
(robustness) + 1 Nit (test) actionable.

### Robustness

- **Grok LOW + Gemini Important round-12 — argv scanner only handled space form**.
  v0.9.11's inline `indexOf("--output-format")` recognized only the
  two-token shape `["--output-format", "json"]` that `grokBaseArgs`
  emits today. A future runJob caller using the inline form
  `--output-format=json` would silently get `trustworthy: false`.
  **Fix**: extracted `commandUsesJsonOutput(argv)` helper in
  `lib/grok.mjs` that handles BOTH forms + last-wins semantics for
  duplicates. runJob now calls it instead of inline scanning.

- **Gemini Nit round-12 — direct test for the derivation logic**.
  v0.9.11's test only exercised pre-constructed meta objects, not
  the actual runJob argv→trust derivation. Added 10 assertions on
  `commandUsesJsonOutput` covering: space form, inline form, missing
  flag, null/empty argv, last-wins for duplicates of each shape.

### Tests

- 10 new assertions on `commandUsesJsonOutput` (the new helper).
- Total: 333 passing + 5 integration (skipped).

## [0.9.11] - 2026-05-15

`/goal` round-11 — **3/3 SHIP**: Codex "no regressions evident", Gemini
"patch is solid", Grok **"Shippable."** 1 forward-looking Important +
3 cleanups; this release addresses them.

### Eliminated the "forget to set the flag" footgun

- **Gemini Important + Grok LOW round-11**. v0.9.10 required each
  runJob caller to manually set `extra.envelope_json: true` when
  invoking grok with `--output-format json`. A future caller could
  forget → silent trust regression. **Fix**: runJob now derives the
  trust flag directly from the spawned argv (`meta.command`) — looks
  for `--output-format json` presence. The manual field is gone;
  trust is automatic. cmdReview's extra block dropped both
  `envelope_json` (no longer needed) and `json_output` (was dead
  data per Grok LOW).

- **Grok MED round-11 — stale comment in `render.mjs`**.
  Module-level doc still described the v0.9.9 behavior ("read
  `meta.session_id_trustworthy`, a flag set ... when the job had
  `json_output: true`"). Updated to describe the v0.9.11 design.

### Tests

- 1 new test reflects the v0.9.11 derivation; v0.9.10 historical
  test kept for the backward-compat path.
- Total: 332 passing + 5 integration (skipped).

## [0.9.10] - 2026-05-15

`/goal` round-10 — Codex + Grok converged on a **regression v0.9.9
introduced** while fixing the v0.9.8 architectural issue. The trust
flag was reading the wrong field.

### Bug fix

- **Codex P2 + Grok HIGH — `meta.json_output` ≠ envelope-was-JSON**.
  `cmdReview` ALWAYS invokes grok with `jsonOutput: true` regardless
  of `flags.json` (it parses JSON envelope internally, then re-renders
  plain text when the user didn't ask for JSON output). v0.9.9's
  trust gate read `meta.json_output` (which mirrors `flags.json`,
  the user-facing render flag) → for normal `/grok:review` (no
  `--json`), the flag was false → trust=false → session hint
  suppressed. Codex called it out via comparison to v0.9.8 behavior;
  Grok traced the data flow line-by-line. **Fix**: introduced a
  separate `meta.envelope_json` field at job-creation time that
  reflects the actual grok invocation (always true for review). The
  trust flag now reads from `envelope_json`, not `json_output`.
  Backward-compat: old jobs without either field still fall back to
  the v0.9.8 kind whitelist.

- **Gemini Nit round-10 — unused `getSessionProvenance` import in test**.
  Cleanup; removed.

### Tests

- 1 new behavioral regression test covering all 3 scenarios:
  `/grok:review` without `--json` (must trust), `/grok:review --json`
  (must trust), task with model-hallucinated JSON (must suppress).
- Total: 331 passing + 5 integration (skipped).

## [0.9.9] - 2026-05-15

`/goal` round-9 — **3/3 explicit approval**. Gemini even returned a
parsed `VERDICT: SHIP` for the first time (the aggregator's status
column showed `ok` for the first time in v0.9.x). 1 Nit + 1 LOW
remaining; this release applies both.

### Polish

- **Grok LOW round-9 — Trust decision moved to job-creation site**.
  v0.9.8's whitelist (`TRUSTED_SESSION_ID_KINDS = ["review",
  "adversarial-review"]`) lived in `lib/render.mjs`. Adding a new
  json-output job kind would require remembering to update that list
  too. **Fix**: `runJob`'s close handler now sets
  `meta.session_id_trustworthy = !!meta.json_output` when it
  populates `meta.session_id`. The renderer reads that flag. The
  trust decision now lives WITH the job creator, where it knows
  whether the JSON envelope is authoritative.
  Backward-compat: old job-meta files without the flag fall back to
  the v0.9.8 kind whitelist so existing review/adversarial-review
  jobs don't suddenly lose their hint.

- **Gemini Nit round-9 — Test dynamic imports → top-level**.
  Three tests used `await import("...lib/render.mjs")` inside their
  bodies. Moved to a top-level import block matching the rest of
  the test file's style.

### Status

- 8 `/goal` rounds in v0.9.x, all "correctness" + "important"
  findings resolved.
- v0.9.x is **shippable** per all 3 reviewers (Codex+Gemini+Grok)
  in round-9.
- 330 fake-grok tests + 5 real-grok integration tests (skipped by
  default; verified passing locally against grok 0.1.210).
- 4 new commands (worktree/sessions/memory/mcp) + 6 new flags
  (--worktree, --continue, --resume, --restore-code, --no-memory,
  --experimental-memory) — full Native Grok Differentiators surface.

## [0.9.8] - 2026-05-15

`/goal` round-8 — first round with **all 3 reviewers explicitly
approving**: Codex "No actionable issues", Gemini "Ship it.",
Grok "The diff can merge." 1 Nit + 2 LOW remaining; this release
applies the 2 actionable ones.

### Polish

- **Gemini Nit round-8 — blacklist → whitelist for trusted session_id**.
  `getSessionProvenance` gated `session_id` on `meta.kind !== "task"`
  (blacklist). Future plain-output job kinds would silently inherit
  trust by default. **Fix**: `TRUSTED_SESSION_ID_KINDS = new Set(["review", "adversarial-review"])` —
  fail-closed whitelist. A new job kind must be explicitly added
  before its parsed session_id is trusted.

- **Grok LOW #1 round-8 — brittle source-grep test replaced with behavioral**.
  v0.9.7's regression guard used `fs.readFileSync` + `indexOf` slice
  + regex on `lib/render.mjs` source — fragile to refactors. Replaced
  with a behavioral test that calls `renderJobDetails` for every
  priority case AND asserts task-kind session_id is suppressed in
  actual output. Same coverage, immune to formatting changes.

### Tests

- 1 replaced (source-grep → behavioral) + 3 extended cases (whitelist
  enforcement: task / unknown-kind / missing-kind all suppressed).
- Total: 330 passing + 5 integration (skipped).

### Status

After 8 `/goal` rounds in v0.9.x, all `correctness` and `important`
findings have been resolved. Grok LOW #2 (small cosmetic duplication
between `formatSessionHint` and `formatSessionLabel` switch ladders)
is acknowledged as acceptable — both functions are simple, have
distinct documented purposes, and consolidation would obscure intent.

## [0.9.7] - 2026-05-15

`/goal` round-7 — 3/3 reviewer convergence (every round, every round) on
"the consolidation isn't actually consolidated". This release **finally**
makes good on the architectural claim.

### Bug fixes

- **3/3 Important — `renderJobDetails` still duplicated the priority chain**.
  v0.9.6 added `formatSessionHint` in `companion.mjs` and *claimed* all
  three render paths used it. They didn't: `renderJobDetails` (in
  `lib/render.mjs`) kept its own copy of the ladder. **Fix**: moved
  `formatSessionHint` + new helpers `getSessionProvenance` (returns a
  discriminated tagged union — Grok's structural suggestion) and
  `formatSessionLabel` (short form for `renderJobDetails`) into
  `lib/render.mjs`. companion.mjs imports the hint helper.
  renderJobDetails now calls `formatSessionLabel` directly. **One source
  of truth, three callers.** Future priority changes require editing
  one file.

- **Codex P2 #2 — Plain-task `meta.session_id` could be model hallucination**.
  Task jobs run with plain output. If the model's response happens to
  contain a JSON-shaped envelope with a `sessionId` field, `runJob`'s
  close handler stored it in `meta.session_id`, and v0.9.6's footer
  trusted it. **Fix**: `getSessionProvenance` gates the legacy
  `session_id` branch on `meta.kind !== "task"`. Review/adversarial-review
  jobs (which use json output) still trust their parsed sessionId.

- **Codex P2 #1 + Gemini Important #1 — Wrong raw-CLI short flag**.
  v0.9.6 used `grok -s <id>` as the raw-CLI half of the session-id
  hint. `-s` is the create-or-resume short form; the documented
  standalone continuation command is `grok -r <id>` (resume only).
  Users copying the suggestion when the session already existed got
  the right behavior; users copying it BEFORE the session existed got
  surprises. **Fix**: use `grok -r <id>` consistently. The slash-command
  half stays `--session-id=` (create-or-resume) because the plugin's
  flag is structured differently.

- **Gemini Nit + Grok LOW — Inconsistent labels**.
  `formatSessionHint` said "Resumed Grok session: X" while
  `renderJobDetails` said "Resumed session: X". Aligned both on
  "Resumed session: X".

- **Grok LOW #2 — Stale comment in cmdTask**. The "Only surface a
  Session footer when the user explicitly named a session…" comment
  predated v0.9.6 and was factually wrong. Updated to describe what
  the code actually does.

### Tests

- 3 new behavioral tests on the new helpers (priority order, task-kind
  suppression, short vs full label, all-5-cases for both hint and
  label variants). 1 old test updated to use `kind: "review"` since
  legacy `session_id` is now task-suppressed.
- Total: 330 passing + 5 integration (skipped).

## [0.9.6] - 2026-05-15

`/goal` round-6 — 3/3 reviewer convergence (yet again) on the same
pattern: v0.9.5 added the new `requested_resume` / `requested_continue`
fields but only wired them into the cmdTask footer. `/grok:status`
and `/grok:result` (the two surfaces explicitly named in the previous
bug report!) still consulted only `meta.session_id`.

### Bug fixes

- **3/3 HIGH — Session hint missing from `/grok:status` and `/grok:result`**.
  Extracted `formatSessionHint(meta)` as a module-scope exported
  helper. Single source of truth for the priority chain:
    `requested_session_id` > `requested_resume` (string) > `requested_resume` (true) >
    `requested_continue` > `session_id`.
  All three render paths (`cmdTask` footer, `cmdResult`,
  `renderJobDetails`) now call this helper. The previous "fix in one
  place, miss it in two others" pattern is closed.

- **Grok HIGH #2 round-6 — cmdResult suggested wrong flag for `session_id`**.
  When `meta.session_id` (legacy JSON envelope path) was populated,
  cmdResult suggested `--resume=<id>` — but `--resume` requires the
  session to already exist, while `--session-id` creates-or-resumes.
  Users following the suggestion got a "session not found" error.
  **Fix**: `formatSessionHint` uses `--session-id=` form for the
  legacy case (matching create-or-resume semantics).

- **Codex P2 round-6 — `--resume <id>` (space form) advertised in skill**.
  The parser requires `--resume=<id>` (inline `=`); bare `--resume`
  is bool. The cli-runtime skill text said both forms were accepted.
  **Fix**: removed the space-form mention; added an explicit note
  that the named form requires `=`.

- **Gemini Nit #2 round-6 — `--continue` footer missing `grok -c` hint**.
  The `--resume` branches mention `or grok -r`. The `--continue`
  branch didn't have its `or grok -c` counterpart. Added.

### Tests

- 4 new tests:
  - Direct behavioral test of `formatSessionHint` exercising all 5
    priority cases + null fallback.
  - Source-shape tests asserting `cmdTask` still records all 3
    fields, `renderJobDetails` consults all 4 fields, and
    `cmdResult` calls `formatSessionHint`.
- Total: 329 passing + 5 integration (skipped).

## [0.9.5] - 2026-05-15

`/goal` round-5 — 3/3 reviewer convergence on the **incomplete** v0.9.4
fix (the rescue.md edits never actually landed) + Grok found a related
HIGH about job-meta provenance.

### Bug fixes

- **3/3 HIGH — v0.9.4 fix was incomplete (rescue.md + skills not updated)**.
  v0.9.4's CHANGELOG claimed it updated both the agent prompt AND
  `rescue.md`'s `argument-hint` + the loaded skills. Only the agent
  prompt actually changed. The two skills (`grok-cli-runtime`,
  `grok-prompting`) and `rescue.md` still only mentioned `--session-id`.
  Per the rescue subagent's contract ("loads the cli-runtime skill"),
  an LLM following the skill would drop `--resume`/`--continue` as
  task text. **Fix**: this release updates all 4 files
  (`rescue.md` argument-hint + bullet, `grok-rescue.md`, both skills).

- **Grok HIGH #2 round-5 — `cmdTask` lost resume/continue provenance**.
  `meta.requested_session_id` was the only session-id captured in job
  metadata. `/grok:status`, `/grok:result`, and the in-flight footer
  gated their resume hints on that single field. When a session was
  started via `--resume=<id>` or `--continue`, the hints never
  surfaced → the user had no way to know which session was used to
  continue. **Fix**: `extra.requested_resume` and `extra.requested_continue`
  are now recorded in job meta; the footer renders the appropriate
  hint based on which entry point was used.

- **Codex P2 round-5 — integration test for `/grok:inspect` too permissive**.
  After v0.9.4's "accept stderr as valid error" change, ANY stderr
  output (even a CLI usage / "unknown subcommand" failure from a
  future upstream rename) would pass. Acknowledged as test-quality
  trade-off; tightening to "expected config/auth stderr vs unknown
  command" requires more brittle pattern matching. Tracked as a
  future refinement.

### Tests

- 2 new tests asserting (a) `cmdTask` records all three resume entry
  points and emits the right footer, (b) all 4 docs/skills/agent
  files mention `--resume` AND `--continue` — catches the v0.9.4
  "edits didn't apply" class of bug.
- Total: 326 passing + 5 integration (skipped by default).

## [0.9.4] - 2026-05-15

`/goal` round-4 — 3 real findings, the biggest being a **factually
incorrect resume-guidance message** that v0.9.3 added.

### Bug fixes

- **Grok HIGH — `/grok:rescue --resume=<id>` wasn't actually supported**.
  v0.9.3's output suggested `(resume: /grok:rescue --resume=<id> or
  grok -r <id>)` but the `grok-rescue` subagent's prompt only handled
  `--session-id`. Users following the advice would have their
  `--resume=<id>` token treated as ordinary task text → continuation
  intent lost. **Fix**: extended the rescue subagent prompt + the
  command's argument-hint to preserve `--resume=<id>` and `--continue`
  as runtime-control flags (same shape as `--session-id`). Now the
  advertised path actually works.

- **Codex P2 #1 + Codex P2 #2 — integration tests had wrong assertions**.
  `/grok:setup --json` correctly exits 1 when not-ready (CI signal +
  actionable JSON), but the test asserted `r.status === 0`.
  `/grok:inspect` can emit its clear error on stderr, but the test
  only inspected stdout. Both fixed:
    - setup: `status === 0 || status === 1` accepted; JSON shape still
      enforced (`nextSteps` must be present when `!ready`).
    - inspect: failure is "no output on stdout AND no output on stderr",
      not just stdout.

- **Grok MED — `/grok:sessions search` POSIX `--` undocumented**.
  v0.9.2 removed the `allowFlagLikePositionals` heuristic, making
  `/grok:sessions search --my-pattern` exit 2. The change was correct
  (consistent with the rest of the wrapper surface) but `sessions.md`
  didn't tell users the new requirement. Documented: searches with
  `-`-prefixed tokens need `/grok:sessions search -- --my-pattern`.

### Tests

- 324 passing + 5 integration (skipped by default), same as v0.9.3.
  Round-4 fixes are docs + agent prompt + test assertion updates;
  no behavior change in the production paths beyond `/grok:rescue`
  gaining real `--resume`/`--continue` support.

## [0.9.3] - 2026-05-15

`/goal` round-3 came back **APPROVE_WITH_NITS from 3/3 reviewers** —
Codex CLEAN, Gemini 3 nits, Grok 2 LOW. This release applies every
finding plus addresses a long-standing critique about test strategy
("why fake grok and not real grok?").

### Bug fixes (test strategy)

- **Real-grok integration smoke tests**. The previous 324 fake-grok
  tests verified that the plugin BUILDS the right argv. They didn't
  catch upstream renames (if xAI renames `--max-turns` to
  `--turn-limit`, every fake test still passes but the plugin
  silently breaks in production). New `tests/integration-real-grok.test.mjs`
  has 5 smoke tests against the actual `grok` binary:
    - `grok --version` exit + format
    - `capabilityProbe` required flags all appear in real `grok --help`
    - `/grok:setup --json` returns either `ready: true` or actionable
      `nextSteps`
    - `/grok:inspect` doesn't silently fail
    - `/grok:ask` with a sentinel prompt echoes the sentinel
  Skipped by default (the 320 fake tests stay fast + cost-free + auth-
  free). Run via `GROK_INTEGRATION_TEST=1 npm test`. CI workflow can
  set both `GROK_INTEGRATION_TEST=1` and `GROK_CODE_XAI_API_KEY=$SECRET`.

### Round-3 cleanups (all from this round's reviewer feedback)

- **Gemini Nit #1 — `allowFlagLikePositionals` dead code**. Removed
  the parameter from `cmdGrokSubcommandPassthrough` signature. The
  POSIX `--` terminator + per-positional `isLiteral` tracking does
  the same job more explicitly.

- **Gemini Nit #2 — flag-value denylist mismatch**. The positional
  loop used `CONTROL_BYTE_FREETEXT_DENYLIST` (TAB/LF/CR allowed),
  but the flag-value loop still used the strict `[\x00-\x1f\x7f]`.
  Forward-compat fix: same constant in both loops.

- **Gemini Nit #3 — stale short-flag docs**. The plugin's output
  used to suggest `grok -r <id>` for resume (the raw grok CLI form).
  After v0.9.2 dropped short aliases from our parser, that's still
  correct (grok's CLI accepts `-r`) but it doesn't surface the
  plugin's `/grok:rescue --resume=<id>` option. Output now mentions
  BOTH: `(resume: /grok:rescue --resume=<id>  or  grok -r <id>)`.

- **Grok LOW #1 — error message emitted blocked bytes raw**.
  Refusing a positional with `\x07` (BEL) or `\x1b` (ESC) used to
  emit those bytes into the user's terminal (terminal bell, ANSI
  injection). The error path now uses `JSON.stringify` to render
  control bytes as visible `\u00XX` escapes.

- **Grok LOW #2 — direct unit test for `literalStartIndex`**. v0.9.2
  added the field but only exercised it via the E2E argv-shape test.
  Added direct assertions on the return value: index points to the
  correct slot, `-1` when no `--` was seen, `0` when `--` is first.

### Tests

- 4 new round-3 fix tests + 5 integration smoke tests (skipped by
  default).
- Total suite: 324 passing + 5 skipped.

## [0.9.2] - 2026-05-15

`/goal` round-2 on v0.9.1 surfaced more 3/3-convergent bugs in the new
parser surface plus a critical regression: the `--` terminator was
consumed by parseArgs but never re-emitted when forwarding to grok.

### Bug fixes

- **3/3 CRITICAL — `--` terminator silently regressed v0.9.1's fix**.
  v0.9.1 added POSIX `--` so users could search for literal flag-like
  strings (`/grok:sessions search -- --timeout`). But
  `cmdGrokSubcommandPassthrough` then forwarded `["sessions", "search",
  "--timeout"]` to grok with no protective terminator → grok saw
  `--timeout` as its OWN flag → workaround broken.
  **Fix**: parseArgs now returns `literalStartIndex` (the position
  where `--`-escaped tokens begin). The wrapper splits regular vs
  literal positionals and re-emits `--` immediately before literals
  in the forwarded argv.

- **3/3 CRITICAL — Short-alias rewrite over-triggered on prompt text**.
  v0.9.1 enabled `shortAliases = {w,r,c,m}` globally; a prompt like
  `/grok:ask explain grep -r foo` set resume=true and consumed `foo`.
  **Fix**: shortAliases REMOVED from the top-level parseArgs call.
  The parser feature is still available for explicit opt-in (some
  future per-subcommand config), but prompt-accepting commands are
  immune by default. Users must use the long form
  (`--resume=ID`, `--worktree=name`, `--continue`).

- **Codex P3 + Grok MED — `EMPTY_VALUE` not handled in main() catch**.
  v0.9.1's parser threw `EMPTY_VALUE` for `--worktree=` but `main()`
  only converted `MISSING_VALUE` to a usage error (exit 2). Empty
  inline values fell to the outer fatal handler (exit 1) with the
  wrong message. **Fix**: catch both codes the same way.

- **Gemini Nit #4 — Control-byte denylist blocked legitimate whitespace**.
  v0.9.1's `[\x00-\x1f\x7f]` rejected TAB / LF / CR. Real use cases
  (multi-line memory entries, pasted multi-line search queries) were
  blocked. **Fix**: `CONTROL_BYTE_FREETEXT_DENYLIST = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/`
  — TAB/LF/CR allowed, every other C0 + DEL still blocked.

- **Gemini Important #2 — Wrapper couldn't distinguish escaped from typo'd flags**.
  Same fix as the first bullet: `literalStartIndex` tracks which
  positionals were explicitly escaped via `--`. The wrapper now
  bypasses the flag-like-positional check for literals (the user
  explicitly told us they want it literal even if it looks like a flag).
  The previous per-subcommand `allowFlagLikePositionals: positional[0]
  === "search"` heuristic is no longer needed.

### Tests

- 7 new behavior tests covering: `--` terminator re-emission, top-level
  immunity to short aliases (verified with explicit opt-in still works),
  multi-line free-text positionals (TAB/LF/CR), BEL/ESC still blocked,
  EMPTY_VALUE exit code = 2 not 1, literalStartIndex tracking.
- Total suite: 320 passing.

## [0.9.1] - 2026-05-15

`/goal` round-1 on v0.9.0 surfaced **2 CRITICAL 3/3-convergent bugs**
in the v0.9.0 new surface plus several smaller items.

### Bug fixes

- **3/3 CRITICAL — Optional-value parser ate prompt tokens**.
  `/grok:ask --worktree how do I fix this?` named the worktree `how`
  and dropped that word from the prompt — the v0.9.0 peek-ahead
  semantics consumed any non-`--` token after the flag. **Fix**:
  removed peek-ahead. Bare `--worktree` is always bool; named form
  REQUIRES inline `=`: `--worktree=feature-x`. Empty `--worktree=`
  throws (explicit user intent unclear). `--worktree=false` = bool false.

- **3/3 CRITICAL — Subcommand positional allowlist over-rejected**.
  `cmdGrokSubcommandPassthrough`'s `[A-Za-z0-9._:@/+=-]+` regex blocked
  real MCP URLs (`?token=`, `#fragment`) and any free-text session
  search. **Fix**: replaced strict allowlist with a control-byte
  denylist (`spawnSync` is shell-less, so shell-meta is already
  Node-mitigated). Length cap raised to 1024.

- **Codex P2 — Short-flag aliases never reached parser**.
  Grok CLI documents `-w/-r/-c` shorthand; the parser only saw `--`-prefixed
  forms, so `/grok:ask -r abc-123 prompt` left `-r` and `abc-123` in
  positional. **Fix**: new `shortAliases` parser option +
  `COMMON_SHORT_ALIASES = { w: "worktree", r: "resume", c: "continue",
  m: "model" }`. Bundle form `-rabc` rewrites to `--resume=abc`.

- **Gemini Important — Flag-like positionals always rejected**.
  Searching for `--timeout` mentions via `/grok:sessions search "--timeout"`
  errored "Refusing to forward unknown flag-like argument". **Fix**:
  POSIX `--` terminator added to parseArgs (everything after is
  literal positional). Users type `/grok:sessions search -- --timeout`.

- **Grok MED — `--timeout` advertised but dropped**. Every wrapper's
  `.md` arg-hint listed `[--timeout <duration>]`, but
  `cmdGrokSubcommandPassthrough`'s `allowFlags: new Set(["json"])`
  dropped it before forwarding. **Fix**: new `SUBCMD_BASE_ALLOW =
  new Set(["json", "timeout"])` shared across all 4 wrappers.

- **Gemini Nit — Empty inline value silently dropped**.
  `--worktree=""` used to just be skipped. **Fix**: parser throws
  `EMPTY_VALUE` with a clear message ("Use --flag for bool or
  --flag=<value> for named").

### Tests

- 9 new behavior tests covering the new parser semantics (bool-only
  bare form, inline `=` named, empty throw, `=false` bool, short
  aliases incl. bundle form, `--` terminator, MCP URL acceptance,
  flag-like search with terminator, `--timeout` forwarding).
- Updated 3 v0.9.0 tests for the new semantics.
- Total suite: 315 passing.

## [0.9.0] - 2026-05-15

**"Native Grok Differentiators"** — the second 4-LLM-consensus release.
Closes the largest known-gap list from v0.6.0's CHANGELOG ("Known gaps")
plus the v0.8.0 4-LLM research roadmap.

### New commands

- **`/grok:worktree [list|gc|rm <name>]`** — wraps `grok worktree`. Pairs
  with the new `--worktree [<name>]` flag on every prompt-accepting
  command. Lets Grok run inside a fresh git worktree so edits stay
  isolated from the main checkout.

- **`/grok:sessions [list|search|restore]`** — wraps `grok sessions`.
  Surfaces Grok's native session store (`~/.grok/sessions/...`), which
  is separate from the plugin's own job-id system (`/grok:status`,
  `/grok:result`). Pair with `--resume <id>` to continue.

- **`/grok:memory [edit|stats|clear|enable|disable]`** — wraps
  `grok memory`. Surfaces Grok's cross-session memory store.

- **`/grok:mcp [list|add|remove|doctor]`** — wraps `grok mcp`. Manage
  MCP (Model Context Protocol) servers configured for Grok.

### New passthrough flags (across ask / review / research / best-of / rescue / aggregate-review)

- **`--worktree [<name>]`** — start Grok session inside a fresh git
  worktree, optionally named.
- **`-c, --continue`** — continue the most-recent Grok session for cwd.
- **`-r, --resume [<session-id>]`** — resume by id, or by most-recent
  if omitted.
- **`--restore-code`** — re-added (this time properly wired through
  `grokBaseArgs` + `capabilityProbe`; was removed in v0.8.1 as a stub).
- **`--no-memory`** — disable cross-session memory for this call.
- **`--experimental-memory`** — enable cross-session memory for this
  call (mutex with `--no-memory`).

### Parser additions

- New `COMMON_OPTIONAL_VALUE_FLAGS` set + `optionalValueFlags` parser
  option. Required for Grok's `-w/--worktree [<NAME>]` and
  `-r/--resume [<SESSION_ID>]` which both have an optional positional
  value. The parser classifies the next token as a value when it
  doesn't start with `--`.

### Hardening

- **`cmdGrokSubcommandPassthrough`** — centralized helper for all 4
  new wrapper commands. Each spawn:
  - Goes through `cleanGrokEnv()` (env scrubbing)
  - Wraps output in `sanitizeForTerminal()` (ANSI defense)
  - Refuses positional args that match a flag pattern (`--*` or `-X`)
    — defense against parser unknowns getting silently forwarded to
    grok where they'd surface as confusing "unknown option" stderr.
  - Validates each positional against
    `/^[A-Za-z0-9._:@/+=-]+$/` (no shell-meta).
  - Allowlists which `--<flag>` are forwarded per command (e.g. only
    `--json` for now; others are dropped).
  - Sets `maxBuffer = HEADLESS_GROK_MAX_BUFFER` with ENOBUFS detection
    (consistent with other commands).

- **`capabilityProbe` extended** with all 6 new flag tokens. Same G1
  motivation as v0.6.0 + v0.8.0: if grok renames any of these, setup
  fails cleanly with an actionable error message.

### Tests

- New `tests/v0-9-0-native-grok.test.mjs` — 23 behavior tests:
  - Optional-value parser semantics (bool form, named form, inline `=`,
    `--`-prefix lookahead)
  - `grokBaseArgs` worktree/resume/continue/restore-code/memory flag
    emission + validation (control bytes, path separators, mutex)
  - End-to-end subprocess passthrough for the 4 wrapper commands via
    fake-grok with PATH override
  - Security: shell-meta in positional rejected, unknown `--*` in
    positional rejected
  - capabilityProbe regression
- Total suite: 306 passing (+25).

## [0.8.9] - 2026-05-15

`/goal` round-10 was the **first round with no correctness findings** —
Codex came back CLEAN, Gemini found 1 stylistic nit, Grok found 2
medium-cosmetic + 3 low. This release applies the medium fixes.

### Cleanups (no functional changes)

- **Gemini Nit — `import` declaration at top of file**. Moved
  `fileURLToPath` from the bottom-of-file inline `import` to the
  module-header import block alongside `fs`, `path`, `os`, `spawn*`,
  `randomBytes`. Stylistic only — ES module imports were already
  hoisted at runtime.

- **Grok MED #2 — symmetric realpath fallbacks**. The v0.8.8 entry
  guard's `_entryPath` IIFE fell back to the raw `p` on realpath
  failure, while `_invokedAs` fell back to `path.resolve(...)`. Under
  the (rare) dual-realpath-failure case, the comparison could
  silently fail-mismatch on a case-insensitive macOS volume. **Fix**:
  both branches now fall back via `path.resolve` so the comparison
  stays normalized-equivalent end-to-end. The safe failure mode is
  still "main() doesn't auto-run on import."

- **Grok LOW #3 — skip-message wording**. When `budget === 0` from
  positive-timeout overrun, the v0.8.7/v0.8.8 wording said
  "insufficient remaining timeout budget (0ms < 2000ms)" — technically
  correct but reads oddly. v0.8.9: distinguishes
  "timeout budget exhausted" (budget=0) from
  "timeout budget Xms < 2000ms" (positive but tiny).

### Tests

- 2 new behavioral tests (Grok MED #1 round-10): explicit coverage of
  the three guard cases — user-unbounded, exhausted positive,
  healthy positive — at edge boundaries (==MIN, MIN-1, exactly
  elapsed, etc.).
- Total suite: 281 passing.

### Notes for the user

This is the cleanest round of the v0.8.x `/goal` loop yet. Round-11
should confirm convergence. After that we move to **v0.9.0**
(`--sandbox`, `--worktree`, `--continue`/`--resume`, `grok sessions`,
`grok mcp`, memory management).

## [0.8.8] - 2026-05-15

`/goal` round-9 — 3/3 reviewer consensus on a single CRITICAL bug
introduced by v0.8.7's own fix, plus a symlink-resolution gap in the
new entry-point guard.

### Bug fixes

- **3/3 reviewer consensus — exhausted-budget hang risk**.
  `remainingBudgetMs` returns 0 for BOTH `timeoutMs === 0`
  (user-unbounded) AND `elapsed >= timeoutMs` (positive-budget
  overrun). v0.8.7's skip guard was `timeoutMs > 0 && budget > 0 &&
  budget < FALLBACK_MIN_BUDGET_MS` — the `&& budget > 0` clause let
  overrun cases (`budget === 0`) fall through to the spawn, which
  received `timeoutMs: 0` and treated it as unbounded → potential
  indefinite hang past the user's configured timeout.
  **Fix**: distinguish via `userUnbounded = timeoutMs === 0` at the
  call site. Skip guard becomes `!userUnbounded && budget <
  FALLBACK_MIN_BUDGET_MS` (covers both tiny-positive AND overrun).
  Spawn call passes `userUnbounded ? 0 : budget` so 0 only reaches
  the fallback when the user actually asked for unbounded.

- **Gemini Nit + Grok MED #2 — entry-point guard symlink resolution**.
  v0.8.7's guard compared `path.resolve(process.argv[1])` against
  `fileURLToPath(import.meta.url)`. The latter is already a realpath;
  the former isn't. Under a plugin-cache symlink, npm `.bin/` shim,
  or case-insensitive macOS volume, the comparison falsely failed
  and `main()` silently didn't run. **Fix**: both sides resolved via
  `fs.realpathSync` with a fallback to the non-resolved form on
  ENOENT.

### Tests

- 2 new behavioral tests asserting the corrected guard shape + the
  realpath resolution.
- Total suite: 279 passing.

## [0.8.7] - 2026-05-15

`/goal` round-8 review of v0.8.6: 3/3 consensus on a single CRITICAL
regression + a real per-reviewer accounting bug from Grok.

### Bug fixes

- **3/3 reviewer consensus — `--timeout 0` broke the CLI fallback**.
  v0.8.6's `Math.max(0, timeoutMs - elapsed)` collapsed to 0 for the
  documented "unbounded" sentinel, then the `< 5000` guard always
  tripped → fallback silently skipped, gemini workaround regressed.
  **Fix**: `remainingBudgetMs(timeoutMs, elapsed)` now treats 0 as a
  passthrough (returns 0 = unbounded). The skip-guard now requires
  `timeoutMs > 0 && budget > 0 && budget < FALLBACK_MIN_BUDGET_MS`.

- **Grok HIGH #2 — batch wall-clock starved fast buggy peers**.
  v0.8.6 used a single `startedAtMs` for the whole `Promise.all`. If
  the slowest sibling took 9 of 10 minutes, the gemini fallback got
  ~1 min of budget even though gemini's own peer attempt took 8s.
  **Fix**: per-reviewer accounting via each `r.elapsedMs` (already
  recorded by `spawnReviewer`).

- **Grok MED #3 — FALLBACK_MIN_BUDGET_MS too aggressive at 5000ms**.
  Spawn cold path can eat 2-6s on a loaded machine. Lowered to 2000ms
  (and named the constant explicitly so it's no longer magic).

- **Grok MED #4 / Grok LOW #5 / Grok LOW #6 — testability**.
  Predicate + budget logic extracted to module-scope helpers
  (`shouldFallbackToCli`, `isPeerEmptyDiffMessage`, `remainingBudgetMs`,
  `MAX_PEER_EARLY_EXIT_BYTES`, `FALLBACK_MIN_BUDGET_MS`), all
  exported. Replaces 3 source-grep tests with 10 behavioral ones that
  exercise edge cases (parsed-verdict-with-mid-prose-phrase,
  long-output-rejection, empty-diff-rejection, anchored-regex,
  per-reviewer budget, unbounded passthrough).

- **Grok LOW — dead `startedAt` alias**. Removed.

- **Test infrastructure**. v0.8.7's helper extraction means test
  files now `import` from companion.mjs to call the helpers directly.
  Without a guard, every import would trigger `main()` with no
  subcommand → usage error → test failure. Gated `main()` on
  `process.argv[1] === fileURLToPath(import.meta.url)` so importing
  the module no longer runs the CLI dispatcher.

### Tests

- 10 new behavioral tests on the extracted helpers (replaces 3
  source-grep tests).
- Total suite: 277 passing.

## [0.8.6] - 2026-05-15

`/goal` round-7 (the first round where Gemini actually delivered a
review, via the v0.8.5 CLI fallback). All 3 reviewers converged on the
same bug in the v0.8.5 workaround itself.

### Bug fixes

- **3/3 reviewer consensus — fallback predicate was too greedy**.
  v0.8.5's check `/Nothing to review/i.test(r.output)` was unanchored
  → a real review that contained the phrase "nothing to review" in
  prose (e.g. "nothing to review in the test utilities because...")
  would have its real findings silently discarded and replaced with
  a redundant CLI rerun. **Fix**: tightened to require all of:
    1. `r.via === "peer"` (only retrying peer routing)
    2. `r.verdict === "UNPARSED"` (a real review always has VERDICT:)
    3. output starts with "Nothing to review" (anchored ^ regex)
    4. output length < 400 bytes (real reviews are multi-KB)
    5. our captureDiff DID find a non-empty diff

- **Gemini MED — fallback timeout budget was effectively doubled**.
  v0.8.5 passed the full `timeoutMs` to the CLI re-spawn, so a user
  who configured a 10-minute timeout could end up waiting 20 minutes
  (peer attempt + full CLI attempt). **Fix**: track wall-clock at
  the start of the parallel batch, compute `remainingMs = max(0,
  timeoutMs - elapsed)`, pass that to the fallback. If < 5s remains,
  skip the fallback entirely and keep the peer result.

- **Grok LOW — dead field `peerFallbackFrom`**. v0.8.5 wrote
  `newResult.peerFallbackFrom = "peer"` but nothing ever read it.
  Removed.

### Tests

- 3 new behavior tests asserting the tightened predicate shape, the
  remaining-budget calculation, and the removed dead field.
- Total suite: 269 passing.

## [0.8.5] - 2026-05-15

Self-healing workaround for [gemini-plugin-cc#4](https://github.com/taibaran/gemini-plugin-cc/issues/4).

### Background

While running `/grok:aggregate-review` repeatedly during the v0.8.x
`/goal` loop, Gemini's verdict came back as "Nothing to review" every
single round — even when the diff was clearly non-empty. Root cause
(reported upstream): gemini-plugin-cc's `captureDiff` for
`--scope branch` calls `git diff -- <ref>...HEAD`. The `--` separator
makes git interpret the ref-range as a *pathspec* (non-existent file)
instead of a refspec, returning 0 bytes + exit 0 + spurious "Nothing
to review". The fallback to the no-`--` form only fires on non-zero
exit, which never triggers.

Verified: grok-plugin-cc (this repo) and openai/codex-plugin-cc do
**not** have this bug — only gemini-plugin-cc.

### What v0.8.5 does

In `/grok:aggregate-review`, after collecting peer-routed results, if
ANY peer reviewer returned a "Nothing to review" message AND our own
`captureDiff` shows the diff is non-empty, we **re-spawn that
reviewer with the raw CLI path** (the v0.7.0 fallback that uses our
captured diff via `-p ""` + stdin or `--prompt-file`). The original
peer attempt's wasted ~150ms is dwarfed by the time saved getting a
real review.

The per-reviewer detail in the report now annotates the routing path
as `cli-fallback` instead of `peer` when this triggers, so users can
see exactly what happened.

### Self-healing semantics

When gemini-plugin-cc ships a fix for #4, peer routing will produce
real output and the "Nothing to review" check won't match → no
fallback triggers → fast peer-plugin routing resumes. No code change
needed on this side.

### Tests

- 266 passing (unchanged — the fallback is exercised end-to-end the
  next time `/grok:aggregate-review` runs against a real diff). A
  behavioral test with stacked fake-grok + fake-gemini + fake-codex
  binaries would add real coverage; tracked for a future round.

## [0.8.4] - 2026-05-15

`/goal` loop round-5: aggregate-review against v0.8.2 surfaced 1
CRITICAL security regression + 3 test-quality issues (Codex + Grok
agreed; Gemini still "nothing to review").

### Security

- **Codex P1 — subagent Bash scope** (`agents/grok-aggregate-review.md`,
  `agents/grok-rescue.md`). Both subagents declared `tools: Bash`
  (unrestricted). A prompt-injection vector in `$ARGUMENTS` could
  bypass the prompt-level "only call companion.mjs" guidance and run
  arbitrary shell commands. **Fix**: scoped both subagents'
  permissions to `Bash(node:*)` — Claude Code's tool-permission layer
  now enforces "node-only" regardless of prompt text.

### Test quality (Codex P2 + Grok M1 + Grok L2 + Grok L3)

- **Race + vacuous-pass in promptFile-leak test**. v0.8.2's test
  counted `os.tmpdir()` files globally → racy against concurrent
  greps, and on a machine without `grok` on PATH cmdReview's
  `which("grok")` guard exited BEFORE the timeout path, so the test
  passed without exercising the code. **Fix**: put a fake-grok on
  PATH + set TMPDIR to an isolated dir so the readdir is scoped only
  to files this test could have created.

- **Missing coverage for grokBaseArgs failure path**. The v0.8.2
  reordering protected TWO early-exit sites (`grokBaseArgs` throw +
  `resolveTimeoutMs` exit) but only the latter had a behavioral test.
  Added a parallel test that triggers `grokBaseArgs` via an invalid
  `--allow` rule (control byte) and asserts no leak.

- **Source-grep test for cmdTask spread order**. The v0.8.2 commit
  added a source-grep test in the same change that explicitly
  rejected source-grep tests for cmdReview — direct contradiction.
  Replaced with a behavioral assertion: spread `{effort:"low"}`
  followed by explicit `effort:"high"` into `grokBaseArgs` must emit
  exactly one `--effort high`, locking the merge semantics rather
  than the source-string shape.

### Tests

- 3 new behavior tests (replaced 2 brittle ones).
- Total suite: 266 passing.

## [0.8.3] - 2026-05-15

UX/architecture fix: `/grok:aggregate-review` now appears as an **agent**
operation in Claude Code (via the `Agent` tool), not as a raw shell call.

### What changed

- **New subagent**: `plugins/grok/agents/grok-aggregate-review.md`
  (model: sonnet, tools: Bash). A thin forwarder — its only job is to
  invoke `node companion.mjs aggregate-review ...` and return stdout
  verbatim. Matches the existing `grok:grok-rescue` pattern.
- **Slash command rewritten**: `plugins/grok/commands/aggregate-review.md`
  now dispatches through `Agent(subagent_type: "grok:grok-aggregate-review")`
  instead of invoking Bash directly. Includes `--background`/`--wait`
  execution-mode handling per the rescue pattern.

### Why

Users reported the command "appeared as shell, not as a grok agent" in
the Claude Code UI. The underlying mechanics are identical — companion.mjs
still does the parallel codex/gemini/grok orchestration with the peer
plugin routing from v0.7.1 — but the user-visible tool surface is now
`Agent` rather than `Bash`. This matches how `/grok:rescue` ships and
gives the command a consistent agent-style entry point.

### Tests

- Updated `tests/v0-7-0-aggregate-review.test.mjs` to assert on the
  new agent-routing structure (subagent_type, allowed-tools includes
  Agent, agent definition file shape).
- Total suite: 265 passing.

## [0.8.2] - 2026-05-15

Round-3 fixes — `/goal` loop iteration on the v0.8.x line. The
aggregate-review against v0.8.1 surfaced one real bug (Grok LOW about
incomplete coverage of early-exit leak paths) and two defensive
improvements.

### Bug fixes

- **Grok LOW (real bug) — second promptFile leak path in cmdReview**.
  v0.8.1 added `try { unlink } catch {}` to the `grokBaseArgs` catch,
  but `resolveTimeoutMs(flags.timeout)` calls `process.exit(2)` on an
  invalid `--timeout` AFTER `writePromptToTempFile` had already run.
  **Fix**: reordered cmdReview so EVERY flag validation
  (`grokBaseArgs`, `resolveTimeoutMs`) runs BEFORE
  `writePromptToTempFile`. The temp file is now allocated only once
  the call is guaranteed to proceed; runJob's existing `cleanupPaths`
  handles unlinking on success/error/timeout/disk-overflow.

- **Grok MED — `cmdTask` spread order**. The v0.8.1 code wrote
  `{ effort, ...extractPolicyFlags(flags) }`, putting the explicit
  (validated) `effort` BEFORE the spread. If `extractPolicyFlags` ever
  grows an `effort` key, the spread would silently overwrite the
  validated value. Defensive reordering: spread first, explicit
  `effort` last → explicit always wins.

- **Grok LOW (test brittleness) — source-grep test for cmdReview
  cleanup**. Replaced with a behavioral test that actually invokes
  `companion.mjs review --timeout nonsense_value` against a tiny git
  repo + dirty working tree, then checks `/tmp` for grok-prompt-*
  files. Immune to Prettier / refactor / formatting changes.

### Defensive additions

- New regression test that `grokBaseArgs({ effort: "high" })` actually
  emits `--effort high`. Closes Grok's HIGH false-alarm by locking
  behavior in source-of-truth rather than relying on a future reader
  to trace the function definition.

### Tests

- 3 new behavior tests in `tests/v0-8-0-permission-rules.test.mjs`
  (1 replaces a brittle one).
- Total suite: 264 passing.

## [0.8.1] - 2026-05-15

Round-2 fixes for v0.8.0, found by running the new `/grok:aggregate-review`
on v0.8.0's own diff (HEAD~1..HEAD). Codex (via peer) flagged 3 issues
and Grok (via peer) flagged 5 — every fix below traces to a real
reviewer-found bug.

### Bug fixes

- **Grok HIGH — `--restore-code` dead flag**. Was added to
  `COMMON_BOOL_FLAGS` in v0.8.0 but never wired to `extractPolicyFlags`,
  `grokBaseArgs`, or `capabilityProbe`. Silently dropped. **Removed**
  from the flag set until v0.9.0 builds out the resume path.

- **Grok MEDIUM — control-byte regex allowed TAB + LF**
  (`lib/grok.mjs::validateRuleArray`). The v0.8.0 regex
  `[\x00-\x08\x0b-\x1f\x7f]` accepted `\x09` (tab) and `\x0a` (newline).
  A `--rules "evil\nadditional directive"` could survive validation and
  end up echoed back into model context. **Fix**: split into two
  validators — `CONTROL_BYTE_STRICT` (no TAB, no LF, used by
  `--allow`/`--deny`/`--rules`/`--tools`/`--sandbox`/`--agent`) and
  `CONTROL_BYTE_MULTILINE` (TAB + LF + CR allowed, used by
  `--system-prompt-override` since real system prompts have
  paragraphs).

- **Grok MEDIUM — `cmdTask` skipped policy flags**
  (`companion.mjs::cmdTask`). The v0.8.0 changelog claimed "Permission
  Model Parity" but `/grok:task` (the write-mode rescue) still called
  `grokBaseArgs({readOnly, model, jsonOutput})` directly, dropping
  `--allow`/`--deny`/`--rules`/`--max-turns`/etc. **Fix**: `cmdTask`
  now uses `...extractPolicyFlags(flags)` like the other commands.

- **Codex P2.a — `cmdReview` leaked prompt file on validation failure**
  (`companion.mjs::cmdReview`). Calling `/grok:review --max-turns nope`
  would write the full diff prompt file via `writePromptToTempFile`,
  then `grokBaseArgs` would throw on the invalid `--max-turns`, and
  the early-exit path would leave the file in `/tmp`. **Fix**:
  `try { fs.unlinkSync(promptFile) } catch {}` inside the catch.

- **Codex P2.b — `cmdInspect` had no `maxBuffer`**
  (`companion.mjs::cmdInspect`). `grok inspect` output can exceed
  spawnSync's 1 MiB default in projects with many skills/MCPs;
  exceeded buffer left `r.status: null` and the helper exited 0 with
  truncated output. **Fix**: explicit `maxBuffer = HEADLESS_GROK_MAX_BUFFER`
  + ENOBUFS detection + hint pointing the user at `--json` redirect.

- **Codex P3 — `--flag=value` corrupted values containing `=`**
  (`lib/args.mjs::parseArgs`). The old `t.slice(2).split("=", 2)` form
  returns only the first 2 array slots, so `--system-prompt-override=Use A=B`
  became `{key: "system-prompt-override", value: "Use A"}` — the trailing
  `=B` was silently dropped. **Fix**: split on FIRST `=` using
  `indexOf("=")` + slice, preserving every `=` after the first separator.

### Tests

- 9 new regression tests in `tests/v0-8-0-permission-rules.test.mjs`.
- Total suite: 262 passing.

## [0.8.0] - 2026-05-15

**"Permission Model Parity + Inspectability"** — the v0.8.0 release the
4-LLM research pass (Codex + Gemini + Grok + Claude general) unanimously
picked as the highest-value next step.

### New commands

- **`/grok:inspect [--json]`** — wraps `grok inspect`. Shows the merged
  config (AGENTS.md, skills, MCP, rules, permissions, LSP, hooks) that
  will apply to the next call. All 4 LLMs flagged this as a gap: the
  single most useful "why is grok doing X?" debugging tool was
  unreachable from inside Claude Code.

### New flags (threaded through ask / review / research / best-of)

- **`--allow <rule>` / `--deny <rule>`** (repeatable) — fine-grained
  permission rules with `ToolPrefix(glob)` syntax: `--allow "Bash(npm*)"
  --deny "Bash(sudo*)"`. Strictly better than the old coarse
  `READ_ONLY_DISALLOWED_TOOLS` constant.
- **`--tools <list>`** — explicit allowlist of tool names; sharper than
  denylist for /grok:ask read-only-by-intent.
- **`--rules <text|@file>`** (repeatable) — per-call system-prompt
  guardrails without touching AGENTS.md.
- **`--max-turns <N>`** — user override of the hardcoded plugin defaults
  (ask=30, review=60, research=200, best-of=30). The default is still
  applied when `--max-turns` is absent.
- **`--no-subagents` / `--no-plan` / `--verbatim`** — Grok CLI kill-switches.
- **`--reasoning-effort <effort>`** — distinct from `--effort`; applies
  only to reasoning models.
- **`--system-prompt-override <prompt>`** — advanced; size-capped at 16 KiB.
- **`--permission-mode <mode>`** — user-selectable
  (`default|acceptEdits|auto|dontAsk|bypassPermissions|plan`).
- **`--sandbox <profile>`** — `GROK_SANDBOX` equivalent; profile name
  validated against control bytes + path separators.
- **`--agent <name>`** — pick a bundled Grok agent persona.

### Hardening

- **`validateRuleArray()`** in `lib/grok.mjs` — every `--allow`/`--deny`/
  `--rules` entry is sanity-checked: max 256 entries, max 1 KiB per
  entry, no control bytes (prompt-injection defense). Same defense
  applied to `--system-prompt-override`, `--sandbox` profile name, and
  `--agent` name.
- **`capabilityProbe` extended** — `--allow`, `--deny`, `--tools`,
  `--rules`, `--no-subagents`, `--no-plan`, `--reasoning-effort`,
  `--system-prompt-override`, `--verbatim`, `--sandbox`, `--agent`. Same
  G1 motivation as v0.6.0: if grok renames any of these, setup fails
  cleanly instead of users hitting "unknown option" at runtime.

### Parser changes

- New `COMMON_REPEATABLE_FLAGS` set + `repeatableFlags` parser option.
  `--allow`/`--deny`/`--rules` accumulate into arrays; non-repeatable
  flags still overwrite (last-wins).
- New `COMMON_VALUE_FLAGS` entries: `tools`, `max-turns`,
  `reasoning-effort`, `system-prompt-override`, `permission-mode`,
  `agent`, `sandbox`.
- New `COMMON_BOOL_FLAGS` entries: `no-subagents`, `no-plan`, `verbatim`,
  `restore-code`.

### Cross-command consistency

- `/grok:review` and `/grok:adversarial-review` now accept `--check`.
- All policy flags above are accepted across ask / review / research /
  best-of (via the new shared `extractPolicyFlags()` helper).

### Tests

- 21 new behavior tests in `tests/v0-8-0-permission-rules.test.mjs`:
  parser accumulation, grokBaseArgs validators, end-to-end argv
  capture via fake-grok, capabilityProbe regression.
- Total suite: 252 passing.

## [0.7.3] - 2026-05-15

Two real bugs discovered while running the v0.8.0 research pass with
all four LLMs against the plugin's own source tree.

### Bug fixes

- **Grok doom-loop on plugin skill discovery** (`lib/grok.mjs`).
  When `grok` is spawned in a directory containing the plugin source
  (the dev tree or any project that bundles the plugin), grok
  auto-discovers `plugins/grok/skills/grok-cli-runtime`,
  `grok-prompting`, and `grok-result-handling` and exposes them as
  callable tools. The model then calls `grok-cli-runtime` as if it
  were an integration tool; the CLI panics ("`use_tool can only
  dispatch to integration tools`"); after 5 repeats the doom-loop
  guard terminates the session with no useful output. Fix: added the
  three skill names to `READ_ONLY_DISALLOWED_TOOLS` and
  `AUTH_PROBE_DISALLOWED_TOOLS` via a new
  `GROK_PLUGIN_SKILL_NAMES` constant so grok never sees them as tools.

- **`DEFAULT_RESEARCH_MAX_TURNS` was too low** (`companion.mjs`).
  The 60-turn budget was tripping users with `Internal error:
  max_turns exceeded` on legitimate deep research prompts that
  require reading 10-20 files (each file read burns a turn). Bumped
  to 200, with a comment noting `--timeout` is the real DoS guard.

### Tests

- 5 new regression tests in `tests/v0-7-3-grok-skill-doom-loop.test.mjs`.
- Total suite: 231 passing.

## [0.7.2] - 2026-05-15

Round-2 bug fixes for `/grok:aggregate-review`, found by running
the v0.7.1 dogfood (`/grok:aggregate-review --base HEAD~1 --scope branch`)
against v0.7.1 itself. Codex (via peer) and Grok (via peer) both
flagged real issues.

### Bug fixes

- **Grok BLOCKING — `spec.isPlainText` regression**
  (`companion.mjs::spawnReviewer`). The v0.7.0 round-2 fix that
  gates `parseGrokJson` behind a plain-text marker was scoped to
  `spec.isPlainText`, but `isPlainText` is a property of the
  `buildCmd` RETURN value, not of the spec itself. `spec.isPlainText`
  was always `undefined`, so the guard was always taken — exactly
  the regression v0.7.0 round-2 was supposed to fix. Now reads
  `buildResult.isPlainText`.

- **Codex P1 — `Verdict: needs-attention` slipped past failure check**
  (`companion.mjs::parseAggVerdict` + aggregate exit code logic).
  `codex-plugin-cc`'s review renderer writes `Verdict: needs-attention`
  (lowercase, hyphenated). The old `[A-Z_]+` capture tokenized that
  as `NEEDS`, which the failure check (REJECT/UNPARSED/etc.) didn't
  recognize. Codex findings could therefore aggregate as
  `Status: ok`. v0.7.2 widens the char class to `[A-Za-z_-]+`,
  normalizes hyphens-to-underscores and case-to-uppercase
  (`NEEDS_ATTENTION`), and inverts the failure check to an
  explicit-good whitelist (`AGG_CLEAN_VERDICTS`) so future
  unrecognized verdicts default to failure.

- **Codex P2 — peer plugin counted without CLI presence**
  (`AGG_REVIEWERS[*].detect`). Returning `{kind: "peer"}` whenever
  the cached companion.mjs file exists treated an installed plugin
  as an installed reviewer. If the user has the peer plugin cached
  but the underlying CLI isn't on PATH, the command can pass the
  "at least two reviewers" guard and then fail inside the peer
  with setup/127 errors. v0.7.2 requires both peer plugin AND
  `which(name)` for peer routing.

- **Codex P2 — focus text dropped on peer route**
  (`AGG_REVIEWERS[*].buildCmd`). The aggregate prompt's `focus`
  positional was passed to the CLI fallback path but never reached
  peer reviewers. Now: when focus is non-empty, every reviewer
  auto-switches its sub to `adversarial-review` (which accepts a
  trailing focus positional in all three peer plugins) and the
  focus is appended to the args.

### Tests

- 5 new behavior tests covering the four fixes above.
- Total suite: 226 passing.

## [0.7.1] - 2026-05-15

Architectural fix for `/grok:aggregate-review` — addresses a real
concern raised by the user during v0.7.0 review: spawning raw
codex/gemini binaries from inside our Node code bypassed each peer
plugin's safety layer.

### What changed

Each reviewer's `detect()` now returns either `{kind: "peer", path}`
(peer plugin's companion.mjs found in `~/.claude/plugins/cache/`) or
`{kind: "cli", path}` (raw CLI on PATH). The reviewer's `buildCmd()`
routes through whichever was found.

Peer routing invokes `node <peer-companion>.mjs <review|adversarial-review> --wait`,
which:
- Inherits the peer plugin's prompt-file handling (no ARG_MAX risk).
- Inherits the peer plugin's env scrubbing + ANSI sanitization.
- Inherits the peer plugin's capability probes + auth handling +
  fallback model chain.
- Is sync-by-design (`--wait` blocks until the job completes).

The previous raw-CLI path (with v0.7.0 round-2 hardening) stays as
the fallback when a peer plugin isn't installed.

### Why not the rescue subagents directly

`codex:codex-rescue` and `gemini:gemini-rescue` return acknowledgement
stubs instead of actual results (upstream bug — see
[openai/codex-plugin-cc#324](https://github.com/openai/codex-plugin-cc/issues/324)
and [taibaran/gemini-plugin-cc#3](https://github.com/taibaran/gemini-plugin-cc/issues/3)).
Until those land, calling each peer plugin's `companion.mjs review --wait`
directly is the best available route through the peer plugin layer.

### Output changes

- Header line now annotates each reviewer with `(via peer)` or `(via cli)`.
- Per-reviewer detail line shows `Via: peer` / `Via: cli`.

### Tests

- 5 new behavior tests cover: `findPeerCompanion` semver-descending
  version pick; `PEER_PLUGIN_LOOKUP` coverage of codex / gemini / grok;
  each reviewer's `detect()` consulting `findPeerCompanion` first;
  `<sub> --wait` being passed to all 3 peer plugins; output annotations.
- Total suite: 222 passing.

## [0.7.0] - 2026-05-15

Meta-aggregator command for multi-LLM consensus reviews.

### New commands

- **`/grok:aggregate-review [focus]`** — captures the current diff (same
  scope rules as `/grok:review`) and runs it through every installed
  peer CLI in parallel: Codex, Gemini, Grok. Aggregates verdicts into a
  unified markdown report with a per-reviewer detail section and a
  summary table (verdict + blocking count + nits count + elapsed time).
  Exits 1 if any reviewer returned `VERDICT: REJECT`, 0 otherwise.

  Per-reviewer command shapes (cross-checked against each CLI's --help):
    - `codex exec --skip-git-repo-check` with prompt on stdin
    - `gemini --skip-trust --approval-mode plan -p <prompt>`
    - `grok -p <prompt>` with the plugin's standard read-only flags
      (--permission-mode plan + --disallowed-tools)

  Defense-in-depth: every peer CLI is spawned with `cleanGrokEnv()` —
  the same env-scrubbing allowlist used for the local grok process. A
  compromised codex/gemini binary cannot exfiltrate ANTHROPIC_API_KEY,
  AWS_*, etc. through this path.

  Default per-reviewer timeout: 10 minutes. Override via `--timeout`.
  Requires at least two peer CLIs installed; the command refuses to run
  with only one because that's just `/grok:review` with extra steps.

### Tests

- 6 new structural + behavior tests in `tests/v0-7-0-aggregate-review.test.mjs`.
  Total suite: 208 passing.

## [0.6.0] - 2026-05-15

Three Grok-specific differentiator commands plus refactor of the headless
dispatcher. Four independent reviewers (Claude / Codex / Gemini / Grok)
audited across two rounds; eight real bugs and seven nits all landed in
this release.

### Round-2 bug fixes (Codex + Gemini)

- **Codex-A. ANSI escapes inside JSON `text` reach the terminal**
  (`companion.mjs::runHeadlessGrok`). `parsed.text` came from JSON which
  preserves `` payloads byte-for-byte through `JSON.parse`. Without
  `sanitizeForTerminal()` those reached the user's terminal raw (OSC 52
  clipboard injection, cursor moves, screen clear, color-spoofed phishing
  banners). Helper now sanitizes `parsed.text` and `parsed.message`.
  (Codex review.)

- **Codex-B. Non-timeout `spawnSync` errors mis-exit 0**
  (`companion.mjs::runHeadlessGrok`). `ENOBUFS` from a long /grok:research
  output left `r.status = null` and the helper still parsed + exited 0.
  Now sets explicit `maxBuffer = HEADLESS_GROK_MAX_BUFFER (32 MiB)` and
  refuses ALL non-ETIMEDOUT `r.error` codes, with a dedicated ENOBUFS
  hint pointing the user at `/grok:rescue` / `/grok:task` for streaming
  long-form sessions. (Codex review.)

- **Codex-C / Gemini-G1. ANSI injection through `/grok:models` footer**
  (`companion.mjs::cmdModels`). The footer used to print
  `effectiveModel()`, `cfg.activeModel`, and `GROK_PLUGIN_MODEL` raw —
  any of those is reachable via env or prompt-injection. All footer
  values now route through `sanitizeForTerminal()`. The `--set-default`
  positional gets a 128-char length cap (`MAX_MODEL_ID_LEN`) as
  defense-in-depth before reaching `setActiveModel`'s strict
  `MODEL_ID_PATTERN` validator. (Codex + Gemini.)

- **Codex. `/grok:models` has no timeout / auth hint**. An auth or
  network hang would block `/grok:models` indefinitely. Default timeout
  is now 30s (`DEFAULT_MODELS_TIMEOUT_MS`), overridable via `--timeout`.
  Auth failures route through `classifyAuthBlob` the same way
  `/grok:ask` does. (Codex review.)

- **Gemini-G2. `/grok:research` / `/grok:best-of` rejected `--effort MAX`**
  (`companion.mjs::cmdResearch`, `cmdBestOf`). `cmdAsk` normalized
  effort via `validateEffort()` (lowercases/trims); these two bypassed
  it and passed the raw user value to `grokBaseArgs` which does
  strict-case whitelist matching. `/grok:research --effort MAX` crashed
  while `/grok:ask --effort MAX` succeeded — surprising drift. Both
  now use `validateEffort`. (Gemini review.)

- **Gemini-G3. Tautological tests in `tests/v0-6-0-features.test.mjs`**.
  The `E2E: research default chain` test reproduced cmdResearch's
  internal default-flag logic in the test body and asserted on its own
  local variables. If `cmdResearch` broke, the test still passed.
  Replaced with subprocess-against-fake-grok tests in
  `tests/v0-6-0-round2-fixes.test.mjs` — runs the real `companion.mjs`
  with a fake `grok` on `$PATH` that records its argv to disk, then
  asserts on what the real CLI actually received. (Gemini review.)

### Round-2 nits (Gemini)

- **N2. `/grok:ask` silently ignored `--no-web-search`** — the flag
  parsed correctly but `cmdAsk` didn't thread `disableWebSearch` through
  to `grokBaseArgs`. Fixed; behaviorally tested.

- **N3. `VALID_EFFORTS` in `companion.mjs` duplicated
  `EFFORT_LEVELS` in `lib/grok.mjs`** — drift risk. Removed the local
  duplicate; `validateEffort` now consumes the canonical
  `EFFORT_LEVELS` import.

- **/grok:models auth-hint** (Codex) — added `[hint: auth expired …]`
  message when `grok models` fails with a recognizable auth blob,
  matching `/grok:ask` behavior.

### Round-1 fixes (Claude general / Grok — already landed before round-2)

### New commands (initial v0.6.0 scope)

- **`/grok:research <question>`** — deep research mode. Defaults: `--effort max`
  + `--check` self-verification loop + live web search ON. Override hooks:
  `--effort low|medium|high|xhigh|max`, `--no-check`, `--no-web-search`.

- **`/grok:models [--set-default <id>]`** — wraps `grok models`. With
  `--set-default <id>` (or `--set-default` followed by a positional id),
  persists the model into the workspace `activeModel` config. Footer shows
  the four-tier precedence: per-call `--model` > `GROK_PLUGIN_MODEL` env
  > workspace `activeModel` > plugin `DEFAULT_MODEL`.

- **`/grok:best-of <N> <prompt>`** — wraps `grok --best-of-n N`. Grok runs
  the prompt N ways in parallel and returns its best answer. Plugin caps
  N at `BEST_OF_N_MAX = 8` (each branch is full token-spend; the cap
  prevents accidental N=50 runs). Two argv forms accepted:
  `best-of 3 <prompt>` and `best-of --best-of-n 3 <prompt>`.

### Bug fixes from reviewer round

- **G1. Capability probe didn't verify v0.6.0 flags** (`lib/grok.mjs`).
  `capabilityProbe()` checked the v0.4.0-era core flags only. On a pre-0.6
  `grok` binary, `/grok:setup` would have reported green while
  `/grok:research` then failed at runtime with "unknown option: --effort".
  Required list now includes `--effort`, `--check`, `--best-of-n`,
  `--disable-web-search`. (Grok review.)

### Refactors

- **`runHeadlessGrok` extracted** (`companion.mjs`). The ~30-line tail
  (spawn → ETIMEDOUT handling → `parseGrokJson` dispatch → auth-hint
  emission → exit-code mapping) used to be copy-pasted across `cmdAsk`,
  `cmdResearch`, and `cmdBestOf`. v0.5.0's `[hint: ...]` lines would
  have only landed in one of three callers if not for this. Single
  source of truth now. (Claude general review nit-1.)

- **`bestof` → `best-of`** (`companion.mjs`, `commands/best-of.md`).
  Matches the hyphenated multi-word convention from `imagine-video` /
  `adversarial-review`. (Claude general review nit-2.)

- **`--no-check` flag for `/grok:research`** (`lib/args.mjs`,
  `companion.mjs`). Research mode defaults `--check` on; previously
  no documented way to disable. Now `--no-check` mirrors the
  `--no-web-search` shape. (Claude general review nit-5.)

### Tests

- 41 new behavior tests across `tests/v0-6-0-features.test.mjs` and
  `tests/v0-6-0-round2-fixes.test.mjs`. Total suite: 202 passing.
  Round-2 tests run `companion.mjs` as a subprocess with a fake `grok`
  on `$PATH` (writing its argv to disk, env-stripped by `cleanGrokEnv`
  so handoff uses a sibling `mode` file). This replaces the tautological
  reproduce-the-logic patterns Gemini flagged in round-2-G3.

### Known gaps (deferred from this release)

Grok review surfaced five missing Grok-CLI features the plugin doesn't
yet expose. Tracking for follow-up patches:

- `--sandbox <profile>` — kernel-level fs/net isolation (Grok's distinct
  security boundary vs. Claude/Codex/Gemini).
- `--worktree` — first-class git-worktree session isolation.
- Memory controls — `--no-memory` / `--experimental-memory`.
- Session resume — `--continue` / `--resume` from headless commands.
- MCP surface — `grok mcp` subcommands for managing external tool servers.

## [0.5.0] - 2026-05-15

Comprehensive 4-reviewer round (Claude / Codex / Gemini / Grok) surfaced
a fresh set of attack surfaces and code-quality opportunities. Five real
bugs + four refactor items addressed.

### Real bugs

- **C1. `findLastVerdictInString` O(n²) scan** (`lib/verdict.mjs`).
  Same pathological-input vulnerability Codex flagged for
  `findLastJsonObject` in round 4 — a wall of `{` chars with no `}`
  triggered N independent scans-to-EOF. The verdict scanner now uses
  the same `MAX_FAILED_SCANS_PER_CALL = 128` cap. (Codex.)

- **C2. Disk exhaustion via unbounded job logs** (`companion.mjs::runJob`).
  An adversarial prompt trapping Grok in an output loop could silently
  fill the host filesystem before the timeout fired. Added
  `MAX_JOB_LOG_BYTES = 500 MiB` cap: on overflow the process tree is
  terminated and the job is marked `disk-overflow`. (Gemini.)

- **C3. TOCTOU race in `/grok:result`** (`lib/state.mjs`,
  `companion.mjs`). The previous flow `safeJobLogPath` → `fs.openSync`
  had a race window in shared-machine environments where an attacker
  could swap a valid log for a symlink between the validation and the
  open. New `readBoundedJobLog` opens with `O_NOFOLLOW` (rejects
  symlink leaves), `fstat`s the opened fd (rejects non-regular files),
  and reads bounded — all through a single fd, no path-string races.
  (Gemini.)

- **C4. TerminalSanitizer pending-buffer DoS** (`lib/render.mjs`).
  An attacker streaming an unterminated ANSI sequence (`ESC [`
  followed by infinite chars without a terminator) would grow
  `this.pending` without bound and OOM the Node process. Cap at
  `MAX_PENDING_ESCAPE_BYTES = 4 KiB`: anything past this length is
  force-sanitized and dropped. (Gemini.)

- **C5. Default task timeout was `0` (unbounded)** (`companion.mjs`).
  Bumped to 2 hours — a hard backstop for runaway rescue agents
  while preserving the open-ended-by-design property for legitimate
  long rescues. Users can still pass `--timeout 0` to opt back into
  unbounded behavior. (Gemini.)

### Refactor

- **C6 + C9. Shared envelope parser and prompt-file helper.**
  `parseGrokJson` and `writePromptToTempFile` were each duplicated
  verbatim in `companion.mjs` AND `stop-review-gate-hook.mjs`.
  Both moved to `lib/grok.mjs` as exports. The duplication risk
  Codex flagged in round 3 (parsers could drift over time) is closed:
  one source of truth, used by both call sites. (Codex + Claude.)

- **C7 (partial). Behavior tests for newly-exported helpers.**
  Added 15 tests in `tests/v0-5-0-hardening.test.mjs` that exercise
  `parseGrokJson`, `writePromptToTempFile`, `readBoundedJobLog`, and
  `parseVerdict` directly — these used to be private and only
  source-shape-tested. Full conversion of all source-regex tests is
  v0.5.1 work. (Claude.)

- **C8 (deferred). Mock-grok integration tests.** Tracked for v0.5.1.

### Tests

- 161 tests (was 146 in v0.4.0). All passing.

## [0.4.0] - 2026-05-15

Round 3 of independent review. Codex, Gemini, and Grok all approved v0.3.0
for production but surfaced 8 follow-up improvements (4 real bugs, 4
defense-in-depth). All 8 are addressed here. 141 tests total (was 121).

### Real bugs fixed

- **B1. UTF-8 chunk tearing** (`companion.mjs::runJob`,
  `stop-review-gate-hook.mjs`). `proc.stdout.on("data", d => d.toString())`
  on raw Buffer chunks decodes multi-byte UTF-8 sequences split across
  chunks to `U+FFFD`, silently corrupting the JSON envelope and any
  user-visible output. Fix: `proc.stdout.setEncoding("utf8")` so Node's
  internal StringDecoder buffers incomplete sequences across data events.
  (Gemini round-3.)

- **B2. Branch diff capture used wrong git argument order** (`lib/git.mjs`).
  `git diff -- <ref>...HEAD` makes git interpret the refspec as a pathspec
  — the command exited 0 with empty output and the fallback never fired,
  silently producing "nothing to review" for any `--scope branch` review.
  Fix: drop the misplaced `--`; the refspec validator already prevents
  flag injection. (Codex round-3.)

- **B3. Read-only tool policy was inconsistent across call sites**
  (`lib/grok.mjs`). `grokBaseArgs` banned 3 tools, `authProbe` banned 6.
  Extracted to named constants `READ_ONLY_DISALLOWED_TOOLS` (banishes
  writes + shell but keeps web search + Agent for grounding) and
  `AUTH_PROBE_DISALLOWED_TOOLS` (banishes all tools for the deterministic
  probe). The difference is now intentional, named, and traceable.
  (Codex round-3.)

- **B4. `parseGrokJson` did not match the stop-gate's robust parser**
  (`companion.mjs`, `lib/verdict.mjs`). The companion called
  `JSON.parse(clean)` on the whole blob and silently fell through to
  "unknown" — any tracing noise between the envelope and EOF flipped error
  envelopes to "completed". Extracted `findLastJsonObject` into
  `lib/verdict.mjs` and used in both `parseGrokJson` (companion) and
  `parseGrokJsonEnvelope` (hook). The two parsers can no longer drift.
  (Codex round-3.)

### Defense-in-depth

- **B5. `/grok:result` reads are now bounded** (`companion.mjs`). New
  `readBoundedFile` caps stdout/stderr display reads at
  `MAX_REVIEW_JSON_BYTES` (8 MiB) with an explicit truncation marker. The
  on-disk file remains complete for forensic use. (Codex round-3.)

- **B6. `/grok:imagine` media-path shell-injection defense** (`companion.mjs`).
  The `open "${mediaPath}"` hint was a copy-paste shell-injection vector:
  a content-policy-bypassing model returning `![alt]("; rm -rf ~; #)`
  would have the plugin display `open ""; rm -rf ~; #"` for the user to
  copy. New `isSafeMediaPath` validates with a conservative regex
  (`^[A-Za-z0-9._/\-%@+]+$`); unsafe paths get a warning instead of an
  open command. (Gemini round-3.)

- **B7. JSON review schema vs prose alignment + strict validation**
  (`prompts/review.md`, `companion.mjs`). The prompt taught
  `Critical/Important/Nit` but the schema required
  `critical/high/medium/low`. Updated the prompt to use the schema's four
  levels. The shallow validator was replaced with a strict pass that
  enforces severity enum, bounded string lengths (64 KiB per field), and
  bounded array lengths (256 items) — defending against a misbehaving
  model returning a 5 MiB `summary` that locks up the terminal.
  (Grok round-3.)

- **B8. `isAlive` EPERM handling** (`lib/process.mjs`). The old contract
  was "EPERM → alive" to avoid reaping jobs owned by another user; in
  the plugin's threat model EPERM only happens on PID reuse (our PID
  exited; the kernel handed it to a daemon from another UID). Returning
  true caused state accumulation: pruneJobs thought the job was still
  alive, terminateProcessTree couldn't kill the foreign process. Now
  treats EPERM as "not our process anymore" and returns false.
  (Gemini round-3.)

### Tests

- 20 new regression tests in `tests/v0-4-0-hardening.test.mjs` pin each
  of the 8 fixes against future drift. Total: 141 tests, all passing.

## [0.3.0] - 2026-05-15

Hardening release. Three independent reviewers (Codex, Gemini, Grok)
audited v0.2.0 and surfaced four ship-blocking issues plus four high-
priority improvements. All eight are addressed in this release.

### Security fixes

- **`safeJobLogPath` symlink bypass** (`lib/state.mjs`) — the old check used
  `&&` between the plain-path and realpath dirname comparisons, so a symlink
  planted inside `jobsDir/` that pointed outside it (e.g. `/etc/hosts`) passed
  the plain check and was returned as a "safe" path. New behavior: both checks
  must pass independently. Realpath canonicalization is now required when the
  file exists; ENOENT (fresh job, log not yet written) is still accepted.
- **Stop-gate truncation fail-open** (`stop-review-gate-hook.mjs`) — the hook
  capped stdout at 256 KiB in memory, so a Grok run that streamed thought
  tokens before the final JSON envelope would silently fail the parse and
  default to `emitAllow()`. Now tees stdout to a temp file and re-reads it
  on close (bounded at 8 MiB to defend against runaway responses).
- **Prompt-injection via unescaped diff** (`lib/prompts.mjs`) — the repo
  diff was substituted into XML-tagged prompt blocks without escaping, so a
  malicious commit containing `</repository_context><system>IGNORE...</system>`
  could break out of its container. Now every repo/user-controlled value
  flows through `escapeXmlInTrustedBlock`, including the diff.

### Bug fixes

- **`capabilityProbe --cwd` ghost requirement** (`lib/grok.mjs`) — `--cwd`
  was listed as a required flag in the capability probe, but the plugin
  never actually emits `--cwd` (it uses `spawn({ cwd })` instead). A future
  Grok release that dropped the flag would have falsely broken `/grok:setup`.
  Removed from the required list with a comment explaining why.
- **Misleading task footer** (`companion.mjs`) — `cmdTask` ran with plain
  output (not JSON), so `parseGrokJson` always returned `kind: "unknown"`
  and `meta.session_id` was never populated. The footer surfaced the
  `requested_session_id` if present, but also accepted the never-populated
  `meta.session_id` as a fallback — implying resume semantics that didn't
  exist. Now only fires when the user explicitly passed `--session-id`.
- **`cmdImagine` policy-gate ordering** (`companion.mjs`) — the
  control-byte refusal ran AFTER the `which("grok")` check, so a CI runner
  without grok would mask the refusal with `exit 127`. Moved the gate
  before the binary check (matches `cmdTask --write` pattern).
- **ANSI-before-JSON.parse** (`companion.mjs`, `stop-review-gate-hook.mjs`)
  — `parseGrokJson` and `parseGrokJsonEnvelope` called `JSON.parse(raw)`
  directly. Grok normally emits clean JSON on stdout, but its Rust tracing
  layer can leak colored log lines under certain terminal configurations.
  A single stray escape sequence flipped an error envelope to "unknown"
  and the close handler treated it as success. Now both call sites run
  `sanitizeForTerminal(raw)` first.

### Allowlist additions

- `cleanGrokEnv` now passes through `GROK_AUTH_PROVIDER_LABEL`,
  `GROK_AUTH_EXPIRED`, `GROK_DISABLE_TELEMETRY`, and `GROK_WEB_SEARCH_MODEL`.
  All four are documented in `~/.grok/README.md`'s Environment Variables
  section but were previously dropped by the allowlist.

### Resilience

- **Model fallback chain expansion** (`lib/grok.mjs`) — `probeWithFallback`
  previously triggered only on `"model unavailable"`. Now also fires on
  `"quota exhausted"` (transient per-model throttling). The chain itself is
  still a singleton (`["grok-build"]`) because only one public model is
  exposed today, but the trigger semantics are correct for when more ship.

### Tests

- 15 new regression tests across `tests/state-symlink.test.mjs`,
  `tests/prompt-injection.test.mjs`, and `tests/json-ansi-strip.test.mjs`
  pinning the security guarantees against future regressions. 109 tests
  total, all passing.

## [0.2.0] - 2026-05-14

### Added

- `/grok:imagine <description>` and `/grok:imagine-video <description>` —
  surface Grok's builtin Media Generation slash commands (documented in
  `~/.grok/docs/user-guide/04-slash-commands.md`) through the plugin's
  headless flow. The companion runs `grok -p "/imagine <desc>" --output-format json`,
  parses the markdown image/video link out of the response, and prints
  the saved file path plus an `open "<path>"` line. Defaults: 5 min
  timeout for images, 15 min for video. `--json` flag returns a parseable
  `{kind, description, path, sessionId, raw}` envelope instead of the
  friendly text format. Control bytes in the description are rejected at
  the dispatcher layer for defense-in-depth.

### Tests

- 6 new tests in `tests/imagine.test.mjs` (dispatcher wiring, usage errors,
  control-byte refusal) and the dispatcher-coverage check now requires
  `imagine` and `imagine-video` in `main()`. 94 tests total, all passing.

## [0.1.0] - 2026-05-14

Initial release. Wraps the xAI Grok CLI (`grok` binary, headless `-p`)
for use from inside Claude Code, following the structure used by
`openai/codex-plugin-cc` and `taibaran/gemini-plugin-cc`.

### Added

- **Slash commands**
  - `/grok:setup` — verify Grok install, run a capability probe (checks the
    flag tokens the plugin depends on), run an auth probe, and optionally
    toggle the stop-time review gate.
  - `/grok:ask` — read-only one-shot question.
  - `/grok:review` — code review on working-tree / staged / branch diff,
    foreground or background.
  - `/grok:adversarial-review` — same target selection, skeptical framing.
  - `/grok:rescue` — delegate investigation or fix work to Grok via the
    `grok:grok-rescue` subagent.
  - `/grok:status`, `/grok:result`, `/grok:cancel`, `/grok:purge`.
- **`grok:grok-rescue` subagent** (`agents/grok-rescue.md`) — thin forwarder
  to `companion.mjs task`. Honors `--write`, `--read-only`, `--model`,
  `--effort`, `--session-id`, `--background`, `--wait`, and `--timeout`.
- **Internal skills**
  - `grok-cli-runtime` — defines the contract for invoking the companion
    runtime.
  - `grok-prompting` — guidance for shaping rescue prompts to Grok.
  - `grok-result-handling` — guidance for surfacing Grok output verbatim.
- **Hooks** (`hooks/hooks.json`): SessionStart, SessionEnd, and optional
  Stop review gate.
- **Security hardening** (mirrored from `gemini-plugin-cc`):
  - `cleanGrokEnv` allowlist drops `ANTHROPIC_API_KEY`, `GITHUB_TOKEN`,
    `AWS_*`, `SSH_AUTH_SOCK`, `NODE_OPTIONS`, and anything else not on the
    explicit allowlist. Adds only Grok / xAI env vars documented in the
    upstream README (`GROK_CODE_XAI_API_KEY`, `GROK_CLI_CHAT_PROXY_BASE_URL`,
    `GROK_OIDC_*`, `GROK_AUTH_PROVIDER_*`, `GROK_HOME`, etc.).
  - `TerminalSanitizer` strips ANSI / OSC / DCS sequences and dangerous
    C0 bytes, stream-aware across chunk boundaries.
  - `safeJobLogPath` confines `/grok:result` reads to `jobsDir`, with
    realpath canonicalization so macOS case-insensitive paths and symlinks
    do not bypass the check.
  - `atomicWrite` with `O_EXCL` + `crypto.randomBytes` defeats predictable-
    name symlink attacks in shared tmp.
  - `withConfigLock` (file lock + stale-lock recovery) around
    `config.json` read-modify-write.
  - `terminateProcessTree` (SIGTERM → SIGKILL) with PID validation that
    rejects PID 0 and PID 1.
  - `parseVerdict` accepts only the schema-shaped JSON `{decision, reason}`
    — frees-form `ALLOW`/`BLOCK` text is rejected. Defends against
    prompt-injection via the diff or Claude transcript snippet.
- **Capability probing** — `capabilityProbe()` runs `grok --help` at setup
  time and reports any missing flag tokens. Catches breaking-change
  upgrades where Grok renames a flag without a major-version bump.
- **Session resumption** — `--session-id <id>` threads a named session into
  Grok's `-s` flag. The companion surfaces the underlying Grok `sessionId`
  in `/grok:result` so users can drop down into raw `grok -r <id>`.
- **Adversarial-review prompt** — explicit skepticism stance, prioritizes
  trust-boundary, concurrency, rollback, and data-integrity failures.
- **JSON review output** — `--json` returns structured findings against
  `schemas/review-output.schema.json`.
- **Test suite** — 79 unit tests covering args, state, git ref validation,
  PID validation, ANSI sanitizer, verdict parser, and the Grok CLI wrapper.
- **CI** — Node 20 / 22 matrix on Ubuntu + macOS, plus a smoke test for the
  dispatcher's behavior when Grok is not installed.

### Known limitations

- The Stop-time review gate sees the *current* working-tree + staged diff,
  not strictly the edits introduced by the immediately previous Claude
  turn. The prompt instructs Grok to ignore non-turn edits, but pre-
  existing dirty state can trip false positives. This matches the behavior
  of `gemini-plugin-cc` and `codex-plugin-cc`; a true turn-attribution
  scheme would require a complementary pre-turn snapshot hook.

[0.1.0]: https://github.com/taibaran/grok-plugin-cc/releases/tag/v0.1.0
