// v1.1.0 — Codex CLI support.
//
// Codex CLI (openai/codex 0.130+) supports a plugin marketplace whose
// schema is intentionally close to Claude Code's. Codex also sets
// CLAUDE_PLUGIN_ROOT (and PLUGIN_ROOT) for backward-compatibility with
// CC plugins, so commands/*.md, agents/*.md, hooks/hooks.json, and
// scripts/companion.mjs all run unchanged under Codex.
//
// v1.1.0 adds the manifest and skill metadata that make grok-plugin-cc
// **discoverable** by Codex's marketplace + skill router:
//
//   1. `.agents/plugins/marketplace.json` at repo root — Codex's
//      marketplace schema (different from CC's
//      `.claude-plugin/marketplace.json`). Required for
//      `codex plugin marketplace add LovelaceLoom/grok-plugin-cc`.
//
//   2. `plugins/grok/.codex-plugin/plugin.json` — Codex-native plugin
//      manifest with an `interface` block (displayName, category,
//      capabilities, defaultPrompt) so the Codex TUI surfaces the
//      plugin properly. The CC manifest at
//      `plugins/grok/.claude-plugin/plugin.json` is unchanged.
//
//   3. Four user-facing skills under `plugins/grok/skills/`:
//        - grok-ask/SKILL.md
//        - grok-research/SKILL.md
//        - grok-imagine/SKILL.md
//        - grok-rescue/SKILL.md
//      Each has a model-oriented description so Codex's (and CC's)
//      skill router auto-invokes them at the right time. All four
//      shell out to the same scripts/companion.mjs.
//
// This file pins those structural guarantees so they don't regress.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const CODEX_MARKET = path.join(REPO_ROOT, ".agents", "plugins", "marketplace.json");
const CODEX_PLUGIN = path.join(REPO_ROOT, "plugins", "grok", ".codex-plugin", "plugin.json");
const CC_PLUGIN = path.join(REPO_ROOT, "plugins", "grok", ".claude-plugin", "plugin.json");
const CC_MARKET = path.join(REPO_ROOT, ".claude-plugin", "marketplace.json");
const PKG_JSON = path.join(REPO_ROOT, "package.json");
const SKILLS_DIR = path.join(REPO_ROOT, "plugins", "grok", "skills");

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function readFrontmatter(p) {
  const src = fs.readFileSync(p, "utf8");
  const m = src.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return null;
  const fm = {};
  for (const line of m[1].split("\n")) {
    const kv = line.match(/^([\w-]+):\s*(.*)$/);
    if (kv) fm[kv[1]] = kv[2].trim();
  }
  return fm;
}

test("v1.1.0: .agents/plugins/marketplace.json exists and parses", () => {
  assert.ok(fs.existsSync(CODEX_MARKET), `Codex marketplace manifest missing at ${CODEX_MARKET}`);
  const m = readJson(CODEX_MARKET);
  assert.equal(m.name, "grok-plugin-cc");
  assert.ok(m.interface && typeof m.interface.displayName === "string", "marketplace must declare interface.displayName");
  assert.ok(Array.isArray(m.plugins) && m.plugins.length >= 1, "marketplace must list at least one plugin");
  const grok = m.plugins.find((p) => p.name === "grok");
  assert.ok(grok, "marketplace must include the 'grok' plugin entry");
  assert.equal(grok.source?.source, "local");
  assert.equal(grok.source?.path, "./plugins/grok");
  assert.ok(grok.policy && grok.policy.installation === "AVAILABLE", "plugin policy.installation must be AVAILABLE");
});

test("v1.1.0: .codex-plugin/plugin.json exists with required interface block", () => {
  assert.ok(fs.existsSync(CODEX_PLUGIN), `Codex plugin manifest missing at ${CODEX_PLUGIN}`);
  const m = readJson(CODEX_PLUGIN);
  assert.equal(m.name, "grok");
  assert.ok(typeof m.version === "string" && /^\d+\.\d+\.\d+/.test(m.version), "version must be semver");
  assert.ok(m.interface, "Codex plugin must have an interface block");
  assert.ok(typeof m.interface.displayName === "string", "interface.displayName required");
  assert.ok(typeof m.interface.shortDescription === "string", "interface.shortDescription required");
  assert.ok(typeof m.interface.category === "string", "interface.category required");
  assert.ok(Array.isArray(m.interface.capabilities) && m.interface.capabilities.length >= 1, "interface.capabilities must be non-empty array");
  assert.equal(m.skills, "./skills/", "plugin.json must point skills field at ./skills/");
});

