import type { MessageEvent } from "mioku";
import type { AgentHost } from "../types";
import { runAgentTurn } from "../core/loop";

export function createMessageHandler(host: AgentHost) {
  return async (e: MessageEvent) => {
    if (e.message_type === "group") return;
    const userId = Number(e.user_id || e.sender?.user_id || 0);
    if (!userId || userId === Number(e.self_id || 0)) return;
    if (!(await host.isAllowed(userId))) return;
    await runAgentTurn(host, e);
  };
}
