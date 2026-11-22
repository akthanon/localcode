import type { Message, Session } from "./message.ts";
import type { Config, PermissionRule } from "./config.ts";

/** JSON Schema subset used for tool parameters. */
export interface JsonSchema {
  type: "object" | "string" | "number" | "integer" | "boolean" | "array" | "null";
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: Array<string | number | boolean>;
  default?: unknown;
  additionalProperties?: boolean | JsonSchema;
  [key: string]: unknown;
}

export interface ToolResult {
  /** Short title shown in the TUI. */
  title?: string;
  /** Text returned to the model. */
  output: string;
  /** Additional metadata (not sent to the model). */
  metadata?: Record<string, unknown>;
  /** Base64 images for vision models. */
  images?: string[];
  error?: boolean;
}

export interface ToolContext {
  session: Session;
  /** Project root directory. */
  directory: string;
  config: Config;
  /** Summarizes a permission request. Returns true when approved. */
  askPermission(action: string, resource: string, description: string): Promise<boolean>;
  /** Emits an event to the front-end (TUI/API). */
  emit(event: Record<string, unknown>): void;
  /** Cancellation signal for the current request. */
  signal?: AbortSignal;
  /** ID of the tool call, used to stream output to the front-end. */
  callID?: string;
  /** Message that originated the call (useful for subagents). */
  message?: Message;
  /** Presents interactive questions to the user. In auto mode the first option is used. */
  askQuestion?: (questions: Array<{
    question: string;
    header: string;
    options: Array<{ label: string; description?: string }>;
    multiple?: boolean;
  }>) => Promise<Record<string, string>>;
  /** Returns a loaded skill by id. */
  getSkill?: (id: string) => SkillDefinition | undefined;
  /** Tools habilitadas (necesario para Code Mode). */
  enabledTools?: ToolDefinition[];
  /** Starts a subagent and returns its sessionID. */
  startSubagent(agent: string, prompt: string, description: string): Promise<string>;
  /** Records the text of a pending subagent task. */
  updateTask(sessionID: string, patch: Record<string, unknown>): void;
  /** Persists the session to disk. */
  saveSession(): Promise<void>;
}

export interface ToolDefinition {
  /** Unique identifier sent to the model. */
  id: string;
  description: string;
  parameters: JsonSchema;
  /** Action template used for permissions. Defaults to `id:*`. */
  permission?: {
    action: string;
    resource: (args: Record<string, unknown>, ctx: ToolContext) => string;
  };
  /** Whether the tool requires interactive approval (question). */
  requiresApproval?: boolean;
  execute(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult>;
}

export interface AgentDefinition {
  id: string;
  description?: string;
  mode: "primary" | "subagent" | "all";
  /** Full system prompt. When set, it replaces the shared base prompt. */
  system?: string;
  /**
   * Role-specific instructions appended to the shared base prompt.
   * Built-in agents use this so switching agents still changes behavior even
   * when a global `system.prompt` is configured with `mode: "replace"`.
   */
  instructions?: string;
  model?: string;
  /** Maximum agent-loop steps (0 = no limit). */
  steps?: number;
  hidden?: boolean;
  disabled?: boolean;
  color?: string;
  permissions?: PermissionRule[];
  tools?: string[];
  /** Ollama option overrides for this agent. */
  ollama?: { options?: Record<string, unknown>; request?: Record<string, unknown> };
}

export interface SkillDefinition {
  id: string;
  name: string;
  description: string;
  content: string;
  path?: string;
}

export interface CommandDefinition {
  id: string;
  description?: string;
  template: string;
  agent?: string;
  model?: string;
  arguments?: Array<{ name: string; description?: string; required?: boolean }>;
}
