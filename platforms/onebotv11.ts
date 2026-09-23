import type { AgentPlatform, PlatformFileLookup } from "./types";
import { EMPTY_FILE_LOOKUP, mergeFileLookup } from "./types";

/** onebotv11:get_file / get_group_file_url / get_private_file_url */
export const onebotv11Platform: AgentPlatform = {
  adapter: "onebotv11",
  route: "onebotv11:message",
  async resolveFile(bot, ref): Promise<PlatformFileLookup> {
    const attempts: Array<[string, Record<string, unknown>]> = [
      ["get_file", { file_id: ref.fileId }],
    ];
    if (ref.groupId) {
      attempts.push([
        "get_group_file_url",
        { group_id: ref.groupId, file_id: ref.fileId },
      ]);
    }
    if (ref.userId) {
      attempts.push([
        "get_private_file_url",
        { user_id: ref.userId, file_id: ref.fileId },
      ]);
    }
    const found: PlatformFileLookup = { sources: [], names: [] };
    for (const [action, params] of attempts) {
      try {
        mergeFileLookup(
          found,
          await bot.sendApi<Record<string, unknown>>(action, params),
        );
      } catch {
        // 协议端不支持该 action 时继续尝试下一个
      }
      if (found.sources.length > 0) break;
    }
    return found;
  },
};

export { EMPTY_FILE_LOOKUP };