test("v1.1.0: Codex + CC plugin.json versions are kept in lockstep", () => {
  const codex = readJson(CODEX_PLUGIN);
  const cc = readJson(CC_PLUGIN);
  const ccMarket = readJson(CC_MARKET);
  const pkg = readJson(PKG_JSON);
  assert.equal(codex.version, cc.version, ".codex-plugin and .claude-plugin plugin.json versions must match");
  assert.equal(cc.version, pkg.version, "plugin.json and package.json versions must match");
  assert.equal(ccMarket.metadata?.version, pkg.version, "CC marketplace metadata.version must match package.json");
  assert.equal(ccMarket.plugins?.[0]?.version, pkg.version, "CC marketplace plugins[0].version must match package.json");
});

test("v1.1.0: 4 user-facing Codex skills exist with proper frontmatter", () => {
  const expected = ["grok-ask", "grok-research", "grok-imagine", "grok-rescue"];
  for (const name of expected) {
    const skillFile = path.join(SKILLS_DIR, name, "SKILL.md");
    assert.ok(fs.existsSync(skillFile), `expected skill ${name} at ${skillFile}`);
    const fm = readFrontmatter(skillFile);
    assert.ok(fm, `skill ${name} missing YAML frontmatter`);
    assert.equal(fm.name, name, `skill ${name} frontmatter name mismatch`);
    assert.ok(fm.description && fm.description.length >= 60, `skill ${name} description too short — needs ≥60 chars so the LLM router can match intent`);
    // user-invocable: not set, default true. Internal skills should explicitly set false.
    assert.notEqual(fm["user-invocable"], "false", `skill ${name} must be user-invocable (not internal)`);
  }
});

test("v1.1.0: user-facing skills all reference CLAUDE_PLUGIN_ROOT/scripts/companion.mjs", () => {
  // Codex sets CLAUDE_PLUGIN_ROOT for CC-compat, so the same env var works
  // in both hosts. If a future PR switches to a host-specific var, it must
  // also update this test.
  const skills = ["grok-ask", "grok-research", "grok-imagine", "grok-rescue", "grok-fan-out"];
  for (const name of skills) {
    const skillFile = path.join(SKILLS_DIR, name, "SKILL.md");
    const src = fs.readFileSync(skillFile, "utf8");
    assert.match(src, /CLAUDE_PLUGIN_ROOT.*scripts\/companion\.mjs/, `skill ${name} must reference CLAUDE_PLUGIN_ROOT/scripts/companion.mjs`);
  }
});

test("v1.1.0: internal skills remain user-invocable: false (no regression)", () => {
  // The 3 internal skills used by grok-rescue subagent stay internal.
  // They are CC-specific (subagent context) and inert in Codex.
  const internal = ["grok-cli-runtime", "grok-prompting", "grok-result-handling"];
  for (const name of internal) {
    const skillFile = path.join(SKILLS_DIR, name, "SKILL.md");
    assert.ok(fs.existsSync(skillFile), `internal skill ${name} must still exist`);
    const fm = readFrontmatter(skillFile);
    assert.equal(fm["user-invocable"], "false", `internal skill ${name} must keep user-invocable: false`);
  }
});

test("skills/ directory contains exactly the expected 8 skills", () => {
  // 5 user-facing (grok-ask/research/imagine/rescue + v1.2.0 grok-fan-out) +
  // 3 internal. If this fails, someone added a skill without updating the
  // test — review intent.
  const entries = fs.readdirSync(SKILLS_DIR).filter((e) => {
    const full = path.join(SKILLS_DIR, e);
    return fs.statSync(full).isDirectory();
  }).sort();
  assert.deepEqual(entries, [
    "grok-ask",
    "grok-cli-runtime",
    "grok-fan-out",
    "grok-imagine",
    "grok-prompting",
    "grok-rescue",
    "grok-research",
    "grok-result-handling",
  ]);
});

test("v1.1.0: README documents the Codex install command", () => {
  const readme = fs.readFileSync(path.join(REPO_ROOT, "README.md"), "utf8");
  assert.match(readme, /codex plugin marketplace add/, "README must show 'codex plugin marketplace add' command");
  assert.match(readme, /Codex CLI/i, "README must mention Codex CLI");
});

test("v1.1.0: CHANGELOG documents the v1.1.0 release", () => {
  const changelog = fs.readFileSync(path.join(REPO_ROOT, "CHANGELOG.md"), "utf8");
  assert.match(changelog, /## \[1\.1\.0\]/, "CHANGELOG must have a [1.1.0] section");
  assert.match(changelog, /Codex/i, "CHANGELOG 1.1.0 must mention Codex");
});
