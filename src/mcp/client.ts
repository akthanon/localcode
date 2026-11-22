import { spawn, type ChildProcess } from "node:child_process";
import type { Config, McpServerConfig } from "../types/config.ts";
import type { ToolContext, ToolDefinition, ToolResult } from "../types/tool.ts";
import { logger } from "../util/logger.ts";

interface JsonRpcMessage {
  jsonrpc: "2.0";
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string };
}

interface McpTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

/** Minimal MCP client over stdio (JSON-RPC 2.0). */
export class McpClient {
  private readonly name: string;
  private readonly options: McpServerConfig;
  private readonly config: Config;
  private child?: ChildProcess;
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private buffer = "";
  private readonly log = logger.child("mcp");

  constructor(name: string, options: McpServerConfig, config: Config) {
    this.name = name;
    this.options = options;
    this.config = config;
  }

  async connect(): Promise<void> {
    if (this.options.type !== "local" || !this.options.command?.length) {
      this.log.warn(`MCP server ${this.name} is not local or has no command`);
      return;
    }
    const [command, ...args] = this.options.command;
    this.child = spawn(command!, args, {
      cwd: process.cwd(),
      env: { ...process.env, ...(this.options.env ?? {}) },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stdout?.on("data", (data: Buffer) => this.onData(data.toString("utf8")));
    this.child.stderr?.on("data", (data: Buffer) => this.log.debug(`[${this.name}] ${data.toString().trim()}`));
    this.child.on("exit", (code) => {
      this.log.warn(`MCP server ${this.name} exited with code ${code}`);
      for (const { reject } of this.pending.values()) reject(new Error("MCP server terminated"));
      this.pending.clear();
    });

    await this.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "LocalCode", version: "0.1.0" },
    });
    this.notify("notifications/initialized", {});
  }

  private onData(text: string): void {
    this.buffer += text;
    let index = this.buffer.indexOf("\n");
    while (index >= 0) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (line) {
        try {
          const message = JSON.parse(line) as JsonRpcMessage;
          if (message.id !== undefined && this.pending.has(message.id)) {
            const { resolve, reject } = this.pending.get(message.id)!;
            this.pending.delete(message.id);
            if (message.error) reject(new Error(message.error.message));
            else resolve(message.result);
          }
        } catch {
          // Ignore non-JSON lines
        }
      }
      index = this.buffer.indexOf("\n");
    }
  }

  private send(message: JsonRpcMessage): void {
    this.child?.stdin?.write(`${JSON.stringify(message)}\n`);
  }

  private request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timeout in MCP ${this.name}.${method}`));
      }, this.options.timeout ?? this.config.mcp.timeout);
      timer.unref?.();
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  private notify(method: string, params: unknown): void {
    this.send({ jsonrpc: "2.0", method, params });
  }

  async tools(): Promise<ToolDefinition[]> {
    if (!this.child) return [];
    const result = (await this.request("tools/list", {})) as { tools?: McpTool[] };
    const client = this;
    return (result.tools ?? []).map((tool) => this.toToolDefinition(tool, client));
  }

  private toToolDefinition(tool: McpTool, client: McpClient): ToolDefinition {
    return {
      id: `${this.name}_${tool.name}`,
      description: tool.description ?? `MCP tool ${tool.name} from ${this.name}`,
      parameters: (tool.inputSchema ?? { type: "object", properties: {} }) as ToolDefinition["parameters"],
      permission: {
        action: `${this.name}_${tool.name}`,
        resource: () => "*",
      },
      async execute(_ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> {
        const response = (await client.callTool(tool.name, args)) as {
          content?: Array<{ type: string; text?: string }>;
          isError?: boolean;
        };
        const output = (response.content ?? [])
          .map((item) => (item.type === "text" ? item.text ?? "" : `[${item.type}]`))
          .join("\n");
        return { output: output || "(no output)", error: response.isError === true };
      },
    };
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    return this.request("tools/call", { name, arguments: args });
  }

  close(): void {
    this.child?.kill();
    this.child = undefined;
  }
}

/** Manages all configured MCP servers. */
export class McpManager {
  private readonly clients = new Map<string, McpClient>();
  private tools: ToolDefinition[] = [];
  private readonly log = logger.child("mcp-manager");
  private readonly config: Config;

  constructor(config: Config) {
    this.config = config;
  }

  async initialize(): Promise<void> {
    for (const [name, options] of Object.entries(this.config.mcp.servers ?? {})) {
      if (options.enabled === false) continue;
      try {
        const client = new McpClient(name, options, this.config);
        await client.connect();
        this.clients.set(name, client);
        const tools = await client.tools();
        this.tools.push(...tools);
      } catch (error) {
        this.log.warn(`Could not connect to MCP server ${name}`, String(error));
      }
    }
  }

  listTools(): ToolDefinition[] {
    return this.tools;
  }

  status(): Array<{ name: string; connected: boolean; tools: number }> {
    return [...this.clients.entries()].map(([name, client]) => ({
      name,
      connected: true,
      tools: this.tools.filter((t) => t.id.startsWith(`${name}_`)).length,
    }));
  }

  close(): void {
    for (const client of this.clients.values()) client.close();
    this.clients.clear();
    this.tools = [];
  }
}
