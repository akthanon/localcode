import type { Config } from "../types/config.ts";
import { ConfigError } from "../util/errors.ts";
import { isPlainObject } from "../util/jsonc.ts";
import { defaultConfig } from "./defaults.ts";

/** Normalizes and validates the merged configuration, filling gaps with defaults. */
export function normalizeConfig(input: Config): Config {
  if (!isPlainObject(input as unknown as Record<string, unknown>)) {
    throw new ConfigError("Configuration must be an object");
  }
  const defaults = defaultConfig();
  const config: Config = { ...defaults, ...input } as Config;

  if (config.version !== 1) {
    throw new ConfigError(`Unsupported configuration version: ${config.version} (expected 1)`);
  }
  if (!["ollama", "openai-compatible"].includes(config.provider.type)) {
    throw new ConfigError(`Invalid provider.type: ${config.provider.type}`);
  }
  if (!["native", "openai"].includes(config.provider.transport)) {
    throw new ConfigError(`Invalid provider.transport: ${config.provider.transport}`);
  }
  if (!Number.isInteger(config.server.port) || config.server.port < 0 || config.server.port > 65535) {
    throw new ConfigError(`Invalid server.port: ${config.server.port}`);
  }
  if (!isPlainObject(config.model.catalog)) config.model.catalog = {};
  if (!isPlainObject(config.model.aliases)) config.model.aliases = {};
  if (!isPlainObject(config.ollama.options)) config.ollama.options = {};
  if (!isPlainObject(config.ollama.request)) config.ollama.request = {};
  if (!isPlainObject(config.ollama.perModel)) config.ollama.perModel = {};
  if (!isPlainObject(config.ollama.variants)) config.ollama.variants = {};
  if (!isPlainObject(config.system.sections)) config.system.sections = {};
  if (!isPlainObject(config.system.variables)) config.system.variables = {};
  if (!isPlainObject(config.agent.definitions)) config.agent.definitions = {};
  if (!isPlainObject(config.commands)) config.commands = {};
  if (!isPlainObject(config.mcp.servers)) config.mcp.servers = {};
  if (!["replace", "prepend", "append"].includes(config.system.mode)) {
    throw new ConfigError(`Invalid system.mode: ${config.system.mode}`);
  }
  if (!Array.isArray(config.permissions)) config.permissions = [];
  if (!Array.isArray(config.tools.enabled)) config.tools.enabled = defaults.tools.enabled;
  if (!Array.isArray(config.plugins)) config.plugins = [];

  // The port may come from the environment (useful in tests and containers).
  if (process.env.LOCALCODE_PORT) {
    config.server.port = Number(process.env.LOCALCODE_PORT);
  }
  if (process.env.LOCALCODE_HOST) {
    config.server.host = process.env.LOCALCODE_HOST;
  }
  if (process.env.LOCALCODE_MODEL) {
    config.model.default = process.env.LOCALCODE_MODEL;
  }
  if (process.env.LOCALCODE_BASE_URL) {
    config.provider.baseURL = process.env.LOCALCODE_BASE_URL;
  }

  return config;
}

/** Resolves a model alias and splits the `model#variant` suffix. */
export function resolveModelSelector(
  config: Config,
  selector: string,
): { model: string; variant?: string } {
  const hash = selector.indexOf("#");
  const rawModel = hash >= 0 ? selector.slice(0, hash) : selector;
  const variant = hash >= 0 ? selector.slice(hash + 1) : undefined;

  // Selectors may include a provider prefix: ollama/qwen3:8b
  let model = rawModel;
  const slash = model.indexOf("/");
  if (slash >= 0 && ["ollama", "local", "lmstudio", "vllm"].includes(model.slice(0, slash))) {
    model = model.slice(slash + 1);
  }
  model = config.model.aliases[model] ?? model;
  return { model, variant };
}
