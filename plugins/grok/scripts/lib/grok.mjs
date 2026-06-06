// Grok CLI wrapper — version detection, auth probing, arg construction,
// and a curated environment for the spawned `grok` process.
//
// References for every constant or flag here: ~/.grok/README.md (the
// authoritative xAI Grok CLI documentation). Anything that depends on the
// upstream CLI shape carries a "see README" comment.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readConfig } from "./state.mjs";
import { findLastJsonObject } from "./verdict.mjs";
import { sanitizeForTerminal } from "./render.mjs";

export const AUTH_PROBE_TIMEOUT_MS = 30_000;

// Defense-in-depth: the `grok` binary inherits this Node process's full
// environment by default, which inside Claude Code includes ANTHROPIC_API_KEY,
// GITHUB_TOKEN, AWS_*, SSH_AUTH_SOCK, and anything else the user has exported.
// A compromised grok binary (supply-chain attack on the xAI installer, or a
// hostile fork on PATH) would exfiltrate every secret. cleanGrokEnv() returns
// an allowlisted subset that is sufficient for grok to function — auth, locale,
// terminal, proxy — and nothing else. Adding to the allowlist requires an
// explicit reason in the diff.
//
// The Grok-specific keys come from `## Environment Variables` in the README.
const ALLOWED_ENV_KEYS = new Set([
  // Process basics
  "PATH", "HOME", "USER", "LOGNAME", "SHELL", "PWD",
  // Locale
  "LANG", "LC_ALL", "LC_CTYPE", "LC_MESSAGES",
  // Terminal
  "TERM", "COLORTERM", "TERM_PROGRAM", "NO_COLOR", "FORCE_COLOR",
  // Temp dirs
  "TMPDIR", "TMP", "TEMP",
  // XDG base dirs (the user's ~/.grok/ stays at $HOME, but corporate
  // environments can re-home via these — keep them passed through).
  "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME", "XDG_RUNTIME_DIR",
  // Grok / xAI authentication and endpoint overrides. Names verified against
  // the installed CLI README "Environment Variables" section (0.2.22). The
  // primary API-key variable is XAI_API_KEY; the binary also reads
  // GROK_CODE_XAI_API_KEY as a lower-priority global fallback.
  "XAI_API_KEY",                    // primary API key (console.x.ai) — documented headless auth var
  "GROK_CODE_XAI_API_KEY",          // legacy/global fallback API key (still honored by the binary)
  "GROK_CLI_CHAT_PROXY_BASE_URL",   // proxy URL override
  "GROK_MODELS_BASE_URL",
  "GROK_MODELS_LIST_URL",
  "GROK_AUTH_PROVIDER_COMMAND",
  "GROK_AUTH_PROVIDER_LABEL",       // TUI label override for external auth
  "GROK_AUTH_TOKEN_TTL",
  "GROK_AUTH_EARLY_INVALIDATION_SECS",
  "GROK_AUTH_EXPIRED",              // set by Grok itself when re-running the auth provider
  "GROK_OIDC_ISSUER",
  "GROK_OIDC_CLIENT_ID",
  "GROK_HOME",                      // overrides ~/.grok config dir
  "GROK_SUBAGENTS",                 // 0/1
  "GROK_MEMORY",                    // 0/1
  "GROK_WEB_FETCH",                 // 0/1
  "GROK_WEB_FETCH_PROXY",
  "GROK_WEB_SEARCH_MODEL",          // overrides the model used by web_search tool
  "GROK_AGENT",                     // custom agent definition path
  "GROK_RESPECT_GITIGNORE",         // 0/1
  "GROK_FEEDBACK_ENABLED",
  "GROK_TELEMETRY_ENABLED",         // telemetry on/off (1/0) — the real 0.2.22 var (was GROK_DISABLE_TELEMETRY, which never existed)
  "GROK_DEPLOYMENT_KEY",
  "GROK_LOG_FILE",
  "GROK_LOG_FILTER",
  "GROK_SANDBOX",                   // sandbox profile
  "GROK_LSP_TOOLS",
  // v1.2.0 — context compaction controls (used by /grok:research deep mode).
  "GROK_COMPACTION_MODE",           // summary|transcript|segments
  "GROK_COMPACTION_DETAIL",         // none|minimal|balanced|verbose
  // Logging (stderr in headless)
  "RUST_LOG",
  // Plugin-level override for the default model (similar to GEMINI_PLUGIN_MODEL)
  "GROK_PLUGIN_MODEL",
  // Plugin-level write-mode safety toggle (mirrors GEMINI_PLUGIN_ALLOW_WRITE).
  "GROK_PLUGIN_ALLOW_WRITE",
  // Strict review gate behavior (mirrors GEMINI_REVIEW_GATE_STRICT).
  "GROK_REVIEW_GATE_STRICT",
  // Proxy (corporate networks)
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY",
  "http_proxy", "https_proxy", "no_proxy", "all_proxy",
  // Custom CA bundle for corporate TLS-intercepting proxies.
  // Pointedly NOT adding NODE_OPTIONS — that one accepts `--require=path.js`
  // and would let a hostile env inject arbitrary code.
  "NODE_EXTRA_CA_CERTS"
]);
// LC_* covers all locale category overrides (LC_NUMERIC, LC_TIME, etc.).
const ALLOWED_PREFIXES = ["LC_"];

// cleanGrokEnv builds the allowlisted environment for the spawned `grok`
// process. The optional `overrides` object lets a caller FORCE specific
// values (e.g. GROK_WEB_FETCH=1 for research/ask) — but only for keys that
// are already on the allowlist. A non-allowlisted override is silently
// dropped, so this can never become a hole that re-introduces a secret the
// allowlist exists to strip. Non-string override values are ignored too.
export function isAllowedEnvKey(k) {
  return ALLOWED_ENV_KEYS.has(k) || ALLOWED_PREFIXES.some(p => k.startsWith(p));
}

export function cleanGrokEnv(parent = process.env, overrides = null) {
  const out = Object.create(null);
  for (const k of Object.keys(parent)) {
    const v = parent[k];
    if (typeof v !== "string") continue;
    if (isAllowedEnvKey(k)) out[k] = v;
  }
  if (overrides) {
    for (const k of Object.keys(overrides)) {
      const v = overrides[k];
      if (typeof v !== "string") continue;
      if (isAllowedEnvKey(k)) out[k] = v;
    }
  }
  return out;
}

// v1.2.0: decide the GROK_WEB_FETCH override for grounding-friendly commands
// (research / ask / fan-out). Grok's web_fetch tool is OFF unless
// GROK_WEB_FETCH=1, so the URL the user pasted can't be fetched by default —
// one of Grok's grounding differentiators is dormant. We turn it ON by default
// but with two overrides of that default:
//   (1) An explicit offline flag wins. noWebFetch is true for --no-web-fetch
//       AND for --no-web-search (callers OR them) — both are explicit "go
//       offline" intents, so they force GROK_WEB_FETCH=0 even if the user's
//       env had it on. This is deliberate: an explicit per-call flag outranks
//       a passively-exported default.
//   (2) Otherwise, never clobber a GROK_WEB_FETCH the user set in their env —
//       ANY string value (including an explicit empty "") counts as "set" and
//       is left untouched.
// Returns an overrides object for cleanGrokEnv's second argument (empty = leave
// env as-is).
export function webFetchEnvOverride({ noWebFetch = false, parentEnv = process.env } = {}) {
  if (noWebFetch) return { GROK_WEB_FETCH: "0" };
  const existing = parentEnv ? parentEnv.GROK_WEB_FETCH : undefined;
  if (typeof existing === "string") return {};   // user set it (incl. ""): respect it
  return { GROK_WEB_FETCH: "1" };
}

