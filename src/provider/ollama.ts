import type { Config } from "../types/config.ts";
import type {
  OllamaChatResponse,
  OllamaGenerateResponse,
  OllamaRunningModel,
  OllamaShowResponse,
  OllamaTagModel,
  OllamaTagsResponse,
  OllamaToolCall,
} from "../types/ollama.ts";
import { ProviderError } from "../util/errors.ts";
import { logger } from "../util/logger.ts";
import type { ChatChunk, ChatParams, DiscoveredModel, ModelProvider } from "./types.ts";

/** Client for Ollama's NATIVE API (/api/*). */
export class OllamaProvider implements ModelProvider {
  readonly id = "ollama";
  readonly kind = "ollama" as const;
  private readonly log = logger.child("ollama");
  private readonly config: Config;

  constructor(config: Config) {
    this.config = config;
  }

  /** Normalizes the base URL and returns the root without /v1. */
  nativeRoot(): string {
    let url = this.config.provider.baseURL.replace(/\/+$/, "");
    if (url.endsWith("/v1")) url = url.slice(0, -3);
    return url;
  }

  openAIRoot(): string {
    const url = this.config.provider.baseURL.replace(/\/+$/, "");
    return url.endsWith("/v1") ? url : `${url}/v1`;
  }

  endpoint(nativePath: string): string {
    return `${this.nativeRoot()}/api/${nativePath.replace(/^\//, "")}`;
  }

