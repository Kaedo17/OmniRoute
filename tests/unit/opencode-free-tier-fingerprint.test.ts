/**
 * Regression tests for the OpenCode free-tier client fingerprint.
 *
 * Upstream gates the free tier by fingerprinting the request body: without a
 * tool literally named `read` and `stream: true`, every `oc/*` free request is
 * answered with `403 FreeTierError` ("OpenCode's free tier can only be used from
 * within OpenCode"). The keyless `opencode` provider and every `-free` model id
 * on the keyed zen/go lanes must therefore carry OpenCode's own read/shell tool
 * declarations. Mirrors decolua/9router PR #4842.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  OPENCODE_FINGERPRINT_TOOLS,
  OPENCODE_SESSION_RE,
  applyFingerprintTools,
  isOpencodeFreeModel,
  isOpencodeFreeTierRequest,
  restoreFingerprintToolNames,
  restoreFingerprintToolNamesInLine,
} from "../../open-sse/utils/opencodeFingerprint.ts";
import {
  OpencodeExecutor,
  DEFAULT_OPENCODE_CLI_UA,
  isPremiumOpencodeModel,
} from "../../open-sse/executors/opencode.ts";
import { opencodeProvider } from "../../open-sse/config/providers/registry/opencode/index.ts";

type JsonRecord = Record<string, unknown>;

function toolName(tool: unknown): string {
  const record = tool as JsonRecord;
  if (typeof record.name === "string") return record.name;
  const fn = record.function as JsonRecord | undefined;
  return typeof fn?.name === "string" ? fn.name : "";
}

function toolNames(tools: unknown): string[] {
  return Array.isArray(tools) ? tools.map(toolName) : [];
}

// ── Free-tier predicate ─────────────────────────────────────────────────────

describe("isOpencodeFreeTierRequest", () => {
  it("treats every keyless `opencode` free model as free-tier", () => {
    for (const model of ["big-pickle", "deepseek-v4-flash-free", "hy3-free"]) {
      assert.equal(isOpencodeFreeTierRequest("opencode", model), true, model);
    }
  });

  it("treats `-free` ids on the keyed zen lane as free-tier", () => {
    assert.equal(isOpencodeFreeTierRequest("opencode-zen", "mimo-v2.5-free"), true);
    assert.equal(isOpencodeFreeModel("opencode-zen", "mimo-v2.5-free"), true);
  });

  it("never treats opencode-go models as free-tier (no free tier)", () => {
    assert.equal(isOpencodeFreeTierRequest("opencode-go", "ox-alpha-free"), false);
    assert.equal(isPremiumOpencodeModel("glm-5.2", "opencode-go"), true);
  });

  it("does not treat paid zen models as free-tier", () => {
    assert.equal(isOpencodeFreeTierRequest("opencode-zen", "glm-5.2"), false);
    assert.equal(isOpencodeFreeTierRequest("opencode-zen", "muse-spark-1.2"), false);
  });
});

// ── Tool fingerprint injection ──────────────────────────────────────────────

describe("applyFingerprintTools — injection", () => {
  it("appends read + shell (chat shape) when the caller declared no tools", () => {
    const body: JsonRecord = { model: "big-pickle", messages: [] };
    applyFingerprintTools(body, false);
    const names = toolNames(body.tools);
    for (const required of OPENCODE_FINGERPRINT_TOOLS) {
      assert.ok(names.includes(required), `expected injected ${required}`);
    }
    const readTool = (body.tools as JsonRecord[]).find((t) => toolName(t) === "read")!;
    assert.equal(typeof (readTool.function as JsonRecord).description, "string");
    assert.ok(Object.keys((readTool.function as JsonRecord).parameters).length > 0);
  });

  it("appends flat read + shell with strict:false for the Responses API", () => {
    const body: JsonRecord = { model: "muse-spark-1.2-contributor-free", input: [] };
    applyFingerprintTools(body, true);
    const names = toolNames(body.tools);
    assert.ok(names.includes("read"));
    assert.ok(names.includes("shell"));
    const readTool = (body.tools as JsonRecord[]).find((t) => toolName(t) === "read")!;
    assert.equal(readTool.name, "read");
    assert.equal(readTool.strict, false);
    assert.equal(body.tool_choice, "auto");
  });

  it("adds a placeholder system note only when tools were appended", () => {
    const withTools: JsonRecord = { messages: [{ role: "user", content: "hi" }] };
    applyFingerprintTools(withTools, false);
    const system = (withTools.messages as JsonRecord[]).find((m) => m.role === "system");
    assert.ok(system, "expected a system note");
    assert.match(String(system!.content), /placeholder/i);

    const responses: JsonRecord = { input: [] };
    applyFingerprintTools(responses, true);
    assert.match(String(responses.instructions), /placeholder/i);
  });

  it("does not append when the caller already supplies the canonical definitions", () => {
    const seed: JsonRecord = { messages: [] };
    applyFingerprintTools(seed, false);
    const canonicalRead = (seed.tools as JsonRecord[]).find((t) => toolName(t) === "read")!;
    const canonicalShell = (seed.tools as JsonRecord[]).find((t) => toolName(t) === "shell")!;

    const body: JsonRecord = { messages: [], tools: [canonicalRead, canonicalShell] };
    applyFingerprintTools(body, false);
    assert.deepEqual(toolNames(body.tools).sort(), ["read", "shell"]);
  });

  it("removes tool_choice:'none' (upstream 403s on it)", () => {
    const body: JsonRecord = { messages: [], tool_choice: "none" };
    applyFingerprintTools(body, false);
    assert.equal(body.tool_choice, undefined);
  });

  it("preserves a caller's explicit tool_choice", () => {
    const body: JsonRecord = { messages: [], tools: [], tool_choice: "required" };
    applyFingerprintTools(body, false);
    assert.equal(body.tool_choice, "required");
  });
});

// ── Alias + response restoration ────────────────────────────────────────────

describe("applyFingerprintTools — conflicting caller tools", () => {
  it("aliases a caller `read` with a different definition and restores it in the response", () => {
    const body: JsonRecord = {
      messages: [
        { role: "assistant", tool_calls: [{ function: { name: "read", arguments: "{}" } }] },
      ],
      tools: [
        {
          type: "function",
          function: {
            name: "read",
            description: "caller read",
            parameters: { type: "object", properties: { file: { type: "string" } } },
          },
        },
      ],
    };
    const map = applyFingerprintTools(body, false);

    const names = toolNames(body.tools);
    assert.ok(names.includes("read_client"), `expected read_client, got ${names.join(",")}`);
    assert.ok(names.includes("read"), "canonical read must be appended");
    assert.equal(map.get("read_client"), "read");

    // History was renamed to stay consistent with the aliased tool list.
    const assistant = (body.messages as JsonRecord[]).find((m) => m.role === "assistant")!;
    const historyName = toolName((assistant.tool_calls as JsonRecord[])[0]);
    assert.equal(historyName, "read_client");

    // Response side restores the caller's original name.
    const payload: JsonRecord = {
      choices: [{ message: { tool_calls: [{ function: { name: "read_client" } }] } }],
    };
    restoreFingerprintToolNames(payload, map);
    const restored = ((payload.choices as JsonRecord[])[0].message as JsonRecord)
      .tool_calls as JsonRecord[];
    assert.equal(toolName(restored[0]), "read");
  });

  it("restores the caller's name on a streaming SSE line", () => {
    const map = new Map([["read_client", "read"]]);
    const line = `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ function: { name: "read_client" } }] } }] })}`;
    const out = restoreFingerprintToolNamesInLine(line, map);
    assert.match(out, /"name":"read"/);
    assert.doesNotMatch(out, /read_client/);
  });

  it("restores the caller's name on a Responses API output item", () => {
    const map = new Map([["shell_client", "shell"]]);
    const payload: JsonRecord = { output: [{ type: "function_call", name: "shell_client" }] };
    restoreFingerprintToolNames(payload, map);
    assert.equal((payload.output as JsonRecord[])[0].name, "shell");
  });
});

// ── Executor integration ────────────────────────────────────────────────────

describe("OpencodeExecutor free-tier integration", () => {
  it("injects the fingerprint into a free-tier request body", () => {
    const executor = new OpencodeExecutor("opencode");
    const body = { model: "big-pickle", messages: [{ role: "user", content: "hi" }] };
    const out = executor.transformRequest("big-pickle", body, false, {}) as JsonRecord;
    assert.ok(toolNames(out.tools).includes("read"));
    assert.ok(toolNames(out.tools).includes("shell"));
  });

  it("leaves paid-lane requests untouched", () => {
    const executor = new OpencodeExecutor("opencode-zen");
    const body = { model: "glm-5.2", messages: [{ role: "user", content: "hi" }] };
    const out = executor.transformRequest("glm-5.2", body, true, {}) as JsonRecord;
    assert.equal(out.tools, undefined);
  });

  it("uses the flat tool shape for Responses-format free models", () => {
    const executor = new OpencodeExecutor("opencode");
    (executor as unknown as { _requestFormat: string | null })._requestFormat = "openai-responses";
    const body = { model: "muse-spark-1.2-contributor-free", input: [] };
    const out = executor.transformRequest(
      "muse-spark-1.2-contributor-free",
      body,
      true,
      {}
    ) as JsonRecord;
    const readTool = (out.tools as JsonRecord[]).find((t) => toolName(t) === "read")!;
    assert.equal(readTool.name, "read");
    assert.equal(readTool.strict, false);
  });

  it("buildHeaders sends Bearer public + v2 UA + mirrored session for the keyless lane", () => {
    const executor = new OpencodeExecutor("opencode");
    const headers = executor.buildHeaders(null, false, null, "big-pickle");
    assert.equal(headers["Authorization"], "Bearer public");
    assert.equal(headers["User-Agent"], DEFAULT_OPENCODE_CLI_UA);
    assert.equal(headers["x-opencode-client"], "cli");
    const session = headers["x-opencode-session"];
    assert.ok(session);
    assert.match(session, OPENCODE_SESSION_RE);
    assert.equal(headers["x-opencode-session-id"], session);
    assert.equal(headers["x-session-affinity"], session);
    assert.equal(headers["x-session-id"], session);
    assert.equal(headers["x-opencode-request"], undefined);
  });

  it("buildHeaders keeps a real key when one is present", () => {
    const executor = new OpencodeExecutor("opencode");
    const headers = executor.buildHeaders(
      { apiKey: "sk-real" } as never,
      false,
      null,
      "big-pickle"
    );
    assert.equal(headers["Authorization"], "Bearer sk-real");
  });
});

// ── Registry wiring ─────────────────────────────────────────────────────────

describe("opencode registry wiring", () => {
  it("serves the free lane from /inference/v1", () => {
    assert.equal(opencodeProvider.baseUrl, "https://opencode.ai/inference/v1");
    assert.equal(opencodeProvider.modelsUrl, "https://opencode.ai/zen/v1/models");
  });
});
