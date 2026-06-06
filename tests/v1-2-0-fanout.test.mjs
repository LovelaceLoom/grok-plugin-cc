// v1.2.0 Phase 1 — fan-out (multi-angle, single-call Grok analysis).
//
// Two mechanisms:
//   - DEFAULT: instruct Grok (via the prompt) to dispatch several built-in
//     personas through its `task` tool in parallel, then synthesize. No custom
//     schema — uses Grok's documented personas (researcher / reviewer /
//     security-auditor / test-writer / ...).
//   - ADVANCED: a validated `--agents <JSON>` passthrough for custom inline
//     subagent definitions. The plugin enforces a safety envelope (count cap,
//     name sanity, control-byte scrub, total-size cap); Grok validates the
//     field schema itself.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  FANOUT_PERSONAS,
  DEFAULT_FANOUT_PERSONAS,
  MAX_FANOUT_AGENTS,
  validatePersonas,
  validateAgentsJson,
  buildFanOutPrompt,
  grokBaseArgs
} from "../plugins/grok/scripts/lib/grok.mjs";

// ---------- persona allow-set ----------

test("DEFAULT_FANOUT_PERSONAS are all members of the FANOUT_PERSONAS allow-set", () => {
  for (const p of DEFAULT_FANOUT_PERSONAS) {
    assert.ok(FANOUT_PERSONAS.has(p), `default persona ${p} not in allow-set`);
  }
  assert.ok(DEFAULT_FANOUT_PERSONAS.length >= 3);
});

test("validatePersonas defaults to DEFAULT_FANOUT_PERSONAS when omitted", () => {
  assert.deepEqual(validatePersonas(undefined), DEFAULT_FANOUT_PERSONAS);
  assert.deepEqual(validatePersonas(null), DEFAULT_FANOUT_PERSONAS);
});

test("validatePersonas accepts a CSV subset of built-ins", () => {
  assert.deepEqual(validatePersonas("reviewer,security-auditor"), ["reviewer", "security-auditor"]);
});

test("validatePersonas accepts an array and de-dupes", () => {
  assert.deepEqual(validatePersonas(["reviewer", "reviewer", "researcher"]), ["reviewer", "researcher"]);
});

test("validatePersonas rejects an unknown persona", () => {
  assert.throws(() => validatePersonas("not-a-real-persona"), /persona/i);
});

test("validatePersonas rejects more than MAX_FANOUT_AGENTS", () => {
  const many = Array.from({ length: MAX_FANOUT_AGENTS + 1 }, (_, i) => `p${i}`);
  assert.throws(() => validatePersonas(many), /too many|max/i);
});

// ---------- validateAgentsJson (custom --agents passthrough) ----------

test("validateAgentsJson accepts a valid array string and returns names + canonical json", () => {
  const input = '[{"name":"sec","description":"security","promptBody":"audit it"}]';
  const out = validateAgentsJson(input);
  assert.deepEqual(out.names, ["sec"]);
  const reparsed = JSON.parse(out.json);
  assert.equal(reparsed[0].name, "sec");
});

test("validateAgentsJson accepts an already-parsed array", () => {
  const out = validateAgentsJson([{ name: "a", description: "d", promptBody: "p" }]);
  assert.deepEqual(out.names, ["a"]);
});

test("validateAgentsJson rejects invalid JSON", () => {
  assert.throws(() => validateAgentsJson("{not json"), /JSON/i);
});

test("validateAgentsJson rejects a non-array", () => {
  assert.throws(() => validateAgentsJson('{"name":"x"}'), /array/i);
});

test("validateAgentsJson rejects an empty array", () => {
  assert.throws(() => validateAgentsJson("[]"), /empty|at least/i);
});

test("validateAgentsJson rejects an element without a name", () => {
  assert.throws(() => validateAgentsJson('[{"description":"no name"}]'), /name/i);
});

test("validateAgentsJson rejects a name with a path separator", () => {
  assert.throws(() => validateAgentsJson('[{"name":"../etc","description":"x"}]'), /name/i);
});

test("validateAgentsJson rejects a name containing control bytes", () => {
  assert.throws(() => validateAgentsJson('[{"name":"a\\u0007b","description":"x"}]'), /control|name/i);
});

test("validateAgentsJson allows newlines inside a prompt body but rejects a BEL control byte", () => {
  // newline OK
  const ok = validateAgentsJson([{ name: "a", description: "d", promptBody: "line1\nline2" }]);
  assert.equal(JSON.parse(ok.json)[0].promptBody, "line1\nline2");
  // BEL (0x07) anywhere in a string is rejected
  assert.throws(() => validateAgentsJson([{ name: "a", description: "d", promptBody: "xy" }]), /control/i);
});

test("validateAgentsJson enforces the agent-count cap", () => {
  const many = Array.from({ length: MAX_FANOUT_AGENTS + 1 }, (_, i) => ({ name: `a${i}`, description: "d" }));
  assert.throws(() => validateAgentsJson(many), /too many|max/i);
});

test("validateAgentsJson enforces a total-size cap (ARG_MAX defense)", () => {
  const huge = [{ name: "a", description: "x".repeat(200000) }];
  assert.throws(() => validateAgentsJson(huge), /too large|size/i);
});

test("validateAgentsJson rejects pathologically deep nesting with a clear error (not a RangeError)", () => {
  // ~5000 levels is only ~10KB of JSON — under the size cap — but unbounded
  // recursion would blow the stack. Must surface a clean validation error.
  let deep = "x";
  for (let i = 0; i < 5000; i++) deep = [deep];
  assert.throws(
    () => validateAgentsJson([{ name: "a", description: "d", extra: deep }]),
    (e) => e instanceof Error && /deep|nest/i.test(e.message) && !(e instanceof RangeError)
  );
});

// ---------- grokBaseArgs agents wiring ----------

test("grokBaseArgs emits --agents with canonical JSON when agents are supplied", () => {
  const args = grokBaseArgs({ agents: [{ name: "sec", description: "d", promptBody: "p" }] });
  const idx = args.indexOf("--agents");
  assert.ok(idx >= 0, "expected --agents in argv");
  const json = args[idx + 1];
  const parsed = JSON.parse(json);
  assert.equal(parsed[0].name, "sec");
});

test("grokBaseArgs omits --agents when none supplied", () => {
  const args = grokBaseArgs({});
  assert.equal(args.includes("--agents"), false);
});

test("grokBaseArgs throws on invalid agents (propagated from validateAgentsJson)", () => {
  assert.throws(() => grokBaseArgs({ agents: "[]" }), /empty|at least/i);
});

// ---------- buildFanOutPrompt ----------

test("buildFanOutPrompt (persona mode) lists every persona and the task and demands synthesis", () => {
  const p = buildFanOutPrompt("Audit auth.js for bugs", { personas: ["reviewer", "security-auditor"] });
  assert.match(p, /reviewer/);
  assert.match(p, /security-auditor/);
  assert.match(p, /Audit auth\.js for bugs/);
  assert.match(p, /parallel/i);
  assert.match(p, /synthesi/i);
});

test("buildFanOutPrompt (custom-agents mode) references the custom agent names", () => {
  const p = buildFanOutPrompt("Review the diff", { agentNames: ["alpha", "beta"] });
  assert.match(p, /alpha/);
  assert.match(p, /beta/);
  assert.match(p, /Review the diff/);
});
