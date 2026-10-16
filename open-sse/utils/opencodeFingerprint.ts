/**
 * Helpers for the OpenCode free-tier client fingerprint.
 *
 * OpenCode's free tier (the keyless `opencode` provider and every `-free`
 * model id) is gated upstream: the request body itself is fingerprinted. As of
 * 2026-10-16 the live gate requires a tool literally named `read` (lowercase)
 * plus `stream: true`; earlier waves also checked OpenCode's own `read`/`shell`
 * definitions, a v2 `User-Agent`, mirrored session headers and the
 * `/inference/v1` endpoint. This module implements the full upstream contract
 * (mirrors decolua/9router PR #4842) so the lane survives the gate changing
 * again:
 *
 * - append OpenCode's verbatim `read`/`shell` definitions when the caller did
 *   not declare them;
 * - never leave `tool_choice: "none"` on the wire (upstream answers it with 403);
 * - a caller tool that already uses an exact fingerprint name with a different
 *   definition travels under an alias, including its earlier calls in history,
 *   and the response side restores the caller's original name.
 */
import { createHash, randomBytes } from "node:crypto";

/** Names required by the upstream free-tier gate. */
export const OPENCODE_FINGERPRINT_TOOLS = ["read", "shell"] as const;

/**
 * Valid OpenCode session id: `ses_` + 12 lowercase-hex (inverted
 * timestamp+counter) + 14 base62. The free-tier gate decodes the hex prefix and
 * rejects ids whose counter is not small (a 16-hex conversation hash is
 * rejected with 403 FreeTierError).
 */
export const OPENCODE_SESSION_RE = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/;

const SESSION_PREFIX_MASK = (1n << 48n) - 1n;
const SESSION_TIME_MASK = (1n << 36n) - 1n;
const BASE62_CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

let lastSessionMs = 0;
let sessionCounter = 0;

function descendingTimeHex(time: bigint, counterValue: bigint): string {
  return (~(time * 0x1000n + counterValue) & SESSION_PREFIX_MASK).toString(16).padStart(12, "0");
}

function randomSessionSuffix(length = 14): string {
  const bytes = randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i++) out += BASE62_CHARS[bytes[i] % 62];
  return out;
}

/**
 * Generate a valid OpenCode `ses_...` session id.
 *
 * With a `seed`, the 36-bit time field is derived from a sha256 of the seed and
 * the counter is pinned to 1 (like the CLI) — so the same conversation keeps the
 * same id across turns (prompt-cache stability) while staying gate-valid.
 * Without a seed, a real timestamp + per-millisecond counter is used.
 */
export function generateOpencodeSessionId(seed?: string | null, timestamp = Date.now()): string {
  const trimmed = typeof seed === "string" && seed.trim().length > 0 ? seed.trim() : null;
  if (trimmed) {
    // Deterministic, gate-valid id: time field from digest bytes 0-4, counter
    // pinned to 1, suffix derived from digest bytes 6-19 (mirrors 9router's
    // translateSessionId) — so the same seed always yields the same id.
    const digest = createHash("sha256").update(trimmed).digest();
    const time = BigInt(`0x${digest.subarray(0, 5).toString("hex")}`) & SESSION_TIME_MASK;
    let suffix = "";
    for (let i = 6; i < 20; i++) suffix += BASE62_CHARS[digest[i] % 62];
    return `ses_${descendingTimeHex(time, 1n)}${suffix}`;
  }

  if (timestamp !== lastSessionMs) {
    lastSessionMs = timestamp;
    sessionCounter = 0;
  }
  sessionCounter++;
  return `ses_${descendingTimeHex(BigInt(timestamp), BigInt(sessionCounter))}${randomSessionSuffix()}`;
}

/** True when `value` is a well-formed OpenCode session id. */
export function isValidOpencodeSessionId(value: unknown): boolean {
  return typeof value === "string" && OPENCODE_SESSION_RE.test(value.trim());
}

export type OpencodeFingerprintToolName = (typeof OPENCODE_FINGERPRINT_TOOLS)[number];

/**
 * Free model ids on the keyless `opencode` tier (canonical list, mirrors the
 * registry catalog). Any model id ending in `-free` is also free, so upstream
 * additions work without a deploy.
 */
