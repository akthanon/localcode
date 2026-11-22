import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";

import type { Config } from "../types/config.ts";
import type { CommandDefinition } from "../types/tool.ts";
import { parseFrontmatter } from "../util/frontmatter.ts";
import { applyTemplate } from "../agent/system-prompt.ts";
import type { AgentDefinition, SkillDefinition, ToolDefinition } from "../types/tool.ts";

export interface BuiltinCommandInfo {
  id: string;
  description: string;
}

export const BUILTIN_COMMANDS: BuiltinCommandInfo[] = [
  { id: "help", description: "Show available commands" },
  { id: "models", description: "Select the local model" },
  { id: "agent", description: "Switch the active agent" },
  { id: "new", description: "Create a new session" },
  { id: "sessions", description: "List and switch sessions" },
  { id: "clear", description: "Clear the current session history" },
  { id: "compact", description: "Summarize the conversation to free context" },
  { id: "config", description: "Show or modify configuration" },
  { id: "reload", description: "Reload agents, skills, commands, and MCP" },
  { id: "skills", description: "List available skills" },
  { id: "mcp", description: "Show MCP server status" },
  { id: "permissions", description: "Show permission rules" },
  { id: "params", description: "Show effective Ollama parameters" },
  { id: "export", description: "Export the session to Markdown/JSON" },
  { id: "undo", description: "Undo the last edit (snapshots)" },
  { id: "quit", description: "Exit LocalCode" },
];

/** Loads custom slash commands from config and Markdown files. */
export class CommandLoader {
  readonly commands = new Map<string, CommandDefinition>();
  private readonly config: Config;
  private readonly directory: string;

  constructor(config: Config, directory: string) {
    this.config = config;
    this.directory = directory;
    for (const cmd of BUILTIN_COMMANDS) {
      this.commands.set(cmd.id, { id: cmd.id, description: cmd.description, template: "" });
    }
    for (const [id, command] of Object.entries(config.commands ?? {})) {
      this.commands.set(id, { id, ...command });
    }
    const dirs = [
      join(homedir(), ".config", "localcode", "commands"),
      join(this.directory, ".localcode", "commands"),
    ];
    for (const dir of dirs) {
      if (!existsSync(dir)) continue;
      for (const file of readdirSync(dir)) {
        if (!file.endsWith(".md")) continue;
        const { data, body } = parseFrontmatter(readFileSync(join(dir, file), "utf8"));
        const id = typeof data.id === "string" ? data.id : basename(file, ".md");
        this.commands.set(id, {
          id,
          description: typeof data.description === "string" ? data.description : undefined,
          agent: typeof data.agent === "string" ? data.agent : undefined,
          model: typeof data.model === "string" ? data.model : undefined,
          template: body,
        });
      }
    }
  }

  get(id: string): CommandDefinition | undefined {
    return this.commands.get(id);
  }

  list(): CommandDefinition[] {
    return [...this.commands.values()];
  }

  expand(
    id: string,
    args: string,
    ctx: {
      config: Config;
      agent: AgentDefinition;
      directory: string;
      model: string;
      tools: ToolDefinition[];
      skills: SkillDefinition[];
    },
  ): string {
    const command = this.get(id);
    if (!command) return args;
    const template = command.template.replace(/\$ARGUMENTS/g, args).replace(/\{args\}/g, args);
    return applyTemplate(template, ctx);
  }
}
