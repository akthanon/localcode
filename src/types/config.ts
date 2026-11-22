import type { OllamaOptions, OllamaRequestConfig } from "./ollama.ts";
import type { AgentDefinition, CommandDefinition } from "./tool.ts";

export type PermissionEffect = "allow" | "ask" | "deny";

export interface PermissionRule {
  action: string;
  resource: string;
  effect: PermissionEffect;
  /** Message shown when asking for confirmation. */
  message?: string;
}

export interface ServerConfig {
  enabled: boolean;
  host: string;
  port: number;
  /** Habilita CORS para clientes web. */
  cors: boolean;
  /** Token bearer opcional. */
  authToken?: string;
  /** Prefijo de las rutas, p. ej. "/api". */
  basePath?: string;
}

export interface ProviderConfig {
  /** "ollama" discovers models via /api/tags. "openai-compatible" uses /v1/models. */
  type: "ollama" | "openai-compatible";
  /** URL base SIN /v1 para el API nativa de Ollama. */
  baseURL: string;
  apiKey?: string;
  headers: Record<string, string>;
  /** "native" usa /api/chat; "openai" usa /v1/chat/completions. */
  transport: "native" | "openai";
  discovery: {
    enabled: boolean;
    intervalMs: number;
    timeoutMs: number;
    includeEmbeddings: boolean;
  };
  timeout: {
    /** ms until the first header arrives. 0 = no limit. */
    headers: number;
    /** ms between stream chunks. 0 = no limit. */
    chunk: number;
    /** Total request timeout in ms. 0 = no limit. */
    total: number;
  };
  retries: number;
}

export interface ModelCatalogEntry {
  name?: string;
  family?: string;
  /** Usable context window in tokens. */
  context?: number;
  output?: number;
  tools?: boolean;
  vision?: boolean;
  reasoning?: boolean;
  embedding?: boolean;
  disabled?: boolean;
  /** Real ID sent to the server if it differs from the alias. */
  modelID?: string;
  /** Model-specific system prompt. */
  systemPrompt?: string;
  options?: OllamaOptions;
  request?: OllamaRequestConfig;
}

export interface ModelConfig {
  /** Modelo por defecto (acepta alias). */
  default: string;
  /** Short aliases -> real model name. */
  aliases: Record<string, string>;
  /** Per-model metadata and parameters. */
  catalog: Record<string, ModelCatalogEntry>;
  /** Variante aplicada por defecto. */
  variant?: string;
}

/**
 * System prompt configuration. Key differentiator from OpenCode:
 * full control over the base prompt, templates, instruction files,
 * secciones ordered y variables.
 */
export interface SystemPromptConfig {
  /** replace: usa solo `prompt`. prepend/append: combina con el prompt del agente. */
  mode: "replace" | "prepend" | "append";
  /** System prompt text. Supports variables such as {{cwd}} and {{model}}. */
  prompt?: string;
  /** Archivos de instrucciones a incluir (AGENTS.md, .localcode/INSTRUCTIONS.md, ...). */
  files: string[];
  /** Variables para sustituir en la plantilla. */
  variables: Record<string, string>;
  /** Incluir el prompt base del agente (build/plan/...). */
  includeDefault: boolean;
  /** Incluir información del entorno (SO, shell, cwd, git). */
  includeEnvironment: boolean;
  /** Include the list of available tools. */
  includeToolDescriptions: boolean;
  /** Include available skills. */
  includeSkills: boolean;
  /** Include available slash commands. */
  includeCommands: boolean;
  /** Secciones adicionales insertadas en orden. */
  sections: Record<string, string>;
  /** Separador entre secciones. */
  separator: string;
}

