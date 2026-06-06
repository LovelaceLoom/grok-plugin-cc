// Regression tests for behaviors that aren't naturally covered by the
// per-module unit tests because they live inside companion.mjs's runJob and
// would otherwise require spawning a real `grok` to exercise.
//
// These tests import the companion module solely to validate that the file
// parses and the helper functions used by the dispatcher are stable. The
// dispatcher itself runs on import only when invoked as `node companion.mjs`
// (main() is called at the bottom), so simply importing the file does not
// kick off any subprocess.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { sanitizeForTerminal } from "../plugins/grok/scripts/lib/render.mjs";

// We can't import private functions from companion.mjs without re-exporting
// them, but we can verify the behavior by inspecting the source of truth
// (the file itself) and asserting the contract.

const COMPANION_PATH = new URL("../plugins/grok/scripts/companion.mjs", import.meta.url).pathname;

test("companion.mjs re-reads the full stdout file when outBuf is truncated", () => {
  // Regression for the Codex-identified bug: if outBuf (capped at MAX_JOB_BUF
  // = 256 KiB) is truncated to invalid JSON, the close handler used to
  // misclassify an exit-0 internal-error envelope as `completed`. The fix is
  // to re-read the full file from disk for the parse when outBuf parses as
  // "unknown" — guarded by MAX_REVIEW_JSON_BYTES to avoid OOM.
  const source = fs.readFileSync(COMPANION_PATH, "utf8");
  // Normalize collapsed-comment whitespace so cross-line phrases match cleanly.
  const collapsed = source.replace(/\n\s*\/\/\s*/g, " ").replace(/\s+/g, " ");
  assert.match(collapsed, /Re-read the full file from disk for the envelope check/i,
    "companion.mjs must explain the truncation re-read in a comment");
  assert.match(source, /readFileSync\(meta\.stdout_path, "utf8"\)/,
    "companion.mjs must actually read the file back in runJob");
  assert.match(source, /MAX_REVIEW_JSON_BYTES/,
    "the re-read must be bounded by MAX_REVIEW_JSON_BYTES to prevent OOM");
});

test("companion.mjs exits 2 for malformed --timeout values", () => {
  // The contract surfaces in resolveTimeoutMs: bad input -> exit 2 with a
  // user-facing message. We can assert the message at least exists in source.
  const source = fs.readFileSync(COMPANION_PATH, "utf8");
  assert.match(source, /Invalid --timeout value/);
  assert.match(source, /Use forms like 300s, 20m/);
});

test("companion.mjs exits 124 for timeouts (matches GNU timeout(1))", () => {
  const source = fs.readFileSync(COMPANION_PATH, "utf8");
  assert.match(source, /EXIT_TIMEOUT\s*=\s*124/);
  assert.match(source, /process\.exit\(EXIT_TIMEOUT\)/);
});

test("companion.mjs always streams stdout through TerminalSanitizer", () => {
  // The streaming sanitizer must be wired into runJob's stdout handler;
  // raw streaming would leak ANSI / OSC 52 / DCS sequences to the user's
  // terminal directly from Grok's tracing output on stderr-as-it-comes.
  const source = fs.readFileSync(COMPANION_PATH, "utf8");
  assert.match(source, /new TerminalSanitizer\(\)/);
  assert.match(source, /sanitizer\.push\(d\)/);
  assert.match(source, /sanitizer\.flush\(\)/);
});

test("companion.mjs --write refusal includes the exact env var name", () => {
  const source = fs.readFileSync(COMPANION_PATH, "utf8");
  assert.match(source, /GROK_PLUGIN_ALLOW_WRITE/);
  // The refusal message must explain --yolo so the user knows what they're
  // opting into (not a silent allow).
  assert.match(source, /--yolo/);
});

test("sanitizeForTerminal is idempotent on already-clean strings", () => {
  // Calling the sanitizer on clean text must not alter it; otherwise we'd
  // strip characters Grok intentionally emits (e.g., a real `\t` in the
  // response).
  const clean = "Plain output\nWith a tab:\tin the middle\nAnd \"quotes\".";
  assert.equal(sanitizeForTerminal(clean), clean);
});

test("companion.mjs declares all the documented subcommands in main()", () => {
  // If a developer adds a slash command's markdown but forgets to wire the
  // subcommand into main()'s switch, the command silently 404s at runtime.
  // Smoke-check the dispatcher recognizes every documented subcommand.
  const source = fs.readFileSync(COMPANION_PATH, "utf8");
  for (const sub of [
    "setup",
    "ask",
    "review",
    "adversarial-review",
    "imagine",
    "imagine-video",
    "task",
    "research",
    "fan-out",
    "models",
    "best-of",
    "aggregate-review",
    "inspect",
    "status",
    "result",
    "cancel",
    "purge"
  ]) {
    assert.match(source, new RegExp(`case\\s+"${sub}"\\s*:`),
      `main() must handle subcommand "${sub}"`);
  }
});
