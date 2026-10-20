import assert from "node:assert/strict";
import { test } from "node:test";

import { FEATURE_FLAG_DEFINITIONS } from "../../src/shared/constants/featureFlagDefinitions.ts";

/**
 * Fork resilience defaults (rate-limit fix).
 *
 * The free tier rate-limits per egress IP (#9611): one 429 burst marks every
 * fingerprint account at once, and with both resilience flags off the last
 * upstream 429 is surfaced raw to the client — the "rate limit error even
 * though lots of accounts are made" report. This fork therefore flips
 * OPENCODE_PARK_AND_RESUME and OPENCODE_POOL_RESELECT to default-on (both
 * overridable via env/DB per the usual priority chain), while keeping
 * OPENCODE_RATE_LIMITED_429_EARLY_STOP off: that one SURFACES a classified
 * rate-limit 429 early, which is exactly the behavior being avoided.
 */
test("OPENCODE_PARK_AND_RESUME defaults to on in this fork", () => {
  const def = FEATURE_FLAG_DEFINITIONS.find((d) => d.key === "OPENCODE_PARK_AND_RESUME");
  assert.ok(def, "definition must exist");
  assert.equal(def.defaultValue, "true");
  assert.equal(def.category, "network");
  assert.equal(def.requiresRestart, false);
});

test("OPENCODE_POOL_RESELECT defaults to on in this fork", () => {
  const def = FEATURE_FLAG_DEFINITIONS.find((d) => d.key === "OPENCODE_POOL_RESELECT");
  assert.ok(def, "definition must exist");
  assert.equal(def.defaultValue, "true");
  assert.equal(def.category, "network");
  assert.equal(def.requiresRestart, false);
});

test("OPENCODE_RATE_LIMITED_429_EARLY_STOP stays opt-in (it surfaces the 429)", () => {
  const def = FEATURE_FLAG_DEFINITIONS.find(
    (d) => d.key === "OPENCODE_RATE_LIMITED_429_EARLY_STOP"
  );
  assert.ok(def, "definition must exist");
  assert.equal(def.defaultValue, "false");
  assert.match(def.description, /Off by default/);
});

test("park/reselect descriptions document the fork-on default", () => {
  const park = FEATURE_FLAG_DEFINITIONS.find((d) => d.key === "OPENCODE_PARK_AND_RESUME");
  const reselect = FEATURE_FLAG_DEFINITIONS.find((d) => d.key === "OPENCODE_POOL_RESELECT");
  for (const def of [park, reselect]) {
    assert.ok(def && def.description.includes("On by default in this fork"), def?.key ?? "");
    assert.ok(!/\bOff by default/.test(def.description), `${def.key} description still says off`);
  }
});
