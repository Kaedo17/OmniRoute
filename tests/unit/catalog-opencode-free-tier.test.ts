/**
 * catalog-opencode-free-tier.test.ts — `oc/` catalog rows are scoped to the free tier.
 *
 * Regression guard for the operator rule: `GET /v1/models` must publish EXACTLY the free
 * models the OpenCode base URL currently serves, under `owned_by: "omniroute"` — not the
 * full 139-row block (which included 122 paid ids) and not stale/delisted free ids the
 * upstream has dropped but the registry's static list still carries.
 */
import test from "node:test";
import assert from "node:assert/strict";

const { applyOpencodeFreeTierCatalogWithSources, OPENCODE_FREE_OWNER } =
  await import("../../src/sse/services/catalogOpencodeFreeTier.ts");

/** What the base URL served when this was measured: the 10 current free ids. */
const BASE_URL = new Set([
  "big-pickle",
  "beam-free",
  "mimo-v2.6-flash-free",
  "nemotron-3.5-super-vl-free",
  "nemotron-3.5-lightning-free",
  "jev-1.13-free",
  "longcat-2.5-preview-free",
  "deepseek-v4.1-flash-free",
  "glm-5.3-flash-free",
  "space-bunny-free",
]);

/** Mirrors the real contract: a `-free` suffix or the legacy id is free. */
const LEGACY_FREE = new Set(["big-pickle"]);
const isPremium = (bareId: string): boolean => !/-free$/.test(bareId) && !LEGACY_FREE.has(bareId);

const sources = (available: ReadonlySet<string> = BASE_URL) => ({ available, isPremium });

const row = (id: string, ownedBy = "opencode") => ({ id, owned_by: ownedBy });

test("keeps a free model that is on the base URL and regroups it under omniroute", () => {
  const out = applyOpencodeFreeTierCatalogWithSources([row("oc/glm-5.3-flash-free")], sources());
  assert.equal(out.length, 1);
  assert.equal(out[0].id, "oc/glm-5.3-flash-free");
  assert.equal(out[0].owned_by, OPENCODE_FREE_OWNER);
});

test("drops a paid model that is on the base URL", () => {
  const out = applyOpencodeFreeTierCatalogWithSources([row("oc/claude-opus-5")], sources());
  assert.deepEqual(
    out.map((m) => m.id),
    []
  );
});

test("drops a free model the base URL no longer serves (delisted upstream)", () => {
  // Still matches the `-free` suffix rule, but is absent from the live base URL.
  const out = applyOpencodeFreeTierCatalogWithSources([row("oc/mimo-v2.5-free")], sources());
  assert.deepEqual(
    out.map((m) => m.id),
    []
  );
});

test("publishes exactly the 10 base-URL free models out of a mixed 13-row block", () => {
  const models = [
    ...[...BASE_URL].map((id) => row(`oc/${id}`)),
    // paid, still on the base URL
    row("oc/gpt-5.6-luna"),
    row("oc/claude-sonnet-5"),
    // free but delisted upstream
    row("oc/mimo-v2.5-free"),
  ];
  assert.equal(models.length, 13);

  const out = applyOpencodeFreeTierCatalogWithSources(models, sources());
  assert.equal(out.length, 10);
  assert.deepEqual(out.map((m) => m.id).sort(), [...BASE_URL].map((id) => `oc/${id}`).sort());
  assert.ok(
    out.every((m) => m.owned_by === OPENCODE_FREE_OWNER),
    "every survivor must carry the omniroute owner identity"
  );
});

test("leaves non-oc/ rows untouched, preserving their original owner", () => {
  const out = applyOpencodeFreeTierCatalogWithSources(
    [row("openrouter/gpt-5", "openrouter"), row("glm-5", "zhipuai"), row("combo/auto/1", "combo")],
    sources()
  );
  assert.deepEqual(
    out.map((m) => [m.id, m.owned_by]),
    [
      ["openrouter/gpt-5", "openrouter"],
      ["glm-5", "zhipuai"],
      ["combo/auto/1", "combo"],
    ]
  );
});

test("drops a no-thinking mirror of a paid model together with its base row", () => {
  // The no-thinking pass mints `no-think/oc/<model>` for every advertised `oc/` model.
  // A prefix match would miss these, orphaning paid rows under the free-tier identity.
  const out = applyOpencodeFreeTierCatalogWithSources(
    [row("no-think/oc/claude-opus-5"), row("no-think/oc/gpt-5.6-luna"), row("oc/claude-opus-5")],
    sources()
  );
  assert.deepEqual(
    out.map((m) => m.id),
    []
  );
});

