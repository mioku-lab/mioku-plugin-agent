import type { AgentPlatform } from "./types";
import { EMPTY_FILE_LOOKUP } from "./types";

/** 未单独登记的适配器(如 stdin、未来的新平台)走的兜底分支 */
export const genericPlatform: AgentPlatform = {
  adapter: "",
  route: "message",
  async resolveFile() {
    return EMPTY_FILE_LOOKUP;
  },
};
