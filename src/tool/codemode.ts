import type { ToolContext, ToolDefinition } from "../types/tool.ts";
import { PermissionDeniedError } from "../util/errors.ts";
import { safeStringify } from "../util/logger.ts";

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (
  ...args: string[]
) => (...values: unknown[]) => Promise<unknown>;

/**
 * Code Mode: runs JavaScript that combines tools and fetch in a single
 * round trip to the model. No imports or direct filesystem access: everything goes
 * through the tool catalog and respects its permissions.
 */
export const executeTool: ToolDefinition = {
  id: "execute",
  description:
    "Runs JavaScript in Code Mode to combine tools in parallel and process their results without filling the context. Use `tools.<id>(args)`, `fetch(url)`, and return the result with `return`. No imports or direct filesystem access.",
  parameters: {
    type: "object",
    properties: {
      code: {
        type: "string",
        description:
          "JavaScript code. Example: const [a, b] = await Promise.all([tools.read({path:'a.ts'}), tools.read({path:'b.ts'})]); return a.output + b.output;",
      },
    },
    required: ["code"],
  },
  permission: { action: "execute", resource: () => "*" },
  async execute(ctx, args): Promise<{ title?: string; output: string; error?: boolean }> {
    const code = String(args.code ?? "");
    const available = ctx.enabledTools ?? [];
    const api: Record<string, unknown> = {};
    for (const tool of available) {
      api[tool.id] = async (toolArgs: Record<string, unknown> = {}) => {
        if (tool.permission) {
          const resource = tool.permission.resource(toolArgs, ctx);
          const allowed = await ctx.askPermission(tool.permission.action, resource, `${tool.id}: ${resource}`);
          if (!allowed) throw new PermissionDeniedError(tool.permission.action, resource);
        }
        const result = await tool.execute(ctx, toolArgs);
        return { ...result, output: result.output.slice(0, 20_000) };
      };
    }
    const ns = new Proxy(api, {
      get(target, prop: string) {
        if (prop in target) return target[prop];
        return undefined;
      },
    });
    try {
      const fn = new AsyncFunction("tools", "fetch", "session", "config", `"use strict";\n${code}\n`);
      const result = await fn(ns, fetch, ctx.session, ctx.config);
      const text = typeof result === "string" ? result : safeStringify(result);
      return { title: "execute", output: truncate(text) };
    } catch (error) {
      return { output: `Code Mode error: ${String(error)}`, error: true };
    }
  },
};

function truncate(text: string): string {
  return text.length > 51_200 ? `${text.slice(0, 51_200)}\n…[truncated]` : text;
}
