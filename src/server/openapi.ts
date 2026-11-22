/** OpenAPI 3.1 document for the LocalCode API. */
export const openApiDocument = {
  openapi: "3.1.0",
  info: {
    title: "LocalCode API",
    version: "0.1.0",
    description: "API for a local-first coding agent specialized in Ollama",
  },
  servers: [{ url: "http://127.0.0.1:4096" }],
  paths: {
    "/api/info": { get: { operationId: "info", responses: { "200": { description: "Server info" } } } },
    "/api/health": { get: { operationId: "health", responses: { "200": { description: "Ollama health" } } } },
    "/api/config": {
      get: { operationId: "config.get", responses: { "200": { description: "Current configuration" } } },
      patch: { operationId: "config.patch", responses: { "200": { description: "Updated configuration" } } },
    },
    "/api/config/reload": { post: { operationId: "config.reload", responses: { "200": { description: "Reloaded" } } } },
    "/api/models": { get: { operationId: "models.list", responses: { "200": { description: "Local models" } } } },
    "/api/models/refresh": { post: { operationId: "models.refresh", responses: { "200": { description: "Models" } } } },
    "/api/agents": { get: { operationId: "agents.list", responses: { "200": { description: "Agents" } } } },
    "/api/skills": { get: { operationId: "skills.list", responses: { "200": { description: "Skills" } } } },
    "/api/commands": { get: { operationId: "commands.list", responses: { "200": { description: "Commands" } } } },
    "/api/tools": { get: { operationId: "tools.list", responses: { "200": { description: "Tools" } } } },
    "/api/permissions": { get: { operationId: "permissions.list", responses: { "200": { description: "Rules" } } } },
    "/api/permissions/{id}/respond": {
      post: {
        operationId: "permissions.respond",
        parameters: [{ in: "path", name: "id", required: true, schema: { type: "string" } }],
        requestBody: { content: { "application/json": { schema: { type: "object", properties: { approved: { type: "boolean" } } } } } },
        responses: { "200": { description: "Responded" } },
      },
    },
    "/api/mcp": { get: { operationId: "mcp.status", responses: { "200": { description: "MCP servers" } } } },
    "/api/sessions": {
      get: { operationId: "session.list", responses: { "200": { description: "Sessions" } } },
      post: { operationId: "session.create", responses: { "201": { description: "Session created" } } },
    },
    "/api/sessions/{id}": {
      get: { operationId: "session.get", responses: { "200": { description: "Session" } } },
      patch: { operationId: "session.patch", responses: { "200": { description: "Session" } } },
      delete: { operationId: "session.delete", responses: { "200": { description: "Deleted" } } },
    },
    "/api/sessions/{id}/messages": { get: { operationId: "session.messages", responses: { "200": { description: "Messages" } } } },
    "/api/sessions/{id}/prompt": {
      post: {
        operationId: "session.prompt",
        parameters: [{ in: "query", name: "stream", schema: { type: "boolean", default: true } }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["prompt"],
                properties: {
                  prompt: { type: "string" },
                  agent: { type: "string" },
                  model: { type: "string" },
                  systemPrompt: { type: "string" },
                },
              },
            },
          },
        },
        responses: {
          "200": {
            description: "SSE events or full session",
            content: { "text/event-stream": { schema: { type: "string" } } },
          },
        },
      },
    },
    "/api/sessions/{id}/abort": { post: { operationId: "session.abort", responses: { "200": { description: "Cancelled" } } } },
    "/api/sessions/{id}/compact": { post: { operationId: "session.compact", responses: { "200": { description: "Compacted" } } } },
    "/api/sessions/{id}/export": { get: { operationId: "session.export", responses: { "200": { description: "Export" } } } },
  },
  components: {
    schemas: {
      Message: {
        type: "object",
        properties: {
          id: { type: "string" },
          role: { type: "string", enum: ["system", "user", "assistant", "tool"] },
          content: { type: "string" },
          thinking: { type: "string" },
          toolCalls: { type: "array", items: { type: "object" } },
          createdAt: { type: "string" },
        },
      },
      Session: {
        type: "object",
        properties: {
          id: { type: "string" },
          title: { type: "string" },
          directory: { type: "string" },
          agent: { type: "string" },
          model: { type: "string" },
          messages: { type: "array", items: { $ref: "#/components/schemas/Message" } },
        },
      },
    },
  },
} as const;
