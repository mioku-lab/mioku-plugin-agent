import type { AgentPlatform } from "./types";
import { EMPTY_FILE_LOOKUP } from "./types";

/**
 * QQ 官方通道：附件事件自带公网 URL(见 adapter 的 segments.ts),
 * 官方没有 file_id 换下载地址的公开接口,所以这里不做事。
 */
export const qqOfficialPlatform: AgentPlatform = {
  adapter: "qq-official",
  route: "qq-official:message",
  async resolveFile() {
    return EMPTY_FILE_LOOKUP;
  },
};
