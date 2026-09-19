import type { ConfigService } from "mioku";
import type { ChatSharedConfig } from "../types";

export async function readChatSharedConfig(
  configService: ConfigService | undefined,
): Promise<ChatSharedConfig> {
  if (!configService) return { persona: "", replyStyle: "", emotion: null };
  const personalization = await configService
    .getConfig("chat", "personalization")
    .catch(() => null);
  return {
    persona: String(personalization?.persona ?? ""),
    replyStyle: String(personalization?.replyStyle?.baseStyle ?? ""),
    emotion:
      personalization?.emotion && typeof personalization.emotion === "object"
        ? {
            defaultEmotion: String(
              personalization.emotion.defaultEmotion ?? "default",
            ),
            emotions: personalization.emotion.emotions ?? {},
          }
        : null,
  };
}
