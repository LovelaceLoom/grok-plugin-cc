#!/usr/bin/env node
// Grok Companion — slim dispatcher.
// Subcommands:
//   setup | ask | review | adversarial-review | task |
//   imagine | imagine-video |
//   research | models | bestof |     ← v0.6.0 Grok-specific differentiators
//   status | result | cancel | purge
//
// Heavy lifting lives in scripts/lib/ — this file just routes.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";

import { parseArgs, COMMON_BOOL_FLAGS, COMMON_VALUE_FLAGS, COMMON_REPEATABLE_FLAGS, COMMON_OPTIONAL_VALUE_FLAGS, parseDuration } from "./lib/args.mjs";
import {
  ensureDir, jobsDir, newJobId,
  writeJobMeta, readJobMeta, listJobs, pruneJobs,
  readConfig, setReviewGate, safeJobLogPath, readBoundedJobLog, purgeJobs, setActiveModel
} from "./lib/state.mjs";
import { isAlive, terminateProcessTree } from "./lib/process.mjs";
import { captureDiff } from "./lib/git.mjs";
import {
  which, grokVersion, classifyAuthBlob,
  detectAuthSource, grokBaseArgs, effectiveModel, DEFAULT_MODEL,
  cleanGrokEnv, probeWithFallback, checkMinVersion, MIN_GROK_VERSION,
  MODEL_FALLBACK_CHAIN, capabilityProbe,
  parseGrokJson, writePromptToTempFile, EFFORT_LEVELS, compareVersions, commandUsesJsonOutput,
  effortFlagForModel, grokHomeDir,
  webFetchEnvOverride, validatePersonas, validateAgentsJson, buildFanOutPrompt,
  DEFAULT_FANOUT_PERSONAS, MAX_FANOUT_AGENTS
} from "./lib/grok.mjs";
import { buildReviewPrompt } from "./lib/prompts.mjs";
import { renderJobTable, renderJobDetails, fmtTime, TerminalSanitizer, sanitizeForTerminal, formatSessionHint } from "./lib/render.mjs";

// Conservative timeouts. Override with `--timeout <duration>`, or pass
// `--timeout 0` to disable.
//
// The task default was 0 (unbounded) through v0.4.0 — rescue work is
// open-ended by design and the user can /grok:cancel a stuck job. The
// v0.5.0 review (Gemini) flagged this as a disk-DoS amplifier: an
// adversarial prompt trapping Grok in an output loop will silently fill
// the host's filesystem with no upper bound. The default is now 2 hours
// — well above any legitimate rescue I have seen in production
// (multi-step refactors, deep multi-file investigation) but a hard
// backstop against runaway agents. Users can still pass `--timeout 0`
// to opt back into unbounded behavior when they know the workload.
const DEFAULT_ASK_TIMEOUT_MS = 5 * 60 * 1000;       // 5 min
const DEFAULT_REVIEW_TIMEOUT_MS = 20 * 60 * 1000;   // 20 min
const DEFAULT_TASK_TIMEOUT_MS = 2 * 60 * 60 * 1000; // 2 hours

// Hard cap on per-job on-disk stdout/stderr size. Without this, an
// adversarial prompt trapping Grok in an infinite output loop would fill
// the host filesystem before the timeout (or cancel) fires. 500 MiB is
// generous for any legitimate run (a long review streams a few MB of
// reasoning at most) while making host-OS DoS structurally impossible.
// On overflow we kill the process tree and mark the job failed; the
// truncated log is preserved for postmortem.
const MAX_JOB_LOG_BYTES = 500 * 1024 * 1024;

// Default max-turns budgets. The probe-time discovery (~/.grok/README +
// hands-on testing) showed Grok consumes ~4 internal messages even for a
// trivial reply, so the floor must be well above 4 for any real interaction.
const DEFAULT_ASK_MAX_TURNS = 30;
const DEFAULT_REVIEW_MAX_TURNS = 60;

// Node's setTimeout silently truncates delays exceeding 2^31-1 ms (~24.85d):
// instead of waiting that long, the timer fires at ~1ms and Node prints a
// TimeoutOverflowWarning. So `--timeout 30d` would wrap to "instantly" without
// this clamp.
const MAX_SETTIMEOUT_MS = 2_147_483_647;

function resolveTimeoutMs(rawFlag, defaultMs) {
  if (rawFlag === undefined) return defaultMs;
  const parsed = parseDuration(String(rawFlag));
  if (parsed === null) {
    console.error(`Invalid --timeout value: ${rawFlag}. Use forms like 300s, 20m, or 0 to disable.`);
    process.exit(2);
  }
  if (parsed > MAX_SETTIMEOUT_MS) {
    process.stderr.write(`[grok-plugin] --timeout ${rawFlag} exceeds Node's max setTimeout delay (${MAX_SETTIMEOUT_MS} ms ~ 24.85d). Clamping; pass --timeout 0 to disable instead.\n`);
    return MAX_SETTIMEOUT_MS;
  }
  return parsed;
}

// Hard cap on how much of the on-disk log we will read into memory for JSON
// parsing. The disk log is uncapped (raw bytes kept for debugging), but
// JSON.parse on a multi-GB string would OOM the process.
const MAX_REVIEW_JSON_BYTES = 8 * 1024 * 1024;      // 8 MB

// Standard exit code for "command terminated by timeout" (matches GNU
// timeout(1)). Distinguishable from policy refusals (2) and missing-binary
// (127) so wrappers can tell timeouts apart from other failures.
const EXIT_TIMEOUT = 124;

// Valid values for --effort, per `grok --help`. We let the user pass any of
// these through unchanged; anything else is rejected at parse time rather
// than being surfaced as a confusing CLI error.
// Gemini v0.6.0 round-2 nit-N3: VALID_EFFORTS used to live here and
// duplicate EFFORT_LEVELS from lib/grok.mjs. Drift risk. Single source of
// truth lives in lib/grok.mjs now; companion.mjs's validateEffort is a
// case-insensitive *normalizer* layered on top.
function validateEffort(effort) {
  if (effort === undefined || effort === null || effort === "") return null;
  const e = String(effort).toLowerCase().trim();
  if (!EFFORT_LEVELS.has(e)) {
    console.error(`Invalid --effort: ${effort}. Valid values: ${[...EFFORT_LEVELS].join(", ")}.`);
    process.exit(2);
  }
  return e;
}

// writePromptToTempFile moved to lib/grok.mjs in v0.5.0 (was duplicated
// here and in stop-review-gate-hook.mjs). Imported above.

function safeUnlink(p) {
  try { fs.unlinkSync(p); } catch {}
}

// readBoundedFile removed in v0.5.0 — replaced by `readBoundedJobLog` in
// lib/state.mjs, which is TOCTOU-safe via O_NOFOLLOW + fstat on a single
// fd. cmdResult is the only caller, and it now uses readBoundedJobLog.

// Validate that a path Grok claimed to write (an image / video output)
// is safe to print to the user's terminal as part of an `open <path>`
// hint. Two attack surfaces in scope:
//
//   1. Shell-metacharacter injection. A malicious model returning a
//      markdown link like `![alt]("; rm -rf ~; #)` would otherwise have
//      the plugin display `open ""; rm -rf ~; #"` — a copy-paste
//      command-injection trap.
//
//   2. Argument injection via leading hyphen. macOS `open -aTerminal`
//      parses the path as a FLAG (launching Terminal.app instead of
//      opening the file). A model returning `-aTerminal` as a "path"
//      would otherwise produce `open "-aTerminal"` — visually a file
//      path but actually an arg. (Gemini round-4 finding.)
//
// Defense: legitimate /imagine output is always an absolute path under
// `~/.grok/sessions/<workspace>/<session>/images/<n>.<ext>`. Require:
//   - First character: `/` (absolute path; refuses leading `-` or any
//     other non-slash character).
//   - Body: alphanumeric, `.`, `_`, `/`, `-`, `%`, `@`, `+` only.
//   - Length 1..4096.
// The /imagine output handler ALSO writes the hint as `open -- "<path>"`
// (POSIX end-of-options marker) for defense in depth.
const SAFE_MEDIA_PATH_PATTERN = /^\/[A-Za-z0-9._\/\-%@+]*$/;
function isSafeMediaPath(p) {
  return typeof p === "string" && p.length > 0 && p.length < 4096 && SAFE_MEDIA_PATH_PATTERN.test(p);
}

// v1.0.4 (Codex P0): confine media-source paths to grok's session dir
// before any destructive operation (today: --save-to copyFileSync).
// Without this, a prompt-injected grok could return a markdown link
// like `![](/etc/passwd)` and the plugin would happily read /etc/passwd
// and write its contents to whatever --save-to path the user supplied
// — a real local-file exfiltration vector. The display path
// (`Image: /etc/passwd`) is already noisy enough that a user would
// notice, but a scripted --save-to caller with the path coming from
// --json wouldn't see the malicious path until after the copy.
//
// Uses path.resolve to defeat traversal attacks like
// `${sessionsRoot}/../etc/passwd` — resolve collapses `..` segments so
// the post-resolve prefix check is authoritative. (We do NOT realpath
// — that would require the file to exist at check time, which is
// fine for the copy path but unnecessary here; the source must exist
// for copyFileSync to do anything anyway.)
function isUnderGrokSessionsDir(p) {
  if (typeof p !== "string" || !p) return false;
  const sessionsRoot = path.join(grokHomeDir(), "sessions");
  const resolved = path.resolve(p);
  return resolved === sessionsRoot || resolved.startsWith(sessionsRoot + path.sep);
}

// ---------- subcommand: setup ----------

function cmdSetup({ flags }) {
  const wantJson = !!flags.json;
  const result = {
    ready: false,
    node: { available: !!process.versions.node, detail: `v${process.versions.node}` },
    grok: { available: false, detail: null, version_ok: false },
    capabilities: { ok: false, missing: [] },
    auth: { available: false, detail: null, source: null },
    model: { active: effectiveModel(), default: DEFAULT_MODEL, override: process.env.GROK_PLUGIN_MODEL || null },
    reviewGateEnabled: false,
    actionsTaken: [],
    nextSteps: []
  };

  // Toggle review gate first so the result reflects the new state.
  if (flags["enable-review-gate"]) {
    setReviewGate(process.cwd(), true);
    result.actionsTaken.push("Enabled the stop-time review gate for this workspace.");
  } else if (flags["disable-review-gate"]) {
    setReviewGate(process.cwd(), false);
    result.actionsTaken.push("Disabled the stop-time review gate for this workspace.");
  }
  const cfg = readConfig(process.cwd());
  result.reviewGateEnabled = !!cfg.reviewGateEnabled;

  const grokBin = which("grok");
  if (grokBin) {
    result.grok.available = true;
    const rawVer = grokVersion();
    // v1.0.1 (issue #1): distinguish "version line printed" from "binary
    // exited 0 with empty output" — the latter is the broken-auto-update
    // failure mode where setup needs to surface a recovery hint, not a
    // generic version-warning. grokVersion() returns "" for that case.
    if (rawVer === "") {
      result.grok.detail = "installed but returns empty output";
      result.grok.broken = true;
      result.grok.version_ok = false;
      result.nextSteps.push(
        "Grok CLI returned empty output for `grok --version` — likely a broken auto-update. Try (in order):\n" +
        "  1. `grok update` to reinstall the latest version, OR\n" +
        "  2. Roll back: `ls ~/.grok/downloads/` then `ln -sf ../downloads/<previous-binary> ~/.grok/bin/grok`, OR\n" +
        "  3. Reinstall: `curl -fsSL https://x.ai/cli/install.sh | bash`"
      );
    } else {
      result.grok.detail = rawVer || "installed";
      const verCheck = checkMinVersion(rawVer);
      result.grok.version_ok = verCheck.ok;
      if (!verCheck.ok) {
        result.grok.version_warning = verCheck.reason;
        result.nextSteps.push(
          `Upgrade Grok CLI: \`grok update\` (or reinstall via \`curl -fsSL https://x.ai/cli/install.sh | bash\`). Plugin requires >= ${MIN_GROK_VERSION}; detected ${verCheck.current || "unknown"}.`
        );
      }
    }
  } else {
    result.grok.detail = "not installed";
    result.nextSteps.push("Install Grok CLI: `curl -fsSL https://x.ai/cli/install.sh | bash`");
  }

  if (result.grok.available) {
    const cap = capabilityProbe();
    result.capabilities = cap;
    if (!cap.ok) {
      result.nextSteps.push(
        `Grok CLI is missing flags this plugin depends on: ${cap.missing.join(", ")}. Upgrade with \`grok update\`.`
      );
    }
  }

  if (result.grok.available && result.capabilities.ok) {
    const probe = probeWithFallback();
    result.auth.available = probe.ok;
    result.auth.detail = probe.detail;
    result.auth.source = probe.ok ? detectAuthSource() : null;
    if (probe.fallbackUsed) {
      setActiveModel(process.cwd(), probe.fallbackUsed);
      result.model.active = probe.fallbackUsed;
      result.model.fallbackUsed = probe.fallbackUsed;
      result.actionsTaken.push(
        `Default model ${result.model.default} unavailable; persisting fallback ${probe.fallbackUsed} for this workspace. Override with --model or GROK_PLUGIN_MODEL.`
      );
    } else if (probe.ok) {
      const cur = readConfig(process.cwd());
      if (cur.activeModel && cur.activeModel !== result.model.default) {
        setActiveModel(process.cwd(), null);
        result.actionsTaken.push(
          `Default model ${result.model.default} is available again; cleared persisted fallback ${cur.activeModel}.`
        );
      }
    }
    if (!probe.ok) {
      if (probe.detail === "model unavailable") {
        const tried = [result.model.default, ...MODEL_FALLBACK_CHAIN.filter(m => m !== result.model.default)];
        result.nextSteps.push(
          `No fallback-chain model is available for this account. Tried: ${tried.join(", ")}. Override with --model or GROK_PLUGIN_MODEL.`
        );
      } else if (probe.detail === "no auth method configured") {
        result.nextSteps.push(
          "Authenticate Grok. Either:\n  - Run `!grok login` and complete the browser OAuth flow, OR\n  - Set XAI_API_KEY (get a key from https://console.x.ai) - either inline (`export XAI_API_KEY=...`) or in `~/.claude/settings.json` under `env`. (The legacy GROK_CODE_XAI_API_KEY still works as a fallback.)"
        );
      } else {
        result.nextSteps.push(`Grok auth probe failed (${probe.detail}). Try \`!grok login\` to refresh credentials.`);
      }
    }
  }

  if (result.grok.available && result.capabilities.ok && result.auth.available && !result.reviewGateEnabled) {
    result.nextSteps.push("Optional: run `/grok:setup --enable-review-gate` to require a fresh review before stop.");
  }

  result.ready = result.grok.available && result.capabilities.ok && result.auth.available;

  if (wantJson) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  } else {
    if (result.actionsTaken.length) {
      for (const a of result.actionsTaken) console.log(a);
      console.log("");
    }
    console.log(`Node:         ${result.node.detail}`);
    console.log(`Grok:         ${result.grok.detail}`);
    console.log(`Capabilities: ${result.capabilities.ok ? "ok" : `missing: ${result.capabilities.missing.join(", ")}`}`);
    console.log(`Auth:         ${result.auth.available ? "OK working" : "FAIL " + result.auth.detail}${result.auth.source ? ` (${result.auth.source})` : ""}`);
    console.log(`Model:        ${result.model.active}${result.model.override ? "  (via GROK_PLUGIN_MODEL)" : "  (plugin default)"}`);
    console.log(`Review gate:  ${result.reviewGateEnabled ? "enabled" : "disabled"}`);
    if (result.nextSteps.length) {
      console.log("\nNext steps:");
      for (const step of result.nextSteps) console.log(`- ${step}`);
    } else {
      console.log("\nGrok plugin is ready.");
    }
  }
  process.exit(result.ready ? 0 : 1);
}

// ---------- subcommand: ask ----------

// parseGrokJson moved to lib/grok.mjs in v0.5.0 (was here in companion
// AND in stop-review-gate-hook.mjs::parseGrokJsonEnvelope). Imported
// above. The two-parser drift Codex flagged is closed.

