import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import type { Bot } from "mioku";
import type { MediaAttachment, MediaKind } from "./media";

const MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 60_000;

export interface DownloadedMedia {
  kind: MediaKind;
  messageId: string;
  name: string;
  size: number;
  path: string;
  remoteUrl?: string;
}

export interface DownloadResult {
  dir: string;
  files: DownloadedMedia[];
  errors: string[];
}

function dateStamp(now = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function sanitizeName(value: string): string {
  const base = path
    .basename(value)
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
    .trim();
  return base && base !== "." && base !== ".." ? base.slice(0, 120) : "";
}

function nameFromUrl(source: string): string {
  try {
    const url = new URL(source);
    return sanitizeName(decodeURIComponent(path.basename(url.pathname)));
  } catch {
    return "";
  }
}

function extensionFromContentType(contentType: string | null): string {
  const type = String(contentType ?? "")
    .split(";")[0]
    .trim()
    .toLowerCase();
  const map: Record<string, string> = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/gif": ".gif",
    "image/webp": ".webp",
    "video/mp4": ".mp4",
    "audio/mpeg": ".mp3",
    "audio/wav": ".wav",
    "application/pdf": ".pdf",
    "application/zip": ".zip",
    "text/plain": ".txt",
    "application/json": ".json",
  };
  return map[type] ?? "";
}

async function uniquePath(dir: string, name: string): Promise<string> {
  const ext = path.extname(name);
  const stem = ext ? name.slice(0, -ext.length) : name;
  let candidate = path.join(dir, name);
  let index = 1;
  while (fs.existsSync(candidate)) {
    candidate = path.join(dir, `${stem}-${index}${ext}`);
    index += 1;
  }
  return candidate;
}

function bareFileName(value: string | undefined): string {
  if (!value) return "";
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (/^(?:https?|base64|data|file):/i.test(trimmed)) return "";
  if (/[\\/]/.test(trimmed)) return "";
  return trimmed;
}

function chooseFileName(
  item: MediaAttachment,
  fallbackName: string,
  contentType: string | null,
  index: number,
): string {
  const candidates = [
    sanitizeName(item.name ?? ""),
    sanitizeName(bareFileName(item.file)),
    sanitizeName(bareFileName(item.path)),
    sanitizeName(item.path ? path.basename(item.path) : ""),
    sanitizeName(fallbackName),
  ].filter(Boolean);

  const withExtension = candidates.find((name) => path.extname(name));
  const base =
    withExtension ??
    candidates[0] ??
    `${item.kind}_${item.messageId || "msg"}_${index + 1}`;
  return path.extname(base)
    ? base
    : `${base}${extensionFromContentType(contentType)}`;
}

export function toFileUrl(filePath: string): string {
  const normalized = String(filePath ?? "").replace(/\\/g, "/");
  return normalized.startsWith("/")
    ? `file://${normalized}`
    : `file:///${normalized}`;
}

export function imageMimeOf(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  return "image/jpeg";
}

export function fileToDataUrl(filePath: string, buffer: Buffer): string {
  return `data:${imageMimeOf(filePath)};base64,${buffer.toString("base64")}`;
}

export async function readImageDataUrl(filePath: string): Promise<string> {
  const buffer = await fsp.readFile(filePath);
  return fileToDataUrl(filePath, buffer);
}