export interface OllamaConfigBlock {
  /** Global options sent as `options` to Ollama. */
  options: OllamaOptions;
  /** Global request parameters (think, keep_alive, format, raw, ...). */
  request: OllamaRequestConfig;
  /** Per-model settings (real Ollama name or an alias). */
  perModel: Record<
    string,
    {
      options?: OllamaOptions;
      request?: OllamaRequestConfig;
      systemPrompt?: Partial<SystemPromptConfig>;
    }
  >;
  /** Named variants, selectable with `model#variant`. */
  variants: Record<
    string,
    {
      options?: OllamaOptions;
      request?: OllamaRequestConfig;
      systemPrompt?: Partial<SystemPromptConfig>;
    }
  >;
}

export interface AgentConfig {
  default: string;
  definitions: Record<string, AgentDefinition>;
  /** Global step limit (0 = no limit). */
  maxSteps: number;
}

export interface ToolsConfig {
  enabled: string[];
  disabled: string[];
  /** Shell used by the bash tool. */
  shell: string;
  bash: {
    defaultTimeout: number;
    maxBackgroundMs: number;
    /** Legacy hard cap retained for compatibility. */
    maxOutputBytes: number;
    /** Maximum output returned to the model. The rest goes to a managed file. */
    previewBytes: number;
    previewLines: number;
    saveFullOutput: boolean;
  };
  read: {
    maxLines: number;
    maxBytes: number;
    maxImageBytes: number;
  };
  output: {
    maxLines: number;
    maxBytes: number;
  };
  /** Formateadores por extensión, p. ej. { "*.ts": ["npx prettier --write"] }. */
  formatter: boolean | Record<string, string[]>;
}

export interface SkillsConfig {
  enabled: boolean;
  autoDiscover: boolean;
  paths: string[];
}

export interface McpServerConfig {
  type: "local" | "remote";
  command?: string[];
  url?: string;
  env?: Record<string, string>;
  headers?: Record<string, string>;
  enabled?: boolean;
  timeout?: number;
  /** false = expose tools directly instead of inside `execute`. */
  codemode?: boolean;
}

export interface McpConfig {
  servers: Record<string, McpServerConfig>;
  timeout: number;
  codemode: boolean;
}

export interface SessionConfig {
  dir: string;
  autoTitle: boolean;
  snapshots: {
    enabled: boolean;
    max: number;
  };
  compaction: {
    auto: boolean;
    keepTokens: number;
    bufferPercent: number;
    /** Model used for summarization; empty = the session model. */
    model?: string;
  };
}

export interface TuiConfig {
  theme: "dark" | "light" | "mono";
  showThinking: boolean;
  showToolOutput: boolean;
  showUsage: boolean;
  vimMode: boolean;
  mouse: boolean;
  maxVisibleMessages: number;
  /** Keyboard shortcuts: command -> key or keys. */
  keybinds: Record<string, string | string[]>;
}

export interface LoggingConfig {
  level: "debug" | "info" | "warn" | "error";
  file?: string;
  maxBytes: number;
}

export interface PluginConfig {
  package: string;
  options?: Record<string, unknown>;
  enabled?: boolean;
}

/** A profile is a deep override of the base configuration. */
export type ProfileOverride = Record<string, unknown>;

export interface Config {
  $schema?: string;
  version: number;
  /** Active profile (can be changed with --profile or LOCALCODE_PROFILE). */
  profile: string;
  profiles: Record<string, ProfileOverride>;
  server: ServerConfig;
  provider: ProviderConfig;
  model: ModelConfig;
  system: SystemPromptConfig;
  ollama: OllamaConfigBlock;
  agent: AgentConfig;
  tools: ToolsConfig;
  permissions: PermissionRule[];
  commands: Record<string, CommandDefinition>;
  skills: SkillsConfig;
  mcp: McpConfig;
  session: SessionConfig;
  tui: TuiConfig;
  logging: LoggingConfig;
  plugins: Array<string | PluginConfig>;
}

/** Loaded configuration with provenance metadata. */
export interface LoadedConfig {
  config: Config;
  /** Loaded files, from lowest to highest priority. */
  sources: string[];
  /** Detected project root directory. */
  directory: string;
}
