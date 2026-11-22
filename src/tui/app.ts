import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Runtime } from "../runtime.ts";
import type { Message, StreamEvent } from "../types/message.ts";
import type { PermissionPrompter } from "../permission/engine.ts";
import { codes, screen, paint, wrapText, box, stripAnsi, visibleLength, sanitizeTerminalText } from "./ansi.ts";
import { resolveOllamaParams } from "../config/resolve.ts";
import { toErrorMessage } from "../util/errors.ts";

type Overlay =
  | { type: "none" }
  | { type: "commands"; filter: string; index: number }
  | { type: "models"; index: number }
  | { type: "agents"; index: number }
  | { type: "params"; scroll: number }
  | { type: "help" }
  | { type: "sessions"; index: number }
  | { type: "permission"; id: string; description: string; resolve: (value: boolean) => void }
  | { type: "question"; questions: Array<{ header: string; question: string; options: Array<{ label: string; description?: string }> }>; answers: Record<string, string>; index: number; resolve: (value: Record<string, string>) => void };

interface PendingKey {
  resolve: (value: string) => void;
}

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** OSC 52 clipboard write, supported by most modern terminal emulators. */
function clipboardSequence(text: string): string {
  return `\x1b]52;c;${Buffer.from(text, "utf8").toString("base64")}\x07`;
}

/** Compact, assertable context-window readout for the status line. */
export function formatContextUsage(usage: Record<string, unknown> | undefined, contextWindow: number): string {
  const prompt = Number(usage?.prompt_eval_count ?? 0);
  const cached = Number(usage?.prompt_eval_cached_count ?? 0);
  const generated = Number(usage?.eval_count ?? 0);
  const total = prompt + generated;
  const percent = contextWindow > 0 ? ` ${Math.round((total / contextWindow) * 100)}%` : "";
  const parts = [`ctx ${total}/${contextWindow || "?"}${percent}`, `out ${generated}`];
  if (cached > 0) parts.push(`cache ${cached}`);
  return parts.join(" · ");
}

/** Splits a terminal data chunk into individual keys without breaking escape sequences. */
function tokenizeInput(data: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < data.length) {
    const ch = data[i]!;
    if (ch === "\x1b") {
      if (data[i + 1] === "[") {
        let j = i + 2;
        while (j < data.length && !(data[j]! >= "@" && data[j]! <= "~")) j++;
        if (j < data.length) {
          tokens.push(data.slice(i, j + 1));
          i = j + 1;
          continue;
        }
      } else if (data[i + 1] === "O") {
        tokens.push(data.slice(i, i + 3));
        i += 3;
        continue;
      }
      tokens.push("\x1b");
      i++;
      continue;
    }
    if (ch === "\x7f" || (ch.charCodeAt(0) < 0x20 && ch !== "\t")) {
      tokens.push(ch);
      i++;
      continue;
    }
    let j = i;
    while (j < data.length) {
      const c = data[j]!;
      if (c === "\x1b" || c === "\x7f" || (c.charCodeAt(0) < 0x20 && c !== "\t")) break;
      j++;
    }
    tokens.push(data.slice(i, j));
    i = j;
  }
  return tokens;
}

/** Interactive terminal TUI, inspired by the OpenCode experience. */
export class TUI {
  private readonly runtime: Runtime;
  private sessionID: string;
  private input = "";
  private cursor = 0;
  private history: string[] = [];
  private historyIndex = -1;
  private overlay: Overlay = { type: "none" };
  private running = false;
  private streaming = "";
  private thinking = "";
  private status = "Ready";
  private scroll = 0;
  private dirty = true;
  private renderTimer?: NodeJS.Timeout;
  private disposed = false;
  private lastKey = "";
  private usage: Record<string, unknown> | undefined;
  private activityIndex = 0;
  private activityTimer?: NodeJS.Timeout;
  private abortController?: AbortController;
  private readonly liveToolOutput = new Map<string, string>();
  private lastFrame: string[] = [];
  private lastWidth = 0;
  private lastHeight = 0;
  private selectionMode = false;