async function fetchBuffer(
  source: string,
): Promise<{ buffer: Buffer; contentType: string | null }> {
  const response = await fetch(source, {
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  return { buffer, contentType: response.headers.get("content-type") };
}

async function readSource(
  source: string,
): Promise<{
  buffer: Buffer;
  contentType: string | null;
  fallbackName: string;
}> {
  if (/^https?:/i.test(source)) {
    const { buffer, contentType } = await fetchBuffer(source);
    return { buffer, contentType, fallbackName: nameFromUrl(source) };
  }
  if (source.startsWith("base64://")) {
    return {
      buffer: Buffer.from(source.slice("base64://".length), "base64"),
      contentType: null,
      fallbackName: "",
    };
  }
  if (source.startsWith("data:")) {
    const comma = source.indexOf(",");
    const meta = comma >= 0 ? source.slice(0, comma) : "";
    const payload = comma >= 0 ? source.slice(comma + 1) : source;
    const contentType = /^data:([^;,]+)/i.exec(meta)?.[1] ?? null;
    const isBase64 = /;base64/i.test(meta);
    return {
      buffer: Buffer.from(payload, isBase64 ? "base64" : "utf-8"),
      contentType,
      fallbackName: "",
    };
  }

  const localPath = source.startsWith("file://")
    ? source.slice("file://".length)
    : source;
  const stat = await fsp.stat(localPath).catch(() => null);
  if (!stat?.isFile()) {
    throw new Error(
      `source is neither a URL nor a readable local file: ${source}`,
    );
  }
  return {
    buffer: await fsp.readFile(localPath),
    contentType: null,
    fallbackName: sanitizeName(path.basename(localPath)),
  };
}

function candidateSources(item: MediaAttachment): string[] {
  const candidates: string[] = [];
  const push = (value: string | undefined) => {
    if (value && !candidates.includes(value)) candidates.push(value);
  };
  push(item.url && /^https?:/i.test(item.url) ? item.url : undefined);
  push(
    item.file && /^(?:https?|base64|data):/i.test(item.file)
      ? item.file
      : undefined,
  );
  push(item.url);
  push(item.path);
  push(item.file);
  return candidates;
}

async function platformLookup(
  bot: Bot | undefined,
  item: MediaAttachment,
): Promise<{ sources: string[]; names: string[] }> {
  const sources: string[] = [];
  const names: string[] = [];
  if (!bot || !item.fileId) return { sources, names };

  const attempts: Array<[string, Record<string, unknown>]> = [
    ["get_file", { file_id: item.fileId }],
  ];
  if (item.groupId) {
    attempts.push([
      "get_group_file_url",
      { group_id: Number(item.groupId), file_id: item.fileId },
    ]);
  }
  if (item.userId) {
    attempts.push([
      "get_private_file_url",
      { user_id: Number(item.userId), file_id: item.fileId },
    ]);
  }

  for (const [action, params] of attempts) {
    try {
      const result = (await bot.sendApi(action, params)) as Record<
        string,
        unknown
      > | null;
      if (!result || typeof result !== "object") continue;
      for (const key of ["url", "file", "path"]) {
        const value = result[key];
        if (typeof value === "string" && value.trim())
          sources.push(value.trim());
      }
      const base64 = result.base64 ?? result.data;
      if (typeof base64 === "string" && base64.trim()) {
        sources.push(`base64://${base64.trim()}`);
      }
      for (const key of ["file_name", "name"]) {
        const value = result[key];
        if (typeof value === "string" && value.trim()) names.push(value.trim());
      }
    } catch {
      // 平台不支持该 action 时忽略，继续尝试下一个
    }
  }
  return { sources, names };
}

function describeFields(item: MediaAttachment): string {
  const fields = Object.entries(item)
    .filter(
      ([key, value]) =>
        key !== "kind" && key !== "messageId" && value !== undefined,
    )
    .map(([key, value]) => `${key}=${String(value).slice(0, 60)}`);
  return fields.join(", ") || "(no usable fields)";
}

async function resolveSource(
  item: MediaAttachment,
  bot: Bot | undefined,
): Promise<{
  buffer: Buffer;
  contentType: string | null;
  fallbackName: string;
}> {
  const platform = await platformLookup(bot, item);
  const candidates = [...candidateSources(item), ...platform.sources];
  if (candidates.length === 0) {
    throw new Error(`no downloadable source (${describeFields(item)})`);
  }
  let lastError = "";
  for (const source of candidates) {
    try {
      const result = await readSource(source);
      // 平台返回的原始文件名最可信，其次才是 URL 推断出来的名字
      return {
        ...result,
        fallbackName: platform.names[0] ?? result.fallbackName,
      };
    } catch (err) {
      lastError = String(err);
    }
  }
  throw new Error(`${lastError} | fields: ${describeFields(item)}`);
}

export async function downloadMediaItems(
  items: MediaAttachment[],
  workspaceRoot: string,
  options: { bot?: Bot } = {},
): Promise<DownloadResult> {
  const dir = path.join(workspaceRoot, "download", dateStamp());
  const files: DownloadedMedia[] = [];
  const errors: string[] = [];
  if (items.length === 0) return { dir, files, errors };

  await fsp.mkdir(dir, { recursive: true });
  for (const [index, item] of items.entries()) {
    try {
      const { buffer, contentType, fallbackName } = await resolveSource(
        item,
        options.bot,
      );
      if (buffer.byteLength > MAX_DOWNLOAD_BYTES) {
        errors.push(`#${index + 1} exceeds ${MAX_DOWNLOAD_BYTES} bytes`);
        continue;
      }
      const name = chooseFileName(item, fallbackName, contentType, index);
      const target = await uniquePath(dir, name);
      await fsp.writeFile(target, buffer);
      files.push({
        kind: item.kind,
        messageId: item.messageId,
        name: path.basename(target),
        size: buffer.byteLength,
        path: target,
        remoteUrl:
          item.url && /^https?:/i.test(item.url) ? item.url : undefined,
      });
    } catch (err) {
      errors.push(`#${index + 1} ${err}`);
    }
  }
  return { dir, files, errors };
}