// ---------- shared failure diagnostics (v1.0.1, issues #1+#2) ----------
//
// When the spawned `grok` child exits with both stdout AND stderr empty,
// the user previously got an opaque non-zero exit with no signal at all
// (observed during the 0.1.210→0.1.211 auto-update where the new binary
// returned empty for every command). The fix: always print the exit
// code, the command argv (shell-quoted so it pastes back), and a recovery
// hint. Used by runHeadlessGrok, cmdImagine, and runJob.
function shellQuoteArgv(argv) {
  return argv.map(a => {
    if (a == null) return "";
    const s = String(a);
    if (/[\s"'$`\\<>|;&*?(){}#!]/.test(s) || s.includes("\n")) return JSON.stringify(s);
    return s;
  }).join(" ");
}
// v1.0.5 (issue #9): "empty for practical purposes". A 1-byte newline (the
// silent-empty pattern observed on synthesis-style ~18KB prompts hitting an
// upstream-grok abort path) is truthy in JS, so the original `!r.stdout`
// check missed it. Treat whitespace-only output as anomalous too.
function isWhitespaceOnly(s) {
  if (s == null || s === "") return true;
  return String(s).trim().length === 0;
}
function diagnoseEmptySpawnFailure({ args, status, label }) {
  const cmdStr = shellQuoteArgv(["grok", ...args]);
  process.stderr.write(
    `\n[grok-plugin] ${label}: grok exited ${status ?? "?"} with empty stdout and stderr.\n` +
    `[grok-plugin] Command: ${cmdStr}\n` +
    `[grok-plugin] The grok binary may be broken, OR your prompt may have hit an upstream silent-abort path\n` +
    `[grok-plugin] (observed on certain large synthesis-style prompts in 0.1.211 — see issue #9). Try:\n` +
    `[grok-plugin]   1. /grok:setup     — verify the binary is healthy\n` +
    `[grok-plugin]   2. grok update     — reinstall the latest version\n` +
    `[grok-plugin]   3. ls ~/.grok/downloads/ && ln -sf ../downloads/<previous-binary> ~/.grok/bin/grok — roll back\n` +
    `[grok-plugin]   4. Re-run with --output-format=json to see the raw envelope (large prompts that look\n` +
    `[grok-plugin]      like 'SAMPLE A: ... SAMPLE B: ... synthesize' may trigger the upstream abort —\n` +
    `[grok-plugin]      wait for /grok:aggregate-of-n in v1.1.0 for a structurally safe version).\n`
  );
}

// ---------- shared headless dispatcher (v0.6.0 refactor) ----------
//
// cmdAsk, cmdResearch, and cmdBestOf used to each carry their own ~30-line
// copy of this exact block. Claude general v0.6.0 review nit-1 flagged the
// drift risk — when v0.5.0 added the `[hint: ...]` lines after stderr, it
// would only have propagated to one of three callers. Centralizing here
// makes the policy uniform.
//
// Contract: spawn grok with `args`, sanitize all output, classify auth
// failures, and process.exit() with an appropriate code. The function
// does NOT return — every code path ends in process.exit. Callers must
// not put work after the call.
//
//   args         — full argv to pass to `grok` (no leading binary).
//   timeoutMs    — child-process timeout. 0 means no Node-level timeout.
//                  Always clamped to MAX_SETTIMEOUT_MS.
//   label        — short word for the timeout error message ("ask",
//                  "research", "best-of"). Surfaces in user-facing text.
//   timeoutHint  — optional second sentence after the timeout line.
//                  cmdAsk / cmdResearch use this to suggest alternate
//                  --timeout values; cmdBestOf passes "" (no hint).
// Headless-output cap. spawnSync's default maxBuffer is 1 MiB and on
// overflow it sets `r.error.code === "ENOBUFS"` while leaving `r.status`
// as `null`. Codex v0.6.0 round-2: without an explicit bound + error
// check, a long /grok:research stream silently truncates and the helper
// exits 0 anyway. 32 MiB is generous for any reasonable headless answer
// (research streams in the wild are 100-500 KiB) while keeping the cap
// well below process RSS.
const HEADLESS_GROK_MAX_BUFFER = 32 * 1024 * 1024;
function runHeadlessGrok({ args, timeoutMs, label, timeoutHint = "", extraEnv = null }) {
  const spawnOpts = {
    encoding: "utf8",
    env: cleanGrokEnv(process.env, extraEnv),
    maxBuffer: HEADLESS_GROK_MAX_BUFFER
  };
  if (timeoutMs > 0) spawnOpts.timeout = Math.min(timeoutMs, MAX_SETTIMEOUT_MS);
  const r = spawnSync("grok", args, spawnOpts);
  if (r.error && r.error.code === "ETIMEDOUT") {
    if (r.stdout) process.stdout.write(sanitizeForTerminal(r.stdout));
    if (r.stderr) process.stderr.write(sanitizeForTerminal(r.stderr));
    const hintSuffix = timeoutHint ? ` ${timeoutHint}` : "";
    process.stderr.write(`\n[grok-plugin] ${label} timed out after ${timeoutMs}ms.${hintSuffix}\n`);
    process.exit(EXIT_TIMEOUT);
  }
  // Codex v0.6.0 round-2 BLOCKING B: spawnSync errors other than ETIMEDOUT
  // (ENOBUFS, ENOENT, EAGAIN, …) used to fall through to the json-parse
  // path with status=null and produce a misleading exit 0. Refuse early
  // and surface the real cause.
  if (r.error) {
    if (r.stdout) process.stdout.write(sanitizeForTerminal(r.stdout));
    if (r.stderr) process.stderr.write(sanitizeForTerminal(r.stderr));
    process.stderr.write(`\n[grok-plugin] ${label} failed: ${r.error.code || r.error.message}\n`);
    if (r.error.code === "ENOBUFS") {
      process.stderr.write(`[grok-plugin] grok output exceeded ${HEADLESS_GROK_MAX_BUFFER} bytes (HEADLESS_GROK_MAX_BUFFER); rerun via /grok:rescue or /grok:task for a streaming long-form session.\n`);
    }
    process.exit(1);
  }
  const parsed = parseGrokJson(r.stdout || "");
  if (parsed.kind === "text") {
    // Codex v0.6.0 round-2 BLOCKING A: parsed.text comes from JSON which
    // can carry escape sequences as  that survive JSON.parse intact.
    // Without sanitizeForTerminal those reach the user's terminal raw and
    // are dangerous (OSC 52 clipboard injection, cursor moves, screen
    // clear, color-spoofed phishing). Same defense as the unparsed-fallback
    // path below.
    process.stdout.write(sanitizeForTerminal(parsed.text + "\n"));
    process.exit(0);
  }
  if (parsed.kind === "error") {
    const why = classifyAuthBlob(parsed.message);
    process.stderr.write(`Grok error: ${sanitizeForTerminal(parsed.message)}\n`);
    if (why) process.stderr.write(`[hint: ${why}. Run /grok:setup.]\n`);
    process.exit(1);
  }
  // Couldn't parse — fall back to whatever Grok printed, but also surface stderr.
  if (r.stdout) process.stdout.write(sanitizeForTerminal(r.stdout));
  if (r.status !== 0) {
    if (r.stderr) process.stderr.write(sanitizeForTerminal(r.stderr));
    const why = classifyAuthBlob((r.stdout || "") + "\n" + (r.stderr || ""));
    if (why) process.stderr.write(`\n[hint: ${why}. Run /grok:setup.]\n`);
  }
  // v1.0.1 (issue #2): empty stdout + empty stderr is anomalous — the user
  // gets no signal otherwise. Surface the exit code and the full argv so
  // they can either re-run manually or rule out a broken-binary case.
  // Exit code: preserve r.status semantics; the diagnostic is the signal.
  // v1.0.5 (issue #9): tighten — a 1-byte newline ("\n") is truthy, so the
  // original `!r.stdout` check missed grok's silent-empty case on large
  // synthesis prompts (~18KB). Use trim().length to treat whitespace-only
  // output as anomalous too.
  if (isWhitespaceOnly(r.stdout) && isWhitespaceOnly(r.stderr)) {
    diagnoseEmptySpawnFailure({ args, status: r.status, label });
  }
  process.exit(r.status ?? 0);
}

// v0.8.0: pluck the user-facing permission/policy flags from a parsed
// flags object into the shape grokBaseArgs expects. Returns an object
// suitable for spreading into grokBaseArgs({...}) — only includes keys
// the user actually passed, so command-specific defaults (effort=max,
// check=true, etc.) elsewhere are preserved.
function extractPolicyFlags(flags) {
  const out = {};
  if (Array.isArray(flags.allow)) out.allow = flags.allow;
  if (Array.isArray(flags.deny)) out.deny = flags.deny;
  if (Array.isArray(flags.rules)) out.rules = flags.rules;
  if (flags.tools != null) out.tools = flags.tools;
  if (flags["max-turns"] != null) out.maxTurns = flags["max-turns"];
  if (flags["no-subagents"]) out.noSubagents = true;
  if (flags["no-plan"]) out.noPlan = true;
  if (flags.verbatim) out.verbatim = true;
  if (flags["reasoning-effort"] != null) out.reasoningEffort = flags["reasoning-effort"];
  if (flags["system-prompt-override"] != null) out.systemPromptOverride = flags["system-prompt-override"];
  if (flags["permission-mode"] != null) out.permissionMode = flags["permission-mode"];
  if (flags.sandbox != null) out.sandbox = flags.sandbox;
  if (flags.agent != null) out.agent = flags.agent;
  // v0.9.0 — session / worktree / memory passthroughs
  if (flags.worktree != null) out.worktree = flags.worktree;
  if (flags.continue) out.continueSession = true;
  if (flags.resume != null) out.resume = flags.resume;
  if (flags["restore-code"]) out.restoreCode = true;
  if (flags["no-memory"]) out.noMemory = true;
  if (flags["experimental-memory"]) out.experimentalMemory = true;
  return out;
}

function cmdAsk({ flags, positional }) {
  const prompt = positional.join(" ").trim();
  if (!prompt) {
    console.error("Usage: ask <question>");
    process.exit(2);
  }
  const timeoutMs = resolveTimeoutMs(flags.timeout, DEFAULT_ASK_TIMEOUT_MS);
  const effort = validateEffort(flags.effort);
  if (!which("grok")) {
    console.error("Grok CLI not installed. Run `/grok:setup`.");
    process.exit(127);
  }
  // Always request json output internally so we can detect Grok's
  // exit-0-on-internal-error case and surface a clean error.
  // v0.6.0 nit-N2: thread --no-web-search.
  // v0.8.0: thread --allow/--deny/--rules/--tools/--max-turns/etc.
  // The user --max-turns (if provided) wins over DEFAULT_ASK_MAX_TURNS.
  const disableWebSearch = !!flags["no-web-search"];
  const checkFlag = !!flags.check;
  let baseArgs;
  try {
    baseArgs = grokBaseArgs({
      readOnly: true,
      model: flags.model,
      jsonOutput: true,
      effort,
      check: checkFlag,
      disableWebSearch,
      ...extractPolicyFlags(flags)
    });
  } catch (e) {
    console.error(String(e.message || e));
    process.exit(2);
  }
  const args = ["-p", prompt, ...baseArgs];
  // If the user did NOT supply --max-turns, fall back to the plugin
  // default. extractPolicyFlags already pushed --max-turns into baseArgs
  // when the user supplied one, so we only add the default in the
  // absence of a user value.
  if (flags["max-turns"] == null) args.push("--max-turns", String(DEFAULT_ASK_MAX_TURNS));
  // v1.2.0: turn Grok's web_fetch grounding tool ON by default (off in the
  // CLI unless GROK_WEB_FETCH=1) so a pasted URL can be fetched. Suppressed
  // by --no-web-fetch, by --no-web-search (offline intent), or by a user-set
  // GROK_WEB_FETCH env value.
  const extraEnv = webFetchEnvOverride({ noWebFetch: !!flags["no-web-fetch"] || disableWebSearch });
  runHeadlessGrok({
    args, timeoutMs, label: "ask", extraEnv,
    timeoutHint: "Re-run with --timeout 0 to disable, or pick a longer duration like --timeout 15m."
  });
}

// ---------- shared job runner ----------

const MAX_JOB_BUF = 256 * 1024;

// Spawn `grok`, stream output to a job log on disk (and optionally to the
// user's stdout, sanitized), and resolve when the process closes. Used by
// both cmdReview and cmdTask.
function runJob({ args, meta, showStdout = true, timeoutMs = 0, cleanupPaths = [] }) {
  return new Promise((resolve, reject) => {
    ensureDir(jobsDir());
    const stdoutFd = fs.openSync(meta.stdout_path, "w");
    const stderrFd = fs.openSync(meta.stderr_path, "w");

    const proc = spawn("grok", args, {
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
      env: cleanGrokEnv()
    });
    // Tell Node to UTF-8-decode the child's stdio streams BEFORE the data
    // handlers see chunks. Without this, multi-byte sequences that split
    // across chunk boundaries decode to U+FFFD replacement characters and
    // can silently corrupt the JSON envelope or, worse, the user-visible
    // streamed output. Node uses an internal StringDecoder when you call
    // setEncoding, so multi-byte sequences are buffered and emitted only
    // when complete.
    proc.stdout.setEncoding("utf8");
    proc.stderr.setEncoding("utf8");
    meta.pid = proc.pid;
    if (timeoutMs > 0) meta.timeout_ms = timeoutMs;
    writeJobMeta(meta.id, meta);
    pruneJobs();

    let outBuf = "", errBuf = "";
    const sanitizer = new TerminalSanitizer();

    let timedOut = false;
    let diskOverflowed = false;
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timeoutTimer = null;
    if (timeoutMs > 0) {
      timeoutTimer = setTimeout(() => {
        if (proc.exitCode !== null || proc.signalCode !== null) return;
        timedOut = true;
        meta.status = "timed-out";
        meta.ended_at = new Date().toISOString();
        try { writeJobMeta(meta.id, meta); } catch {}
        terminateProcessTree(proc.pid).catch(() => {});
      }, timeoutMs);
    }

    // Trigger when the combined stdout+stderr on-disk size exceeds the
    // cap. Mark status BEFORE killing the process so the close handler
    // sees "disk-overflow" and doesn't race-overwrite it with "failed".
    // Mirrors the timeout-timer pattern.
    function tripDiskOverflow() {
      if (diskOverflowed) return;
      diskOverflowed = true;
      meta.status = "disk-overflow";
      meta.ended_at = new Date().toISOString();
      meta.error = `on-disk log exceeded ${MAX_JOB_LOG_BYTES} bytes; process killed to protect filesystem`;
      try { writeJobMeta(meta.id, meta); } catch {}
      terminateProcessTree(proc.pid).catch(() => {});
    }

    proc.stdout.on("data", d => {
      // setEncoding("utf8") above means `d` is already a UTF-8-safe
      // string (decoded with an internal StringDecoder that buffers
      // incomplete sequences across chunks). We still need to write to
      // disk — fs.writeSync accepts strings and writes them as utf8 by
      // default, so the on-disk log stays byte-accurate.
      const bytes = Buffer.byteLength(d, "utf8");
      if (stdoutBytes + stderrBytes + bytes > MAX_JOB_LOG_BYTES) {
        // Write what we can fit, then trip overflow. The trailing
        // truncation marker lets postmortem readers tell why the log
        // stops mid-stream.
        const remaining = MAX_JOB_LOG_BYTES - stdoutBytes - stderrBytes;
        if (remaining > 0) {
          try { fs.writeSync(stdoutFd, d.slice(0, remaining)); } catch {}
          stdoutBytes += remaining;
        }
        try { fs.writeSync(stdoutFd, `\n[grok-plugin] LOG CAP HIT — process terminated to protect filesystem (${MAX_JOB_LOG_BYTES} bytes)\n`); } catch {}
        tripDiskOverflow();
        return;
      }
      stdoutBytes += bytes;
      fs.writeSync(stdoutFd, d);
      if (showStdout) {
        const safe = sanitizer.push(d);
        if (safe) process.stdout.write(safe);
      }
      if (outBuf.length < MAX_JOB_BUF) {
        outBuf += d.slice(0, MAX_JOB_BUF - outBuf.length);
      }
    });
    proc.stderr.on("data", d => {
      const bytes = Buffer.byteLength(d, "utf8");
      if (stdoutBytes + stderrBytes + bytes > MAX_JOB_LOG_BYTES) {
        const remaining = MAX_JOB_LOG_BYTES - stdoutBytes - stderrBytes;
        if (remaining > 0) {
          try { fs.writeSync(stderrFd, d.slice(0, remaining)); } catch {}
          stderrBytes += remaining;
        }
        try { fs.writeSync(stderrFd, `\n[grok-plugin] LOG CAP HIT — process terminated to protect filesystem\n`); } catch {}
        tripDiskOverflow();
        return;
      }
      stderrBytes += bytes;
      fs.writeSync(stderrFd, d);
      if (errBuf.length < MAX_JOB_BUF) {
        errBuf += d.slice(0, MAX_JOB_BUF - errBuf.length);
      }
    });

    proc.on("close", code => {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      try { fs.closeSync(stdoutFd); } catch {}
      try { fs.closeSync(stderrFd); } catch {}
      if (showStdout) {
        const tail = sanitizer.flush();
        if (tail) process.stdout.write(tail);
      }
      for (const p of cleanupPaths) safeUnlink(p);

      const current = readJobMeta(meta.id) || meta;
      // Grok returns exit 0 even on internal `{"type":"error"}` payloads.
      // Look at the parsed JSON envelope to set the right job status.
      //
      // outBuf is capped at MAX_JOB_BUF (256 KiB), so for any output above
      // that cap the truncated buffer cannot parse as valid JSON and we
      // would silently flip an error payload to "completed". Re-read the
      // full file from disk for the envelope check, but bound the read at
      // MAX_REVIEW_JSON_BYTES so a runaway response cannot OOM us.
      let parsedOut = parseGrokJson(outBuf);
      if (parsedOut.kind === "unknown") {
        try {
          const stat = fs.statSync(meta.stdout_path);
          if (stat.size > outBuf.length && stat.size <= MAX_REVIEW_JSON_BYTES) {
            const full = fs.readFileSync(meta.stdout_path, "utf8");
            parsedOut = parseGrokJson(full);
          }
        } catch {}
      }
      const grokInternalError = parsedOut.kind === "error";

      if (current.status === "cancelled" || current.status === "timed-out" || current.status === "disk-overflow") {
        current.exit_code = code;
        writeJobMeta(meta.id, current);
        meta.status = current.status;
      } else if (grokInternalError) {
        meta.status = "failed";
        meta.exit_code = code;
        meta.error = parsedOut.message;
        meta.ended_at = new Date().toISOString();
        writeJobMeta(meta.id, meta);
      } else {
        meta.status = code === 0 ? "completed" : "failed";
        meta.exit_code = code;
        if (parsedOut.kind === "text" && parsedOut.sessionId) {
          meta.session_id = parsedOut.sessionId;
          // v0.9.12 (Grok LOW + Gemini Important round-12): use the
          // shared `commandUsesJsonOutput` helper from lib/grok.mjs.
          // It recognizes BOTH `--output-format json` (space form,
          // what grokBaseArgs emits today) AND `--output-format=json`
          // (inline form a future caller could use). Last-wins
          // semantics across duplicate flags. The v0.9.11 inline
          // scanner only handled the space form and would have
          // silently suppressed trust for any caller using inline.
          meta.session_id_trustworthy = commandUsesJsonOutput(meta.command);
        }
        // v1.0.6 (issue #10): mark `no_output` on meta when the job
        // exits with no stdout AND no stderr. cmdResult and downstream
        // subagents (grok-rescue, grok-aggregate-review) can route on
        // this to surface a recovery hint instead of showing "(empty)".
        // Whitespace-only is treated as empty too — matches v1.0.5's
        // `isWhitespaceOnly` rule from the runHeadlessGrok/cmdImagine
        // paths.
        if (isWhitespaceOnly(outBuf) && isWhitespaceOnly(errBuf)) {
          meta.no_output = true;
        }
        meta.ended_at = new Date().toISOString();
        writeJobMeta(meta.id, meta);
      }

      if (timedOut) {
        process.stderr.write(`\n[grok-plugin] Job ${meta.id} timed out after ${timeoutMs}ms. Re-run with --timeout 0 to disable, or pick a longer duration like --timeout 30m.\n`);
      } else if (diskOverflowed) {
        process.stderr.write(`\n[grok-plugin] Job ${meta.id} terminated: on-disk log exceeded ${MAX_JOB_LOG_BYTES} bytes. The log was truncated at the cap; full output was not captured. Check the prompt — Grok was likely in an output loop.\n`);
      } else if ((code !== 0 || grokInternalError) && meta.status !== "cancelled") {
        if (errBuf) process.stderr.write(sanitizeForTerminal(errBuf));
        const why = classifyAuthBlob(outBuf + "\n" + errBuf);
        if (why) process.stderr.write(`\n[hint: ${why}. Run /grok:setup.]\n`);
        // v1.0.1 (issue #2): when both buffers are empty in a non-zero exit,
        // surface the argv + recovery hints so the user isn't left guessing.
        // Matches the same anomaly we diagnose in runHeadlessGrok/cmdImagine.
        // v1.0.5 (issue #9): also fire when buffers are whitespace-only
        // (a 1-byte newline was previously missed because "\n" is truthy).
        if (isWhitespaceOnly(outBuf) && isWhitespaceOnly(errBuf)) {
          diagnoseEmptySpawnFailure({ args: meta.command.slice(1), status: code, label: `Job ${meta.id}` });
        }
      } else if (meta.no_output && meta.status !== "cancelled") {
        // v1.0.6 (issue #10): exit-0 with no output is the FOURTH silent-
        // failure pattern (after v1.0.1 broken-binary, v1.0.5 1-byte newline
        // in runHeadlessGrok/cmdImagine). Previously runJob's diagnostic
        // was gated by `code !== 0 || grokInternalError`, so a clean exit
        // with empty log files (the issue #10 case — `companion.mjs task`
        // returns "completed" + empty stdout/stderr) slipped past silently.
        // The reporter's grok-rescue agent hung waiting for non-existent
        // output. Always surface the anomaly so callers can act on it.
        diagnoseEmptySpawnFailure({ args: meta.command.slice(1), status: code, label: `Job ${meta.id}` });
      }

      resolve({ code, outBuf, errBuf, timedOut, diskOverflowed, parsedOut });
    });

    proc.on("error", err => {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      try { fs.closeSync(stdoutFd); } catch {}
      try { fs.closeSync(stderrFd); } catch {}
      for (const p of cleanupPaths) safeUnlink(p);
      meta.status = "failed";
      meta.exit_code = -1;
      meta.error = err.message;
      meta.ended_at = new Date().toISOString();
      writeJobMeta(meta.id, meta);
      reject(err);
    });
  });
}

function buildJobMeta({ kind, args, task_text, extra = {} }) {
  const id = newJobId();
  const dir = jobsDir();
  return {
    version: 1,
    id,
    kind,
    pid: null,
    command: ["grok", ...args],
    started_at: new Date().toISOString(),
    status: "running",
    stdout_path: path.join(dir, `${id}.stdout.log`),
    stderr_path: path.join(dir, `${id}.stderr.log`),
    task_text,
    ...extra
  };
}

// ---------- subcommand: review / adversarial-review ----------

// Severity levels allowed by schemas/review-output.schema.json. Kept in sync
// with the schema by hand because we want to fail loudly here without
// pulling in an AJV dependency.
const SCHEMA_SEVERITIES = new Set(["critical", "high", "medium", "low"]);

// Hard caps on individual schema fields. A misbehaving Grok could return a
// 5 MiB `summary` or `next_steps[]` entry — rendering that to the user's
// terminal would lock it up. Caps are generous enough for any reasonable
// review (each finding's body can be ~64 KiB).
const SCHEMA_MAX_STRING_BYTES = 64 * 1024;
const SCHEMA_MAX_ARRAY_LEN = 256;

function checkBoundedString(value, label) {
  if (typeof value !== "string") return `${label} is not a string`;
  if (Buffer.byteLength(value, "utf8") > SCHEMA_MAX_STRING_BYTES) {
    return `${label} exceeds ${SCHEMA_MAX_STRING_BYTES} bytes`;
  }
  return null;
}

// Validate a parsed review object against schemas/review-output.schema.json.
// Returns null on success, a human-readable error message on failure.
// Replaces the previous "shallow" check (which only validated top-level
// keys + verdict enum). The strict version enforces:
//   - top-level shape (verdict / summary / findings / next_steps)
//   - severity enum on every finding (matches schema)
//   - bounded string lengths so a runaway model can't break the terminal
//   - bounded array lengths on findings and next_steps
//   - each finding has the required fields, with the right types
function validateReviewSchema(obj) {
  if (!obj || typeof obj !== "object") return "not an object";
  for (const key of ["verdict", "summary", "findings", "next_steps"]) {
    if (!(key in obj)) return `missing required key: ${key}`;
  }
  if (!["approve", "needs-attention"].includes(obj.verdict)) return `bad verdict: ${obj.verdict}`;
  const summaryErr = checkBoundedString(obj.summary, "summary");
  if (summaryErr) return summaryErr;
  if (!Array.isArray(obj.findings)) return "findings is not an array";
  if (obj.findings.length > SCHEMA_MAX_ARRAY_LEN) {
    return `findings has ${obj.findings.length} entries (max ${SCHEMA_MAX_ARRAY_LEN})`;
  }
  for (let i = 0; i < obj.findings.length; i++) {
    const f = obj.findings[i];
    if (!f || typeof f !== "object") return `findings[${i}] is not an object`;
    for (const key of ["severity", "title", "body", "file", "line_start", "line_end", "confidence", "recommendation"]) {
      if (!(key in f)) return `findings[${i}] missing key: ${key}`;
    }
    if (!SCHEMA_SEVERITIES.has(f.severity)) {
      return `findings[${i}] has invalid severity: ${f.severity} (allowed: ${[...SCHEMA_SEVERITIES].join(", ")})`;
    }
    for (const strField of ["title", "body", "file", "recommendation"]) {
      const err = checkBoundedString(f[strField], `findings[${i}].${strField}`);
      if (err) return err;
    }
    if (!Number.isInteger(f.line_start) || f.line_start < 1) {
      return `findings[${i}].line_start must be a positive integer`;
    }
    if (!Number.isInteger(f.line_end) || f.line_end < 1) {
      return `findings[${i}].line_end must be a positive integer`;
    }
    if (typeof f.confidence !== "number" || f.confidence < 0 || f.confidence > 1) {
      return `findings[${i}].confidence must be a number in [0, 1]`;
    }
  }
  if (!Array.isArray(obj.next_steps)) return "next_steps is not an array";
  if (obj.next_steps.length > SCHEMA_MAX_ARRAY_LEN) {
    return `next_steps has ${obj.next_steps.length} entries (max ${SCHEMA_MAX_ARRAY_LEN})`;
  }
  for (let i = 0; i < obj.next_steps.length; i++) {
    const err = checkBoundedString(obj.next_steps[i], `next_steps[${i}]`);
    if (err) return err;
  }
  return null;
}

// Backward-compatible alias. The old name was "Shallow" but we now do a
// full strict pass; kept exporting under the old call site name so the
// rest of the file doesn't need rewriting.
const validateReviewSchemaShallow = validateReviewSchema;

async function cmdReview({ flags, positional }, { adversarial }) {
  if (!which("grok")) {
    console.error("Grok CLI not installed. Run `/grok:setup`.");
    process.exit(127);
  }
  const scope = flags.scope || "auto";
  const base = flags.base || null;
  const focus = positional.join(" ").trim();
  const jsonOutput = !!flags.json;
  const effort = validateEffort(flags.effort);
  const diffResult = captureDiff({ scope: scope === "branch" ? "branch" : scope, base });

  if (diffResult.kind === "no-repo") {
    console.log("Not inside a git repository - nothing to review.");
    process.exit(0);
  }
  if (diffResult.kind === "no-base") {
    console.error("Branch review needs a base ref. Pass --base <ref> (no origin/main, origin/master, main, or master found).");
    process.exit(2);
  }
  if (diffResult.kind === "bad-ref") {
    console.error(`Invalid git ref for --base: ${base}`);
    process.exit(2);
  }
  if (!diffResult.diff.trim()) {
    console.log(`Nothing to review (scope: ${diffResult.kind}${diffResult.base ? `, base: ${diffResult.base}` : ""}).`);
    process.exit(0);
  }

  const target = diffResult.kind + (diffResult.base ? ` (base: ${diffResult.base})` : "");

  // v0.8.2 (Grok aggregate-review round-2 LOW: audit ALL early-exit
  // paths after writePromptToTempFile). Order matters: every flag
  // validation that can call process.exit MUST run BEFORE the temp
  // file is created. resolveTimeoutMs exits on invalid --timeout;
  // grokBaseArgs throws on invalid policy flags. Validate both first,
  // then write the file once we know the call will proceed.
  let baseArgs;
  try {
    baseArgs = grokBaseArgs({
      readOnly: true,
      model: flags.model,
      jsonOutput: true,
      // v1.0.4 (Codex P0): route --effort through grokBaseArgs so the
      // v1.0.3 model-capability gate fires. Prior to this fix, cmdReview
      // called grokBaseArgs *without* `effort` and then `args.push`-ed
      // --effort below — bypassing the gate entirely and re-introducing
      // the 400 cascade on grok-build for /grok:review --effort high.
      effort,
      check: !!flags.check, // v0.8.0 cross-command consistency — review can self-verify too
      ...extractPolicyFlags(flags)
    });
  } catch (e) {
    console.error(String(e.message || e));
    process.exit(2);
  }
  const timeoutMs = resolveTimeoutMs(flags.timeout, DEFAULT_REVIEW_TIMEOUT_MS);

  const prompt = buildReviewPrompt({
    adversarial,
    focus,
    target,
    jsonOutput,
    diff: diffResult.diff
  });

  // Grok's headless mode does not consume stdin. The diff goes through
  // --prompt-file so we don't blow ARG_MAX with a multi-MB prompt.
  // SAFE TO ALLOCATE: every validation above has either exited cleanly
  // OR produced a usable value. runJob's cleanupPaths handles unlink
  // on close (success, error, timeout, or disk-overflow).
  const promptFile = writePromptToTempFile(prompt);

  const args = ["--prompt-file", promptFile, ...baseArgs];
  if (flags["max-turns"] == null) args.push("--max-turns", String(DEFAULT_REVIEW_MAX_TURNS));

  const meta = buildJobMeta({
    kind: adversarial ? "adversarial-review" : "review",
    args,
    task_text: `${target}${focus ? ` - focus: ${focus}` : ""}`,
    extra: {
      // v0.9.11: `envelope_json` and `json_output` were both removed.
      // runJob now derives the trust signal directly from the spawned
      // argv (looks for `--output-format json`), eliminating the
      // "command forgot to set envelope_json" footgun. Grok LOW round-11
      // also flagged that `json_output` was written but never read.
      model: flags.model || null,
      effort: effort || null
    }
  });

  let result;
  try {
    // Don't stream stdout to the user during review — wait for the full
    // JSON envelope, then render either the inner text or parsed JSON.
    result = await runJob({ args, meta, showStdout: false, timeoutMs, cleanupPaths: [promptFile] });
  } catch (err) {
    safeUnlink(promptFile);
    console.error(`Failed to spawn grok: ${err.message}`);
    process.exit(127);
  }

  if (result.timedOut) process.exit(EXIT_TIMEOUT);

  // Read the full on-disk stdout to get the full payload (outBuf is capped).
  let fullOut = result.outBuf;
  try {
    const stat = fs.statSync(meta.stdout_path);
    if (stat.size <= MAX_REVIEW_JSON_BYTES) {
      fullOut = fs.readFileSync(meta.stdout_path, "utf8");
    } else {
      process.stderr.write(
        `[grok-plugin] review: output is ${stat.size} bytes, > ${MAX_REVIEW_JSON_BYTES} cap. Will only render the truncated prefix; full output stays on disk at ${meta.stdout_path}.\n`
      );
    }
  } catch {}

  const parsed = parseGrokJson(fullOut);
  if (parsed.kind === "error") {
    process.stderr.write(`Grok error: ${parsed.message}\n`);
    const why = classifyAuthBlob(parsed.message);
    if (why) process.stderr.write(`[hint: ${why}. Run /grok:setup.]\n`);
    process.exit(1);
  }
  if (parsed.kind === "unknown") {
    // Fall back to whatever Grok printed.
    process.stdout.write(sanitizeForTerminal(fullOut));
    process.exit(result.code ?? 1);
  }

  // parsed.kind === "text"
  if (!jsonOutput) {
    process.stdout.write(parsed.text + "\n");
    process.exit(0);
  }

  // The user asked for JSON. The model was told to emit JSON matching our
  // review-output schema, but it may wrap it in ```json fences or extra prose.
  let inner = parsed.text.trim();
  const fenced = inner.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fenced) inner = fenced[1].trim();
  try {
    const innerParsed = JSON.parse(inner);
    const why = validateReviewSchemaShallow(innerParsed);
    if (why) {
      process.stderr.write(`[grok-plugin] review --json: schema mismatch (${why}). Returning unwrapped payload.\n`);
    }
    process.stdout.write(JSON.stringify(innerParsed, null, 2) + "\n");
  } catch {
    // Couldn't parse the inner text as JSON either; return the text as-is.
    process.stdout.write(parsed.text + "\n");
  }
  process.exit(0);
}

// ---------- subcommand: imagine / imagine-video ----------

// Default per-call deadlines for media generation. Image generation is fast
// (~5-30s); video generation routinely takes a minute or two. Override via
// --timeout; pass --timeout 0 to disable.
const DEFAULT_IMAGE_TIMEOUT_MS = 5 * 60 * 1000;    // 5 min
const DEFAULT_VIDEO_TIMEOUT_MS = 15 * 60 * 1000;   // 15 min

// Extract the saved image / video path from Grok's response text. Grok's
// /imagine and /imagine-video builtins respond with markdown of the shape
// `![alt](/absolute/path/to/file.ext)`. We pull out the URL portion so the
// user gets a direct path they can `open` (macOS), `xdg-open` (Linux), or
// drag into a chat. Falls back to the raw text if the markdown shape isn't
// matched — Grok occasionally returns extra prose for safety/refusal cases.
function extractMediaPath(text) {
  if (typeof text !== "string") return null;
  const m = text.match(/!\[[^\]]*\]\(([^)]+)\)/);
  if (m && m[1]) return m[1];
  return null;
}

