// @vitest-environment jsdom
/**
 * Regression: "even with round-robin it doesn't switch — each account needs the
 * proxy bound on the row that OWNS it".
 *
 * `handleDistributeProxies` used to build the cross-row union of account ids and
 * PUT every entry to `connections[0]`. Accounts living on rows 2..N therefore
 * never received a proxy binding: at request time their `proxy` resolved to
 * null, every rotation key collapsed onto the shared ambient egress, and a
 * single 429 set the whole fleet aside — rotation could not change IP.
 *
 * Contract now: one PUT per connection row, carrying that row's own ids, with
 * the pool proxies still spread round-robin across the whole fleet.
 */
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars && typeof vars === "object" && "count" in vars ? `${vars.count} accounts` : key,
}));

const { default: NoAuthAccountCard } =
  await import("../../../src/shared/components/NoAuthAccountCard");

const PROVIDER_ID = "opencode";
const containers: Array<{ root: ReturnType<typeof createRoot>; el: HTMLDivElement }> = [];

const CONNECTIONS = [
  {
    id: "conn-a",
    provider: PROVIDER_ID,
    providerSpecificData: { fingerprints: ["a-1", "a-2"] },
  },
  {
    id: "conn-b",
    provider: PROVIDER_ID,
    providerSpecificData: { fingerprints: ["b-1"] },
  },
];

function stubFetch(putBodies: Array<{ url: string; body: Record<string, unknown> }>) {
  const mockFetch = vi.fn((url: string, init?: RequestInit) => {
    if (init?.method === "PUT") {
      putBodies.push({ url: String(url), body: JSON.parse(String(init.body)) });
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) } as Response);
    }
    if (String(url).includes("/api/settings/proxies")) {
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            items: [
              { id: "pool-1", status: "active" },
              { id: "pool-2", status: "active" },
              { id: "pool-3", status: "active" },
            ],
          }),
      } as Response);
    }
    if (String(url).includes("/api/providers")) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ connections: CONNECTIONS }),
      } as Response);
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve({}) } as Response);
  });
  vi.stubGlobal("fetch", mockFetch);
  return mockFetch;
}

function renderCard() {
  const el = document.createElement("div");
  document.body.appendChild(el);
  const root = createRoot(el);
  act(() => {
    root.render(
      <NoAuthAccountCard
        providerId={PROVIDER_ID}
        providerName="OpenCode"
        generateAccountId={() => "generated"}
      />
    );
  });
  containers.push({ root, el });
  return el;
}

async function waitFor(fn: () => boolean, timeoutMs = 3000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fn()) return;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  }
  throw new Error("waitFor timed out");
}

afterEach(() => {
  for (const { root, el } of containers.splice(0)) {
    act(() => root.unmount());
    el.remove();
  }
  vi.unstubAllGlobals();
});

describe("NoAuthAccountCard distribute proxies", () => {
  it("writes each row's own account ids to that row, with a proxy per account", async () => {
    const putBodies: Array<{ url: string; body: Record<string, unknown> }> = [];
    stubFetch(putBodies);
    const el = renderCard();

    await waitFor(() =>
      Array.from(el.querySelectorAll("button")).some((b) => b.textContent?.includes("Distribute"))
    );

    const distributeButton = Array.from(el.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Distribute")
    )!;
    await act(async () => {
      distributeButton.click();
    });

    await waitFor(() => putBodies.length === 2);

    const byUrl = new Map(
      putBodies.map(({ url, body }) => [
        url,
        (
          body.providerSpecificData as {
            accountProxies: Array<{ fingerprint: string; proxyId: string }>;
          }
        ).accountProxies,
      ])
    );

    // One write per owning row — never the union dumped into the first row.
    expect(putBodies.map((p) => p.url).sort()).toEqual([
      "/api/providers/conn-a",
      "/api/providers/conn-b",
    ]);
    expect(byUrl.get("/api/providers/conn-a")!.map((e) => e.fingerprint)).toEqual(["a-1", "a-2"]);
    expect(byUrl.get("/api/providers/conn-b")!.map((e) => e.fingerprint)).toEqual(["b-1"]);

    // Every account got a binding, and the round-robin cursor spans rows so the
    // first account of the second row does not repeat the last proxy of row A.
    const bindings = [...byUrl.values()].flat();
    expect(bindings.every((entry) => typeof entry.proxyId === "string")).toBe(true);
    expect(new Set(bindings.map((entry) => entry.proxyId))).toEqual(
      new Set(["pool-1", "pool-2", "pool-3"])
    );
    expect(bindings[2].proxyId).toBe("pool-3");
  });
});
