/**
 * Merge a no-auth provider connection row's `fingerprints` / `accountProxies`
 * into the request-ready `providerSpecificData` picture.
 *
 * Fork fix (rotation collapsed onto one egress): the merge used to be
 * first-wins PER FIELD, so `fingerprints` could be taken from row A while
 * `accountProxies` came from row B. The executor then resolved every
 * `proxyMap.get(fingerprint)` to `undefined` and each account fell back to the
 * connection's shared ambient egress. Because the rotation key of a proxy-less
 * account IS that shared ambient key (`keyOfMember` in opencodeEgressThrottle),
 * a single 429 set the whole fleet aside and no rotation could ever change IP.
 *
 * Both lists are now unioned by identity (first occurrence wins, duplicates
 * dropped): every account keeps the proxy bound to it on its own row, and
 * accounts living on a sibling connection row still join the rotation fleet.
 */
type JsonRecord = Record<string, unknown>;

function fingerprintOf(entry: unknown): string | null {
  if (!entry || typeof entry !== "object") return null;
  const fp = (entry as { fingerprint?: unknown }).fingerprint;
  return typeof fp === "string" && fp ? fp : null;
}

export function mergeNoAuthProviderSpecificData(
  hydrated: JsonRecord,
  conn: { providerSpecificData?: unknown }
): void {
  const psd = conn.providerSpecificData;
  if (!psd || typeof psd !== "object") return;
  const record = psd as JsonRecord;

  if (Array.isArray(record.fingerprints)) {
    const merged: unknown[] = Array.isArray(hydrated.fingerprints)
      ? [...hydrated.fingerprints]
      : [];
    const seen = new Set(merged.filter((v): v is string => typeof v === "string"));
    for (const fp of record.fingerprints) {
      if (typeof fp !== "string" || !fp || seen.has(fp)) continue;
      seen.add(fp);
      merged.push(fp);
    }
    hydrated.fingerprints = merged;
  }

  if (Array.isArray(record.accountProxies)) {
    const merged: unknown[] = Array.isArray(hydrated.accountProxies)
      ? [...hydrated.accountProxies]
      : [];
    const seen = new Set<string>();
    for (const entry of merged) {
      const fp = fingerprintOf(entry);
      if (fp) seen.add(fp);
    }
    for (const entry of record.accountProxies) {
      const fp = fingerprintOf(entry);
      if (fp === null || seen.has(fp)) continue;
      seen.add(fp);
      merged.push(entry);
    }
    hydrated.accountProxies = merged;
  }
}
