import type { Config } from "../types/config.ts";
import type { OllamaOptions, OllamaRequestConfig, ResolvedOllamaConfig } from "../types/ollama.ts";
import { deepMerge } from "../util/deep.ts";
import { resolveModelSelector } from "./validate.ts";

export interface ParamOverrides {
  options?: OllamaOptions;
  request?: OllamaRequestConfig;
  systemPrompt?: string;
  variant?: string;
}

/**
 * Precedence order (lowest to highest):
 *   global -> model catalog -> perModel -> variant -> session/agent overrides
 */
export function resolveOllamaParams(
  config: Config,
  selector?: string,
  overrides: ParamOverrides = {},
): ResolvedOllamaConfig {
  const rawSelector = selector || config.model.default;
  const resolved = resolveModelSelector(config, rawSelector);
  const model = resolved.model;
  const variant = overrides.variant ?? resolved.variant ?? config.model.variant;

  // The catalog may use either an alias or the real model name.
  const raw = rawSelector.slice(0, rawSelector.indexOf("#") >= 0 ? rawSelector.indexOf("#") : undefined);
  const rawModel = raw.includes("/") ? raw.slice(raw.lastIndexOf("/") + 1) : raw;
  const catalog = config.model.catalog[model] ?? config.model.catalog[rawModel] ?? {};
  const perModel = config.ollama.perModel[model] ?? config.ollama.perModel[rawModel] ?? {};
  const variantConfig = variant ? (config.ollama.variants[variant] ?? {}) : {};

  let options = {} as OllamaOptions;
  for (const layer of [
    config.ollama.options,
    catalog.options,
    perModel.options,
    variantConfig.options,
    overrides.options,
  ]) {
    options = deepMerge(options, layer ?? {}) as OllamaOptions;
  }

  let request = {} as OllamaRequestConfig;
  for (const layer of [
    config.ollama.request,
    catalog.request,
    perModel.request,
    variantConfig.request,
    overrides.request,
  ]) {
    request = deepMerge(request, layer ?? {}) as OllamaRequestConfig;
  }

  // `null` removes a key, allowing a profile to disable a global value.
  for (const [key, value] of Object.entries(options)) {
    if (value === null || value === undefined) delete options[key];
  }
  for (const [key, value] of Object.entries(request)) {
    if (value === null || value === undefined) delete request[key];
  }

  const system =
    overrides.systemPrompt ??
    (variantConfig as { systemPrompt?: string }).systemPrompt ??
    (perModel as { systemPrompt?: string }).systemPrompt ??
    catalog.systemPrompt;

  return { options, request, system };
}

/** Effective model list (catalog + discovered), applying aliases and disabled flags. */
export function modelCatalogEntries(config: Config): Array<{ id: string; name: string }> {
  const entries: Array<{ id: string; name: string }> = [];
  for (const [id, entry] of Object.entries(config.model.catalog)) {
    if (entry.disabled) continue;
    entries.push({ id, name: entry.name ?? id });
  }
  for (const [alias, target] of Object.entries(config.model.aliases)) {
    if (!entries.some((e) => e.id === target)) {
      entries.push({ id: alias, name: `${alias} → ${target}` });
    }
  }
  if (config.model.default && !entries.some((e) => e.id === config.model.default)) {
    entries.unshift({ id: config.model.default, name: config.model.default });
  }
  return entries;
}
