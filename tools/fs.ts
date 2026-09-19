import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import type { AITool } from "mioku";
import type { FsPolicy } from "./perm";
import { canWrite, permissionDenied, resolveWorkspacePath } from "./perm";

const READ_DEFAULT_LIMIT = 500;
const READ_MAX_LIMIT = 2000;
const READ_MAX_BYTES = 256 * 1024;
const READ_MAX_LINE = 2000;
const LIST_MAX_RESULTS = 100;
const GREP_MAX_MATCHES = 250;

export interface FsToolDeps {
  policy: FsPolicy;
}

function toTool(tool: AITool): AITool {
  return tool;
}

function lineNumbered(lines: string[], offset: number): string {
  return lines
    .map((line, index) => {
      const truncated =
        line.length > READ_MAX_LINE
          ? `${line.slice(0, READ_MAX_LINE)}… [line truncated]`
          : line;
      return `${String(offset + index).padStart(6)}\t${truncated}`;
    })
    .join("\n");
}

export function createReadTool(deps: FsToolDeps): AITool {
  return toTool({
    name: "read",
    description:
      "Read a UTF-8 text file and return numbered lines. Supports offset/limit windowing for large files.",
    parameters: {
      type: "object",
      properties: {
        file_path: { type: "string", description: "File path (absolute, or relative to the workspace)" },
        offset: { type: "number", description: "1-based first line to return" },
        limit: { type: "number", description: "Max lines to return (default 500, max 2000)" },
      },
      required: ["file_path"],
    },
    handler: async (args) => {
      const filePath = resolveWorkspacePath(deps.policy, String(args?.file_path ?? ""));
      let stat: fs.Stats;
      try {
        stat = await fsp.stat(filePath);
      } catch {
        return { error: `File not found: ${filePath}` };
      }
      if (!stat.isFile()) return { error: `Not a regular file: ${filePath}` };
      const offset = Math.max(1, Math.floor(Number(args?.offset) || 1));
      let limit = Math.floor(Number(args?.limit) || READ_DEFAULT_LIMIT);
      limit = Math.min(Math.max(1, limit), READ_MAX_LIMIT);
      const content = await fsp.readFile(filePath, "utf-8");
      const allLines = content.split("\n");
      const selected: string[] = [];
      let bytes = 0;
      let index = offset - 1;
      while (index < allLines.length && selected.length < limit) {
        const line = `${allLines[index]}\n`;
        if (bytes + line.length > READ_MAX_BYTES) {
          selected.push("[output truncated: byte limit reached]");
          break;
        }
        selected.push(allLines[index]);
        bytes += line.length;
        index += 1;
      }
      return {
        file: filePath,
        totalLines: allLines.length,
        offset,
        content: lineNumbered(selected, offset),
        hasMore: index < allLines.length,
      };
    },
  });
}

export function createWriteTool(deps: FsToolDeps): AITool {
  return toTool({
    name: "write",
    description:
      "Create or completely overwrite a UTF-8 text file with the given content.",
    parameters: {
      type: "object",
      properties: {
        file_path: { type: "string", description: "File path" },
        content: { type: "string", description: "Full file content to write" },
      },
      required: ["file_path", "content"],
    },
    handler: async (args) => {
      const filePath = resolveWorkspacePath(deps.policy, String(args?.file_path ?? ""));
      if (!canWrite(deps.policy, filePath)) {
        return { error: permissionDenied(deps.policy, "write", filePath).message };
      }
      const content = String(args?.content ?? "");
      await fsp.mkdir(path.dirname(filePath), { recursive: true });
      await fsp.writeFile(filePath, content, "utf-8");
      return { success: true, file: filePath, bytes: Buffer.byteLength(content) };
    },
  });
}

export function createEditTool(deps: FsToolDeps): AITool {
  return toTool({
    name: "edit",
    description:
      "Replace an exact literal string in an existing UTF-8 text file. old_string must appear exactly once unless replace_all is set.",
    parameters: {
      type: "object",
      properties: {
        file_path: { type: "string", description: "File path" },
        old_string: { type: "string", description: "Exact text to replace" },
        new_string: { type: "string", description: "Replacement text" },
        replace_all: { type: "boolean", description: "Replace every occurrence" },
      },
      required: ["file_path", "old_string", "new_string"],
    },
    handler: async (args) => {
      const filePath = resolveWorkspacePath(deps.policy, String(args?.file_path ?? ""));
      if (!canWrite(deps.policy, filePath)) {
        return { error: permissionDenied(deps.policy, "edit", filePath).message };
      }
      const oldString = String(args?.old_string ?? "");
      const newString = String(args?.new_string ?? "");
      if (!oldString) return { error: "old_string must be a non-empty string" };
      let content: string;
      try {
        content = await fsp.readFile(filePath, "utf-8");
      } catch {
        return { error: `File not found: ${filePath}` };
      }
      const occurrences = content.split(oldString).length - 1;
      if (occurrences === 0) return { error: "old_string not found in file" };
      if (occurrences > 1 && !args?.replace_all) {
        return {
          error: `old_string appears ${occurrences} times. Provide more surrounding context or set replace_all=true.`,
        };
      }
      const next =
        occurrences > 1 && args?.replace_all
          ? content.split(oldString).join(newString)
          : content.replace(oldString, newString);
      await fsp.writeFile(filePath, next, "utf-8");
      return { success: true, file: filePath, replacements: occurrences > 1 && args?.replace_all ? occurrences : 1 };
    },
  });
}

