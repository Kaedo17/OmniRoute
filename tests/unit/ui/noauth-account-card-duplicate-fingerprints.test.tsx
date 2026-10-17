// @vitest-environment jsdom
/**
 * Regression: duplicated account fingerprints in NoAuthAccountCard.
 *
 * A no-auth provider accumulates rows whose `providerSpecificData.fingerprints`
 * overlap (sibling providers share state, and the add path used to write the
 * union of every row back into one row). The grid must render one node per
 * UNIQUE id (duplicate ids produced "two children with the same key" warnings
 * and an inflated count), and add/remove must touch only the owning row.
 *
 * NOTE: tests/unit/ui/noauth-account-card.test.tsx is excluded from the vitest
 * config (pre-existing failure, #8618), so this guard lives in its own file.
 */
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, it, expect, vi, afterEach } from "vitest";

// The component calls useTranslations() directly; mock the hook so no
// NextIntlClientProvider is needed and label assertions stay deterministic.
vi.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars && typeof vars === "object" && "count" in vars ? `${vars.count} accounts` : key,
}));

const { default: NoAuthAccountCard } =
  await import("../../../src/shared/components/NoAuthAccountCard");

const PROVIDER_ID = "opencode";
const containers: Array<{ root: ReturnType<typeof createRoot>; el: HTMLDivElement }> = [];

function stubConnections(connections: unknown[], putBodies?: Array<Record<string, unknown>>) {
  const mockFetch = vi.fn((url: string, init?: RequestInit) => {
    if (init?.method === "PUT") {
      if (putBodies && typeof init.body === "string") {
        putBodies.push(JSON.parse(init.body) as Record<string, unknown>);
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) } as Response);
    }
    if (String(url).includes("/api/providers")) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ connections }),
      } as Response);
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve({}) } as Response);
  });
  vi.stubGlobal("fetch", mockFetch);
  return mockFetch;
}

function renderCard(props: Partial<React.ComponentProps<typeof NoAuthAccountCard>> = {}) {
  const el = document.createElement("div");
  document.body.appendChild(el);
  const root = createRoot(el);
  let counter = 0;
  act(() => {
    root.render(
      <NoAuthAccountCard
        providerId={PROVIDER_ID}
        providerName="OpenCode"
        generateAccountId={() => `gen-${counter++}`}
        {...props}
      />
    );
  });
  containers.push({ root, el });
  return el;
}

const grid = (el: HTMLElement) =>
  el.querySelector<HTMLElement>("[data-testid='noauth-account-grid']");

const chipIds = (el: HTMLElement) =>
  Array.from(grid(el)!.querySelectorAll<HTMLElement>("[data-account-id]")).map(
    (n) => n.dataset.accountId ?? ""
  );

async function waitFor(fn: () => boolean, timeoutMs = 3000) {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}

afterEach(() => {
  for (const { root, el } of containers.splice(0)) {
    act(() => root.unmount());
    el.remove();
  }
  vi.unstubAllGlobals();
});

describe("NoAuthAccountCard duplicate fingerprints", () => {
  it("renders one chip per UNIQUE fingerprint when ids repeat across rows", async () => {
    stubConnections([
      {
        id: "conn-1",
        provider: PROVIDER_ID,
        providerSpecificData: { fingerprints: ["a-1", "b-2", "c-3"], accountProxies: [] },
      },
      {
        id: "conn-2",
        provider: PROVIDER_ID,
        providerSpecificData: {
          fingerprints: ["a-1", "b-2", "c-3", "d-4", "a-1", "b-2"],
          accountProxies: [],
        },
      },
    ]);
    const el = renderCard();
    await waitFor(() => grid(el) !== null);

    const ids = chipIds(el);
    // No duplicate ids → no duplicate React keys; count is the unique set.
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual(["a-1", "b-2", "c-3", "d-4"]);
  });

  it("adds a new account to the target row's OWN ids, not the union across rows", async () => {
    const putBodies: Array<Record<string, unknown>> = [];
    stubConnections(
      [
        {
          id: "conn-1",
          provider: PROVIDER_ID,
          providerSpecificData: { fingerprints: ["a-1"], accountProxies: [] },
        },
        {
          id: "conn-2",
          provider: PROVIDER_ID,
          providerSpecificData: { fingerprints: ["z-9"], accountProxies: [] },
        },
      ],
      putBodies
    );
    const el = renderCard({ addLabel: "Add account" });
    await waitFor(() => grid(el)?.querySelectorAll("[data-account-id]").length === 2);

    const addBtn = Array.from(el.querySelectorAll("button")).find((b) =>
      (b.textContent ?? "").includes("Add account")
    )!;
    act(() => addBtn.dispatchEvent(new MouseEvent("click", { bubbles: true })));

    await waitFor(() => putBodies.length > 0);
    const body = putBodies.at(-1) as { providerSpecificData?: { fingerprints?: string[] } };
    // conn-1's own id + the new one; conn-2's "z-9" must NOT leak in.
    expect(body.providerSpecificData?.fingerprints).toEqual(["a-1", "gen-0"]);
  });

  it("removes an account from the row that owns it", async () => {
    const putBodies: Array<Record<string, unknown>> = [];
    stubConnections(
      [
        {
          id: "conn-1",
          provider: PROVIDER_ID,
          providerSpecificData: { fingerprints: ["a-1"], accountProxies: [] },
        },
        {
          id: "conn-2",
          provider: PROVIDER_ID,
          providerSpecificData: { fingerprints: ["z-9"], accountProxies: [] },
        },
      ],
      putBodies
    );
    const el = renderCard();
    await waitFor(() => grid(el)?.querySelectorAll("[data-account-id]").length === 2);

    const chip = Array.from(grid(el)!.querySelectorAll<HTMLElement>("[data-account-id]")).find(
      (n) => n.dataset.accountId === "z-9"
    )!;
    const deleteBtn = chip.querySelector<HTMLButtonElement>('button[aria-label="removeAccount"]')!;
    act(() => deleteBtn.dispatchEvent(new MouseEvent("click", { bubbles: true })));

    await waitFor(() => putBodies.length > 0);
    const body = putBodies.at(-1) as { providerSpecificData?: { fingerprints?: string[] } };
    expect(body.providerSpecificData?.fingerprints).toEqual([]);
  });
});
