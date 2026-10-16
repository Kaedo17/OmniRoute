import { setUserAgentHeader } from "../executors/base.ts";
import { generateSessionId } from "../services/sessionManager.ts";
import { generateOpencodeSessionId, isValidOpencodeSessionId } from "./opencodeFingerprint.ts";

/**
 * Header keys that are forwarded from the client to the upstream provider.
 * Used by both OpencodeExecutor and DefaultExecutor.
 */
const OPENCODE_HEADER_KEYS = [
  "x-opencode-session",
  "x-opencode-project",
  "x-opencode-client",
] as const;

/**
 * OpenCode v2 CLI User-Agent shape: `opencode/<channel>/<version>/<client>`
 * (e.g. `opencode/latest/2.0.26/cli`). The free-tier gate has rejected the v1
 * `opencode/1.18.x` form in past waves, so only a v2-shaped downstream UA is
 * forwarded; anything else is replaced with the synthesized v2 default.
 * Mirrors 9router PR #4842.
 */
const OPENCODE_V2_UA_RE = /^opencode\/[a-z0-9-]+\/\d+\.\d+\.\d+\/[a-z0-9-]+$/i;

/**
 * Mirror the conversation session id into every header name the OpenCode v2
 * client sends. The free-tier gate has required all four to match in past
 * waves; values are forced equal to `x-opencode-session` so the mirror is
 * always consistent.
 */
function mirrorOpencodeSessionHeaders(headers: Record<string, string>): void {
  const session = headers["x-opencode-session"];
  if (!session) return;
  headers["x-opencode-session-id"] = session;
  headers["x-session-affinity"] = session;
  headers["x-session-id"] = session;
}

/**
 * Common agent-metadata headers used by non-OpenCode clients (custom agents/
 * providers) for upstream request tracking and attribution. Forwarded the same
 * way as the x-opencode-* set: case-insensitive lookup, client value wins.
 * Added for 9router#2413 — these were previously dropped for every client
 * outside the OpenCode allowlist.
 */
const AGENT_METADATA_HEADER_KEYS = ["x-session-id", "x-title"] as const;

/**
 * Case-insensitive lookup for a header in a headers record.
 */
function findHeader(headers: Record<string, string>, name: string): string | undefined {
  return Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
}

/**
 * Forward OpenCode client request metadata headers to the upstream provider.
 *
 * Shared logic used by OpencodeExecutor and DefaultExecutor:
 * 1. Forwards User-Agent from clientHeaders via `setUserAgentHeader()`
 * 2. Forwards x-opencode-session, x-opencode-project, x-opencode-client headers
 *    (case-insensitive match)
 * 3. Forwards x-session-id, x-title agent-metadata headers (case-insensitive
 *    match) — common conventions used by non-OpenCode agent clients (9router#2413)
 *
 * @param headers - The outbound headers record to mutate
 * @param clientHeaders - The client-provided headers to forward from
 * @param options.synthesizeRequestId - When true (OpencodeExecutor only), maps
 *   x-session-affinity / x-session-id to x-opencode-session when the latter is
 *   missing, and mirrors the session id into x-opencode-session-id /
 *   x-session-affinity / x-session-id (OpenCode v2 gate).
 * @param options.cliDefaults - When provided (OpencodeExecutor only), synthesize
 *   the OpenCode CLI identity headers that Cloudflare requires on VPS egress
 *   (User-Agent, x-opencode-client, x-opencode-project) plus a conversation
 *   session id, but ONLY for keys the client did not already supply. Client values
 *   always win; these defaults only fill gaps. User-Agent is the one exception: a
 *   client UA that is not already the OpenCode v2 CLI form
 *   (`opencode/<channel>/<version>/<client>`) is REPLACED with the synthesized v2
 *   UA, because opencode.ai's free tier rejects generic client UAs from datacenter
 *   IPs with FreeUsageLimitError 429. (#5997, follow-up #10229)
 * @param options.sessionBody - Request body fields used to generate a
 *   conversation-stable session fingerprint (model, system, messages, tools).
 *   When provided, x-opencode-session is a deterministic hash instead of a random
 *   UUID, so upstream prompt caching hits across requests in the same conversation.
 */