// v1.0.2 (issue #5): copy the just-generated media from grok's internal
// session dir (`~/.grok/sessions/<URL-encoded-cwd>/<session-id>/{images,
// videos}/N.X`) to a user-specified path. The session copy is preserved
// for `grok -r <session-id>` resume / audit — caller doesn't need to know
// about it. Returns the absolute resolved destination on success.
//
// Trust model: `saveToRaw` is USER input to the plugin (typed into the
// slash command), not model output. We trust the user with their own
// filesystem but block control bytes (the one terminal-attack vector
// that survives `path.resolve` + the `open --` quoting).
//
// Directory semantics: if `saveToRaw` ends with `/` OR resolves to an
// existing directory, the basename of `mediaPath` is appended (matches
// the POSIX `cp source dir/` semantics most users expect).
function copyMediaToSaveTo(mediaPath, saveToRaw) {
  if (typeof saveToRaw !== "string" || !saveToRaw) {
    throw new Error("--save-to value is empty.");
  }
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(saveToRaw)) {
    throw new Error("--save-to value contains control bytes; refusing.");
  }
  // v1.0.4 (Codex P0): confine the SOURCE path to grok's session dir.
  // The source comes from grok's stdout (parsed markdown image link)
  // and a prompt-injected grok could return any local file path. The
  // chars-only isSafeMediaPath check at the call site passes /etc/passwd
  // fine — it's the prefix check that blocks the exfiltration vector.
  if (!isUnderGrokSessionsDir(mediaPath)) {
    throw new Error(
      `source media path '${mediaPath}' is outside ${grokHomeDir()}/sessions/ — ` +
      `refusing to copy. Grok may have returned an injected path; inspect the raw ` +
      `output (use --json to see it) before re-running.`
    );
  }
  let dest = path.resolve(process.cwd(), saveToRaw);
  // Directory semantics: trailing slash OR existing directory → treat
  // dest as a directory and append the basename of the source file.
  const endsWithSep = saveToRaw.endsWith(path.sep) || saveToRaw.endsWith("/");
  let isDir = false;
  try { isDir = fs.statSync(dest).isDirectory(); } catch {}
  if (endsWithSep || isDir) {
    dest = path.join(dest, path.basename(mediaPath));
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  // copyFileSync follows symlinks on the destination (writes through to
  // target) — that's correct for the user-provided destination. The
  // source is now both chars-validated (isSafeMediaPath at call site)
  // AND prefix-validated (isUnderGrokSessionsDir above).
  fs.copyFileSync(mediaPath, dest);
  return dest;
}