test("keeps a no-thinking mirror of a free model, under the omniroute owner", () => {
  const out = applyOpencodeFreeTierCatalogWithSources(
    [row("no-think/oc/glm-5.3-flash-free")],
    sources()
  );
  assert.deepEqual(
    out.map((m) => [m.id, m.owned_by]),
    [["no-think/oc/glm-5.3-flash-free", OPENCODE_FREE_OWNER]]
  );
});

test("drops the canonical opencode/<model> mirror when its oc/ sibling is present", () => {
  // Discovery makes the synced-models loop emit a canonical mirror beside each alias row
  // (`parent: aliasId`), so the same free model was listed twice under two owner names.
  const out = applyOpencodeFreeTierCatalogWithSources(
    [
      row("oc/glm-5.3-flash-free"),
      row("opencode/glm-5.3-flash-free", "opencode"),
      row("oc/beam-free"),
      row("opencode/beam-free", "opencode"),
    ],
    sources()
  );
  assert.deepEqual(
    out.map((m) => [m.id, m.owned_by]),
    [
      ["oc/glm-5.3-flash-free", OPENCODE_FREE_OWNER],
      ["oc/beam-free", OPENCODE_FREE_OWNER],
    ]
  );
});

test("keeps a canonical row that has no oc/ sibling — it is not a mirror", () => {
  const out = applyOpencodeFreeTierCatalogWithSources(
    [row("opencode/some-standalone-model", "opencode")],
    sources()
  );
  assert.deepEqual(
    out.map((m) => [m.id, m.owned_by]),
    [["opencode/some-standalone-model", "opencode"]]
  );
});

test("drops the canonical mirror even when the alias row itself is filtered out", () => {
  // A paid model's alias row is dropped by the free rule; its mirror must not survive
  // as an orphan advertising the same paid id.
  const out = applyOpencodeFreeTierCatalogWithSources(
    [row("oc/claude-opus-5"), row("opencode/claude-opus-5", "opencode")],
    sources()
  );
  assert.deepEqual(out, []);
});

test("leaves the separate keyed gateways opencode-zen/ and opencode-go/ alone", () => {
  const out = applyOpencodeFreeTierCatalogWithSources(
    [
      row("opencode-zen/glm-5.3-flash-free", "opencode-zen"),
      row("opencode-go/some-model", "opencode-go"),
      row("oc/glm-5.3-flash-free"),
    ],
    sources()
  );
  assert.deepEqual(
    out.map((m) => [m.id, m.owned_by]),
    [
      ["opencode-zen/glm-5.3-flash-free", "opencode-zen"],
      ["opencode-go/some-model", "opencode-go"],
      ["oc/glm-5.3-flash-free", OPENCODE_FREE_OWNER],
    ]
  );
});

test("an empty synced list degrades to the free rule instead of blanking the block", () => {
  // Fresh install: discovery has not run, so `available` is empty. Intersecting against
  // it would publish zero rows; the documented fallback keeps free ids visible.
  const out = applyOpencodeFreeTierCatalogWithSources(
    [row("oc/mimo-v2.5-free"), row("oc/gpt-5.6-luna")],
    sources(new Set())
  );
  assert.deepEqual(
    out.map((m) => m.id),
    ["oc/mimo-v2.5-free"]
  );
});

test("is pure — returns a new array and does not mutate the input rows", () => {
  const input = [row("oc/glm-5.3-flash-free"), row("oc/gpt-5.6-luna")];
  const out = applyOpencodeFreeTierCatalogWithSources(input, sources());
  assert.notEqual(out, input);
  assert.equal(input.length, 2);
  assert.equal(input[0].owned_by, "opencode", "input row must stay untouched");
});

test("passes empty and non-array inputs through unchanged", () => {
  assert.deepEqual(applyOpencodeFreeTierCatalogWithSources([], sources()), []);
  // Defensive: a non-array from a malformed caller passes through rather than throwing.
  const malformed = undefined as unknown as Array<Record<string, unknown>>;
  assert.equal(applyOpencodeFreeTierCatalogWithSources(malformed, sources()), undefined);
});

test("ignores a bare `oc/` prefix with no model id", () => {
  const out = applyOpencodeFreeTierCatalogWithSources([row("oc/")], sources());
  assert.deepEqual(
    out.map((m) => m.id),
    ["oc/"]
  );
  assert.equal(out[0].owned_by, "opencode", "an empty id is not a free model");
});
