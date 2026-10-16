/**
 * liveServerAllowList — extract of the host/origin allow-list logic from
 * `src/server/ws/liveServer.ts`.
 *
 * Lives in its own module so unit tests can exercise it without booting the
 * full WebSocket server. The behaviour here MUST match the one used by the
 * connection handler exactly.
 *
 * Bug #1 (plans/2026-06-23-omniroute-v3.8.34-deep-audit.md) added the
 * `LIVE_WS_ALLOWED_HOSTS` opt-in for LAN/Tailscale deployments.
 */

const DEFAULT_HOST = "127.0.0.1";

/**
 * Default origins allowed to open a WebSocket against the local dashboard.
 * These match the historical loopback HTTP listener at port 20128.
 *
 * NOTE: `buildAllowedOrigins()` additionally derives loopback origins for the
 * CONFIGURED dashboard port (DASHBOARD_PORT / PORT / OMNIROUTE_PORT), so a
 * custom `PORT` does not lock the dashboard out of its own LiveWS. This frozen
 * constant stays 20128-only for backward compatibility and tests.
 */
export const DEFAULT_ALLOWED_ORIGINS: readonly string[] = Object.freeze([
  "http://127.0.0.1:20128",
  "http://localhost:20128",
  "http://[::1]:20128",
  // 0.0.0.0 is the "unspecified" address but browsers treat it as loopback
  // when the user pastes it into the address bar; the dashboard is reachable
  // at http://0.0.0.0:20128 and its WS Origin is exactly that string. Same
  // local-only posture as the entries above — it never refers to a LAN host.
  "http://0.0.0.0:20128",
]);

/**
 * Loopback host spellings a browser may use for the dashboard Origin header.
 * `[::1]` keeps its brackets because that is how it appears in an Origin URL.
 */
const LOOPBACK_ORIGIN_HOSTS: readonly string[] = Object.freeze([
  "127.0.0.1",
  "localhost",
  "0.0.0.0",
  "[::1]",
]);

/**
 * Port the dashboard is served on. Prefers the dashboard/HTTP port so a
 * non-default `PORT` (e.g. 20129) is covered by the loopback allow-list —
 * otherwise every LiveWS upgrade from the dashboard is rejected with
 * FORBIDDEN_ORIGIN. Falls back to the historical default 20128.
 */
function resolveDashboardPort(env: NodeJS.ProcessEnv): string {
  const raw = env.DASHBOARD_PORT || env.PORT || env.OMNIROUTE_PORT || "";
  const trimmed = String(raw).trim();
  return /^\d+$/.test(trimmed) ? trimmed : "20128";
}

/**
 * Loopback origins for the resolved dashboard port. Returns [] for the default
 * port (already covered by DEFAULT_ALLOWED_ORIGINS) so the set stays identical
 * to the historical behaviour when PORT is unset/20128.
 */
function loopbackOriginsForPort(env: NodeJS.ProcessEnv): string[] {
  const port = resolveDashboardPort(env);
  if (port === "20128") return [];
  return LOOPBACK_ORIGIN_HOSTS.map((host) => `http://${host}:${port}`);
}

/**
 * Parse a comma-separated env value into a set of trimmed, non-empty entries.
 * Centralized so tests can exercise empty / whitespace / dup behaviour.
 */
export function parseCsvEnv(value: string | undefined | null): Set<string> {
  return new Set(
    (value ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
  );
}

/**
 * Build the static origin allow-list from defaults + the resolved dashboard
 * port's loopback origins + LIVE_WS_ALLOWED_ORIGINS.
 */
export function buildAllowedOrigins(env: NodeJS.ProcessEnv = process.env): Set<string> {
  const extra = parseCsvEnv(env.LIVE_WS_ALLOWED_ORIGINS);
  return new Set([...DEFAULT_ALLOWED_ORIGINS, ...loopbackOriginsForPort(env), ...extra]);
}

/**
 * Build the host-based allow-list (LAN/Tailscale extension).
 */
export function buildAllowedHosts(env: NodeJS.ProcessEnv = process.env): Set<string> {
  return parseCsvEnv(env.LIVE_WS_ALLOWED_HOSTS);
}

/**
 * Parse the host portion of an Origin URL.
 *
 * Returns `null` when the input is not a well-formed absolute URL — callers
 * should treat `null` as "not a match".
 */
export function originHost(origin: string): { host: string; hostname: string } | null {
  try {
    const url = new URL(origin);
    return { host: url.host, hostname: url.hostname };
  } catch {
    return null;
  }
}

/**
 * Whether the given Origin's host (or `host:port`) is in the host
 * allow-list. Returns false when the list is empty.
 */
export function originHostMatches(origin: string, allowedHosts: Set<string>): boolean {
  if (allowedHosts.size === 0) return false;
  const parsed = originHost(origin);
  if (!parsed) return false;
  return allowedHosts.has(parsed.host) || allowedHosts.has(parsed.hostname);
}

/**
 * Top-level Origin allow decision. The contract:
 *
 *   - When `origin` is undefined (no Origin header, e.g. CLI/MCP), we only
 *     accept the request when the WS listener is bound to loopback. This
 *     prevents drive-by LAN clients from omitting Origin to bypass the
 *     browser-side check.
 *
 *   - When `origin` is present, we accept it if it matches an entry in the
 *     static origin list (defaults + LIVE_WS_ALLOWED_ORIGINS) or if its
 *     host matches an entry in the LAN allow-list (LIVE_WS_ALLOWED_HOSTS).
 */
export function isOriginAllowed(
  origin: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
  options: { allowedOrigins?: Set<string>; allowedHosts?: Set<string> } = {}
): boolean {
  const allowedOrigins = options.allowedOrigins ?? buildAllowedOrigins(env);
  const allowedHosts = options.allowedHosts ?? buildAllowedHosts(env);

  if (!origin) {
    const host = env.LIVE_WS_HOST || DEFAULT_HOST;
    return host === "127.0.0.1" || host === "::1" || host === "localhost";
  }
  if (allowedOrigins.has(origin)) return true;
  if (originHostMatches(origin, allowedHosts)) return true;
  return false;
}
