/**
 * Ad-hoc live validation for the OpenCode free-tier fingerprint fix.
 *
 * Runs the REAL OpencodeExecutor request-shaping (transformRequest + buildHeaders
 * + buildUrl) against https://opencode.ai and prints the HTTP status. Before the
 * fix this returned 403 FreeTierError; after it returns 200.
 *
 * Run: DATA_DIR=$(mktemp -d) node --import tsx/esm scripts/ad-hoc/validate-opencode-free-tier.ts
 *
 * NOTE: OpenCode rate-limits/cooldowns free-tier traffic per IP after repeated
 * probes; while cooled down EVERY request (valid or not) returns 403 FreeTierError.
 * Run from a VPS/fresh IP when validating, and space probes out.
 */
import { OpencodeExecutor } from "../../open-sse/executors/opencode.ts";

type JsonRecord = Record<string, unknown>;

function toolNames(tools: unknown): string[] {
  if (!Array.isArray(tools)) return [];
  return tools.map((tool) => {
    const record = tool as JsonRecord;
    if (typeof record.name === "string") return record.name;
    const fn = record.function as JsonRecord | undefined;
    return typeof fn?.name === "string" ? fn.name : "";
  });
}

async function probe(label: string, provider: string, model: string, flat: boolean): Promise<void> {
  const executor = new OpencodeExecutor(provider);
  if (flat)
    (executor as unknown as { _requestFormat: string | null })._requestFormat = "openai-responses";
  const clientBody: JsonRecord = flat
    ? {
        model,
        stream: true,
        input: [{ role: "user", content: "Reply with the single word: pong" }],
        max_output_tokens: 64,
      }
    : {
        model,
        stream: true,
        messages: [{ role: "user", content: "Reply with the single word: pong" }],
        max_tokens: 64,
      };

  const transformed = executor.transformRequest(model, clientBody, true, {}) as JsonRecord;
  const headers = executor.buildHeaders(null, true, null, model, undefined, transformed);
  const url = executor.buildUrl(model, true);

  const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(transformed) });
  const text = await res.text();
  console.log(
    JSON.stringify(
      {
        label,
        url,
        status: res.status,
        tools: toolNames(transformed.tools),
        userAgent: headers["User-Agent"],
        authorization: headers["Authorization"],
        sessionMirrors: [
          headers["x-opencode-session"],
          headers["x-opencode-session-id"],
          headers["x-session-affinity"],
          headers["x-session-id"],
        ],
        bodyStart: text.slice(0, 140).replace(/\n/g, " "),
      },
      null,
      2
    )
  );
}

await probe("chat/big-pickle", "opencode", "big-pickle", false);
await probe("responses/muse-spark-free", "opencode", "muse-spark-1.2-contributor-free", true);
