/**
 * Regression test for #5997 — opencode upstream requests must carry OpenCode CLI
 * identity headers even when the client did not supply them.
 *
 * On a datacenter VPS, `opencode.ai` is fronted by Cloudflare, which 403s (HTML
 * challenge) requests lacking CLI identity. Since most OpenAI-compatible clients
 * never send those headers, `OpencodeExecutor.buildHeaders()` must synthesize the
 * defaults when absent. Client-supplied values always take precedence (defaults
 * only fill gaps), and the UA/client/project defaults are env-overridable.
 *
 * PR #10571 turned the executor-level synthesis ON BY DEFAULT and changed the
 * synthesized defaults. The OpenCode v2 free-tier gate (2026-10, mirrored from
 * decolua/9router PR #4842) then tightened the identity:
 *   - User-Agent must be the v2 shape `opencode/<channel>/<version>/<client>`
 *     (v1 `opencode/1.18.x` and `opencode-cli/...` forms are replaced);
 *   - the conversation session id is mirrored into `x-opencode-session-id`,
 *     `x-session-affinity` and `x-session-id`;
 *   - `x-opencode-request` is no longer synthesized or forwarded (the v2 CLI
 *     does not send it).
 * Opt-out remains `OPENCODE_SYNTHESIZE_CLI_HEADERS=false`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { forwardOpencodeClientHeaders } from "../../open-sse/utils/opencodeHeaders.ts";
import { OpencodeExecutor, DEFAULT_OPENCODE_CLI_UA } from "../../open-sse/executors/opencode.ts";
import { OPENCODE_SESSION_RE } from "../../open-sse/utils/opencodeFingerprint.ts";

const SESSION_RE = OPENCODE_SESSION_RE;

// Caller-supplied cliDefaults (used to test forwardOpencodeClientHeaders directly).
const CLI_DEFAULTS = { userAgent: "opencode/latest/2.0.26/cli", client: "cli", project: "default" };

// OpencodeExecutor.buildHeaders()'s own synthesized defaults.
const OPENCODE_DEFAULTS = { userAgent: DEFAULT_OPENCODE_CLI_UA, client: "cli", project: "global" };

function withEnv(key: string, value: string | undefined, fn: () => void) {
  const saved = process.env[key];
  try {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
    fn();
  } finally {
    if (saved === undefined) delete process.env[key];
    else process.env[key] = saved;
  }
}

function assertSessionMirrors(headers: Record<string, string>): void {
  const session = headers["x-opencode-session"];
  assert.ok(session, "x-opencode-session must be present");
  assert.equal(headers["x-opencode-session-id"], session);
  assert.equal(headers["x-session-affinity"], session);
  assert.equal(headers["x-session-id"], session);
  assert.equal(headers["x-opencode-request"], undefined);
}

test("forwardOpencodeClientHeaders: cliDefaults synthesize all CLI identity headers when absent [#5997]", () => {
  const headers: Record<string, string> = {};
  forwardOpencodeClientHeaders(headers, {}, { cliDefaults: CLI_DEFAULTS });

  assert.equal(headers["User-Agent"], CLI_DEFAULTS.userAgent);
  assert.equal(headers["x-opencode-client"], "cli");
  assert.equal(headers["x-opencode-project"], "default");
  assert.match(headers["x-opencode-session"] ?? "", SESSION_RE);
  assertSessionMirrors(headers);
});

test("forwardOpencodeClientHeaders: non-v2 client UA is REPLACED with the CLI UA; other headers keep client-wins [#5997 follow-up]", () => {
  const headers: Record<string, string> = {};
  const clientHeaders = {
    "User-Agent": "curl/8.5.0",
    "x-opencode-client": "vscode",
    "x-opencode-project": "acme",
    "x-opencode-request": "req-from-client",
    "x-opencode-session": "sess-from-client",
  };
  forwardOpencodeClientHeaders(headers, clientHeaders, { cliDefaults: CLI_DEFAULTS });

  assert.equal(headers["User-Agent"], CLI_DEFAULTS.userAgent);
  assert.equal(headers["x-opencode-client"], "vscode");
  assert.equal(headers["x-opencode-project"], "acme");
  // x-opencode-request is never forwarded now.
  assert.equal(headers["x-opencode-request"], undefined);
  // A non-`ses_` client session hint is translated into a gate-valid id, mirrored everywhere.
  assert.notEqual(headers["x-opencode-session"], "sess-from-client");
  assert.match(headers["x-opencode-session"] ?? "", SESSION_RE);
  assertSessionMirrors(headers);
});

test("forwardOpencodeClientHeaders: a v2 CLI UA is preserved (real CLI identity intact)", () => {
  const headers: Record<string, string> = {};
  const clientHeaders = { "User-Agent": "opencode/latest/2.5.0/cli" };
  forwardOpencodeClientHeaders(headers, clientHeaders, { cliDefaults: CLI_DEFAULTS });
  assert.equal(headers["User-Agent"], "opencode/latest/2.5.0/cli");
});

test("forwardOpencodeClientHeaders: a v1 opencode-cli UA is replaced with the v2 default", () => {
  const headers: Record<string, string> = {};
  const clientHeaders = { "User-Agent": "opencode-cli/2.5.0" };
  forwardOpencodeClientHeaders(headers, clientHeaders, { cliDefaults: CLI_DEFAULTS });
  assert.equal(headers["User-Agent"], CLI_DEFAULTS.userAgent);
});

test("forwardOpencodeClientHeaders: without cliDefaults, no synthesis (DefaultExecutor path unchanged)", () => {
  const headers: Record<string, string> = {};
  forwardOpencodeClientHeaders(headers, {});
  assert.equal(headers["User-Agent"], undefined);
  assert.equal(headers["x-opencode-client"], undefined);
  assert.equal(headers["x-opencode-project"], undefined);
  assert.equal(headers["x-opencode-request"], undefined);
});

test("OpencodeExecutor.buildHeaders: synthesizes v2 CLI defaults by default — flag unset [#10571]", () => {
  withEnv("OPENCODE_SYNTHESIZE_CLI_HEADERS", undefined, () => {
    const executor = new OpencodeExecutor("opencode-go");
    const headers = executor.buildHeaders(null, true, null, "glm-5.2");
    assert.equal(headers["User-Agent"], OPENCODE_DEFAULTS.userAgent);
    assert.equal(headers["x-opencode-client"], OPENCODE_DEFAULTS.client);
    assert.equal(headers["x-opencode-project"], OPENCODE_DEFAULTS.project);
    assertSessionMirrors(headers);
  });
});

test("OpencodeExecutor.buildHeaders: synthesizes CLI defaults with flag explicitly on + no client headers [#5997]", () => {
  withEnv("OPENCODE_SYNTHESIZE_CLI_HEADERS", "true", () => {
    const executor = new OpencodeExecutor("opencode-go");
    const headers = executor.buildHeaders(null, true, null, "glm-5.2");

    assert.equal(headers["User-Agent"], OPENCODE_DEFAULTS.userAgent);
    assert.equal(headers["x-opencode-client"], OPENCODE_DEFAULTS.client);
    assert.equal(headers["x-opencode-project"], OPENCODE_DEFAULTS.project);
    assert.match(headers["x-opencode-session"] ?? "", SESSION_RE);
    assertSessionMirrors(headers);
  });
});

test("OpencodeExecutor.buildHeaders: forward-only — no fabrication when flag is explicitly off [#10571 opt-out]", () => {
  withEnv("OPENCODE_SYNTHESIZE_CLI_HEADERS", "false", () => {
    const executor = new OpencodeExecutor("opencode-go");
    const headers = executor.buildHeaders(null, true, null, "glm-5.2");
    assert.equal(headers["User-Agent"], undefined);
    assert.equal(headers["x-opencode-client"], undefined);
    assert.equal(headers["x-opencode-project"], undefined);
  });
});

test("OpencodeExecutor.buildHeaders: OPENCODE_GO_USER_AGENT env overrides the default UA (flag on) [#5997]", () => {
  withEnv("OPENCODE_SYNTHESIZE_CLI_HEADERS", "true", () => {
    withEnv("OPENCODE_GO_USER_AGENT", "opencode-cli/2.5.0", () => {
      const executor = new OpencodeExecutor("opencode-go");
      const headers = executor.buildHeaders(null, true, null, "glm-5.2");
      assert.equal(headers["User-Agent"], "opencode-cli/2.5.0");
    });
  });
});
