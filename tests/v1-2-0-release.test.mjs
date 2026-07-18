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

test("package.json + both plugin manifests are bumped to 1.2.2", () => {
  assert.equal(readJson("package.json").version, "1.2.2");
  assert.equal(readJson("plugins/grok/.claude-plugin/plugin.json").version, "1.2.2");
  assert.equal(readJson("plugins/grok/.codex-plugin/plugin.json").version, "1.2.2");
});

test("CHANGELOG documents v1.2.2 hardening, v1.2.1 fan-out, and the v1.2.0 auth fix", () => {
  const changelog = fs.readFileSync(path.join(REPO_ROOT, "CHANGELOG.md"), "utf8");
  assert.match(changelog, /## \[1\.2\.2\]/, "CHANGELOG must have a [1.2.2] section");
  assert.match(changelog, /## \[1\.2\.1\]/, "CHANGELOG must have a [1.2.1] section");
  assert.match(changelog, /## \[1\.2\.0\]/, "CHANGELOG must keep the [1.2.0] section");
  assert.match(changelog, /parallel/i, "CHANGELOG 1.2.1 must mention the parallel fan-out");
  assert.match(changelog, /XAI_API_KEY/, "CHANGELOG must mention the XAI_API_KEY fix");
});

test("README documents /grok:fan-out", () => {
  const readme = fs.readFileSync(path.join(REPO_ROOT, "README.md"), "utf8");
  assert.match(readme, /fan-out/i, "README must mention fan-out");
});
