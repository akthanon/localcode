import type { ToolDefinition } from "../types/tool.ts";

/** Starts a background child agent with its own context. */
export const subagentTool: ToolDefinition = {
  id: "task",
  description:
    "Starts a background subagent to research or execute a task with its own context. Returns a sessionID; the report arrives as a message when done.",
  parameters: {
    type: "object",
    properties: {
      agent: { type: "string", description: "Subagent ID (e.g. explore, general)" },
      description: { type: "string", description: "Short 3-5 word description" },
      prompt: { type: "string", description: "Full, self-contained instruction for the subagent" },
    },
    required: ["agent", "description", "prompt"],
  },
  permission: { action: "subagent", resource: (args) => String(args.agent ?? "*") },
  async execute(ctx, args): Promise<{ title?: string; output: string }> {
    const agent = String(args.agent ?? "");
    const description = String(args.description ?? "subagent");
    const prompt = String(args.prompt ?? "");
    try {
      const sessionID = await ctx.startSubagent(agent, prompt, description);
      ctx.emit({ type: "subagent-started", sessionID, agent });
      return {
        title: `subagent: ${agent}`,
        output: `Subagent started (sessionID: ${sessionID}). You will receive its report when it finishes.`,
      };
    } catch (error) {
      return { output: `Failed to start subagent: ${String(error)}`, error: true };
    }
  },
};
