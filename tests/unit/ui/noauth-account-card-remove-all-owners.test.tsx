// @vitest-environment jsdom
/**
 * Regression: deleting a no-auth account whose fingerprint lives on MORE than
 * one connection row ("can't delete" symptom).
 *
 * The display grid is a deduped union across rows, but `handleRemoveAccount`
 * only stripped the fingerprint from the FIRST row found and silently ignored
 * failures (console.error only) — so when the same id was written onto 2+ rows
 * (the exact state the old union-write bug produced), one PUT left the other
 * copies behind, `fetchConnections()` re-rendered, and the chip came back.
 *
 * Contract now: every owning row must receive a PUT with the id stripped, and
 * a failed write must surface an error message instead of dying silently.
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

function stubConnections(
  connections: unknown[],
  putBodies?: Array<{ url: string; body: Record<string, unknown> }>,
  putOk = true
) {
  const mockFetch = vi.fn((url: string, init?: RequestInit) => {
    if (init?.method === "PUT") {
      if (putBodies && typeof init.body === "string") {
        putBodies.push({
          url: String(url),
          body: JSON.parse(init.body) as Record<string, unknown>,
        });
      }
      return Promise.resolve({ ok: putOk, json: () => Promise.resolve({}) } as Response);
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

describe("NoAuthAccountCard remove clears EVERY owning row", () => {
  it("PUTs the stripped fingerprint to every row that owns the id", async () => {
    const putBodies: Array<{ url: string; body: Record<string, unknown> }> = [];
    stubConnections(
      [
        {
          id: "conn-1",
          provider: PROVIDER_ID,
          providerSpecificData: { fingerprints: ["a-1", "z-9"], accountProxies: [] },
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

    await waitFor(() => putBodies.length >= 2);
    const urls = putBodies.map((p) => p.url).sort();
    expect(urls).toEqual(["/api/providers/conn-1", "/api/providers/conn-2"]);
    for (const p of putBodies) {
      const fingerprints = (p.body.providerSpecificData as { fingerprints?: string[] })
        ?.fingerprints;
      expect(fingerprints).not.toContain("z-9");
    }
  });

  it("surfaces a visible error when the owning-row PUT fails", async () => {
    const putBodies: Array<{ url: string; body: Record<string, unknown> }> = [];
    stubConnections(
      [
        {
          id: "conn-1",
          provider: PROVIDER_ID,
          providerSpecificData: { fingerprints: ["z-9"], accountProxies: [] },
        },
      ],
      putBodies,
      false
    );
    const el = renderCard();
    await waitFor(() => grid(el)?.querySelectorAll("[data-account-id]").length === 1);

    const chip = Array.from(grid(el)!.querySelectorAll<HTMLElement>("[data-account-id]")).find(
      (n) => n.dataset.accountId === "z-9"
    )!;
    const deleteBtn = chip.querySelector<HTMLButtonElement>('button[aria-label="removeAccount"]')!;
    act(() => deleteBtn.dispatchEvent(new MouseEvent("click", { bubbles: true })));

    // The card must show a status message (not only console.error) — the
    // mocked t() renders keys verbatim, so any element carrying the
    // removeFailed key counts.
    await waitFor(() => {
      const text = el.textContent ?? "";
      return putBodies.length > 0 && text.includes("removeFailed");
    });
  });

  it("renders the remove button visible on touch devices (no hover to reveal it)", async () => {
    stubConnections([
      {
        id: "conn-1",
        provider: PROVIDER_ID,
        providerSpecificData: { fingerprints: ["z-9"], accountProxies: [] },
      },
    ]);
    const el = renderCard();
    await waitFor(() => grid(el)?.querySelectorAll("[data-account-id]").length === 1);

    const chip = Array.from(grid(el)!.querySelectorAll<HTMLElement>("[data-account-id]")).find(
      (n) => n.dataset.accountId === "z-9"
    )!;
    const removeBtn = chip.querySelector<HTMLButtonElement>('button[aria-label="removeAccount"]')!;
    expect(removeBtn).toBeTruthy();

    const cls = removeBtn.className;
    // Regression: the button used to be opacity-0 revealed ONLY by
    // group-hover — invisible for good on touch devices, which is where the
    // dashboard is actually used. It must now (a) stay discoverable on mouse
    // (faint base opacity, full on hover) and (b) be fully visible on
    // hover-less devices via the [@media(hover:none)] variant.
    expect(cls).toMatch(/opacity-40\b/);
    expect(cls).toMatch(/group-hover:opacity-100/);
    expect(cls).toMatch(/\[@media\(hover:none\)\]:opacity-100/);
    expect(cls).not.toMatch(/(^|[\s"])opacity-0([\s"]|$)/);
  });
});
