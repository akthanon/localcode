import { randomUUID } from "node:crypto";
import type { Config } from "../types/config.ts";
import type { Message, Session, StreamEvent, ToolCallRecord } from "../types/message.ts";
import type { ToolContext, ToolDefinition, ToolResult } from "../types/tool.ts";
import type { OllamaToolCall } from "../types/ollama.ts";
import type { ChatParams, ModelProvider } from "../provider/types.ts";
import type { ProviderRegistry } from "../provider/registry.ts";
import type { ToolRegistry } from "../tool/registry.ts";
import type { SessionStore } from "../session/store.ts";
import type { SessionManager } from "../session/manager.ts";
import type { PermissionEngine } from "../permission/engine.ts";
import type { PluginManager } from "../plugin/loader.ts";
import type { AgentLoader } from "./loader.ts";
import type { SkillLoader } from "../skill/loader.ts";
import type { CommandLoader } from "../command/loader.ts";
import type { McpManager } from "../mcp/client.ts";
import { resolveOllamaParams } from "../config/resolve.ts";
import { PermissionDeniedError } from "../util/errors.ts";
import { buildSystemPrompt } from "./system-prompt.ts";

export interface RunnerDeps {
  config: Config;
  directory: string;
  provider: ModelProvider;
  registry: ProviderRegistry;
  tools: ToolRegistry;
  agents: AgentLoader;
  skills: SkillLoader;
  commands: CommandLoader;
  store: SessionStore;
  sessions: SessionManager;
  permissions: PermissionEngine;
  plugins: PluginManager;
  mcp: McpManager;
  emit: (event: StreamEvent | Record<string, unknown>) => void;
  askPermission?: (action: string, resource: string, description: string) => Promise<boolean>;
  askQuestion?: ToolContext["askQuestion"];
  autoApprove?: boolean;
}

export interface RunOptions {
  agent?: string;
  model?: string;
  systemPrompt?: string;
  maxSteps?: number;
  signal?: AbortSignal;
  /** Skip automatic titles and compaction (useful in tests). */
  skipMaintenance?: boolean;
}

/** Main agent loop: model -> tools -> model. */
/** Normalizes names so `web_search` / `web-search` resolve to `websearch`. */
export function normalizeToolName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function resolveToolByName(tools: ToolDefinition[], name: string): ToolDefinition | undefined {
  return tools.find((tool) => tool.id === name)
    ?? tools.find((tool) => normalizeToolName(tool.id) === normalizeToolName(name));
}

/** A recoverable tool error: tells the model to continue instead of stopping. */
export function unavailableToolMessage(name: string, tools: ToolDefinition[]): string {
  const available = tools.map((tool) => tool.id).join(", ") || "(none)";
  return [
    `Tool "${name}" is not available.`,
    `Available tools: ${available}.`,
    "Do not stop the task because of this. Continue with an available tool (use webfetch or bash/curl for web access) or give a short final answer with what you have.",
  ].join("\n");
}

export class AgentRunner {
  private readonly deps: RunnerDeps;

  constructor(deps: RunnerDeps) {
    this.deps = deps;
  }

