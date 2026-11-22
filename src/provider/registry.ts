import type { Config } from "../types/config.ts";
import type { DiscoveredModel, ModelProvider } from "./types.ts";
import { OllamaProvider } from "./ollama.ts";
import { OpenAICompatibleProvider } from "./openai-compatible.ts";
import { logger } from "../util/logger.ts";

/** Provider registry with automatic discovery and a model cache. */
export class ProviderRegistry {
  readonly provider: ModelProvider;
  config: Config;
  private models: DiscoveredModel[] = [];
  private timer?: NodeJS.Timeout;
  private readonly log = logger.child("providers");

  constructor(config: Config) {
    this.config = config;
    this.provider =
      config.provider.transport === "openai" || config.provider.type === "openai-compatible"
        ? new OpenAICompatibleProvider(config)
        : new OllamaProvider(config);
  }

  async initialize(): Promise<void> {
    await this.refresh();
    if (this.config.provider.discovery.enabled && this.config.provider.discovery.intervalMs > 0) {
      this.timer = setInterval(() => {
        void this.refresh().catch((error) => this.log.debug("Model refresh failed", String(error)));
      }, this.config.provider.discovery.intervalMs);
      this.timer.unref?.();
    }
  }

  async refresh(): Promise<DiscoveredModel[]> {
    try {
      const discovered = await this.provider.listModels();
      if (discovered.length) this.models = discovered;
      return this.models;
    } catch (error) {
      this.log.warn("Could not discover models; keeping previous inventory", String(error));
      return this.models;
    }
  }

  listModels(): DiscoveredModel[] {
    return this.models;
  }

  getModel(id: string): DiscoveredModel | undefined {
    return this.models.find((m) => m.id === id || m.name === id);
  }

  updateConfig(config: Config): void {
    this.config = config;
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Merges discovered models with the user-declared catalog. */
  mergedModels(): DiscoveredModel[] {
    const result = new Map<string, DiscoveredModel>();
    for (const model of this.models) result.set(model.id, model);
    for (const [id, entry] of Object.entries(this.config.model.catalog)) {
      const existing = result.get(id) ?? result.get(entry.modelID ?? "");
      result.set(id, {
        id,
        name: entry.name ?? existing?.name ?? id,
        family: entry.family ?? existing?.family,
        context: entry.context ?? existing?.context ?? 32768,
        output: entry.output ?? existing?.output ?? 8192,
        tools: entry.tools ?? existing?.tools ?? true,
        vision: entry.vision ?? existing?.vision ?? false,
        reasoning: entry.reasoning ?? existing?.reasoning ?? false,
        embedding: entry.embedding ?? existing?.embedding ?? false,
        capabilities: existing?.capabilities ?? [],
        modelSystem: existing?.modelSystem,
      });
    }
    return [...result.values()].filter((m) => !this.config.model.catalog[m.id]?.disabled);
  }
}
