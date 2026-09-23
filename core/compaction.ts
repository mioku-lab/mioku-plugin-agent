import type { AgentHost } from "../types";
import { compactionThresholdTokens } from "../configs/context-window";

export function estimateTokens(text: string): number {
  const normalized = String(text ?? "").trim();
  if (!normalized) return 0;
  const cjkChars = normalized.match(/[\u3400-\u9fff\u3040-\u30ff]/g)?.length || 0;
  const latinWords = normalized.match(/[A-Za-z0-9_]+/g)?.length || 0;
  const symbols = Math.max(0, normalized.length - cjkChars);
  return Math.max(1, Math.ceil(cjkChars * 0.6 + latinWords * 1.3 + symbols / 6));
}

export function estimateHistoryTokens(
  messages: Array<{ content: string }>,
): number {
  return messages.reduce((sum, message) => sum + estimateTokens(message.content), 0);
}

function transcript(messages: Array<{ role: string; content: string }>): string {
  return messages
    .map((message) => {
      const speaker =
        message.role === "user" ? "USER" : message.role === "assistant" ? "AGENT" : "SYSTEM";
      return `${speaker}: ${message.content}`;
    })
    .join("\n\n");
}

export interface CompactionResult {
  compacted: boolean;
  reason: string;
  freedTokens: number;
}

export async function maybeCompact(
  host: AgentHost,
  userId: string,
  options: { force?: boolean } = {},
): Promise<CompactionResult> {
  const settings = host.getSettings();
  const compaction = settings.compaction;
  if (!compaction.enabled && !options.force) {
    return { compacted: false, reason: "compaction disabled", freedTokens: 0 };
  }
  const thresholdTokens = compactionThresholdTokens(settings.maxContextTokens);

  const session = host.sessions.get(userId);
  const messages = host.db.getMessagesAfter(session.sessionId, session.summaryUpTo);
  if (messages.length <= compaction.keepRecentMessages) {
    return {
      compacted: false,
      reason: `only ${messages.length} message(s), need more than ${compaction.keepRecentMessages}`,
      freedTokens: 0,
    };
  }

  const older = messages.slice(0, messages.length - compaction.keepRecentMessages);
  const olderTokens = estimateHistoryTokens(older);
  if (!options.force && olderTokens < thresholdTokens) {
    return {
      compacted: false,
      reason: `~${olderTokens} tokens below threshold ${thresholdTokens}`,
      freedTokens: 0,
    };
  }

  const resolved = host.resolveModel();
  const worker = resolved?.working ?? resolved?.instance;
  if (!worker) {
    return { compacted: false, reason: "no model available", freedTokens: 0 };
  }

  const previousSummary = session.summary
    ? `Previous summary:\n${session.summary}\n\n`
    : "";
  const prompt = `${previousSummary}Conversation to summarize:\n\n${transcript(older)}\n\nWrite an updated running summary in English for an AI agent's long-term context. Keep: the user's requests and goals, key facts learned (files, paths, decisions, outcomes), open tasks and unresolved questions. Be factual and compact. Output only the summary text.`;

  try {
    const response = await worker.complete({
      model: resolved?.workingModel || resolved?.model || "",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.3,
    });
    const summary = response.content?.trim();
    if (!summary) {
      return { compacted: false, reason: "empty summary from model", freedTokens: 0 };
    }
    host.db.setSummary(session.sessionId, summary, older[older.length - 1].id);
    host.logger.info(
      `[agent] compacted ${older.length} messages for user ${userId} (freed ~${olderTokens} tokens)`,
    );
    return { compacted: true, reason: `${older.length} messages condensed`, freedTokens: olderTokens };
  } catch (err) {
    host.logger.warn(`[agent] compaction failed: ${err}`);
    return { compacted: false, reason: `compaction failed: ${err}`, freedTokens: 0 };
  }
}
