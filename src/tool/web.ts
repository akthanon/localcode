import type { ToolDefinition } from "../types/tool.ts";
import { truncateOutput } from "../util/output.ts";

function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|h[1-6]|li|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export const webfetchTool: ToolDefinition = {
  id: "webfetch",
  description: "Fetches an HTTP(S) URL and returns its content as text/markdown.",
  parameters: {
    type: "object",
    properties: {
      url: { type: "string", description: "URL to fetch" },
      format: {
        type: "string",
        enum: ["markdown", "text", "html"],
        description: "Output format",
        default: "markdown",
      },
      timeout: { type: "integer", description: "Timeout in seconds (max 120)", default: 30 },
    },
    required: ["url"],
  },
  permission: { action: "webfetch", resource: (args) => String(args.url ?? "*") },
  async execute(_ctx, args): Promise<{ title?: string; output: string; error?: boolean }> {
    const url = String(args.url ?? "");
    if (!/^https?:\/\//i.test(url)) return { output: "Only http(s) URLs are allowed", error: true };
    try {
      const response = await fetch(url, {
        headers: { "User-Agent": "LocalCode/0.1 (+local AI agent)" },
        signal: AbortSignal.timeout(Math.min(Number(args.timeout ?? 30), 120) * 1000),
      });
      const body = await response.text();
      const text = args.format === "html" ? body : htmlToText(body);
      const result = truncateOutput(text, { maxBytes: 51_200, maxLines: 2000 });
      return { title: url, output: `HTTP ${response.status}\n\n${result.text}` };
    } catch (error) {
      return { output: `Failed to fetch ${url}: ${String(error)}`, error: true };
    }
  },
};

export const websearchTool: ToolDefinition = {
  id: "websearch",
  description:
    "Searches the web with DuckDuckGo (no credentials) and returns titles, URLs, and snippets.",
  parameters: {
    type: "object",
    properties: { query: { type: "string", description: "Search query" } },
    required: ["query"],
  },
  permission: { action: "websearch", resource: (args) => String(args.query ?? "*") },
  async execute(_ctx, args): Promise<{ title?: string; output: string; error?: boolean }> {
    const query = String(args.query ?? "");
    try {
      const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
      const response = await fetch(url, {
        headers: { "User-Agent": "Mozilla/5.0 (compatible; LocalCode/0.1)" },
        signal: AbortSignal.timeout(30_000),
      });
      const html = await response.text();
      const results = [...html.matchAll(/<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)]
        .slice(0, 10)
        .map((match, index) => {
          const title = htmlToText(match[2]!).trim();
          let link = match[1]!;
          const uddg = link.match(/uddg=([^&]+)/);
          if (uddg) link = decodeURIComponent(uddg[1]!);
          return `${index + 1}. ${title}\n   ${link}`;
        });
      return {
        title: `websearch: ${query}`,
        output: results.length ? results.join("\n") : "No results found",
      };
    } catch (error) {
      return { output: `Search failed: ${String(error)}`, error: true };
    }
  },
};

export const webTools = [webfetchTool, websearchTool];
