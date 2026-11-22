# Configuration reference

Format: **JSONC** (JSON with `//` and `/* */` comments, trailing commas allowed).
Default file: `localcode.json` or `localcode.jsonc`.

## Discovery

All existing files are merged, from lowest to highest priority:

1. `/etc/localcode/localcode.json`, `/etc/localcode/localcode.jsonc`
2. `~/.config/localcode/localcode.json`, `.jsonc`
3. Each parent directory, from the farthest to the nearest
4. `<each parent>/.localcode/localcode.json`, `.jsonc`
5. `LOCALCODE_CONFIG_CONTENT` (inline JSON, highest priority)
6. Selected profile (`--profile`, `LOCALCODE_PROFILE`, or `"profile"`)

You can also force a file with `localcode --config path/to/file.jsonc`.

## Variable substitution

The following are expanded in any string:

- `${VAR}` and `{env:VAR}` → environment variable.
- `{file:path}` → file contents (relative to the config directory).

```jsonc
{
  "provider": { "apiKey": "{env:OLLAMA_API_KEY}" },
  "system": { "prompt": "{file:./prompts/base.md}" }
}
```

## General structure

```jsonc
{
  "$schema": "./schema/localcode.schema.json",
  "version": 1,
  "profile": "default",
  "profiles": { "...": { "...": "deep override" } },

  "server": { "enabled": true, "host": "127.0.0.1", "port": 4096, "cors": true, "authToken": "", "basePath": "/api" },
  "provider": { "...": "see Provider" },
  "model": { "...": "see Models" },
  "system": { "...": "see System prompt" },
  "ollama": { "...": "see Ollama parameters" },
  "agent": { "...": "see Agents" },
  "tools": { "...": "see Tools" },
  "permissions": [ { "action": "bash", "resource": "git push *", "effect": "ask" } ],
  "commands": {},
  "skills": { "enabled": true, "autoDiscover": true, "paths": [] },
  "mcp": { "servers": {}, "timeout": 30000, "codemode": true },
  "session": { "...": "see Sessions" },
  "tui": { "...": "see TUI" },
  "logging": { "level": "info", "file": "" },
  "plugins": []
}
```

## Provider

```jsonc
"provider": {
  "type": "ollama",              // "ollama" | "openai-compatible"
  "baseURL": "http://127.0.0.1:11434",
  "apiKey": "",
  "transport": "native",         // "native" (/api/*) | "openai" (/v1/*)
  "headers": {},
  "discovery": {
    "enabled": true,
    "intervalMs": 60000,
    "timeoutMs": 5000,
    "includeEmbeddings": false
  },
  "timeout": { "headers": 300000, "chunk": 900000, "total": 0 },
  "retries": 1
}
```

- `native` uses `/api/tags`, `/api/show`, `/api/chat`, `/api/generate`, etc.
- `openai` uses the OpenAI-compatible endpoint (`/v1/chat/completions`).
- `timeout.total: 0` disables the total limit; `chunk` controls the time between chunks.

## Models

```jsonc
"model": {
  "default": "qwen2.5-coder:7b",
  "variant": "precise",
  "aliases": { "code": "qwen2.5-coder:7b" },
  "catalog": {
    "qwen2.5-coder:7b": {
      "name": "Qwen 2.5 Coder 7B",
      "context": 32768,
      "output": 8192,
      "tools": true,
      "vision": false,
      "reasoning": false,
      "embedding": false,
      "disabled": false,
      "systemPrompt": "You are a code expert.",
      "options": { "num_ctx": 32768 },
      "request": { "think": false }
    }
  }
}
```

Selectors: `model`, `alias`, `model#variant`, `ollama/model`.
The catalog can be declared with the alias or the real model name.

## System prompt

```jsonc
"system": {
  "mode": "replace",             // "replace" | "prepend" | "append"
  "prompt": "You are LOCALCODE. Project: {{PROJECT}}.",
  "files": ["./AGENTS.md", "~/.config/localcode/prompt.md"],
  "variables": { "PROJECT": "localcode" },
  "includeDefault": true,
  "includeEnvironment": true,
  "includeToolDescriptions": true,
  "includeSkills": true,
  "includeCommands": false,
  "sections": { "rules": "Never explain the obvious." },
  "separator": "\n\n"
}
```

- `replace`: only the user prompt (or the agent/model prompt if there is none).
- `prepend`: user prompt, then agent prompt.
- `append`: agent prompt, then user prompt.

For an explanation of **which place to use depending on scope** (global, agent, model, CLI), see [`SYSTEM-PROMPT.md`](./SYSTEM-PROMPT.md).

Template variables available (both forms, lowercase and uppercase):
`{{cwd}}`/`{{CWD}}`, `{{directory}}`, `{{model}}`/`{{MODEL}}`, `{{agent}}`/`{{AGENT}}`,
`{{agentDescription}}`, `{{date}}`, `{{datetime}}`, `{{os}}`, `{{shell}}`, `{{profile}}`.
Also `{{env.NAME}}` and `{env:NAME}`. Variables defined in
`system.variables` take priority over the above.

## Ollama parameters (all)

