import { pathToFileURL } from "node:url";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

import type { Config, PluginConfig } from "../types/config.ts";
import type { ToolDefinition } from "../types/tool.ts";
import { logger } from "../util/logger.ts";

export interface PluginContext {
  config: Config;
  directory: string;
  /** Registers an additional tool. */
  registerTool(tool: ToolDefinition): void;
  /** Registers a hook on runner events. */
  on(event: "before-request" | "after-response" | "tool-call" | "session-start", hook: (payload: unknown) => void | Promise<void>): void;
}

export interface Plugin {
  name?: string;
  init?(ctx: PluginContext): void | Promise<void>;
}

/** Loads plugins declared in the configuration. Errors do not stop startup. */
export class PluginManager {
  private readonly plugins: Plugin[] = [];
  private readonly hooks = new Map<string, Array<(payload: unknown) => void | Promise<void>>>();
  private readonly extraTools: ToolDefinition[] = [];
  private readonly log = logger.child("plugins");
  private readonly config: Config;
  private readonly directory: string;

  constructor(config: Config, directory: string) {
    this.config = config;
    this.directory = directory;
  }

  async initialize(): Promise<void> {
    for (const entry of this.config.plugins ?? []) {
      const spec: PluginConfig = typeof entry === "string" ? { package: entry } : entry;
      if (spec.enabled === false) continue;
      try {
        let module: { default?: Plugin | (() => Plugin); plugin?: Plugin | (() => Plugin) };
        if (spec.package.startsWith(".") || spec.package.startsWith("/")) {
          const full = resolve(this.directory, spec.package);
          const url = existsSync(full) ? pathToFileURL(full).href : spec.package;
          module = (await import(url)) as typeof module;
        } else {
          module = (await import(spec.package)) as typeof module;
        }
        const candidate = module.default ?? module.plugin;
        const plugin = typeof candidate === "function" ? candidate() : candidate;
        if (!plugin) continue;
        await plugin.init?.(this.context(spec));
        this.plugins.push(plugin);
      } catch (error) {
        this.log.warn(`Could not load plugin ${spec.package}`, String(error));
      }
    }
  }

  private context(spec: PluginConfig): PluginContext {
    return {
      config: this.config,
      directory: this.directory,
      registerTool: (tool) => this.extraTools.push(tool),
      on: (event, hook) => {
        const list = this.hooks.get(event) ?? [];
        list.push(hook);
        this.hooks.set(event, list);
      },
      // Keep the options in case the plugin needs them at init time.
      ...(spec.options ? { options: spec.options } : {}),
    } as PluginContext;
  }

  tools(): ToolDefinition[] {
    return this.extraTools;
  }

  async emit(event: string, payload: unknown): Promise<void> {
    for (const hook of this.hooks.get(event) ?? []) {
      try {
        await hook(payload);
      } catch (error) {
        this.log.warn(`Hook error: ${event}`, String(error));
      }
    }
  }

  list(): string[] {
    return this.plugins.map((p) => p.name ?? "anonymous");
  }
}
