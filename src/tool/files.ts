import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

import type { ToolContext, ToolDefinition, ToolResult } from "../types/tool.ts";
import { matchesPattern } from "../permission/engine.ts";
import { expandHome, isInside } from "../util/path.ts";
import { numberedLines, truncateOutput } from "../util/output.ts";
import { globFiles } from "../util/glob.ts";

function resolveToolPath(ctx: ToolContext, path: string): string {
  const expanded = expandHome(String(path ?? ""));
  return isAbsolute(expanded) ? resolve(expanded) : resolve(ctx.directory, expanded);
}

async function checkExternalDirectory(ctx: ToolContext, path: string): Promise<boolean> {
  if (isInside(ctx.directory, path)) return true;
  return ctx.askPermission("external_directory", path, `Access ${path} outside the project`);
}

async function runFormatter(ctx: ToolContext, path: string): Promise<void> {
  const formatter = ctx.config.tools.formatter;
  if (!formatter || typeof formatter === "boolean") return;
  const name = basename(path);
  for (const [pattern, commands] of Object.entries(formatter)) {
    if (!matchesPattern(name, pattern) && !matchesPattern(path, pattern)) continue;
    for (const command of commands) {
      const final = command.replaceAll("{file}", JSON.stringify(path)).replaceAll("$FILE", JSON.stringify(path));
      spawnSync(ctx.config.tools.shell, ["-lc", final], { cwd: ctx.directory, stdio: "ignore" });
    }
  }
}

const objectSchema = (properties: Record<string, unknown>, required: string[]) => ({
  type: "object" as const,
  properties,
  required,
});

export const readTool: ToolDefinition = {
  id: "read",
  description:
    "Reads a text file or directory (non-recursive listing). Returns numbered lines. Use offset and limit for large files. Can also read images and PDFs.",
  parameters: objectSchema(
    {
      path: { type: "string", description: "Absolute path or path relative to the project directory" },
      offset: { type: "integer", description: "First line (1-based)", default: 1 },
      limit: { type: "integer", description: "Maximum number of lines", default: 2000 },
    },
    ["path"],
  ),
  permission: { action: "read", resource: (args) => String(args.path ?? "*") },
  async execute(ctx, args): Promise<ToolResult> {
    const path = resolveToolPath(ctx, String(args.path ?? ""));
    if (!existsSync(path)) return { output: `Error: not found: ${path}`, error: true };
    if (!(await checkExternalDirectory(ctx, path))) {
      return { output: `Permission denied to read ${path}`, error: true };
    }
    const stat = statSync(path);
    if (stat.isDirectory()) {
      const entries = readdirSync(path).map((name) => {
        const full = join(path, name);
        return `${statSync(full).isDirectory() ? "dir " : "file"} ${name}`;
      });
      return { title: path, output: entries.join("\n") };
    }
    const ext = extname(path).toLowerCase();
    if ([".png", ".jpg", ".jpeg", ".gif", ".webp", ".pdf"].includes(ext)) {
      if (stat.size > ctx.config.tools.read.maxImageBytes) {
        return { output: `Image too large (${stat.size} bytes)`, error: true };
      }
      const mime = ext === ".pdf" ? "application/pdf" : `image/${ext === ".jpg" ? "jpeg" : ext.slice(1)}`;
      return {
        title: path,
        output: `<image ${basename(path)}>`,
        images: [`data:${mime};base64,${readFileSync(path).toString("base64")}`],
      };
    }
    const text = readFileSync(path, "utf8");
    const offset = Number(args.offset ?? 1);
    const limit = Number(args.limit ?? ctx.config.tools.read.maxLines);
    const result = truncateOutput(numberedLines(text, offset, limit), {
      maxBytes: ctx.config.tools.read.maxBytes,
    });
    return { title: path, output: result.text };
  },
};

export const writeTool: ToolDefinition = {
  id: "write",
  description: "Creates or fully replaces a text file. Parent directories are created if needed.",
  parameters: objectSchema(
    {
      path: { type: "string", description: "File path" },
      content: { type: "string", description: "Full file content" },
    },
    ["path", "content"],
  ),
  permission: { action: "edit", resource: (args) => String(args.path ?? "*") },
  async execute(ctx, args): Promise<ToolResult> {
    const path = resolveToolPath(ctx, String(args.path ?? ""));
    if (!(await checkExternalDirectory(ctx, path))) {
      return { output: `Permission denied to write ${path}`, error: true };
    }
    const existed = existsSync(path);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, String(args.content ?? ""), "utf8");
    await runFormatter(ctx, path);
    return { title: path, output: `${existed ? "File updated" : "File created"}: ${path}` };
  },
};

