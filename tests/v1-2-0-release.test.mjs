// v1.2.0 — release metadata: version bumped everywhere, CHANGELOG + README
// document the release.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const REPO_ROOT = new URL("..", import.meta.url).pathname;

function readJson(rel) {
  return JSON.parse(fs.readFileSync(path.join(REPO_ROOT, rel), "utf8"));
}

test("package.json + both plugin manifests are bumped to 1.2.0", () => {
  assert.equal(readJson("package.json").version, "1.2.0");
  assert.equal(readJson("plugins/grok/.claude-plugin/plugin.json").version, "1.2.0");
  assert.equal(readJson("plugins/grok/.codex-plugin/plugin.json").version, "1.2.0");
});

test("CHANGELOG documents the v1.2.0 release with fan-out + XAI_API_KEY", () => {
  const changelog = fs.readFileSync(path.join(REPO_ROOT, "CHANGELOG.md"), "utf8");
  assert.match(changelog, /## \[1\.2\.0\]/, "CHANGELOG must have a [1.2.0] section");
  assert.match(changelog, /fan-out/i, "CHANGELOG 1.2.0 must mention fan-out");
  assert.match(changelog, /XAI_API_KEY/, "CHANGELOG 1.2.0 must mention the XAI_API_KEY fix");
});

test("README documents /grok:fan-out", () => {
  const readme = fs.readFileSync(path.join(REPO_ROOT, "README.md"), "utf8");
  assert.match(readme, /fan-out/i, "README must mention fan-out");
});
