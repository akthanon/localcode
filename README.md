# LocalCode

> Local coding agent, inspired by OpenCode and specialized in **Ollama**.
> No runtime dependencies: Node.js 26+ with native TypeScript type stripping.

LocalCode brings together in a single project a terminal TUI, an HTTP server with SSE, an SDK,
tools, agents, permissions, MCP, plugins, and persistent sessions. The focus is on
**controlling absolutely every Ollama parameter** and on **fully customizing
the system prompt**, something generic tools don't allow.

## Project status

- **Phase 1 ✅:** complete implementation verified with a simulated Ollama server
  (11 tests, without contacting any real server).
- **Phase 2 ✅:** tests against a real Ollama server (v0.40.16) with `gemma4:26b`:
  discovery, streaming, `think`, `format: json`, `keep_alive`, tool calling,
  system prompt, and API/SSE/SDK verified. See [`docs/PHASE2.md`](./docs/PHASE2.md).

## Requirements

- Node.js **26+** (uses `--experimental-strip-types` natively; no `tsc` or npm packages required).
- An Ollama server accessible over HTTP (phase 2 only).

## Getting started

```bash
cd /home/ubuntu/localcode

node src/index.ts version                 # version
node src/index.ts init                    # creates an example localcode.jsonc
node src/index.ts config                  # effective configuration
node src/index.ts models                  # discovered models
node src/index.ts run "explain this repo" # non-interactive mode
node src/index.ts serve                   # REST API + SSE on :4096
node src/index.ts                         # interactive TUI (requires tty)
```

You can also install it as a local binary:

```bash
npm link
localcode run "hello"
```

### Main flags

| Flag | Description |
| --- | --- |
| `--dir <path>` | Working directory |
| `--config <file>` | Explicit configuration file |
| `--profile <name>` | Configuration profile |
| `--model <model>` | Model or alias (accepts `model#variant`) |
| `--agent <agent>` | Agent (`build`, `plan`, `general`, `explore`, ...) |
| `--base-url <url>` | Ollama URL |
| `--system <text>` | Replaces the system prompt |
| `--system-file <file>` | Reads the system prompt from a file |
| `--max-steps <n>` | Agent loop step limit |
| `--auto-approve` | Approves `ask`-type permissions (non-interactive) |
| `--json` | JSON output in `run` and `models` |

Environment variables: `LOCALCODE_BASE_URL`, `LOCALCODE_MODEL`, `LOCALCODE_PROFILE`,
`LOCALCODE_CONFIG`, `LOCALCODE_CONFIG_CONTENT`, `LOCALCODE_PORT`, `LOCALCODE_HOST`,
`LOCALCODE_LOG_LEVEL`.

## Configuration

The native format is JSON with comments (JSONC). It searches, in order of increasing priority:

1. `/etc/localcode/localcode.json{,.jsonc}`
2. `~/.config/localcode/localcode.json{,.jsonc}`
3. Parent directories up to the root
4. `<dir>/.localcode/localcode.json{,.jsonc}`
5. `LOCALCODE_CONFIG_CONTENT` (inline JSON)

See [`localcode.example.jsonc`](./localcode.example.jsonc) for **all** documented options,
and [`docs/CONFIG.md`](./docs/CONFIG.md) for the complete reference.
For the system prompt, the definitive guide is [`docs/SYSTEM-PROMPT.md`](./docs/SYSTEM-PROMPT.md).

Minimal example:

```jsonc
{
  "$schema": "./schema/localcode.schema.json",
  "version": 1,
  "provider": { "baseURL": "http://127.0.0.1:11434", "transport": "native" },
  "model": { "default": "qwen2.5-coder:7b" },
  "system": {
    "mode": "replace",
    "prompt": "You are LocalCode. You have full access to the provided tools. Use them immediately and reply in the user's language.",
    "includeToolDescriptions": true
  },
  "ollama": {
    "options": { "temperature": 0.2, "num_ctx": 32768, "top_p": 0.9 },
    "request": { "think": false, "keep_alive": "10m" },
    "variants": {
      "creative": { "options": { "temperature": 1.1, "top_p": 0.95 } }
    }
  }
}
```

### Ollama parameter precedence

```
global (ollama.options)
  → model catalog (model.catalog.<id>.options)
    → per model (ollama.perModel.<id>.options)
      → variant (ollama.variants.<name>.options)
        → agent/session/CLI overrides
```

The same applies to `request` (`think`, `keep_alive`, `format`, `raw`, `stream`, `logprobs`,
`top_logprobs`, `suffix`, `system`). A `null` value removes the inherited key.

## Features

- **Native Ollama provider:** `/api/chat` and `/api/generate` with NDJSON, tool calls,
  thinking (`thinking`), discovery via `/api/tags` + `/api/show`, `/api/ps`,
  `/api/version`, pull/copy/delete, timeouts, retries, and headers.
- **Alternative transport:** OpenAI-compatible (LM Studio, vLLM, llama.cpp).
- **Configurable system prompt:** `replace`/`prepend`/`append` modes, files, variables,
  environment, tools, skills, commands, and custom sections.
- **Tools:** `read`, `write`, `edit`, `glob`, `grep`, `bash`, `webfetch`, `websearch`,
  `question`, `todowrite`, `skill`, `task` (subagents), and `execute` (Code Mode).
- **Agents and skills:** built-in (`build`, `plan`, `general`, `explore`, `compaction`,
  `title`), definitions in config and Markdown/JSONC file discovery.
- **Permissions:** ordered `allow`/`ask`/`deny` rules with wildcards.
- **Sessions:** disk persistence, automatic titles, compaction, and snapshots/undo.
- **MCP:** JSON-RPC 2.0 stdio client with tools exposed to the model.
- **Plugins:** `before-request`, `after-response`, `tool-call`, `session-start` hooks.
- **API + SDK:** REST, SSE, OpenAPI, CORS, token auth, and TypeScript client.
- **TUI:** command panel, models, agents, parameters, help, history, and overlays
  for permissions/questions.

## API and SDK

See [`docs/API.md`](./docs/API.md). Quick example:

```ts
import { LocalCodeClient } from "./src/sdk/client.ts";

const client = new LocalCodeClient({ baseURL: "http://127.0.0.1:4096" });
const session = await client.createSession({ model: "qwen2.5-coder:7b" });
for await (const event of client.prompt(session.id, "hello")) {
  if (event.type === "text-delta") process.stdout.write((event as { delta: string }).delta);
}
```

## Development

```bash
npm test          # phase 1 suite with mock Ollama (no external network)
npm run check     # checks TypeScript syntax across the whole project
npm run mock      # simulated Ollama server for manual testing
```

The suite covers: JSONC/profiles/validation, parameter precedence, system prompt,
provider streaming and tool calls, end-to-end agent loop, API/SSE/SDK, CLI,
and TUI headless mode.

## Architecture

See [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md).
