// Regression tests for the eight v0.4.0 hardening fixes.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";

import {
  findLastJsonObject,
  parseVerdict,
  findBalancedJsonEnd
} from "../plugins/grok/scripts/lib/verdict.mjs";

import {
  READ_ONLY_DISALLOWED_TOOLS,
  AUTH_PROBE_DISALLOWED_TOOLS,
  grokBaseArgs
} from "../plugins/grok/scripts/lib/grok.mjs";

import { isAlive } from "../plugins/grok/scripts/lib/process.mjs";

const COMPANION_PATH = new URL("../plugins/grok/scripts/companion.mjs", import.meta.url).pathname;
const STOP_GATE_PATH = new URL("../plugins/grok/scripts/stop-review-gate-hook.mjs", import.meta.url).pathname;
const GIT_LIB_PATH = new URL("../plugins/grok/scripts/lib/git.mjs", import.meta.url).pathname;
const PROMPT_REVIEW_PATH = new URL("../plugins/grok/prompts/review.md", import.meta.url).pathname;

// ============================================================================
// B1 — UTF-8 chunk tearing defense (Gemini round-3 finding)
// ============================================================================

test("B1: companion.mjs::runJob sets utf8 encoding on spawned stdio", () => {
  const src = fs.readFileSync(COMPANION_PATH, "utf8");
  // The setEncoding calls must be present right after the spawn in runJob.
  assert.match(src, /proc\.stdout\.setEncoding\("utf8"\)/,
    "runJob must setEncoding('utf8') on proc.stdout");
  assert.match(src, /proc\.stderr\.setEncoding\("utf8"\)/,
    "runJob must setEncoding('utf8') on proc.stderr");
});

test("B1: stop-review-gate-hook.mjs sets utf8 encoding on spawned stdio", () => {
  const src = fs.readFileSync(STOP_GATE_PATH, "utf8");
  assert.match(src, /proc\.stdout\.setEncoding\("utf8"\)/);
  assert.match(src, /proc\.stderr\.setEncoding\("utf8"\)/);
});

// ============================================================================
// B2 — git diff branch refspec must NOT be preceded by `--` (Codex finding)
// ============================================================================

test("B2: lib/git.mjs no longer puts `--` before the refspec in branch diff", () => {
  const src = fs.readFileSync(GIT_LIB_PATH, "utf8");
  // The buggy form was: git diff -- <ref>...HEAD
  // The fix is: git diff <ref>...HEAD (with optional `--` AFTER if needed).
  // We check that the substring `"diff", "--", \`${ref}...HEAD\`` is gone.
  assert.equal(
    src.includes(`"diff", "--", \`\${ref}...HEAD\``),
    false,
    "lib/git.mjs must not call `git diff -- <ref>...HEAD` (git treats the refspec as a pathspec)"
  );
  // And the new correct form must be present.
  assert.match(src, /"diff",\s*`\$\{ref\}\.\.\.HEAD`/,
    "lib/git.mjs must call git diff <ref>...HEAD without a preceding `--`");
});

// ============================================================================
// B3 — read-only vs auth-probe tool policy is exported as named constants
// ============================================================================

test("B3: READ_ONLY_DISALLOWED_TOOLS bans writes + shell + subagents but leaves web tools", () => {
  // Read-only ops (ask/review/research/fan-out) keep web_search / web_fetch —
  // Grok's biggest differentiator vs Claude is live web grounding.
  const banned = new Set(READ_ONLY_DISALLOWED_TOOLS.split(","));
  assert.ok(banned.has("search_replace"), "search_replace must be banned in read-only");
  assert.ok(banned.has("run_terminal_cmd"), "run_terminal_cmd must be banned in read-only");
  assert.ok(banned.has("todo_write"), "todo_write must be banned in read-only");
  assert.ok(!banned.has("web_search"), "web_search must NOT be banned in read-only (Grok strength)");
  assert.ok(!banned.has("web_fetch"), "web_fetch must NOT be banned in read-only");
  // v1.2.0 (CRITICAL, grok 0.2.22): Agent (subagents) MUST be banned in
  // read-only. On 0.2.22 the auto-included subagent-control tools
  // (get_task_output/wait_tasks/kill_task) require run_terminal_cmd, which
  // read-only strips — so leaving Agent enabled made `grok -p` fail at agent
  // build ("Requirements unsatisfied") for every read-only command. Banning
  // Agent removes those tools and the unmet requirement.
  assert.ok(banned.has("Agent"), "Agent must be banned in read-only (0.2.22 build-requirement fix)");
});

