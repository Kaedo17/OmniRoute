import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// The free-model set is derived from TWO independent syncs: model availability
// (`syncedAvailableModels`, written by discovery) and cost (`models_dev_pricing`,
// written by the models.dev job). A deployment can have the first without the
// second — that is the state that used to 402 the entire opencode free tier.
const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-opencode-free-pricing-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";

const core = await import("../../src/lib/db/core.ts");
const contract = await import("../../open-sse/executors/opencodeFreeTierContract.ts");
const modelsDevSync = await import("../../src/lib/modelsDevSync.ts");

const SYNCED_KEY = "opencode:conn-regression";

function writeSyncedAvailability(ids: string[]): void {
  core
    .getDbInstance()
    .prepare(
      "INSERT OR REPLACE INTO key_value (namespace, key, value) VALUES ('syncedAvailableModels', ?, ?)"
    )
    .run(SYNCED_KEY, JSON.stringify(ids.map((id) => ({ id }))));
}

function clearSyncedAvailability(): void {
  core
    .getDbInstance()
    .prepare("DELETE FROM key_value WHERE namespace = 'syncedAvailableModels'")
    .run();
}

function syncedIds(): string[] {
  const row = core
    .getDbInstance()
    .prepare("SELECT value FROM key_value WHERE namespace = 'syncedAvailableModels' AND key = ?")
    .get(SYNCED_KEY) as { value: string } | undefined;
  return row ? (JSON.parse(row.value) as { id: string }[]).map((m) => m.id) : [];
}

/** `null` clears both the test override and the version-keyed memo. */
function resetFreeCatalogMemo(): void {
  contract._setOpencodeFreeModelsForTests(null);
}

test.beforeEach(() => {
  clearSyncedAvailability();
  modelsDevSync.clearModelsDevPricing();
  resetFreeCatalogMemo();
});

test.after(() => {
  resetFreeCatalogMemo();
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("availability synced with an EMPTY pricing map does not 402 the free tier", () => {
  writeSyncedAvailability(["space-bunny-free", "big-pickle", "gpt-5"]);
  resetFreeCatalogMemo();

  // Guard the fixture itself: if the rows did not land, the assertion below would
  // pass for the wrong reason (empty availability also falls back to legacy).
  assert.deepEqual(syncedIds().sort(), ["big-pickle", "gpt-5", "space-bunny-free"]);

  // Before the fallback: every available id fell through the cost check, leaving an
  // EMPTY free set, which the gate read as "everything is premium" → HTTP 402.
  assert.equal(contract.isPremiumOpencodeModel("space-bunny-free", "opencode"), false);
  assert.equal(contract.isPremiumOpencodeModel("big-pickle", "opencode"), false);
  assert.equal(contract.isPremiumOpencodeModel("space-bunny-free", "opencode-zen"), false);
});

test("a synced catalog WITH pricing still gates paid models as premium", () => {
  writeSyncedAvailability(["space-bunny-free", "gpt-5"]);
  modelsDevSync.saveModelsDevPricing({
    opencode: {
      "space-bunny-free": { input: 0, output: 0 },
      "gpt-5": { input: 3, output: 15 },
    },
  });
  resetFreeCatalogMemo();

  assert.equal(contract.isPremiumOpencodeModel("space-bunny-free", "opencode"), false);
  assert.equal(contract.isPremiumOpencodeModel("gpt-5", "opencode"), true);
});

test("no synced catalog at all keeps the legacy suffix heuristic", () => {
  resetFreeCatalogMemo();

  assert.equal(contract.isPremiumOpencodeModel("anything-free", "opencode"), false);
  assert.equal(contract.isPremiumOpencodeModel("big-pickle", "opencode"), false);
  assert.equal(contract.isPremiumOpencodeModel("gpt-5", "opencode"), true);
});
