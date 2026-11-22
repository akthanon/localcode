#!/usr/bin/env node
import { Runtime } from "./runtime.ts";
import { TUI } from "./tui/app.ts";
import { createApiServer } from "./server/app.ts";
import { resolveOllamaParams } from "./config/resolve.ts";
import { OLLAMA_OPTION_DEFAULTS } from "./config/defaults.ts";
import { toErrorMessage } from "./util/errors.ts";
import { loadConfig } from "./config/loader.ts";
import { watchConfig } from "./config/watcher.ts";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

interface Flags {
  [key: string]: string | boolean | undefined;
  _: string[];
}

function parseArgs(argv: string[]): Flags {
  const flags: Flags = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg.startsWith("--")) {
      const [name, inline] = arg.slice(2).split("=", 2);
      if (inline !== undefined) {
        flags[name!] = inline;
      } else if (["--no-server", "--auto-approve", "--json", "--debug", "--help"].includes(`--${name}`)) {
        flags[name!] = true;
      } else {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith("--")) {
          flags[name!] = next;
          i++;
        } else {
          flags[name!] = true;
        }
      }
    } else {
      flags._.push(arg);
    }
  }
  return flags;
}

const HELP = `LocalCode v0.1.0 — local-first coding agent specialized in Ollama

Usage:
  localcode [options]                   Open the interactive TUI
  localcode run [options] "prompt"      Run a prompt without a UI
  localcode serve [options]             Start the API + SSE server
  localcode models [options]            List detected local models
  localcode config [options]            Show the effective configuration
  localcode init                        Create an example localcode.jsonc
  localcode version                     Show the version

Options:
  --dir <path>           Project directory
  --config <file>        Explicit configuration file
  --profile <name>       Configuration profile
  --model <model>        Model to use (or alias)
  --agent <agent>        Agent to use
  --base-url <url>       Ollama server URL
  --system <text>        System prompt (replaces configured one)
  --system-file <file>   Read the system prompt from a file
  --max-steps <n>        Agent step limit
  --port <n>             Server port
  --no-server            Do not start the server with the TUI
  --auto-approve         Auto-approve permission prompts
  --json                 JSON output in run mode
  --debug                Debug logging
  -h, --help             Show this help

Environment variables:
  LOCALCODE_BASE_URL, LOCALCODE_MODEL, LOCALCODE_PROFILE,
  LOCALCODE_CONFIG, LOCALCODE_CONFIG_CONTENT, LOCALCODE_PORT,
  LOCALCODE_LOG_LEVEL
`;

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const flags = parseArgs(argv);
  const command = String(flags._[0] ?? "tui");

  // Apply overrides before creating the runtime so discovery uses the right URL.
  if (flags["base-url"]) process.env.LOCALCODE_BASE_URL = String(flags["base-url"]);
  if (flags.model) process.env.LOCALCODE_MODEL = String(flags.model);
  if (flags.port) process.env.LOCALCODE_PORT = String(flags.port);

  if (command === "help" || flags.help || argv.includes("-h")) {
    process.stdout.write(HELP);
    return;
  }
  if (command === "version") {
    process.stdout.write("localcode 0.1.0\n");
    return;
  }
  if (command === "init") {
    const dir = String(flags.dir ?? process.cwd());
    const target = join(dir, "localcode.jsonc");
    if (existsSync(target)) {
      process.stdout.write(`Already exists: ${target}\n`);
      return;
    }
    const example = join(PROJECT_ROOT, "localcode.example.jsonc");
    const content = existsSync(example)
      ? readFileSync(example, "utf8")
      : JSON.stringify({ $schema: "./schema/localcode.schema.json", version: 1 }, null, 2);
    writeFileSync(target, content);
    process.stdout.write(`Created ${target}\n`);
    return;
  }

  const options = {
    directory: flags.dir ? String(flags.dir) : undefined,
    file: flags.config ? String(flags.config) : undefined,
    profile: flags.profile ? String(flags.profile) : undefined,
    autoApprove: Boolean(flags["auto-approve"]),
    minimal: command === "run" || command === "models" || command === "config",
  };

  if (command === "config") {
    const loaded = loadConfig(options);
    if (flags["system"] || flags["system-file"]) {
      process.stdout.write(`${resolveSystemText(flags)}\n`);
      return;
    }
    if (flags.all) {
      process.stdout.write(`${JSON.stringify(OLLAMA_OPTION_DEFAULTS, null, 2)}\n`);
      return;
    }
    process.stdout.write(`${JSON.stringify({ config: loaded.config, sources: loaded.sources }, null, 2)}\n`);
    return;
  }

  if (command === "models") {
    const runtime = await Runtime.create({ ...options, autoApprove: true });
    if (flags["base-url"]) runtime.config.provider.baseURL = String(flags["base-url"]);
    if (flags.model) runtime.config.model.default = String(flags.model);
    await runtime.registry.refresh();
    const models = runtime.registry.mergedModels();
    if (flags.json) {
      process.stdout.write(`${JSON.stringify(models, null, 2)}\n`);
    } else if (!models.length) {
      process.stdout.write("No models detected. Check the Ollama URL and that models are installed.\n");
    } else {
      for (const model of models) {
        const caps = [model.tools && "tools", model.vision && "vision", model.reasoning && "think"].filter(Boolean).join(",");
        process.stdout.write(`${model.id.padEnd(42)} ctx:${String(model.context).padEnd(7)} ${caps}\n`);
      }
    }
    runtime.dispose();
    return;
  }

  const runtime = await Runtime.create(options);
  const overrides: Record<string, unknown> = {};
  if (flags.model) overrides.model = { default: String(flags.model) };
  if (flags["base-url"]) overrides.provider = { baseURL: String(flags["base-url"]) };
  if (flags.debug) overrides.logging = { level: "debug" };
  runtime.setConfigOverrides(overrides);

  const systemText = resolveSystemText(flags);

  if (command === "serve") {
    const server = createApiServer(runtime);
    const configWatcher = watchConfig(runtime);
    process.stdout.write(`LocalCode API at http://${runtime.config.server.host}:${server.port}/api\n`);
    const shutdown = async () => {
      configWatcher.close();
      await server.close();
      runtime.dispose();
      process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    return;
  }

  if (command === "run") {
    const prompt = flags._.slice(1).join(" ").trim();
    if (!prompt) {
      process.stderr.write("Usage: localcode run \"prompt\"\n");
      process.exitCode = 1;
      runtime.dispose();
      return;
    }
    const session = runtime.store.create({ model: runtime.config.model.default });
    const result = await runtime.runner.run(session, prompt, {
      model: flags.model ? String(flags.model) : undefined,
      agent: flags.agent ? String(flags.agent) : undefined,
      systemPrompt: systemText,
      maxSteps: flags["max-steps"] ? Number(flags["max-steps"]) : undefined,
    });
    const final = result.messages.filter((m) => m.role === "assistant").at(-1)?.content ?? "";
    if (flags.json) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      process.stdout.write(`${final}\n`);
    }
    runtime.dispose();
    return;
  }

  // Default TUI. Config edits are picked up without restarting.
  if (!flags["no-server"]) {
    createApiServer(runtime);
  }
  const tui = new TUI(runtime, undefined, {
    model: flags.model ? String(flags.model) : undefined,
    agent: flags.agent ? String(flags.agent) : undefined,
  });
  const configWatcher = watchConfig(runtime);
  tui.start();
  const shutdown = () => {
    configWatcher.close();
    tui.stop();
    runtime.dispose();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

function resolveSystemText(flags: Flags): string | undefined {
  if (flags["system-file"]) return readFileSync(String(flags["system-file"]), "utf8");
  if (flags.system) return String(flags.system);
  return undefined;
}

main().catch((error) => {
  process.stderr.write(`Error: ${toErrorMessage(error)}\n`);
  process.exitCode = 1;
});