  private headers(extra?: Record<string, string>): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...this.config.provider.headers,
      ...extra,
    };
    if (this.config.provider.apiKey) {
      headers.Authorization = `Bearer ${this.config.provider.apiKey}`;
    }
    return headers;
  }

  private timeoutSignal(signal?: AbortSignal): { signal: AbortSignal; cleanup: () => void } {
    const controllers: AbortController[] = [];
    const signals: AbortSignal[] = [];
    if (signal) signals.push(signal);
    const { headers, chunk, total } = this.config.provider.timeout;
    if (total > 0) {
      const c = new AbortController();
      const timer = setTimeout(() => c.abort(new Error("Total request timeout")), total);
      timer.unref?.();
      signals.push(c.signal);
      controllers.push(c);
    }
    if (headers > 0 && headers !== total) {
      const c = new AbortController();
      const timer = setTimeout(() => c.abort(new Error("Timed out waiting for headers")), headers);
      timer.unref?.();
      signals.push(c.signal);
      controllers.push(c);
    }
    const combined = signals.length > 1 ? AbortSignal.any(signals) : (signals[0] ?? new AbortController().signal);
    return {
      signal: combined,
      cleanup: () => controllers.forEach((c) => c.abort()),
    };
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const { signal, cleanup } = this.timeoutSignal(init.signal ?? undefined);
    try {
      const response = await fetch(this.endpoint(path), { ...init, signal, headers: this.headers(init.headers as Record<string, string>) });
      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new ProviderError(`Ollama ${path} returned ${response.status}: ${body.slice(0, 500)}`);
      }
      return (await response.json()) as T;
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      throw new ProviderError(`Could not connect to Ollama at ${this.nativeRoot()}: ${String(error)}`);
    } finally {
      cleanup();
    }
  }

  async health(): Promise<boolean> {
    try {
      const response = await fetch(this.endpoint("tags"), {
        headers: this.headers(),
        signal: AbortSignal.timeout(this.config.provider.discovery.timeoutMs),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  async version(): Promise<string | undefined> {
    try {
      const response = await fetch(`${this.nativeRoot()}/api/version`, {
        headers: this.headers(),
        signal: AbortSignal.timeout(this.config.provider.discovery.timeoutMs),
      });
      if (!response.ok) return undefined;
      const data = (await response.json()) as { version?: string };
      return data.version;
    } catch {
      return undefined;
    }
  }

  async listRawModels(): Promise<OllamaTagModel[]> {
    const data = await this.request<OllamaTagsResponse>("tags");
    return data.models ?? [];
  }

  async listRunning(): Promise<OllamaRunningModel[]> {
    try {
      const data = await this.request<{ models: OllamaRunningModel[] }>("ps");
      return data.models ?? [];
    } catch {
      return [];
    }
  }

  async showModel(name: string): Promise<OllamaShowResponse> {
    return this.request<OllamaShowResponse>("show", {
      method: "POST",
      body: JSON.stringify({ name, verbose: false }),
    });
  }

  async pull(name: string): Promise<void> {
    await this.request("pull", { method: "POST", body: JSON.stringify({ name, stream: false }) });
  }

  async copy(source: string, destination: string): Promise<void> {
    await this.request("copy", { method: "POST", body: JSON.stringify({ source, destination }) });
  }

  async delete(name: string): Promise<void> {
    await this.request("delete", { method: "POST", body: JSON.stringify({ name }) });
  }

  /** Discovers models and enriches each one with /api/show. */
  async listModels(): Promise<DiscoveredModel[]> {
    const raw = await this.listRawModels();
    const models: DiscoveredModel[] = [];
    for (const tag of raw) {
      let show: OllamaShowResponse = {};
      try {
        show = await this.showModel(tag.name);
      } catch (error) {
        this.log.debug(`Could not run show for ${tag.name}`, String(error));
      }
      const discovered = this.toDiscoveredModel(tag, show);
      if (!discovered.embedding || this.config.provider.discovery.includeEmbeddings) {
        models.push(discovered);
      }
    }
    return models;
  }

  toDiscoveredModel(tag: OllamaTagModel, show: OllamaShowResponse): DiscoveredModel {
    const capabilities = (show.capabilities ?? tag.capabilities ?? []).map((c) => c.toLowerCase());
    const info = (show.info ?? show.modelinfo ?? {}) as Record<string, unknown>;
    const name = tag.name.toLowerCase();
    const embedding =
      capabilities.includes("embedding") ||
      /\bembed\b|embedding/.test(name) ||
      (info["embedding_length"] !== undefined && !capabilities.includes("completion"));

    const context =
      this.numberFromInfo(info, ["llama.context_length", "context_length", "num_ctx"]) ??
      tag.details?.context_length ??
      32768;
    const output = this.numberFromInfo(info, ["llama.max_position_embeddings"]) ?? 8192;

    return {
      id: tag.name,
      name: tag.name,
      family: tag.details?.family ?? (info["general.architecture"] as string | undefined),
      size: tag.size,
      digest: tag.digest,
      modifiedAt: tag.modified_at,
      context,
      output,
      tools: capabilities.includes("tools") || capabilities.includes("tool"),
      vision: capabilities.includes("vision") || capabilities.includes("image"),
      reasoning: capabilities.includes("thinking") || capabilities.includes("reasoning") || Boolean(show.thinking?.default),
      embedding,
      capabilities,
      parameterSize: tag.details?.parameter_size,
      quantization: tag.details?.quantization_level,
      modelSystem: show.system,
    };
  }

  private numberFromInfo(info: Record<string, unknown>, keys: string[]): number | undefined {
    for (const key of keys) {
      const value = info[key];
      if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
      if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
    }
    return undefined;
  }

  /** Builds the /api/chat body. The system prompt goes first. */
  buildChatBody(params: ChatParams): Record<string, unknown> {
    const messages = [...params.messages];
    const system = params.system ?? (typeof params.request?.system === "string" ? params.request.system : undefined);
    if (system && !messages.some((m) => m.role === "system")) {
      messages.unshift({ role: "system", content: system });
    }
    const body: Record<string, unknown> = {
      model: params.model,
      messages,
      stream: params.request?.stream ?? true,
    };
    const options = { ...(params.options ?? {}) };
    if (Object.keys(options).length) body.options = options;
    if (params.tools?.length) body.tools = params.tools;
    for (const key of ["think", "keep_alive", "format", "raw", "logprobs", "top_logprobs", "suffix"] as const) {
      const value = params.request?.[key];
      if (value !== undefined && value !== null) body[key] = value;
    }
    return body;
  }

  /** Main stream: /api/chat with NDJSON. */
  async *chat(params: ChatParams): AsyncGenerator<ChatChunk, void, unknown> {
    const body = this.buildChatBody(params);
    const maxAttempts = Math.max(1, this.config.provider.retries + 1);
    let lastError: unknown;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      let receivedAny = false;
      try {
        for await (const line of this.streamLines("chat", body, params.signal)) {
          receivedAny = true;
          const event = JSON.parse(line) as OllamaChatResponse;
          const chunk = this.toChatChunk(event);
          yield chunk;
          if (chunk.done) return;
        }
        if (receivedAny) return;
        throw new ProviderError("Ollama closed the stream without sending events");
      } catch (error) {
        lastError = error;
        if (params.signal?.aborted || receivedAny || attempt === maxAttempts) break;
        this.log.warn(`Retrying /api/chat (${attempt}/${maxAttempts})`, String(error));
      }
    }
    throw new ProviderError(`/api/chat error: ${String(lastError)}`);
  }

  /** /api/generate stream (useful for raw prompts and FIM). */
  async *generate(params: {
    model: string;
    prompt: string;
    system?: string;
    suffix?: string;
    options?: Record<string, unknown>;
    request?: Record<string, unknown>;
    signal?: AbortSignal;
  }): AsyncGenerator<ChatChunk, void, unknown> {
    const body: Record<string, unknown> = {
      model: params.model,
      prompt: params.prompt,
      stream: params.request?.stream ?? true,
    };
    if (params.system) body.system = params.system;
    if (params.suffix) body.suffix = params.suffix;
    if (params.options && Object.keys(params.options).length) body.options = params.options;
    for (const key of ["think", "keep_alive", "format", "raw", "logprobs", "top_logprobs"] as const) {
      const value = params.request?.[key];
      if (value !== undefined && value !== null) body[key] = value;
    }
    for await (const line of this.streamLines("generate", body, params.signal)) {
      const event = JSON.parse(line) as OllamaGenerateResponse;
      yield {
        text: event.response ?? "",
        thinking: event.thinking ?? "",
        toolCalls: [],
        done: Boolean(event.done),
        doneReason: event.done_reason,
        usage: event,
      };
    }
  }

  private async *streamLines(
    path: string,
    body: Record<string, unknown>,
    parentSignal?: AbortSignal,
  ): AsyncGenerator<string, void, unknown> {
    const chunkTimeout = this.config.provider.timeout.chunk;
    const controller = new AbortController();
    const signals = parentSignal ? [parentSignal, controller.signal] : [controller.signal];
    const signal = signals.length > 1 ? AbortSignal.any(signals) : signals[0]!;

    let timer: NodeJS.Timeout | undefined;
    const arm = () => {
      if (timer) clearTimeout(timer);
      if (chunkTimeout > 0) {
        timer = setTimeout(() => controller.abort(new Error("Timeout entre chunks")), chunkTimeout);
        timer.unref?.();
      }
    };
    arm();

    try {
      const response = await fetch(this.endpoint(path), {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(body),
        signal,
      });
      if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new ProviderError(`Ollama ${path} returned ${response.status}: ${text.slice(0, 500)}`);
      }
      if (!response.body) throw new ProviderError(`Ollama ${path} returned no body`);

      let buffer = "";
      for await (const piece of response.body) {
        arm();
        buffer += new TextDecoder().decode(piece, { stream: true });
        let newline = buffer.indexOf("\n");
        while (newline >= 0) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (line) yield line;
          newline = buffer.indexOf("\n");
        }
      }
      const tail = buffer.trim();
      if (tail) yield tail;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  toChatChunk(event: OllamaChatResponse): ChatChunk {
    const message = event.message;
    const toolCalls: OllamaToolCall[] = (message?.tool_calls ?? []).map((call) => ({
      id: call.id,
      function: {
        name: call.function.name,
        arguments: call.function.arguments ?? {},
        description: call.function.description,
      },
    }));
    return {
      text: message?.content ?? "",
      thinking: message?.thinking ?? "",
      toolCalls,
      done: Boolean(event.done),
      doneReason: event.done_reason,
      usage: event as OllamaUsage,
    };
  }

  /** Single non-streaming request (useful for titles, summaries, and tests). */
  async chatOnce(params: ChatParams): Promise<ChatChunk> {
    let text = "";
    let thinking = "";
    const toolCalls: OllamaToolCall[] = [];
    let usage: OllamaUsage | undefined;
    let doneReason: string | undefined;
    for await (const chunk of this.chat({ ...params, request: { ...params.request, stream: false } })) {
      text += chunk.text;
      thinking += chunk.thinking;
      toolCalls.push(...chunk.toolCalls);
      if (chunk.usage) usage = chunk.usage;
      if (chunk.doneReason) doneReason = chunk.doneReason;
    }
    return { text, thinking, toolCalls, done: true, doneReason, usage };
  }
}
