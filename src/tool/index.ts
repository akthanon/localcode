import { ToolRegistry } from "./registry.ts";
import { fileTools } from "./files.ts";
import { bashTool } from "./shell.ts";
import { webTools } from "./web.ts";
import { interactionTools } from "./interaction.ts";
import { subagentTool } from "./subagent.ts";
import { executeTool } from "./codemode.ts";

export function createToolRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(...fileTools, bashTool, ...webTools, ...interactionTools, subagentTool, executeTool);
  return registry;
}

export { ToolRegistry };
export * from "./files.ts";
export * from "./shell.ts";
export * from "./web.ts";
export * from "./interaction.ts";
export * from "./subagent.ts";
export * from "./codemode.ts";
