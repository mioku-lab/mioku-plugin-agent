import * as fsp from "node:fs/promises";
import type { Bot, MessageSegment, MessageTarget, MiokuContext } from "mioku";

export function isLocalFilePath(value: string): boolean {
  return value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value);
}

export function normalizeImageSource(file: string): string {
  const value = String(file ?? "").trim();
  if (!value) return value;
  if (/^(?:file|base64|data|https?):/i.test(value)) return value;
  if (isLocalFilePath(value)) return `file://${value}`;
  return value;
}

export async function sendImageSource(
  ctx: MiokuContext,
  bot: Bot,
  target: MessageTarget,
  source: string,
  prefix: MessageSegment[] = [],
): Promise<boolean> {
  const value = String(source ?? "").trim();
  if (!value) return false;
  try {
    if (isLocalFilePath(value)) {
      const buffer = await fsp.readFile(value);
      await bot.sendMessage(target, [...prefix, ctx.segment.image(buffer)]);
      return true;
    }
    await bot.sendMessage(target, [
      ...prefix,
      ctx.segment.image(normalizeImageSource(value)),
    ]);
    return true;
  } catch (err) {
    ctx.logger.warn(`[agent] failed to send image ${value}: ${err}`);
    return false;
  }
}

export async function sendLocalFile(
  ctx: MiokuContext,
  bot: Bot,
  target: MessageTarget,
  filePath: string,
  name: string,
): Promise<void> {
  await bot.sendMessage(target, [ctx.segment.file(filePath, { name })]);
}
