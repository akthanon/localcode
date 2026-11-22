import type { ToolContext, ToolDefinition } from "../types/tool.ts";

interface QuestionSpec {
  question: string;
  header: string;
  options: Array<{ label: string; description?: string }>;
  multiple?: boolean;
}

export const questionTool: ToolDefinition = {
  id: "question",
  description:
    "Asks the user a question with options and waits for an answer. Use it when there are ambiguous decisions or important alternatives.",
  requiresApproval: true,
  parameters: {
    type: "object",
    properties: {
      questions: {
        type: "array",
        description: "Questions to present",
        items: {
          type: "object",
          properties: {
            question: { type: "string" },
            header: { type: "string", description: "Short label (max 30 characters)" },
            options: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  label: { type: "string" },
                  description: { type: "string" },
                },
                required: ["label"],
              },
            },
            multiple: { type: "boolean" },
          },
          required: ["question", "header", "options"],
        },
      },
    },
    required: ["questions"],
  },
  permission: { action: "question", resource: () => "*" },
  async execute(ctx, args): Promise<{ title?: string; output: string }> {
    const questions = (Array.isArray(args.questions) ? args.questions : []) as QuestionSpec[];
    if (!questions.length) return { output: "No questions provided", error: true };
    if (!ctx.askQuestion) {
      const answers: Record<string, string> = {};
      for (const q of questions) answers[q.header] = q.options[0]?.label ?? "";
      return { output: JSON.stringify(answers, null, 2) };
    }
    const answers = await ctx.askQuestion(questions);
    ctx.emit({ type: "question-answered", answers });
    return { output: JSON.stringify(answers, null, 2) };
  },
};

export const todowriteTool: ToolDefinition = {
  id: "todowrite",
  description:
    "Records or updates the to-do list. Use it for multi-stage plans. Each item has content, status (pending|in_progress|completed), and priority (high|medium|low).",
  parameters: {
    type: "object",
    properties: {
      todos: {
        type: "array",
        items: {
          type: "object",
          properties: {
            content: { type: "string" },
            status: { type: "string", enum: ["pending", "in_progress", "completed", "cancelled"] },
            priority: { type: "string", enum: ["high", "medium", "low"] },
          },
          required: ["content", "status"],
        },
      },
    },
    required: ["todos"],
  },
  permission: { action: "todowrite", resource: () => "*" },
  async execute(ctx, args): Promise<{ title?: string; output: string }> {
    const todos = Array.isArray(args.todos) ? args.todos : [];
    ctx.session.metadata = { ...(ctx.session.metadata ?? {}), todos };
    await ctx.saveSession();
    const counts = todos.reduce<Record<string, number>>((acc, todo: { status: string }) => {
      acc[todo.status] = (acc[todo.status] ?? 0) + 1;
      return acc;
    }, {});
    return {
      title: "todowrite",
      output: `List updated: ${JSON.stringify(counts)}`,
    };
  },
};

export const skillTool: ToolDefinition = {
  id: "skill",
  description: "Loads the instructions and resources of an available skill by ID.",
  parameters: {
    type: "object",
    properties: { id: { type: "string", description: "Skill ID" } },
    required: ["id"],
  },
  permission: { action: "skill", resource: (args) => String(args.id ?? "*") },
  async execute(ctx, args): Promise<{ title?: string; output: string }> {
    const id = String(args.id ?? "");
    const skill = ctx.getSkill?.(id);
    if (!skill) return { output: `Skill not found: ${id}`, error: true };
    ctx.emit({ type: "skill-loaded", id });
    return { title: `skill: ${id}`, output: `# ${skill.name}\n\n${skill.content}` };
  },
};

export const interactionTools = [questionTool, todowriteTool, skillTool];

/** Helper for turning questions into readable TUI text. */
export function formatQuestions(questions: QuestionSpec[]): string {
  return questions
    .map((q) => `${q.header}: ${q.question}\n${q.options.map((o, i) => `  ${i + 1}. ${o.label}`).join("\n")}`)
    .join("\n\n");
}