export const OPENCODE_FREE_MODEL_IDS: ReadonlySet<string> = new Set([
  "big-pickle",
  "deepseek-v4-flash-free",
  "mimo-v2.5-free",
  "hy3-free",
  "nemotron-3-ultra-free",
  "north-mini-code-free",
]);

/**
 * True when a provider/model pair is served by OpenCode's free (keyless) gate.
 *
 * - `opencode-go` has no free tier.
 * - Any `-free` suffix id is free on the noauth/zen tier.
 * - Otherwise the known free catalog decides.
 */
export function isOpencodeFreeModel(provider: string, model: string): boolean {
  if (provider === "opencode-go") return false;
  const m = String(model ?? "");
  if (m.endsWith("-free")) return true;
  return OPENCODE_FREE_MODEL_IDS.has(m);
}

/**
 * True when a request must carry the free-tier fingerprint AND be sent to the
 * upstream as a stream (the gate rejects non-streaming free requests).
 */
export function isOpencodeFreeTierRequest(provider: string, model: string): boolean {
  return isOpencodeFreeModel(provider, model);
}

interface FingerprintToolDefinition {
  description: string;
  parameters: Record<string, unknown>;
}

/**
 * Verbatim from the OpenCode v2 CLI. Upstream has checked description and
 * parameters in past gate waves, so do not reword or reformat these.
 */
const FINGERPRINT_TOOL_DEFINITIONS: Record<OpencodeFingerprintToolName, FingerprintToolDefinition> =
  {
    read: {
      description:
        "Read the contents of a file or directory. Supports text files, images, and PDFs. " +
        "Images and PDFs are presented directly to the model. Each text line is prefixed by " +
        "its 1-based line number as <line>: <content>. The prefix is for reference and is not " +
        "part of the file content. Directory entries are returned one per line. Use offset and " +
        "limit to read large files or directories in sections. Prefer one larger read over many " +
        "small slices, and use grep to find specific content in large files.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File or directory to read" },
          offset: {
            type: "integer",
            minimum: 0,
            description: "The line or directory entry to start reading from (1-based)",
          },
          limit: {
            type: "integer",
            minimum: 0,
            description:
              "The maximum number of lines or directory entries to read (defaults to and capped at 2000)",
          },
        },
        required: ["path"],
        additionalProperties: false,
      },
    },
    shell: {
      description:
        "Execute a shell command and return its output. Commands run on Linux using bash. " +
        "Quote file paths containing spaces or special characters. Prefer dedicated tools over " +
        "shell commands when possible. When output is large, the full result is saved to a file " +
        "and a truncated preview is returned. Rely on automatic truncation unless filtering the " +
        "output is more useful. Commands accept an optional timeout, background commands have no " +
        "timeout by default. Background commands return immediately, and you will be notified " +
        "when they complete.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "Shell command string to execute" },
          workdir: {
            type: "string",
            description:
              "Working directory to execute the command in. Defaults to the current working " +
              "directory. When possible, avoid changing directories in the command and set the " +
              "working directory here instead.",
          },
          timeout: {
            type: "integer",
            minimum: 0,
            description:
              "Timeout in milliseconds. Set to 0 to disable the timeout. Defaults to 120000 for " +
              "foreground commands. Background commands have no timeout by default.",
          },
          background: {
            type: "boolean",
            description:
              "Run the command in the background and return immediately (useful for dev servers " +
              "and long-running builds). You do not need to use '&' at the end of the command " +
              "when using this parameter. You will be notified when it completes. DO NOT poll " +
              "for completion.",
          },
        },
        required: ["command"],
        additionalProperties: false,
      },
    },
  };

type JsonRecord = Record<string, unknown>;

/** The fingerprint name when `name` is exactly one; "" otherwise. */
export function fingerprintToolKey(name: unknown): OpencodeFingerprintToolName | "" {
  const trimmed = String(name ?? "").trim();
  return (OPENCODE_FINGERPRINT_TOOLS as readonly string[]).includes(trimmed)
    ? (trimmed as OpencodeFingerprintToolName)
    : "";
}

