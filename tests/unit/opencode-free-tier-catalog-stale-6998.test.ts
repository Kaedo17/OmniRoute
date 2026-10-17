import test from "node:test";
import assert from "node:assert/strict";

const { opencodeProvider } =
  await import("../../open-sse/config/providers/registry/opencode/index.ts");

function modelIds(): string[] {
  return (opencodeProvider.models ?? []).map((m) => m.id);
}

const DELISTED_FREE_MODELS = [
  "minimax-m3-free",
  "minimax-m2.5-free",
  "ling-2.6-1t-free",
  "trinity-large-preview-free",
  "nemotron-3-super-free",
  "qwen3.6-plus-free",
  // 2026-10-17: dropped from the registry after the live catalog
  // (https://opencode.ai/zen/v1/models) stopped advertising them — a request
  // answered "not available in the active live catalog".
  "deepseek-v4-flash-free",
  "mimo-v2.5-free",
  "hy3-free",
  "nemotron-3-ultra-free",
  "north-mini-code-free",
];

// Re-measured 2026-10-17 against https://opencode.ai/zen/v1/models: the ids
// below are the free entries the live catalog actually advertises now. The
// previous block (mimo-v2.5-free, hy3-free, nemotron-3-ultra-free,
// north-mini-code-free — measured 2026-07-14) is no longer advertised, so a
// request for them is rejected with "not available in the active live catalog".
const LIVE_FREE_MODELS_MISSING_FROM_CATALOG = [
  "big-pickle",
  "beam-free",
  "deepseek-v4.1-flash-free",
  "glm-5.3-flash-free",
  "jev-1.13-free",
  "longcat-2.5-preview-free",
  "mimo-v2.6-flash-free",
  "nemotron-3.5-lightning-free",
  "nemotron-3.5-super-vl-free",
  "space-bunny-free",
];

test("issue #6998: oc registry does not advertise delisted free-tier models", () => {
  const ids = modelIds();
  for (const delisted of DELISTED_FREE_MODELS) {
    assert.ok(
      !ids.includes(delisted),
      `oc registry still advertises delisted upstream model "${delisted}"`
    );
  }
});

test("issue #6998: oc registry advertises the current live free-tier models", () => {
  const ids = modelIds();
  for (const live of LIVE_FREE_MODELS_MISSING_FROM_CATALOG) {
    assert.ok(ids.includes(live), `oc registry is missing live upstream free-tier model "${live}"`);
  }
});
