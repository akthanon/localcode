# Phase 2 — tests against real Ollama

Verified server: `http://10.0.218.5:11434`, Ollama **0.40.16**.
Model used: **`gemma4:26b`** (25.2B, Q4_K_M, `completion`, `vision`,
`tools`, `thinking` capabilities, context 262144).

## Test configuration

`test/phase2.local.jsonc` reduces `num_ctx` to 4096 and `num_predict` to 256 so the
26B model responds in a few seconds, and sets `temperature: 0.1`, `seed: 42`,
`think: false`, and `keep_alive: "10m"`.

```bash
node src/index.ts models --config test/phase2.local.jsonc
node src/index.ts run "Respond exactly: LOCALCODE_OK" --config test/phase2.local.jsonc
```

## Verified results

| Test | Result |
| --- | --- |
| `/api/version` | `0.40.16` |
| Discovery (`/api/tags` + `/api/show`) | 10 models; `gemma4:26b` with tools/vision/thinking and ctx 262144 |
| Streaming `/api/chat` (NDJSON) | `LOCALCODE_OK` in ~21 s (first load) |
| Real tool calling | `read(package.json)` → `tool` message with contents → final answer `localcode` / `0.1.0` |
| `think: true` | `thinking` deltas + final text (`4`) |
| `format: "json"` | `{"ok":true,"n":7}` parsed correctly |
| `keep_alive: "5m"` | model present in `/api/ps` after the request |
| `suffix` + `temperature`/`seed` | accepted without error |
| System prompt (`--system`) | exact `SYSTEM_OK` response |
| REST API + SSE + SDK | events `message, step, usage, tool-call, tool-result, text-delta, done`; session with 4 messages |

## Reproducible commands

```bash
npm test                         # phase 1 (mock, 11 tests)
npm run probe                    # direct provider probes with gemma4:26b
node src/index.ts serve --config test/phase2.local.jsonc --port 4097 --auto-approve &
npm run probe:api                # SDK client against the real server
```

## Fixes made as a result of phase 2

- Discovery now reads `capabilities`, `details.context_length`, and `thinking.default`
  from real Ollama 0.40.16 responses (it previously only looked at `show.info`, so
  `gemma4:26b` appeared with 32768 context instead of 262144).
- **Critical bug fixed: the model could not be changed from the terminal.** `SessionStore.get()`
  returned a new object read from disk on every call, so in the TUI
  `this.session.model = item` was discarded and `save(this.session)` saved the original
  object. The store now keeps one instance per session (identity cache), so F2/F3
  persist the model and agent. In addition, `--model` and `--agent` are applied to the
  reopened session when the TUI starts (they previously only affected `run`).
- `delete()` in the store now correctly returns `true` and clears the cache.
