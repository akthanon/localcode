import type { Config } from "../types/config.ts";
import type { Message, Session } from "../types/message.ts";
import type { ModelProvider } from "../provider/types.ts";
import type { AgentLoader } from "../agent/loader.ts";
import type { SessionStore } from "./store.ts";
import { resolveOllamaParams } from "../config/resolve.ts";
import { buildSystemPrompt } from "../agent/system-prompt.ts";
import { randomUUID } from "node:crypto";

/** Automatic titles, context compaction, and token estimation. */
export class SessionManager {
  /** Last compaction failure, exposed for status messages and diagnostics. */
  lastError?: string;
  private readonly config: Config;
  private readonly provider: ModelProvider;
  private readonly agents: AgentLoader;
  private readonly store: SessionStore;

  constructor(config: Config, provider: ModelProvider, agents: AgentLoader, store: SessionStore) {
    this.config = config;
    this.provider = provider;
    this.agents = agents;
    this.store = store;
  }

  /** Keeps title/compaction prompts in sync after a config reload. */
  updateAgents(agents: AgentLoader): void {
    this.agents = agents;
  }

  /** Rough but useful estimate for local models (~4 chars/token). */
  estimateTokens(messages: Message[]): number {
    const chars = messages.reduce((sum, message) => {
      return sum + (message.content?.length ?? 0) + (message.thinking?.length ?? 0) + JSON.stringify(message.toolCalls ?? []).length;
    }, 0);
    return Math.ceil(chars / 4);
  }

  contextLimit(session: Session): number {
    const params = resolveOllamaParams(this.config, session.model);
    return Number(params.options.num_ctx ?? 32768);
  }

  shouldCompact(session: Session): boolean {
    if (!this.config.session.compaction.auto) return false;
    const limit = this.contextLimit(session);
    const reserve = Math.ceil(limit * (this.config.session.compaction.bufferPercent / 100));
    const estimated = this.estimateTokens(session.messages);
    const measured = Number(session.metadata?.contextTokens ?? 0);
    return Math.max(estimated, measured) > limit - reserve;
  }

  /** True when this session has enough older messages to summarize. */
  canCompact(session: Session): boolean {
    const split = this.compactionSplit(session);
    return split > 3;
  }

  private compactionSplit(session: Session): number {
    const keepTokens = this.config.session.compaction.keepTokens;
    const reserve = Math.ceil(this.contextLimit(session) * (this.config.session.compaction.bufferPercent / 100));
    let acc = 0;
    let split = session.messages.length;
    for (let i = session.messages.length - 1; i >= 0; i--) {
      acc += this.estimateTokens([session.messages[i]!]);
      if (acc > Math.min(keepTokens, reserve)) {
        split = i + 1;
        break;
      }
    }
    return split;
  }

  shouldAutoTitle(session: Session): boolean {
    return this.config.session.autoTitle && session.title === "New session" &&
      session.messages.some((m) => m.role === "user");
  }

  /** Generates a short title using the local model itself. */
  async autoTitle(session: Session): Promise<void> {
    if (!this.shouldAutoTitle(session)) return;
    const agent = this.agents.get("title");
    const system = buildSystemPrompt({
      config: this.config,
      agent,
      directory: session.directory,
      model: session.model,
      tools: [],
      skills: [],
      session,
      extraFiles: [],
    });
    const firstUser = session.messages.find((m) => m.role === "user");
    try {
      const result = await this.provider.chat({
        model: session.model,
        messages: [{ role: "user", content: firstUser?.content.slice(0, 2000) ?? "" }],
        system,
        options: { ...resolveOllamaParams(this.config, session.model).options, num_predict: 24, temperature: 0 },
        request: { stream: false, think: false },
      });
      let text = "";
      for await (const chunk of result) text += chunk.text;
      const title = text.trim().split("\n")[0]?.replace(/^["'#*-]+\s*/, "").slice(0, 60);
      if (title) {
        session.title = title;
        this.store.save(session);
      }
    } catch {
      // If title generation fails, keep the generic title.
    }
  }

  /** Summarizes the older conversation and keeps recent messages. */
  async compact(session: Session): Promise<boolean> {
    this.lastError = undefined;
    const split = this.compactionSplit(session);
    const old = session.messages.slice(0, Math.max(0, split - 1));
    const recent = session.messages.slice(Math.max(0, split - 1));
    if (old.length < 3) return false;

    const agent = this.agents.get("compaction");
    const system = buildSystemPrompt({
      config: this.config,
      agent,
      directory: session.directory,
      model: session.model,
      tools: [],
      skills: [],
      session,
    });
    // Keep the summary request inside the model's context window. Prefer the
    // most recent old messages and drop older ones when the budget is reached.
    const budget = Math.max(4000, Math.min(12000, Math.floor(this.contextLimit(session) * 0.15 * 4)));
    const parts: string[] = [];
    let used = 0;
    for (const m of [...old].reverse()) {
      const part = `<${m.role}${m.toolName ? ` tool="${m.toolName}"` : ""}>${m.content.slice(0, 400)}</${m.role}>`;
      if (used + part.length > budget) break;
      parts.unshift(part);
      used += part.length;
    }
    const transcript = parts.join("\n");

    try {
      const stream = await this.provider.chat({
        model: this.config.session.compaction.model || session.model,
        messages: [{ role: "user", content: `Summary of the previous conversation:\n\n${transcript}` }],
        system,
        options: { ...resolveOllamaParams(this.config, session.model).options, num_predict: 2048 },
        request: { stream: false, think: false },
      });
      let summary = "";
      for await (const chunk of stream) summary += chunk.text;
      if (!summary.trim()) {
        this.lastError = "summary was empty";
        return false;
      }

      const summaryMessage: Message = {
        id: randomUUID(),
        role: "user",
        content: `<conversation-summary>\n${summary.trim()}\n</conversation-summary>`,
        createdAt: new Date().toISOString(),
        metadata: { compaction: true },
      };
      const notice: Message = {
        id: randomUUID(),
        role: "system",
        content: "Context compacted: older messages were summarized.",
        createdAt: new Date().toISOString(),
        metadata: { compactionNotice: true },
      };
      session.messages = [notice, summaryMessage, ...recent.map((m) => ({ ...m, compacted: false }))];
      session.metadata ??= {};
      delete session.metadata.contextTokens;
      this.store.save(session);
      return true;
    } catch (error) {
      // If compaction fails, continue with the full context.
      this.lastError = error instanceof Error ? error.message : String(error);
      return false;
    }
  }
}
