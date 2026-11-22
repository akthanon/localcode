import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

import type { Message, Session, SessionSummary } from "../types/message.ts";
import type { Config } from "../types/config.ts";
import { resolvePath } from "../util/path.ts";

/** Session and snapshot persistence on disk. */
export class SessionStore {
  readonly dir: string;
  readonly snapshotDir: string;
  private readonly config: Config;
  private readonly directory: string;
  /** Same instance per session: consumers can mutate and save safely. */
  private readonly cache = new Map<string, Session>();

  constructor(config: Config, directory: string) {
    this.config = config;
    this.directory = directory;
    this.dir = resolvePath(config.session.dir, this.directory);
    this.snapshotDir = resolve(join(this.dir, "..", "snapshots"));
    mkdirSync(this.dir, { recursive: true });
    if (config.session.snapshots.enabled) mkdirSync(this.snapshotDir, { recursive: true });
  }

  private path(id: string): string {
    return join(this.dir, `${id.replace(/[^a-zA-Z0-9_-]/g, "_")}.json`);
  }

  create(init: Partial<Session> & { directory?: string }): Session {
    const now = new Date().toISOString();
    const session: Session = {
      id: init.id ?? randomUUID(),
      title: init.title ?? "New session",
      directory: init.directory ?? this.directory,
      agent: init.agent ?? this.config.agent.default,
      model: init.model ?? this.config.model.default,
      profile: init.profile ?? this.config.profile,
      messages: init.messages ?? [],
      createdAt: now,
      updatedAt: now,
      parentID: init.parentID,
      pendingTasks: init.pendingTasks ?? [],
      metadata: init.metadata ?? {},
    };
    this.save(session);
    return session;
  }

  get(id: string): Session | undefined {
    const cached = this.cache.get(id);
    if (cached) return cached;
    const path = this.path(id);
    if (!existsSync(path)) return undefined;
    try {
      const session = JSON.parse(readFileSync(path, "utf8")) as Session;
      // Older sessions may not have these fields.
      session.messages ??= [];
      session.metadata ??= {};
      session.pendingTasks ??= [];
      this.cache.set(id, session);
      return session;
    } catch {
      return undefined;
    }
  }

  require(id: string): Session {
    const session = this.get(id);
    if (!session) throw new Error(`Session not found: ${id}`);
    return session;
  }

  save(session: Session): void {
    session.updatedAt = new Date().toISOString();
    const path = this.path(session.id);
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(session, null, 2), "utf8");
    renameSync(tmp, path);
    this.cache.set(session.id, session);
  }

  list(): SessionSummary[] {
    if (!existsSync(this.dir)) return [];
    const sessions: SessionSummary[] = [];
    for (const file of readdirSync(this.dir)) {
      if (!file.endsWith(".json")) continue;
      try {
        const session = JSON.parse(readFileSync(join(this.dir, file), "utf8")) as Session;
        if (session.parentID) continue;
        sessions.push({
          id: session.id,
          title: session.title,
          directory: session.directory,
          agent: session.agent,
          model: session.model,
          createdAt: session.createdAt,
          updatedAt: session.updatedAt,
          messageCount: session.messages.length,
        });
      } catch {
        // Corrupt file: skip it
      }
    }
    return sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  delete(id: string): boolean {
    const path = this.path(id);
    if (!existsSync(path)) return false;
    unlinkSync(path);
    this.cache.delete(id);
    return true;
  }

  appendMessage(session: Session, message: Message): void {
    session.messages.push(message);
    this.save(session);
  }

  /** Saves a file's original content before editing. */
  snapshot(sessionID: string, path: string): string | undefined {
    if (!this.config.session.snapshots.enabled) return undefined;
    if (!existsSync(path)) return undefined;
    const dir = join(this.snapshotDir, sessionID);
    mkdirSync(dir, { recursive: true });
    const name = `${Date.now()}-${path.replace(/[^a-zA-Z0-9_.-]/g, "_")}.bak`;
    const full = join(dir, name);
    writeFileSync(full, readFileSync(path));
    this.pruneSnapshots(dir);
    return full;
  }

  private pruneSnapshots(dir: string): void {
    if (!existsSync(dir)) return;
    const files = readdirSync(dir).sort();
    const max = this.config.session.snapshots.max;
    for (const file of files.slice(0, Math.max(0, files.length - max))) {
      try {
        unlinkSync(join(dir, file));
      } catch {
        // ignore
      }
    }
  }

  undo(sessionID: string): string | undefined {
    const dir = join(this.snapshotDir, sessionID);
    if (!existsSync(dir)) return undefined;
    const files = readdirSync(dir).filter((f) => f.endsWith(".bak")).sort();
    const last = files.at(-1);
    if (!last) return undefined;
    const match = last.match(/^\d+-(.+)\.bak$/);
    if (!match) return undefined;
    const original = match[1]!.replace(/_/g, "/");
    const content = readFileSync(join(dir, last));
    writeFileSync(original, content);
    unlinkSync(join(dir, last));
    return original;
  }
}