export const editTool: ToolDefinition = {
  id: "edit",
  description:
    "Replaces exact text in an existing file. oldString must appear once unless replaceAll is true.",
  parameters: objectSchema(
    {
      path: { type: "string", description: "File path" },
      oldString: { type: "string", description: "Exact text to replace" },
      newString: { type: "string", description: "New text" },
      replaceAll: { type: "boolean", description: "Replace every occurrence", default: false },
    },
    ["path", "oldString", "newString"],
  ),
  permission: { action: "edit", resource: (args) => String(args.path ?? "*") },
  async execute(ctx, args): Promise<ToolResult> {
    const path = resolveToolPath(ctx, String(args.path ?? ""));
    if (!existsSync(path)) return { output: `File does not exist: ${path}`, error: true };
    if (!(await checkExternalDirectory(ctx, path))) {
      return { output: `Permission denied to edit ${path}`, error: true };
    }
    const content = readFileSync(path, "utf8");
    const oldString = String(args.oldString ?? "");
    const newString = String(args.newString ?? "");
    if (!oldString) return { output: "oldString cannot be empty", error: true };
    if (oldString === newString) return { output: "oldString and newString are identical", error: true };

    const occurrences = content.split(oldString).length - 1;
    if (occurrences === 0) return { output: `Text not found in ${path}`, error: true };
    if (occurrences > 1 && !args.replaceAll) {
      return { output: `Text appears ${occurrences} times; use replaceAll=true`, error: true };
    }
    const updated = args.replaceAll
      ? content.replaceAll(oldString, newString)
      : content.replace(oldString, newString);
    writeFileSync(path, updated, "utf8");
    await runFormatter(ctx, path);
    return { title: path, output: `Replaced in ${path} (${occurrences} occurrence(s))` };
  },
};

export const globTool: ToolDefinition = {
  id: "glob",
  description: "Finds file paths with a glob pattern such as **/*.ts. Returns paths relative to the project.",
  parameters: objectSchema(
    {
      pattern: { type: "string", description: "Glob pattern, e.g. src/**/*.ts" },
      path: { type: "string", description: "Base directory (default: project)" },
      hidden: { type: "boolean", description: "Include hidden files", default: false },
      limit: { type: "integer", description: "Maximum results", default: 100 },
    },
    ["pattern"],
  ),
  permission: { action: "glob", resource: (args) => String(args.pattern ?? "*") },
  async execute(ctx, args): Promise<ToolResult> {
    const base = args.path ? resolveToolPath(ctx, String(args.path)) : ctx.directory;
    const files = globFiles(String(args.pattern ?? "*"), base, {
      hidden: Boolean(args.hidden),
      limit: Number(args.limit ?? 100),
    });
    return {
      title: `glob: ${args.pattern}`,
      output: files.length ? files.join("\n") : "No files found",
      metadata: { count: files.length },
    };
  },
};

export const grepTool: ToolDefinition = {
  id: "grep",
  description: "Searches files for text or regex. Returns path, line number, and snippet.",
  parameters: objectSchema(
    {
      pattern: { type: "string", description: "Search pattern" },
      path: { type: "string", description: "Directory or file to search" },
      include: { type: "string", description: "File filter, e.g. *.ts" },
      literal: { type: "boolean", description: "Treat the pattern as literal text", default: false },
      caseSensitive: { type: "boolean", description: "Case-sensitive", default: true },
      limit: { type: "integer", description: "Maximum matches", default: 100 },
    },
    ["pattern"],
  ),
  permission: { action: "grep", resource: (args) => String(args.pattern ?? "*") },
  async execute(ctx, args): Promise<ToolResult> {
    const rawPath = args.path ? resolveToolPath(ctx, String(args.path)) : ctx.directory;
    const pattern = String(args.pattern ?? "");
    const limit = Number(args.limit ?? 100);
    let regex: RegExp;
    try {
      const escaped = args.literal ? pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : pattern;
      regex = new RegExp(escaped, args.caseSensitive ? "" : "i");
    } catch (error) {
      return { output: `Invalid regex: ${String(error)}`, error: true };
    }
    const files = existsSync(rawPath) && statSync(rawPath).isFile()
      ? [rawPath]
      : globFiles("**/*", rawPath, { limit: 5000 }).map((f) => join(rawPath, f));
    const matches: string[] = [];
    for (const file of files) {
      if (matches.length >= limit) break;
      if (args.include && !matchesPattern(file, String(args.include))) continue;
      let text: string;
      try {
        text = readFileSync(file, "utf8");
      } catch {
        continue;
      }
      if (text.includes("\u0000")) continue;
      const lines = text.split("\n");
      for (let i = 0; i < lines.length && matches.length < limit; i++) {
        if (regex.test(lines[i]!)) {
          matches.push(`${file}:${i + 1}: ${lines[i]!.slice(0, 300)}`);
        }
      }
    }
    return {
      title: `grep: ${pattern}`,
      output: matches.length ? matches.join("\n") : "No matches found",
      metadata: { count: matches.length },
    };
  },
};

export const fileTools = [readTool, writeTool, editTool, globTool, grepTool];