// Only one public model is currently exposed via `grok models` for the default
// hosted endpoint. Pinning the plugin to this id keeps results consistent even
// if Grok flips the default later. Override per-call with --model, or globally
// via GROK_PLUGIN_MODEL.
export const DEFAULT_MODEL = "grok-build";
// Fallback chain. Today there is only one public model, so this is a
// singleton — meaning `probeWithFallback` cannot actually fall back. Kept as
// a single-entry array (not removed entirely) so that when xAI ships
// additional public models we can add them without changing the public
// surface or the setup-report shape. The setup report's `fallbackUsed`
// field stays meaningful: null today, populated when a real fallback fires.
export const MODEL_FALLBACK_CHAIN = ["grok-build"];

// Minimum xAI Grok CLI version we have validated against. Bump only when a
// newer flag set or output-format change becomes mandatory for the plugin.
export const MIN_GROK_VERSION = "0.1.210";

// Precedence for model selection (highest wins):
//   1. callerModel argument (per-call --model flag)
//   2. GROK_PLUGIN_MODEL env var (global override)
//   3. workspace config.activeModel
//   4. DEFAULT_MODEL
export function effectiveModel(callerModel, cwd) {
  if (callerModel) return callerModel;
  if (process.env.GROK_PLUGIN_MODEL) return process.env.GROK_PLUGIN_MODEL;
  try {
    const cfg = readConfig(cwd ?? process.cwd());
    if (cfg && typeof cfg.activeModel === "string" && cfg.activeModel) {
      return cfg.activeModel;
    }
  } catch {}
  return DEFAULT_MODEL;
}

// Compare two semver-like strings ("0.39.1" vs "0.30.0"). Returns -1 / 0 / 1.
export function compareVersions(a, b) {
  const parse = s => String(s || "0.0.0").match(/(\d+)\.(\d+)\.(\d+)/) || [];
  const pa = parse(a), pb = parse(b);
  for (let i = 1; i <= 3; i++) {
    const ai = parseInt(pa[i] || "0", 10);
    const bi = parseInt(pb[i] || "0", 10);
    if (ai < bi) return -1;
    if (ai > bi) return 1;
  }
  return 0;
}

export function checkMinVersion(currentRaw) {
  const current = (currentRaw || "").trim();
  // `grok --version` prints e.g. `grok 0.1.210 (8b63e9068c)` — the leading
  // word and trailing build hash are non-semver, so extract the numeric core.
  const m = current.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!m) return { ok: false, reason: "could not parse version", current };
  const cleaned = m[0];
  if (compareVersions(cleaned, MIN_GROK_VERSION) < 0) {
    return { ok: false, reason: `installed ${cleaned} < required ${MIN_GROK_VERSION}`, current: cleaned };
  }
  return { ok: true, current: cleaned };
}

