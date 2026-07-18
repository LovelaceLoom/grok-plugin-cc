// v0.9.3 — REAL grok-binary smoke tests.
//
// All tests in this file are SKIPPED unless `GROK_INTEGRATION_TEST=1`
// is set in the environment. The other ~320 tests in the suite use
// fake-grok stubs because:
//   - Speed: 320 fake-grok tests run in 3s; real grok would take
//     several minutes (one network round-trip per call).
//   - Cost: each real grok call burns xAI tokens (~$0.01-$0.10).
//   - Determinism: real grok output varies; fake stubs are exact.
//   - Auth-free: CI without xAI credentials can still run the suite.
//   - Correctness scope: those tests verify that the plugin BUILDS
//     the right argv. Whether grok itself does the right thing with
//     that argv is xAI's responsibility.
//
// What this file is for: catching upstream drift. If xAI renames
// `--max-turns` to `--turn-limit`, every fake-grok test still passes,
// but `grok --help` won't expose the renamed flag and any user who
// runs /grok:setup or /grok:ask will see a "unknown option" stderr.
// One smoke test against real grok catches that class of failure.
//
// Required setup:
//   - `grok` on PATH
//   - Authenticated (run `grok login` or set XAI_API_KEY)
//   - GROK_INTEGRATION_TEST=1 in env
//
// CI pattern (e.g., a nightly workflow):
//   GROK_INTEGRATION_TEST=1 XAI_API_KEY=$SECRET npm test

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const COMPANION = path.resolve(__dirname, "../plugins/grok/scripts/companion.mjs");
const ENABLED = process.env.GROK_INTEGRATION_TEST === "1";
const SKIP_REASON = "Skipped: set GROK_INTEGRATION_TEST=1 to run real-grok smoke tests";

function whichGrok() {
  const r = spawnSync("which", ["grok"], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : null;
}

test("integration: `grok --version` runs and reports a version", { skip: !ENABLED && SKIP_REASON }, () => {
  if (!whichGrok()) assert.fail("grok not on PATH");
  const r = spawnSync("grok", ["--version"], { encoding: "utf8", timeout: 30_000 });
  assert.equal(r.status, 0, `grok --version exited ${r.status}: ${r.stderr}`);
  // grok 0.x.y format
  assert.match(r.stdout, /grok\s+\d+\.\d+\.\d+/);
});

test("integration: capabilityProbe required flags ALL appear in `grok --help`", { skip: !ENABLED && SKIP_REASON }, async () => {
  if (!whichGrok()) assert.fail("grok not on PATH");
  // Same exact check capabilityProbe does internally.
  const { capabilityProbe } = await import("../plugins/grok/scripts/lib/grok.mjs");
  const result = capabilityProbe();
  assert.equal(result.ok, true,
    `capabilityProbe failed; missing: ${(result.missing || []).join(", ")}\n` +
    `This means xAI renamed/removed a flag the plugin depends on. ` +
    `Update plugins/grok/scripts/lib/grok.mjs's capabilityProbe required list.`);
});

test("integration: /grok:setup --json reports either 'ready' or actionable nextSteps", { skip: !ENABLED && SKIP_REASON }, () => {
  if (!whichGrok()) assert.fail("grok not on PATH");
  const r = spawnSync(process.execPath, [COMPANION, "setup", "--json"], {
    encoding: "utf8",
    timeout: 60_000
  });
  // v0.9.4 (Codex P2 #1 round-4): cmdSetup intentionally exits 1 when
  // not ready (a CI-meaningful signal that something needs attention)
  // while still emitting actionable JSON. The test must accept BOTH
  // status === 0 (fully ready) AND status === 1 (not-ready-but-actionable).
  // It only fails if the JSON is malformed or missing nextSteps in the
  // not-ready case.
  assert.ok(r.status === 0 || r.status === 1,
    `setup --json exited ${r.status} (expected 0 ready or 1 not-ready): ${r.stderr}`);
  let parsed;
  try { parsed = JSON.parse(r.stdout); }
  catch (e) { assert.fail(`setup --json output was not parseable JSON: ${r.stdout.slice(0, 200)}`); }
  // Either auth is configured and we're ready, OR we get an actionable
  // hint. The plugin must never silently say "we don't know what's wrong."
  if (!parsed.ready) {
    assert.ok(Array.isArray(parsed.nextSteps) && parsed.nextSteps.length > 0,
      `setup not ready but produced no nextSteps array — UX regression. Output:\n${r.stdout}`);
  }
});

test("integration: /grok:inspect surfaces non-empty config", { skip: !ENABLED && SKIP_REASON }, () => {
  if (!whichGrok()) assert.fail("grok not on PATH");
  const r = spawnSync(process.execPath, [COMPANION, "inspect"], {
    encoding: "utf8",
    timeout: 60_000
  });
  // grok inspect can exit non-zero in some configurations (no AGENTS.md,
  // no skills, etc.); we just need either real output OR a clear error.
  // v0.9.4 (Codex P2 #2 + Gemini Important round-4): the error message
  // can come on STDERR too. The previous version only checked stdout.
  if (r.status !== 0 && !r.stdout && !r.stderr) {
    assert.fail("/grok:inspect failed with no output to stdout or stderr");
  }
  // If we did get output, it should have at least the standard sections.
  // (Tolerate format changes — only assert that the output isn't empty.)
  if (r.status === 0) {
    assert.ok(r.stdout.length > 0, "inspect output should not be empty when status === 0");
  }
});

test("integration: /grok:ask with a trivial prompt returns an answer", { skip: !ENABLED && SKIP_REASON, timeout: 120_000 }, () => {
  if (!whichGrok()) assert.fail("grok not on PATH");
  // The cheapest realistic test: ask grok to repeat a token. Costs
  // ~1¢ per run; uses ~50 tokens total. Verifies the full plugin →
  // grok → xAI → response → plugin → stdout pipeline.
  const sentinel = `INTEG_${Date.now()}`;
  const r = spawnSync(process.execPath, [COMPANION, "ask", `Reply with exactly: ${sentinel}`], {
    encoding: "utf8",
    timeout: 90_000
  });
  // If the user isn't authed, the plugin should still surface a clear
  // hint (we tested that in "setup --json" above). Here we accept either
  // a successful response OR a hint.
  if (r.status === 0) {
    assert.ok(r.stdout.includes(sentinel),
      `/grok:ask success path didn't echo the sentinel. Got:\n${r.stdout}`);
  } else {
    assert.match((r.stderr || ""), /(hint:|auth|setup)/i,
      `/grok:ask non-zero exit must produce an actionable hint. Got stderr:\n${r.stderr}`);
  }
});
