/**
 * OpenCode Zen free-tier models on the KEYED lane.
 *
 * Upstream gates the free tier behind the attested anonymous identity, not behind a
 * subscription: a request carrying a real `oc_sk_*` connection key is answered
 * 403 FreeTierError ("can only be used from within OpenCode"), while the same request
 * carrying `Bearer public` plus a session id succeeds. Paid models on the same host are
 * the opposite — they need the connection key and are refused without it.
 *
 * OmniRoute resolves credentials before the executor ever sees them, so an operator who
 * added an opencode API key (for the paid models) also routes their FREE models down the
 * keyed lane. `buildHeaders` used to forward the key unconditionally, which turned every
 * free-tier request on such an account into a 403. The free-tier scope is already known
 * here as `gatedScope` (it drives the forced stream, the CLI identity headers and the
 * session re-mint), so the auth lane is switched on the same predicate.
 *
 * Ported from decolua/9router#4784 — narrowed to the `Authorization: Bearer` lane. The
 * two `x-api-key` lanes (Claude format, and openai-responses on the Zen host) are left
 * alone on purpose: #12633 measured that the Zen `/v1/responses` endpoint requires
 * `x-api-key` rather than a Bearer header.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { _setOpencodeFreeModelsForTests } from "../../open-sse/executors/opencodeFreeTierContract.ts";
import { OpencodeExecutor } from "../../open-sse/executors/opencode.ts";
import { isValidOpencodeSessionValue } from "../../open-sse/utils/opencodeHeaders.ts";

const FREE_MODEL = "mimo-v2.6-flash-free";
const PAID_MODEL = "gpt-5.6-luna";
const KEY = "oc_sk_test_key";

/** Pin the free set so the verdict does not depend on a synced catalog (no DB here). */
function pinned<T>(run: () => T): T {
  _setOpencodeFreeModelsForTests([FREE_MODEL]);
  try {
    return run();
  } finally {
    _setOpencodeFreeModelsForTests(null);
  }
}

test("keyed lane: a free-tier model drops the connection key for the attested identity", () => {
  pinned(() => {
    const executor = new OpencodeExecutor("opencode-zen");
    const headers = executor.buildHeaders({ apiKey: KEY }, true, null, FREE_MODEL);

    assert.equal(
      headers["Authorization"],
      "Bearer public",
      "free tier must present the anonymous identity, not the operator key"
    );
    assert.equal(
      headers["x-api-key"],
      undefined,
      "the chat-completions lane must not leak the key under a second header"
    );
  });
});

test("keyed lane: the gated request still carries a session and a request id", () => {
  pinned(() => {
    const executor = new OpencodeExecutor("opencode-zen");
    const headers = executor.buildHeaders({ apiKey: KEY }, true, null, FREE_MODEL);

    assert.ok(
      isValidOpencodeSessionValue(headers["x-opencode-session"]),
      "the session must be the canonical time-based shape upstream validates"
    );
    assert.ok(
      headers["x-opencode-request"],
      "a request id is part of the attested free-tier identity"
    );
  });
});

test("keyed lane: a paid model keeps the connection key untouched", () => {
  pinned(() => {
    const executor = new OpencodeExecutor("opencode-zen");
    const headers = executor.buildHeaders({ apiKey: KEY }, true, null, PAID_MODEL);

    assert.equal(headers["Authorization"], `Bearer ${KEY}`);
    assert.equal(headers["x-api-key"], undefined);
  });
});

test("keyed lane: opencode-go has no free tier, so its key is never swapped", () => {
  pinned(() => {
    const executor = new OpencodeExecutor("opencode-go");
    const headers = executor.buildHeaders({ apiKey: KEY }, true, null, FREE_MODEL);

    assert.equal(
      headers["Authorization"],
      `Bearer ${KEY}`,
      "the go surface is not gated — a free-suffixed id there still needs the key"
    );
  });
});

test("keyed lane: the two x-api-key lanes from #12633 stay on the key", () => {
  pinned(() => {
    const responses = new OpencodeExecutor("opencode-zen");
    responses._requestFormat = "openai-responses";
    const responsesHeaders = responses.buildHeaders({ apiKey: KEY }, true, null, FREE_MODEL);
    assert.equal(
      responsesHeaders["x-api-key"],
      KEY,
      "Zen /v1/responses requires x-api-key (measured #12633)"
    );
    assert.equal(responsesHeaders["Authorization"], undefined);

    const claude = new OpencodeExecutor("opencode-zen");
    claude._requestFormat = "claude";
    const claudeHeaders = claude.buildHeaders({ apiKey: KEY }, true, null, FREE_MODEL);
    assert.equal(claudeHeaders["x-api-key"], KEY);
    assert.equal(claudeHeaders["Authorization"], undefined);
  });
});

test("keyless: an anonymous free-tier request gains no Authorization header", () => {
  pinned(() => {
    const executor = new OpencodeExecutor("opencode-zen");
    const headers = executor.buildHeaders(null, true, null, FREE_MODEL);

    assert.equal(
      headers["Authorization"],
      undefined,
      "nothing to swap when no key resolves — the no-auth lane stays anonymous"
    );
  });
});
