import type { Config, LoadedConfig } from "./types/config.ts";
import type { StreamEvent } from "./types/message.ts";
import type { ToolContext } from "./types/tool.ts";
import { loadConfig, reloadConfig, type LoadOptions } from "./config/loader.ts";
import { OllamaProvider } from "./provider/ollama.ts";
import { OpenAICompatibleProvider } from "./provider/openai-compatible.ts";
import { ProviderRegistry } from "./provider/registry.ts";
import { createToolRegistry, type ToolRegistry } from "./tool/index.ts";
import { AgentLoader } from "./agent/loader.ts";
import { SkillLoader } from "./skill/loader.ts";
import { CommandLoader } from "./command/loader.ts";
import { SessionStore } from "./session/store.ts";
import { SessionManager } from "./session/manager.ts";
import { PermissionEngine, type PermissionPrompter } from "./permission/engine.ts";
import { PluginManager } from "./plugin/loader.ts";
import { McpManager } from "./mcp/client.ts";
import { AgentRunner } from "./agent/runner.ts";
import { logger } from "./util/logger.ts";
import { deepMerge } from "./util/deep.ts";
import { isPlainObject } from "./util/jsonc.ts";

export interface RuntimeOptions extends LoadOptions {
  /** Non-interactive mode: auto-approves "ask" actions. */
  autoApprove?: boolean;
  /** Skip MCP and plugins (useful in tests). */
  minimal?: boolean;
}

type Emitter = (event: StreamEvent | Record<string, unknown>) => void;

/** Composes all subsystems. Equivalent to OpenCode's "background service". */
export class Runtime {
  loaded: LoadedConfig;
  config: Config;
  readonly directory: string;
  readonly provider!: OllamaProvider | OpenAICompatibleProvider;
  readonly registry!: ProviderRegistry;
  readonly tools: ToolRegistry;
  agents!: AgentLoader;
  skills!: SkillLoader;
  commands!: CommandLoader;
  readonly store: SessionStore;
  readonly sessions: SessionManager;
  readonly permissions: PermissionEngine;
  readonly plugins: PluginManager;
  readonly mcp: McpManager;
  readonly runner: AgentRunner;
  autoApprove: boolean;

  private readonly emitters = new Set<Emitter>();
  private readonly loadOptions: RuntimeOptions;
  private configOverrides: Record<string, unknown> = {};
  private reloadInFlight?: Promise<void>;
  private questionHook?: ToolContext["askQuestion"];
  private readonly log = logger.child("runtime");

  private constructor(loaded: LoadedConfig, options: RuntimeOptions) {
    this.loaded = loaded;
    this.loadOptions = options;
    this.config = loaded.config;
    this.directory = loaded.directory;
    this.autoApprove = Boolean(options.autoApprove);

    this.provider = this.config.provider.transport === "openai" || this.config.provider.type === "openai-compatible"
      ? new OpenAICompatibleProvider(this.config)
      : new OllamaProvider(this.config);
    this.registry = new ProviderRegistry(this.config);
    this.tools = createToolRegistry();
    this.agents = new AgentLoader(this.config, this.directory);
    this.skills = new SkillLoader(this.config, this.directory);
    this.commands = new CommandLoader(this.config, this.directory);
    this.store = new SessionStore(this.config, this.directory);
    this.sessions = new SessionManager(this.config, this.provider, this.agents, this.store);
    this.permissions = new PermissionEngine(this.config);
    this.permissions.autoApprove = this.autoApprove;
    this.plugins = new PluginManager(this.config, this.directory);
    this.mcp = new McpManager(this.config);

    // Stable reference for the runner getters (used by /reload).
    const thisRef = this;
    this.runner = new AgentRunner({
      config: this.config,
      directory: this.directory,
      provider: this.provider,
      registry: this.registry,
      tools: this.tools,
      get agents() { return thisRef.agents; },
      get skills() { return thisRef.skills; },
      get commands() { return thisRef.commands; },
      store: this.store,
      sessions: this.sessions,
      permissions: this.permissions,
      plugins: this.plugins,
      mcp: this.mcp,
      emit: (event) => this.emit(event),
      askPermission: (action, resource, description) => this.askPermission(action, resource, description),
      askQuestion: (questions) => this.askQuestion(questions),
      autoApprove: this.autoApprove,
    });
  }

