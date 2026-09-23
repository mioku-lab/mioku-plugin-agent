import type { MessageEvent } from "mioku";
import type { AgentHost } from "../types";
import { identityOf } from "../core/identity";
import { runAgentTurn } from "../core/loop";
import { genericPlatform } from "../platforms/generic";
import type { AgentPlatform } from "../platforms/types";

/** 各平台分支共用的入口：权限/自消息过滤后进入 agent 轮次 */
export async function handleAgentMessage(
  host: AgentHost,
  event: MessageEvent,
  platform: AgentPlatform = genericPlatform,
): Promise<void> {
  if (event.message_type === "group") return;
  const identity = identityOf(event);
  if (!identity.userId || identity.userId === identity.botId) return;
  if (!(await host.isAllowed(identity.userId))) return;
  await runAgentTurn(host, event, platform);
}