test("B3: AUTH_PROBE_DISALLOWED_TOOLS bans every tool for the deterministic probe", () => {
  const banned = new Set(AUTH_PROBE_DISALLOWED_TOOLS.split(","));
  for (const tool of ["Agent", "run_terminal_cmd", "search_replace", "web_search", "web_fetch", "todo_write"]) {
    assert.ok(banned.has(tool), `${tool} must be banned during auth probe`);
  }
});

test("B3: grokBaseArgs uses the shared READ_ONLY_DISALLOWED_TOOLS constant", () => {
  const args = grokBaseArgs({ readOnly: true });
  const idx = args.indexOf("--disallowed-tools");
  assert.notEqual(idx, -1);
  assert.equal(args[idx + 1], READ_ONLY_DISALLOWED_TOOLS);
});

// ============================================================================
// B4 — parseGrokJson uses shared findLastJsonObject (matches stop-gate)
// ============================================================================

test("B4: lib/grok.mjs::parseGrokJson uses findLastJsonObject in slow path", () => {
  // v0.5.0 moved parseGrokJson from companion.mjs to lib/grok.mjs.
  const GROK_LIB_PATH = new URL("../plugins/grok/scripts/lib/grok.mjs", import.meta.url).pathname;
  const src = fs.readFileSync(GROK_LIB_PATH, "utf8");
  const start = src.indexOf("export function parseGrokJson(");
  assert.ok(start >= 0);
  const slice = src.slice(start, start + 2500);
  assert.match(slice, /findLastJsonObject/,
    "parseGrokJson must use findLastJsonObject in its slow path");
  // Import is at the top.
  assert.match(src, /import\s*\{[^}]*findLastJsonObject[^}]*\}\s*from\s*"\.\/verdict\.mjs"/);
});

test("B4: findLastJsonObject returns the LAST balanced object", () => {
  const obj = findLastJsonObject(`some preface {"a":1} mid {"b":2} end`);
  assert.deepEqual(obj, { b: 2 });
});

test("B4: findLastJsonObject handles mid-string starts gracefully", () => {
  // Simulate the tail-read case where the buffer starts mid-string.
  const tail = `cated string"} prefix {"text":"real envelope","stopReason":"EndTurn"}`;
  const obj = findLastJsonObject(tail);
  assert.equal(obj.text, "real envelope");
  assert.equal(obj.stopReason, "EndTurn");
});

test("B4: findLastJsonObject returns null on empty/null/non-string", () => {
  assert.equal(findLastJsonObject(""), null);
  assert.equal(findLastJsonObject(null), null);
  assert.equal(findLastJsonObject(undefined), null);
  assert.equal(findLastJsonObject(12345), null);
});

test("B4: findLastJsonObject handles pathological N-`{` input in O(n) (Codex round-4 fix)", () => {
  // Synthesize an 8 KiB string of `{` with no `}`. Pre-fix this was
  // O(n²) — each `{` scanned to EOF independently — and would hang for
  // 8 MiB inputs. With the failure cap (128 per call) it must complete
  // quickly even when the wall is enormous. We use 8 KiB here so the
  // test stays fast even on slow CI runners; the algorithmic bound
  // applies regardless of size.
  const pathological = "{".repeat(8 * 1024);
  const t0 = Date.now();
  const result = findLastJsonObject(pathological);
  const dt = Date.now() - t0;
  assert.equal(result, null, "no balanced object exists in a wall of `{` chars");
  assert.ok(dt < 1000, `must complete in < 1s, took ${dt}ms`);
});