  constructor(
    runtime: Runtime,
    sessionID?: string,
    options: { model?: string; agent?: string } = {},
  ) {
    this.runtime = runtime;
    const existing = runtime.store.list()[0];
    this.sessionID = sessionID ?? existing?.id ?? runtime.store.create({}).id;

    // An explicit CLI flag wins over a reopened session's model/agent and is
    // pinned so later config reloads do not override it.
    const session = this.session;
    session.metadata ??= {};
    if (options.model) {
      session.model = options.model;
      session.metadata.pinnedModel = true;
    }
    if (options.agent) {
      session.agent = options.agent;
      session.metadata.pinnedAgent = true;
    }
    if (options.model || options.agent) runtime.store.save(session);

    runtime.setPermissionPrompter(this.promptPermission);
    runtime.setQuestionHook(async (questions) => {
      return new Promise((resolve) => {
        this.overlay = { type: "question", questions, answers: {}, index: 0, resolve };
        this.dirty = true;
      });
    });
    runtime.onEvent((event) => this.onEvent(event as StreamEvent));
  }

  get session(): ReturnType<Runtime["store"]["require"]> {
    return this.runtime.store.require(this.sessionID);
  }

  private get mouseActive(): boolean {
    return this.runtime.config.tui.mouse && !this.selectionMode;
  }

  private syncMouse(): void {
    process.stdout.write(this.mouseActive ? screen.mouseOn : screen.mouseOff);
  }

  private transcriptText(): string {
    const lines: string[] = [];
    for (const message of this.session.messages) {
      const label = message.role === "user" ? ">" : message.role === "assistant" ? "" : "  tool";
      const content = sanitizeTerminalText(message.content ?? "").replace(/\n+$/, "");
      if (content) {
        for (const line of content.split("\n")) lines.push(label ? `${label} ${line}` : line);
      }
      for (const call of message.toolCalls ?? []) {
        lines.push(`  ⚙ ${call.name} ${JSON.stringify(call.arguments)}`);
      }
    }
    return lines.join("\n");
  }

