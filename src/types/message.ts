/** Data model for sessions and messages. */

export type MessageRole = "system" | "user" | "assistant" | "tool";

export interface ToolCallRecord {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ImagePart {
  type: "image";
  data: string;
  mimeType?: string;
}

export interface TextPart {
  type: "text";
  text: string;
}

export interface Message {
  id: string;
  role: MessageRole;
  content: string;
  createdAt: string;
  /** Model reasoning text (Ollama `thinking`). */
  thinking?: string;
  /** Tool calls requested by the model. */
  toolCalls?: ToolCallRecord[];
  /** For tool-role messages: id and name of the invoked tool. */
  toolCallId?: string;
  toolName?: string;
  /** Imágenes en base64 (visión). */
  images?: string[];
  /** Model that produced the message. */
  model?: string;
  /** Whether the message was removed from active context by compaction. */
  compacted?: boolean;
  metadata?: Record<string, unknown>;
}

export interface Session {
  id: string;
  title: string;
  /** Project working directory the session belongs to. */
  directory: string;
  /** ID of the active agent. */
  agent: string;
  /** `model` or `provider/model` selector used by the session. */
  model: string;
  /** Name of the applied configuration profile. */
  profile?: string;
  messages: Message[];
  createdAt: string;
  updatedAt: string;
  /** Parent session, if this is a subagent. */
  parentID?: string;
  /** Pending task delivered by a subagent. */
  pendingTasks?: Array<{ sessionID: string; description: string; report?: string; state: string }>;
  metadata?: Record<string, unknown>;
}

export interface SessionSummary {
  id: string;
  title: string;
  directory: string;
  agent: string;
  model: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
}

export type StreamEvent =
  | { type: "status"; status: string; sessionID?: string }
  | { type: "step"; step: number; sessionID?: string }
  | { type: "message"; message: Message; sessionID?: string }
  | { type: "text-delta"; delta: string; sessionID?: string; messageID?: string }
  | { type: "thinking-delta"; delta: string; sessionID?: string; messageID?: string }
  | { type: "tool-call"; call: ToolCallRecord; sessionID?: string }
  | { type: "tool-output"; callID?: string; tool: string; chunk: string; stream?: "stdout" | "stderr"; sessionID?: string }
  | { type: "tool-result"; result: ToolResultEvent; sessionID?: string }
  | { type: "permission"; request: PermissionRequestEvent; sessionID?: string }
  | { type: "usage"; usage: Record<string, unknown>; sessionID?: string }
  | {
      type: "config-reloaded";
      sources: string[];
      previousModel: string;
      previousProfile: string;
      model: string;
      agent: string;
    }
  | { type: "error"; error: string; sessionID?: string }
  | { type: "done"; sessionID?: string };

export interface ToolResultEvent {
  callID: string;
  tool: string;
  title?: string;
  output: string;
  error?: boolean;
}

export interface PermissionRequestEvent {
  id: string;
  action: string;
  resource: string;
  description: string;
}