async function cmdImagine({ flags, positional }, { video }) {
  const description = positional.join(" ").trim();
  if (!description) {
    console.error(`Usage: ${video ? "imagine-video" : "imagine"} <description>`);
    process.exit(2);
  }

  // Reject obvious shell-injection patterns in the description BEFORE the
  // binary check. The control-byte refusal is a policy decision about the
  // input, not about whether Grok is reachable. If we deferred this until
  // after `which` succeeded, a CI runner without grok would mask the
  // refusal with a generic "not installed" error — confusing for the user
  // (which problem are they fixing?) and surprising for the test matrix
  // (test outcome depends on the host's installed CLIs).
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(description)) {
    console.error("Description contains control bytes; refusing to forward to Grok.");
    process.exit(2);
  }

  if (!which("grok")) {
    console.error("Grok CLI not installed. Run `/grok:setup`.");
    process.exit(127);
  }

  const slashCommand = video ? "/imagine-video" : "/imagine";
  const defaultMs = video ? DEFAULT_VIDEO_TIMEOUT_MS : DEFAULT_IMAGE_TIMEOUT_MS;
  const timeoutMs = resolveTimeoutMs(flags.timeout, defaultMs);
  const effort = validateEffort(flags.effort);

  // We do NOT use grokBaseArgs here. /imagine is a builtin "shell"
  // command, not an agentic task — it doesn't run tools, so the
  // --permission-mode plan + --disallowed-tools layer is unnecessary, and
  // forcing JSON output is what gives us a parseable response.
  const prompt = `${slashCommand} ${description}`;
  const args = [
    "-p", prompt,
    "--output-format", "json",
    "-m", effectiveModel(flags.model),
    "--max-turns", "10"
  ];
  // v1.0.4 (Codex P0): route --effort through the shared
  // effortFlagForModel helper from lib/grok.mjs. Because cmdImagine
  // doesn't use grokBaseArgs, v1.0.3's model-capability gate was
  // bypassed here — /grok:imagine --effort high still triggered the
  // 4× 400 cascade on grok-build. The helper centralizes the gate so
  // every effort emission goes through one place.
  {
    const gated = effortFlagForModel({ effort, model: flags.model, kind: "effort" });
    if (gated) args.push("--effort", gated);
  }

  const spawnOpts = { encoding: "utf8", env: cleanGrokEnv() };
  if (timeoutMs > 0) spawnOpts.timeout = Math.min(timeoutMs, MAX_SETTIMEOUT_MS);

  const r = spawnSync("grok", args, spawnOpts);
  if (r.error && r.error.code === "ETIMEDOUT") {
    if (r.stdout) process.stdout.write(sanitizeForTerminal(r.stdout));
    if (r.stderr) process.stderr.write(sanitizeForTerminal(r.stderr));
    process.stderr.write(`\n[grok-plugin] ${video ? "imagine-video" : "imagine"} timed out after ${timeoutMs}ms. Re-run with --timeout 0 to disable, or pick a longer duration.\n`);
    process.exit(EXIT_TIMEOUT);
  }

  const parsed = parseGrokJson(r.stdout || "");
  if (parsed.kind === "error") {
    const why = classifyAuthBlob(parsed.message);
    process.stderr.write(`Grok error: ${parsed.message}\n`);
    if (why) process.stderr.write(`[hint: ${why}. Run /grok:setup.]\n`);
    process.exit(1);
  }
  if (parsed.kind !== "text") {
    if (r.stdout) process.stdout.write(sanitizeForTerminal(r.stdout));
    if (r.stderr) process.stderr.write(sanitizeForTerminal(r.stderr));
    // v1.0.1 (issue #2): empty stdout + empty stderr is anomalous — the
    // broken-binary auto-update case from issue #1 hits exactly here. Print
    // the argv + recovery hints so the user has something actionable.
    // v1.0.5 (issue #9): tighten to whitespace-only check (a 1-byte
    // newline was missed; observed on upstream silent-empty for some
    // synthesis-style large prompts).
    if (isWhitespaceOnly(r.stdout) && isWhitespaceOnly(r.stderr)) {
      diagnoseEmptySpawnFailure({ args, status: r.status, label: video ? "imagine-video" : "imagine" });
    }
    process.exit(r.status ?? 1);
  }

  const mediaPath = extractMediaPath(parsed.text);

  // v1.0.2 (issue #5): when --save-to is supplied AND we got a safe media
  // path back, copy the file to the user's destination before printing.
  // The display path then reflects where the file ACTUALLY is, not the
  // internal grok session-dir path. Failures (permission denied, disk
  // full, source missing) surface as `saveError` instead of crashing
  // the command — the file still exists at the internal session path,
  // so the user can recover.
  let savedTo = null;
  let saveError = null;
  if (mediaPath && isSafeMediaPath(mediaPath) && flags["save-to"]) {
    try {
      savedTo = copyMediaToSaveTo(mediaPath, flags["save-to"]);
    } catch (e) {
      saveError = e && e.message ? e.message : String(e);
    }
  }
  // The path we expose to the user: the saved-to copy if successful,
  // otherwise the internal session path. Both `--json` consumers and
  // human-readable output use this single resolution.
  const displayPath = savedTo || mediaPath;

  if (flags.json) {
    process.stdout.write(JSON.stringify({
      kind: video ? "video" : "image",
      description,
      // `path` is where the file IS NOW — preserves backward compat
      // (old callers read .path and get the file location) while making
      // --save-to invisible to them.
      path: displayPath,
      // `sessionPath` is always the internal grok session-dir path so
      // callers that want to inspect the on-disk session can do so.
      sessionPath: mediaPath,
      // `savedTo` is non-null only if --save-to was supplied AND succeeded.
      savedTo,
      // `saveError` is non-null only if --save-to was supplied AND failed.
      saveError,
      sessionId: parsed.sessionId || null,
      raw: parsed.text
    }, null, 2) + "\n");
    process.exit(0);
  }

  if (mediaPath) {
    const noun = video ? "Video" : "Image";
    // VALIDATE BEFORE PRINTING. Codex round-5 caught that the previous
    // version printed `${noun}: ${mediaPath}\n` BEFORE the safety check,
    // so a path containing newlines, ANSI escapes, or other terminal
    // control sequences could leak straight to the user's terminal —
    // potentially clearing the screen, moving the cursor, or hiding
    // text. The safety check now gates BOTH the path display and the
    // open hint. Unsafe paths get a JSON-escaped representation so the
    // user can still see what was returned without the terminal being
    // attacked.
    if (isSafeMediaPath(mediaPath)) {
      // displayPath = savedTo if --save-to succeeded, else internal session path.
      // savedTo paths come from path.resolve(user-input) and may include chars
      // outside SAFE_MEDIA_PATH_PATTERN (spaces, tildes), so we cannot reuse
      // isSafeMediaPath on them — the control-byte refusal inside
      // copyMediaToSaveTo is sufficient, and the `open --` quoting handles
      // shell metacharacters defensively.
      process.stdout.write(`${noun}: ${displayPath}\n`);
      // `open --` uses the POSIX end-of-options marker so even a path
      // that somehow slipped a leading hyphen past the regex (future
      // refactor regression) cannot be reinterpreted by macOS `open` as
      // a `-aTerminal` flag. Belt-and-suspenders alongside the regex.
      process.stdout.write(`\nOpen with:\n  open -- "${displayPath}"\n`);
    } else {
      // JSON.stringify escapes control characters, quotes, and backslashes,
      // so even a path full of ANSI/newline payloads renders as inert text.
      const safeDisplay = JSON.stringify(mediaPath);
      process.stdout.write(`${noun} (UNSAFE PATH): ${safeDisplay}\n`);
      process.stdout.write(`\n[grok-plugin] WARNING: returned media path contains unsafe characters; not generating an open command.\n`);
    }
    // v1.0.2 (issue #5): if --save-to was supplied but failed, surface
    // the reason so the user knows why their requested path is empty.
    // The internal session copy still exists; they can copy it manually.
    if (saveError) {
      process.stderr.write(`\n[grok-plugin] --save-to failed: ${saveError}\n`);
      process.stderr.write(`[grok-plugin] The file is still available at the session path printed above.\n`);
    }
    if (parsed.sessionId) {
      // v0.9.6: use --session-id= form (matches formatSessionHint's
      // logic for create-or-resume semantics).
      process.stdout.write(`\nSession: ${parsed.sessionId}  (resume: /grok:rescue --session-id=${parsed.sessionId}  or  grok -s ${parsed.sessionId})\n`);
    }
  } else {
    // No markdown link in the response — surface the raw text so the user
    // can see the model's refusal or content-policy explanation.
    process.stdout.write(parsed.text + "\n");
  }
  process.exit(0);
}

// ---------- subcommand: task ----------

async function cmdTask({ flags, positional }) {
  const taskText = positional.join(" ").trim();
  if (!taskText) {
    console.error("Usage: task <description of what to do>");
    process.exit(2);
  }

  // Write-mode gate runs BEFORE the binary check so a "refused for safety"
  // error is never masked by "Grok not installed".
  const isWrite = !!flags.write && !flags["read-only"];
  if (isWrite && process.env.GROK_PLUGIN_ALLOW_WRITE !== "1") {
    console.error("--write refused: GROK_PLUGIN_ALLOW_WRITE is not set to 1.");
    console.error("");
    console.error("--write puts Grok in --yolo mode, which lets it modify files in this");
    console.error("workspace without per-action confirmation. Only enable in a workspace");
    console.error("where you already trust running an unattended agent.");
    console.error("");
    console.error("To enable for this session:    export GROK_PLUGIN_ALLOW_WRITE=1");
    console.error("To enable persistently:        add it to ~/.claude/settings.json env.");
    process.exit(2);
  }

  const timeoutMs = resolveTimeoutMs(flags.timeout, DEFAULT_TASK_TIMEOUT_MS);
  const effort = validateEffort(flags.effort);

  if (!which("grok")) {
    console.error("Grok CLI not installed. Run `/grok:setup`.");
    process.exit(127);
  }

  if (isWrite) {
    process.stderr.write("[grok-plugin] WRITE MODE ACTIVE - Grok may modify files in this workspace.\n");
  }

  // Plain output during a task: the user is interactively watching Grok
  // think. JSON detection still applies via the on-close handler.
  // v0.8.1 (Grok aggregate-review round-2 MED #2): /grok:task now also
  // accepts --allow / --deny / --rules / --max-turns / --tools / etc.,
  // matching /grok:ask, /grok:review, /grok:research, /grok:best-of.
  let policyArgs;
  try {
    // v0.8.2 (Grok aggregate-review round-2 MED): spread extractPolicyFlags
    // FIRST so the explicit `effort` (already normalized by validateEffort
    // above) wins if extractPolicyFlags ever grows an effort key. Today
    // it doesn't, but the spread-order defense is free.
    policyArgs = grokBaseArgs({
      readOnly: !isWrite,
      model: flags.model,
      jsonOutput: false,
      ...extractPolicyFlags(flags),
      effort
    });
  } catch (e) {
    console.error(String(e.message || e));
    process.exit(2);
  }
  const args = ["-p", taskText, ...policyArgs];
  // If user supplied --max-turns it's already in policyArgs; we don't
  // override it here. The grok CLI default applies when neither side
  // sets it (cmdTask historically never set a default — keep it that
  // way for long-running rescues).

  // Optional session-id continuation: -s creates a new session if not found,
  // -r requires it exists. We surface both via --session-id and --resume on
  // the slash-command surface; here, just thread it through.
  if (flags["session-id"]) args.push("-s", String(flags["session-id"]));

  // v0.9.5 (Grok HIGH #2 round-5): also record --resume and --continue
  // provenance so /grok:status, /grok:result, and the in-flight footer
  // can surface the resume hint even when the session was started via
  // those flags rather than --session-id.
  const meta = buildJobMeta({
    kind: "task",
    args,
    task_text: taskText,
    extra: {
      write: isWrite,
      model: flags.model || null,
      effort: effort || null,
      requested_session_id: flags["session-id"] || null,
      requested_resume: flags.resume != null ? flags.resume : null,
      requested_continue: !!flags.continue
    }
  });

  let result;
  try {
    result = await runJob({ args, meta, showStdout: true, timeoutMs });
  } catch (err) {
    console.error(`Failed to spawn grok: ${err.message}`);
    process.exit(127);
  }

  process.stdout.write(`\n\n[grok-plugin] Job ${meta.id} ${meta.status} (exit ${result.code}).\n`);
  // v0.9.7 (Grok LOW #2 round-7): the old v0.9.5 comment described a
  // limitation that no longer applies (formatSessionHint now surfaces
  // ALL requested_* entry points, plus getSessionProvenance gates
  // the legacy session_id branch behind meta.kind !== "task" so plain-
  // output model hallucinations don't bleed through).
  //
  // v0.9.6 (3/3 round-6 + round-5 follow-up): formatSessionHint
  // consolidates the priority chain so cmdTask footer, cmdResult, and
  // renderJobDetails all render the same hint shape from the same
  // job-meta shape. Earlier the priority lived in cmdTask only and the
  // other two paths missed every entry point except meta.session_id.
  const hint = formatSessionHint(meta);
  if (hint) process.stdout.write(`[grok-plugin] ${hint}\n`);
  process.stdout.write(`[grok-plugin] /grok:result ${meta.id}\n`);
  if (result.timedOut) process.exit(EXIT_TIMEOUT);
  if (meta.status === "failed") process.exit(1);
  process.exit(result.code ?? 0);
}

