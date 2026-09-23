import type { MessageEvent } from "mioku";

/**
 * 事件的用户身份。
 * `userId` 是平台原始 id(QQ 号或 openid),用于权限名单匹配;
 * `scope` 额外带上适配器,用于会话/工作区/队列隔离,避免不同平台相同 id 串号。
 */
export interface AgentIdentity {
  readonly userId: string;
  readonly adapter: string;
  readonly botId: string;
  readonly scope: string;
}

export const identityOf = (event: MessageEvent): AgentIdentity => {
  const userId = String(event?.user_id ?? event?.sender?.user_id ?? "").trim();
  const adapter = String(
    event?.bot?.adapter ?? event?.identity?.adapter ?? "",
  ).trim();
  const botId = String(event?.self_id ?? event?.bot?.bot_id ?? "").trim();
  return {
    userId,
    adapter,
    botId,
    scope: `${adapter || "unknown"}:${userId}`,
  };
};
