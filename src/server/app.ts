import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";

import type { Runtime } from "../runtime.ts";
import type { Message, StreamEvent } from "../types/message.ts";
import { toErrorMessage } from "../util/errors.ts";
import { logger } from "../util/logger.ts";
import { openApiDocument } from "./openapi.ts";

interface PendingPermission {
  resolve: (approved: boolean) => void;
  action: string;
  resource: string;
  description: string;
  sessionID?: string;
}

export interface ServerHandle {
  close(): Promise<void>;
  port: number;
}

/** HTTP server with REST API, SSE, and an OpenAPI document. */
export function createApiServer(runtime: Runtime): ServerHandle {
  const log = logger.child("server");
  const controllers = new Map<string, AbortController>();
  const permissions = new Map<string, PendingPermission>();

  runtime.setPermissionPrompter((action, resource, description) => {
    return new Promise<boolean>((resolve) => {
      const id = randomUUID();
      permissions.set(id, { resolve, action, resource, description });
      runtime.emit({
        type: "permission",
        request: { id, action, resource, description },
      });
    });
  });

  const sendJson = (res: ServerResponse, status: number, body: unknown) => {
    const text = JSON.stringify(body);
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": Buffer.byteLength(text),
    });
    res.end(text);
  };

  const readBody = async (req: IncomingMessage): Promise<Record<string, unknown>> => {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      const buffer = chunk as Buffer;
      size += buffer.length;
      if (size > 10 * 1024 * 1024) throw new Error("Request body too large");
      chunks.push(buffer);
    }
    if (!chunks.length) return {};
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
  };

  const route = (path: string): string => {
    const base = runtime.config.server.basePath ?? "/api";
    return path.startsWith("/openapi") || path === "/" ? path : `${base}${path}`;
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const path = url.pathname;

    if (runtime.config.server.cors) {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "GET,POST,PATCH,DELETE,OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    }
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    if (runtime.config.server.authToken) {
      const token = req.headers.authorization?.replace(/^Bearer\s+/i, "");
      if (token !== runtime.config.server.authToken) {
        sendJson(res, 401, { error: "Unauthorized" });
        return;
      }
    }

    try {
      await handleRequest(req, res, path, url);
    } catch (error) {
      const message = toErrorMessage(error);
      log.error(`${req.method} ${path}: ${message}`);
      if (!res.headersSent) sendJson(res, 500, { error: message });
      else res.end();
    }
  });

  async function handleRequest(req: IncomingMessage, res: ServerResponse, path: string, url: URL): Promise<void> {
    const method = req.method ?? "GET";

    if (path === "/" && method === "GET") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`<!doctype html><title>LocalCode</title><h1>LocalCode ${"0.1.0"}</h1><p>Local-first coding agent powered by Ollama.</p><ul><li><a href="/openapi.json">OpenAPI</a></li><li><a href="${route("/info")}">Info</a></li><li><a href="${route("/sessions")}">Sessions</a></li></ul>`);
      return;
    }

    if (path === "/openapi.json" && method === "GET") {
      sendJson(res, 200, openApiDocument);
      return;
    }

    if (path === route("/info") && method === "GET") {
      sendJson(res, 200, {
        name: "localcode",
        version: "0.1.0",
        directory: runtime.directory,
        profile: runtime.config.profile,
        provider: runtime.config.provider.type,
        baseURL: runtime.config.provider.baseURL,
        model: runtime.config.model.default,
        models: runtime.registry.mergedModels().length,
        agents: runtime.agents.list().map((a) => a.id),
        tools: runtime.tools.enabled(runtime.config).map((t) => t.id),
        serverVersion: await runtime.provider.version(),
      });
      return;
    }

    if ((path === route("/health") || path === "/health") && method === "GET") {
      sendJson(res, 200, { ok: await runtime.provider.health() });
      return;
    }

    if (path === route("/config") && method === "GET") {
      sendJson(res, 200, { config: runtime.config, sources: runtime.loaded.sources });
      return;
    }

    if (path === route("/config") && method === "PATCH") {
      const body = await readBody(req);
      Object.assign(runtime.config, body.config ?? body);
      sendJson(res, 200, { config: runtime.config });
      return;
    }

    if (path === route("/config/reload") && method === "POST") {
      await runtime.reload();
      sendJson(res, 200, { ok: true, sources: runtime.loaded.sources });
      return;
    }

    if (path === route("/providers") && method === "GET") {
      sendJson(res, 200, [runtime.config.provider]);
      return;
    }

    if (path === route("/models") && method === "GET") {
      sendJson(res, 200, runtime.registry.mergedModels());
      return;
    }

    if (path === route("/models/refresh") && method === "POST") {
      await runtime.registry.refresh();
      sendJson(res, 200, runtime.registry.mergedModels());
      return;
    }

    if (path === route("/agents") && method === "GET") {
      sendJson(res, 200, runtime.agents.list());
      return;
    }

    if (path === route("/skills") && method === "GET") {
      sendJson(res, 200, runtime.skills.list());
      return;
    }

    if (path === route("/commands") && method === "GET") {
      sendJson(res, 200, runtime.commands.list());
      return;
    }

    if (path === route("/tools") && method === "GET") {
      sendJson(res, 200, runtime.tools.enabled(runtime.config));
      return;
    }

    if (path === route("/permissions") && method === "GET") {
      sendJson(res, 200, runtime.config.permissions);
      return;
    }

    const permissionMatch = path.match(new RegExp(`^${route("/permissions")}/([^/]+)/respond$`));
    if (permissionMatch && method === "POST") {
      const body = await readBody(req);
      const pending = permissions.get(permissionMatch[1]!);
      if (!pending) {
        sendJson(res, 404, { error: "Permission request not found" });
        return;
      }
      permissions.delete(permissionMatch[1]!);
      pending.resolve(Boolean(body.approved));
      sendJson(res, 200, { ok: true });
      return;
    }

    if (path === route("/mcp") && method === "GET") {
      sendJson(res, 200, runtime.mcp.status());
      return;
    }

    if (path === route("/plugins") && method === "GET") {
      sendJson(res, 200, runtime.plugins.list());
      return;
    }

    if (path === route("/sessions") && method === "GET") {
      sendJson(res, 200, runtime.store.list());
      return;
    }

    if (path === route("/sessions") && method === "POST") {
      const body = await readBody(req);
      const session = runtime.store.create({
        agent: typeof body.agent === "string" ? body.agent : undefined,
        model: typeof body.model === "string" ? body.model : undefined,
        title: typeof body.title === "string" ? body.title : undefined,
      });
      sendJson(res, 201, session);
      return;
    }

    const sessionMatch = path.match(new RegExp(`^${route("/sessions")}/([^/]+)$`));
    if (sessionMatch) {
      const id = sessionMatch[1]!;
      const session = runtime.store.get(id);
      if (!session) {
        sendJson(res, 404, { error: "Session not found" });
        return;
      }
      if (method === "GET") {
        sendJson(res, 200, session);
        return;
      }
      if (method === "PATCH") {
        const body = await readBody(req);
        if (typeof body.title === "string") session.title = body.title;
        if (typeof body.agent === "string") session.agent = body.agent;
        if (typeof body.model === "string") session.model = body.model;
        runtime.store.save(session);
        sendJson(res, 200, session);
        return;
      }
      if (method === "DELETE") {
        runtime.store.delete(id);
        sendJson(res, 200, { ok: true });
        return;
      }
    }

    const messagesMatch = path.match(new RegExp(`^${route("/sessions")}/([^/]+)/messages$`));
    if (messagesMatch && method === "GET") {
      const session = runtime.store.get(messagesMatch[1]!);
      if (!session) {
        sendJson(res, 404, { error: "Session not found" });
        return;
      }
      sendJson(res, 200, session.messages);
      return;
    }

    const promptMatch = path.match(new RegExp(`^${route("/sessions")}/([^/]+)/prompt$`));
    if (promptMatch && method === "POST") {
      const session = runtime.store.require(promptMatch[1]!);
      const body = await readBody(req);
      const prompt = String(body.prompt ?? body.message ?? "");
      if (!prompt) {
        sendJson(res, 400, { error: "Missing `prompt`" });
        return;
      }
      const abort = new AbortController();
      controllers.set(session.id, abort);
      const wantStream = url.searchParams.get("stream") !== "false";
      if (wantStream) {
        res.writeHead(200, {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache, no-transform",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
        });
        const off = runtime.onEvent((event) => {
          const typed = event as StreamEvent;
          if (typed.sessionID && typed.sessionID !== session.id) return;
          res.write(`data: ${JSON.stringify(event)}\n\n`);
        });
        try {
          await runtime.runner.run(session, prompt, {
            agent: typeof body.agent === "string" ? body.agent : undefined,
            model: typeof body.model === "string" ? body.model : undefined,
            systemPrompt: typeof body.systemPrompt === "string" ? body.systemPrompt : undefined,
            signal: abort.signal,
          });
        } catch (error) {
          res.write(`data: ${JSON.stringify({ type: "error", error: toErrorMessage(error) })}\n\n`);
        } finally {
          off();
          controllers.delete(session.id);
          res.end();
        }
      } else {
        const updated = await runtime.runner.run(session, prompt, { signal: abort.signal });
        controllers.delete(session.id);
        sendJson(res, 200, updated);
      }
      return;
    }

    const abortMatch = path.match(new RegExp(`^${route("/sessions")}/([^/]+)/abort$`));
    if (abortMatch && method === "POST") {
      controllers.get(abortMatch[1]!)?.abort();
      sendJson(res, 200, { ok: true });
      return;
    }

    const compactMatch = path.match(new RegExp(`^${route("/sessions")}/([^/]+)/compact$`));
    if (compactMatch && method === "POST") {
      const session = runtime.store.require(compactMatch[1]!);
      await runtime.sessions.compact(session);
      sendJson(res, 200, session);
      return;
    }

    const exportMatch = path.match(new RegExp(`^${route("/sessions")}/([^/]+)/export$`));
    if (exportMatch && method === "GET") {
      const session = runtime.store.require(exportMatch[1]!);
      const format = url.searchParams.get("format") ?? "markdown";
      if (format === "json") {
        sendJson(res, 200, session);
      } else {
        const markdown = [`# ${session.title}`, "", ...session.messages.map((message: Message) => {
          const header = `## ${message.role}${message.toolName ? ` (${message.toolName})` : ""}`;
          return `${header}\n\n${message.content}`;
        })].join("\n\n");
        res.writeHead(200, { "Content-Type": "text/markdown; charset=utf-8" });
        res.end(markdown);
      }
      return;
    }

    sendJson(res, 404, { error: `Route not found: ${method} ${path}` });
  }

  server.listen(runtime.config.server.port, runtime.config.server.host, () => {
    log.info(`API listening at http://${runtime.config.server.host}:${runtime.config.server.port}${route("")}`);
  });

  return {
    get port(): number {
      const address = server.address();
      return typeof address === "object" && address ? address.port : runtime.config.server.port;
    },
    close: async () => {
      for (const controller of controllers.values()) controller.abort();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
