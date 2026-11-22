import { spawn, spawnSync } from "node:child_process";
import { createWriteStream, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ToolContext, ToolDefinition, ToolResult } from "../types/tool.ts";
import { prepareToolOutput } from "../util/output.ts";
import { expandHome, isInside } from "../util/path.ts";
import { webfetchTool, websearchTool } from "./web.ts";

export interface DelegatedToolCommand {
  tool: "websearch" | "webfetch";
  args: Record<string, string>;
}

/** Detects `websearch query="..."` / `webfetch url=...` issued through bash. */
export function parseToolCommand(command: string): DelegatedToolCommand | undefined {
  const match = /^(websearch|web_search|web-search|webfetch)\b([\s\S]*)$/i.exec(command.trim());
  if (!match) return undefined;
  const tool = /^webfetch$/i.test(match[1]!) ? "webfetch" : "websearch";
  const rest = match[2]!.trim();
  if (!rest) return undefined;
  // Do not delegate composed shell commands; they must really run in the shell.
  if (/[|;&<>`$\n]/.test(rest.replace(/"[^"]*"|'[^']*'/g, ""))) return undefined;

  const named = new RegExp(`^${tool === "websearch" ? "query" : "url"}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|(\\S+))$`, "i");
  const positional = /^(?:"([^"]*)"|'([^']*)'|(\S+))$/;
  const found = named.exec(rest) ?? positional.exec(rest);
  const value = found?.[1] ?? found?.[2] ?? found?.[3];
  if (!value) return undefined;
  return { tool, args: { [tool === "websearch" ? "query" : "url"]: value } };
}

function resolveWorkdir(ctx: ToolContext, workdir?: string): string {
  if (!workdir) return ctx.directory;
  const expanded = expandHome(workdir);
  const path = expanded.startsWith("/") ? resolve(expanded) : resolve(ctx.directory, expanded);
  if (!existsSync(path)) throw new Error(`Directory does not exist: ${path}`);
  return path;
}

/** Runs a command with the user's shell. */
export function executeShell(
  command: string,
  cwd: string,
  shell: string,
  timeout: number,
  signal?: AbortSignal,
  onOutput?: (chunk: string, stream: "stdout" | "stderr") => void,
): Promise<{ stdout: string; stderr: string; exitCode: number | null; killed: boolean }> {
  return new Promise((resolvePromise, reject) => {
    // detached makes the shell a process-group leader, so cancellation can
    // terminate the shell AND its children (nmap, gobuster, etc.).
    const child = spawn(shell, ["-lc", command], {
      cwd,
      env: process.env as Record<string, string>,
      detached: true,
    });
    let stdout = "";
    let stderr = "";
    let killed = false;
    let killTimer: NodeJS.Timeout | undefined;

    const kill = (signalName: NodeJS.Signals) => {
      if (!child.pid) return;
      try {
        process.kill(-child.pid, signalName);
      } catch {
        try { child.kill(signalName); } catch { /* already gone */ }
      }
    };
    const terminate = (force = false) => {
      killed = true;
      kill(force ? "SIGKILL" : "SIGTERM");
      if (!force && !killTimer) killTimer = setTimeout(() => kill("SIGKILL"), 2000);
    };
    const timer = setTimeout(() => terminate(true), timeout);
    timer.unref?.();
    const onAbort = () => terminate(false);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();

    const read = (stream: "stdout" | "stderr") => (data: Buffer) => {
      const text = data.toString("utf8");
      if (stream === "stdout") stdout += text;
      else stderr += text;
      onOutput?.(text, stream);
    };
    child.stdout?.on("data", read("stdout"));
    child.stderr?.on("data", read("stderr"));
    child.on("error", (error) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      signal?.removeEventListener("abort", onAbort);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      signal?.removeEventListener("abort", onAbort);
      resolvePromise({ stdout, stderr, exitCode: code, killed });
    });
  });
}

export const bashTool: ToolDefinition = {
  id: "bash",
  description:
    "Runs a command in the user's shell. Use `workdir` instead of `cd`. For long processes use `background: true`. Output is truncated automatically.",
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", description: "Command to run" },
      workdir: { type: "string", description: "Working directory relative to the project" },
      timeout: { type: "integer", description: "Timeout in milliseconds" },
      background: { type: "boolean", description: "Run in the background", default: false },
      description: { type: "string", description: "Short description for the user" },
    },
    required: ["command"],
  },
  permission: { action: "bash", resource: (args) => String(args.command ?? "*") },
  async execute(ctx, args): Promise<ToolResult> {
    const command = String(args.command ?? "");
    const delegated = parseToolCommand(command);
    if (delegated) {
      const enabled = ctx.enabledTools?.some((tool) => tool.id === delegated.tool) ?? true;
      if (!enabled) {
        return {
          output: `Tool "${delegated.tool}" is disabled. Enable it in tools.enabled, or use curl through bash. Do not stop the task because of this.`,
          error: true,
        };
      }
      const tool = delegated.tool === "websearch" ? websearchTool : webfetchTool;
      const result = await tool.execute(ctx, delegated.args);
      return {
        title: result.title ?? delegated.tool,
        output: `Note: "${command}" was handled by the ${delegated.tool} tool.\n${result.output}`,
        error: result.error,
        metadata: { delegatedTo: delegated.tool },
      };
    }
    const cwd = resolveWorkdir(ctx, args.workdir ? String(args.workdir) : undefined);
    if (!isInside(ctx.directory, cwd)) {
      const ok = await ctx.askPermission("external_directory", cwd, `Run in ${cwd}`);
      if (!ok) return { output: "Permission denied for that directory", error: true };
    }

    if (args.background) {
      const logDir = join(ctx.directory, ".localcode", "logs");
      const { mkdirSync } = await import("node:fs");
      mkdirSync(logDir, { recursive: true });
      const outPath = join(logDir, `bg-${Date.now()}.log`);
      const out = createWriteStream(outPath);
      const child = spawn(ctx.config.tools.shell, ["-lc", command], {
        cwd,
        env: process.env as Record<string, string>,
        detached: true,
        stdio: ["ignore", out.fd, out.fd],
      });
      child.unref();
      ctx.signal?.addEventListener("abort", () => {
        if (!child.pid) return;
        try { process.kill(-child.pid, "SIGTERM"); } catch { /* already gone */ }
      }, { once: true });
      ctx.emit({ type: "background-started", command, log: outPath, pid: child.pid });
      return { title: "background", output: `Background process (pid ${child.pid}). Log: ${outPath}` };
    }

    const timeout = Number(args.timeout ?? ctx.config.tools.bash.defaultTimeout);
    const emitOutput = (chunk: string, stream: "stdout" | "stderr") => {
      ctx.emit({
        type: "tool-output",
        callID: ctx.callID,
        tool: "bash",
        chunk,
        stream,
        sessionID: ctx.session.id,
      });
    };
    try {
      const result = await executeShell(command, cwd, ctx.config.tools.shell, timeout, ctx.signal, emitOutput);
      const managed = prepareToolOutput(
        [result.stdout, result.stderr].filter(Boolean).join("\n") || "(no output)",
        {
          directory: ctx.directory,
          sessionID: ctx.session.id,
          callID: ctx.callID,
          previewBytes: Number(ctx.config.tools.bash.previewBytes ?? 8192),
          previewLines: Number(ctx.config.tools.bash.previewLines ?? 120),
          saveFullOutput: ctx.config.tools.bash.saveFullOutput ?? true,
        },
      );
      const status = result.killed
        ? " [TIMED OUT]"
        : result.exitCode === 0
          ? ""
          : ` [exit ${result.exitCode}]`;
      return {
        title: args.description ? String(args.description) : command.slice(0, 60),
        output: `${managed.text}${status}`,
        error: result.exitCode !== 0,
        metadata: {
          exitCode: result.exitCode,
          killed: result.killed,
          truncated: managed.truncated,
          fullOutput: managed.fullPath,
          totalLines: managed.totalLines,
          totalBytes: managed.totalBytes,
        },
      };
    } catch (error) {
      return { output: `Command execution failed: ${String(error)}`, error: true };
    }
  },
};

/** Utility for detecting the available shell (used by config). */
export function detectShell(): string {
  const candidates = [process.env.SHELL, "/bin/bash", "/bin/zsh", "/bin/sh"].filter(Boolean) as string[];
  for (const shell of candidates) {
    const result = spawnSync(shell, ["-c", "true"], { stdio: "ignore" });
    if (result.status === 0) return shell;
  }
  return "/bin/sh";
}