// ---------- subcommand: status ----------

function refreshStatus(meta) {
  if (meta.status === "running" && !isAlive(meta.pid)) {
    meta.status = "ended";
    meta.ended_at = meta.ended_at || new Date().toISOString();
    writeJobMeta(meta.id, meta);
  }
}

function cmdStatus({ flags, positional }) {
  const target = positional[0];
  if (target) {
    const meta = readJobMeta(target);
    if (!meta) { console.log(`No job ${target}.`); process.exit(1); }
    refreshStatus(meta);
    console.log(renderJobDetails(meta));
    process.exit(0);
  }
  const limit = flags.all ? 50 : 10;
  const all = listJobs().slice(0, limit);
  for (const j of all) refreshStatus(j);
  console.log(renderJobTable(all));
  process.exit(0);
}

// ---------- subcommand: result ----------

function cmdResult({ positional }) {
  const target = positional[0];
  let meta;
  if (target) {
    meta = readJobMeta(target);
    if (!meta) { console.log(`No job ${target}.`); process.exit(1); }
    refreshStatus(meta);
  } else {
    const all = listJobs();
    for (const j of all) refreshStatus(j);
    const completed = all.filter(j => j.status !== "running");
    if (completed.length === 0) {
      console.log("No completed Grok jobs in this workspace.");
      process.exit(0);
    }
    meta = completed[0];
  }
  console.log(`# Job ${meta.id}`);
  console.log(`Kind: ${meta.kind}${meta.write ? " (write)" : ""}`);
  console.log(`Status: ${meta.status}`);
  console.log(`Task: ${meta.task_text || "-"}`);
  console.log(`Started: ${fmtTime(meta.started_at)}${meta.ended_at ? `   Ended: ${fmtTime(meta.ended_at)}` : ""}`);
  if (meta.exit_code !== undefined) console.log(`Exit: ${meta.exit_code}`);
  // v0.9.6 (3/3 round-6): use the shared formatSessionHint so /grok:result
  // surfaces the SAME hint shape as the in-flight cmdTask footer + as
  // renderJobDetails. Previously this only rendered when meta.session_id
  // was populated (rare for rescue jobs, which use plain output).
  const sessionHint = formatSessionHint(meta);
  if (sessionHint) console.log(sessionHint);
  console.log("\n## Output\n");
  // v0.5.0: switched from `safeJobLogPath` + `readBoundedFile` to
  // `readBoundedJobLog` which atomically validates + opens + reads
  // through a single fd with O_NOFOLLOW. Closes the TOCTOU race window
  // where an attacker could swap a job log for a symlink between the
  // path validation and the open.
  const raw = readBoundedJobLog(meta.stdout_path, undefined, MAX_REVIEW_JSON_BYTES);
  if (raw === null) {
    console.log("(stdout path is outside the jobs directory or could not be safely read)");
  } else {
    const parsed = parseGrokJson(raw);
    if (parsed.kind === "text") {
      process.stdout.write(sanitizeForTerminal(parsed.text + "\n"));
    } else if (parsed.kind === "error") {
      process.stdout.write(sanitizeForTerminal(`(grok internal error) ${parsed.message}\n`));
    } else {
      process.stdout.write(sanitizeForTerminal(raw || "(no output)\n"));
    }
  }
  // v1.0.6 (issue #10): surface the empty-output anomaly here too. The
  // runJob-close diagnostic only fires once at task time; if the user
  // discovers the empty output later via /grok:result, the cause/recovery
  // hints aren't available unless we replay them. Gate on meta.no_output
  // (set by runJob when both buffers are whitespace-only on exit 0).
  if (meta.no_output) {
    process.stderr.write(
      `\n[grok-plugin] WARNING: this job produced NO output (stdout + stderr both empty) ` +
      `even though it exited ${meta.exit_code ?? "0"}. Possible causes:\n` +
      `[grok-plugin]   - The prompt hit an upstream silent-abort path (see issues #9/#10)\n` +
      `[grok-plugin]   - --permission-mode plan + headless -p may suppress output when the task\n` +
      `[grok-plugin]     requires tool execution (web_search, file ops). /grok:task uses plan mode\n` +
      `[grok-plugin]     in read-only by default; try /grok:rescue --write for tool-using tasks.\n` +
      `[grok-plugin]   - The grok binary may be broken (see /grok:setup).\n`
    );
  }
  if (meta.exit_code && meta.exit_code !== 0) {
    console.log("\n## Errors\n");
    const errRaw = readBoundedJobLog(meta.stderr_path, undefined, MAX_REVIEW_JSON_BYTES);
    if (errRaw !== null) {
      process.stdout.write(sanitizeForTerminal(errRaw));
    }
  }
  console.log(`\n---\nFollow-up: /grok:status ${meta.id}`);
  process.exit(0);
}

// ---------- subcommand: cancel ----------

async function killJob(meta) {
  meta.status = "cancelled";
  meta.ended_at = new Date().toISOString();
  writeJobMeta(meta.id, meta);
  await terminateProcessTree(meta.pid);
}

async function cmdCancel({ positional }) {
  const target = positional[0];
  if (!target) {
    const running = listJobs().filter(j => j.status === "running" && isAlive(j.pid));
    if (running.length === 0) {
      console.log("No running Grok jobs to cancel.");
      process.exit(0);
    }
    await Promise.all(running.map(j => killJob(j)));
    console.log(`Cancelled ${running.length} job(s).`);
    process.exit(0);
  }
  const meta = readJobMeta(target);
  if (!meta) { console.log(`No job ${target}.`); process.exit(1); }
  if (meta.status !== "running" || !isAlive(meta.pid)) {
    console.log(`Job ${meta.id} is not running (status: ${meta.status}). Nothing to cancel.`);
    process.exit(0);
  }
  await killJob(meta);
  console.log(`Cancelled ${meta.id}.`);
  process.exit(0);
}

// ---------- subcommand: purge ----------

function cmdPurge({ flags }) {
  const ageRaw = flags["older-than"] || null;
  const maxAgeMs = ageRaw ? parseDuration(ageRaw) : null;
  if (ageRaw && !maxAgeMs) {
    console.error(`Invalid --older-than value: ${ageRaw}. Use forms like 30d, 12h, 45m, 60s.`);
    process.exit(2);
  }
  const purged = purgeJobs({ maxAgeMs });
  if (maxAgeMs) {
    console.log(`Purged ${purged} job(s) older than ${ageRaw}.`);
  } else {
    console.log(`Purged ${purged} job(s).`);
  }
  process.exit(0);
}

// ---------- main ----------

// ---------- v0.6.0: /grok:research ----------
//
// Deep research / long-form question mode. Uses --effort max + --check by
// default (self-verification loop). Web search stays ON — that's the whole
// point of /grok:research, otherwise it would just be /grok:ask with a
// bigger timeout.
//
// Default timeout 30 min (research streams can run multi-minute) but the
// user can override with --timeout.
const DEFAULT_RESEARCH_TIMEOUT_MS = 30 * 60 * 1000;
// v0.7.3: bumped from 60 → 200. The grok CLI counts every internal
// reasoning + tool-call as a turn. Deep research that legitimately
// needs to read 10-20 files burns 80+ turns just on file reads before
// composing the answer. 60 was tripping users with "Internal error:
// max_turns exceeded" on real research prompts. 200 leaves comfortable
// headroom while still acting as a runaway bound (the --timeout layer
// is the real DoS guard).
const DEFAULT_RESEARCH_MAX_TURNS = 200;

function cmdResearch({ flags, positional }) {
  const prompt = positional.join(" ").trim();
  if (!prompt) {
    console.error("Usage: research <question>");
    process.exit(2);
  }
  const timeoutMs = resolveTimeoutMs(flags.timeout, DEFAULT_RESEARCH_TIMEOUT_MS);
  if (!which("grok")) {
    console.error("Grok CLI not installed. Run `/grok:setup`.");
    process.exit(127);
  }
  // Research-mode defaults: effort=max, check=true, web-search ON.
  // Override hooks:
  //   --effort <level>     overrides effort (validated by validateEffort,
  //                        case-insensitive — Gemini v0.6.0 round-2 G2)
  //   --no-check           explicit opt-out of self-verification loop
  //   --no-web-search      turn off Grok's built-in live search
  const effort = validateEffort(flags.effort) || "max";
  const checkFlag = flags["no-check"] ? false
                 : flags.check === false ? false
                 : true;
  const disableWebSearch = !!flags["no-web-search"];
  // v1.2.0: research defaults to the `segments` compaction mode — it persists
  // per-segment markdown so a long, multi-turn research run keeps more of its
  // own context grep-able instead of collapsing to a lossy summary. Override
  // with --compaction-mode / --compaction-detail.
  const compactionMode = flags["compaction-mode"] || "segments";
  const compactionDetail = flags["compaction-detail"];
  let baseArgs;
  try {
    baseArgs = grokBaseArgs({
      readOnly: true,
      model: flags.model,
      jsonOutput: true,
      effort,
      check: checkFlag,
      disableWebSearch,
      compactionMode,
      compactionDetail,
      ...extractPolicyFlags(flags)
    });
  } catch (e) {
    console.error(String(e.message || e));
    process.exit(2);
  }
  const args = ["-p", prompt, ...baseArgs];
  if (flags["max-turns"] == null) args.push("--max-turns", String(DEFAULT_RESEARCH_MAX_TURNS));
  // v1.2.0: web_fetch grounding ON by default (suppressed by --no-web-fetch,
  // --no-web-search, or a user-set GROK_WEB_FETCH).
  const extraEnv = webFetchEnvOverride({ noWebFetch: !!flags["no-web-fetch"] || disableWebSearch });
  runHeadlessGrok({
    args, timeoutMs, label: "research", extraEnv,
    timeoutHint: "Re-run with --timeout 0 to disable, or pick a longer duration like --timeout 1h."
  });
}

// ---------- v1.2.0: /grok:fan-out ----------
//
// One Grok call that dispatches several subagents in parallel, each analyzing
// the task from a different angle, then synthesizes a single consolidated
// answer. This is the "use Grok in many directions in one shot" primitive.
//
// Two modes:
//   default        — built-in personas (researcher / reviewer / security-
//                    auditor / test-writer) applied via Grok's `task` tool.
//   --agents-json  — custom inline subagent definitions (validated, passed
//                    through to `grok --agents`).
//
// Read-only by default (plan mode + write/shell tool denylist) so the subagents
// analyze rather than edit; subagent spawning itself stays enabled. --write
// (gated by GROK_PLUGIN_ALLOW_WRITE=1) opens it up for change-making fan-outs.
const DEFAULT_FANOUT_TIMEOUT_MS = 30 * 60 * 1000; // 30 min — several child sessions
const DEFAULT_FANOUT_MAX_TURNS = 200;
function cmdFanOut({ flags, positional }) {
  const task = positional.join(" ").trim();
  if (!task) {
    console.error("Usage: fan-out <task>   [--personas a,b,c | --agents-json '<json>'] [--write] [--no-web-fetch]");
    process.exit(2);
  }
  if (!which("grok")) {
    console.error("Grok CLI not installed. Run `/grok:setup`.");
    process.exit(127);
  }
  if (flags["no-subagents"]) {
    console.error("fan-out needs subagents — drop --no-subagents (a fan-out with no subagents is just a plain ask).");
    process.exit(2);
  }
  const timeoutMs = resolveTimeoutMs(flags.timeout, DEFAULT_FANOUT_TIMEOUT_MS);

  const writeMode = !!flags.write;
  if (writeMode && process.env.GROK_PLUGIN_ALLOW_WRITE !== "1") {
    console.error("[grok-plugin] fan-out --write requires GROK_PLUGIN_ALLOW_WRITE=1 in the environment (safety gate). Refusing.");
    process.exit(2);
  }

  // Decide the subagents: explicit custom --agents-json, else built-in personas.
  let agents = null;       // canonical json string for --agents (custom mode)
  let agentNames = null;   // names for the orchestration prompt (custom mode)
  let personas = null;     // persona names (default mode)
  try {
    if (flags["agents-json"] != null && flags["agents-json"] !== "") {
      const v = validateAgentsJson(flags["agents-json"]);
      agents = v.json;
      agentNames = v.names;
    } else {
      personas = validatePersonas(flags.personas);
    }
  } catch (e) {
    console.error(String(e.message || e));
    process.exit(2);
  }

  const fanPrompt = buildFanOutPrompt(task, agentNames ? { agentNames } : { personas });
  const effort = validateEffort(flags.effort);
  const checkFlag = !!flags.check;
  let baseArgs;
  try {
    baseArgs = grokBaseArgs({
      readOnly: !writeMode,   // read-only analysis by default; Agent/task tool stays enabled
      model: flags.model,
      jsonOutput: true,
      effort,
      check: checkFlag,
      agents,                 // null in persona mode; canonical json in custom mode
      ...extractPolicyFlags(flags)
    });
  } catch (e) {
    console.error(String(e.message || e));
    process.exit(2);
  }
  const args = ["-p", fanPrompt, ...baseArgs];
  if (flags["max-turns"] == null) args.push("--max-turns", String(DEFAULT_FANOUT_MAX_TURNS));
  const extraEnv = webFetchEnvOverride({ noWebFetch: !!flags["no-web-fetch"] });
  runHeadlessGrok({
    args, timeoutMs, label: "fan-out", extraEnv,
    timeoutHint: "Fan-out runs several subagents; re-run with --timeout 0 to disable or a longer --timeout like 1h."
  });
}

// ---------- v0.6.0: /grok:models ----------
//
// Wraps `grok models`. Optional --set-default <id> persists the model into
// the per-workspace activeModel config. Optional --json emits the workspace
// config + parsed model list as JSON.
//
// Codex + Gemini v0.6.0 round-2 BLOCKING (C, also Gemini G1):
//   The footer used to print `effectiveModel()`, `cfg.activeModel`, and
//   `GROK_PLUGIN_MODEL` raw. Any of those can carry ANSI/OSC/newline
//   payloads (env-controlled or LLM-controlled via prompt-injection on
//   --set-default). Every echoed value now passes through
//   sanitizeForTerminal(). The --set-default positional is also length-
//   capped to defuse pathological inputs.
//
// Codex v0.6.0 round-2 BLOCKING (third bullet on `/grok:models`):
//   `grok models` used to run without a timeout — an auth/network hang
//   could block /grok:models indefinitely. Now bounded by --timeout,
//   default 30s. Auth failures route through classifyAuthBlob the same
//   way /grok:ask does.
const DEFAULT_MODELS_TIMEOUT_MS = 30 * 1000;
const MAX_MODEL_ID_LEN = 128;
function cmdModels({ flags, positional }) {
  if (!which("grok")) {
    console.error("Grok CLI not installed. Run `/grok:setup`.");
    process.exit(127);
  }
  if (flags["set-default"]) {
    const target = positional[0] || flags.model;
    if (!target) {
      console.error("Usage: models --set-default <model-id>");
      process.exit(2);
    }
    const targetStr = String(target);
    if (targetStr.length > MAX_MODEL_ID_LEN) {
      console.error(`--set-default value exceeds ${MAX_MODEL_ID_LEN} chars; refusing.`);
      process.exit(2);
    }
    setActiveModel(process.cwd(), targetStr);
    const safeTarget = sanitizeForTerminal(targetStr);
    if (flags.json) {
      console.log(JSON.stringify({ ok: true, activeModel: targetStr }));
    } else {
      console.log(`Active model for this workspace set to: ${safeTarget}`);
      console.log("(Per-call --model still overrides; GROK_PLUGIN_MODEL env still overrides per-call.)");
    }
    process.exit(0);
  }
  const timeoutMs = resolveTimeoutMs(flags.timeout, DEFAULT_MODELS_TIMEOUT_MS);
  const spawnOpts = { encoding: "utf8", env: cleanGrokEnv() };
  if (timeoutMs > 0) spawnOpts.timeout = Math.min(timeoutMs, MAX_SETTIMEOUT_MS);
  const r = spawnSync("grok", ["models"], spawnOpts);
  if (r.error && r.error.code === "ETIMEDOUT") {
    process.stderr.write(`\n[grok-plugin] models timed out after ${timeoutMs}ms.\n`);
    process.exit(EXIT_TIMEOUT);
  }
  const out = sanitizeForTerminal(r.stdout || "");
  const err = sanitizeForTerminal(r.stderr || "");
  const cfg = (() => { try { return readConfig(process.cwd()); } catch { return {}; } })();
  if (flags.json) {
    console.log(JSON.stringify({
      raw: out,
      activeModel: cfg.activeModel || null,
      pluginDefault: DEFAULT_MODEL,
      effective: effectiveModel(null, process.cwd())
    }));
    process.exit(r.status ?? 0);
  }
  if (out) process.stdout.write(out);
  if (err) process.stderr.write(err);
  // Codex v0.6.0 round-2 — if grok models failed, surface auth hint the
  // same way /grok:ask does.
  if (r.status !== 0) {
    const why = classifyAuthBlob((r.stdout || "") + "\n" + (r.stderr || ""));
    if (why) process.stderr.write(`\n[hint: ${why}. Run /grok:setup.]\n`);
    process.exit(r.status ?? 1);
  }
  // Sanitize every footer value — cfg.activeModel from disk, env, and
  // effectiveModel() (which can return either). Defense against ANSI/OSC/
  // newline payloads in any of those sources.
  const safeEffective = sanitizeForTerminal(effectiveModel(null, process.cwd()));
  process.stdout.write(`\n[grok-plugin] effective model for this workspace: ${safeEffective}\n`);
  if (cfg.activeModel) {
    process.stdout.write(`[grok-plugin] workspace pinned: ${sanitizeForTerminal(String(cfg.activeModel))}\n`);
  }
  process.stdout.write(`[grok-plugin] plugin default: ${sanitizeForTerminal(DEFAULT_MODEL)}\n`);
  if (process.env.GROK_PLUGIN_MODEL) {
    process.stdout.write(`[grok-plugin] env override (GROK_PLUGIN_MODEL): ${sanitizeForTerminal(process.env.GROK_PLUGIN_MODEL)}\n`);
  }
  process.exit(r.status ?? 0);
}

