// v1.2.0 Phase 2b — live streaming (research --stream).
//
// createStreamingJsonParser turns Grok's `--output-format streaming-json`
// NDJSON event stream into live text deltas + a final result, tolerant of
// chunk boundaries splitting a line mid-way.

import { test } from "node:test";
import assert from "node:assert/strict";

import { createStreamingJsonParser, grokBaseArgs } from "../plugins/grok/scripts/lib/grok.mjs";

test("grokBaseArgs selects streaming-json output when streamingJson is set", () => {
  const args = grokBaseArgs({ jsonOutput: true, streamingJson: true });
  const i = args.indexOf("--output-format");
  assert.ok(i >= 0 && args[i + 1] === "streaming-json");
});

test("grokBaseArgs still selects json output by default", () => {
  const args = grokBaseArgs({ jsonOutput: true });
  const i = args.indexOf("--output-format");
  assert.equal(args[i + 1], "json");
});

test("streaming parser emits text deltas in order and accumulates the full text", () => {
  const deltas = [];
  const p = createStreamingJsonParser({ onText: d => deltas.push(d) });
  p.push('{"type":"text","data":"Hello"}\n');
  p.push('{"type":"thought","data":"thinking"}\n');
  p.push('{"type":"text","data":" world"}\n');
  p.push('{"type":"end","stopReason":"EndTurn","sessionId":"s9"}\n');
  p.end();
  assert.deepEqual(deltas, ["Hello", " world"]);
  const r = p.result();
  assert.equal(r.kind, "text");
  assert.equal(r.text, "Hello world");
  assert.equal(r.sessionId, "s9");
  assert.equal(r.sawEnd, true);
});

test("streaming parser tolerates a line split across two chunks", () => {
  const deltas = [];
  const p = createStreamingJsonParser({ onText: d => deltas.push(d) });
  p.push('{"type":"text","da');         // mid-line boundary
  p.push('ta":"chunked"}\n');
  p.end();
  assert.deepEqual(deltas, ["chunked"]);
  assert.equal(p.result().text, "chunked");
});

test("streaming parser handles a final line with no trailing newline via end()", () => {
  const p = createStreamingJsonParser();
  p.push('{"type":"text","data":"tail"}');   // no newline
  p.end();
  assert.equal(p.result().text, "tail");
});

test("streaming parser surfaces an error event", () => {
  let errMsg = null;
  const p = createStreamingJsonParser({ onError: m => { errMsg = m; } });
  p.push('{"type":"text","data":"partial"}\n');
  p.push('{"type":"error","message":"boom"}\n');
  p.end();
  assert.equal(errMsg, "boom");
  const r = p.result();
  assert.equal(r.kind, "error");
  assert.equal(r.message, "boom");
});

test("streaming parser ignores non-JSON noise lines (Rust tracing leakage)", () => {
  const deltas = [];
  const p = createStreamingJsonParser({ onText: d => deltas.push(d) });
  p.push('INFO some rust tracing line\n');
  p.push('{"type":"text","data":"ok"}\n');
  p.end();
  assert.deepEqual(deltas, ["ok"]);
});