```jsonc
"ollama": {
  "options": {
    "mirostat": 0,               // 0 off, 1 Mirostat, 2 Mirostat 2.0
    "mirostat_eta": 0.1,
    "mirostat_tau": 5.0,
    "num_ctx": 4096,
    "repeat_last_n": 64,
    "repeat_penalty": 1.1,
    "temperature": 0.8,
    "seed": 0,
    "stop": ["FIN"],             // string or array
    "num_predict": -1,
    "draft_num_predict": 0,
    "top_k": 40,
    "top_p": 0.9,
    "min_p": 0.0,
    "typical_p": 0.5,
    "num_batch": 512,
    "num_gpu": -1,
    "main_gpu": 0,
    "low_vram": false,
    "f16_kv": true,
    "logits_all": false,
    "vocab_only": false,
    "use_mmap": true,
    "use_mlock": false,
    "num_thread": 0,
    "num_keep": 0,
    "presence_penalty": 0.0,
    "frequency_penalty": 0.0,
    "tfs_z": 1.0,
    "penalize_newline": true,
    "numa": false,
    "trunc": true,
    "num_gpu_layers": 0
  },
  "request": {
    "think": false,              // boolean | "high"|"medium"|"low" | null
    "keep_alive": "5m",          // string | number (ms)
    "format": "json",            // "json" | JSON Schema | null
    "raw": false,
    "stream": true,
    "logprobs": false,
    "top_logprobs": 0,
    "suffix": "",
    "system": ""
  },
  "perModel": {
    "qwen2.5-coder:7b": {
      "options": { "temperature": 0.2 },
      "request": { "think": false },
      "systemPrompt": "You are a senior developer."
    }
  },
  "variants": {
    "creative": {
      "options": { "temperature": 1.1, "top_p": 0.95 },
      "request": { "think": true }
    }
  }
}
```

`additionalProperties: true`: any new Ollama option is forwarded unchanged.

### Precedence order

From lowest to highest priority:

1. `ollama.options` / `ollama.request` (global)
2. `model.catalog.<model>.options` / `.request`
3. `ollama.perModel.<model>.options` / `.request`
4. `ollama.variants.<variant>.options` / `.request`
5. agent, session, or CLI overrides

Objects are deep-merged. A `null` value removes the resulting key,
which lets you disable a global value from a profile or a variant.

## Agents

```jsonc
"agent": {
  "default": "build",
  "maxSteps": 20,
  "definitions": {
    "reviewer": {
      "id": "reviewer",
      "description": "Review changes",
      "mode": "primary",
      "system": "You are a strict code reviewer.",
      "tools": ["read", "grep", "glob"],
      "steps": 8,
      "ollama": { "options": { "temperature": 0.1 } }
    }
  }
}
```

Built-in agents: `build`, `plan`, `general`, `explore`, `compaction`, `title`.

## Tools, permissions, and sessions

```jsonc
"tools": {
  "enabled": ["read", "write", "edit", "glob", "grep", "bash", "execute"],
  "disabled": [],
  "shell": "/bin/bash",
  "bash": {
    "defaultTimeout": 120000,
    "previewBytes": 2048,
    "previewLines": 40,
    "saveFullOutput": true
  },
  "read": { "maxLines": 2000, "maxBytes": 51200, "maxImageBytes": 20971520 },
  "output": { "maxLines": 2000, "maxBytes": 51200 }
},
"permissions": [
  { "action": "bash", "resource": "git push *", "effect": "ask", "message": "Push changes?" },
  { "action": "read", "resource": "/etc/*", "effect": "deny" },
  { "action": "write", "resource": "src/**", "effect": "allow" }
],
"session": {
  "dir": ".localcode/sessions",
  "autoTitle": true,
  "snapshots": { "enabled": true },
  "compaction": { "auto": true, "bufferPercent": 20 }
},
"tui": { "theme": "default", "showThinking": true, "maxMessages": 200 }
```

When bash output exceeds `previewBytes` or `previewLines` (handy for `ffuf`), the full output is written to `.localcode/output/<session>/<call>.log` and the model receives only a head/tail preview plus that path. This keeps noisy commands out of the model context. Defaults are intentionally small for local models: 2048 bytes / 40 lines. Raise them only if your context window allows it.

Set `"tui": { "showUsage": true }` to show `ctx used/window percentage · out tokens · cache tokens` in the status line. The numbers come from Ollama's `prompt_eval_count` and `eval_count`, so you can verify how much context each step actually consumed.

Mouse-wheel scrolling is enabled by default (`"tui": { "mouse": true }`). It uses SGR button reporting (1000+1006), not drag tracking. Press **F5** to copy the whole transcript to the terminal clipboard (OSC 52) and switch to selection mode (mouse reporting off, drag to copy); press F5 again to return to wheel scrolling. A plain-text copy is also saved to `.localcode/output/<session>/transcript.txt`. If your terminal ignores OSC 52, use that file or set `"mouse": false` and use PageUp/PageDown.

Permission rules are evaluated in order; **the last match wins**.
`resource` supports wildcards `*`, `**`, and `?`.

## Profiles

```jsonc
{
  "profile": "default",
  "profiles": {
    "local-fast": {
      "model": { "default": "qwen2.5-coder:3b" },
      "ollama": { "options": { "num_predict": 512, "temperature": 0.1 } }
    },
    "creative": {
      "ollama": { "options": { "temperature": 1.1, "top_p": 0.95 } }
    }
  }
}
```

Activate with `--profile creative` or `LOCALCODE_PROFILE=creative`.

## Schema

The file [`schema/localcode.schema.json`](../schema/localcode.schema.json) validates the
general structure and all Ollama options.