test("B4: findLastJsonObject still finds a real envelope hidden after partial noise", () => {
  // The failure-cap fix must NOT break the case where a legitimate
  // envelope follows some partial JSON noise. A few dozen unbalanced
  // fragments are well below the 128-failure cap.
  const noise = Array.from({ length: 16 }, (_, i) => `{partial${i}`).join(" ");
  const input = `${noise} prefix {"text":"real","stopReason":"EndTurn"}`;
  const result = findLastJsonObject(input);
  assert.ok(result, "must still find the real envelope after legitimate noise");
  assert.equal(result.text, "real");
});

// ============================================================================
// B5 — /grok:result bounded reads (Codex finding)
// ============================================================================

test("B5: companion.mjs::cmdResult uses TOCTOU-safe readBoundedJobLog with a cap", () => {
  // v0.5.0 upgraded the bounded read from `readBoundedFile(safePath, cap)` —
  // which had a TOCTOU race between safeJobLogPath and the subsequent
  // fs.openSync — to `readBoundedJobLog(filePath, cwd, cap)` which
  // validates + opens with O_NOFOLLOW + fstats inside one fd. This test
  // asserts cmdResult is on the new API.
  const src = fs.readFileSync(COMPANION_PATH, "utf8");
  const start = src.indexOf("function cmdResult(");
  assert.ok(start >= 0);
  // v1.0.6: cmdResult grew (added no_output diagnostic banner) so the
  // old 2500-byte slice no longer contains the stderr branch. Bumped
  // to 5000 to keep the source-grep stable across reasonable growth.
  const slice = src.slice(start, start + 5000);
  assert.match(slice, /readBoundedJobLog\(meta\.stdout_path,\s*undefined,\s*MAX_REVIEW_JSON_BYTES\)/,
    "cmdResult must use readBoundedJobLog (TOCTOU-safe) for stdout, bounded at MAX_REVIEW_JSON_BYTES");
  assert.match(slice, /readBoundedJobLog\(meta\.stderr_path,\s*undefined,\s*MAX_REVIEW_JSON_BYTES\)/,
    "cmdResult must use readBoundedJobLog (TOCTOU-safe) for stderr, bounded at MAX_REVIEW_JSON_BYTES");
});