export function which(cmd) {
  const r = spawnSync("which", [cmd], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : null;
}

// v1.0.1 (issue #1): grokVersion now distinguishes three states so the
// caller can detect a broken-binary auto-update where `grok --version`
// exits 0 but prints nothing (observed on the 0.1.210→0.1.211 update).
//   - null         : could not run grok --version (exit != 0 or spawn error)
//   - ""           : exited 0 but printed empty output (binary is broken)
//   - "grok 0.1.."  : real version line
// Returning "" instead of null in the broken-binary case lets cmdSetup
// surface a specific actionable hint about rolling back via ~/.grok/downloads/
// rather than the generic "could not parse version" message.
export function grokVersion() {
  const r = spawnSync("grok", ["--version"], { encoding: "utf8", env: cleanGrokEnv() });
  if (r.status !== 0) return null;
  return (r.stdout || "").trim();
}

// v1.0.3 (issue #7): Read grok's models_cache.json to check whether a
// given model supports `--effort` / `--reasoning-effort`. The cache is
// populated by grok itself when you run `grok models`; we never write
// to it. We use the cached `info.supports_reasoning_effort` flag to
// decide whether to forward those flags — forwarding to a model that
// doesn't support them triggers a cryptic 400 from cli-chat-proxy with
// "Model X does not support parameter reasoningEffort", repeated 4× to
// stderr, while the CLI exits 0. The plugin's /grok:research command
// defaults to `--effort max`, so on the default model (grok-build, which
// declares supports_reasoning_effort=false) every research call was
// silently producing this 400 cascade. Strip-with-warning is preferred
// over abort: --effort is a quality hint, not required semantics, and
// silently aborting /grok:research on the default model would be worse
// UX than running it without effort.
//
// Returns:
//   true  — model supports the capability
//   false — model explicitly does NOT support it
//   null  — unknown (cache missing, model not in cache, field absent)
//
// `null` is treated conservatively by the caller: forward the flag and
// let upstream handle it. Only `false` triggers the strip-with-warning.
// v1.0.4 (Codex P1, round-1 review): honor GROK_HOME consistently with
// the cleanGrokEnv allowlist. The env allowlist already lets GROK_HOME
// through to the child grok process — so an enterprise user who has
// re-homed their grok config via GROK_HOME (per upstream docs) would
// hit a stale or missing models_cache.json at the default ~/.grok/
// path while grok itself reads from $GROK_HOME/. The gate would then
// see null cache → conservative-forward → 400 cascade. Use the same
// resolution grok itself uses.
export function grokHomeDir() {
  return process.env.GROK_HOME || path.join(os.homedir(), ".grok");
}

function readGrokModelsCache() {
  const cachePath = path.join(grokHomeDir(), "models_cache.json");
  try {
    const raw = fs.readFileSync(cachePath, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && parsed.models && typeof parsed.models === "object") {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

export function modelSupportsReasoningEffort(modelId, cacheOverride = undefined) {
  // GROK_PLUGIN_DISABLE_EFFORT_GATE=1 fully bypasses the gate — used by
  // pre-v1.0.3 tests that pre-date this gate and assume --effort always
  // forwards (these still encode useful per-test invariants like flag
  // ordering or case-insensitivity, but the gate would now strip the
  // flag because grok-build declares no support). The env var is read
  // every call so a per-test setup/teardown can flip it safely.
  if (process.env.GROK_PLUGIN_DISABLE_EFFORT_GATE === "1") return null;
  if (!modelId || typeof modelId !== "string") return null;
  const cache = cacheOverride !== undefined ? cacheOverride : readGrokModelsCache();
  if (!cache || !cache.models || typeof cache.models !== "object") return null;
  const entry = cache.models[modelId];
  if (!entry || !entry.info || typeof entry.info !== "object") return null;
  const v = entry.info.supports_reasoning_effort;
  if (v === true) return true;
  if (v === false) return false;
  return null;
}

// v1.0.4 (Codex P0 round-1 review): single source of truth for the
// per-model --effort gate. v1.0.3 only enforced the gate inside
// `grokBaseArgs`, but two callers append `--effort` outside that
// helper — `cmdReview` (it called grokBaseArgs without `effort`, then
// pushed `--effort` manually after) and `cmdImagine` (which doesn't
// use grokBaseArgs at all). Both paths bypassed the gate entirely,
// so `/grok:review --effort high` and `/grok:imagine --effort high`
// still triggered the 4× 400 cascade on grok-build.
//
// This helper centralizes the gate-and-warn so every caller can
// route their effort decision through one entry point. Returns the
// effort value to forward (or null if stripped — caller should not
// push the flag in that case). The `kind` argument controls the
// warning text so we can distinguish `--effort` from `--reasoning-effort`.
export function effortFlagForModel({ effort, model, cwd, kind = "effort" } = {}) {
  if (effort == null || effort === "") return null;
  if (!EFFORT_LEVELS.has(String(effort))) {
    throw new Error(`invalid --${kind}: ${effort}. Allowed: ${[...EFFORT_LEVELS].join(",")}`);
  }
  const resolved = effectiveModel(model, cwd);
  const supports = modelSupportsReasoningEffort(resolved);
  if (supports === false) {
    const flagName = kind === "reasoning-effort" ? "--reasoning-effort" : "--effort";
    process.stderr.write(
      `[grok-plugin] WARNING: model '${resolved}' declares supports_reasoning_effort=false ` +
      `in ~/.grok/models_cache.json — stripping ${flagName}=${effort} to avoid a 400 from ` +
      `cli-chat-proxy.grok.com. Run \`grok models\` to refresh the cache, or pin --model ` +
      `to a model that supports effort.\n`
    );
    return null;
  }
  return String(effort);
}

// Capability probe — verify that the flags this plugin relies on actually
// exist in the installed `grok` binary. Catches breaking changes where Grok
// renames a flag without bumping a major version. Surfaced through /grok:setup.
//
// The probe is conservative: it only checks for the flag tokens we depend on,
// not exhaustively. Missing flags are reported by name.
// The flag tokens this plugin depends on. Each entry is the smallest
// distinctive substring guaranteed to appear in `grok --help` output for the
// flag in question. Exported so the contract is testable without spawning grok.
//
// Note that `grok --help` lists `--always-approve` while the README documents
// both `--yolo` and `--always-approve` as equivalent aliases; we look for the
// help-visible name and use `--yolo` in actual invocations (matches the
// README's examples and is shorter).
//
// `--cwd` is intentionally NOT in the required list even though grok exposes
// it. The plugin does not pass `--cwd` to the child — we use `spawn(..., {
// cwd })` instead, which is the canonical way to set the working directory of
// a Node child process. Listing `--cwd` as required would let a future grok
// release that drops the flag falsely break /grok:setup over a capability we
// never depended on.
export const CAPABILITY_REQUIRED_FLAGS = [
  "-p, --single",
  "-m, --model",
  "--output-format",
  "--always-approve",
  "--permission-mode",
  "--max-turns",
  "--disallowed-tools",
  "--prompt-file",
  // v0.6.0 — flags required by /grok:research, /grok:best-of, /grok:models.
  "--effort",
  "--check",
  "--best-of-n",
  "--disable-web-search",
  // v0.8.0 — permission rule flags + advanced controls. Same G1
  // motivation: if grok is updated and these are renamed, fail at
  // setup time (clear error) rather than at user-call time (silent
  // "unknown option" stderr).
  "--allow",
  "--deny",
  "--tools",
  "--rules",
  "--no-subagents",
  "--no-plan",
  "--reasoning-effort",
  "--system-prompt-override",
  "--verbatim",
  "--sandbox",
  "--agent",
  // v0.9.0 — session / worktree / memory passthroughs
  "-w, --worktree",
  "-c, --continue",
  "-r, --resume",
  "--restore-code",
  "--no-memory",
  "--experimental-memory"
];

// Advisory-only capabilities. Used by some commands but NOT load-bearing for the
// core (setup/ask/review/research). A grok build that lacks one of these is
// reported in the setup report but does NOT flip readiness to false — otherwise
// a user who never touches custom fan-out would be blocked over a flag they
// never use. (--prompt-json is intentionally NOT listed: the plugin never emits
// it, so requiring it could only manufacture a false not-ready.)
export const CAPABILITY_OPTIONAL_FLAGS = [
  "--agents"   // v1.2.0 custom-mode /grok:fan-out only
];

// Capability probe — verify that the flags this plugin relies on actually
// exist in the installed `grok` binary. Catches breaking changes where Grok
// renames a flag without bumping a major version. Surfaced through /grok:setup.
//
// The probe is conservative: it only checks for the flag tokens we depend on,
// not exhaustively. Missing flags are reported by name.
export function capabilityProbe() {
  const r = spawnSync("grok", ["--help"], { encoding: "utf8", env: cleanGrokEnv() });
  if (r.status !== 0) {
    return { ok: false, reason: "could not run grok --help", missing: [] };
  }
  const help = r.stdout || "";
  const missing = CAPABILITY_REQUIRED_FLAGS.filter(token => !help.includes(token));
  // Advisory: surfaced in the setup report but never flips `ok`/readiness.
  const missingOptional = CAPABILITY_OPTIONAL_FLAGS.filter(token => !help.includes(token));
  return { ok: missing.length === 0, missing, missingOptional };
}

// Classify an arbitrary blob (combined stdout+stderr) into a known failure
// category so callers can emit actionable hints. Returns null when we cannot
// classify — caller treats that as a generic failure.
//
// Patterns are based on observed CLI output:
//   - When auth is missing or expired, Grok prints "Signing in with Grok..."
//     and an OAuth URL pointing at `auth.x.ai/oauth2/authorize`.
//   - Rate-limit / quota errors carry HTTP 429-style phrasing.
//   - Permission/auth rejection surfaces as 401/403 with "forbidden".
//   - "model not found" / "model not available" indicates a stale model id.
export function classifyAuthBlob(blob) {
  if (!blob) return null;
  // OAuth flow appearing in headless output means the binary is trying to
  // launch the browser flow, which is the canonical signal of missing auth.
  if (/auth\.x\.ai\/oauth2\/authorize|Signing in with Grok|XAI_API_KEY|GROK_CODE_XAI_API_KEY|console\.x\.ai/i.test(blob)) {
    return "no auth method configured";
  }
  if (/token.*expired|refresh.*token|reauthenticate/i.test(blob)) {
    return "auth expired — run `grok login`";
  }
  if (/quota|rate.?limit|RESOURCE_EXHAUSTED|429/i.test(blob)) {
    return "quota exhausted";
  }
  if (/permission.denied|forbidden|\b401\b|\b403\b/i.test(blob)) {
    return "auth rejected";
  }
  if (/ModelNotFound|model.*not.*(found|available)|invalid.*model/i.test(blob)) {
    return "model unavailable";
  }
  return null;
}

// Best-effort label for what the active auth source is. Only meaningful when
// the auth probe succeeds; called purely for the setup report.
export function detectAuthSource() {
  if (process.env.XAI_API_KEY) return "XAI_API_KEY env";
  if (process.env.GROK_CODE_XAI_API_KEY) return "GROK_CODE_XAI_API_KEY env";
  if (process.env.GROK_AUTH_PROVIDER_COMMAND) return "external auth provider";
  if (process.env.GROK_OIDC_ISSUER) return "OIDC";
  // Default install path stores tokens in ~/.grok/auth.json after `grok login`.
  return "browser OAuth (~/.grok/auth.json)";
}

// Tools to disallow for read-only operations (ask, review,
// adversarial-review, research, fan-out). Strips write + shell capabilities but
// deliberately leaves web_search / web_fetch intact so Grok can ground its
// answers in current docs or X discourse — that is Grok's primary
// differentiator against Claude's knowledge cutoff.
//
// v1.2.0 (CRITICAL, grok 0.2.22): `Agent` (subagent spawning) is now ALSO
// disabled. On 0.2.22 the agent builder auto-includes the subagent-control
// tools (get_task_output / wait_tasks / kill_task) whenever subagents are
// enabled, and those tools REQUIRE a background-capable bash tool
// (run_terminal_cmd) to be present. Because read-only mode strips
// run_terminal_cmd, leaving subagents enabled made the agent build fail
// outright — "Requirements unsatisfied" — breaking EVERY read-only command
// (ask/review/research) under -p. Disabling Agent removes the subagent-control
// tools and the unmet requirement. Read-only commands are single-shot and do
// not need subagents anyway; web grounding is unaffected.
//
// These tool IDs come from the README's "Tool Filtering" section, not
// display names.
// v0.7.3 (Grok research-doom-loop bug): when grok is spawned inside a
// directory that contains our plugin (e.g., the dev tree or a project
// that depends on it), grok auto-discovers our `plugins/grok/skills/*`
// and exposes them as callable tools. The model then calls
// `grok-cli-runtime` etc. as if they were integration tools and the
// CLI panics ("use_tool can only dispatch to integration tools"). After
// 5 repeats, doom-loop termination kicks in and grok exits with no
// useful output.
//
// These skills are meant to be invoked by the `grok-rescue` SUBAGENT
// (Claude Sonnet wrapper), not by grok itself. Banning them from
// grok's tool surface closes the loop entirely.
export const GROK_PLUGIN_SKILL_NAMES = "grok-cli-runtime,grok-prompting,grok-result-handling";
export const READ_ONLY_DISALLOWED_TOOLS = `Agent,search_replace,run_terminal_cmd,todo_write,${GROK_PLUGIN_SKILL_NAMES}`;

// Tools to disallow during the auth probe. The probe sends a trivial "say
// OK" prompt — it has no business calling ANY tool, so we ban the full
// set (including Agent / web_*) to keep the probe cheap, deterministic,
// and fast. Using a separate constant from READ_ONLY_DISALLOWED_TOOLS
// makes the difference between "real work, read-only" and "minimal liveness
// check" explicit in the code, addressing Codex's "inconsistent policy"
// finding.
export const AUTH_PROBE_DISALLOWED_TOOLS = `Agent,run_terminal_cmd,search_replace,web_search,web_fetch,todo_write,${GROK_PLUGIN_SKILL_NAMES}`;

// Build the base argument vector for a non-interactive `grok -p` invocation.
//
//   readOnly=true  → --permission-mode plan AND strip write/shell tools.
//                    The two layers are deliberate: --permission-mode is a
//                    policy gate, --disallowed-tools removes the tools from
//                    the agent's vocabulary entirely, so a clever model can't
//                    silently bypass plan mode via internal tool calls.
//   readOnly=false → --yolo (auto-approve all tool executions).
//
// jsonOutput=true selects --output-format json (single JSON object after
// completion). The plain default is left for interactive-feeling text.
//
// sessionId chains the call into a named session for multi-turn use; without
// it the headless run is one-shot.
//
// cwd is threaded into effectiveModel so workspace-scoped activeModel (set
// by /grok:setup's fallback chain) resolves against the user's actual
// workspace and not whatever cwd the hook process happens to inherit from
// Claude Code. Optional — defaults to process.cwd() inside effectiveModel.
// Whitelist of Grok-CLI --effort levels. Validated at the boundary so the
// caller can pass user input straight through without ad-hoc parsing.
export const EFFORT_LEVELS = new Set(["low", "medium", "high", "xhigh", "max"]);

// v1.2.0: context-compaction controls (`grok --help`). `segments` persists
// per-segment markdown that can be grep'd back later — the most context-
// preserving mode, useful for long /grok:research runs.
export const COMPACTION_MODES = new Set(["summary", "transcript", "segments"]);
export const COMPACTION_DETAILS = new Set(["none", "minimal", "balanced", "verbose"]);

// Upper bound on --best-of-n. Grok lets you pick any positive int, but each
// branch is a full token-spend, so we cap it at 8 to keep accidental
// 50-branch runs from melting quota. Callers can override with a higher
// value by passing it explicitly; this default is just the validator default.
export const BEST_OF_N_MAX = 8;

// v0.8.0: permission_mode values accepted upstream — used by grokBaseArgs
// when the user-facing `--permission-mode` is supplied.
// v0.9.12 (Grok LOW + Gemini Important round-12): scan a spawned
// argv for `--output-format json` in any of its accepted shapes.
// The v0.9.11 inline scanner only recognized the space-separated
// form `["--output-format", "json"]` that grokBaseArgs emits today,
// missing the `--output-format=json` inline form a future caller
// could legitimately use. Last-wins semantics handle duplicates.
// v0.9.13 (Grok Medium round-13): the v0.9.12 scanner peeked at
// argv[i+1] for the space form but did not advance past it. A value
// token that happened to match `--output-format=...` (e.g. the
// literal value passed via space form) would then be re-interpreted
// as an inline flag on the next iteration, flipping the verdict.
// Consume the value token so its contents are never re-scanned.
export function commandUsesJsonOutput(argv) {
  if (!Array.isArray(argv)) return false;
  let result = false;
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (typeof t !== "string") continue;
    if (t === "--output-format") {
      // Next token is the value — consume it so a value that resembles
      // an inline flag (e.g. "--output-format=json") cannot flip the
      // result on the next iteration.
      const val = argv[i + 1];
      result = val === "json";
      if (typeof val === "string") i++;
    } else if (t === "--output-format=json") {
      result = true;
    } else if (t.startsWith("--output-format=")) {
      // Different value (--output-format=plain etc.); not json.
      result = false;
    }
  }
  return result;
}

export const PERMISSION_MODES = new Set([
  "default", "acceptEdits", "auto", "dontAsk", "bypassPermissions", "plan"
]);

// v0.8.0: cap rules/allow/deny payloads. Each rule is a glob string;
// 1 KiB per rule and 256 rules total is well above any reasonable use
// and protects against accidental megabyte-sized inputs blowing argv
// (ARG_MAX) on systems where these are passed as separate args.
const MAX_PERMISSION_RULES = 256;
const MAX_PERMISSION_RULE_LEN = 1024;

// v0.8.1 (Grok aggregate-review round-2 MEDIUM #1):
//
// CONTROL_BYTE_STRICT rejects ALL C0 control bytes (0x00-0x1F + 0x7F)
// including TAB (0x09) and LF (0x0A). Used for single-line tokens
// where a literal newline is never legitimate: --allow / --deny /
// --rules (inline form; @file path is also one line), --tools (CSV),
// --sandbox profile name, --agent name.
//
// CONTROL_BYTE_MULTILINE allows TAB + LF + CR but rejects every other
// C0 control. Used for --system-prompt-override where multi-line
// content is the whole point. The v0.8.0 regex used the multi-line
// variant for ALL of them, allowing a `--rules "evil\nadditional
// directive"` to slip past validation and be echoed back into model
// context. Splitting the validators closes that exactly.
const CONTROL_BYTE_STRICT = /[\x00-\x1f\x7f]/;
const CONTROL_BYTE_MULTILINE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;

function validateRuleArray(name, arr) {
  if (arr == null) return null;
  if (!Array.isArray(arr)) {
    throw new Error(`--${name} must be an array of strings`);
  }
  if (arr.length > MAX_PERMISSION_RULES) {
    throw new Error(`--${name} too many entries (${arr.length} > ${MAX_PERMISSION_RULES})`);
  }
  for (const r of arr) {
    if (typeof r !== "string") {
      throw new Error(`--${name} entries must be strings`);
    }
    if (r.length === 0) {
      throw new Error(`--${name} empty string is not a valid rule`);
    }
    if (r.length > MAX_PERMISSION_RULE_LEN) {
      throw new Error(`--${name} rule exceeds ${MAX_PERMISSION_RULE_LEN} chars`);
    }
    // Strict — no TAB, no LF, no other C0. Each rule is a single-line
    // token; multi-line content goes through --rules @file.
    if (CONTROL_BYTE_STRICT.test(r)) {
      throw new Error(`--${name} rule contains control bytes (incl. tab/newline)`);
    }
  }
  return arr;
}

// ---------- v1.2.0: fan-out (multi-angle, single-call analysis) ----------
//
// Grok's `task` tool ships built-in personas (CLI Subagents docs:
// researcher / reviewer / security-auditor / test-writer / implementer /
// design-doc-writer / design-doc-reviewer). The DEFAULT fan-out asks Grok to
// dispatch several of these in parallel and synthesize — no custom schema, so
// it can't drift if xAI changes the inline `--agents` JSON shape. The advanced
// `--agents` passthrough below is for power users who want custom inline
// subagent definitions; we enforce a safety envelope and let Grok validate the
// field schema itself.
export const FANOUT_PERSONAS = new Set([
  "researcher", "reviewer", "security-auditor", "test-writer",
  "implementer", "design-doc-writer", "design-doc-reviewer"
]);
// Read-only analysis quartet used when the caller doesn't pick personas.
export const DEFAULT_FANOUT_PERSONAS = ["researcher", "reviewer", "security-auditor", "test-writer"];

// Hard cap on subagents per fan-out. Each is a full child session (token
// spend), so this bounds accidental blow-ups. The slash-command default is
// the quartet above; the autonomous skill is told to stay at/under it.
export const MAX_FANOUT_AGENTS = 8;
// Per-string-field and total-payload caps for a custom --agents JSON blob.
// The blob rides on argv, so the total cap is an ARG_MAX defense.
export const MAX_AGENT_FIELD_LEN = 8 * 1024;
export const MAX_AGENTS_JSON_BYTES = 64 * 1024;

export function validatePersonas(input) {
  if (input == null || input === "") return [...DEFAULT_FANOUT_PERSONAS];
  const list = Array.isArray(input)
    ? input
    : String(input).split(",").map(s => s.trim()).filter(Boolean);
  // Cap the requested count first so an obviously-too-large ask fails clearly
  // even if some entries are also invalid.
  if (list.length > MAX_FANOUT_AGENTS) {
    throw new Error(`too many personas (${list.length} > MAX ${MAX_FANOUT_AGENTS})`);
  }
  const seen = new Set();
  const out = [];
  for (const p of list) {
    if (typeof p !== "string") throw new Error("--personas entries must be strings");
    if (!FANOUT_PERSONAS.has(p)) {
      throw new Error(`unknown persona: ${p}. Allowed: ${[...FANOUT_PERSONAS].join(", ")}`);
    }
    if (!seen.has(p)) { seen.add(p); out.push(p); }
  }
  return out.length ? out : [...DEFAULT_FANOUT_PERSONAS];
}

// Recursively validate every string in a custom subagent object: size-capped,
// and free of non-newline control bytes (prompt bodies legitimately contain
// newlines/tabs, so we use the MULTILINE variant). Names get a stricter check
// at the top level before this runs.
// Bound recursion depth so a pathologically nested (but small) payload throws a
// clean validation error instead of a RangeError stack overflow. 64 is far
// deeper than any real subagent definition.
const MAX_AGENT_NESTING_DEPTH = 64;
function scrubAgentStrings(value, where, depth = 0) {
  if (depth > MAX_AGENT_NESTING_DEPTH) {
    throw new Error(`--agents nesting too deep at ${where} (>${MAX_AGENT_NESTING_DEPTH} levels)`);
  }
  if (typeof value === "string") {
    if (value.length > MAX_AGENT_FIELD_LEN) {
      throw new Error(`--agents field ${where} too large (>${MAX_AGENT_FIELD_LEN} chars)`);
    }
    if (CONTROL_BYTE_MULTILINE.test(value)) {
      throw new Error(`--agents field ${where} contains forbidden control bytes`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => scrubAgentStrings(v, `${where}[${i}]`, depth + 1));
    return;
  }
  if (value && typeof value === "object") {
    for (const k of Object.keys(value)) scrubAgentStrings(value[k], `${where}.${k}`, depth + 1);
  }
}

// Validate a custom `--agents` payload (JSON string or already-parsed array).
// Returns { json, names }. We deliberately do NOT hard-code Grok's field
// schema (only `name` is required, as identity) — Grok validates the rest, so
// the plugin stays correct even if xAI evolves the inline definition shape.
export function validateAgentsJson(input, { maxAgents = MAX_FANOUT_AGENTS } = {}) {
  let arr;
  if (typeof input === "string") {
    try { arr = JSON.parse(input); }
    catch (e) { throw new Error(`invalid --agents JSON: ${e.message}`); }
  } else {
    arr = input;
  }
  if (!Array.isArray(arr)) {
    throw new Error("--agents must be a JSON array of subagent objects");
  }
  if (arr.length === 0) {
    throw new Error("--agents must contain at least one subagent object");
  }
  if (arr.length > maxAgents) {
    throw new Error(`--agents has too many entries (${arr.length} > MAX ${maxAgents})`);
  }
  const names = [];
  for (let i = 0; i < arr.length; i++) {
    const a = arr[i];
    if (!a || typeof a !== "object" || Array.isArray(a)) {
      throw new Error(`--agents[${i}] must be an object`);
    }
    const nm = a.name;
    if (typeof nm !== "string" || nm.length === 0) {
      throw new Error(`--agents[${i}] is missing a non-empty "name"`);
    }
    if (nm.length > 128) {
      throw new Error(`--agents[${i}].name too long (>128 chars)`);
    }
    // name is a single-line identity token: no control bytes (incl. tab/LF),
    // no path separators (defuse `../` style names).
    if (CONTROL_BYTE_STRICT.test(nm) || nm.includes("/")) {
      throw new Error(`--agents[${i}].name invalid: control bytes or path separators`);
    }
    scrubAgentStrings(a, `[${i}]`);
    names.push(nm);
  }
  const json = JSON.stringify(arr);
  if (Buffer.byteLength(json, "utf8") > MAX_AGENTS_JSON_BYTES) {
    throw new Error(`--agents payload too large (>${MAX_AGENTS_JSON_BYTES} bytes); reduce agent count or prompt sizes`);
  }
  return { json, names };
}

// TRUE parallel fan-out (v1.2.0): the PLUGIN orchestrates it — one Grok call
// per angle, run in parallel, then a synthesis call. This is genuinely "call
// Grok many times in different directions", reliably, instead of relying on
// Grok's internal `task`-tool subagent dispatch (which is denied/cancelled in
// headless read-only mode → empty output).
//
// buildAnglePrompt frames ONE angle's focused analysis.
export function buildAnglePrompt(angle, task) {
  const a = String(angle == null ? "" : angle).trim();
  const t = String(task == null ? "" : task).trim();
  return [
    `You are a ${a} specialist. Analyze the TASK below strictly from your ${a} perspective —`,
    `be thorough and specific, and cover only what a ${a} would care about. Give concrete specialist`,
    "findings, not a general summary. Proceed autonomously; do not ask clarifying questions. State assumptions.",
    "",
    "TASK:",
    t
  ].join("\n");
}

// Cap per-angle text fed into the synthesis prompt so the combined prompt stays
// bounded (it rides on --prompt-file, but we still don't want a multi-MB blob).
export const MAX_SYNTHESIS_ANGLE_CHARS = 48 * 1024;

// buildSynthesisPrompt assembles the per-angle reports into a single
// reconcile-and-conclude request. angleReports: [{ angle, text }].
export function buildSynthesisPrompt(task, angleReports) {
  const t = String(task == null ? "" : task).trim();
  const reports = Array.isArray(angleReports) ? angleReports : [];
  const blocks = reports.map(r => {
    let body = String(r && r.text != null ? r.text : "");
    if (body.length > MAX_SYNTHESIS_ANGLE_CHARS) {
      body = body.slice(0, MAX_SYNTHESIS_ANGLE_CHARS) + "\n…[truncated for synthesis]";
    }
    return `### ${String(r && r.angle != null ? r.angle : "angle")} analysis\n${body}`;
  }).join("\n\n");
  return [
    `You are synthesizing ${reports.length} independent expert analyses of the same task into ONE`,
    "consolidated verdict. Reconcile agreements and conflicts across them and give the overall answer.",
    "INTEGRATE the analyses — do not just restate each one. Be complete but not repetitive.",
    "",
    `ORIGINAL TASK: ${t}`,
    "",
    "ANALYSES:",
    blocks
  ].join("\n");
}

export function grokBaseArgs({
  readOnly = true,
  model,
  jsonOutput = false,
  sessionId,
  cwd,
  effort,
  check = false,
  bestOfN,
  disableWebSearch = false,
  // v0.8.0 permission/policy passthroughs (all optional)
  allow,                  // Array<string> | undefined — repeatable --allow
  deny,                   // Array<string> | undefined — repeatable --deny
  tools,                  // string | undefined — comma-separated tool allowlist
  rules,                  // Array<string> | string | undefined — --rules (repeatable; strings or @file paths)
  maxTurns,               // number | undefined — user override of internal default
  noSubagents = false,    // --no-subagents
  noPlan = false,         // --no-plan
  reasoningEffort,        // string | undefined — --reasoning-effort (distinct from --effort)
  systemPromptOverride,   // string | undefined — --system-prompt-override (advanced)
  verbatim = false,       // --verbatim
  permissionMode,         // string | undefined — user-selectable; overrides readOnly's default
  sandbox,                // string | undefined — --sandbox <profile>
  agent,                  // string | undefined — --agent <name>
  agents,                 // Array | JSON string | undefined — --agents <json> (v1.2.0 inline subagents)
  compactionMode,         // string | undefined — --compaction-mode summary|transcript|segments
  compactionDetail,       // string | undefined — --compaction-detail none|minimal|balanced|verbose
  // v0.9.0 — session / worktree / memory passthroughs
  worktree,               // string|true|undefined — --worktree [<name>]: bool form (true) or named
  continueSession = false,// --continue: continue most-recent session for cwd
  resume,                 // string|true|undefined — --resume [<session-id>]: bool or named id
  restoreCode = false,    // --restore-code: checkout the session's original commit on resume
  noMemory = false,       // --no-memory: disable cross-session memory for this call
  experimentalMemory = false, // --experimental-memory: enable cross-session memory for this call
  streamingJson = false   // v1.2.0: emit --output-format streaming-json (live NDJSON) instead of json
} = {}) {
  const args = [
    "--output-format", streamingJson ? "streaming-json" : (jsonOutput ? "json" : "plain"),
    "-m", effectiveModel(model, cwd)
  ];
  // v0.8.0: --permission-mode is now user-controllable. If the user
  // provided one, validate against PERMISSION_MODES (defense against
  // prompt-injection / typo). Otherwise keep the read-only default
  // (plan) or write-mode default (--yolo, which means auto-approve
  // every tool use).
  if (permissionMode != null && permissionMode !== "") {
    if (!PERMISSION_MODES.has(String(permissionMode))) {
      throw new Error(`invalid --permission-mode: ${permissionMode}. Allowed: ${[...PERMISSION_MODES].join(",")}`);
    }
    args.push("--permission-mode", String(permissionMode));
    // Even with a custom permission mode, in read-only contexts we
    // still want the disallowed-tools shield as belt-and-suspenders
    // (a user can pick `auto` mode and we still strip search_replace/
    // run_terminal_cmd/todo_write, plus the skill bans from v0.7.3).
    if (readOnly) args.push("--disallowed-tools", READ_ONLY_DISALLOWED_TOOLS);
  } else if (readOnly) {
    args.push("--permission-mode", "plan");
    args.push("--disallowed-tools", READ_ONLY_DISALLOWED_TOOLS);
  } else {
    args.push("--yolo");
  }
  if (sessionId) args.push("-s", sessionId);
  // v0.6.0 Grok-specific differentiators:
  //  --effort tweaks the reasoning budget (low → max). Validated against
  //    EFFORT_LEVELS so we never forward freeform user input as a flag value.
  //  --check appends a self-verification loop to the prompt (headless only).
  //    Grok generates the answer, then critiques it against the original
  //    prompt. Single flag, no value.
  //  --best-of-n runs the task N ways in parallel and picks the best result
  //    (headless only). Costs N× tokens; we cap at BEST_OF_N_MAX by default.
  //  --disable-web-search turns off Grok's built-in web search + web_fetch.
  //    Useful for offline/repo-only reviews where you don't want sources
  //    pulled in. (Default for Grok is web search ON — that's its big
  //    differentiator against Claude's training cutoff.)
  // v1.0.4 (Codex P0): route through the shared effortFlagForModel helper.
  // Same gate behavior as v1.0.3 but cmdImagine and any future caller that
  // doesn't go through grokBaseArgs can now reuse the same logic.
  {
    const gated = effortFlagForModel({ effort, model, cwd, kind: "effort" });
    if (gated) args.push("--effort", gated);
  }
  if (check) args.push("--check");
  if (bestOfN != null) {
    const n = Number(bestOfN);
    if (!Number.isInteger(n) || n < 1) {
      throw new Error(`invalid --best-of-n: ${bestOfN} (must be a positive integer)`);
    }
    if (n > BEST_OF_N_MAX) {
      throw new Error(`--best-of-n ${n} exceeds plugin cap of ${BEST_OF_N_MAX}`);
    }
    args.push("--best-of-n", String(n));
  }
  if (disableWebSearch) args.push("--disable-web-search");

  // v0.8.0 permission-rule passthroughs. Each --allow / --deny is a
  // repeatable token; the validator caps both count and per-entry size
  // + scrubs control bytes (prompt-injection defense).
  const allowList = validateRuleArray("allow", allow);
  if (allowList) {
    for (const rule of allowList) args.push("--allow", rule);
  }
  const denyList = validateRuleArray("deny", deny);
  if (denyList) {
    for (const rule of denyList) args.push("--deny", rule);
  }
  // --tools is comma-separated already per `grok --help`; we accept
  // a string (treat as-is) or an array (join with commas). Validate
  // each entry for control bytes the same way.
  if (tools != null && tools !== "") {
    const list = Array.isArray(tools) ? tools : String(tools).split(",").map(s => s.trim()).filter(Boolean);
    validateRuleArray("tools", list);
    args.push("--tools", list.join(","));
  }
  // --rules accepts a single value but is also repeatable. Each entry
  // may be inline text or an @file path. We pass them through; grok
  // itself handles @file expansion.
  if (rules != null && rules !== "") {
    const list = Array.isArray(rules) ? rules : [rules];
    validateRuleArray("rules", list);
    for (const r of list) args.push("--rules", r);
  }
  // --max-turns user override. The CLI accepts a positive integer.
  if (maxTurns != null) {
    const n = Number(maxTurns);
    if (!Number.isInteger(n) || n < 1) {
      throw new Error(`invalid --max-turns: ${maxTurns} (must be a positive integer)`);
    }
    args.push("--max-turns", String(n));
  }
  if (noSubagents) args.push("--no-subagents");
  if (noPlan) args.push("--no-plan");
  if (verbatim) args.push("--verbatim");
  // v1.0.4 (Codex P0): same shared helper. Distinct `kind` controls warning text.
  {
    const gatedRE = effortFlagForModel({ effort: reasoningEffort, model, cwd, kind: "reasoning-effort" });
    if (gatedRE) args.push("--reasoning-effort", gatedRE);
  }
  if (systemPromptOverride != null && systemPromptOverride !== "") {
    // Sanitize control bytes — system-prompt-override goes verbatim
    // into the grok system prompt and any control bytes would render
    // in error echoes.
    const s = String(systemPromptOverride);
    if (s.length > 16 * 1024) {
      throw new Error(`--system-prompt-override too long (>${16 * 1024} chars). Use --rules @file for large rules.`);
    }
    // Multi-line allowed (system prompts have paragraphs). Strip
    // anything else — DEL, BEL, ESC, vertical tab, etc.
    if (CONTROL_BYTE_MULTILINE.test(s)) {
      throw new Error(`--system-prompt-override contains forbidden control bytes (newline + tab OK)`);
    }
    args.push("--system-prompt-override", s);
  }
  if (sandbox != null && sandbox !== "") {
    // grok accepts arbitrary profile names; we just sanity-check length
    // and control bytes (strict — single-line token). The "real"
    // defense is the kernel's own sandboxing — we're just passing the
    // name through. Slash is also rejected to defuse `../etc/passwd`.
    const s = String(sandbox);
    if (s.length > 128 || CONTROL_BYTE_STRICT.test(s) || s.includes("/")) {
      throw new Error(`--sandbox profile name invalid: ${s.slice(0, 32)}`);
    }
    args.push("--sandbox", s);
  }
  if (agent != null && agent !== "") {
    const s = String(agent);
    if (s.length > 128 || CONTROL_BYTE_STRICT.test(s) || s.includes("/")) {
      throw new Error(`--agent name invalid: ${s.slice(0, 32)}`);
    }
    args.push("--agent", s);
  }
  // v1.2.0: --agents <json> inline subagent definitions (fan-out). Validated
  // (count cap, name sanity, control-byte scrub, ARG_MAX size cap) and
  // re-serialized to canonical JSON before it goes on argv.
  if (agents != null && agents !== "") {
    const { json } = validateAgentsJson(agents);
    args.push("--agents", json);
  }
  // v1.2.0: context compaction controls.
  if (compactionMode != null && compactionMode !== "") {
    if (!COMPACTION_MODES.has(String(compactionMode))) {
      throw new Error(`invalid --compaction-mode: ${compactionMode}. Allowed: ${[...COMPACTION_MODES].join(", ")}`);
    }
    args.push("--compaction-mode", String(compactionMode));
  }
  if (compactionDetail != null && compactionDetail !== "") {
    if (!COMPACTION_DETAILS.has(String(compactionDetail))) {
      throw new Error(`invalid --compaction-detail: ${compactionDetail}. Allowed: ${[...COMPACTION_DETAILS].join(", ")}`);
    }
    args.push("--compaction-detail", String(compactionDetail));
  }

  // v0.9.0 session / worktree / memory.
  //
  // --worktree may be `true` (bare flag, auto-generate name) OR a string
  // name. Validate names same as --agent/--sandbox: short, no control bytes,
  // no path separators (worktree names can't contain `/` per git semantics).
  // v0.9.1 (Gemini Nit round-1): empty string explicit value
  // (`--worktree=""`) is no longer silently dropped — the parser
  // throws on EMPTY_VALUE before this code runs. `false` means the
  // user explicitly set `--worktree=false` (bool semantics); do not
  // emit anything.
  if (worktree === true) {
    args.push("--worktree");
  } else if (worktree === false) {
    // Explicitly disabled; emit nothing.
  } else if (worktree != null) {
    const s = String(worktree);
    if (s.length === 0 || s.length > 128 || CONTROL_BYTE_STRICT.test(s) || s.includes("/")) {
      throw new Error(`--worktree name invalid: ${s.slice(0, 32)}`);
    }
    args.push("--worktree", s);
  }
  if (continueSession) args.push("--continue");
  if (resume === true) {
    args.push("--resume");
  } else if (resume === false) {
    // Explicitly disabled; emit nothing.
  } else if (resume != null) {
    // Session IDs come in many shapes (UUIDs, ULIDs, hex). Be permissive
    // but defuse control-byte / newline injection.
    const s = String(resume);
    if (s.length === 0 || s.length > 256 || CONTROL_BYTE_STRICT.test(s)) {
      throw new Error(`--resume session id invalid: ${s.slice(0, 32)}`);
    }
    args.push("--resume", s);
  }
  if (restoreCode) args.push("--restore-code");
  if (noMemory && experimentalMemory) {
    // grok itself accepts either, but not both. Catch this at the
    // plugin layer for a clearer error.
    throw new Error("--no-memory and --experimental-memory are mutually exclusive");
  }
  if (noMemory) args.push("--no-memory");
  if (experimentalMemory) args.push("--experimental-memory");
  return args;
}

// One-shot auth probe. Asks the model for a trivial, deterministic response and
// checks both the exit code and the response body. `--max-turns 5` is generous
// enough to absorb Grok's internal thinking turns (the live CLI uses ~4 internal
// messages even for "say OK") while still catching a hung session.
//
// Tool list uses the broader AUTH_PROBE_DISALLOWED_TOOLS (vs the per-call
// READ_ONLY_DISALLOWED_TOOLS used by ask/review). The probe doesn't need web
// search / subagents / etc., so banning the full set keeps it deterministic.
export function authProbe(model) {
  const r = spawnSync(
    "grok",
    [
      "-p", "Reply with exactly the word: OK",
      "--output-format", "json",
      "-m", model || effectiveModel(),
      "--max-turns", "5",
      "--permission-mode", "plan",
      "--disallowed-tools", AUTH_PROBE_DISALLOWED_TOOLS
    ],
    { encoding: "utf8", timeout: AUTH_PROBE_TIMEOUT_MS, env: cleanGrokEnv() }
  );
  const blob = (r.stdout || "") + "\n" + (r.stderr || "");

  if (r.error?.code === "ETIMEDOUT") {
    return { ok: false, detail: "auth probe timed out", model: model || effectiveModel() };
  }

  // v1.2.0: parse via the shared, hardened parseGrokJson rather than a bare
  // JSON.parse on stdout. The bare parse failed whenever grok's Rust tracing
  // layer leaked a single colored log line around the envelope — a perfectly
  // authenticated account would then be reported as "probe failed", and
  // /grok:setup would tell the user to re-login for no reason. parseGrokJson
  // strips ANSI/OSC, recovers the last balanced object, and handles
  // streaming-json — so the probe is robust to noisy stdout.
  const parsed = parseGrokJson(r.stdout || "");
  if (parsed.kind === "error") {
    const why = classifyAuthBlob(parsed.message || blob);
    return { ok: false, detail: why || "error response", raw: (parsed.message || "").slice(0, 400), model: model || effectiveModel() };
  }
  if (r.status === 0 && parsed.kind === "text" && /\bOK\b/i.test(parsed.text || "")) {
    return { ok: true, detail: "responsive", model: model || effectiveModel() };
  }
  const why = classifyAuthBlob(blob);
  return { ok: false, detail: why || "probe failed", raw: blob.slice(0, 400), model: model || effectiveModel() };
}

// Parse Grok's --output-format json envelope. Shape:
//   success: { text, stopReason, sessionId, requestId, thought? }
//   error:   { type: "error", message }
// Returns { kind: "text" | "error" | "unknown", text, message, sessionId }.
//
// Two defense layers:
//   1. Strip ANSI / OSC / DCS / C0 controls (`sanitizeForTerminal`) —
//      Grok's Rust tracing layer can leak colored log lines into stdout.
//   2. Fast path JSON.parse; slow path scans for the LAST balanced JSON
//      object via the shared `findLastJsonObject` helper.
//
// Moved to lib/grok.mjs in v0.5.0 (C6/C9 refactor). Previously this
// existed verbatim in companion.mjs (used by ask/review/task) AND in
// stop-review-gate-hook.mjs::parseGrokJsonEnvelope. The two copies
// were each evolving slightly differently — Codex flagged the drift
// risk in round 3. Single source of truth now.
// v1.2.0: reconstruct a `--output-format streaming-json` (NDJSON) stream into
// the same shape the single-object json envelope yields. Each line is a
// self-contained event: {type:"text",data}, {type:"thought",data},
// {type:"error",message}, {type:"end",stopReason,sessionId,requestId}. We
// concatenate the `text` events' data, surface the first error, and pull
// session metadata from the `end` event. Returns null when the input is not
// recognizable as a multi-event stream (so the caller falls through to the
// single-object path). This is a defensive guard: every plugin path requests
// `--output-format json` explicitly today, but a remote/default flip to
// streaming-json would otherwise silently degrade every command to "unknown".
export function reconstructStreamingJson(clean) {
  const lines = clean.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (lines.length === 0) return null;
  let text = "";
  let sessionId = null;
  let stopReason = null;
  let errorMsg = null;
  let events = 0;
  for (const line of lines) {
    let ev = null;
    try { ev = JSON.parse(line); } catch { continue; }
    if (!ev || typeof ev !== "object" || typeof ev.type !== "string") continue;
    events++;
    if (ev.type === "text" && typeof ev.data === "string") text += ev.data;
    else if (ev.type === "error" && errorMsg == null) errorMsg = ev.message || ev.data || "";
    else if (ev.type === "end") {
      sessionId = ev.sessionId || null;
      stopReason = ev.stopReason || null;
    }
  }
  if (events === 0) return null;
  if (errorMsg != null) return { kind: "error", message: errorMsg };
  return { kind: "text", text, sessionId, stopReason };
}

// v1.2.0: incremental NDJSON parser for live `--output-format streaming-json`.
// Feed it raw stdout chunks via push(); it buffers partial lines, parses each
// complete event, fires onText/onThought/onError callbacks for live display,
// and accumulates a final result() identical in shape to parseGrokJson's. Call
// end() once the stream closes to flush a trailing newline-less line.
export function createStreamingJsonParser({ onText, onThought, onError } = {}) {
  let buf = "";
  let text = "";
  let sessionId = null;
  let stopReason = null;
  let errorMsg = null;
  let sawEnd = false;

  function handleLine(line) {
    const t = line.trim();
    if (!t) return;
    let ev = null;
    try { ev = JSON.parse(t); } catch { return; }      // ignore non-JSON noise
    if (!ev || typeof ev !== "object" || typeof ev.type !== "string") return;
    if (ev.type === "text" && typeof ev.data === "string") {
      text += ev.data;
      if (onText) onText(ev.data);
    } else if (ev.type === "thought" && typeof ev.data === "string") {
      if (onThought) onThought(ev.data);
    } else if (ev.type === "error") {
      if (errorMsg == null) errorMsg = ev.message || ev.data || "";
      if (onError) onError(errorMsg);
    } else if (ev.type === "end") {
      sawEnd = true;
      sessionId = ev.sessionId || null;
      stopReason = ev.stopReason || null;
    }
  }

  return {
    push(chunk) {
      buf += chunk;
      let idx;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        handleLine(line);
      }
    },
    end() {
      if (buf.length) { handleLine(buf); buf = ""; }
    },
    result() {
      return {
        kind: errorMsg != null ? "error" : "text",
        text,
        message: errorMsg,
        sessionId,
        stopReason,
        sawEnd
      };
    }
  };
}

export function parseGrokJson(raw) {
  if (!raw) return { kind: "unknown" };
  const clean = sanitizeForTerminal(raw).trim();
  if (!clean) return { kind: "unknown" };
  let parsed = null;
  try { parsed = JSON.parse(clean); } catch {}
  if (!parsed || typeof parsed !== "object") {
    parsed = findLastJsonObject(clean);
  }
  if (!parsed || typeof parsed !== "object") return { kind: "unknown" };
  if (parsed.type === "error") {
    return { kind: "error", message: parsed.message || "" };
  }
  if (typeof parsed.text === "string") {
    return {
      kind: "text",
      text: parsed.text,
      sessionId: parsed.sessionId || null,
      stopReason: parsed.stopReason || null
    };
  }
  // streaming-json (NDJSON) guard: the object we parsed is a stream event
  // (`{type:"text"|"thought"|"end"}`) rather than the single json envelope.
  // Reassemble the full stream rather than degrading to "unknown".
  if (parsed.type === "text" || parsed.type === "thought" || parsed.type === "end") {
    const recon = reconstructStreamingJson(clean);
    if (recon) return recon;
  }
  return { kind: "unknown" };
}

// Write a string to a fresh temp file with `O_EXCL` + 96 bits of
// randomness, retrying on the (extremely unlikely) EEXIST collision.
// Returns the absolute path; callers MUST unlink it when done.
//
// Used by review/imagine paths (which pass a multi-MB prompt to
// `grok --prompt-file`) AND by the stop-review-gate hook. Moved to
// lib/grok.mjs in v0.5.0 (C6 refactor) — previously this same function
// existed verbatim in companion.mjs AND stop-review-gate-hook.mjs.
export function writePromptToTempFile(prompt, prefix = "grok-prompt") {
  const dir = os.tmpdir();
  for (let attempt = 0; attempt < 8; attempt++) {
    const name = `${prefix}-${Date.now()}-${randomBytes(12).toString("hex")}.txt`;
    const p = path.join(dir, name);
    let fd;
    try {
      // O_EXCL via "wx" mode: refuse to overwrite a pre-planted symlink.
      fd = fs.openSync(p, "wx", 0o600);
    } catch (e) {
      if (e && e.code === "EEXIST") continue;
      throw e;
    }
    try { fs.writeSync(fd, prompt); }
    finally { fs.closeSync(fd); }
    return p;
  }
  throw new Error("writePromptToTempFile: exhausted retries trying to find a free name");
}

// Walk the fallback chain only if the user has not pinned a model AND the
// failure looks like one that another model might fix:
//   - "model unavailable"  — this specific model is not enabled for the
//                            account; another model in the chain might be.
//   - "quota exhausted"    — per-model quotas exist; another model may have
//                            headroom even if this one is throttled.
// For other failure classes (no auth method, auth rejected) walking the
// chain just produces N copies of the same error — skip it.
//
// Today the chain is a single entry (only `grok-build` is publicly exposed),
// so this function effectively returns the first probe result. When xAI
// ships more public models, the fallback semantics kick in automatically.
const FALLBACK_TRIGGER_DETAILS = new Set([
  "model unavailable",
  "quota exhausted"
]);

export function probeWithFallback() {
  const userPinned = !!process.env.GROK_PLUGIN_MODEL;
  const first = authProbe();
  if (first.ok) return { ...first, fallbackUsed: null };
  if (userPinned) return { ...first, fallbackUsed: null };
  if (!FALLBACK_TRIGGER_DETAILS.has(first.detail)) return { ...first, fallbackUsed: null };
  for (const candidate of MODEL_FALLBACK_CHAIN) {
    if (candidate === first.model) continue;
    const r = authProbe(candidate);
    if (r.ok) return { ...r, fallbackUsed: candidate };
  }
  return { ...first, fallbackUsed: null };
}
