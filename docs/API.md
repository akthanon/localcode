# HTTP API and SDK

The server starts with `localcode serve` (or automatically with the TUI).
By default it listens on `http://127.0.0.1:4096`, with the `/api` prefix.

```bash
node src/index.ts serve --port 4096
```

## Authentication and CORS

If `server.authToken` is set, all requests require:

```
Authorization: Bearer <token>
```

`server.cors: true` adds CORS headers and responds to `OPTIONS`.

## Endpoints

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/` | Welcome HTML page |
| `GET` | `/openapi.json` | OpenAPI document |
| `GET` | `/api/info` | Runtime, models, agents, and tools information |
| `GET` | `/api/health` | Provider status `{ "ok": true }` |
| `GET` | `/api/config` | Effective configuration and sources |
| `PATCH` | `/api/config` | Merges changes into the in-memory configuration |
| `POST` | `/api/config/reload` | Reloads from disk |
| `GET` | `/api/providers` | Configured providers |
| `GET` | `/api/models` | Discovered models + catalog |
| `POST` | `/api/models/refresh` | Forces discovery |
| `GET` | `/api/agents` | Available agents |
| `GET` | `/api/skills` | Available skills |
| `GET` | `/api/commands` | Slash commands |
| `GET` | `/api/tools` | Enabled tools |
| `GET` | `/api/permissions` | Permission rules |
| `POST` | `/api/permissions/:id/respond` | Responds `{ "approved": true|false }` |
| `GET` | `/api/mcp` | MCP server status |
| `GET` | `/api/plugins` | Loaded plugins |
| `GET` | `/api/sessions` | Session list |
| `POST` | `/api/sessions` | Creates session `{ agent, model, title }` |
| `GET` | `/api/sessions/:id` | Full session |
| `PATCH` | `/api/sessions/:id` | Updates `title`, `agent`, `model` |
| `DELETE` | `/api/sessions/:id` | Deletes session |
| `GET` | `/api/sessions/:id/messages` | Session messages |
| `POST` | `/api/sessions/:id/prompt?stream=true` | Runs prompt (SSE by default) |
| `POST` | `/api/sessions/:id/abort` | Cancels execution |
| `POST` | `/api/sessions/:id/compact` | Compacts the context |
| `GET` | `/api/sessions/:id/export?format=markdown\|json` | Exports the session |

### Prompt

```bash
curl -N -X POST http://127.0.0.1:4096/api/sessions/<id>/prompt \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"hello","model":"qwen2.5-coder:7b","agent":"build"}'
```

`?stream=false` returns the full session as JSON instead of SSE.

## SSE events

Each event is a `data: {...}\n\n` line.

| `type` | Fields | Meaning |
| --- | --- | --- |
| `message` | `message` | Message added (user/assistant/tool) |
| `step` | `step` | Start of an agent loop step |
| `text-delta` | `delta`, `messageID` | Text fragment from the model |
| `thinking-delta` | `delta`, `messageID` | Reasoning fragment |
| `usage` | `usage` | Ollama statistics plus `contextWindow` (`num_ctx`) |
| `tool-call` | `call` | The model requested a tool |
| `tool-output` | `callID`, `tool`, `chunk`, `stream` | Incremental stdout/stderr from a running tool |
| `tool-result` | `result` | Tool result |
| `permission` | `request` | Permission awaiting a response |
| `status` | `status` | Status (compacting, reloading, ...) |
| `error` | `error` | Error during execution |
| `done` | — | Execution finished |

All events carry `sessionID` when applicable.

## TypeScript SDK

```ts
import { LocalCodeClient } from "./src/sdk/client.ts";

const client = new LocalCodeClient({
  baseURL: "http://127.0.0.1:4096",
  apiKey: "optional",
});

await client.health();
await client.info();
const models = await client.listModels();

const session = await client.createSession({ model: models[0].id, title: "Demo" });

for await (const event of client.prompt(session.id, "explain this project")) {
  switch (event.type) {
    case "text-delta":
      process.stdout.write((event as { delta: string }).delta);
      break;
    case "permission": {
      const id = (event as { request: { id: string } }).request.id;
      await client.respondPermission(id, true);
      break;
    }
  }
}

const final = await client.getSession(session.id);
console.log(final.messages.length);
```

Available methods: `info`, `health`, `listModels`, `listSessions`, `createSession`,
`getSession`, `messages`, `deleteSession`, `prompt` (async generator),
`respondPermission`.

## Example permission flow

1. The model requests `bash` with `rm -rf /tmp/x` and the rule is `ask`.
2. The server emits `permission` with an `id` and blocks execution.
3. The client responds `POST /api/permissions/<id>/respond` with `{"approved":false}`.
4. The agent loop continues (or stops if all tools were denied).
