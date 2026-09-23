import type { AgentPlatform, PlatformFileLookup } from "./types";
import { EMPTY_FILE_LOOKUP, mergeFileLookup } from "./types";

interface IcqqFileHolder {
  getFileUrl?(fileId: string): Promise<string>;
  getFileInfo?(fileId: string): Promise<{ url?: string; name?: string } | null>;
}

interface IcqqFileClient {
  pickGroup?(groupId: string): IcqqFileHolder;
  pickFriend?(userId: string): IcqqFileHolder;
}

/** icqq:pickGroup / pickFriend 上的 getFileInfo / getFileUrl */
export const icqqPlatform: AgentPlatform = {
  adapter: "icqq",
  route: "icqq:message",
  async resolveFile(bot, ref): Promise<PlatformFileLookup> {
    const client = bot.as<IcqqFileClient>();
    const holder = ref.groupId
      ? client.pickGroup?.(ref.groupId)
      : ref.userId
        ? client.pickFriend?.(ref.userId)
        : undefined;
    if (!holder) return EMPTY_FILE_LOOKUP;

    const found: PlatformFileLookup = { sources: [], names: [] };
    if (holder.getFileInfo) {
      try {
        mergeFileLookup(found, await holder.getFileInfo(ref.fileId));
      } catch {
        // 文件不存在或无权限时继续尝试 getFileUrl
      }
    }
    if (found.sources.length === 0 && holder.getFileUrl) {
      try {
        const url = await holder.getFileUrl(ref.fileId);
        if (typeof url === "string" && url.trim()) {
          found.sources.push(url.trim());
        }
      } catch {
        // 调用方会回退到消息段里自带的 url/file
      }
    }
    return found;
  },
};
