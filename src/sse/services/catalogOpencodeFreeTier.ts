/**
 * catalogOpencodeFreeTier.ts — scope the public `oc/` block to the free tier.
 *
 * OpenCode's no-auth alias publishes `oc/<model>` for every model the upstream
 * advertises (139 rows when last measured), so the catalog listed paid ids the anonymous
 * lane cannot serve alongside the genuinely free ones. The operator's rule is narrower:
 *
 *   1. **only free** — a row survives when its bare id is BOTH on the base URL
 *      (`https://opencode.ai/zen/v1/models`, what discovery persists into
 *      `syncedAvailableModels`) AND free under `isPremiumOpencodeModel`. Intersecting
 *      with the synced list is what drops ids upstream has delisted: the `-free` suffix
 *      rule alone keeps stale entries (a retired `muse-spark-*-contributor-free` still
 *      ends in `-free`), which is measured, not hypothetical — the registry's static
 *      model list carried 7 free ids the live base URL no longer serves.
 *   2. **owned_by "omniroute"** — the surviving rows are grouped under `omniroute` in
 *      `GET /v1/models` rather than under `opencode`, so the free pool reads as its own
 *      provider in every client that groups by `owned_by`.
 *   3. **one row per model** — discovery makes the synced-models loop emit a canonical
 *      `opencode/<model>` mirror beside each `oc/<model>` alias (it was absent while the
 *      synced list was empty), so every free model was listed twice under two different
 *      owner names. A canonical row whose `oc/` sibling is present is dropped; a canonical
 *      row with no alias sibling is an independent entry and is left alone.
 *
 * The rule is applied to the alias AS A SEGMENT, not as a string prefix, so presentation
 * variants that wrap the alias (`no-think/oc/<model>`, minted by the no-thinking pass)
 * inherit it: a dropped base model takes its mirror with it rather than leaving an orphaned
 * paid row advertised under a free-tier provider identity.
 *
 * Degradation: when discovery has never run on a fresh install the synced list is EMPTY,
 * and intersecting against it would publish ZERO free rows. Falling back to the free rule
 * alone keeps the block populated until discovery lands; once the list is non-empty the
 * intersection (and therefore "exactly what the base URL serves") takes over. This mirrors
 * the fallback `isPremiumOpencodeModel` already makes for an unsynced catalog.
 *
 * Scoping: this rewrites the CATALOG ONLY. `oc/<model>` routing, credential lookup and
 * dispatch are untouched — a paid id disappearing from `GET /v1/models` still resolves if
 * a client names it directly.
 *
 * Placement: this lives in the service layer, not beside the catalog it filters, because
 * G14 (eslint.config.mjs) forbids `src/app/**` from importing `open-sse/executors/**`
 * directly — the app layer must delegate through a handler or service. The service layer
 * is the boundary that is allowed to reach the executor's free-tier contract.
 */
import { readSyncedOpencodeFamilyModelIds } from "@/lib/db/models";
import { isPremiumOpencodeModel } from "@omniroute/open-sse/executors/opencodeFreeTierContract.ts";

/** The routing alias segment that marks a model as the OpenCode no-auth pool. */
export const OPENCODE_NOAUTH_ALIAS = "oc";

/** Routing alias prefix form: `oc/<model>`. */
export const OPENCODE_NOAUTH_PREFIX = `${OPENCODE_NOAUTH_ALIAS}/`;

/**
 * The family's canonical provider id — the segment the synced-models loop uses when it
 * emits a canonical mirror (`opencode/<model>`) alongside the alias row. Distinct from
 * `opencode-zen` / `opencode-go`, which are separate keyed gateways this module never touches.
 */
export const OPENCODE_CANONICAL_ID = "opencode";

/** Public owner identity the surviving free rows are regrouped under. */
export const OPENCODE_FREE_OWNER = "omniroute";

type CatalogRow = Record<string, any>;

/** The external lookups the scoping rule needs, so the core stays pure. */
export interface OpencodeFreeTierSources {
  /** Bare ids the base URL currently serves. Empty = discovery has not run. */
  available: ReadonlySet<string>;
  /** Whether a bare id is premium (true) or free (false) under the free-tier contract. */
  isPremium: (bareId: string) => boolean;
}

