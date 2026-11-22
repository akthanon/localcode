import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { platform, release } from "node:os";

import type { AgentDefinition, SkillDefinition, ToolDefinition } from "../types/tool.ts";
import type { Config } from "../types/config.ts";
import type { Session } from "../types/message.ts";
import { DEFAULT_SYSTEM_PROMPT } from "../config/defaults.ts";
import { resolveModelSelector } from "../config/validate.ts";

export interface SystemPromptInput {
  config: Config;
  agent: AgentDefinition;
  directory: string;
  model: string;
  tools: ToolDefinition[];
  skills: SkillDefinition[];
  session?: Session;
  /** Additional files (e.g. skill instructions). */
  extraFiles?: string[];
}

/** Substitutes variables in a system prompt template. */
export function applyTemplate(
  template: string,
  input: SystemPromptInput,
  extra: Record<string, string> = {},
): string {
  const { config, agent, directory, model } = input;
  const modelName = resolveModelSelector(config, model).model;

  const date = new Date().toISOString().slice(0, 10);
  const datetime = new Date().toISOString();
  const values: Record<string, string> = {
    cwd: directory,
    directory,
    model: modelName,
    agent: agent.id,
    agentDescription: agent.description ?? "",
    date,
    datetime,
    os: platform(),
    osRelease: release(),
    shell: config.tools.shell,
    profile: config.profile,
    // Uppercase aliases for templates such as {{MODEL}} / {{AGENT}}.
    CWD: directory,
    DIRECTORY: directory,
    MODEL: modelName,
    AGENT: agent.id,
    AGENT_DESCRIPTION: agent.description ?? "",
    DATE: date,
    DATETIME: datetime,
    OS: platform(),
    SHELL: config.tools.shell,
    PROFILE: config.profile,
    ...config.system.variables,
    ...extra,
  };

  let result = template.replace(/\{\{([A-Za-z_][\w.]*)\}\}/g, (match, key: string) => {
    if (key in values) return values[key]!;
    if (key.startsWith("env.")) return process.env[key.slice(4)] ?? "";
    return match;
  });
  result = result.replace(/\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, key: string) => process.env[key] ?? "");
  return result;
}

function readInstructionFiles(input: SystemPromptInput): string[] {
  const files = [...new Set([...input.config.system.files, ...(input.extraFiles ?? [])])];
  const contents: string[] = [];
  for (const file of files) {
    const path = file.startsWith("/") || file.startsWith("~")
      ? resolve(input.directory, file.replace(/^~/, process.env.HOME ?? ""))
      : join(input.directory, file);
    if (!existsSync(path)) continue;
    try {
      const text = readFileSync(path, "utf8").trim();
      if (text) contents.push(`<instructions source="${file}">\n${text}\n</instructions>`);
    } catch {
      // An unreadable instruction file must not break the session.
    }
  }
  return contents;
}

/**
 * Builds the final system prompt. This is where full prompt control lives,
 * which OpenCode does not offer for local models.
 */
export function buildSystemPrompt(input: SystemPromptInput): string {
  const { config, agent } = input;
  const sys = config.system;
  const sections: string[] = [];

  // 1. Base prompt + per-agent instructions.
  // `agent.system` is a full replacement (custom agents); `agent.instructions`
  // is role-specific text appended to the shared base. Keeping them separate
  // means switching agents still changes behavior even with a global prompt.
  const userPrompt = sys.prompt ? applyTemplate(sys.prompt, input) : "";
  const agentInstructions = agent.instructions ? applyTemplate(agent.instructions, input) : "";
  const basePrompt = agent.system ?? (sys.includeDefault ? DEFAULT_SYSTEM_PROMPT : "");

  let core: string;
  if (sys.mode === "replace") {
    core = [userPrompt || basePrompt, agentInstructions].filter(Boolean).join("\n\n");
  } else if (sys.mode === "prepend") {
    core = [userPrompt, basePrompt, agentInstructions].filter(Boolean).join("\n\n");
  } else {
    core = [basePrompt, agentInstructions, userPrompt].filter(Boolean).join("\n\n");
  }
  if (core) sections.push(core);

  // 2. Project instruction files.
  const files = readInstructionFiles(input);
  if (files.length) sections.push(...files);

  // 3. Environment.
  if (sys.includeEnvironment) {
    const modelName = resolveModelSelector(config, input.model).model;
    sections.push(
      [
        "# Environment",
        `- Directory: ${input.directory}`,
        `- OS: ${platform()} ${release()}`,
        `- Shell: ${config.tools.shell}`,
        `- Local model: ${modelName}`,
        `- Profile: ${config.profile}`,
      ].join("\n"),
    );
  }

  // 4. Available tools.
  if (sys.includeToolDescriptions && input.tools.length) {
    const lines = input.tools.map((tool) => {
      const props = Object.entries(tool.parameters.properties ?? {})
        .map(([name, schema]) => `${name}${schema.required ? "" : "?"}: ${schema.type}`)
        .join(", ");
      return `- ${tool.id}(${props}): ${tool.description.split("\n")[0]}`;
    });
    sections.push(`# Available tools\n${lines.join("\n")}`);
  }

  // 5. Skills.
  if (sys.includeSkills && input.skills.length) {
    sections.push(
      `# Available skills\n${input.skills
        .map((s) => `- ${s.id}: ${s.description}`)
        .join("\n")}`,
    );
  }

  // 6. User-defined sections (in insertion order).
  for (const [name, content] of Object.entries(sys.sections)) {
    sections.push(`# ${name}\n${applyTemplate(content, input)}`);
  }

  return sections.join(sys.separator).trim();
}
