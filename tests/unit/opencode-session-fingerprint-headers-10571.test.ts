/**
 * Regression test for PR #10571 + the OpenCode v2 gate (9router PR #4842) —
 * `x-opencode-session` must be a STABLE, conversation-scoped id that ALSO
 * matches the format the free-tier gate accepts.
 *
 * `open-sse/utils/opencodeHeaders.ts::applyCliDefaults` derives the id from
 * `generateSessionId(sessionBody)` (`open-sse/services/sessionManager.ts`) and
 * encodes it as a valid `ses_...` id via `generateOpencodeSessionId()`, so the
 * same conversation keeps the same id across turns (prompt-cache stability)
 * while staying gate-valid. A 16-hex hash (or a bare UUID) is rejected upstream
 * with 403 FreeTierError.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { forwardOpencodeClientHeaders } from "../../open-sse/utils/opencodeHeaders.ts";
import { OpencodeExecutor } from "../../open-sse/executors/opencode.ts";
import {
  OPENCODE_SESSION_RE,
  generateOpencodeSessionId,
} from "../../open-sse/utils/opencodeFingerprint.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SESSION_RE = OPENCODE_SESSION_RE;

const CLI_DEFAULTS = { userAgent: "opencode/latest/2.0.26/cli", client: "cli", project: "global" };

const CONVERSATION_A = {
  model: "big-pickle",
  messages: [{ role: "user", content: "Hello there" }],
};

const CONVERSATION_A_SECOND_TURN = {
  model: "big-pickle",
  messages: [
    { role: "user", content: "Hello there" },
    { role: "assistant", content: "Hi! How can I help?" },
    { role: "user", content: "What's the weather?" },
  ],
};

const CONVERSATION_B_DIFFERENT_MODEL = {
  model: "deepseek-v4-flash-free",
  messages: [{ role: "user", content: "Hello there" }],
};

const CONVERSATION_C_DIFFERENT_FIRST_MESSAGE = {
  model: "big-pickle",
  messages: [{ role: "user", content: "A completely different opening message" }],
};

test("generateOpencodeSessionId: a seed produces a deterministic, gate-valid id", () => {
  const a = generateOpencodeSessionId("seed-1");
  const b = generateOpencodeSessionId("seed-1");
  assert.equal(a, b);
  assert.match(a, SESSION_RE);
});

test("generateOpencodeSessionId: no seed produces a gate-valid id (never a UUID)", () => {
  const id = generateOpencodeSessionId(null);
  assert.match(id, SESSION_RE);
  assert.doesNotMatch(id, UUID_RE);
});

test("x-opencode-session is a gate-valid ses_ id (not a raw hash) when sessionBody is provided", () => {
  const headers: Record<string, string> = {};
  forwardOpencodeClientHeaders(
    headers,
    {},
    {
      cliDefaults: CLI_DEFAULTS,
      sessionBody: CONVERSATION_A,
    }
  );
  assert.match(headers["x-opencode-session"] ?? "", SESSION_RE);
  assert.doesNotMatch(headers["x-opencode-session"] ?? "", UUID_RE);
});

test("x-opencode-session stays STABLE across requests in the same conversation", () => {
  const headersFirstTurn: Record<string, string> = {};
  forwardOpencodeClientHeaders(
    headersFirstTurn,
    {},
    {
      cliDefaults: CLI_DEFAULTS,
      sessionBody: CONVERSATION_A,
    }
  );

  const headersSecondTurn: Record<string, string> = {};
  forwardOpencodeClientHeaders(
    headersSecondTurn,
    {},
    {
      cliDefaults: CLI_DEFAULTS,
      sessionBody: CONVERSATION_A_SECOND_TURN,
    }
  );

  assert.equal(headersFirstTurn["x-opencode-session"], headersSecondTurn["x-opencode-session"]);
});

test("x-opencode-session CHANGES when the model differs", () => {
  const headersA: Record<string, string> = {};
  forwardOpencodeClientHeaders(
    headersA,
    {},
    {
      cliDefaults: CLI_DEFAULTS,
      sessionBody: CONVERSATION_A,
    }
  );

  const headersB: Record<string, string> = {};
  forwardOpencodeClientHeaders(
    headersB,
    {},
    {
      cliDefaults: CLI_DEFAULTS,
      sessionBody: CONVERSATION_B_DIFFERENT_MODEL,
    }
  );

  assert.notEqual(headersA["x-opencode-session"], headersB["x-opencode-session"]);
});

test("x-opencode-session CHANGES when the first user message differs", () => {
  const headersA: Record<string, string> = {};
  forwardOpencodeClientHeaders(
    headersA,
    {},
    {
      cliDefaults: CLI_DEFAULTS,
      sessionBody: CONVERSATION_A,
    }
  );

  const headersC: Record<string, string> = {};
  forwardOpencodeClientHeaders(
    headersC,
    {},
    {
      cliDefaults: CLI_DEFAULTS,
      sessionBody: CONVERSATION_C_DIFFERENT_FIRST_MESSAGE,
    }
  );

  assert.notEqual(headersA["x-opencode-session"], headersC["x-opencode-session"]);
});

test("x-opencode-session falls back to a fresh gate-valid id when no sessionBody is provided", () => {
  const headers: Record<string, string> = {};
  forwardOpencodeClientHeaders(headers, {}, { cliDefaults: CLI_DEFAULTS });
  assert.match(headers["x-opencode-session"] ?? "", SESSION_RE);
});

test("a valid client-supplied x-opencode-session wins over the derived fingerprint", () => {
  const clientSession = generateOpencodeSessionId("client-seed");
  const headers: Record<string, string> = {};
  forwardOpencodeClientHeaders(
    headers,
    { "x-opencode-session": clientSession },
    {
      cliDefaults: CLI_DEFAULTS,
      sessionBody: CONVERSATION_A,
    }
  );
  assert.equal(headers["x-opencode-session"], clientSession);
});

test("an invalid client session hint is translated into a gate-valid id", () => {
  const headers: Record<string, string> = {};
  forwardOpencodeClientHeaders(
    headers,
    { "x-opencode-session": "not-a-ses-id" },
    {
      cliDefaults: CLI_DEFAULTS,
      sessionBody: CONVERSATION_A,
    }
  );
  assert.notEqual(headers["x-opencode-session"], "not-a-ses-id");
  assert.match(headers["x-opencode-session"] ?? "", SESSION_RE);
});

test("OpencodeExecutor.buildHeaders derives a stable x-opencode-session from the request body across calls with the same conversation", () => {
  const executor = new OpencodeExecutor("opencode-go");
  const headersFirst = executor.buildHeaders(null, true, null, "big-pickle", undefined, {
    model: "big-pickle",
    messages: [{ role: "user", content: "Same conversation" }],
  });
  const headersSecond = executor.buildHeaders(null, true, null, "big-pickle", undefined, {
    model: "big-pickle",
    messages: [
      { role: "user", content: "Same conversation" },
      { role: "assistant", content: "..." },
      { role: "user", content: "follow-up" },
    ],
  });

  assert.match(headersFirst["x-opencode-session"] ?? "", SESSION_RE);
  assert.equal(headersFirst["x-opencode-session"], headersSecond["x-opencode-session"]);
});

test("Responses requests use a fresh gate-valid ses_ session for Muse compatibility", () => {
  const executor = new OpencodeExecutor("opencode");
  executor._requestFormat = "openai-responses";
  const headers = executor.buildHeaders(
    null,
    true,
    null,
    "muse-spark-1.2-contributor-free",
    undefined,
    {
      model: "muse-spark-1.2-contributor-free",
      input: [],
    }
  );
  assert.match(headers["x-opencode-session"] ?? "", SESSION_RE);
  assert.equal(headers["x-opencode-session-id"], headers["x-opencode-session"]);
});

test("OpencodeExecutor.buildHeaders derives a DIFFERENT x-opencode-session for a different conversation body", () => {
  const executor = new OpencodeExecutor("opencode-go");
  const headersA = executor.buildHeaders(null, true, null, "big-pickle", undefined, {
    model: "big-pickle",
    messages: [{ role: "user", content: "Conversation one" }],
  });
  const headersB = executor.buildHeaders(null, true, null, "big-pickle", undefined, {
    model: "big-pickle",
    messages: [{ role: "user", content: "Conversation two, totally different" }],
  });

  assert.notEqual(headersA["x-opencode-session"], headersB["x-opencode-session"]);
});
