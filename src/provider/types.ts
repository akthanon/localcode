import type { OllamaOptions, OllamaRequestConfig, OllamaToolCall, OllamaUsage } from "../types/ollama.ts";

export interface DiscoveredModel {
  id: string;
  name: string;
  family?: string;
  size?: number;
  digest?: string;
  modifiedAt?: string;
  context: number;
  output: number;
  tools: boolean;
  vision: boolean;
  reasoning: boolean;
  embedding: boolean;
  capabilities: string[];
  parameterSize?: string;
  quantization?: string;
  /** System prompt defined in the model's Modelfile. */
  modelSystem?: string;
}

export interface ChatParams {
  model: string;
  messages: Array<{
    role: "system" | "user" | "assistant" | "tool";
    content: string;
    images?: string[];
    tool_calls?: OllamaToolCall[];
    tool_name?: string;
    tool_call_id?: string;
  }>;
  tools?: Array<{
    type: "function";
    function: { name: string; description: string; parameters: Record<string, unknown> };
  }>;
  options?: OllamaOptions;
  request?: OllamaRequestConfig;
  system?: string;
  signal?: AbortSignal;
}

export interface ChatChunk {
  text: string;
  thinking: string;
  toolCalls: OllamaToolCall[];
  done: boolean;
  doneReason?: string;
  usage?: OllamaUsage;
  error?: string;
}

export interface ModelProvider {
  readonly id: string;
  readonly kind: "ollama" | "openai-compatible";
  health(): Promise<boolean>;
  listModels(): Promise<DiscoveredModel[]>;
  chat(params: ChatParams): AsyncGenerator<ChatChunk, void, unknown>;
  /** Server version information, if available. */
  version(): Promise<string | undefined>;
}