function patternToRegExp(pattern: string): RegExp {
  let source = "";
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];
    if (char === "*") {
      if (pattern[i + 1] === "*") {
        source += pattern[i + 2] === "/" ? "(?:.*/)?" : ".*";
        if (pattern[i + 2] === "/") i += 2;
        else i += 1;
      } else {
        source += "[^/]*";
      }
      continue;
    }
    if (char === "?") {
      source += "[^/]";
      continue;
    }
    source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${source}$`);
}

async function walkFiles(root: string, cap: number): Promise<string[]> {
  const results: string[] = [];
  const queue = [root];
  while (queue.length > 0 && results.length < cap * 20) {
    const current = queue.shift()!;
    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === ".git") continue;
        queue.push(full);
      } else if (entry.isFile()) {
        results.push(full);
        if (results.length >= cap * 20) break;
      }
    }
  }
  return results;
}

export function createGlobTool(deps: FsToolDeps): AITool {
  return toTool({
    name: "glob",
    description:
      "Find files whose paths match a glob pattern (supports ** and *). Searches the workspace by default.",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Glob pattern, e.g. **/*.ts" },
        path: { type: "string", description: "Directory to search (default: workspace root)" },
      },
      required: ["pattern"],
    },
    handler: async (args) => {
      const pattern = String(args?.pattern ?? "");
      if (!pattern) return { error: "pattern must be a non-empty string" };
      const root = resolveWorkspacePath(deps.policy, String(args?.path ?? "") || deps.policy.workspaceRoot);
      if (!fs.existsSync(root)) return { error: `Directory not found: ${root}` };
      const regExp = patternToRegExp(pattern);
      const files = await walkFiles(root, LIST_MAX_RESULTS);
      const matched = files
        .filter((file) => {
          const rel = path.relative(root, file).split(path.sep).join("/");
          return regExp.test(rel) || regExp.test(path.basename(file));
        })
        .slice(0, LIST_MAX_RESULTS);
      return { root, count: matched.length, files: matched };
    },
  });
}

export function createGrepTool(deps: FsToolDeps): AITool {
  return toTool({
    name: "grep",
    description:
      "Search file contents with a regular expression. Returns matching lines with line numbers.",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Regular expression" },
        path: { type: "string", description: "File or directory to search (default: workspace root)" },
        include: { type: "string", description: "Glob filter for file names, e.g. *.ts" },
      },
      required: ["pattern"],
    },
    handler: async (args) => {
      const pattern = String(args?.pattern ?? "");
      if (!pattern) return { error: "pattern must be a non-empty string" };
      let regExp: RegExp;
      try {
        regExp = new RegExp(pattern);
      } catch (err) {
        return { error: `Invalid regex: ${err}` };
      }
      const target = resolveWorkspacePath(deps.policy, String(args?.path ?? "") || deps.policy.workspaceRoot);
      const include = args?.include ? patternToRegExp(String(args.include)) : null;
      const stat = fs.existsSync(target) ? fs.statSync(target) : null;
      const files = stat?.isFile() ? [target] : await walkFiles(target, GREP_MAX_MATCHES);
      const matches: Array<{ file: string; line: number; text: string }> = [];
      for (const file of files) {
        if (include && !include.test(path.basename(file))) continue;
        let content: string;
        try {
          if (fs.statSync(file).size > 2 * 1024 * 1024) continue;
          content = await fsp.readFile(file, "utf-8");
        } catch {
          continue;
        }
        const lines = content.split("\n");
        for (let i = 0; i < lines.length; i++) {
          if (regExp.test(lines[i])) {
            matches.push({
              file,
              line: i + 1,
              text: lines[i].slice(0, 500),
            });
            if (matches.length >= GREP_MAX_MATCHES) break;
          }
        }
        if (matches.length >= GREP_MAX_MATCHES) break;
      }
      return {
        pattern,
        count: matches.length,
        truncated: matches.length >= GREP_MAX_MATCHES,
        matches,
      };
    },
  });
}