test("B5 (v0.5.0): readBoundedJobLog truncates with a marker on oversized files", () => {
  // v0.5.0 moved the bounded-read helper to lib/state.mjs as
  // `readBoundedJobLog` and made it TOCTOU-safe (O_NOFOLLOW + fstat).
  const STATE_LIB = new URL("../plugins/grok/scripts/lib/state.mjs", import.meta.url).pathname;
  const src = fs.readFileSync(STATE_LIB, "utf8");
  assert.match(src, /\[\.\.\. output truncated by grok-plugin/,
    "readBoundedJobLog must include a truncation marker in the returned text");
  // It must also use O_NOFOLLOW (TOCTOU defense).
  assert.match(src, /O_NOFOLLOW/,
    "readBoundedJobLog must open with O_NOFOLLOW to defeat symlink-swap races");
  // And fstat on the fd (not stat on the path).
  assert.match(src, /fs\.fstatSync\(fd\)/,
    "readBoundedJobLog must fstat the opened fd, not stat the path");
});

// ============================================================================
// B6 — /grok:imagine media-path shell-injection defense (Gemini finding)
// ============================================================================

test("B6: companion.mjs validates media path before generating an `open` hint", () => {
  const src = fs.readFileSync(COMPANION_PATH, "utf8");
  assert.match(src, /function isSafeMediaPath\(/);
  assert.match(src, /SAFE_MEDIA_PATH_PATTERN/);
  // The cmdImagine output path must consult isSafeMediaPath BEFORE writing
  // the open command.
  const start = src.indexOf("async function cmdImagine(");
  assert.ok(start >= 0);
  const slice = src.slice(start, start + 5000);
  assert.match(slice, /isSafeMediaPath\(mediaPath\)/);
});

test("B6: isSafeMediaPath regex requires absolute path AND rejects shell metacharacters", () => {
  // Round 4 of review (Gemini) caught a leading-hyphen arg-injection:
  // macOS `open -aTerminal` parses the path as a FLAG (launching
  // Terminal.app), so a returned "path" of `-aTerminal` would have been
  // treated as safe by the previous regex `^[A-Za-z0-9._/\-%@+]+$`.
  // The fix: require the path to start with `/` (absolute), refusing
  // any leading hyphen or alphanumeric-only relative path.
  const SAFE = /^\/[A-Za-z0-9._\/\-%@+]*$/;
  // Legitimate absolute Grok output:
  assert.ok(SAFE.test("/Users/me/.grok/sessions/abc%2Fdef/images/1.jpg"));
  assert.ok(SAFE.test("/tmp/grok-out/video.mp4"));
  // The leading-hyphen attack — must be rejected.
  assert.equal(SAFE.test("-aTerminal"), false,
    "leading hyphen must be rejected (open -aTerminal is an arg-injection vector)");
  assert.equal(SAFE.test("-rf"), false,
    "any leading hyphen must be rejected (-rf, -aFinder, etc)");
  // Other shell-metacharacter attacks — same rejection as before.
  for (const bad of [
    '"; rm -rf ~; #',
    "'\"';rm",
    "/tmp/a;ls",
    "/tmp/a|whoami",
    "/tmp/a$(id)",
    "/tmp/a`id`",
    "/tmp/a\nrm /etc",
    "/tmp/a&background",
    "relative/path.jpg",            // no leading slash → reject
    "Users/me/.grok/img.jpg",       // no leading slash → reject
    "../etc/passwd"                 // no leading slash → reject
  ]) {
    assert.equal(SAFE.test(bad), false, `should reject: ${bad}`);
  }
});

test("B6: companion.mjs::SAFE_MEDIA_PATH_PATTERN matches the absolute-path regex in source", () => {
  const src = fs.readFileSync(COMPANION_PATH, "utf8");
  // The exact pattern must require a leading slash and only the safe
  // character class for the rest. Round-4 fix.
  assert.match(src, /SAFE_MEDIA_PATH_PATTERN = \/\^\\\/\[A-Za-z0-9\._\\\/\\\-%@\+\]\*\$\//);
});

test("B6: imagine output uses `open --` POSIX end-of-options separator", () => {
  // Defense-in-depth alongside the regex: even if the regex ever
  // loosens and lets a leading hyphen through, `open --` ensures macOS
  // `open` parses the next arg as a file path, not a flag.
  // v1.0.2 (issue #5): variable was renamed from mediaPath to displayPath
  // (= savedTo || mediaPath) so --save-to destinations also get the `open`
  // hint. The POSIX `--` guarantee still applies — assert against either
  // variable name.
  const src = fs.readFileSync(COMPANION_PATH, "utf8");
  assert.match(src, /open\s+--\s+"\$\{(?:media|display)Path\}"/,
    "imagine output must use `open -- \"...\"` (POSIX end-of-options)");
});

test("B6 round-5: mediaPath display is gated by isSafeMediaPath (Codex round-5 fix)", () => {
  // Codex round-5 caught that the previous version printed
  // `${noun}: ${mediaPath}\n` BEFORE the isSafeMediaPath check, so a
  // path containing ANSI escapes or newlines leaked straight to the
  // user's terminal. The fix moves the validation BEFORE any output.
  const src = fs.readFileSync(COMPANION_PATH, "utf8");
  const cmdImagineStart = src.indexOf("async function cmdImagine(");
  assert.ok(cmdImagineStart >= 0, "cmdImagine must exist");
  // Find the mediaPath display block.
  const mediaPathBlockStart = src.indexOf("const mediaPath = extractMediaPath(", cmdImagineStart);
  assert.ok(mediaPathBlockStart >= 0);
  const block = src.slice(mediaPathBlockStart, mediaPathBlockStart + 3000);

  // The first .write that mentions `${mediaPath}` (or its JSON-escaped
  // form) must come AFTER `isSafeMediaPath(`. Verify by finding the
  // positions.
  const safeCheckPos = block.indexOf("isSafeMediaPath(mediaPath)");
  // Find any `process.stdout.write(...)` that interpolates mediaPath.
  const rawWritePos = block.search(/process\.stdout\.write\(`[^`]*\$\{mediaPath\}/);
  assert.ok(safeCheckPos >= 0, "isSafeMediaPath(mediaPath) check must exist");
  if (rawWritePos >= 0) {
    assert.ok(rawWritePos > safeCheckPos,
      "Any process.stdout.write that interpolates mediaPath must come AFTER the isSafeMediaPath check (Codex round-5)");
  }
});

test("B6 round-5: unsafe mediaPath is shown JSON-escaped to defang ANSI/newlines", () => {
  // The unsafe-path branch must JSON.stringify the path so terminal
  // control characters render as inert text (e.g. \"\\u001b[2J\").
  // We assert against the whole file since cmdImagine is over 100 lines.
  const src = fs.readFileSync(COMPANION_PATH, "utf8");
  assert.match(src, /JSON\.stringify\(mediaPath\)/,
    "Unsafe mediaPath must be JSON.stringify-ed before display");
  assert.match(src, /UNSAFE PATH/,
    "Unsafe-path display must label the line as unsafe");
});

// ============================================================================
// B7 — review schema/prose alignment + strict validation (Grok finding)
// ============================================================================

test("B7: review prompt severity vocabulary matches the JSON schema", () => {
  const prompt = fs.readFileSync(PROMPT_REVIEW_PATH, "utf8");
  // The four schema severities must each appear in the prompt's finding_bar.
  for (const sev of ["critical", "high", "medium", "low"]) {
    assert.ok(prompt.includes(`**${sev}**`),
      `review prompt must teach the model the **${sev}** severity (matches schema enum)`);
  }
  // The old severities must NOT appear as severity labels.
  for (const oldSev of ["Important", "Nit"]) {
    assert.equal(prompt.includes(`**${oldSev}**`), false,
      `review prompt must not still use the old **${oldSev}** label`);
  }
});

test("B7: strict review-schema validator enforces severity enum on findings", () => {
  // We can't import the private validator, but we can assert the constants
  // it uses are present and complete.
  const src = fs.readFileSync(COMPANION_PATH, "utf8");
  assert.match(src, /const SCHEMA_SEVERITIES = new Set\(\["critical", "high", "medium", "low"\]\)/);
  assert.match(src, /SCHEMA_MAX_STRING_BYTES/);
  assert.match(src, /SCHEMA_MAX_ARRAY_LEN/);
  // The strict validator must be the active export name in the rest of the file.
  assert.match(src, /function validateReviewSchema\(obj\)/);
});

// ============================================================================
// B8 — isAlive EPERM handling (Gemini finding)
// ============================================================================

test("B8: isAlive(pid) treats EPERM as `not our process anymore` (returns false)", () => {
  // We can't easily synthesize an EPERM PID in tests, but we CAN assert
  // the source-level contract: the catch clause for EPERM returns false,
  // not true.
  const src = fs.readFileSync(
    new URL("../plugins/grok/scripts/lib/process.mjs", import.meta.url).pathname,
    "utf8"
  );
  // The fix: the EPERM branch must return false.
  const m = src.match(/if \(e && e\.code === "EPERM"\) return (\w+);/);
  assert.ok(m, "process.mjs must have an EPERM branch in isAlive");
  assert.equal(m[1], "false", `EPERM branch must return false, found return ${m[1]}`);
});

test("B8: isAlive(process.pid) still returns true for our own PID", () => {
  // The normal case stays correct.
  assert.equal(isAlive(process.pid), true);
});

test("B8: isAlive rejects PID 0 and PID 1 (regression)", () => {
  // These are not new but pinning them keeps the safety guard.
  assert.equal(isAlive(0), false);
  assert.equal(isAlive(1), false);
});
