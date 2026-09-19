import type { AITool } from "mioku";
import type { AgentSettingsConfig } from "../types";

interface WebToolDeps {
  settings: AgentSettingsConfig;
  onSearch?: () => void;
}

interface SearxngResult {
  title?: string;
  url?: string;
  content?: string;
}

function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article|blockquote|pre)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li[^>]*>/gi, "- ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n\s*\n+/g, "\n\n")
    .trim();
}

function extractTitle(html: string): string {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  return match ? match[1].trim().slice(0, 200) : "";
}

export function createWebSearchTool(deps: WebToolDeps): AITool {
  const { settings, onSearch } = deps;
  return {
    name: "web_search",
    description:
      "Search the web via SearXNG and return a list of results (title, url, snippet).",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query" },
        limit: { type: "number", description: `Max results (default ${settings.webSearch.defaultLimit})` },
      },
      required: ["query"],
    },
    handler: async (args) => {
      const query = String(args?.query ?? "").trim();
      if (!query) return { error: "query must be a non-empty string" };
      if (!settings.webSearch.enabled) {
        return { error: "web search is disabled in agent settings" };
      }
      onSearch?.();
      const limit = Math.min(
        Math.max(1, Math.floor(Number(args?.limit) || settings.webSearch.defaultLimit)),
        settings.webSearch.maxLimit,
      );
      const url = new URL(settings.webSearch.baseUrl);
      url.searchParams.set("q", query);
      url.searchParams.set("format", "json");
      const response = await fetch(url, {
        signal: AbortSignal.timeout(settings.webSearch.timeoutMs),
        headers: { Accept: "application/json" },
      });
      if (!response.ok) {
        return { error: `Search request failed: HTTP ${response.status}` };
      }
      const data = (await response.json()) as { results?: SearxngResult[] };
      const results = (data.results ?? []).slice(0, limit).map((item) => ({
        title: item.title ?? "",
        url: item.url ?? "",
        snippet: item.content ?? "",
      }));
      return { query, count: results.length, results };
    },
  };
}

export function createWebFetchTool(deps: WebToolDeps): AITool {
  const { settings } = deps;
  return {
    name: "web_fetch",
    description:
      "Fetch a web page URL and return the extracted main text content (HTML converted to plain text).",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "HTTP(S) URL to fetch" },
      },
      required: ["url"],
    },
    handler: async (args) => {
      const target = String(args?.url ?? "").trim();
      if (!/^https?:\/\//i.test(target)) {
        return { error: "url must start with http:// or https://" };
      }
      if (!settings.webFetch.enabled) {
        return { error: "web fetch is disabled in agent settings" };
      }
      const response = await fetch(target, {
        signal: AbortSignal.timeout(settings.webFetch.timeoutMs),
        headers: {
          "User-Agent":
            "Mozilla/5.0 (compatible; mioku-agent/0.1; +https://github.com/mioku-lab)",
          Accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5",
        },
        redirect: "follow",
      });
      if (!response.ok) {
        return { error: `Fetch failed: HTTP ${response.status}` };
      }
      const contentType = response.headers.get("content-type") ?? "";
      const raw = await response.text();
      if (contentType.includes("text/plain")) {
        return { url: target, contentType, content: raw.slice(0, settings.webFetch.maxChars) };
      }
      return {
        url: target,
        contentType,
        title: extractTitle(raw),
        content: htmlToText(raw).slice(0, settings.webFetch.maxChars),
      };
    },
  };
}