// ---------- v0.6.0: /grok:bestof ----------
//
// Parallel-branch wrapper. Calls Grok with `--best-of-n N` so the model
// runs the prompt N ways internally and returns its best answer. The
// number of branches is capped by BEST_OF_N_MAX in lib/grok.mjs.
//
// Cost note: each branch is a full token-spend; --best-of-n 5 costs ~5×
// a regular /grok:ask. The plugin caps at BEST_OF_N_MAX (default 8).
const DEFAULT_BESTOF_TIMEOUT_MS = 20 * 60 * 1000;
const DEFAULT_BESTOF_MAX_TURNS = 30;
function cmdBestOf({ flags, positional }) {
  // First positional is N, rest is the prompt. Also accept --best-of-n N.
  let n = flags["best-of-n"];
  let prompt;
  if (n != null) {
    prompt = positional.join(" ").trim();
  } else if (positional.length >= 2 && /^\d+$/.test(positional[0])) {
    n = positional[0];
    prompt = positional.slice(1).join(" ").trim();
  } else {
    console.error("Usage: best-of <N> <prompt>  (or: best-of --best-of-n <N> <prompt>)");
    process.exit(2);
  }
  if (!prompt) {
    console.error("Usage: best-of <N> <prompt>");
    process.exit(2);
  }
  // v1.0.3 (issue #8): one-line stderr reminder that --best-of-n is
  // code-task-only. grok's underlying /best-of-n skill spawns N parallel
  // subagents in isolated git worktrees and evaluates them on Correctness
  // / Code Quality / Safety — for text or research prompts the diff
  // evaluator has nothing to score and you get an evaluation table over
  // empty diffs (issue #8 reporter lost ~5x token spend before realizing).
  // Suppressed when --json (parseable pipelines) or when the user has
  // set GROK_PLUGIN_QUIET_BANNERS=1 (power-user opt-out, matches the
  // grok-CLI-style GROK_* env-var convention).
  if (!flags.json && process.env.GROK_PLUGIN_QUIET_BANNERS !== "1") {
    process.stderr.write(
      `[grok-plugin] /grok:best-of wraps grok --best-of-n (CODE / FILE-CHANGE tasks only — ` +
      `scores worktree diffs). For research/summarization/text, use /grok:research or /grok:ask. ` +
      `Suppress this banner with GROK_PLUGIN_QUIET_BANNERS=1.\n`
    );
  }
  const timeoutMs = resolveTimeoutMs(flags.timeout, DEFAULT_BESTOF_TIMEOUT_MS);
  // Gemini v0.6.0 round-2 G2: same case-insensitive normalization as cmdAsk.
  const effort = validateEffort(flags.effort);
  const checkFlag = !!flags.check;
  const disableWebSearch = !!flags["no-web-search"];
  if (!which("grok")) {
    console.error("Grok CLI not installed. Run `/grok:setup`.");
    process.exit(127);
  }
  let baseArgs;
  try {
    baseArgs = grokBaseArgs({
      readOnly: true,
      model: flags.model,
      jsonOutput: true,
      effort,
      check: checkFlag,
      bestOfN: n,
      disableWebSearch,
      ...extractPolicyFlags(flags)
    });
  } catch (e) {
    console.error(String(e.message || e));
    process.exit(2);
  }
  const args = ["-p", prompt, ...baseArgs];
  if (flags["max-turns"] == null) args.push("--max-turns", String(DEFAULT_BESTOF_MAX_TURNS));
  runHeadlessGrok({ args, timeoutMs, label: "best-of", timeoutHint: "" });
}

// ============================================================================
// v0.7.1: peer-plugin discovery for /grok:aggregate-review
// ============================================================================
//
// The user flagged a real architectural concern in v0.7.0: spawning raw
// codex/gemini binaries from inside our Node code bypasses each peer
// plugin's safety layer (env scrubbing, prompt-file handling, capability
// probes, fallback model chains, auth handling). The "proper" interface
// (the rescue subagent system) is blocked upstream by the stub bugs we
// filed (codex-plugin-cc#324, gemini-plugin-cc#3).
//
// v0.7.1 routes through each peer plugin's `companion.mjs review --wait`
// where available. That preserves uniform prompt control + uniform output
// shape (each plugin already wraps its CLI with the same defenses we'd
// otherwise re-implement) and is sync-by-design (`--wait` blocks until
// the job completes). Raw-CLI spawn stays as a fallback when a peer
// plugin isn't installed.

// Cache root for installed Claude Code plugins.
const CC_PLUGIN_CACHE = path.join(os.homedir(), ".claude/plugins/cache");

// Map of reviewer-name → peer-plugin lookup data. cacheName is the
// directory under ~/.claude/plugins/cache/. The scriptName is the
// companion.mjs file inside the plugin's scripts/ dir. We pick the
// highest-version directory available (peer plugins use semver-named
// version subdirs).
const PEER_PLUGIN_LOOKUP = {
  codex:  { cacheName: "openai-codex",     scriptName: "codex-companion.mjs" },
  gemini: { cacheName: "gemini-plugin-cc", scriptName: "companion.mjs" },
  grok:   { cacheName: "grok-plugin-cc",   scriptName: "companion.mjs" }
};

// Find a peer plugin's companion.mjs by walking the well-known cache
// layout: `~/.claude/plugins/cache/<cacheName>/<plugin>/<version>/scripts/<scriptName>`.
// Returns the highest-semver version's absolute path, or null.
function findPeerCompanion(reviewerName) {
  const spec = PEER_PLUGIN_LOOKUP[reviewerName];
  if (!spec) return null;
  const cacheRoot = path.join(CC_PLUGIN_CACHE, spec.cacheName);
  let pluginsLevel;
  try { pluginsLevel = fs.readdirSync(cacheRoot, { withFileTypes: true }); }
  catch { return null; }
  for (const plugDir of pluginsLevel) {
    if (!plugDir.isDirectory()) continue;
    const plugRoot = path.join(cacheRoot, plugDir.name);
    let versions;
    try { versions = fs.readdirSync(plugRoot); }
    catch { continue; }
    // Highest semver first — same compareVersions used by /grok:setup.
    versions.sort((a, b) => compareVersions(b, a));
    for (const ver of versions) {
      const candidate = path.join(plugRoot, ver, "scripts", spec.scriptName);
      try {
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch { /* keep looking */ }
    }
  }
  return null;
}

// ============================================================================
// v0.7.0: /grok:aggregate-review — multi-LLM consensus review
// ============================================================================
//
// Runs the same diff-review prompt against every installed peer CLI
// (codex, gemini, grok) in parallel, captures their verdicts, and renders
// a unified report. This is the meta-aggregator the user asked for in the
// v0.7.0 roadmap.
//
// Per-reviewer invocations (cross-checked against their --help output):
//   codex   exec --skip-git-repo-check                — stdin=prompt
//   gemini  --skip-trust --approval-mode plan -p <prompt>
//   grok    --output-format plain -p <prompt> --permission-mode plan
//                                              --disallowed-tools ...
//
// Aggregate timeout is per-reviewer (each gets the full budget); the
// command waits for all of them, surfacing partial results if any time
// out. Verdict-parsing is a forgiving regex on `VERDICT: <token>` —
// reviewers that don't speak the contract get a `verdict: unparsed`
// label in the summary table.

const DEFAULT_AGG_TIMEOUT_MS = 10 * 60 * 1000;   // 10m per reviewer

// In-memory buffer cap per reviewer. v0.7.0 round-2 aggregate-review-self
// review (all three reviewers concurred): `stdout += d; stderr += d;` with no
// bound risked OOM on a verbose / runaway reviewer. 16 MiB is generous for
// any legitimate review answer while bounding heap pressure.
const MAX_REVIEWER_BUF = 16 * 1024 * 1024;

// v0.7.1: each reviewer first tries its peer plugin's companion.mjs
// (review --wait) which runs the diff through the peer plugin's safety
// layer (env scrubbing, prompt-file handling, capability probes, etc.).
// Falls back to raw-CLI spawn (v0.7.0 hardened path) when the peer
// plugin is not installed.
const AGG_REVIEWERS = [
  {
    name: "codex",
    label: "Codex (OpenAI)",
    detect: () => {
      // v0.7.2 (Codex P2): a peer plugin's companion.mjs being present
      // does NOT guarantee the underlying CLI is on PATH or authed.
      // Require both before we count this reviewer as available.
      const peer = findPeerCompanion("codex");
      const cli = which("codex");
      if (peer && cli) return { kind: "peer", path: peer };
      if (cli) return { kind: "cli", path: cli };
      return null;
    },
    buildCmd: ({ detection, promptText, base, scope, adversarial, focus }) => {
      if (detection.kind === "peer") {
        // Codex's adversarial-review accepts trailing focus text, plain
        // review does not. If the user passed focus, auto-switch to
        // adversarial-review to forward it through (Codex P2 finding).
        const sub = (adversarial || focus) ? "adversarial-review" : "review";
        const args = [detection.path, sub, "--wait"];
        if (base) args.push("--base", base);
        if (scope) args.push("--scope", scope);
        if (focus && sub === "adversarial-review") args.push(focus);
        return { cmd: process.execPath, args, stdin: null, isPlainText: true, via: "peer" };
      }
      return {
        cmd: "codex",
        args: ["exec", "--skip-git-repo-check"],
        stdin: promptText,
        isPlainText: true,
        via: "cli"
      };
    }
  },
  {
    name: "gemini",
    label: "Gemini (Google)",
    detect: () => {
      const peer = findPeerCompanion("gemini");
      const cli = which("gemini");
      if (peer && cli) return { kind: "peer", path: peer };
      if (cli) return { kind: "cli", path: cli };
      return null;
    },
    buildCmd: ({ detection, promptText, base, scope, adversarial, focus }) => {
      if (detection.kind === "peer") {
        const sub = (adversarial || focus) ? "adversarial-review" : "review";
        const args = [detection.path, sub, "--wait"];
        if (base) args.push("--base", base);
        if (scope) args.push("--scope", scope);
        if (focus && sub === "adversarial-review") args.push(focus);
        return { cmd: process.execPath, args, stdin: null, isPlainText: true, via: "peer" };
      }
      return {
        cmd: "gemini",
        args: ["--skip-trust", "--approval-mode", "plan", "-p", ""],
        stdin: promptText,
        isPlainText: true,
        via: "cli"
      };
    }
  },
  {
    name: "grok",
    label: "Grok (xAI)",
    detect: () => {
      const peer = findPeerCompanion("grok");
      const cli = which("grok");
      // grok needs the CLI present even for peer routing (peer just
      // wraps the CLI). Dev-checkout self-path fallback also requires
      // the CLI.
      if (peer && cli) return { kind: "peer", path: peer };
      const selfPath = fileURLToPathLocal(import.meta.url);
      if (selfPath && cli && fs.existsSync(selfPath)) return { kind: "peer", path: selfPath };
      if (cli) return { kind: "cli", path: cli };
      return null;
    },
    buildCmd: ({ detection, promptFile, model, base, scope, adversarial, focus }) => {
      if (detection.kind === "peer") {
        const sub = (adversarial || focus) ? "adversarial-review" : "review";
        const args = [detection.path, sub, "--wait"];
        if (base) args.push("--base", base);
        if (scope) args.push("--scope", scope);
        if (model) args.push("--model", model);
        if (focus && sub === "adversarial-review") args.push(focus);
        return { cmd: process.execPath, args, stdin: null, isPlainText: true, via: "peer" };
      }
      return {
        cmd: "grok",
        args: [
          "--prompt-file", promptFile,
          ...grokBaseArgs({ readOnly: true, model, jsonOutput: false }),
          "--max-turns", "60"
        ],
        stdin: null,
        isPlainText: true,
        via: "cli"
      };
    }
  }
];

function fileURLToPathLocal(u) {
  try {
    // Local helper — avoid importing url module just for this.
    if (u.startsWith("file://")) return decodeURIComponent(u.slice(7));
    return u;
  } catch { return null; }
}

// v0.7.2 (Codex P1 finding): peer plugins emit verdicts in different
// shapes. codex-plugin-cc's review renderer writes
// `Verdict: needs-attention` (lowercase, hyphenated). The original
// `[A-Z_]+` capture took the first all-caps run and gave `NEEDS`, which
// the failure check didn't recognize. Now we capture a more permissive
// token and normalize it.
//
// Verdicts that count as "clean ship":
//   APPROVE | APPROVE_WITH_NITS | OK | OK_WITH_NITS | NO_ISSUES
// Everything else (NEEDS_ATTENTION, REQUIRES_CHANGES, REJECT, FAIL,
// UNPARSED, NO-OUTPUT, SPAWN_ERROR, etc.) is treated as a failure
// signal by the aggregate exit-code logic.
const AGG_CLEAN_VERDICTS = new Set([
  "APPROVE", "APPROVE_WITH_NITS",
  "OK", "OK_WITH_NITS",
  "NO_ISSUES"
]);

function parseAggVerdict(out) {
  if (!out) return { verdict: "no-output", blocking: 0, nits: 0 };
  // Allow hyphenated/lowercase verdict words; codex-plugin's renderer
  // uses `Verdict: needs-attention`. The widened class is [A-Za-z_-]+
  // and we normalize to UPPERCASE_WITH_UNDERSCORES.
  const m = out.match(/VERDICT:\s*([A-Za-z_-]+)/i);
  const raw = m ? m[1] : null;
  const verdict = raw ? raw.toUpperCase().replace(/-/g, "_") : "UNPARSED";
  // Best-effort counts. The verdict block conventions are user-driven
  // (BLOCKING: / NITS: bullets), so we count lines starting with `-`
  // under those headers if present.
  const blockingMatch = out.match(/BLOCKING:\s*([\s\S]*?)(?:\n\n|NITS:|STRENGTHS:|RATIONALE:|$)/i);
  const nitsMatch = out.match(/NITS:\s*([\s\S]*?)(?:\n\n|STRENGTHS:|RATIONALE:|$)/i);
  const countBullets = s => (s ? (s.match(/^[\s-*]+\S/gm) || []).length : 0);
  return {
    verdict,
    blocking: countBullets(blockingMatch && blockingMatch[1]),
    nits: countBullets(nitsMatch && nitsMatch[1])
  };
}

function spawnReviewer(spec, common) {
  return new Promise(resolve => {
    const buildResult = spec.buildCmd(common);
    const started = Date.now();
    let proc;
    try {
      proc = spawn(buildResult.cmd, buildResult.args, {
        stdio: [buildResult.stdin == null ? "ignore" : "pipe", "pipe", "pipe"],
        env: cleanGrokEnv()
      });
    } catch (err) {
      // v0.7.0 round-2 (Gemini + Grok): spawn() can throw synchronously
      // (e.g., E2BIG with `-p <huge>` before the ARG_MAX fix, ENOENT
      // racing with which(), or fd-exhaustion). Both reviewers flagged
      // that the missing handler would crash the entire companion.
      resolve({
        name: spec.name, label: spec.label,
        exitCode: -1, elapsedMs: Date.now() - started,
        timedOut: false, errored: true,
        output: "",
        stderr: `spawn-throw: ${err.code || err.message}`,
        verdict: "SPAWN_ERROR", blocking: 0, nits: 0
      });
      return;
    }
    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0, stderrBytes = 0;
    let stdoutTruncated = false, stderrTruncated = false;
    let timedOut = false;
    let errored = false;
    proc.stdout.setEncoding("utf8");
    proc.stderr.setEncoding("utf8");
    // v0.7.0 round-2 (Grok finding): cap in-memory accumulation to
    // MAX_REVIEWER_BUF. A misbehaving reviewer flood used to grow the
    // heap unbounded until the SIGKILL fired 10 min later.
    proc.stdout.on("data", d => {
      const n = Buffer.byteLength(d, "utf8");
      if (stdoutBytes + n > MAX_REVIEWER_BUF) {
        const remaining = MAX_REVIEWER_BUF - stdoutBytes;
        if (remaining > 0) stdout += d.slice(0, remaining);
        stdoutBytes = MAX_REVIEWER_BUF;
        stdoutTruncated = true;
        try { proc.kill("SIGKILL"); } catch {}
        return;
      }
      stdout += d;
      stdoutBytes += n;
    });
    proc.stderr.on("data", d => {
      const n = Buffer.byteLength(d, "utf8");
      if (stderrBytes + n > MAX_REVIEWER_BUF) {
        const remaining = MAX_REVIEWER_BUF - stderrBytes;
        if (remaining > 0) stderr += d.slice(0, remaining);
        stderrBytes = MAX_REVIEWER_BUF;
        stderrTruncated = true;
        return;
      }
      stderr += d;
      stderrBytes += n;
    });
    // v0.7.0 round-2 (Gemini + Grok): asynchronous spawn errors
    // (post-fork failures, broken stdio, signal-before-data) emit an
    // 'error' event. Without this listener the Node process crashes
    // unhandled, aborting all sibling reviewers' results.
    proc.on("error", err => {
      errored = true;
      stderr += `\nproc-error: ${err.code || err.message}\n`;
    });
    if (buildResult.stdin != null) {
      proc.stdin.write(buildResult.stdin);
      proc.stdin.end();
    }
    // v0.7.0 round-2 (Codex): --timeout 0 used to install a 0ms timer
    // that fired immediately. Match the existing job-runner pattern:
    // only install the timer when timeoutMs > 0.
    let timer = null;
    if (common.timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        try { proc.kill("SIGKILL"); } catch {}
      }, common.timeoutMs);
    }
    proc.on("close", code => {
      if (timer) clearTimeout(timer);
      const elapsedMs = Date.now() - started;
      // v0.7.0 round-2 (Gemini): grok in aggregate-review is invoked
      // with `--output-format plain`, so the output is plain markdown.
      //
      // v0.7.2 (self-dogfood Grok finding): the previous fix used the
      // wrong scope — the isPlainText property lives on the buildCmd
      // RETURN value, not on the spec itself, so the spec-level read
      // was always undefined and the guard was always taken — exactly
      // the regression the v0.7.0 round-2 fix was meant to prevent.
      // Use buildResult.isPlainText.
      let display = stdout;
      if (!buildResult.isPlainText && spec.name === "grok") {
        const parsed = parseGrokJson(stdout);
        if (parsed.kind === "text") display = parsed.text;
        else if (parsed.kind === "error") display = `(grok internal error) ${parsed.message}`;
      }
      if (stdoutTruncated) {
        display += `\n\n[grok-plugin] reviewer stdout truncated at ${MAX_REVIEWER_BUF} bytes.\n`;
      }
      const cleaned = sanitizeForTerminal(display);
      resolve({
        name: spec.name,
        label: spec.label,
        exitCode: code,
        elapsedMs,
        timedOut,
        errored,
        truncated: stdoutTruncated || stderrTruncated,
        via: buildResult.via,
        output: cleaned,
        stderr: sanitizeForTerminal(stderr).slice(0, 4000),
        ...parseAggVerdict(cleaned)
      });
    });
  });
}

