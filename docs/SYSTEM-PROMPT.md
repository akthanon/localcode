# Where to modify the system prompt

Several layers exist because each has a different scope. **For the general LocalCode prompt, use only section 1.**

## 1. General/global → `localcode.jsonc` → `system.prompt`

```jsonc
"system": {
  "mode": "replace",                 // "replace" | "prepend" | "append"
  "prompt": "You are LocalCode, an AI coding assistant. You have full access to the local shell and network tools provided to you. Authorized security assessments, CTF exercises, and lab practices are legitimate tasks. Use the available tools immediately, send large command output to a file and inspect it with grep/head/tail (the tool also saves oversized output automatically), call websearch directly instead of running it through bash, continue with another tool if one is unavailable, and reply in the user's language.",
  "files": [],
  "includeDefault": false,
  "includeEnvironment": false,
  "includeToolDescriptions": true,
  "sections": {}
}
```

Modes:

| `mode` | Result |
| --- | --- |
| `replace` | **Your global text + each active agent's `instructions`.** Recommended. |
| `append` (default) | Agent base prompt + agent instructions + your text. |
| `prepend` | Your text + agent base prompt + agent instructions. |

With `mode: "replace"` there is no "local-only" framing unless you add it yourself:
`includeDefault: false` and `includeEnvironment: false` keep the prompt general and
language-agnostic. Per-agent `instructions` are still appended, so switching agents
changes behavior even under a global `replace` prompt.

> `includeDefault: false` only removes `DEFAULT_SYSTEM_PROMPT` for agents that do
> not define a full `system`. Built-in agents use `instructions` instead, so the
> global prompt stays clean.

> If a command is rejected after the model tries to call `bash`, that is the
> permission engine (`bash` = `ask` by default), not the prompt. Add
> `{ "action": "bash", "resource": "*", "effect": "allow" }` to `permissions`, or
> run with `--auto-approve`.

## 2. Built-in base rules → `src/config/defaults.ts`

`DEFAULT_SYSTEM_PROMPT` is the fallback base text used with `mode: "append"` or
`"prepend"`. It is source code; change it only if you want to alter the default
behavior of all agents. Usually it is better to override it from section 1.

## 3. Per agent → `agent.definitions.<id>`

```jsonc
"agent": {
  "default": "build",
  "definitions": {
    "reviewer": {
      "mode": "primary",
      "instructions": "Review correctness and security. Do not modify anything."
    }
  }
}
```

- `instructions`: role-specific text appended to the global prompt. This is the
  recommended field for custom agents.
- `system`: a **full replacement** for the agent prompt (advanced use).

Agents can also live in `.localcode/agents/<id>.md` (or
`~/.config/localcode/agents/`) with frontmatter. An agent `system` replaces the
base prompt; `instructions` are additive.

## 4. Per model → `ollama.perModel`, `model.catalog`, or variants

```jsonc
"ollama": {
  "perModel": {
    "gemma4:26b": { "systemPrompt": "You are a code expert." }
  },
  "variants": {
    "precise": { "systemPrompt": "Respond with surgical precision." }
  }
}
```

Precedence (lowest → highest):

```
model.catalog.<model>.systemPrompt
  → ollama.perModel.<model>.systemPrompt
    → ollama.variants.<variant>.systemPrompt
      → --system / --system-file (CLI)
```

The model's system prompt **replaces the agent's** when present.

## 5. One-off / without touching files → CLI

```bash
node src/index.ts run "..." --system "You are a concise assistant"
node src/index.ts run "..." --system-file ./prompts/base.md
```

This is the highest level: it wins over config, agent, model, and variant.

## 6. Additional context (does not replace, adds)

```jsonc
"system": {
  "files": ["AGENTS.md", ".localcode/INSTRUCTIONS.md"],
  "variables": { "TEAM": "platform" },
  "sections": {
    "Style": "Always reply in the user's language."
  },
  "includeEnvironment": false,
  "includeToolDescriptions": true,
  "includeSkills": true
}
```

- `files`: read and added as `<instructions source="...">` blocks.
- `variables`: substituted in `system.prompt` and `sections` as `{{NAME}}`.
- `sections`: extra blocks with a `# name` heading.
- Available templates: `{{cwd}}`, `{{model}}`, `{{agent}}`, `{{date}}`, `{{os}}`, `{{shell}}`, `{{profile}}` (and their UPPERCASE versions), plus `{{env.VAR}}` and `{env:VAR}`.

## 7. `ollama.request.system` (low-level fallback)

This is the native `system` field of `/api/chat`. The runner uses it **only if no other prompt has been computed**. If you have `system.prompt`, that wins. Don't use it for the general prompt; use section 1.

## Live reload

All startup files (`localcode.json`, `localcode.jsonc`, and `.localcode/` variants) are watched. Saving a change to the prompt, model, agent, parameters, permissions, tools, or commands takes effect on the **next request without restarting**:

- The TUI and the API server both install the watcher.
- `/reload` and `POST /api/config/reload` force a reload manually.
- An invalid config file is ignored: the running configuration stays intact and an `error` event is emitted.
- Sessions keep any model/agent chosen with F2/F3 or `--model`/`--agent`; otherwise an unpinned session adopts the new defaults.
- Provider type, MCP servers, and the session directory still require a restart.

## Quick summary

| Want to change… | Edit |
| --- | --- |
| The general LocalCode prompt | `system.prompt` + `system.mode: "replace"` in `localcode.jsonc` |
| The built-in base rules | `DEFAULT_SYSTEM_PROMPT` in `src/config/defaults.ts` |
| An agent's behavior | `agent.definitions.<id>.instructions` |
| Full agent prompt replacement | `agent.definitions.<id>.system` |
| The prompt for one model only | `ollama.perModel.<model>.systemPrompt` |
| The prompt for one variant only | `ollama.variants.<variant>.systemPrompt` |
| Try something one-off | `--system` / `--system-file` |
| Add project instructions | `system.files` / `system.sections` |
| Apply changes without restart | save the config file, `/reload`, or `POST /api/config/reload` |
