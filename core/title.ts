import type { AgentHost } from "../types";

const TITLE_MAX_CHARS = 40;
const TITLE_MAX_MESSAGES = 20;

function fallbackTitle(
  messages: Array<{ role: string; content: string }>,
): string {
  const firstUser = messages.find((message) => message.role === "user");
  const text = (firstUser?.content ?? "").replace(/\s+/g, " ").trim();
  return text.slice(0, TITLE_MAX_CHARS) || "Untitled session";
}

export async function generateSessionTitle(
  host: AgentHost,
  sessionId: string,
): Promise<string> {
  const messages = host.db.getMessagesAfter(sessionId, 0);
  if (messages.length === 0) return "Empty session";
  const fallback = fallbackTitle(messages);

  const resolved = host.resolveModel();
  const worker = resolved?.working ?? resolved?.instance;
  if (!worker) return fallback;

  const transcript = messages
    .slice(-TITLE_MAX_MESSAGES)
    .map((message) => `${message.role === "user" ? "USER" : "AGENT"}: ${message.content}`)
    .join("\n")
    .slice(0, 6000);

  try {
    const response = await worker.complete({
      model: resolved?.workingModel || resolved?.model || "",
      messages: [
        {
          role: "system",
          content:
            "You name conversation sessions. Given a conversation transcript, write a short title that captures the main task or topic. Rules: at most 12 words, same language as the conversation, no quotes, no punctuation at the end, output ONLY the title.",
        },
        { role: "user", content: transcript },
      ],
      temperature: 0.3,
    });
    const title = (response.content ?? "").trim().replace(/^["'#\s]+|["'\s]+$/g, "");
    if (!title) return fallback;
    return title.slice(0, TITLE_MAX_CHARS);
  } catch (err) {
    host.logger.warn(`[agent] session title generation failed: ${err}`);
    return fallback;
  }
}