// ---------- v0.8.7 CLI-fallback helpers (extracted for testability) ----------
//
// The peer-plugin-cc#4 workaround needs three primitives that v0.8.5/v0.8.6
// had inlined. Extracting them gives behavioral tests a clean entry point
// (Grok LOW #6 round-8) and makes the predicate change-resistant
// (`MAX_PEER_EARLY_EXIT_BYTES` is now a named constant — Grok MED #4).

// The peer plugin's empty-diff early-exit message is one line (~50 bytes
// in current gemini-plugin-cc). Be generous: 400 bytes covers any minor
// future change without admitting multi-paragraph reviews. Falsy/empty
// strings short-circuit to false. ANCHORED ^ regex prevents matching
// the phrase mid-prose in a real review.
export const MAX_PEER_EARLY_EXIT_BYTES = 400;
// v0.9.7: formatSessionHint moved to lib/render.mjs (the shared
// rendering helper module). companion.mjs imports it; render.mjs uses
// it via formatSessionLabel. Single source of truth across all three
// surfaces. Closes the duplicate-decision-tree gap 3/3 reviewers
// flagged in round-7.

export function isPeerEmptyDiffMessage(out) {
  const trimmed = (out || "").trim();
  return trimmed.length > 0 &&
    trimmed.length < MAX_PEER_EARLY_EXIT_BYTES &&
    /^Nothing to review/i.test(trimmed);
}

// Predicate: should this reviewer's result be retried via raw CLI?
// All conditions must hold:
//   1. peer routing was used (we only retry the case the bug affects)
//   2. peer returned UNPARSED (real reviews always emit a VERDICT: line)
//   3. output matches the peer's empty-diff early-exit shape (anchored)
//   4. our captureDiff DID produce a non-empty diff
export function shouldFallbackToCli(r, diffResult) {
  if (!r || r.via !== "peer") return false;
  if (r.verdict !== "UNPARSED") return false;
  if (!isPeerEmptyDiffMessage(r.output)) return false;
  if (!diffResult || !diffResult.diff || !diffResult.diff.trim()) return false;
  return true;
}

// Compute the per-reviewer remaining timeout budget.
//   timeoutMs === 0  → user asked for "no timeout"; pass 0 through.
//                      The 3/3 reviewer consensus in round-8 was that
//                      v0.8.6 incorrectly tripped its < 5s guard when
//                      timeoutMs === 0 and silently skipped the entire
//                      fallback.
//   timeoutMs  > 0  → return max(0, timeoutMs - reviewerElapsedMs).
//                      Uses each reviewer's OWN elapsed time, not the
//                      batch wall-clock — Grok HIGH #2 round-8: batch
//                      timing was starving fast buggy peers when slow
//                      siblings ran concurrently.
export function remainingBudgetMs(timeoutMs, reviewerElapsedMs) {
  if (timeoutMs === 0) return 0; // 0 = unbounded sentinel
  const e = Number(reviewerElapsedMs) || 0;
  return Math.max(0, timeoutMs - e);
}

// Spawn latency is observable on a loaded machine (which() + spawn cold
// path can eat 2-6 seconds). Set the minimum useful budget below that
// so we don't skip fallbacks that would actually run, but well above
// "0" so a 100ms budget definitely-skips. Round-8 Grok MED #3 flagged
// the previous 5000 as too aggressive.
export const FALLBACK_MIN_BUDGET_MS = 2000;

async function cmdAggregateReview({ flags, positional }) {
  const scope = flags.scope || "auto";
  const base = flags.base || null;
  const focus = positional.join(" ").trim();
  const diffResult = captureDiff({ scope: scope === "branch" ? "branch" : scope, base });
  if (diffResult.kind === "no-repo") {
    console.log("Not inside a git repository - nothing to review.");
    process.exit(0);
  }
  if (diffResult.kind === "no-base") {
    console.error("Branch review needs a base ref. Pass --base <ref>.");
    process.exit(2);
  }
  if (diffResult.kind === "bad-ref") {
    console.error(`Invalid git ref for --base: ${base}`);
    process.exit(2);
  }
  if (!diffResult.diff.trim()) {
    console.log(`Nothing to review (scope: ${diffResult.kind}${diffResult.base ? `, base: ${diffResult.base}` : ""}).`);
    process.exit(0);
  }

  // v0.7.1: each reviewer's detect() now returns either { kind: "peer",
  // path } (peer plugin's companion.mjs available) or { kind: "cli",
  // path } (raw CLI on PATH) or null. We pair each spec with its
  // detection result so the buildCmd inside spawnReviewer doesn't
  // re-detect.
  const available = AGG_REVIEWERS
    .map(spec => ({ spec, detection: spec.detect() }))
    .filter(r => r.detection);
  if (available.length === 0) {
    console.error("None of codex / gemini / grok are installed. Install at least one CLI to use /grok:aggregate-review.");
    process.exit(127);
  }
  if (available.length === 1) {
    console.error(`Only ${available[0].spec.name} is installed; /grok:aggregate-review needs at least two reviewers to be useful. Use /${available[0].spec.name}:ask or /grok:ask instead.`);
    process.exit(2);
  }

  const target = diffResult.kind + (diffResult.base ? ` (base: ${diffResult.base})` : "");
  // The prompt + promptFile are still needed for the raw-CLI fallback
  // path. Peer plugins capture their own diff (we pass --base/--scope
  // through) and use their own review prompt template, so this prompt
  // is harmless overhead for the peer path — but creating it costs
  // nothing meaningful and the unlink at the end is idempotent.
  const prompt = buildReviewPrompt({
    adversarial: !!flags.adversarial,
    focus,
    target,
    jsonOutput: false,
    diff: diffResult.diff
  });
  const promptFile = writePromptToTempFile(prompt, "grok-agg-prompt");
  const timeoutMs = resolveTimeoutMs(flags.timeout, DEFAULT_AGG_TIMEOUT_MS);

  process.stdout.write(`# /grok:aggregate-review\n`);
  process.stdout.write(`Reviewers: ${available.map(r => `${r.spec.name} (via ${r.detection.kind})`).join(", ")}\n`);
  process.stdout.write(`Target: ${target}${focus ? `\nFocus: ${focus}` : ""}\n`);
  process.stdout.write(`Diff size: ${diffResult.diff.length} bytes\n\n`);
  process.stdout.write(`Running ${available.length} reviewers in parallel (per-reviewer timeout: ${timeoutMs}ms)...\n\n`);

  let results;
  try {
    results = await Promise.all(available.map(r => spawnReviewer(r.spec, {
      detection: r.detection,
      promptFile,
      promptText: prompt,
      model: flags.model,
      timeoutMs,
      base,
      scope: scope === "auto" ? null : scope,
      adversarial: !!flags.adversarial,
      focus: focus || null
    })));

    // v0.8.5 → v0.8.6 → v0.8.7: gemini-plugin-cc#4 self-healing fallback
    // for peer reviewers that return the empty-diff early-exit despite
    // a real diff. Predicate + budget logic extracted to module-scope
    // helpers below so it can be unit-tested directly. The mechanics:
    //   1. Filter `results` for entries that look like the peer-bug
    //      symptom (predicate `shouldFallbackToCli`).
    //   2. For each, compute its OWN remaining budget from its
    //      `elapsedMs` (Grok HIGH #2 round-8: batch-level wall-clock
    //      starved fallbacks when sibling reviewers were slow).
    //   3. Re-spawn via raw CLI (uses our diff via --prompt-file /
    //      -p "" + stdin / etc.).
    const cliFallbacksNeeded = results
      .map((r, i) => ({ r, i, spec: available[i].spec }))
      .filter(({ r }) => shouldFallbackToCli(r, diffResult));
    if (cliFallbacksNeeded.length > 0) {
      process.stdout.write(
        `[grok-plugin] ${cliFallbacksNeeded.length} peer reviewer(s) returned ` +
        `the empty-diff early-exit "Nothing to review" despite a real diff — ` +
        `retrying via raw CLI (gemini-plugin-cc#4 workaround).\n\n`
      );
      const fallbackResults = await Promise.all(cliFallbacksNeeded.map(async ({ r, i, spec }) => {
        // Per-reviewer budget: each peer attempt consumed only its own
        // r.elapsedMs, not the batch wall-clock. Grok HIGH #2 round-8:
        // the v0.8.6 batch wall-clock approach starved fallbacks for
        // fast buggy peers when sibling reviewers were slow.
        //
        // v0.8.8 (3/3 round-9 consensus on `budget === 0` ambiguity):
        // remainingBudgetMs returns 0 for BOTH user-unbounded AND
        // already-exhausted positive budgets. Distinguish here so an
        // overrun does NOT pass `timeoutMs: 0` (= unbounded) to the
        // CLI fallback spawn.
        const userUnbounded = timeoutMs === 0;
        const budget = remainingBudgetMs(timeoutMs, r.elapsedMs);
        if (!userUnbounded && budget < FALLBACK_MIN_BUDGET_MS) {
          // v0.8.9 (Grok LOW #3 round-10): distinguish overrun (budget=0)
          // from low-positive ("insufficient"). "Exhausted" reads more
          // accurately when budget === 0 from elapsed >= timeoutMs.
          const reason = budget === 0 ? "exhausted" : `${budget}ms < ${FALLBACK_MIN_BUDGET_MS}ms`;
          process.stdout.write(
            `[grok-plugin] ${spec.name}: timeout budget ${reason} ` +
            `— keeping peer result.\n\n`
          );
          return null;
        }
        const cliPath = which(spec.name);
        if (!cliPath) return null;
        const newResult = await spawnReviewer(spec, {
          detection: { kind: "cli", path: cliPath },
          promptFile,
          promptText: prompt,
          model: flags.model,
          // Only 0 (unbounded) reaches the fallback when the user
          // asked for unbounded; positive budgets are honored exactly.
          timeoutMs: userUnbounded ? 0 : budget,
          base,
          scope: scope === "auto" ? null : scope,
          adversarial: !!flags.adversarial,
          focus: focus || null
        });
        newResult.via = "cli-fallback";
        return { i, newResult };
      }));
      for (const fb of fallbackResults) {
        if (fb) results[fb.i] = fb.newResult;
      }
    }
  } finally {
    try { fs.unlinkSync(promptFile); } catch {}
  }

  // Per-reviewer detail
  for (const r of results) {
    process.stdout.write(`---\n\n## ${r.label}\n\n`);
    process.stdout.write(`*Exit: ${r.exitCode} · ${r.elapsedMs}ms${r.timedOut ? " · TIMED OUT" : ""} · Via: ${r.via || "?"} · Verdict: ${r.verdict} · Blocking: ${r.blocking} · Nits: ${r.nits}*\n\n`);
    if (r.output) process.stdout.write(r.output.trim() + "\n\n");
    if (r.exitCode !== 0 && r.stderr) {
      process.stdout.write(`<details><summary>stderr</summary>\n\n\`\`\`\n${r.stderr}\n\`\`\`\n\n</details>\n\n`);
    }
  }

  // Summary table — note Status column reflects execution health
  // separately from verdict (v0.7.0 round-2 Codex finding: failed
  // reviewer used to silently exit 0).
  process.stdout.write(`---\n\n## Summary\n\n`);
  process.stdout.write(`| Reviewer | Verdict | Blocking | Nits | Time | Status |\n`);
  process.stdout.write(`|---|---|---|---|---|---|\n`);
  for (const r of results) {
    let status;
    if (r.errored) status = "spawn-error";
    else if (r.timedOut) status = "timeout";
    else if (r.exitCode !== 0) status = `exit ${r.exitCode}`;
    else if (r.verdict === "UNPARSED" || r.verdict === "NO-OUTPUT") status = r.verdict.toLowerCase();
    else status = "ok";
    process.stdout.write(`| ${r.label} | ${r.verdict} | ${r.blocking} | ${r.nits} | ${(r.elapsedMs/1000).toFixed(1)}s | ${status} |\n`);
  }

  // Aggregate failure = anything NOT in the clean-verdict whitelist,
  // OR a reviewer that didn't even produce a clean run.
  //
  // v0.7.0 round-2 added the explicit-bad-verdict list (REJECT, etc.).
  // v0.7.2 inverts to an explicit-good-verdict whitelist after Codex
  // P1 found that `Verdict: needs-attention` from codex-plugin-cc was
  // tokenized as `NEEDS` and slipped through the old check.
  const failed = results.filter(r =>
    !AGG_CLEAN_VERDICTS.has(r.verdict) ||
    r.timedOut ||
    r.errored ||
    (r.exitCode !== 0 && r.exitCode != null)
  );
  if (failed.length > 0) {
    process.stdout.write(`\n**${failed.length} of ${results.length} reviewer(s) did not produce a clean APPROVE / APPROVE_WITH_NITS verdict.** See per-reviewer detail above.\n`);
  }
  process.exit(failed.length > 0 ? 1 : 0);
}