export function forwardOpencodeClientHeaders(
  headers: Record<string, string>,
  clientHeaders: Record<string, string>,
  options?: {
    synthesizeRequestId?: boolean;
    cliDefaults?: { userAgent: string; client: string; project: string };
    sessionBody?: {
      model?: string;
      system?: unknown;
      messages?: Array<{ role?: string; content?: unknown }>;
      tools?: Array<{ name?: string; function?: { name?: string } }>;
    };
  }
): void {
  // 1. Forward User-Agent
  const clientUA = clientHeaders["User-Agent"] || clientHeaders["user-agent"];
  if (clientUA) {
    setUserAgentHeader(headers, clientUA);
  }

  // 2. Forward x-opencode-* metadata headers
  for (const headerName of OPENCODE_HEADER_KEYS) {
    const value = findHeader(clientHeaders, headerName);
    if (value) {
      headers[headerName] = value;
    }
  }

  // 2b. Forward agent-metadata headers (x-session-id, x-title) — 9router#2413
  for (const headerName of AGENT_METADATA_HEADER_KEYS) {
    const value = findHeader(clientHeaders, headerName);
    if (value) {
      headers[headerName] = value;
    }
  }

  // 3. OpencodeExecutor-only: synthesize session/request id from fallback headers
  if (options?.synthesizeRequestId && !headers["x-opencode-session"]) {
    const sessionAffinity =
      findHeader(clientHeaders, "x-session-affinity") || findHeader(clientHeaders, "x-session-id");
    if (sessionAffinity) {
      headers["x-opencode-session"] = sessionAffinity;
    }
  }

  // 4. OpencodeExecutor-only: synthesize the OpenCode CLI identity Cloudflare expects
  //    on VPS egress, for any key the client did not supply (#5997).
  if (options?.cliDefaults) {
    applyCliDefaults(headers, options.cliDefaults, options.sessionBody);
  }

  // 5. OpencodeExecutor-only: make every session header mirror the conversation
  //    session id (v2 gate requirement — see mirrorOpencodeSessionHeaders).
  if (options?.synthesizeRequestId || options?.cliDefaults) {
    mirrorOpencodeSessionHeaders(headers);
  }
}

/**
 * Fill the OpenCode CLI identity headers Cloudflare requires on VPS egress. For
 * x-opencode-* headers, client values always win (defaults only fill gaps). The
 * User-Agent is the exception: a non-v2 client UA (curl, python, SDKs, or the v1
 * `opencode/1.18.x` / `opencode-cli/...` forms) is replaced with the synthesized
 * v2 CLI UA, because opencode.ai's free tier flags generic client UAs from
 * datacenter IPs (FreeUsageLimitError 429) and has rejected the v1 UA shape in
 * later waves. A client UA already in the v2 form is preserved so the real CLI's
 * versioned identity stays intact. (#5997, follow-up; v2: 9router PR #4842)
 */
function applyCliDefaults(
  headers: Record<string, string>,
  cliDefaults: { userAgent: string; client: string; project: string },
  sessionBody?: {
    model?: string;
    system?: unknown;
    messages?: Array<{ role?: string; content?: unknown }>;
    tools?: Array<{ name?: string; function?: { name?: string } }>;
  }
): void {
  const existingUa = headers["User-Agent"] || headers["user-agent"];
  const clientUaIsV2 = typeof existingUa === "string" && OPENCODE_V2_UA_RE.test(existingUa.trim());
  if (!clientUaIsV2) {
    setUserAgentHeader(headers, cliDefaults.userAgent);
  }
  headers["x-opencode-client"] ||= cliDefaults.client;
  headers["x-opencode-project"] ||= cliDefaults.project;
  // Session id must be a gate-valid `ses_...` id. Keep a valid client/CLI value;
  // otherwise translate any hint (or the conversation fingerprint) into one.
  const existingSession = headers["x-opencode-session"];
  if (!isValidOpencodeSessionId(existingSession)) {
    const seed = existingSession || generateSessionId(sessionBody ?? null) || undefined;
    headers["x-opencode-session"] = generateOpencodeSessionId(seed);
  }
}
