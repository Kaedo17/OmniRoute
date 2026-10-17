import type { RegistryEntry } from "../../shared.ts";

export const opencodeProvider: RegistryEntry = {
  id: "opencode",
  alias: "oc",
  format: "openai",
  executor: "opencode",
  // OpenCode v2 moved free inference to /inference/v1; /zen/v1 still answers
  // some free ids but is the legacy lane (mirrors 9router PR #4842). The model
  // list endpoint stays on /zen/v1/models, which is unchanged upstream.
  baseUrl: "https://opencode.ai/inference/v1",
  modelsUrl: "https://opencode.ai/zen/v1/models",
  authType: "apikey",
  authHeader: "Authorization",
  authPrefix: "Bearer",
  passthroughModels: true,
  defaultContextLength: 200000,
  models: [
    // #2900: big-pickle's upstream runs DeepSeek thinking mode — declare the
    // interleaved reasoning_content contract so follow-up/tool-use turns replay
    // it (otherwise DeepSeek returns 400 "reasoning_content ... must be passed back").
    {
      id: "big-pickle",
      name: "Big Pickle",
      supportsReasoning: true,
      interleavedField: "reasoning_content",
    },
    // #MUSE_SPARK: Muse Spark is served by OpenCode Zen ONLY on the OpenAI
    // Responses API (https://opencode.ai/zen/v1/responses), not /chat/completions
    // (confirmed in the official OpenCode Zen docs: https://opencode.ai/docs/zen/).
    // Without targetFormat:"openai-responses" these models fall through to the
    // default chat/completions pass-through and the upstream returns null/empty
    // content (see issue #10867). The opencode provider is passthrough, so
    // declaring them here only sets the wire format / capability flags — the
    // live upstream model list already advertises both ids.
    {
      id: "muse-spark-1.2",
      name: "Muse Spark 1.2",
      supportsReasoning: true,
      targetFormat: "openai-responses",
    },
    {
      id: "muse-spark-1.2-contributor-free",
      name: "Muse Spark 1.2 Contributor Free",
      supportsReasoning: true,
      targetFormat: "openai-responses",
    },
    // 2026-10-17 refresh — measured against https://opencode.ai/zen/v1/models,
    // the source of truth (a non-empty live catalog rejects registry ids it
    // omits, and requesting one answers "not available in the active live
    // catalog"). deepseek-v4-flash-free, mimo-v2.5-free, hy3-free,
    // nemotron-3-ultra-free and north-mini-code-free were delisted upstream and
    // are dropped here instead of kept: `passthroughModels` re-surfaces any of
    // them the moment upstream advertises them again.
    // MUSE_SPARK 1.3: same Responses-only contract as 1.2 (#10867). Without
    // targetFormat the chat pass-through reaches upstream and gets
    // 400 ModelProtocolUnsupported; measured 2026-10-17: the Responses shape
    // answers 200.
    {
      id: "muse-spark-1.3-contributor-free",
      name: "Muse Spark 1.3 Contributor Free",
      supportsReasoning: true,
      targetFormat: "openai-responses",
    },
    // The rest of the current free lineup, all live as of 2026-10-17.
    { id: "beam-free", name: "Beam Free" },
    { id: "deepseek-v4.1-flash-free", name: "DeepSeek V4.1 Flash Free", supportsReasoning: true },
    { id: "glm-5.3-flash-free", name: "GLM 5.3 Flash Free" },
    { id: "jev-1.13-free", name: "Jev 1.13 Free" },
    { id: "longcat-2.5-preview-free", name: "LongCat 2.5 Preview Free" },
    { id: "mimo-v2.6-flash-free", name: "MiMo V2.6 Flash Free" },
    { id: "nemotron-3.5-lightning-free", name: "Nemotron 3.5 Lightning Free" },
    { id: "nemotron-3.5-super-vl-free", name: "Nemotron 3.5 Super VL Free" },
    { id: "space-bunny-free", name: "Space Bunny Free" },
  ],
};