/** Read a tool name from either flat ({name}) or chat ({function:{name}}) shape. */
function toolNameOf(tool: unknown): string {
  if (!tool || typeof tool !== "object" || Array.isArray(tool)) return "";
  const record = tool as JsonRecord;
  if (typeof record.name === "string") return record.name;
  const fn = record.function;
  if (fn && typeof fn === "object" && !Array.isArray(fn)) {
    const name = (fn as JsonRecord).name;
    if (typeof name === "string") return name;
  }
  return "";
}

function chatFunctionOf(tool: unknown): JsonRecord | null {
  if (!tool || typeof tool !== "object" || Array.isArray(tool)) return null;
  const fn = (tool as JsonRecord).function;
  return fn && typeof fn === "object" && !Array.isArray(fn) ? (fn as JsonRecord) : null;
}

/** True when `tool` already carries OpenCode's exact definition for `key`. */
function isFingerprintDefinition(tool: unknown, key: OpencodeFingerprintToolName): boolean {
  const def = chatFunctionOf(tool) ?? (tool as JsonRecord | null);
  const want = FINGERPRINT_TOOL_DEFINITIONS[key];
  if (!def || typeof def !== "object") return false;
  return (
    def.description === want.description &&
    JSON.stringify(def.parameters) === JSON.stringify(want.parameters)
  );
}

function withToolName(tool: unknown, name: string): unknown {
  const fn = chatFunctionOf(tool);
  return fn
    ? { ...(tool as JsonRecord), function: { ...fn, name } }
    : { ...(tool as JsonRecord), name };
}

/**
 * Move caller tools off the fingerprint names when their definition differs
 * from OpenCode's, so the exact definitions can be appended without a duplicate
 * name. Everything else, including case variants such as `Read`, is preserved
 * verbatim.
 *
 * @returns map: sent name -> original name
 */
export function concealFingerprintToolNames(tools: unknown): {
  tools: unknown[];
  map: Map<string, string>;
} {
  const map = new Map<string, string>();
  if (!Array.isArray(tools)) return { tools: [], map };

  const taken = new Set(tools.map((tool) => toolNameOf(tool)));
  const seen = new Set<string>();
  const out: unknown[] = [];
  for (const tool of tools) {
    if (!tool || typeof tool !== "object" || Array.isArray(tool)) {
      out.push(tool);
      continue;
    }

    const key = fingerprintToolKey(toolNameOf(tool));
    if (!key) {
      out.push(tool);
      continue;
    }

    // Duplicate declarations of one name are rejected upstream; keep the first.
    if (seen.has(key)) continue;
    seen.add(key);

    if (isFingerprintDefinition(tool, key)) {
      out.push(tool);
      continue;
    }

    let alias = `${key}_client`;
    for (let i = 2; taken.has(alias); i++) alias = `${key}_client${i}`;
    taken.add(alias);
    map.set(alias, key);
    out.push(withToolName(tool, alias));
  }
  return { tools: out, map };
}

/**
 * Append OpenCode's definition for each fingerprint tool not already declared.
 *
 * @returns names that were appended
 */
export function appendMissingFingerprintTools(tools: unknown[], flat: boolean): string[] {
  const appended: string[] = [];
  if (!Array.isArray(tools)) return appended;
  for (const name of OPENCODE_FINGERPRINT_TOOLS) {
    if (tools.some((tool) => fingerprintToolKey(toolNameOf(tool)) === name)) continue;
    const { description, parameters } = FINGERPRINT_TOOL_DEFINITIONS[name];
    tools.push(
      flat
        ? { type: "function", name, description, parameters, strict: false }
        : { type: "function", function: { name, description, parameters } }
    );
    appended.push(name);
  }
  return appended;
}

/** Invert a sent -> original rename map. */
function aliasesByOriginal(map: Map<string, string>): Map<string, string> {
  return new Map([...map].map(([alias, original]) => [original, alias]));
}

/** Point an explicit tool_choice at the alias of a concealed caller tool. */
export function retargetToolChoice(body: JsonRecord, map: Map<string, string>): void {
  if (!map.size) return;
  const choice = body.tool_choice;
  if (!choice || typeof choice !== "object" || Array.isArray(choice)) return;
  const aliases = aliasesByOriginal(map);
  const record = choice as JsonRecord;

  if (typeof record.name === "string") {
    const alias = aliases.get(record.name.trim());
    if (alias) body.tool_choice = { ...record, name: alias };
    return;
  }

  const fn = record.function;
  if (fn && typeof fn === "object" && !Array.isArray(fn)) {
    const fnRecord = fn as JsonRecord;
    if (typeof fnRecord.name === "string") {
      const alias = aliases.get(fnRecord.name.trim());
      if (alias) body.tool_choice = { ...record, function: { ...fnRecord, name: alias } };
    }
  }
}