  static async create(options: RuntimeOptions = {}): Promise<Runtime> {
    const loaded = loadConfig(options);
    const runtime = new Runtime(loaded, options);
    await runtime.initialize(Boolean(options.minimal));
    return runtime;
  }

  private async initialize(minimal: boolean): Promise<void> {
    await this.registry.initialize();
    if (!minimal) {
      await this.plugins.initialize();
      await this.mcp.initialize();
      this.tools.register(...this.plugins.tools(), ...this.mcp.listTools());
    }
    this.log.info("Runtime ready", {
      directory: this.directory,
      profile: this.config.profile,
      model: this.config.model.default,
      models: this.registry.listModels().length,
    });
  }

  onEvent(listener: Emitter): () => void {
    this.emitters.add(listener);
    return () => this.emitters.delete(listener);
  }

  emit(event: StreamEvent | Record<string, unknown>): void {
    for (const listener of this.emitters) {
      try {
        listener(event);
      } catch (error) {
        this.log.warn("Error in event listener", String(error));
      }
    }
  }

  setPermissionPrompter(prompter: PermissionPrompter): void {
    this.permissions.setPrompter(prompter);
  }

  setQuestionHook(hook: ToolContext["askQuestion"]): void {
    this.questionHook = hook;
  }

  /** CLI overrides are re-applied after every config reload. */
  setConfigOverrides(overrides: Record<string, unknown>): void {
    this.configOverrides = deepMerge(this.configOverrides, overrides) as Record<string, unknown>;
    this.applyConfigOverrides();
  }

  private applyConfigOverrides(): void {
    const target = this.config as unknown as Record<string, unknown>;
    for (const [key, value] of Object.entries(this.configOverrides)) {
      if (isPlainObject(value) && isPlainObject(target[key])) {
        target[key] = deepMerge(target[key], value);
      } else {
        target[key] = value;
      }
    }
  }

  private async askPermission(action: string, resource: string, description: string): Promise<boolean> {
    if (this.autoApprove) return true;
    return this.permissions.authorize(action, resource, description);
  }

  private async askQuestion(questions: Parameters<NonNullable<ToolContext["askQuestion"]>>[0]): Promise<Record<string, string>> {
    if (this.questionHook) return this.questionHook(questions);
    const answers: Record<string, string> = {};
    for (const question of questions) answers[question.header] = question.options[0]?.label ?? "";
    return answers;
  }

  /**
   * Reloads configuration in place. The same Config object is mutated so every
   * subsystem that captured the reference (provider, tools, runner, stores)
   * sees the new values without recreating sessions.
   */
  async reload(): Promise<void> {
    if (this.reloadInFlight) return this.reloadInFlight;
    this.reloadInFlight = this.performReload().finally(() => {
      this.reloadInFlight = undefined;
    });
    return this.reloadInFlight;
  }

  private async performReload(): Promise<void> {
    const loaded = reloadConfig(this.loaded, {
      file: this.loadOptions.file,
      profile: this.config.profile,
      content: this.loadOptions.content,
      isolated: this.loadOptions.isolated,
    });
    const previousModel = this.config.model.default;
    const previousProfile = this.config.profile;
    Object.assign(this.config, loaded.config);
    this.applyConfigOverrides();
    this.loaded = loaded;

    this.agents = new AgentLoader(this.config, this.directory);
    this.skills = new SkillLoader(this.config, this.directory);
    this.commands = new CommandLoader(this.config, this.directory);
    this.sessions.updateAgents(this.agents);
    this.permissions.replaceRules(this.config.permissions);
    this.registry.updateConfig(this.config);
    await this.registry.refresh();

    this.log.info("Config reloaded", {
      profile: this.config.profile,
      model: this.config.model.default,
      agent: this.config.agent.default,
    });
    this.emit({
      type: "config-reloaded",
      sources: loaded.sources,
      previousModel,
      previousProfile,
      model: this.config.model.default,
      agent: this.config.agent.default,
    });
    this.emit({ type: "status", status: "Config reloaded" });
  }

  dispose(): void {
    this.registry.dispose();
    this.mcp.close();
    this.emitters.clear();
  }
}
