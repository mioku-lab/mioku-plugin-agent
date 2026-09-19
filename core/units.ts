export const MARKDOWN_OPEN_TAG = "<MARKDOWN>";
export const MARKDOWN_CLOSE_TAG = "</MARKDOWN>";

export function stripThinkBlocks(text: string): string {
  let source = String(text ?? "");
  let output = "";
  while (source) {
    const open = /<(?:think|thinking)\b[^>]*>/i.exec(source);
    if (!open) {
      output += source;
      break;
    }
    output += source.slice(0, open.index);
    const afterOpen = source.slice(open.index + open[0].length);
    const close = /<\/(?:think|thinking)\s*>/i.exec(afterOpen);
    if (!close) break;
    source = afterOpen.slice(close.index + close[0].length);
  }
  return output.replace(/<\/?(?:think|thinking)\s*>/gi, "");
}

export function createThinkTagStreamFilter() {
  let buffer = "";
  let insideThink = false;

  const findOpen = (text: string) => {
    const match = /<(?:think|thinking)\b[^>]*>/i.exec(text);
    return match ? { index: match.index, end: match.index + match[0].length } : null;
  };
  const findClose = (text: string) => {
    const match = /<\/(?:think|thinking)\s*>/i.exec(text);
    return match ? { index: match.index, end: match.index + match[0].length } : null;
  };
  const keepSuffix = (text: string, tagPrefix: string) => {
    const maxLength = Math.min(text.length, tagPrefix.length - 1);
    const lowerText = text.toLowerCase();
    const lowerPrefix = tagPrefix.toLowerCase();
    for (let length = maxLength; length > 0; length--) {
      if (lowerPrefix.startsWith(lowerText.slice(-length))) {
        return text.slice(-length);
      }
    }
    return "";
  };

  return {
    push(delta: string, force: boolean): string {
      buffer += delta;
      let output = "";
      while (buffer) {
        if (insideThink) {
          const close = findClose(buffer);
          if (!close) {
            buffer = force ? "" : keepSuffix(buffer, "</thinking>");
            break;
          }
          buffer = buffer.slice(close.end);
          insideThink = false;
          continue;
        }
        const open = findOpen(buffer);
        if (!open) {
          const keep = force ? "" : keepSuffix(buffer, "<thinking>");
          output += buffer.slice(0, buffer.length - keep.length);
          buffer = keep;
          break;
        }
        output += buffer.slice(0, open.index);
        buffer = buffer.slice(open.end);
        insideThink = true;
      }
      return output;
    },
  };
}

export function splitOutgoingUnits(text: string): string[] {
  const normalized = String(text ?? "").replace(/\r/g, "");
  const result: string[] = [];
  let buffer = "";
  let insideMarkdown = false;

  for (let index = 0; index < normalized.length; ) {
    if (!insideMarkdown && normalized.startsWith(MARKDOWN_OPEN_TAG, index)) {
      if (buffer.trim()) result.push(buffer.trim());
      buffer = MARKDOWN_OPEN_TAG;
      insideMarkdown = true;
      index += MARKDOWN_OPEN_TAG.length;
      continue;
    }
    if (insideMarkdown && normalized.startsWith(MARKDOWN_CLOSE_TAG, index)) {
      buffer += MARKDOWN_CLOSE_TAG;
      if (buffer.trim()) result.push(buffer.trim());
      buffer = "";
      insideMarkdown = false;
      index += MARKDOWN_CLOSE_TAG.length;
      continue;
    }
    const char = normalized[index];
    if (!insideMarkdown && char === "\n") {
      if (buffer.trim()) result.push(buffer.trim());
      buffer = "";
      index += 1;
      continue;
    }
    buffer += char;
    index += 1;
  }
  if (buffer.trim()) result.push(buffer.trim());
  return result;
}

function takeNextStreamUnit(
  input: string,
  force: boolean,
): { unit: string; rest: string } | null {
  const openIndex = input.indexOf(MARKDOWN_OPEN_TAG);
  const newlineIndex = input.indexOf("\n");

  if (openIndex === -1) {
    if (newlineIndex >= 0) {
      return { unit: input.slice(0, newlineIndex).trim(), rest: input.slice(newlineIndex + 1) };
    }
    if (force && input.trim()) return { unit: input.trim(), rest: "" };
    return null;
  }
  if (newlineIndex >= 0 && newlineIndex < openIndex) {
    return { unit: input.slice(0, newlineIndex).trim(), rest: input.slice(newlineIndex + 1) };
  }
  if (openIndex > 0) {
    const prefix = input.slice(0, openIndex).trim();
    return prefix
      ? { unit: prefix, rest: input.slice(openIndex) }
      : { unit: "", rest: input.slice(openIndex) };
  }
  const closeIndex = input.indexOf(MARKDOWN_CLOSE_TAG, MARKDOWN_OPEN_TAG.length);
  if (closeIndex < 0) {
    if (force && input.trim()) return { unit: input.trim(), rest: "" };
    return null;
  }
  const endIndex = closeIndex + MARKDOWN_CLOSE_TAG.length;
  const unit = input.slice(0, endIndex).trim();
  let rest = input.slice(endIndex);
  while (rest.startsWith("\n")) rest = rest.slice(1);
  return { unit, rest };
}

export function consumeCompleteStreamUnits(
  buffer: string,
  force: boolean,
): { units: string[]; rest: string } {
  let rest = String(buffer ?? "").replace(/\r/g, "");
  const units: string[] = [];
  while (rest) {
    while (rest.startsWith("\n")) rest = rest.slice(1);
    if (!rest) break;
    const next = takeNextStreamUnit(rest, force);
    if (!next) break;
    if (next.unit) units.push(next.unit);
    rest = next.rest;
    if (!force) break;
  }
  return { units, rest };
}

export function extractStandaloneMarkdownBlock(text: string): string | null {
  const trimmed = String(text ?? "").trim();
  if (
    !trimmed.startsWith(MARKDOWN_OPEN_TAG) ||
    !trimmed.endsWith(MARKDOWN_CLOSE_TAG)
  ) {
    return null;
  }
  const inner = trimmed.slice(
    MARKDOWN_OPEN_TAG.length,
    trimmed.length - MARKDOWN_CLOSE_TAG.length,
  );
  return inner.trim() || null;
}

export function cleanEmotionMarkers(text: string): {
  text: string;
  emotion: string | null;
} {
  const match = /\[emotion:([^\]\n]+)\]/i.exec(String(text ?? ""));
  const emotion = match ? match[1].trim().toLowerCase() : null;
  return {
    text: String(text ?? "")
      .replace(/\[emotion:[^\]\n]+\]/gi, "")
      .replace(/\r/g, "")
      .trim(),
    emotion,
  };
}

/** 提取 `[reply:message_id]` 引用标记：标记会被移除，id 用于给下一条消息加引用。 */
export function extractReplyMarker(text: string): {
  text: string;
  replyTo: string | null;
} {
  const source = String(text ?? "");
  const match = /\[reply:([^\]\n]+)\]/i.exec(source);
  const replyTo = match ? match[1].trim() : null;
  return {
    text: source.replace(/\[reply:[^\]\n]+\]/gi, "").replace(/\r/g, "").trim(),
    replyTo: replyTo || null,
  };
}
