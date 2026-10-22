import { describe, it } from "node:test";
import assert from "node:assert";
import { countDistinctEgress } from "../../open-sse/executors/accountRotation.ts";

/**
 * Backs the executor's rotation diagnostic: N accounts behind one address is a
 * no-op rotation on a 429, because the refusal is set aside against the shared
 * egress key and takes the whole fleet out at once.
 */
describe("countDistinctEgress", () => {
  const proxy = (host: string, port = 1080) => ({ type: "socks5", host, port });

  it("returns 1 when every account shares one proxy", () => {
    const accounts = [
      { proxy: proxy("10.0.0.1") },
      { proxy: proxy("10.0.0.1") },
      { proxy: proxy("10.0.0.1") },
    ];
    assert.strictEqual(countDistinctEgress(accounts), 1);
  });

  it("counts one key per distinct host:port", () => {
    const accounts = [
      { proxy: proxy("10.0.0.1") },
      { proxy: proxy("10.0.0.2") },
      { proxy: proxy("10.0.0.1") },
    ];
    assert.strictEqual(countDistinctEgress(accounts), 2);
  });

  it("treats the same host on a different port as a different egress", () => {
    const accounts = [{ proxy: proxy("10.0.0.1", 1080) }, { proxy: proxy("10.0.0.1", 1081) }];
    assert.strictEqual(countDistinctEgress(accounts), 2);
  });

  it("collapses proxy-less accounts onto the shared ambient egress", () => {
    const accounts = [{ proxy: null }, { proxy: null }, { proxy: null }];
    assert.strictEqual(countDistinctEgress(accounts), 1);
  });

  it("separates direct members from proxied ones", () => {
    const accounts = [{ proxy: null }, { proxy: proxy("10.0.0.1") }];
    assert.strictEqual(countDistinctEgress(accounts), 2);
  });
});
