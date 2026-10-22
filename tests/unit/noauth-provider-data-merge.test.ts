import { describe, it } from "node:test";
import assert from "node:assert";
import { mergeNoAuthProviderSpecificData } from "../../src/sse/services/noAuthProviderDataMerge.ts";

/**
 * Regression for the "rotation never switches account/proxy" report.
 *
 * The merge used to be first-wins PER FIELD: `fingerprints` could come from
 * row A while `accountProxies` came from row B. The executor then resolved
 * every `proxyMap.get(fingerprint)` to undefined, every account fell back to
 * the shared ambient egress, and one 429 set the whole fleet aside — so
 * rotating N accounts could never change IP.
 */
describe("mergeNoAuthProviderSpecificData", () => {
  it("keeps a proxy bound to its own fingerprint when they live on different rows", () => {
    const hydrated: Record<string, unknown> = {};

    mergeNoAuthProviderSpecificData(hydrated, {
      providerSpecificData: { fingerprints: ["acc-1", "acc-2"], accountProxies: [] },
    });
    mergeNoAuthProviderSpecificData(hydrated, {
      providerSpecificData: {
        fingerprints: [],
        accountProxies: [
          { fingerprint: "acc-1", proxy: { type: "socks5", host: "10.0.0.1", port: 1080 } },
          { fingerprint: "acc-2", proxy: { type: "socks5", host: "10.0.0.2", port: 1080 } },
        ],
      },
    });

    assert.deepStrictEqual(hydrated.fingerprints, ["acc-1", "acc-2"]);

    const byFingerprint = new Map(
      (hydrated.accountProxies as Array<{ fingerprint: string; proxy: { host: string } }>).map(
        (entry) => [entry.fingerprint, entry.proxy.host] as const
      )
    );
    assert.strictEqual(byFingerprint.get("acc-1"), "10.0.0.1");
    assert.strictEqual(byFingerprint.get("acc-2"), "10.0.0.2");
    // The regression: either account resolving to no proxy collapses rotation.
    assert.strictEqual(byFingerprint.size, 2);
  });

  it("unions accounts across connection rows and dedupes fingerprints", () => {
    const hydrated: Record<string, unknown> = {};

    mergeNoAuthProviderSpecificData(hydrated, {
      providerSpecificData: { fingerprints: ["a", "b"] },
    });
    mergeNoAuthProviderSpecificData(hydrated, {
      providerSpecificData: { fingerprints: ["b", "c"] },
    });
    mergeNoAuthProviderSpecificData(hydrated, {
      providerSpecificData: { fingerprints: ["c", "d"] },
    });

    assert.deepStrictEqual(hydrated.fingerprints, ["a", "b", "c", "d"]);
  });

  it("keeps the first proxy binding for a duplicated fingerprint", () => {
    const hydrated: Record<string, unknown> = {};

    mergeNoAuthProviderSpecificData(hydrated, {
      providerSpecificData: {
        fingerprints: ["a"],
        accountProxies: [{ fingerprint: "a", proxyId: "pool-first" }],
      },
    });
    mergeNoAuthProviderSpecificData(hydrated, {
      providerSpecificData: {
        fingerprints: ["a"],
        accountProxies: [{ fingerprint: "a", proxyId: "pool-second" }],
      },
    });

    assert.deepStrictEqual(hydrated.accountProxies, [{ fingerprint: "a", proxyId: "pool-first" }]);
  });

  it("ignores rows without a usable providerSpecificData", () => {
    const hydrated: Record<string, unknown> = { fingerprints: ["a"] };

    mergeNoAuthProviderSpecificData(hydrated, {});
    mergeNoAuthProviderSpecificData(hydrated, { providerSpecificData: null });
    mergeNoAuthProviderSpecificData(hydrated, { providerSpecificData: "nope" });

    assert.deepStrictEqual(hydrated.fingerprints, ["a"]);
    assert.strictEqual(hydrated.accountProxies, undefined);
  });

  it("drops non-object proxy entries instead of poisoning the fingerprint map", () => {
    const hydrated: Record<string, unknown> = {};

    mergeNoAuthProviderSpecificData(hydrated, {
      providerSpecificData: {
        fingerprints: ["a"],
        accountProxies: [null, "junk", { proxyId: "no-fingerprint" }, { fingerprint: "" }],
      },
    });

    assert.deepStrictEqual(hydrated.accountProxies, []);
  });
});