  /** Copies the full transcript via OSC 52 and keeps a plain-text fallback file. */
  private copyTranscript(): string {
    const text = this.transcriptText();
    const sessionID = this.session.id.replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 80);
    const relative = join(".localcode", "output", sessionID, "transcript.txt");
    const absolute = join(this.runtime.directory, relative);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, text, "utf8");
    process.stdout.write(clipboardSequence(text));
    return relative;
  }

  start(): void {
    if (!process.stdin.isTTY) {
      process.stdout.write("The TUI requires an interactive terminal. Use `localcode run \"...\"` for non-interactive mode.\n");
      process.exitCode = 1;
      return;
    }
    process.stdout.write(screen.alternateOn + screen.cursorHide);
    this.syncMouse();
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", this.onKey);
    process.stdout.on("resize", () => (this.dirty = true));
    this.renderTimer = setInterval(() => {
      if (this.dirty) {
        this.dirty = false;
        this.render();
      }
    }, 33);
    this.renderTimer.unref?.();
    this.activityTimer = setInterval(() => {
      if (!this.running) return;
      this.activityIndex = (this.activityIndex + 1) % SPINNER.length;
      this.markDirty();
    }, 90);
    this.activityTimer.unref?.();
    this.markDirty();
  }

  stop(): void {
    this.disposed = true;
    this.abortController?.abort();
    process.stdin.off("data", this.onKey);
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(false);
      process.stdin.pause();
    }
    if (this.renderTimer) clearInterval(this.renderTimer);
    if (this.activityTimer) clearInterval(this.activityTimer);
    process.stdout.write(screen.mouseOff + screen.cursorShow + screen.alternateOff);
  }

  private markDirty(): void {
    this.dirty = true;
  }

  /** Aborts the in-flight provider request and any running shell process group. */
  private cancelRun(): void {
    if (!this.running) return;
    this.status = "Cancelling…";
    this.abortController?.abort();
    this.markDirty();
  }

  private onEvent(event: StreamEvent): void {
    if (event.sessionID && event.sessionID !== this.sessionID) return;
    switch (event.type) {
      case "text-delta":
        this.streaming += event.delta;
        break;
      case "thinking-delta":
        this.thinking += event.delta;
        break;
      case "tool-output":
        if (event.callID) {
          const previous = this.liveToolOutput.get(event.callID) ?? "";
          this.liveToolOutput.set(event.callID, (previous + event.chunk).slice(-8000));
        }
        break;
      case "message":
        if (event.message.role === "assistant") {
          this.streaming = "";
          this.thinking = "";
        }
        if (event.message.role === "tool" && event.message.toolCallId) {
          this.liveToolOutput.delete(event.message.toolCallId);
        }
        break;
      case "status":
        this.status = sanitizeTerminalText(event.status);
        break;
      case "config-reloaded": {
        const session = this.session;
        session.metadata ??= {};
        let changed = false;
        if (!session.metadata.pinnedModel && event.model && session.model !== event.model) {
          session.model = event.model;
          changed = true;
        }
        if (!session.metadata.pinnedAgent && event.agent && session.agent !== event.agent) {
          session.agent = event.agent;
          changed = true;
        }
        if (changed) {
          this.runtime.store.save(session);
          this.status = `Config reloaded · ${session.agent} · ${session.model}`;
        }
        break;
      }
      case "usage":
        this.usage = event.usage;
        break;
      case "tool-call":
        this.status = `⚙ ${event.call.name}`;
        break;
      case "tool-result":
        this.status = `✓ ${event.result.tool}`;
        break;
      case "permission":
        this.status = "Permission required";
        break;
      case "error":
        this.status = paint(`✗ ${sanitizeTerminalText(event.error)}`, codes.red);
        break;
      case "done":
        this.running = false;
        this.status = "Ready";
        this.scroll = 0;
        break;
    }
    this.markDirty();
  }

  private promptPermission: PermissionPrompter = (action, resource, description) => {
    return new Promise<boolean>((resolve) => {
      this.overlay = { type: "permission", id: "", description: `${action}: ${description || resource}`, resolve };
      this.markDirty();
    });
  };

  private onKey = (data: string): void => {
    for (const key of tokenizeInput(data.toString("utf8"))) {
      if (this.disposed) return;
      this.handleKey(key);
    }
  };

  private handleKey(key: string): void {
    if (this.disposed) return;

    if (this.overlay.type !== "none") {
      this.handleOverlayKey(key);
      return;
    }

    if (key === "\x03") {
      if (this.running && this.lastKey !== "\x03") {
        this.cancelRun();
      } else if (this.lastKey === "\x03") {
        this.stop();
        process.exit(0);
      } else {
        this.status = "Press Ctrl+C again to exit";
        this.markDirty();
      }
      this.lastKey = key;
      return;
    }

    if (key === "\x10") {
      this.overlay = { type: "commands", filter: "", index: 0 };
      this.markDirty();
      return;
    }
    if (key === "\x1bOQ" || key === "\x1b[12~") {
      this.overlay = { type: "models", index: 0 };
      this.markDirty();
      return;
    }
    if (key === "\x1bOR" || key === "\x1b[13~") {
      this.overlay = { type: "agents", index: 0 };
      this.markDirty();
      return;
    }
    if (key === "\x1bOS" || key === "\x1b[14~") {
      this.overlay = { type: "params", scroll: 0 };
      this.markDirty();
      return;
    }
    if (key === "\x1b[15~" || key === "\x1bO5" || key === "\x1bOT") {
      if (!this.selectionMode) {
        const path = this.copyTranscript();
        this.selectionMode = true;
        this.syncMouse();
        this.status = `Transcript copied to clipboard · ${path} · F5 for mouse wheel`;
      } else {
        this.selectionMode = false;
        this.syncMouse();
        this.status = "Scroll mode: mouse wheel · F5 copies transcript";
      }
      this.markDirty();
      return;
    }
    if (key === "\x1bOP" || key === "\x1b[11~") {
      this.overlay = { type: "help" };
      this.markDirty();
      return;
    }
    if (key === "\x0c") {
      this.scroll = 0;
      this.markDirty();
      return;
    }

    if (key === "\r") {
      const value = this.input;
      if (!value.trim() || this.running) return;
      this.input = "";
      this.cursor = 0;
      this.history.push(value);
      this.historyIndex = -1;
      void this.submit(value);
      return;
    }
    if (key === "\n") {
      this.insertText("\n");
      return;
    }
    if (key === "\x7f" || key === "\b") {
      if (this.cursor > 0) {
        this.input = this.input.slice(0, this.cursor - 1) + this.input.slice(this.cursor);
        this.cursor--;
        this.markDirty();
      }
      return;
    }
    if (key === "\x1b[3~") {
      this.input = this.input.slice(0, this.cursor) + this.input.slice(this.cursor + 1);
      this.markDirty();
      return;
    }
    if (key === "\x1b[D") {
      this.cursor = Math.max(0, this.cursor - 1);
      this.markDirty();
      return;
    }
    if (key === "\x1b[C") {
      this.cursor = Math.min(this.input.length, this.cursor + 1);
      this.markDirty();
      return;
    }
    if (key === "\x1b[H" || key === "\x01") {
      this.cursor = 0;
      this.markDirty();
      return;
    }
    if (key === "\x1b[F" || key === "\x05") {
      this.cursor = this.input.length;
      this.markDirty();
      return;
    }
    if (key === "\x1b[A") {
      if (this.historyIndex === -1) this.historyIndex = this.history.length;
      this.historyIndex = Math.max(0, this.historyIndex - 1);
      this.input = this.history[this.historyIndex] ?? "";
      this.cursor = this.input.length;
      this.markDirty();
      return;
    }
    if (key === "\x1b[B") {
      if (this.historyIndex === -1) return;
      this.historyIndex++;
      if (this.historyIndex >= this.history.length) {
        this.historyIndex = -1;
        this.input = "";
      } else {
        this.input = this.history[this.historyIndex] ?? "";
      }
      this.cursor = this.input.length;
      this.markDirty();
      return;
    }
    // `scroll` counts lines up from the bottom: 0 always shows the newest page.
    if (key === "\x1b[5~") {
      this.scroll += 10;
      this.markDirty();
      return;
    }
    if (key === "\x1b[6~") {
      this.scroll = Math.max(0, this.scroll - 10);
      this.markDirty();
      return;
    }
    // SGR mouse wheel: 64 = up (older), 65 = down (newer). Disabled in selection mode.
    const wheel = this.mouseActive ? /^\x1b\[<(\d+);/.exec(key) : null;
    if (wheel) {
      const button = Number(wheel[1]);
      if (button === 64) this.scroll += 3;
      else if (button === 65) this.scroll = Math.max(0, this.scroll - 3);
      this.markDirty();
      return;
    }
    if (key.startsWith("\x1b")) return;
    if (key < " " && key !== "\t") return;
    this.insertText(key);
  }

  private insertText(text: string): void {
    this.input = this.input.slice(0, this.cursor) + text + this.input.slice(this.cursor);
    this.cursor += text.length;
    this.markDirty();
  }

  private handleOverlayKey(key: string): void {
    const overlay = this.overlay;
    if (key === "\x1b" || key === "\x03") {
      if (key === "\x03") this.cancelRun();
      if (overlay.type === "permission") overlay.resolve(false);
      if (overlay.type === "question") overlay.resolve(overlay.answers);
      this.overlay = { type: "none" };
      this.markDirty();
      return;
    }

    if (overlay.type === "help" || overlay.type === "params") {
      if (key === "\x1b[5~" || key === "\x1b[A") {
        if (overlay.type === "params") overlay.scroll = Math.max(0, overlay.scroll - 3);
      }
      if (key === "\x1b[6~" || key === "\x1b[B" || key === " ") {
        if (overlay.type === "params") overlay.scroll += 3;
      }
      if (key === "q" || key === "\r") this.overlay = { type: "none" };
      this.markDirty();
      return;
    }

    if (overlay.type === "permission") {
      const lower = key.toLowerCase();
      if (lower === "y" || lower === "s" || key === "\r") {
        overlay.resolve(true);
        this.overlay = { type: "none" };
      } else if (lower === "n" || key === "\x7f") {
        overlay.resolve(false);
        this.overlay = { type: "none" };
      }
      this.markDirty();
      return;
    }

    if (overlay.type === "question") {
      const questions = overlay.questions;
      const current = questions[overlay.index];
      if (!current) return;
      if (key === "\x1b[C" || key === "\t") {
        overlay.index = (overlay.index + 1) % questions.length;
      } else if (key === "\x1b[D") {
        overlay.index = (overlay.index - 1 + questions.length) % questions.length;
      } else if (/^[1-9]$/.test(key)) {
        const option = current.options[Number(key) - 1];
        if (option) {
          overlay.answers[current.header] = option.label;
          overlay.index++;
          if (overlay.index >= questions.length) {
            overlay.resolve(overlay.answers);
            this.overlay = { type: "none" };
          }
        }
      }
      this.markDirty();
      return;
    }

    const items = this.overlayItems();
    if (key === "\x1b[A") {
      overlay.index = Math.max(0, overlay.index - 1);
      this.markDirty();
      return;
    }
    if (key === "\x1b[B") {
      overlay.index = Math.min(Math.max(0, items.length - 1), overlay.index + 1);
      this.markDirty();
      return;
    }
    if (key === "\x7f" && overlay.type === "commands") {
      overlay.filter = overlay.filter.slice(0, -1);
      overlay.index = 0;
      this.markDirty();
      return;
    }
    if (overlay.type === "commands" && key >= " " && key !== "\x1b" && !key.startsWith("\x1b")) {
      overlay.filter += key;
      overlay.index = 0;
      this.markDirty();
      return;
    }
    if (key === "\r") {
      const selected = items[overlay.index];
      if (selected) void this.selectOverlayItem(selected);
      return;
    }
  }

  private overlayItems(): string[] {
    const overlay = this.overlay;
    if (overlay.type === "commands") {
      return this.runtime.commands
        .list()
        .map((c) => c.id)
        .filter((id) => id.startsWith(overlay.filter));
    }
    if (overlay.type === "models") {
      return [this.runtime.config.model.default, ...this.runtime.registry.mergedModels().map((m) => m.id)]
        .filter((value, index, array) => value && array.indexOf(value) === index);
    }
    if (overlay.type === "agents") {
      return this.runtime.agents.list().map((a) => a.id);
    }
    if (overlay.type === "sessions") {
      return this.runtime.store.list().map((s) => `${s.id}  ${s.title}`);
    }
    return [];
  }

  private async selectOverlayItem(item: string): Promise<void> {
    const type = this.overlay.type;
    this.overlay = { type: "none" };
    if (type === "commands") {
      const command = this.runtime.commands.get(item);
      if (command?.template) {
        void this.submit(`/${item}`);
      } else {
        await this.runCommand(item);
      }
    } else if (type === "models") {
      this.session.model = item;
      this.session.metadata ??= {};
      this.session.metadata.pinnedModel = true;
      this.runtime.store.save(this.session);
      this.status = `Model: ${item}`;
      void this.runtime.registry.refresh();
    } else if (type === "agents") {
      this.session.agent = item;
      this.session.metadata ??= {};
      this.session.metadata.pinnedAgent = true;
      this.runtime.store.save(this.session);
      this.status = `Agent: ${item}`;
    } else if (type === "sessions") {
      this.sessionID = item.split(/\s+/)[0]!;
      this.scroll = 0;
    }
    this.markDirty();
  }

  private async submit(text: string): Promise<void> {
    if (text.startsWith("/")) {
      const [name, ...rest] = text.slice(1).split(/\s+/);
      await this.runCommand(name!, rest.join(" "));
      return;
    }
    const controller = new AbortController();
    this.abortController = controller;
    this.running = true;
    this.scroll = 0;
    this.streaming = "";
    this.thinking = "";
    this.liveToolOutput.clear();
    this.status = "Thinking…";
    this.markDirty();
    try {
      await this.runtime.runner.run(this.session, text, { signal: controller.signal });
    } catch (error) {
      this.status = controller.signal.aborted
        ? "Cancelled"
        : paint(toErrorMessage(error), codes.red);
    } finally {
      this.running = false;
      this.streaming = "";
      this.thinking = "";
      if (controller.signal.aborted) this.status = "Cancelled";
      this.abortController = undefined;
      this.markDirty();
    }
  }

  private async runCommand(name: string, args: string): Promise<void> {
    try {
      switch (name) {
        case "help":
          this.overlay = { type: "help" };
          break;
        case "models":
          this.overlay = { type: "models", index: 0 };
          break;
        case "agent":
          this.overlay = { type: "agents", index: 0 };
          break;
        case "sessions":
          this.overlay = { type: "sessions", index: 0 };
          break;
        case "new":
          this.sessionID = this.runtime.store.create({}).id;
          this.status = "New session";
          break;
        case "clear":
          this.session.messages = [];
          this.runtime.store.save(this.session);
          this.status = "History cleared";
          break;
        case "compact":
          this.status = "Compacting…";
          await this.runtime.sessions.compact(this.session);
          this.status = "Context compacted";
          break;
        case "reload":
          await this.runtime.reload();
          this.status = "Configuration reloaded";
          break;
        case "skills":
          this.status = `Skills: ${this.runtime.skills.list().map((s) => s.id).join(", ") || "none"}`;
          break;
        case "mcp":
          this.status = `MCP: ${this.runtime.mcp.status().map((s) => `${s.name}(${s.tools})`).join(", ") || "none"}`;
          break;
        case "permissions":
          this.status = `Rules: ${this.runtime.config.permissions.length}`;
          break;
        case "params":
          this.overlay = { type: "params", scroll: 0 };
          break;
        case "config": {
          const params = resolveOllamaParams(this.runtime.config, this.session.model);
          this.status = `Profile ${this.runtime.config.profile} · ${JSON.stringify(params).slice(0, 100)}`;
          break;
        }
        case "export": {
          const { writeFileSync } = await import("node:fs");
          const path = `session-${this.sessionID}.md`;
          writeFileSync(path, this.session.messages.map((m) => `## ${m.role}\n\n${m.content}`).join("\n\n"));
          this.status = `Exported to ${path}`;
          break;
        }
        case "undo": {
          const restored = this.runtime.store.undo(this.sessionID);
          this.status = restored ? `Restored ${restored}` : "No snapshots";
          break;
        }
        case "quit":
          this.stop();
          process.exit(0);
          break;
        default: {
          const command = this.runtime.commands.get(name);
          if (command?.template) {
            const expanded = this.runtime.commands.expand(name, args, {
              config: this.runtime.config,
              agent: this.runtime.agents.get(this.session.agent),
              directory: this.runtime.directory,
              model: this.session.model,
              tools: this.runtime.tools.enabled(this.runtime.config),
              skills: this.runtime.skills.list(),
            });
            void this.submit(expanded);
          } else {
            this.status = `Unknown command: ${name}`;
          }
        }
      }
    } catch (error) {
      this.status = paint(toErrorMessage(error), codes.red);
    }
    this.markDirty();
  }

  private render(): void {
    const width = process.stdout.columns || 100;
    const height = process.stdout.rows || 30;
    if (width !== this.lastWidth || height !== this.lastHeight) {
      this.lastFrame = [];
      this.lastWidth = width;
      this.lastHeight = height;
    }
    const messagesHeight = Math.max(3, height - 5);
    const lines = this.renderMessages(messagesHeight, width);

    const out: string[] = [];
    const title = ` LocalCode ${"v0.1.0"} `;
    const model = this.session.model || this.runtime.config.model.default || "no model";
    const info = ` ${this.session.agent} · ${model} · ${this.runtime.config.profile} `;
    out.push(paint(title.padEnd(Math.max(0, width - visibleLength(info))), codes.bgBlue + codes.bold) + paint(info, codes.bgGray));
    out.push(...lines);
    for (let i = lines.length; i < messagesHeight; i++) out.push("");
    out.push(`${codes.gray}${"─".repeat(width)}${codes.reset}`);
    const usage = this.runtime.config.tui.showUsage && this.usage
      ? paint(formatContextUsage(this.usage, Number(this.usage.contextWindow ?? 0)), codes.dim)
      : "";
    const statusWidth = Math.max(0, width - 2 - visibleLength(usage));
    const frame = this.running ? `${SPINNER[this.activityIndex]} ` : "";
    const statusText = `${frame}${stripAnsi(this.status)}`;
    out.push(` ${statusText.slice(0, statusWidth).padEnd(statusWidth)} ${usage}`);
    out.push(`${paint("› ", codes.cyan)}${this.input}${this.running ? paint(" ▌", codes.yellow) : ""}`);
    const mouseHint = this.mouseActive
      ? " · F5 copy/select · wheel scroll"
      : " · F5 wheel · drag to select";
    out.push(paint(` ⏎ send · ⇧⏎ newline · Ctrl+P commands · F1 help · F2 models · F3 agents · F4 params · Ctrl+C cancel${mouseHint}`, codes.dim));

    if (this.overlay.type !== "none") {
      const overlayLines = this.renderOverlay(width, Math.max(8, height - 6));
      const maxStart = Math.max(1, out.length - overlayLines.length);
      const start = Math.min(maxStart, Math.max(1, Math.floor((height - overlayLines.length) / 2)));
      overlayLines.forEach((line, index) => {
        out[start + index] = `  ${line}`;
      });
    }

    // Repaint only lines that changed. The spinner then touches a single row
    // instead of the whole screen, which removes the flicker.
    let diff = "";
    const count = Math.max(out.length, this.lastFrame.length);
    for (let i = 0; i < count; i++) {
      if (out[i] === this.lastFrame[i]) continue;
      diff += screen.goto(i + 1, 1) + screen.eraseLine + (out[i] ?? "");
    }
    this.lastFrame = out.slice();
    if (diff) process.stdout.write(diff);

    if (this.overlay.type === "none") {
      process.stdout.write(screen.goto(height - 1, Math.min(width, 2 + this.cursor)) + screen.cursorShow);
    } else {
      process.stdout.write(screen.cursorHide);
    }
  }

  private renderMessages(maxLines: number, width: number): string[] {
    const messages = this.session.messages;
    const rendered: string[] = [];
    for (const message of messages) {
      const prefix = this.rolePrefix(message);
      const content = sanitizeTerminalText(message.content ?? "");
      if (content) {
        for (const line of wrapText(content, Math.max(10, width - 10))) {
          rendered.push(`${prefix} ${line}`);
        }
      } else if (!message.toolCalls?.length) {
        rendered.push(`${prefix} ${paint("(empty)", codes.dim)}`);
      }
      if (message.toolCalls?.length) {
        for (const call of message.toolCalls) {
          rendered.push(paint(`   ⚙ ${call.name} ${JSON.stringify(call.arguments).slice(0, width - 20)}`, codes.gray));
          const live = this.liveToolOutput.get(call.id);
          if (live) {
            const frame = this.running ? `${SPINNER[this.activityIndex]} ` : "";
            for (const line of wrapText(sanitizeTerminalText(live).trimEnd(), Math.max(10, width - 14))) {
              rendered.push(paint(`   ⚙ ${frame}${line}`, codes.dim));
            }
          }
        }
      }
      if (message.thinking && this.runtime.config.tui.showThinking) {
        for (const line of wrapText(`💭 ${message.thinking.slice(0, 600)}`, width - 4)) {
          rendered.push(paint(line, codes.dim));
        }
      }
    }
    if (this.streaming || this.thinking) {
      if (this.runtime.config.tui.showThinking && this.thinking) {
        for (const line of wrapText(`💭 ${this.thinking.slice(-800)}`, width - 4)) {
          rendered.push(paint(line, codes.dim));
        }
      }
      for (const line of wrapText(sanitizeTerminalText(this.streaming), width - 4)) {
        rendered.push(`${paint("● ", codes.green)}${line}`);
      }
    }
    if (!rendered.length) {
      rendered.push(paint("Type a message or /help to see the commands.", codes.dim));
    }
    const maxScroll = Math.max(0, rendered.length - maxLines);
    const from = Math.max(0, maxScroll - this.scroll);
    return rendered.slice(from, from + maxLines);
  }

  private rolePrefix(message: Message): string {
    switch (message.role) {
      case "user":
        return paint("❯ ", codes.cyan);
      case "assistant":
        return paint("● ", codes.green);
      case "tool":
        return paint("  ⚙ ", codes.gray);
      default:
        return "  ";
    }
  }

  private renderOverlay(width: number, height: number): string[] {
    const overlay = this.overlay;
    const innerWidth = Math.min(width - 6, 80);
    if (overlay.type === "commands") {
      const items = this.overlayItems();
      return box([
        paint(`Commands  /${overlay.filter}`, codes.bold),
        ...items.slice(0, height - 5).map((id, i) => {
          const command = this.runtime.commands.get(id);
          const label = `${i === overlay.index ? "▸" : " "} /${id.padEnd(14)} ${command?.description ?? ""}`;
          return i === overlay.index ? paint(label, codes.cyan) : label;
        }),
      ], innerWidth, "Search");
    }
    if (overlay.type === "models") {
      const items = this.overlayItems();
      return box([
        paint("Detected local models", codes.bold),
        ...items.slice(0, height - 5).map((id, i) => {
          const model = this.runtime.registry.getModel(id);
          const label = `${i === overlay.index ? "▸" : " "} ${id.padEnd(32)} ctx:${model?.context ?? "?"}`;
          return i === overlay.index ? paint(label, codes.cyan) : label;
        }),
      ], innerWidth, "F2 / /models");
    }
    if (overlay.type === "agents") {
      const items = this.overlayItems();
      return box(
        [
          paint("Agents", codes.bold),
          ...items.slice(0, height - 5).map((id, i) => {
            const agent = this.runtime.agents.get(id);
            const label = `${i === overlay.index ? "▸" : " "} ${id.padEnd(14)} ${agent.description ?? ""}`;
            return i === overlay.index ? paint(label, codes.cyan) : label;
          }),
        ],
        innerWidth,
        "F3",
      );
    }
    if (overlay.type === "sessions") {
      const items = this.overlayItems();
      return box(
        [
          paint("Sessions", codes.bold),
          ...items.slice(0, height - 5).map((item, i) => {
            const label = `${i === overlay.index ? "▸" : " "} ${item}`;
            return i === overlay.index ? paint(label, codes.cyan) : label;
          }),
        ],
        innerWidth,
        "Sessions",
      );
    }
    if (overlay.type === "params") {
      const all = JSON.stringify(
        resolveOllamaParams(this.runtime.config, this.session.model),
        null,
        2,
      ).split("\n");
      const view = Math.max(1, height - 3);
      const maxScroll = Math.max(0, all.length - view);
      overlay.scroll = Math.min(Math.max(0, overlay.scroll), maxScroll);
      const from = overlay.scroll;
      const lines = all.slice(from, from + view);
      const title = `Effective parameters · ${this.session.model}`;
      const position = ` [${from + 1}-${Math.min(all.length, from + view)}/${all.length}]`;
      return box([paint(title + position, codes.bold), ...lines], innerWidth, "F4 Ollama");
    }
    if (overlay.type === "help") {
      return box([
        paint("Keyboard shortcuts", codes.bold),
        "⏎             Send message",
        "⇧⏎            Insert new line",
        "Ctrl+P         Command palette",
        "Ctrl+C         Cancel / exit (press twice)",
        "↑ / ↓          Message history",
        "PgUp/PgDn     Scroll conversation",
        "Mouse wheel   Scroll (F5 copies transcript / selection mode)",
        "F1             This help",
        "F2             Select local model",
        "F3             Select agent",
        "F4             View Ollama parameters",
        "Esc            Close panel",
        "",
        "Commands: /models /agent /new /clear /compact",
        "          /config /reload /skills /mcp /params /export /undo",
      ], innerWidth, "Help");
    }
    if (overlay.type === "permission") {
      return box([
        paint(sanitizeTerminalText(overlay.description), codes.yellow),
        "",
        "Allow this action?  [y] Yes   [n] No   [Ctrl+C] Cancel",
      ], innerWidth, "Permission required");
    }
    if (overlay.type === "question") {
      const question = overlay.questions[overlay.index];
      return box([
        paint(`${overlay.index + 1}/${overlay.questions.length} · ${sanitizeTerminalText(question?.header ?? "")}`, codes.bold),
        sanitizeTerminalText(question?.question ?? ""),
        "",
        ...(question?.options.map((option, i) =>
          `${i + 1}. ${sanitizeTerminalText(option.label)}${option.description ? ` — ${sanitizeTerminalText(option.description)}` : ""}`,
        ) ?? []),
        "",
        "Choose an option with 1-9 · Esc to cancel",
      ], innerWidth, "Question");
    }
    return [""];
  }
}
