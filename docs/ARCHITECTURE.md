# Architecture

LocalCode replicates OpenCode's separation of concerns, but with a single local
provider as a first-class citizen.

```text
CLI (src/index.ts)
  ├── TUI (src/tui/app.ts) ──────────────┐
  ├── API HTTP + SSE (src/server/app.ts) ┤
  └── SDK (src/sdk/client.ts) ───────────┤
                                          ▼
                               Runtime (src/runtime.ts)
                                          │
    ┌───────────────┬───────────────┬─────┴─────┬──────────────┬────────────┐
    ▼               ▼               ▼           ▼              ▼            ▼
Config         Providers       AgentRunner  Sessions      Permissions   Tools
loader/        Ollama native   LLM loop     store +       rules         read/write/
validate/      OpenAI-compat   ↔ tools      manager       allow/ask/    bash/web/
resolve        registry        emit events  title/        deny          MCP/plugins
                               system prompt compaction                 subagent
```

## Modules

| Path | Responsibility |
| --- | --- |
| `src/types/` | Configuration, Ollama, message, tool, and event types |
| `src/config/` | JSONC discovery, variables, profiles, validation, and precedence |
| `src/provider/` | Native Ollama client, OpenAI-compatible client, registry, and discovery |
| `src/agent/` | Agent loop runner, agent loader, and system prompt builder |
| `src/tool/` | Registry and tools (files, shell, web, interaction, subagent, Code Mode) |
| `src/session/` | Persistence, snapshots, and maintenance (title/compaction) |
| `src/permission/` | Ordered rule engine with wildcards |
| `src/skill/`, `src/command/` | Skills and slash command discovery |
| `src/mcp/` | JSON-RPC 2.0 stdio client and server management |
| `src/plugin/` | Plugin loading and lifecycle hooks |
| `src/server/` | REST API, SSE, OpenAPI, and CORS/auth |
| `src/sdk/` | TypeScript API client |
| `src/tui/` | ANSI terminal interface |
| `src/util/` | JSONC, deep merge, glob, paths, logging, errors, output |

## Request flow

1. The CLI, TUI, API, or SDK creates/gets a session in `SessionStore`.
2. `AgentRunner.run(session, input, options)`:
   1. Adds the user message and emits `message`.
   2. Resolves Ollama parameters with the configured precedence.
   3. Builds the system prompt (agent + config + files + environment + tools).
   4. Calls `provider.chat()` with messages, tools, `options`, and `request`.
   5. Emits `text-delta` / `thinking-delta` / `usage` as chunks arrive.
   6. Persists the assistant message. If there are `tool_calls`, runs each tool:
      checks permissions, emits `tool-call`/`tool-result`, adds `tool` messages, and repeats.
   7. Applies automatic title and compaction, emits `done`, and saves the session.
3. The server forwards all runtime events to the client via SSE.

## Ollama provider

`OllamaProvider` uses `/api/chat` (NDJSON) as the main path and `/api/generate` for
raw/FIM prompts. It builds the body with:

- `model`, `messages` (the system prompt as the first message), `stream`.
- `options`: all resolved runtime parameters.
- `think`, `keep_alive`, `format`, `raw`, `logprobs`, `top_logprobs`, `suffix`.
- `tools`: definitions in Ollama format.

It includes retries on failures before the first chunk, header/chunk/total timeouts,
custom headers, and apiKey. Discovery combines `/api/tags` (inventory) with
`/api/show` (capabilities, context, system prompt), and optionally `/api/ps`.

## Dependency-free design

The runtime uses only `node:*` modules and TypeScript with explicit `.ts` extensions.
Node.js 26 strips types at load time, so there is no build step.
This implies two constraints respected throughout the code:

- No *parameter properties* (`constructor(private x: T)`).
- No non-strippable TypeScript syntax (enums, namespaces, etc.).

## Events and extensibility

`Runtime.emit()` is the central bus. The TUI, the SSE server, and plugins subscribe
without coupling to the runner. Plugins can register additional tools and hooks;
MCP does the same with external servers. Both are injected into the runner's tool
list at each step.

## Phase 1 tests

`test/mock-ollama.ts` implements an HTTP server with `/api/tags`, `/api/show`,
`/api/version`, `/api/chat`, and `/api/generate`. It simulates streaming, `thinking`,
tool calls, and discovery. `test/phase1.test.ts` verifies the 10 critical areas
without contacting any real server.
