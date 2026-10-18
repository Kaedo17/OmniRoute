import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { preferDirectEgress } from "../../open-sse/executors/accountRotation.ts";

// OpenCode's free tier refuses the identical request with 403 FreeTierError when
// it egresses through a relay proxy and 200 through a direct account (measured
// 2026-10-18, accounts 48646bf0/5ef5a656 via omniroute-relay-*). The gated
// request ordering therefore must put direct accounts ahead of proxied ones.

type Account = { fingerprint: string; proxy: { host: string; port: number } | null };

const DIRECT = (fp: string): Account => ({ fingerprint: fp, proxy: null });
const RELAY = (fp: string, host: string): Account => ({
  fingerprint: fp,
  proxy: { host, port: 443 },
});

describe("preferDirectEgress", () => {
  it("moves relayed accounts behind direct ones, keeping tier order stable", () => {
    const accounts = [
      RELAY("r1", "relay-a.example"),
      DIRECT("d1"),
      RELAY("r2", "relay-b.example"),
      DIRECT("d2"),
    ];
    preferDirectEgress(accounts);
    assert.deepEqual(
      accounts.map((a) => a.fingerprint),
      ["d1", "d2", "r1", "r2"]
    );
  });

  it("is a no-op when every account already egresses direct", () => {
    const accounts = [DIRECT("d1"), DIRECT("d2")];
    preferDirectEgress(accounts);
    assert.deepEqual(
      accounts.map((a) => a.fingerprint),
      ["d1", "d2"]
    );
  });

  it("is a no-op when every account egresses through a relay", () => {
    const accounts = [RELAY("r1", "relay-a.example"), RELAY("r2", "relay-b.example")];
    preferDirectEgress(accounts);
    assert.deepEqual(
      accounts.map((a) => a.fingerprint),
      ["r1", "r2"]
    );
  });

  it("keeps a single direct account first ahead of the relay fleet", () => {
    const accounts = [RELAY("r1", "relay-a.example"), RELAY("r2", "relay-b.example"), DIRECT("d1")];
    preferDirectEgress(accounts);
    assert.equal(accounts[0]?.fingerprint, "d1");
  });

  it("does not drop accounts (direct and relayed tiers concatenate)", () => {
    const accounts = [
      DIRECT("d1"),
      RELAY("r1", "relay-a.example"),
      DIRECT("d2"),
      RELAY("r2", "relay-b.example"),
      DIRECT("d3"),
    ];
    preferDirectEgress(accounts);
    assert.equal(accounts.length, 5);
    assert.deepEqual(
      accounts.slice(0, 3).map((a) => a.fingerprint),
      ["d1", "d2", "d3"]
    );
    assert.deepEqual(
      accounts.slice(3).map((a) => a.fingerprint),
      ["r1", "r2"]
    );
  });
});