  async run(session: Session, input: string, options: RunOptions = {}): Promise<Session> {
    const { config, store, emit } = this.deps;
    const agent = this.deps.agents.get(options.agent ?? session.agent ?? config.agent.default);
    session.agent = agent.id;
    if (options.model) session.model = options.model;
    this.deps.permissions.autoApprove = Boolean(this.deps.autoApprove);

    const userMessage: Message = {
      id: randomUUID(),
      role: "user",
      content: input,
      createdAt: new Date().toISOString(),
    };
    store.appendMessage(session, userMessage);
    emit({ type: "message", message: userMessage, sessionID: session.id });

    const maxSteps = options.maxSteps ?? agent.steps ?? config.agent.maxSteps ?? 0;
    const enabledTools = this.deps.tools.enabled(config, agent.tools);
    const allTools = [...enabledTools, ...this.deps.plugins.tools(), ...this.deps.mcp.listTools()];
    const signal = options.signal;

    let step = 0;
    let compactedAfterError = false;
    while (true) {
      if (signal?.aborted) {
        emit({ type: "error", error: "Execution cancelled", sessionID: session.id });
        break;
      }
      step++;
      emit({ type: "step", step, sessionID: session.id });
      await this.deps.plugins.emit("before-request", { session, step });

      if (!options.skipMaintenance && this.deps.sessions.shouldCompact(session)) {
        if (this.deps.sessions.canCompact(session)) {
          emit({ type: "status", status: "Compacting context…", sessionID: session.id });
          const compacted = await this.deps.sessions.compact(session);
          if (!compacted) {
            const reason = this.deps.sessions.lastError;
            emit({
              type: "status",
              status: `Compaction failed; continuing with the current context${reason ? ` (${reason})` : ""}`,
              sessionID: session.id,
            });
          }
        } else {
          emit({ type: "status", status: "Context is nearly full but no older messages can be compacted yet", sessionID: session.id });
        }
      }

      const resolved = this.resolveParams(session, agent.id, options);
      const systemPrompt = options.systemPrompt ?? await this.buildSystem(session, agent.id, allTools, resolved.system);
      const params: ChatParams = {
        model: session.model,
        messages: this.toProviderMessages(session),
        tools: step === maxSteps && maxSteps > 0 ? undefined : this.deps.tools.toOllamaTools(allTools),
        options: resolved.options,
        request: resolved.request,
        // If no prompt was computed, fall back to `ollama.request.system`.
        system: systemPrompt || undefined,
        signal,
      };

      let text = "";
      let thinking = "";
      const toolCalls: OllamaToolCall[] = [];
      let usage: Record<string, unknown> | undefined;
      const messageID = randomUUID();

      try {
        for await (const chunk of this.deps.provider.chat(params)) {
          if (chunk.text) {
            text += chunk.text;
            emit({ type: "text-delta", delta: chunk.text, sessionID: session.id, messageID });
          }
          if (chunk.thinking) {
            thinking += chunk.thinking;
            emit({ type: "thinking-delta", delta: chunk.thinking, sessionID: session.id, messageID });
          }
          toolCalls.push(...chunk.toolCalls);
          if (chunk.usage) usage = chunk.usage as Record<string, unknown>;
          if (chunk.error) emit({ type: "error", error: chunk.error, sessionID: session.id });
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const contextError = /context|too long|token|length|api\/chat/i.test(message);
        if (contextError && !compactedAfterError && !signal?.aborted) {
          compactedAfterError = true;
          emit({ type: "status", status: "Context full; compacting and retrying…", sessionID: session.id });
          const compacted = await this.deps.sessions.compact(session);
          if (compacted) continue;
          const reason = this.deps.sessions.lastError;
          emit({ type: "error", error: `${message}${reason ? ` · compaction: ${reason}` : ""}`, sessionID: session.id });
          store.save(session);
          return session;
        }
        emit({ type: "error", error: message, sessionID: session.id });
        store.save(session);
        return session;
      }

      if (usage) {
        const promptTokens = Number(usage.prompt_eval_count ?? 0);
        const outputTokens = Number(usage.eval_count ?? 0);
        emit({
          type: "usage",
          usage: { ...usage, contextWindow: Number(resolved.options.num_ctx ?? 0) },
          sessionID: session.id,
        });
        if (promptTokens > 0) {
          session.metadata ??= {};
          session.metadata.contextTokens = promptTokens + outputTokens;
        }
      }

      const toolCallsForMessage = toolCalls.length ? this.normalizeToolCalls(toolCalls) : undefined;
      if (!text && !thinking && !toolCallsForMessage?.length) {
        emit({ type: "status", status: "Model returned no content; try again", sessionID: session.id });
        break;
      }
      const assistantMessage: Message = {
        id: messageID,
        role: "assistant",
        content: text,
        thinking: thinking || undefined,
        createdAt: new Date().toISOString(),
        model: session.model,
        toolCalls: toolCallsForMessage,
      };
      store.appendMessage(session, assistantMessage);
      emit({ type: "message", message: assistantMessage, sessionID: session.id });

      if (!assistantMessage.toolCalls?.length) break;
      if (maxSteps > 0 && step >= maxSteps) {
        const finalMessage: Message = {
          id: randomUUID(),
          role: "assistant",
          content: "Step limit reached. Summarizing the work done.",
          createdAt: new Date().toISOString(),
        };
        store.appendMessage(session, finalMessage);
        emit({ type: "message", message: finalMessage, sessionID: session.id });
        break;
      }

      const toolResults = await this.executeToolCalls(session, assistantMessage.toolCalls, allTools, signal);
      if (signal?.aborted) break;
      if (!toolResults.length) break;
      // Stop looping if every tool failed because of a permission denial.
      const isPermissionDenial = (result: ToolResult) =>
        result.error === true &&
        (result.metadata?.permissionDenied === true || /permission denied/i.test(result.output));
      if (toolResults.length && toolResults.every(isPermissionDenial)) break;
    }

    if (!options.skipMaintenance) await this.deps.sessions.autoTitle(session);
    await this.deps.plugins.emit("after-response", { session });
    emit({ type: "done", sessionID: session.id });
    store.save(session);
    return session;
  }

  private resolveParams(session: Session, agentID: string, options: RunOptions) {
    const agent = this.deps.agents.get(agentID);
    return resolveOllamaParams(this.deps.config, options.model ?? session.model, {
      options: agent.ollama?.options,
      request: agent.ollama?.request,
    });
  }

  private async buildSystem(
    session: Session,
    agentID: string,
    tools: ToolDefinition[],
    modelSystem?: string,
  ): Promise<string> {
    const agent = this.deps.agents.get(agentID);
    // A model-level system prompt is a full replacement: drop role instructions
    // so they are not duplicated under a different base.
    const sys = modelSystem ? { ...agent, system: modelSystem, instructions: undefined } : agent;
    return buildSystemPrompt({
      config: this.deps.config,
      agent: sys,
      directory: session.directory,
      model: session.model,
      tools,
      skills: this.deps.skills.list(),
      session,
    });
  }

  private normalizeToolCalls(calls: OllamaToolCall[]): ToolCallRecord[] {
    return calls.map((call) => {
      let args = call.function.arguments;
      if (typeof args === "string") {
        try {
          args = JSON.parse(args) as Record<string, unknown>;
        } catch {
          args = {};
        }
      }
      return {
        id: call.id ?? randomUUID(),
        name: call.function.name,
        arguments: (args ?? {}) as Record<string, unknown>,
      };
    });
  }

  private toProviderMessages(session: Session): ChatParams["messages"] {
    const messages: ChatParams["messages"] = [];
    for (const message of session.messages) {
      if (message.compacted || message.role === "system") continue;
      if (message.role === "tool") {
        messages.push({
          role: "tool",
          content: message.content,
          tool_name: message.toolName,
          tool_call_id: message.toolCallId,
        });
      } else {
        const call = message.toolCalls?.length
          ? message.toolCalls.map((c) => ({
              id: c.id,
              function: { name: c.name, arguments: c.arguments },
            }))
          : undefined;
        messages.push({
          role: message.role as "user" | "assistant",
          content: message.content,
          images: message.images,
          tool_calls: call,
        });
      }
    }
    return messages;
  }

  private async executeToolCalls(
    session: Session,
    calls: ToolCallRecord[],
    allTools: ToolDefinition[],
    signal?: AbortSignal,
  ): Promise<Array<ToolResult & { callID: string; tool: string }>> {
    const results: Array<ToolResult & { callID: string; tool: string }> = [];
    for (const call of calls) {
      if (signal?.aborted) break;
      const tool = resolveToolByName(allTools, call.name);
      this.deps.emit({ type: "tool-call", call, sessionID: session.id });
      await this.deps.plugins.emit("tool-call", { call, session });

      if (!tool) {
        const output = unavailableToolMessage(call.name, allTools);
        this.deps.emit({ type: "status", status: `Tool unavailable: ${call.name}`, sessionID: session.id });
        this.appendToolMessage(session, call, output, call.name, true);
        this.deps.emit({
          type: "tool-result",
          result: { callID: call.id, tool: call.name, output, error: true },
          sessionID: session.id,
        });
        results.push({ callID: call.id, tool: call.name, output, error: true });
        continue;
      }

      const ctx = this.makeContext(session, signal, allTools, call.id);
      try {
        if (["edit", "write"].includes(tool.id) && typeof call.arguments.path === "string") {
          const { resolve } = await import("node:path");
          const path = call.arguments.path.startsWith("/")
            ? call.arguments.path
            : resolve(session.directory, call.arguments.path);
          this.deps.store.snapshot(session.id, path);
        }
        const result = await tool.execute(ctx, call.arguments);
        const aliasNote = tool.id !== call.name ? `Note: "${call.name}" was resolved to "${tool.id}".\n` : "";
        const output = `${aliasNote}${result.output}`;
        this.appendToolMessage(session, call, output, tool.id, result.error);
        this.deps.emit({
          type: "tool-result",
          result: {
            callID: call.id,
            tool: tool.id,
            title: result.title,
            output,
            error: result.error,
          },
          sessionID: session.id,
        });
        results.push({ ...result, output, callID: call.id, tool: tool.id });
      } catch (error) {
        const output = error instanceof Error ? error.message : String(error);
        const permissionDenied =
          error instanceof PermissionDeniedError ||
          (error as { code?: string } | null)?.code === "PERMISSION_DENIED";
        this.appendToolMessage(session, call, output, tool.id, true);
        this.deps.emit({
          type: "tool-result",
          result: { callID: call.id, tool: tool.id, output, error: true },
          sessionID: session.id,
        });
        results.push({
          callID: call.id,
          tool: tool.id,
          output,
          error: true,
          metadata: permissionDenied ? { permissionDenied: true } : undefined,
        });
      }
    }
    return results;
  }

  private appendToolMessage(session: Session, call: ToolCallRecord, output: string, tool: string, error?: boolean): void {
    const message: Message = {
      id: randomUUID(),
      role: "tool",
      content: output,
      toolCallId: call.id,
      toolName: tool,
      createdAt: new Date().toISOString(),
      metadata: { error },
    };
    this.deps.store.appendMessage(session, message);
    this.deps.emit({ type: "message", message, sessionID: session.id });
  }

  private makeContext(
    session: Session,
    signal: AbortSignal | undefined,
    allTools: ToolDefinition[],
    callID?: string,
  ): ToolContext {
    const deps = this.deps;
    const engine = deps.permissions;
    return {
      session,
      directory: session.directory,
      config: deps.config,
      signal,
      callID,
      enabledTools: allTools,
      askPermission: async (action, resource, description) => {
        deps.emit({
          type: "permission",
          request: { id: randomUUID(), action, resource, description },
          sessionID: session.id,
        });
        if (deps.askPermission) return deps.askPermission(action, resource, description);
        return engine.authorize(action, resource, description);
      },
      askQuestion: deps.askQuestion,
      getSkill: (id) => deps.skills.get(id),
      emit: (event) => deps.emit(event as StreamEvent),
      startSubagent: (agent, prompt, description) => this.startSubagent(session, agent, prompt, description, signal),
      updateTask: (sessionID, patch) => {
        const task = session.pendingTasks?.find((t) => t.sessionID === sessionID);
        if (task) Object.assign(task, patch);
        deps.store.save(session);
      },
      saveSession: async () => deps.store.save(session),
    };
  }

  /** Starts a background subagent and delivers its report to the parent. */
  async startSubagent(
    parent: Session,
    agentID: string,
    prompt: string,
    description: string,
    signal?: AbortSignal,
  ): Promise<string> {
    const child = this.deps.store.create({
      directory: parent.directory,
      agent: agentID,
      model: parent.model,
      parentID: parent.id,
      title: description,
      metadata: { depth: Number(parent.metadata?.depth ?? 0) + 1 },
    });
    parent.pendingTasks = [
      ...(parent.pendingTasks ?? []),
      { sessionID: child.id, description, state: "running" },
    ];
    this.deps.store.save(parent);

    void this.run(child, prompt, { agent: agentID, signal })
      .then(() => {
        const report = child.messages.filter((m) => m.role === "assistant").at(-1)?.content ?? "(no report)";
        const message: Message = {
          id: randomUUID(),
          role: "user",
          content: `<subagent>\n  <sessionID>${child.id}</sessionID>\n  <description>${description}</description>\n  <report>${report}</report>\n</subagent>`,
          createdAt: new Date().toISOString(),
        };
        this.deps.store.appendMessage(parent, message);
        this.deps.emit({ type: "message", message, sessionID: parent.id });
        const task = parent.pendingTasks?.find((t) => t.sessionID === child.id);
        if (task) {
          task.state = "idle";
          task.report = report;
        }
        this.deps.store.save(parent);
      })
      .catch((error) => {
        this.deps.emit({ type: "error", error: String(error), sessionID: parent.id });
      });
    return child.id;
  }
}
