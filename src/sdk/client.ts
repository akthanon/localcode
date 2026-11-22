/** TypeScript client for the LocalCode API. */

import type { Message, Session, SessionSummary, StreamEvent } from "../types/message.ts";

export interface ClientOptions {
  baseURL?: string;
  apiKey?: string;
  fetch?: typeof fetch;
}

export class LocalCodeClient {
  readonly baseURL: string;
  private readonly doFetch: typeof fetch;
  private readonly headers: Record<string, string>;

  constructor(options: ClientOptions = {}) {
    this.baseURL = (options.baseURL ?? "http://127.0.0.1:4096").replace(/\/+$/, "");
    this.doFetch = options.fetch ?? fetch;
    this.headers = { "Content-Type": "application/json" };
    if (options.apiKey) this.headers.Authorization = `Bearer ${options.apiKey}`;
  }

  private url(path: string): string {
    return `${this.baseURL}${path.startsWith("/") ? path : `/${path}`}`;
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await this.doFetch(this.url(path), {
      ...init,
      headers: { ...this.headers, ...(init.headers as Record<string, string>) },
    });
    const text = await response.text();
    let body: unknown;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text;
    }
    if (!response.ok) {
      throw new Error(`LocalCode API ${response.status}: ${JSON.stringify(body)}`);
    }
    return body as T;
  }

  info(): Promise<Record<string, unknown>> {
    return this.request("/api/info");
  }

  health(): Promise<{ ok: boolean }> {
    return this.request("/api/health");
  }

  listModels<T = Array<Record<string, unknown>>>(): Promise<T> {
    return this.request("/api/models");
  }

  listSessions(): Promise<SessionSummary[]> {
    return this.request("/api/sessions");
  }

  createSession(options: { agent?: string; model?: string; title?: string } = {}): Promise<Session> {
    return this.request("/api/sessions", { method: "POST", body: JSON.stringify(options) });
  }

  getSession(id: string): Promise<Session> {
    return this.request(`/api/sessions/${encodeURIComponent(id)}`);
  }

  messages(id: string): Promise<Message[]> {
    return this.request(`/api/sessions/${encodeURIComponent(id)}/messages`);
  }

  async deleteSession(id: string): Promise<void> {
    await this.request(`/api/sessions/${encodeURIComponent(id)}`, { method: "DELETE" });
  }

  async *prompt(
    sessionID: string,
    prompt: string,
    options: { agent?: string; model?: string; systemPrompt?: string; signal?: AbortSignal } = {},
  ): AsyncGenerator<StreamEvent, Session, unknown> {
    const response = await this.doFetch(this.url(`/api/sessions/${encodeURIComponent(sessionID)}/prompt?stream=true`), {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify({ prompt, ...options }),
      signal: options.signal,
    });
    if (!response.ok) throw new Error(`LocalCode API ${response.status}: ${await response.text()}`);
    if (!response.body) throw new Error("Response has no body");

    let buffer = "";
    for await (const chunk of response.body) {
      buffer += new TextDecoder().decode(chunk, { stream: true });
      let idx = buffer.indexOf("\n");
      while (idx >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (line.startsWith("data:")) {
          const data = line.slice(5).trim();
          if (data) yield JSON.parse(data) as StreamEvent;
        }
        idx = buffer.indexOf("\n");
      }
    }
    return this.getSession(sessionID);
  }

  respondPermission(id: string, approved: boolean): Promise<{ ok: boolean }> {
    return this.request(`/api/permissions/${encodeURIComponent(id)}/respond`, {
      method: "POST",
      body: JSON.stringify({ approved }),
    });
  }
}