// ---------- v0.9.0: thin subcommand wrappers ----------
//
// /grok:worktree, /grok:sessions, /grok:memory, /grok:mcp all share the
// same shape: wrap a `grok <subcmd> [...]` invocation with the plugin's
// standard env scrubbing + ANSI sanitization + timeout + auth-hint
// surface. Centralized here to avoid 4 copies of the same boilerplate.
//
// v0.9.1 (3/3 reviewer consensus round-1):
//   - Positional allowlist replaced with control-byte denylist.
//     spawnSync is invoked without `shell: true` so shell-meta is
//     pre-mitigated by Node — the strict allowlist was over-rejecting
//     valid MCP URLs (`?token=`, `#fragment`) and free-text session
//     search queries.
//   - allowedPositionalLooksLikeFlag: per-command control. Sessions
//     `search` legitimately searches for `--`-prefixed strings.
//   - --timeout is now in every command's allowFlags (was advertised
//     in argument-hint but dropped silently).
const DEFAULT_SUB_TIMEOUT_MS = 30 * 1000;
// v0.9.2 (Gemini Nit #4 round-2): allow TAB (0x09), LF (0x0A), CR
// (0x0D) in subcommand positionals. Real-world inputs (`grok memory
// add "multi\nline\nfact"`, pasted multi-line search queries) need
// these. Still reject every other C0 (NUL, BEL, ESC, etc.) and DEL.
const CONTROL_BYTE_FREETEXT_DENYLIST = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;
function cmdGrokSubcommandPassthrough({ subcommand, flags, positional, literalStartIndex = -1, label, allowFlags = new Set(), defaultTimeoutMs = DEFAULT_SUB_TIMEOUT_MS }) {
  if (!which("grok")) {
    console.error("Grok CLI not installed. Run `/grok:setup`.");
    process.exit(127);
  }
  // Construct argv. Positionals pass through after a defense-in-depth
  // check: refuse control bytes (no-shell argv still gets these
  // rendered when grok prints back) and refuse oversize.
  //
  // v0.9.2 (Gemini Important #2 round-2): track which positionals
  // were `--`-escaped via the parser's literalStartIndex. Those bypass
  // the flag-like-positional check (the user explicitly told us they
  // want a literal token even if it looks like a flag). We also need
  // to re-emit `--` before them when forwarding to grok so grok
  // itself doesn't reinterpret them as flags (3/3 round-2 critical).
  const safeRegular = [];
  const safeLiteral = [];
  for (let idx = 0; idx < positional.length; idx++) {
    const p = positional[idx];
    const isLiteral = literalStartIndex >= 0 && idx >= literalStartIndex;
    const s = String(p);
    if (s.length > 1024) {
      console.error(`Refusing to forward oversize argument (${s.length} > 1024 chars).`);
      process.exit(2);
    }
    if (CONTROL_BYTE_FREETEXT_DENYLIST.test(s)) {
      // v0.9.3 (Grok LOW #1 round-3): the offending bytes were
      // previously emitted raw into stderr — a BEL would ring the
      // terminal, an ESC would inject ANSI. JSON.stringify renders
      // them as visible `\u00XX` escapes.
      console.error(`Refusing to forward argument with disallowed control bytes: ${JSON.stringify(s.slice(0, 64))}`);
      process.exit(2);
    }
    if (!isLiteral) {
      if (s.startsWith("--") || (s.length >= 2 && s[0] === "-" && /^-[A-Za-z]/.test(s))) {
        // Same JSON.stringify safety as above; positionals starting with
        // dashes are usually printable ASCII but defense-in-depth.
        console.error(`Refusing to forward unknown flag-like argument: ${JSON.stringify(s.slice(0, 64))} (use \`-- ${s.slice(0, 32)}\` to pass literally)`);
        process.exit(2);
      }
    }
    if (isLiteral) safeLiteral.push(s);
    else safeRegular.push(s);
  }
  // Selected flags are passed through. Only flags in `allowFlags` are
  // forwarded; unknown flags are dropped (the slash command's arg-hint
  // documents what's accepted).
  const safeFlags = [];
  for (const [k, v] of Object.entries(flags)) {
    if (!allowFlags.has(k)) continue;
    if (v === true) safeFlags.push(`--${k}`);
    else if (typeof v === "string" || typeof v === "number") {
      const sv = String(v);
      // v0.9.3 (Gemini Nit #2 round-3): use the same control-byte
      // denylist as positionals (allow TAB/LF/CR) so a future
      // multi-line flag value isn't silently dropped. Today only
      // `json` and `timeout` are in SUBCMD_BASE_ALLOW so this is
      // forward-compatibility only.
      if (sv.length > 256 || CONTROL_BYTE_FREETEXT_DENYLIST.test(sv)) continue;
      safeFlags.push(`--${k}`, sv);
    }
  }
  // v0.9.2 (3/3 round-2 critical: Gemini Critical #1 + Codex P2 #1):
  // re-emit `--` before literal positionals so grok itself doesn't
  // re-interpret them as flags. The previous code consumed `--` in
  // the parser then forwarded the literal `--timeout` to grok with
  // no protection → grok parsed it as a flag → the v0.9.1 fix
  // silently regressed.
  const argv = [subcommand, ...safeRegular, ...safeFlags];
  if (safeLiteral.length > 0) argv.push("--", ...safeLiteral);
  const timeoutMs = resolveTimeoutMs(flags.timeout, defaultTimeoutMs);
  const spawnOpts = {
    encoding: "utf8",
    env: cleanGrokEnv(),
    maxBuffer: HEADLESS_GROK_MAX_BUFFER
  };
  if (timeoutMs > 0) spawnOpts.timeout = Math.min(timeoutMs, MAX_SETTIMEOUT_MS);
  const r = spawnSync("grok", argv, spawnOpts);
  if (r.error && r.error.code === "ETIMEDOUT") {
    process.stderr.write(`\n[grok-plugin] ${label} timed out after ${timeoutMs}ms.\n`);
    process.exit(EXIT_TIMEOUT);
  }
  if (r.error) {
    if (r.stdout) process.stdout.write(sanitizeForTerminal(r.stdout));
    if (r.stderr) process.stderr.write(sanitizeForTerminal(r.stderr));
    process.stderr.write(`\n[grok-plugin] ${label} failed: ${r.error.code || r.error.message}\n`);
    if (r.error.code === "ENOBUFS") {
      process.stderr.write(`[grok-plugin] ${label} output exceeded ${HEADLESS_GROK_MAX_BUFFER} bytes.\n`);
    }
    process.exit(1);
  }
  if (r.stdout) process.stdout.write(sanitizeForTerminal(r.stdout));
  if (r.status !== 0) {
    if (r.stderr) process.stderr.write(sanitizeForTerminal(r.stderr));
    const why = classifyAuthBlob((r.stdout || "") + "\n" + (r.stderr || ""));
    if (why) process.stderr.write(`\n[hint: ${why}. Run /grok:setup.]\n`);
  }
  process.exit(r.status ?? 0);
}

// v0.9.1 (Grok MED round-1): --timeout was advertised in every wrapper's
// argument-hint but dropped by the allowlist. Add it everywhere so
// the docs match the impl.
const SUBCMD_BASE_ALLOW = new Set(["json", "timeout"]);

function cmdWorktree(args) {
  return cmdGrokSubcommandPassthrough({
    subcommand: "worktree",
    flags: args.flags, positional: args.positional,
    literalStartIndex: args.literalStartIndex,
    label: "worktree",
    allowFlags: SUBCMD_BASE_ALLOW,
    defaultTimeoutMs: 30 * 1000
  });
}
function cmdSessions(args) {
  // v0.9.3 (Gemini Nit #1 round-3): removed the
  // `allowFlagLikePositionals: positional[0] === "search"` heuristic.
  // The POSIX `--` terminator now serves the same purpose more
  // explicitly — users wanting to search for "--timeout" type
  // `/grok:sessions search -- --timeout` and the wrapper re-emits
  // `--` before forwarding. The heuristic was redundant + leaky.
  return cmdGrokSubcommandPassthrough({
    subcommand: "sessions",
    flags: args.flags, positional: args.positional,
    literalStartIndex: args.literalStartIndex,
    label: "sessions",
    allowFlags: SUBCMD_BASE_ALLOW,
    defaultTimeoutMs: 30 * 1000
  });
}
function cmdMemory(args) {
  return cmdGrokSubcommandPassthrough({
    subcommand: "memory",
    flags: args.flags, positional: args.positional,
    literalStartIndex: args.literalStartIndex,
    label: "memory",
    allowFlags: SUBCMD_BASE_ALLOW,
    defaultTimeoutMs: 30 * 1000
  });
}
function cmdMcp(args) {
  return cmdGrokSubcommandPassthrough({
    subcommand: "mcp",
    flags: args.flags, positional: args.positional,
    literalStartIndex: args.literalStartIndex,
    label: "mcp",
    allowFlags: SUBCMD_BASE_ALLOW,
    // mcp doctor probes server health which can be slow; bump to 2 min.
    defaultTimeoutMs: 2 * 60 * 1000
  });
}

// ---------- v0.8.0: /grok:inspect ----------
//
// Wraps `grok inspect`. The CLI emits a structured dump (plain or
// --json) describing exactly what merged config will affect the next
// grok call: AGENTS.md / CLAUDE.md / GROK.md rules, autoloaded skills,
// MCP server configs, permission rules, plugins, LSP, hooks.
//
// This is the single most useful "why is grok doing X?" debugging tool
// and the v0.8.0 research found that all 4 LLMs flagged it as a gap.
const DEFAULT_INSPECT_TIMEOUT_MS = 30 * 1000;
function cmdInspect({ flags }) {
  if (!which("grok")) {
    console.error("Grok CLI not installed. Run `/grok:setup`.");
    process.exit(127);
  }
  const timeoutMs = resolveTimeoutMs(flags.timeout, DEFAULT_INSPECT_TIMEOUT_MS);
  const argv = ["inspect"];
  if (flags.json) argv.push("--json");
  // v0.8.1 (Codex P2.b): grok inspect output can exceed spawnSync's
  // 1 MiB default maxBuffer in workspaces with many skills/MCPs. Match
  // the runHeadlessGrok pattern: explicit maxBuffer + ENOBUFS detection.
  const spawnOpts = {
    encoding: "utf8",
    env: cleanGrokEnv(),
    maxBuffer: HEADLESS_GROK_MAX_BUFFER
  };
  if (timeoutMs > 0) spawnOpts.timeout = Math.min(timeoutMs, MAX_SETTIMEOUT_MS);
  const r = spawnSync("grok", argv, spawnOpts);
  if (r.error && r.error.code === "ETIMEDOUT") {
    process.stderr.write(`\n[grok-plugin] inspect timed out after ${timeoutMs}ms.\n`);
    process.exit(EXIT_TIMEOUT);
  }
  if (r.error) {
    if (r.stdout) process.stdout.write(sanitizeForTerminal(r.stdout));
    if (r.stderr) process.stderr.write(sanitizeForTerminal(r.stderr));
    process.stderr.write(`\n[grok-plugin] inspect failed: ${r.error.code || r.error.message}\n`);
    if (r.error.code === "ENOBUFS") {
      process.stderr.write(`[grok-plugin] inspect output exceeded ${HEADLESS_GROK_MAX_BUFFER} bytes; try --json and redirect to a file.\n`);
    }
    process.exit(1);
  }
  if (r.stdout) process.stdout.write(sanitizeForTerminal(r.stdout));
  if (r.status !== 0) {
    if (r.stderr) process.stderr.write(sanitizeForTerminal(r.stderr));
    const why = classifyAuthBlob((r.stdout || "") + "\n" + (r.stderr || ""));
    if (why) process.stderr.write(`\n[hint: ${why}. Run /grok:setup.]\n`);
  }
  process.exit(r.status ?? 0);
}

async function main() {
  const [, , sub, ...rest] = process.argv;
  if (!sub) {
    console.error("Usage: companion.mjs <setup|ask|review|adversarial-review|imagine|imagine-video|task|research|fan-out|models|best-of|aggregate-review|inspect|worktree|sessions|memory|mcp|status|result|cancel|purge> [args...]");
    process.exit(2);
  }
  let args;
  try {
    // v0.9.2 (3/3 round-2 Codex P2 #2 + Gemini Important #3):
    // shortAliases removed from the top-level dispatch. v0.9.1
    // enabled them globally, which mis-rewrote `-r foo` inside
    // free-form prompts like `/grok:ask explain grep -r foo` — the
    // parser set resume=true and consumed `foo` as part of the
    // misinterpreted bundle. Users must now use the long form
    // (--resume=ID, --worktree=name, --continue). The slash command
    // .md files document only the long form.
    args = parseArgs(rest, {
      boolFlags: COMMON_BOOL_FLAGS,
      valueFlags: COMMON_VALUE_FLAGS,
      repeatableFlags: COMMON_REPEATABLE_FLAGS,
      optionalValueFlags: COMMON_OPTIONAL_VALUE_FLAGS
    });
  } catch (e) {
    // v0.9.2 (Codex P3 + Grok MED round-2): EMPTY_VALUE was thrown by
    // the v0.9.1 optional-value parser but only MISSING_VALUE was
    // caught here — EMPTY_VALUE fell through to the outer fatal
    // handler and exited 1 instead of the proper usage-error exit 2.
    if (e.code === "MISSING_VALUE" || e.code === "EMPTY_VALUE") {
      console.error(e.message);
      process.exit(2);
    }
    throw e;
  }
  switch (sub) {
    case "setup": return cmdSetup(args);
    case "ask": return cmdAsk(args);
    case "review": return await cmdReview(args, { adversarial: false });
    case "adversarial-review": return await cmdReview(args, { adversarial: true });
    case "imagine": return await cmdImagine(args, { video: false });
    case "imagine-video": return await cmdImagine(args, { video: true });
    case "task": return await cmdTask(args);
    case "research": return cmdResearch(args);
    case "fan-out": return cmdFanOut(args);
    case "models": return cmdModels(args);
    case "best-of": return cmdBestOf(args);
    case "aggregate-review": return await cmdAggregateReview(args);
    case "inspect": return cmdInspect(args);
    case "worktree": return cmdWorktree(args);
    case "sessions": return cmdSessions(args);
    case "memory": return cmdMemory(args);
    case "mcp": return cmdMcp(args);
    case "status": return cmdStatus(args);
    case "result": return cmdResult(args);
    case "cancel": return await cmdCancel(args);
    case "purge": return cmdPurge(args);
    default:
      console.error(`Unknown subcommand: ${sub}`);
      console.error("Usage: companion.mjs <setup|ask|review|adversarial-review|imagine|imagine-video|task|research|fan-out|models|best-of|aggregate-review|inspect|worktree|sessions|memory|mcp|status|result|cancel|purge> [args...]");
      process.exit(2);
  }
}

// v0.8.7: only auto-run main() when this file is invoked as the
// CLI entry point. Test files import from companion.mjs to call
// shouldFallbackToCli / remainingBudgetMs directly; without this
// guard, every import would trigger main() → usage error → exit 2.
//
// v0.8.8: resolve through fs.realpathSync so symlinks (Claude Code
// plugin cache, npm `.bin/` shims, case-insensitive macOS volumes)
// don't cause the legitimate-entry comparison to falsely fail.
//
// v0.8.9 (Grok MED #2 round-10): both fallback branches now use
// path.resolve so the comparison stays consistent even when realpath
// fails on both sides. Worst case: a symlinked invocation with both
// realpath calls failing falls back to path.resolve on both, which
// still gives consistent normalization. The safe failure mode is
// "main() doesn't auto-run on import" — never the inverse.
const _entryPath = (() => {
  const p = fileURLToPath(import.meta.url);
  try { return fs.realpathSync(p); } catch { return path.resolve(p); }
})();
const _invokedAs = (() => {
  if (!process.argv[1]) return null;
  try { return fs.realpathSync(process.argv[1]); }
  catch { return path.resolve(process.argv[1]); }
})();
if (_invokedAs === _entryPath) {
  main().catch(err => {
    console.error(`grok-plugin fatal: ${err && err.message ? err.message : err}`);
    process.exit(1);
  });
}