/** Rename earlier tool calls in the conversation so history matches the aliases. */
export function aliasHistoryToolCalls(body: JsonRecord, map: Map<string, string>): void {
  if (!map.size) return;
  const aliases = aliasesByOriginal(map);
  const renameName = (name: unknown): unknown =>
    typeof name === "string" && aliases.get(name.trim()) ? aliases.get(name.trim()) : name;

  const renameCall = (call: unknown): void => {
    if (!call || typeof call !== "object" || Array.isArray(call)) return;
    const record = call as JsonRecord;
    if (typeof record.name === "string") {
      record.name = renameName(record.name);
    }
    const fn = record.function;
    if (fn && typeof fn === "object" && !Array.isArray(fn)) {
      const fnRecord = fn as JsonRecord;
      if (typeof fnRecord.name === "string") fnRecord.name = renameName(fnRecord.name);
    }
  };

  const walkMessages = (messages: unknown): void => {
    if (!Array.isArray(messages)) return;
    for (const message of messages) {
      if (!message || typeof message !== "object" || Array.isArray(message)) continue;
      const record = message as JsonRecord;
      if (Array.isArray(record.tool_calls)) record.tool_calls.forEach(renameCall);
      if (Array.isArray(record.content)) {
        for (const part of record.content) {
          if (!part || typeof part !== "object" || Array.isArray(part)) continue;
          const partRecord = part as JsonRecord;
          if (partRecord.type === "tool_use" || partRecord.type === "tool_call") {
            partRecord.name = renameName(partRecord.name);
          }
        }
      }
    }
  };

  walkMessages(body.messages);
  // Responses API input items
  if (Array.isArray(body.input)) {
    for (const item of body.input) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const record = item as JsonRecord;
      if (typeof record.type === "string" && record.type.includes("tool")) renameCall(record);
    }
  }
}

/** Append the placeholder system note that keeps the injected tools inert. */
export function noteUnavailableTools(body: JsonRecord, flat: boolean, appended: string[]): void {
  if (appended.length === 0) return;
  const list = appended.map((name) => `\`${name}\``).join(" and ");
  const note =
    `\n\nNote: the tool${appended.length > 1 ? "s" : ""} ${list} ${appended.length > 1 ? "are" : "is"} ` +
    `placeholder${appended.length > 1 ? "s" : ""} injected by the runtime and ${appended.length > 1 ? "are" : "is"} ` +
    `not part of this session. Do not call ${appended.length > 1 ? "them" : "it"}; use the other ` +
    `tools you have been given, or answer the user directly.`;

  if (flat) {
    const existing = body.instructions;
    body.instructions =
      typeof existing === "string" && existing.length > 0 ? `${existing}${note}` : note.trimStart();
    return;
  }

  const messages = Array.isArray(body.messages) ? (body.messages as unknown[]) : null;
  if (!messages) return;
  const systemMessage = messages.find(
    (message) =>
      message &&
      typeof message === "object" &&
      !Array.isArray(message) &&
      (message as JsonRecord).role === "system"
  ) as JsonRecord | undefined;
  if (systemMessage) {
    if (typeof systemMessage.content === "string") {
      systemMessage.content = `${systemMessage.content}${note}`;
    } else if (Array.isArray(systemMessage.content)) {
      (systemMessage.content as unknown[]).push({ type: "text", text: note });
    }
    return;
  }
  messages.unshift({ role: "system", content: note.trimStart() });
}

/**
 * Apply the free-tier tool fingerprint to an upstream request body in place.
 *
 * @param body translated request body (chat or Responses shape)
 * @param flat true for the Responses API flat tool shape
 * @returns the alias map (sent name -> original name), empty when no conflict
 */
