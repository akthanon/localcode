import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { homedir } from "node:os";

import type { Config } from "../types/config.ts";
import type { SkillDefinition } from "../types/tool.ts";
import { parseFrontmatter } from "../util/frontmatter.ts";

/** Discovers skills in ~/.config/localcode/skills, .localcode/skills, and config.skills.paths. */
export class SkillLoader {
  readonly skills = new Map<string, SkillDefinition>();
  private readonly sources: string[] = [];
  private readonly config: Config;
  private readonly directory: string;

  constructor(config: Config, directory: string) {
    this.config = config;
    this.directory = directory;
    if (!config.skills.enabled) return;
    const roots = [
      join(homedir(), ".config", "localcode", "skills"),
      join(this.directory, ".localcode", "skills"),
      ...(config.skills.paths ?? []).map((p) => (p.startsWith("/") || p.startsWith("~") ? p : join(this.directory, p))),
    ];
    for (const root of new Set(roots)) this.scanRoot(root);
    if (config.skills.autoDiscover) {
      const nested = join(this.directory, "skills");
      if (existsSync(nested)) this.scanRoot(nested);
    }
  }

  private scanRoot(root: string): void {
    const expanded = root.replace(/^~/, homedir());
    if (!existsSync(expanded)) return;
    let entries: string[];
    try {
      entries = readdirSync(expanded);
    } catch {
      return;
    }
    for (const entry of entries) {
      const skillFile = join(expanded, entry, "SKILL.md");
      const singleFile = join(expanded, entry);
      const file = existsSync(skillFile) ? skillFile : /\.md$/i.test(entry) ? singleFile : undefined;
      if (!file) continue;
      try {
        const { data, body } = parseFrontmatter(readFileSync(file, "utf8"));
        const id = typeof data.id === "string" ? data.id : basename(entry).replace(/\.md$/i, "");
        this.skills.set(id, {
          id,
          name: typeof data.name === "string" ? data.name : id,
          description: typeof data.description === "string" ? data.description : body.split("\n")[0] ?? "",
          content: body,
          path: file,
        });
        this.sources.push(file);
      } catch {
        // Invalid skill: skip it
      }
    }
  }

  list(): SkillDefinition[] {
    return [...this.skills.values()];
  }

  get(id: string): SkillDefinition | undefined {
    return this.skills.get(id);
  }

  fileSources(): string[] {
    return this.sources;
  }
}
