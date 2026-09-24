import type { MessageEvent } from "mioku";
import type { AgentHost } from "../types";
import { identityOf } from "../core/identity";
import { runAgentTurn } from "../core/loop";
import { genericPlatform } from "../platforms/generic";
import type { AgentPlatform } from "../platforms/types";

/** 私聊里以命令前缀开头的消息交给命令系统，agent 不处理 */
const COMMAND_PREFIX = /^[./~]/;

/** 各平台分支共用的入口：权限/自消息过滤后进入 agent 轮次 */
export async function handleAgentMessage(
  host: AgentHost,
  event: MessageEvent,
  platform: AgentPlatform = genericPlatform,
): Promise<void> {
  if (event.message_type === "group") return;
  const identity = identityOf(event);
  if (!identity.userId || identity.userId === identity.botId) return;
  const text = host.ctx.text(event);
  if (COMMAND_PREFIX.test(text)) {
    host.logger.debug(
      `[agent] command ignored | user=${identity.userId} text=${text.slice(0, 60)}`,
    );
    return;
  }
  if (!(await host.isAllowed(identity.userId))) return;
  await runAgentTurn(host, event, platform);
}