/**
 * The OpenCode family ids a catalog row can carry, and which role it plays.
 *
 * - `role: "alias"` — the `oc/<model>` no-auth routing alias.
 * - `role: "canonical"` — the `opencode/<model>` canonical id that the synced-models loop
 *   emits as a MIRROR of an alias row (it sets `parent: aliasId`), not an independent entry.
 *
 * Matching is by PATH SEGMENT rather than string prefix because presentation wrappers
 * insert segments in front: the no-thinking pass emits `no-think/oc/<model>` for every
 * advertised `oc/` model. A prefix match would miss those, leaving an orphaned
 * `no-think/oc/<paid-model>` behind once its base row is dropped.
 */
interface OpenCodeFamilyId {
  role: "alias" | "canonical";
  bare: string;
}

function openCodeFamilyIdOf(row: CatalogRow): OpenCodeFamilyId | null {
  const id = typeof row?.id === "string" ? row.id : "";
  if (!id) return null;
  const segments = id.split("/");
  const aliasAt = segments.indexOf(OPENCODE_NOAUTH_ALIAS);
  const at = aliasAt !== -1 ? aliasAt : segments.indexOf(OPENCODE_CANONICAL_ID);
  if (at === -1) return null;
  const bare = segments[at + 1] ?? "";
  if (bare.length === 0) return null;
  return { role: aliasAt !== -1 ? "alias" : "canonical", bare };
}

/**
 * Whether a bare id is on the base URL's current model list.
 *
 * An empty set means discovery has not run — treated as "unknown", not as "nothing
 * qualifies", so a fresh install still shows its free models (see the block comment).
 */
function onBaseUrl(bareId: string, available: ReadonlySet<string>): boolean {
  if (available.size === 0) return true;
  return available.has(bareId);
}

/**
 * Scope the OpenCode family rows to the free tier and regroup them under `omniroute`.
 *
 * - `oc/<model>` alias rows survive only when the model is free AND on the base URL, and are
 *   relabelled `owned_by: "omniroute"`.
 * - `opencode/<model>` canonical mirrors are DROPPED when their `oc/<model>` sibling is also
 *   present: it is the same model under a second id, so keeping both advertised the free pool
 *   twice — once under `omniroute`, once under `opencode`. A canonical row with no alias
 *   sibling is an independent entry and passes through untouched.
 *
 * Pure: rows are copied, never mutated, so callers can compose and test it freely.
 * Unrelated rows pass through untouched, in order.
 */
export function applyOpencodeFreeTierCatalogWithSources(
  models: CatalogRow[],
  sources: OpencodeFreeTierSources
): CatalogRow[] {
  if (!Array.isArray(models) || models.length === 0) return models;

  // Pass 1: which bare ids are represented by an `oc/` alias row? Membership in this set is
  // what marks a canonical row as a redundant mirror rather than an independent entry.
  const aliasSiblings = new Set<string>();
  for (const row of models) {
    const family = openCodeFamilyIdOf(row);
    if (family?.role === "alias") aliasSiblings.add(family.bare);
  }

  const kept: CatalogRow[] = [];
  for (const row of models) {
    const family = openCodeFamilyIdOf(row);
    if (family === null) {
      kept.push(row);
      continue;
    }
    if (family.role === "canonical") {
      if (aliasSiblings.has(family.bare)) continue; // redundant mirror of an oc/ row
      kept.push(row);
      continue;
    }
    if (!onBaseUrl(family.bare, sources.available)) continue;
    if (sources.isPremium(family.bare)) continue;
    kept.push({ ...row, owned_by: OPENCODE_FREE_OWNER });
  }
  return kept;
}

/**
 * Production wrapper: read the synced base-URL list and the free-tier predicate, then
 * delegate to the pure core. A missing DB (unit test / early boot) degrades to the
 * free rule alone rather than blanking the block.
 */
export function applyOpencodeFreeTierCatalog(models: CatalogRow[]): CatalogRow[] {
  let available: ReadonlySet<string>;
  try {
    available = readSyncedOpencodeFamilyModelIds();
  } catch {
    available = new Set<string>();
  }
  return applyOpencodeFreeTierCatalogWithSources(models, {
    available,
    isPremium: (bareId) => isPremiumOpencodeModel(bareId, "opencode"),
  });
}
