import type { Message, MessageEvent, MultimodalContentItem } from "mioku";
import type { AgentHost } from "../types";
import { readImageDataUrl, toFileUrl, type DownloadedMedia } from "./download";

export type MediaKind = "image" | "file" | "video" | "record";

export interface MediaAttachment {
  kind: MediaKind;
  messageId: string;
  name?: string;
  size?: number;
  url?: string;
  file?: string;
  path?: string;
  fileId?: string;
  userId?: string;
  groupId?: string;
}

const MEDIA_KINDS: readonly string[] = ["image", "file", "video", "record"];

function pickString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function pickNumber(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

export function extractMediaFromMessage(
  message: Message | undefined,
  messageId: string,
  context: { userId?: string; groupId?: string } = {},
): MediaAttachment[] {
  const items: MediaAttachment[] = [];
  for (const segment of message ?? []) {
    if (!MEDIA_KINDS.includes(segment.type)) continue;
    const data = segment.data ?? {};
    const attachment = segment.attachment;
    items.push({
      kind: segment.type as MediaKind,
      messageId,
      userId: context.userId,
      groupId: context.groupId,
      name:
        pickString(data.name) ??
        pickString(data.file_name) ??
        pickString(data.file_unique) ??
        pickString(attachment?.name),
      size:
        pickNumber(data.size) ?? pickNumber(data.file_size) ?? attachment?.size,
      url: pickString(data.url) ?? pickString(attachment?.url),
      file: pickString(data.file) ?? pickString(attachment?.file),
      path: pickString(data.path),
      fileId:
        pickString(data.file_id) ??
        pickString(data.fid) ??
        pickString(data.fileId),
    });
  }
  return items;
}

export function extractMedia(event: MessageEvent): MediaAttachment[] {
  return extractMediaFromMessage(
    event.message,
    String(event.message_id ?? ""),
    {
      userId: event.user_id ? String(event.user_id) : undefined,
      groupId: event.group_id ? String(event.group_id) : undefined,
    },
  );
}

export function formatMediaNote(
  downloads: DownloadedMedia[],
  errors: string[] = [],
): string {
  if (downloads.length === 0 && errors.length === 0) return "";
  const lines = downloads.map(
    (item, index) =>
      `- [${index + 1}] message_id=${item.messageId || "unknown"} name=${item.name} [${toFileUrl(item.path)}]`,
  );
  lines.push(...errors.map((error) => `- download failed: ${error}`));
  return [
    "[Attached files] all saved on disk (images are also attached to this message):",
    ...lines,
  ].join("\n");
}

export async function describeImageFile(
  host: AgentHost,
  filePath: string,
): Promise<string> {
  const resolved = host.resolveModel();
  const vision = resolved?.vision ?? resolved?.instance;
  const visionModel = resolved?.visionModel || resolved?.model || "";
  if (!vision) return "(vision model unavailable)";

  let dataUrl: string;
  try {
    dataUrl = await readImageDataUrl(filePath);
  } catch (err) {
    return `(failed to read image: ${err})`;
  }

  const content: MultimodalContentItem[] = [
    {
      type: "text",
      text: "Describe this image in detail, including any visible text, UI elements and data.",
    },
    { type: "image_url", image_url: { url: dataUrl, detail: "auto" } },
  ];
  const response = await vision.complete({
    model: visionModel,
    messages: [
      {
        role: "system",
        content:
          "You are an image analysis assistant. Describe the image clearly and objectively in 2-6 sentences. Transcribe any visible text accurately.",
      },
      { role: "user", content },
    ],
    temperature: 0.3,
  });
  return response.content?.trim() || "(no description returned)";
}

export async function describeImageUrls(
  host: AgentHost,
  urls: string[],
): Promise<string> {
  const resolved = host.resolveModel();
  const vision = resolved?.vision ?? resolved?.instance;
  const visionModel = resolved?.visionModel || resolved?.model || "";
  if (!vision || urls.length === 0) return "";
  const content: MultimodalContentItem[] = [
    {
      type: "text",
      text: "Describe the attached image(s) from a chat message in 2-4 sentences. Transcribe any visible text.",
    },
    ...urls.map(
      (url): MultimodalContentItem => ({
        type: "image_url",
        image_url: { url, detail: "auto" },
      }),
    ),
  ];
  try {
    const response = await vision.complete({
      model: visionModel,
      messages: [
        {
          role: "system",
          content:
            "You are an image analysis assistant. Describe the image clearly and objectively.",
        },
        { role: "user", content },
      ],
      temperature: 0.3,
    });
    return response.content?.trim() || "";
  } catch (err) {
    host.logger.warn(`[agent] image describe failed: ${err}`);
    return "";
  }
}
