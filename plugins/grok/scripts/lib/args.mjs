// Argument parsing for the Grok companion.
// Mirrors gemini-plugin-cc's args.mjs in shape, plus shell-style splitting for
// $ARGUMENTS forwarded as a single quoted string.

export function splitRawArgumentString(raw) {
  const tokens = [];
  let current = "";
  let quote = null;
  let escaping = false;
  let inToken = false;
  for (const ch of raw) {
    if (escaping) { current += ch; escaping = false; inToken = true; continue; }
    if (ch === "\\") { escaping = true; continue; }
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      inToken = true;
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; inToken = true; continue; }
    if (/\s/.test(ch)) {
      if (inToken) { tokens.push(current); current = ""; inToken = false; }
      continue;
    }
    current += ch;
    inToken = true;
  }
  if (escaping) current += "\\";
  if (inToken) tokens.push(current);
  return tokens;
}

export function tokenize(argv) {
  // Claude Code typically forwards $ARGUMENTS as a single string. If we got
  // exactly one positional that contains spaces or quote chars, split it shell-style.
  if (argv.length === 1 && /[\s"']/.test(argv[0])) {
    return splitRawArgumentString(argv[0]);
  }
  return argv;
}

export function parseArgs(argv, {
  boolFlags = new Set(),
  valueFlags = new Set(),
  // v0.8.0: repeatable value flags accumulate into an array instead of
  // overwriting. Required for `--allow`/`--deny`/`--rules` which Grok
  // accepts multiple times.
  repeatableFlags = new Set(),
  // v0.9.0: optional-value flags. Bare `--flag` = true; ONLY the inline
  // `--flag=value` form sets a value. v0.9.1 (3/3 reviewer consensus):
  // we removed the "peek next token" semantics because it ate prompt
  // tokens (`/grok:ask --worktree how do I fix this?` was making the
  // worktree named `how` and dropping `how` from the prompt). Require
  // the explicit `=` form for named values.
  optionalValueFlags = new Set(),
  // v0.9.1: short-alias map (Codex round-1: Grok CLI documents -w/-r/-c
  // but the parser only saw --long forms). Keys are letters (no dash),
  // values are the long flag name. e.g. `{ w: "worktree", c: "continue" }`.
  // When the parser sees `-X` it resolves X via this map and processes
  // as if the user had typed `--<long>`.
  shortAliases = {}
} = {}) {
  const tokens = tokenize(argv);
  const flags = {};
  const positional = [];
  let afterTerminator = false;
  // v0.9.2 (3/3 round-2 critical + Gemini Important): track WHERE the
  // `--` terminator was seen. Wrappers need to know which positionals
  // were "literal-escaped" so they can re-emit the `--` before
  // forwarding to grok (otherwise grok itself sees `--timeout` as a
  // flag and the workaround silently regresses).
  let literalStartIndex = -1;
  for (let i = 0; i < tokens.length; i++) {
    let t = tokens[i];
    // POSIX `--` terminator. Once seen, every subsequent token is a
    // literal positional regardless of its leading dashes.
    if (afterTerminator) { positional.push(t); continue; }
    if (t === "--") {
      afterTerminator = true;
      literalStartIndex = positional.length;
      continue;
    }
    if (!t.startsWith("-")) { positional.push(t); continue; }
    // v0.9.1 → v0.9.2: short-alias resolution. v0.9.2 (3/3 round-2:
    // Codex P2 + Gemini Important + Grok MED) — short aliases are
    // OFF BY DEFAULT now. v0.9.1 enabled them for every command,
    // which over-rewrote `-r foo` in free-form prompts (e.g.,
    // `/grok:ask explain grep -r foo` set resume=true and dropped
    // `foo`). Callers who genuinely need short flags must opt in via
    // the `shortAliases` parser option AND configure them per
    // subcommand. The default top-level dispatch passes an empty
    // map, so prompt-accepting commands are immune.
    if (t.length >= 2 && t[0] === "-" && t[1] !== "-") {
      const ch = t[1];
      if (shortAliases[ch]) {
        const longName = shortAliases[ch];
        if (t.length === 2) {
          t = `--${longName}`;
        } else if (t[2] === "=") {
          t = `--${longName}${t.slice(2)}`;  // include the =value
        } else {
          // Bundle form: `-rabc` → `--resume=abc`
          // Grok MED round-2 noted that for BOOL aliases this swallows
          // attached text. We document the contract: short-alias map
          // is only meant for value-taking flags. Bool clusters like
          // `-cv` are explicitly NOT supported.
          t = `--${longName}=${t.slice(2)}`;
        }
      } else {
        // Unknown short flag → fall through to positional (existing behavior).
        positional.push(t);
        continue;
      }
    }
    if (!t.startsWith("--")) { positional.push(t); continue; }
    // v0.8.1 (Codex P3): split on FIRST `=` only. The old code used
    // `t.slice(2).split("=", 2)` which silently DROPS any tokens
    // beyond the second array slot — so `--system-prompt-override=Use A=B`
    // became `{ rawKey: "system-prompt-override", inline: "Use A" }`,
    // losing the trailing "=B". Find the first equals, slice both sides.
    const stripped = t.slice(2);
    const eqIdx = stripped.indexOf("=");
    const rawKey = eqIdx < 0 ? stripped : stripped.slice(0, eqIdx);
    const inline = eqIdx < 0 ? undefined : stripped.slice(eqIdx + 1);
    if (boolFlags.has(rawKey)) {
      flags[rawKey] = inline === undefined ? true : inline !== "false";
      continue;
    }
    if (valueFlags.has(rawKey) || repeatableFlags.has(rawKey)) {
      const v = inline ?? tokens[i + 1];
      if (v === undefined) {
        const err = new Error(`Missing value for --${rawKey}`);
        err.code = "MISSING_VALUE";
        throw err;
      }
      if (repeatableFlags.has(rawKey)) {
        // Accumulate. Single-occurrence still produces a 1-element array.
        if (!Array.isArray(flags[rawKey])) flags[rawKey] = [];
        flags[rawKey].push(v);
      } else {
        flags[rawKey] = v;
      }
      if (inline === undefined) i++;
      continue;
    }
    if (optionalValueFlags.has(rawKey)) {
      // v0.9.1 (3/3 reviewer consensus round-1): the v0.9.0 peek-ahead
      // semantics ate prompt tokens (`/grok:ask --worktree how do I
      // fix this?` named the worktree "how" and dropped that word
      // from the prompt). New contract:
      //   --flag           → true (bool form)
      //   --flag=value     → value (only inline form sets a value)
      //   --flag=          → throw (explicit user intent to clear is
      //                      ambiguous; ask them to pick true vs a value)
      //   --flag=false     → false (matches bool-flag semantics)
      // Users wanting named worktree/resume must use the `=` form.
      if (inline === undefined) {
        flags[rawKey] = true;
      } else if (inline === "") {
        const err = new Error(`Empty value for --${rawKey}. Use --${rawKey} for bool form, or --${rawKey}=<value> for a named value.`);
        err.code = "EMPTY_VALUE";
        throw err;
      } else if (inline === "false") {
        flags[rawKey] = false;
      } else {
        flags[rawKey] = inline;
      }
      continue;
    }
    // Unknown flag — keep as positional for downstream handling.
    positional.push(t);
  }
  // v0.9.2: if no `--` terminator was seen, literalStartIndex stays
  // at -1 and callers can treat the whole `positional` array as
  // regular tokens.
  return { flags, positional, literalStartIndex };
}

export const COMMON_BOOL_FLAGS = new Set([
  "json", "wait", "background", "all", "write", "read-only",
  // v0.9.0: `resume` moved to COMMON_OPTIONAL_VALUE_FLAGS (it accepts an
  // optional session id now). `continue` moved to the v0.9.0 session
  // passthrough group below.
  "fresh", "resume-last",
  "enable-review-gate", "disable-review-gate",
  // v0.6.0 Grok-specific differentiator flags
  "check",                // --check: self-verification loop (headless)
  "no-check",             // --no-check: explicit opt-out (matters for commands where --check defaults to on, e.g. /grok:research)
  "no-web-search",        // --no-web-search: turn OFF default web search
  // v1.2.0 grounding + fan-out + streaming
  "no-web-fetch",         // --no-web-fetch: opt out of the default-on web_fetch grounding tool (research/ask/fan-out)
  "stream",               // --stream: live streaming output (research; uses --output-format streaming-json)
  "set-default",          // /grok:models --set-default: persist activeModel
  "adversarial",          // /grok:aggregate-review --adversarial: switch all reviewers to adversarial template
  // v0.8.0 Grok CLI bool kill-switches
  "no-subagents",         // --no-subagents: forbid grok from spawning its own subagents
  "no-plan",              // --no-plan: skip the planning turn
  "verbatim",             // --verbatim: send the prompt exactly as given (no plugin rewriting)
  // v0.9.0 — session & memory passthroughs (this group is bool-only;
  // --resume / --worktree take optional values and live in
  // COMMON_OPTIONAL_VALUE_FLAGS instead).
  "continue",             // -c, --continue: continue the most recent session for cwd
  "restore-code",         // --restore-code: checkout the original session's commit on resume
  "no-memory",            // --no-memory: disable cross-session memory for this call
  "experimental-memory"   // --experimental-memory: enable cross-session memory for this call
]);

export const COMMON_VALUE_FLAGS = new Set([
  "base", "scope", "model", "older-than", "timeout", "effort", "session-id",
  // v0.6.0 Grok-specific differentiator value flags
  "best-of-n",            // --best-of-n N: parallel branches (cap BEST_OF_N_MAX)
  // v0.8.0 Grok CLI permission/policy flags (non-repeatable subset)
  "tools",                // --tools <list>: allowlist of tool names
  "max-turns",            // --max-turns N: user-facing turn budget
  "reasoning-effort",     // --reasoning-effort <effort>: distinct from --effort
  "system-prompt-override", // --system-prompt-override <prompt>
  "permission-mode",      // --permission-mode <mode>: user-selectable (plan|auto|acceptEdits|dontAsk|bypassPermissions|default)
  "agent",                // --agent <name>: pick a bundled Grok agent persona
  "sandbox",              // --sandbox <profile>: GROK_SANDBOX equivalent
  // v1.2.0 fan-out + context compaction
  "personas",             // /grok:fan-out --personas a,b,c: pick built-in personas
  "agents-json",          // /grok:fan-out --agents-json '<json>': custom inline subagent defs
  "compaction-mode",      // --compaction-mode summary|transcript|segments
  "compaction-detail",    // --compaction-detail none|minimal|balanced|verbose
  // v1.0.2 (issue #5): --save-to on /grok:imagine + /grok:imagine-video.
  // The plugin copies the generated media from grok's internal session
  // dir (~/.grok/sessions/<URL-encoded-cwd>/<session>/{images,videos}/N.X)
  // to the user-specified path. The session copy is preserved for
  // `grok -r <id>` resume/audit.
  "save-to"
]);

// v0.8.0: repeatable value flags. Each occurrence appends to an array.
// Driven by Grok's --allow / --deny / --rules which are explicitly
// repeatable per `grok --help`. The parser handles accumulation; callers
// receive `flags["allow"]` as Array<string> (or undefined if never passed).
export const COMMON_REPEATABLE_FLAGS = new Set([
  "allow",                // --allow <rule>: ToolPrefix(glob) permission rule
  "deny",                 // --deny  <rule>: same syntax
  "rules"                 // --rules <text>: extra system-prompt rules (also accepts @file)
]);

// v0.9.0: optional-value flags. Grok's CLI exposes `-w, --worktree
// [<NAME>]` and `-r, --resume [<SESSION_ID>]` — both accept either no
// value (auto-generate / most-recent) OR an inline value.
// v0.9.1 (3/3 reviewer consensus round-1): named form requires the
// `=` syntax (`--worktree=feature-x`); bare `--worktree` is always
// bool. The previous peek-ahead behavior corrupted prompts.
export const COMMON_OPTIONAL_VALUE_FLAGS = new Set([
  "worktree",             // --worktree [bool] | --worktree=<name>
  "resume"                // --resume   [bool] | --resume=<session-id>
]);

// v0.9.1 (Codex P2 round-1): short-flag aliases used by Grok's CLI.
// The parser used to ignore single-dash flags entirely, dropping
// `/grok:ask -r abc prompt` into positional and losing the resume
// session id. With this map, `-r abc` rewrites to `--resume=abc` —
// matching grok's documented short forms (-w/--worktree, -r/--resume,
// -c/--continue, -m/--model, -p/--single).
export const COMMON_SHORT_ALIASES = {
  w: "worktree",
  r: "resume",
  c: "continue",
  m: "model"
  // Intentionally NOT mapping -p (Grok's `-p/--single`): the plugin
  // never exposes the single-prompt form to slash commands at this
  // level — the companion always builds it internally.
};

// Parse a duration string. Accepts "30d", "12h", "45m", "60s", "500ms", or a
// plain integer treated as ms for backward compatibility. Returns ms, or null
// on parse failure. `0` (with or without unit) yields 0, which callers
// interpret as "disable timeout".
export function parseDuration(s) {
  if (typeof s !== "string") return null;
  const m = s.trim().match(/^(\d+)\s*(ms|s|m|h|d)?$/i);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  if (!Number.isFinite(n)) return null;
  const unit = (m[2] || "ms").toLowerCase();
  const mult = unit === "ms" ? 1
    : unit === "s" ? 1000
    : unit === "m" ? 60_000
    : unit === "h" ? 3_600_000
    : unit === "d" ? 86_400_000
    : 1;
  return n * mult;
}
