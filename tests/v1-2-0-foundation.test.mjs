// v1.2.0 Phase 0 — foundation: CLI 0.2.22 compat + bug fixes.
//
// Covers:
//   - XAI_API_KEY env passthrough (0.2.22 renamed the API-key var; the old
//     allowlist silently filtered the documented variable).
//   - GROK_TELEMETRY_ENABLED replaces the non-existent GROK_DISABLE_TELEMETRY.
//   - cleanGrokEnv(parent, overrides) — allowlisted overrides (web_fetch wiring).
//   - detectAuthSource / classifyAuthBlob recognise XAI_API_KEY.
//   - parseGrokJson tolerates streaming-json (NDJSON) output.
//   - capabilityProbe required-flag list is exported and includes the new flags.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  cleanGrokEnv,
  detectAuthSource,
  classifyAuthBlob,
  parseGrokJson,
  CAPABILITY_REQUIRED_FLAGS
} from "../plugins/grok/scripts/lib/grok.mjs";

// ---------- XAI_API_KEY ----------

test("cleanGrokEnv keeps XAI_API_KEY (0.2.22 documented API-key var)", () => {
  const out = cleanGrokEnv({ XAI_API_KEY: "xai-abc123" });
  assert.equal(out.XAI_API_KEY, "xai-abc123");
});

test("cleanGrokEnv still keeps the legacy GROK_CODE_XAI_API_KEY fallback", () => {
  const out = cleanGrokEnv({ GROK_CODE_XAI_API_KEY: "xai-legacy" });
  assert.equal(out.GROK_CODE_XAI_API_KEY, "xai-legacy");
});

// ---------- telemetry env rename ----------

test("cleanGrokEnv keeps GROK_TELEMETRY_ENABLED (the real 0.2.22 var)", () => {
  const out = cleanGrokEnv({ GROK_TELEMETRY_ENABLED: "0" });
  assert.equal(out.GROK_TELEMETRY_ENABLED, "0");
});

test("cleanGrokEnv drops the obsolete GROK_DISABLE_TELEMETRY", () => {
  const out = cleanGrokEnv({ GROK_DISABLE_TELEMETRY: "1" });
  assert.equal(out.GROK_DISABLE_TELEMETRY, undefined);
});

// ---------- cleanGrokEnv overrides (web_fetch wiring) ----------

test("cleanGrokEnv applies an allowlisted override", () => {
  const out = cleanGrokEnv({ PATH: "/usr/bin" }, { GROK_WEB_FETCH: "1" });
  assert.equal(out.GROK_WEB_FETCH, "1");
  assert.equal(out.PATH, "/usr/bin");
});

test("cleanGrokEnv override beats a parent value", () => {
  const out = cleanGrokEnv({ GROK_WEB_FETCH: "0" }, { GROK_WEB_FETCH: "1" });
  assert.equal(out.GROK_WEB_FETCH, "1");
});

test("cleanGrokEnv refuses a non-allowlisted override (no security bypass)", () => {
  const out = cleanGrokEnv({}, { ANTHROPIC_API_KEY: "leak", NODE_OPTIONS: "--require=/tmp/x.js" });
  assert.equal(out.ANTHROPIC_API_KEY, undefined);
  assert.equal(out.NODE_OPTIONS, undefined);
});

test("cleanGrokEnv ignores non-string override values", () => {
  const out = cleanGrokEnv({}, { GROK_WEB_FETCH: 1 });
  assert.equal(out.GROK_WEB_FETCH, undefined);
});

// ---------- detectAuthSource ----------

test("detectAuthSource reports XAI_API_KEY first", () => {
  const saved = {
    XAI_API_KEY: process.env.XAI_API_KEY,
    GROK_CODE_XAI_API_KEY: process.env.GROK_CODE_XAI_API_KEY
  };
  process.env.XAI_API_KEY = "xai-x";
  process.env.GROK_CODE_XAI_API_KEY = "xai-legacy";
  try {
    assert.equal(detectAuthSource(), "XAI_API_KEY env");
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

// ---------- classifyAuthBlob ----------

test("classifyAuthBlob recognises an XAI_API_KEY hint as missing auth", () => {
  assert.equal(
    classifyAuthBlob("error: set XAI_API_KEY or run grok login"),
    "no auth method configured"
  );
});

// ---------- parseGrokJson streaming-json (NDJSON) ----------

test("parseGrokJson reconstructs streaming-json into text + session", () => {
  const ndjson = [
    '{"type":"text","data":"Here\'s"}',
    '{"type":"text","data":" a summary"}',
    '{"type":"thought","data":"Analyzing the directory structure..."}',
    '{"type":"end","stopReason":"EndTurn","sessionId":"abc123","requestId":"xyz789"}'
  ].join("\n");
  const r = parseGrokJson(ndjson);
  assert.equal(r.kind, "text");
  assert.equal(r.text, "Here's a summary");
  assert.equal(r.sessionId, "abc123");
  assert.equal(r.stopReason, "EndTurn");
});

test("parseGrokJson surfaces a streaming-json error event", () => {
  const ndjson = [
    '{"type":"text","data":"partial"}',
    '{"type":"error","message":"model overloaded"}'
  ].join("\n");
  const r = parseGrokJson(ndjson);
  assert.equal(r.kind, "error");
  assert.equal(r.message, "model overloaded");
});

test("parseGrokJson still parses a single json envelope (regression)", () => {
  const r = parseGrokJson('{"text":"hello","stopReason":"EndTurn","sessionId":"s1"}');
  assert.equal(r.kind, "text");
  assert.equal(r.text, "hello");
  assert.equal(r.sessionId, "s1");
});

test("parseGrokJson recovers an envelope buried under a noisy tracing line", () => {
  const noisy = 'INFO grok::tracing some rust log line\n{"text":"clean","stopReason":"EndTurn"}';
  const r = parseGrokJson(noisy);
  assert.equal(r.kind, "text");
  assert.equal(r.text, "clean");
});

// ---------- capabilityProbe exported required flags ----------

test("CAPABILITY_REQUIRED_FLAGS includes the new --agents and --prompt-json flags", () => {
  assert.ok(Array.isArray(CAPABILITY_REQUIRED_FLAGS));
  assert.ok(CAPABILITY_REQUIRED_FLAGS.includes("--agents"));
  assert.ok(CAPABILITY_REQUIRED_FLAGS.includes("--prompt-json"));
});

test("CAPABILITY_REQUIRED_FLAGS still includes the pre-existing core flags", () => {
  for (const tok of ["-p, --single", "-m, --model", "--output-format", "--effort"]) {
    assert.ok(CAPABILITY_REQUIRED_FLAGS.includes(tok), `missing ${tok}`);
  }
});
