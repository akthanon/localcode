import type { Config } from "../types/config.ts";
import type { OllamaToolCall } from "../types/ollama.ts";
import { ProviderError } from "../util/errors.ts";
import { logger } from "../util/logger.ts";
import type { ChatChunk, ChatParams, DiscoveredModel, ModelProvider } from "./types.ts";

/** Generic OpenAI-compatible provider (LM Studio, vLLM, llama.cpp server, ...). */
export class OpenAICompatibleProvider implements ModelProvider {
  readonly id = "openai-compatible";
  readonly kind = "openai-compatible" as const;
  private readonly log = logger.child("openai-compatible");
  private readonly config: Config;

  constructor(config: Config) {
    this.config = config;
  }

  root(): string {
    const url = this.config.provider.baseURL.replace(/\/+$/, "");
    return url.endsWith("/v1") ? url : `${url}/v1`;
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...this.config.provider.headers,
    };
    if (this.config.provider.apiKey) headers.Authorization = `Bearer ${this.config.provider.apiKey}`;
    return headers;
  }

  async health(): Promise<boolean> {
    try {
      const response = await fetch(`${this.root()}/models`, {
        headers: this.headers(),
        signal: AbortSignal.timeout(this.config.provider.discovery.timeoutMs),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  async version(): Promise<string | undefined> {
    return undefined;
  }

  async listModels(): Promise<DiscoveredModel[]> {
    try {
      const response = await fetch(`${this.root()}/models`, {
        headers: this.headers(),
        signal: AbortSignal.timeout(this.config.provider.discovery.timeoutMs),
      });
      if (!response.ok) return [];
      const data = (await response.json()) as { data?: Array<Record<string, unknown>> };
      return (data.data ?? []).map((entry) => {
        const id = String(entry.id ?? "");
        const maxLen = (entry.max_model_len ?? entry.context_length) as number | undefined;
        return {
          id,
          name: String(entry.id ?? id),
          context: typeof maxLen === "number" ? maxLen : 32768,
          output: 8192,
          tools: true,
          vision: false,
          reasoning: false,
          embedding: /embed/i.test(id),
          capabilities: [],
        };
      });
    } catch (error) {
      this.log.debug("Could not list OpenAI-compatible models", String(error));
      return [];
    }
  }

  private toOpenAIMessages(params: ChatParams): Array<Record<string, unknown>> {
    return params.messages.map((msg) => {
      const out: Record<string, unknown> = { role: msg.role, content: msg.content };
      if (msg.role === "assistant" && msg.tool_calls?.length) {
        out.tool_calls = msg.tool_calls.map((call) => ({
          id: call.id ?? `call_${Math.random().toString(36).slice(2)}`,
          type: "function",
          function: {
            name: call.function.name,
            arguments: JSON.stringify(call.function.arguments ?? {}),
          },
        }));
      }
      if (msg.role === "tool") {
        out.tool_call_id = msg.tool_call_id ?? msg.tool_name ?? "unknown";
        if (msg.tool_name) out.name = msg.tool_name;
      }
      if (msg.images?.length) {
        out.content = [
          { type: "text", text: msg.content },
          ...msg.images.map((image) => ({
            type: "image_url",
            image_url: { url: image.startsWith("data:") ? image : `data:image/png;base64,${image}` },
          })),
        ];
      }
      return out;
    });
  }

  buildBody(params: ChatParams): Record<string, unknown> {
    const messages = this.toOpenAIMessages(params);
    const system = params.system;
    if (system && !messages.some((m) => m.role === "system")) {
      messages.unshift({ role: "system", content: system });
    }
    const options = params.options ?? {};
    const body: Record<string, unknown> = {
      model: params.model,
      messages,
      stream: params.request?.stream ?? true,
    };
    const mapping: Record<string, string> = {
      temperature: "temperature",
      top_p: "top_p",
      top_k: "top_k",
      min_p: "min_p",
      seed: "seed",
      stop: "stop",
      num_predict: "max_tokens",
      presence_penalty: "presence_penalty",
      frequency_penalty: "frequency_penalty",
      repeat_penalty: "frequency_penalty",
    };
    for (const [source, target] of Object.entries(mapping)) {
      if (options[source] !== undefined) body[target] = options[source];
    }
    if (params.tools?.length) body.tools = params.tools;
    if (params.request?.think === true) body.reasoning_effort = "medium";
    if (typeof params.request?.think === "string") body.reasoning_effort = params.request.think;
    if (body.stream) body.stream_options = { include_usage: true };
    const format = params.request?.format;
    if (format === "json") {
      body.response_format = { type: "json_object" };
    } else if (format && typeof format === "object") {
      body.response_format = { type: "json_schema", json_schema: { name: "output", schema: format } };
    }
    return body;
  }

  async *chat(params: ChatParams): AsyncGenerator<ChatChunk, void, unknown> {
    const body = this.buildBody(params);
    const response = await fetch(`${this.root()}/chat/completions`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(body),
      signal: params.signal,
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new ProviderError(`OpenAI-compatible returned ${response.status}: ${text.slice(0, 500)}`);
    }
    if (!response.body) throw new ProviderError("Response has no body");

    let buffer = "";
    const pending = new Map<number, { id?: string; name?: string; args: string }>();
    const flush = (): OllamaToolCall[] => {
      const calls: OllamaToolCall[] = [];
      for (const [index, item] of [...pending.entries()].sort((a, b) => a[0] - b[0])) {
        let args: Record<string, unknown> = {};
        try {
          args = item.args ? (JSON.parse(item.args) as Record<string, unknown>) : {};
        } catch {
          args = {};
        }
        calls.push({ id: item.id ?? `call_${index}`, function: { name: item.name ?? "", arguments: args } });
      }
      pending.clear();
      return calls;
    };

    for await (const piece of response.body) {
      buffer += new TextDecoder().decode(piece, { stream: true });
      let idx = buffer.indexOf("\n");
      while (idx >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line.startsWith("data:")) {
          idx = buffer.indexOf("\n");
          continue;
        }
        const data = line.slice(5).trim();
        if (data === "[DONE]") {
          yield { text: "", thinking: "", toolCalls: flush(), done: true };
          return;
        }
        try {
          const event = JSON.parse(data) as {
            choices?: Array<{
              delta?: {
                content?: string;
                reasoning_content?: string;
                reasoning?: string;
                tool_calls?: Array<{
                  index?: number;
                  id?: string;
                  function?: { name?: string; arguments?: string };
                }>;
              };
              finish_reason?: string;
            }>;
            usage?: Record<string, unknown>;
          };
          const choice = event.choices?.[0];
          const delta = choice?.delta;
          const calls: OllamaToolCall[] = [];
          for (const call of delta?.tool_calls ?? []) {
            const index = call.index ?? 0;
            const current = pending.get(index) ?? { args: "" };
            if (call.id) current.id = call.id;
            if (call.function?.name) current.name = (current.name ?? "") + call.function.name;
            if (call.function?.arguments) current.args += call.function.arguments;
            pending.set(index, current);
          }
          const finished = Boolean(choice?.finish_reason);
          if (finished && pending.size) calls.push(...flush());
          yield {
            text: delta?.content ?? "",
            thinking: delta?.reasoning_content ?? delta?.reasoning ?? "",
            toolCalls: calls,
            done: false,
            usage: event.usage as ChatChunk["usage"],
          };
        } catch (error) {
          this.log.warn("Failed to parse SSE event", String(error));
        }
        idx = buffer.indexOf("\n");
      }
    }
    const remaining = flush();
    yield { text: "", thinking: "", toolCalls: remaining, done: true };
  }
}
