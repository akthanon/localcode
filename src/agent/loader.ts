import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { homedir } from "node:os";

import type { AgentDefinition } from "../types/tool.ts";
import type { Config } from "../types/config.ts";
import { frontmatterRecord, parseFrontmatter } from "../util/frontmatter.ts";

/** Built-in agents, equivalent to OpenCode's build/plan/general/explore. */
export const BUILTIN_AGENTS: AgentDefinition[] = [
  {
    id: "build",
    description: "Primary coding agent: reads, edits, and runs commands",
    mode: "primary",
    instructions: "Work autonomously until the task is complete. Use tools before answering.",
    color: "#7dd3fc",
  },
  {
    id: "plan",
    description: "Explores and plans without modifying project files",
    mode: "primary",
    instructions: "Plan mode: do NOT modify project files. Investigate and propose a numbered plan with concrete files and steps.",
    color: "#fbbf24",
    permissions: [{ action: "edit", resource: "*", effect: "deny" }],
  },
  {
    id: "general",
    description: "Multi-step research and work with broad tool access",
    mode: "subagent",
    color: "#a78bfa",
  },
  {
    id: "explore",
    description: "Quickly explores code without editing files",
    mode: "subagent",
    instructions: "Explore and report concrete findings with paths and line numbers. Do not edit anything.",
    color: "#34d399",
    permissions: [
      { action: "edit", resource: "*", effect: "deny" },
      { action: "bash", resource: "*", effect: "deny" },
    ],
  },
  {
    id: "compaction",
    description: "Summarizes the conversation to free context",
    mode: "all",
    hidden: true,
    system: "Summarize the conversation concisely, preserving decisions, modified files, and pending tasks.",
  },
  {
    id: "title",
    description: "Generates a short session title",
    mode: "all",
    hidden: true,
    system: "Return only a title of at most 5 words for the conversation.",
  },
];

/** Loads agents from Markdown/JSONC files and merges them with built-ins. */
export class AgentLoader {
  readonly agents = new Map<string, AgentDefinition>();
  private readonly sources: string[] = [];
  private readonly config: Config;
  private readonly directory: string;

  constructor(config: Config, directory: string) {
    this.config = config;
    this.directory = directory;
    for (const agent of BUILTIN_AGENTS) this.agents.set(agent.id, { ...agent });
    this.loadConfigAgents();
    this.loadFiles();
  }

  private loadConfigAgents(): void {
    for (const [id, def] of Object.entries(this.config.agent.definitions ?? {})) {
      const existing = this.agents.get(id);
      const system = (def as AgentDefinition).system;
      const merged: AgentDefinition = {
        ...(existing ?? { id, mode: "primary" as const }),
        ...def,
        id,
      };
      // An explicit `system` replaces the base; otherwise keep the built-in
      // full prompt (if any) or inherit the shared default at build time.
      if (system) merged.system = system;
      else if (!existing?.system) delete merged.system;
      this.agents.set(id, merged);
    }
  }

  private loadFiles(): void {
    const dirs: string[] = [join("/etc/localcode", "agents"), join(homedir(), ".config", "localcode", "agents")];
    let current = resolve(this.directory);
    const ancestors: string[] = [];
    while (true) {
      ancestors.unshift(current);
      const parent = join(current, "..");
      if (resolve(parent) === current) break;
      current = resolve(parent);
    }
    for (const dir of ancestors) dirs.push(join(dir, ".localcode", "agents"));

    for (const dir of dirs) {
      if (!existsSync(dir)) continue;
      for (const file of readdirSync(dir)) {
        if (!/\.(md|json|jsonc)$/i.test(file)) continue;
        const full = join(dir, file);
        try {
          const text = readFileSync(full, "utf8");
          let def: AgentDefinition;
          if (file.endsWith(".md")) {
            const { data, body } = parseFrontmatter(text);
            const nested = relative(dir, full).replace(/\.[^.]+$/, "").replace(/\\/g, "/");
            def = {
              id: typeof data.id === "string" ? data.id : nested,
              description: typeof data.description === "string" ? data.description : undefined,
              mode: (data.mode as AgentDefinition["mode"]) ?? "primary",
              model: typeof data.model === "string" ? data.model : undefined,
              steps: typeof data.steps === "number" ? data.steps : undefined,
              hidden: data.hidden === true,
              disabled: data.disabled === true,
              color: typeof data.color === "string" ? data.color : undefined,
              permissions: (data.permissions as AgentDefinition["permissions"]) ?? undefined,
              instructions: body || undefined,
            };
          } else {
            def = JSON.parse(text) as AgentDefinition;
            def.id = def.id ?? basename(file).replace(/\.[^.]+$/, "");
          }
          if (!def.disabled) this.agents.set(def.id, def);
          this.sources.push(full);
        } catch {
          // An invalid file does not prevent loading the others.
        }
      }
    }
  }

  get(id: string): AgentDefinition {
    const agent = this.agents.get(id);
    if (!agent) throw new Error(`Agent not found: ${id}`);
    return agent;
  }

  list(includeHidden = false): AgentDefinition[] {
    return [...this.agents.values()].filter(
      (a) => !a.disabled && (includeHidden || !a.hidden),
    );
  }

  primaryAgents(): AgentDefinition[] {
    return this.list().filter((a) => a.mode === "primary" || a.mode === "all");
  }

  subagents(): AgentDefinition[] {
    return this.list().filter((a) => a.mode === "subagent" || a.mode === "all");
  }

  defaultAgent(): AgentDefinition {
    const preferred = this.agents.get(this.config.agent.default);
    if (preferred && !preferred.disabled && !preferred.hidden && this.primaryAgents().includes(preferred)) {
      return preferred;
    }
    return this.get("build");
  }

  fileSources(): string[] {
    return this.sources;
  }
}
