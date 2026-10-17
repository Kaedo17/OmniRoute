import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isFreeModel, providerHasFreeModels } from "../../src/shared/utils/freeModels.ts";

describe("isFreeModel isFree opt-in", () => {
  it("isFree:true fetched → free only for a provider with a documented free tier", async () => {
    const { FREE_MODEL_BUDGETS } = await import("@omniroute/open-sse/config/freeModelCatalog");
    const freeProvider = FREE_MODEL_BUDGETS[0].provider;
    assert.equal(isFreeModel("any", { id: "x", isFree: true }), false);
    assert.equal(isFreeModel("local", { id: "my-model", isFree: true }), false);
    assert.equal(isFreeModel(freeProvider, { id: "x", isFree: true }), true);
  });
  it("isFree:false/null/undefined/1/'true' → not free (strict ===true)", () => {
    const junk: unknown[] = [false, null, undefined, 1, "true"];
    for (const v of junk) {
      assert.equal(
        isFreeModel("any", { id: "x", isFree: v as boolean }),
        false,
        `isFree=${String(v)} should be false`
      );
    }
  });
  it("providerHasFreeModels unchanged by custom isFree", () => {
    assert.equal(providerHasFreeModels("local"), false);
    assert.equal(providerHasFreeModels("openai"), providerHasFreeModels("openai"));
  });
  it(":free and pricing 0 still work when isFree absent — only for free-tier providers", async () => {
    const { FREE_MODEL_BUDGETS } = await import("@omniroute/open-sse/config/freeModelCatalog");
    const freeProvider = FREE_MODEL_BUDGETS[0].provider;
    assert.equal(isFreeModel("any", { id: "foo:free" }), false);
    assert.equal(isFreeModel("local", { id: "foo", pricing: { prompt: 0, completion: 0 } }), false);
    assert.equal(isFreeModel(freeProvider, { id: "foo:free" }), true);
    assert.equal(
      isFreeModel(freeProvider, { id: "foo", pricing: { prompt: 0, completion: 0 } }),
      true
    );
    assert.equal(isFreeModel("any", { id: "foo", pricing: { prompt: 0, completion: 1 } }), false);
  });
  it("selectModelsForImport matches isFreeForProvider on every catalogued free model", async () => {
    // FREE_MODEL_IDS_BY_PROVIDER is module-private, so rebuild (provider, id) pairs from the
    // exported FREE_MODEL_BUDGETS: every budgeted provider has a documented free tier.
    const { FREE_MODEL_BUDGETS } = await import("@omniroute/open-sse/config/freeModelCatalog");
    const { selectModelsForImport, isFreeForProvider } =
      await import("../../src/shared/utils/freeModels.ts");
    for (const { provider } of FREE_MODEL_BUDGETS) {
      const m = { id: `${provider}/probe-lock`, pricing: { prompt: 0, completion: 0 } };
      const expected = isFreeForProvider(provider, m);
      const { models } = selectModelsForImport(provider, [m], true);
      assert.equal(models.length, expected ? 1 : 0, `${provider}/probe-lock`);
    }
  });
  it("selectModelsForImport drops zero-price models on providers without documented free tier", async () => {
    // "local" has no documented free tier, so its zero-price model is not free.
    const { selectModelsForImport, providerHasFreeModels } =
      await import("../../src/shared/utils/freeModels.ts");
    assert.equal(providerHasFreeModels("local"), false);
    const { models, freeFilterEmpty } = selectModelsForImport(
      "local",
      [{ id: "local/x", pricing: { prompt: 0, completion: 0 } }],
      true
    );
    assert.deepEqual(models, []);
    assert.equal(freeFilterEmpty, true);
  });
});

describe("isFreeModel honours the hyphenated -free id suffix", () => {
  // Regression guard: OpenCode marks free models with `-free` (not OpenRouter's `:free`)
  // and its /models payload carries only `{ id, name }` — no pricing, no `free` flag, no
  // tags. `hasPayloadFreeEvidence` therefore returned false for every one of them, so the
  // free-only sync imported 1 of 10 free models (only the catalogued `big-pickle`) and the
  // synced availability list needed to scope the `oc/` catalog ended up incomplete.
  it("accepts a bare { id, name } -free payload on a provider with a documented free tier", () => {
    assert.equal(providerHasFreeModels("opencode"), true, "precondition");
    assert.equal(
      isFreeModel("opencode", { id: "glm-5.3-flash-free", name: "glm-5.3-flash-free" }),
      true
    );
    assert.equal(isFreeModel("oc", { id: "beam-free" }), true, "alias resolves to opencode");
    assert.equal(isFreeModel("opencode", { id: "space-bunny-free" }), true);
  });

  it("rejects paid opencode ids even when they belong to the same payload", () => {
    assert.equal(isFreeModel("opencode", { id: "claude-opus-5", name: "claude-opus-5" }), false);
    assert.equal(isFreeModel("opencode", { id: "gpt-5.6-luna" }), false);
    assert.equal(isFreeModel("opencode", { id: "test" }), false);
  });

  it("does NOT grant free access on a provider without a documented free tier", () => {
    // opencode-go has no free tier — the suffix alone must not override that.
    assert.equal(providerHasFreeModels("opencode-go"), false, "precondition");
    assert.equal(isFreeModel("opencode-go", { id: "glm-5.3-flash-free" }), false);
    assert.equal(isFreeModel("local", { id: "some-model-free" }), false);
    assert.equal(isFreeModel("any", { id: "some-model-free" }), false);
  });

  it("requires a model name before the suffix", () => {
    assert.equal(isFreeModel("opencode", { id: "-free" }), false, "suffix alone is not an id");
    assert.equal(isFreeModel("opencode", { id: "" }), false);
  });
});