export function applyFingerprintTools(body: unknown, flat: boolean): Map<string, string> {
  const map = new Map<string, string>();
  if (!body || typeof body !== "object" || Array.isArray(body)) return map;
  const record = body as JsonRecord;

  const { tools, map: concealMap } = concealFingerprintToolNames(record.tools);
  record.tools = tools;
  for (const [alias, original] of concealMap) map.set(alias, original);

  const appended = appendMissingFingerprintTools(record.tools as unknown[], flat);
  retargetToolChoice(record, map);
  aliasHistoryToolCalls(record, map);
  if (appended.length > 0) noteUnavailableTools(record, flat, appended);

  // Responses keeps its explicit auto default. Never leave "none": upstream
  // answers tool_choice "none" with 403 FreeTierError.
  if (record.tool_choice === "none") delete record.tool_choice;
  else if (record.tool_choice === undefined && flat) record.tool_choice = "auto";

  return map;
}

/** Restore the caller's original tool names on a non-streaming JSON payload. */
export function restoreFingerprintToolNames(
  payload: unknown,
  map: Map<string, string> | null
): void {
  if (!payload || typeof payload !== "object" || !map?.size) return;
  const original = (name: unknown): unknown =>
    typeof name === "string" && map.get(name.trim()) ? map.get(name.trim()) : name;

  const visitCall = (call: unknown): void => {
    if (!call || typeof call !== "object" || Array.isArray(call)) return;
    const record = call as JsonRecord;
    if (typeof record.name === "string") record.name = original(record.name);
    const fn = record.function;
    if (fn && typeof fn === "object" && !Array.isArray(fn)) {
      const fnRecord = fn as JsonRecord;
      if (typeof fnRecord.name === "string") fnRecord.name = original(fnRecord.name);
    }
  };

  const record = payload as JsonRecord;

  // Chat Completions: choices[].message.tool_calls[]
  if (Array.isArray(record.choices)) {
    for (const choice of record.choices) {
      if (!choice || typeof choice !== "object" || Array.isArray(choice)) continue;
      const message = (choice as JsonRecord).message as JsonRecord | undefined;
      if (message && Array.isArray(message.tool_calls)) message.tool_calls.forEach(visitCall);
    }
  }

  // Responses: output[] function_call items
  if (Array.isArray(record.output)) {
    for (const item of record.output) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const itemRecord = item as JsonRecord;
      if (itemRecord.type === "function_call") visitCall(itemRecord);
    }
  }
}

/**
 * Restore the caller's original tool names inside one SSE `data:` line.
 * Non-data lines and unparseable payloads are returned unchanged.
 */
export function restoreFingerprintToolNamesInLine(
  line: string,
  map: Map<string, string> | null
): string {
  if (!map?.size) return line;
  const trimmed = line.trim();
  if (!trimmed.startsWith("data:")) return line;
  const jsonText = trimmed.slice(5).trim();
  if (!jsonText || jsonText === "[DONE]") return line;
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return line;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return line;
  const record = parsed as JsonRecord;

  const original = (name: unknown): unknown =>
    typeof name === "string" && map.get(name.trim()) ? map.get(name.trim()) : name;

  // Chat Completions streaming: choices[].delta.tool_calls[]
  if (Array.isArray(record.choices)) {
    for (const choice of record.choices) {
      if (!choice || typeof choice !== "object" || Array.isArray(choice)) continue;
      const delta = (choice as JsonRecord).delta as JsonRecord | undefined;
      if (!delta || !Array.isArray(delta.tool_calls)) continue;
      for (const call of delta.tool_calls) {
        if (!call || typeof call !== "object" || Array.isArray(call)) continue;
        const callRecord = call as JsonRecord;
        if (typeof callRecord.name === "string") callRecord.name = original(callRecord.name);
        const fn = callRecord.function;
        if (fn && typeof fn === "object" && !Array.isArray(fn)) {
          const fnRecord = fn as JsonRecord;
          if (typeof fnRecord.name === "string") fnRecord.name = original(fnRecord.name);
        }
      }
    }
  }

  // Responses streaming: response.output_item.{added,done} with item.name
  const item = record.item;
  if (item && typeof item === "object" && !Array.isArray(item)) {
    const itemRecord = item as JsonRecord;
    if (typeof itemRecord.name === "string") itemRecord.name = original(itemRecord.name);
  }

  return `data: ${JSON.stringify(parsed)}`;
}
