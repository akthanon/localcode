import type { Config } from "../types/config.ts";
import type { ToolDefinition } from "../types/tool.ts";
import type { OllamaToolDefinition } from "../types/ollama.ts";

/** Central registry of tools available to the model. */
export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>();

  register(...tools: ToolDefinition[]): void {
    for (const tool of tools) this.tools.set(tool.id, tool);
  }

  get(id: string): ToolDefinition | undefined {
    return this.tools.get(id);
  }

  all(): ToolDefinition[] {
    return [...this.tools.values()];
  }

  /** Tools actually enabled according to the configuration and agent. */
  enabled(config: Config, agentTools?: string[]): ToolDefinition[] {
    const allow = agentTools ?? config.tools.enabled;
    const deny = new Set(config.tools.disabled);
    return this.all().filter((tool) => allow.includes(tool.id) && !deny.has(tool.id));
  }

  toOllamaTools(tools: ToolDefinition[]): OllamaToolDefinition[] {
    return tools.map((tool) => ({
      type: "function",
      function: {
        name: tool.id,
        description: tool.description,
        parameters: tool.parameters as Record<string, unknown>,
      },
    }));
  }
}
