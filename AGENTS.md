# AGENTS.md

## Cursor Cloud specific instructions

### What this repo is
`grok-plugin-cc` is a single-product repo: a plugin for **Claude Code** and **Codex CLI** that shells out to the external **xAI Grok CLI** (`grok`). There is no web app, API server, or database. The runtime is a Node.js dispatcher at `plugins/grok/scripts/companion.mjs` invoked as `node plugins/grok/scripts/companion.mjs <subcommand> ...` (e.g. `ask`, `review`, `research`, `imagine`, `setup`).

### Toolchain / dependencies
- Node.js **>= 20** is the only requirement (VM currently has v22). There are **zero npm dependencies and no lockfile** — do not expect `node_modules`. `npm install` is unnecessary.
- Lint/build: there is no separate linter or build step. CI's equivalent of "lint" is a syntax check: `node --check` on every `.mjs` under `plugins/grok/scripts/`. Tests use Node's built-in runner. Standard commands live in `package.json` scripts and `.github/workflows/ci.yml`; see also `CONTRIBUTING.md`.

### Testing
- Unit tests: `npm test` (runs `node --test tests/*.test.mjs`). ~460 pass.
- 5 tests are **skipped by default** — the real-Grok integration tests in `tests/integration-real-grok.test.mjs`. They only run with `GROK_INTEGRATION_TEST=1` plus a real `grok` binary and xAI auth.

### Running the product end-to-end (important caveat)
- The `grok` binary is **not installed** in this environment and real Grok calls need xAI auth (`XAI_API_KEY`, or `grok login` writing `~/.grok/auth.json`). Without those, `setup --json` correctly reports `ready: false` and `ask`/`review` exit 127 ("Grok CLI not installed").
- To exercise the full dispatch pipeline (arg building → spawn `grok` → parse `--output-format json` envelope → render) **without** real credentials, put a stub `grok` executable first on `PATH`. It must handle:
  - `grok --version` → a line containing a semver `>= 0.1.210` (see `MIN_GROK_VERSION`).
  - `grok --help` → output containing every token in `CAPABILITY_REQUIRED_FLAGS` (in `plugins/grok/scripts/lib/grok.mjs`), else capability probe fails.
  - headless `-p <prompt> ... --output-format json` → print `{"text": "..."}`. The auth probe sends the exact sentinel prompt `Reply with exactly the word: OK` and expects the response text to contain `OK`.
- The dispatcher discovers `grok` via `which grok` / `spawnSync("grok", ...)`, and only an allowlisted subset of env vars is passed to the child (`cleanGrokEnv` in `lib/grok.mjs`).

### State
Plugin job/config state is filesystem-only, under `${CLAUDE_PLUGIN_DATA}/grok-plugin-cc/state/<workspace>/`, falling back to `/tmp/grok-plugin-cc/` when `CLAUDE_PLUGIN_DATA` is unset.
