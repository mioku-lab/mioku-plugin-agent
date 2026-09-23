import type { Bot, MessageSegment } from "mioku";
import type { AgentHost } from "../types";
import { sendImageSource } from "./attachment";
import {
  cleanEmotionMarkers,
  consumeCompleteStreamUnits,
  createThinkTagStreamFilter,
  extractReplyMarker,
  extractStandaloneMarkdownBlock,
  splitOutgoingUnits,
} from "./units";

const MAX_MESSAGE_CHARS = 1200;

function splitLongText(text: string): string[] {
  if (text.length <= MAX_MESSAGE_CHARS) return [text];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > MAX_MESSAGE_CHARS) {
    let cut = rest.lastIndexOf("\n", MAX_MESSAGE_CHARS);
    if (cut < MAX_MESSAGE_CHARS * 0.5) cut = MAX_MESSAGE_CHARS;
    chunks.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) chunks.push(rest);
  return chunks.filter(Boolean);
}

export class TurnSender {
  private streamBuffer = "";
  private thinkFilter = createThinkTagStreamFilter();
  private quoteId: string | null = null;
  streamedText = "";
  sentCount = 0;

  constructor(
    private host: AgentHost,
    private bot: Bot | undefined,
    private userId: string,
    private enableScreenshot: boolean,
  ) {}

  /** 当前待用的引用段：只有本轮的**第一条**消息带引用，发送成功后才消费掉。 */
  private quoteSegments(): MessageSegment[] {
    return this.quoteId ? [this.host.ctx.segment.reply(this.quoteId)] : [];
  }

  private async deliverText(text: string): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed || trimmed === "---") return;
    if (!this.bot) return;
    const chunks = splitLongText(trimmed);
    for (const [index, chunk] of chunks.entries()) {
      const segments = index === 0 ? this.quoteSegments() : [];
      segments.push(this.host.ctx.segment.text(chunk));
      await this.bot.sendMessage(
        { type: "private", user_id: this.userId },
        segments,
      );
      if (index === 0) this.quoteId = null;
      this.sentCount += 1;
    }
  }

  private async deliverUnit(unit: string): Promise<void> {
    const cleaned = cleanEmotionMarkers(unit);
    const { text, replyTo } = extractReplyMarker(cleaned.text);
    if (replyTo) this.quoteId = replyTo;
    if (!text) return;
    this.streamedText = this.streamedText
      ? `${this.streamedText}\n${text}`
      : text;
    const markdown = extractStandaloneMarkdownBlock(text);
    if (markdown && this.enableScreenshot && this.host.screenshot && this.bot) {
      try {
        const imagePath = await this.host.screenshot.screenshotMarkdown(markdown);
        if (imagePath) {
          const sent = await sendImageSource(
            this.host.ctx,
            this.bot,
            { type: "private", user_id: this.userId },
            imagePath,
            this.quoteSegments(),
          );
          if (sent) {
            this.quoteId = null;
            this.sentCount += 1;
            return;
          }
        }
      } catch (err) {
        this.host.logger.warn(`[agent] markdown screenshot failed: ${err}`);
      }
    }
    await this.deliverText(markdown ?? text);
  }

  async sendText(text: string): Promise<void> {
    for (const unit of splitOutgoingUnits(text)) {
      await this.deliverUnit(unit);
    }
  }

  async onDelta(delta: string): Promise<void> {
    this.streamBuffer += this.thinkFilter.push(delta, false);
    await this.flush(false);
  }

  private async flush(force: boolean): Promise<void> {
    while (true) {
      const { units, rest } = consumeCompleteStreamUnits(this.streamBuffer, force);
      if (units.length === 0) {
        this.streamBuffer = rest;
        break;
      }
      this.streamBuffer = rest;
      for (const unit of units) {
        await this.deliverUnit(unit);
      }
      if (!force) break;
    }
  }

  async finishStream(fullText: string): Promise<void> {
    this.streamBuffer += this.thinkFilter.push("", true);
    await this.flush(true);
    if (this.sentCount === 0 && fullText.trim()) {
      await this.sendText(fullText);
    }
  }
}
