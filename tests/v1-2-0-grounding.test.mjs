// v1.2.0 Phase 2 — grounding + context levers.
//
// web_fetch: Grok's web_fetch tool is OFF unless GROK_WEB_FETCH=1. The plugin
// turns it ON by default for research / ask / fan-out (grounding is Grok's
// differentiator), while respecting an explicit user env value and an explicit
// --no-web-fetch opt-out.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  webFetchEnvOverride,
  cleanGrokEnv,
  grokBaseArgs
} from "../plugins/grok/scripts/lib/grok.mjs";

test("webFetchEnvOverride defaults web_fetch ON when nothing is set", () => {
  assert.deepEqual(webFetchEnvOverride({ parentEnv: {} }), { GROK_WEB_FETCH: "1" });
});

test("webFetchEnvOverride honours an explicit --no-web-fetch opt-out", () => {
  assert.deepEqual(webFetchEnvOverride({ noWebFetch: true, parentEnv: {} }), { GROK_WEB_FETCH: "0" });
});

test("webFetchEnvOverride respects a user-set GROK_WEB_FETCH (no override)", () => {
  assert.deepEqual(webFetchEnvOverride({ parentEnv: { GROK_WEB_FETCH: "0" } }), {});
  assert.deepEqual(webFetchEnvOverride({ parentEnv: { GROK_WEB_FETCH: "1" } }), {});
});

test("webFetchEnvOverride output flows through cleanGrokEnv as an allowlisted override", () => {
  const env = cleanGrokEnv({ PATH: "/usr/bin" }, webFetchEnvOverride({ parentEnv: {} }));
  assert.equal(env.GROK_WEB_FETCH, "1");
});

// ---------- compaction passthrough ----------

test("grokBaseArgs emits --compaction-mode / --compaction-detail when supplied", () => {
  const args = grokBaseArgs({ compactionMode: "segments", compactionDetail: "balanced" });
  const mi = args.indexOf("--compaction-mode");
  const di = args.indexOf("--compaction-detail");
  assert.ok(mi >= 0 && args[mi + 1] === "segments");
  assert.ok(di >= 0 && args[di + 1] === "balanced");
});

test("grokBaseArgs rejects an invalid --compaction-mode", () => {
  assert.throws(() => grokBaseArgs({ compactionMode: "bogus" }), /compaction-mode/i);
});

test("grokBaseArgs rejects an invalid --compaction-detail", () => {
  assert.throws(() => grokBaseArgs({ compactionDetail: "bogus" }), /compaction-detail/i);
});

test("grokBaseArgs omits compaction flags when not supplied", () => {
  const args = grokBaseArgs({});
  assert.equal(args.includes("--compaction-mode"), false);
  assert.equal(args.includes("--compaction-detail"), false);
});
