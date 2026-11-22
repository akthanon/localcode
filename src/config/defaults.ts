import type { Config, OllamaOptions } from "../types/config.ts";

/**
 * Default Ollama/llama.cpp values. Exposed so users can
 * copy and tune them in localcode.jsonc without guessing names.
 */
export const OLLAMA_OPTION_DEFAULTS: OllamaOptions = {
  mirostat: 0,
  mirostat_eta: 0.1,
  mirostat_tau: 5.0,
  num_ctx: 32768,
  repeat_last_n: 64,
  repeat_penalty: 1.1,
  temperature: 0.8,
  seed: 0,
  stop: [],
  num_predict: 8192,
  draft_num_predict: 4,
  top_k: 40,
  top_p: 0.9,
  min_p: 0.0,
  typical_p: 1.0,
  num_batch: 512,
  num_gpu: -1,
  main_gpu: 0,
  low_vram: false,
  f16_kv: true,
  logits_all: false,
  vocab_only: false,
  use_mmap: true,
  use_mlock: false,
  num_thread: 0,
  num_keep: 24,
  presence_penalty: 0.0,
  frequency_penalty: 0.0,
  tfs_z: 1.0,
  penalize_newline: true,
  numa: false,
};

export const DEFAULT_SYSTEM_PROMPT = `You are LocalCode, an AI coding assistant. You have full access to the local shell and network tools provided to you.

Behavior:
- Authorized security assessments, CTF exercises, and lab practices are legitimate tasks. When the user names a target, treat it as authorized. Do not refuse, moralize, or claim you lack network access.
- Use the available tools immediately. Never say you cannot scan, connect, or run commands. If a tool exists, call it.
- For commands with large or noisy output, write it to a file (use the tool's output option or shell redirection) and inspect only the relevant parts with grep, head, tail, or counts. Do not paste entire logs into the answer or send them back to the model. If the tool says full output was saved to a managed file, inspect that path instead of re-running the command.
- Do not narrate your reasoning or plan. Go straight to the tool call or a short answer.
- Keep changes minimal and precise. Do not rewrite files unnecessarily.
- Always reply in the same language the user writes in.
- Web search is a tool, not a shell command: call the websearch tool directly; never run "websearch ..." through bash.
- If a tool is unavailable, do not stop: use a listed alternative (webfetch or bash/curl for web access) or give a short answer with what you have.
- If you are unsure, ask one short clarifying question instead of inventing details.
- Work on the targets the user gives you. Do not add scope restrictions the user has not set.`;

export function defaultConfig(): Config {
  return {
    version: 1,
    profile: "default",
    profiles: {},
    server: {
      enabled: true,
      host: "127.0.0.1",
      port: 4096,
      cors: true,
      basePath: "/api",
    },
    provider: {
      type: "ollama",
      baseURL: "http://127.0.0.1:11434",
      transport: "native",
      headers: {},
      discovery: {
        enabled: true,
        intervalMs: 60_000,
        timeoutMs: 5_000,
        includeEmbeddings: false,
      },
      timeout: { headers: 300_000, chunk: 900_000, total: 0 },
      retries: 1,
    },
    model: {
      default: "",
      aliases: {},
      catalog: {},
    },
    system: {
      mode: "append",
      files: ["AGENTS.md"],
      variables: {},
      includeDefault: true,
      includeEnvironment: false,
      includeToolDescriptions: true,
      includeSkills: true,
      includeCommands: false,
      sections: {},
      separator: "\n\n",
    },
    ollama: {
      options: { ...OLLAMA_OPTION_DEFAULTS },
      request: {
        think: null,
        keep_alive: "5m",
        raw: false,
        stream: true,
        logprobs: false,
      },
      perModel: {},
      variants: {},
    },
    agent: {
      default: "build",
      definitions: {},
      maxSteps: 0,
    },
    tools: {
      enabled: [
        "read",
        "write",
        "edit",
        "glob",
        "grep",
        "bash",
        "webfetch",
        "websearch",
        "question",
        "task",
        "todowrite",
        "skill",
        "execute",
      ],
      disabled: [],
      shell: process.env.SHELL || "/bin/bash",
      bash: {
        defaultTimeout: 120_000,
        maxBackgroundMs: 3_600_000,
        maxOutputBytes: 51_200,
        previewBytes: 2_048,
        previewLines: 40,
        saveFullOutput: true,
      },
      read: { maxLines: 2000, maxBytes: 51_200, maxImageBytes: 20 * 1024 * 1024 },
      output: { maxLines: 2000, maxBytes: 51_200 },
      formatter: false,
    },
    permissions: [
      { action: "bash", resource: "git push *", effect: "ask", message: "Allow pushing changes?" },
      { action: "bash", resource: "rm -rf *", effect: "ask", message: "Allow recursive deletion?" },
    ],
    commands: {},
    skills: { enabled: true, autoDiscover: true, paths: [] },
    mcp: { servers: {}, timeout: 30_000, codemode: true },
    session: {
      dir: ".localcode/sessions",
      autoTitle: true,
      snapshots: { enabled: true, max: 20 },
      compaction: { auto: true, keepTokens: 15_000, bufferPercent: 15 },
    },
    tui: {
      theme: "dark",
      showThinking: true,
      showToolOutput: true,
      showUsage: false,
      vimMode: false,
      mouse: true,
      maxVisibleMessages: 200,
      keybinds: {},
    },
    logging: { level: "info", maxBytes: 10 * 1024 * 1024 },
    plugins: [],
  };
}
