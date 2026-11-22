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
    return this.estimateTokens(session.messages) > limit - reserve;
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
  async compact(session: Session): Promise<void> {
    const keepTokens = this.config.session.compaction.keepTokens;
    let split = session.messages.length;
    let acc = 0;
    for (let i = session.messages.length - 1; i >= 0; i--) {
      acc += this.estimateTokens([session.messages[i]!]);
      if (acc > keepTokens) {
        split = i + 1;
        break;
      }
    }
    const old = session.messages.slice(0, Math.max(0, split - 1));
    const recent = session.messages.slice(Math.max(0, split - 1));
    if (old.length < 3) return;

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
    const transcript = old
      .map((m) => `<${m.role}${m.toolName ? ` tool="${m.toolName}"` : ""}>${m.content.slice(0, 3000)}</${m.role}>`)
      .join("\n");

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
      if (!summary.trim()) return;

      const summaryMessage: Message = {
        id: randomUUID(),
        role: "user",
        content: `<conversation-summary>\n${summary.trim()}\n</conversation-summary>`,
        createdAt: new Date().toISOString(),
        metadata: { compaction: true },
      };
      session.messages = [summaryMessage, ...recent.map((m) => ({ ...m, compacted: false }))];
      this.store.save(session);
    } catch {
      // If compaction fails, continue with the full context.
    }
  }
}
