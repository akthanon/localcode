/**
 * Native types for the Ollama API.
 *
 * One of the main differences from OpenCode: here ALL
 * Ollama's configurable parameters are first-class and can be
 * set in localcode.jsonc, per profile, per model, or per session.
 */

/** Valor de `think` (Ollama v0.13+). Model-defined strings must match /api/show. */
export type ThinkValue = boolean | string | null;

/** Structured output: "json" or a JSON Schema. */
export type FormatValue = "json" | Record<string, unknown> | null;

/**
 * Model runtime options (`options` in /api/chat and /api/generate).
 * Comments indicate Ollama/llama.cpp defaults.
 */
export interface OllamaOptions {
  /** Mirostat: 0 off, 1 Mirostat, 2 Mirostat 2.0. Default 0. */
  mirostat?: number;
  /** Mirostat learning rate. Default 0.1. */
  mirostat_eta?: number;
  /** Mirostat target perplexity. Default 5.0. */
  mirostat_tau?: number;
  /** Context window size in tokens. Default 2048. */
  num_ctx?: number;
  /** Tokens to look back for repetition penalty. 0 off, -1 = num_ctx. Default 64. */
  repeat_last_n?: number;
  /** Repetition penalty strength. Default 1.1. */
  repeat_penalty?: number;
  /** Randomness. Default 0.8. */
  temperature?: number;
  /** Seed for reproducible outputs. Default 0. */
  seed?: number;
  /** Stop sequences. */
  stop?: string | string[];
  /** Maximum tokens to generate. -1 = unlimited. Default -1. */
  num_predict?: number;
  /** Speculative draft tokens per step. 0 disables. Default 4. */
  draft_num_predict?: number;
  /** Top-K sampling. Default 40. */
  top_k?: number;
  /** Nucleus sampling. Default 0.9. */
  top_p?: number;
  /** Minimum probability relative to the most likely token. Default 0.0. */
  min_p?: number;
  /** Typical sampling. Default 1.0. */
  typical_p?: number;
  /** Prompt evaluation batch size. Default 512. */
  num_batch?: number;
  /** Number of layers on GPU (-1 = all). */
  num_gpu?: number;
  /** Main GPU. Default 0. */
  main_gpu?: number;
  /** Keep the KV cache in VRAM. Default false. */
  low_vram?: boolean;
  /** Use half precision for the KV cache. Default true. */
  f16_kv?: boolean;
  /** Return logits for all tokens. Default false. */
  logits_all?: boolean;
  /** Load vocabulary only. Default false. */
  vocab_only?: boolean;
  /** Memory-map weights. Default true. */
  use_mmap?: boolean;
  /** Lock weights in memory (mlock). Default false. */
  use_mlock?: boolean;
  /** Inference threads. 0 = automatic. */
  num_thread?: number;
  /** Initial tokens to keep without truncation. Default 24. */
  num_keep?: number;
  /** Presence penalty. Default 0.0. */
  presence_penalty?: number;
  /** Frequency penalty. Default 0.0. */
  frequency_penalty?: number;
  /** Tail-free sampling. Default 1.0. */
  tfs_z?: number;
  /** Penalize newlines. Default true. */
  penalize_newline?: boolean;
  /** Enable NUMA. Default false. */
  numa?: boolean;
  /** Truncate context instead of erroring. */
  trunc?: boolean;
  /** Alias for num_gpu in some backends. */
  num_gpu_layers?: number;
  /** Any new backend option is passed through as-is. */
  [key: string]: unknown;
}

/** Request parameters that do not go inside `options`. */
export interface OllamaRequestConfig {
  /** Enable/request thinking; null uses the model default. */
  think?: ThinkValue;
  /** Duration to keep the model in VRAM ("5m", -1, 0). Default "5m". */
  keep_alive?: string | number;
  /** Structured output. */
  format?: FormatValue;
  /** No prompt template. Default false. */
  raw?: boolean;
  /** Streaming NDJSON. Default true. */
  stream?: boolean;
  /** Return logprobs. */
  logprobs?: boolean;
  /** Number of alternatives per token when logprobs is enabled. */
  top_logprobs?: number;
  /** Suffix for fill-in-the-middle models. */
  suffix?: string;
  /** Direct system prompt; takes precedence over the agent-built one. */
  system?: string;
}

/** Final parameter resolution: global -> profile -> model -> variant -> session. */
export interface ResolvedOllamaConfig {
  options: OllamaOptions;
  request: OllamaRequestConfig;
  system: string | undefined;
}

/** Information for a model listed by /api/tags. */
export interface OllamaTagModel {
  name: string;
  model: string;
  modified_at: string;
  size: number;
  digest: string;
  capabilities?: string[];
  details?: {
    parent_model?: string;
    format?: string;
    family?: string;
    families?: string[];
    parameter_size?: string;
    quantization_level?: string;
    context_length?: number;
    embedding_length?: number;
    runner?: string;
  };
}

export interface OllamaTagsResponse {
  models: OllamaTagModel[];
}

/** Detailed information from /api/show. */
export interface OllamaShowResponse {
  license?: string;
  modelfile?: string;
  parameters?: string;
  template?: string;
  system?: string;
  info?: Record<string, unknown>;
  details?: Record<string, unknown>;
  capabilities?: string[];
  modelinfo?: Record<string, unknown>;
  thinking?: { values?: boolean[]; default?: boolean };
}

/** Running model (/api/ps). */
export interface OllamaRunningModel {
  name: string;
  model: string;
  size: number;
  digest: string;
  details?: Record<string, unknown>;
  expires_at?: string;
  size_vram?: number;
}

export interface OllamaToolCall {
  id?: string;
  function: {
    name: string;
    arguments: Record<string, unknown>;
    description?: string;
  };
}

export interface OllamaChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  images?: string[];
  tool_calls?: OllamaToolCall[];
  tool_name?: string;
}

export interface OllamaUsage {
  total_duration?: number;
  load_duration?: number;
  prompt_eval_count?: number;
  prompt_eval_cached_count?: number;
  prompt_eval_duration?: number;
  eval_count?: number;
  eval_duration?: number;
}

export interface OllamaChatResponse extends OllamaUsage {
  model?: string;
  created_at?: string;
  message?: OllamaChatMessage & { thinking?: string };
  done?: boolean;
  done_reason?: string;
}

export interface OllamaGenerateResponse extends OllamaUsage {
  model?: string;
  created_at?: string;
  response?: string;
  thinking?: string;
  done?: boolean;
  done_reason?: string;
}

export interface OllamaToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}
