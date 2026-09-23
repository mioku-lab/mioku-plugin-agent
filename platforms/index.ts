import type { MessageEvent, MiokuContext } from "mioku";
import type { AgentHost } from "../types";
import { handleAgentMessage } from "../handlers/message";
import { genericPlatform } from "./generic";
import { icqqPlatform } from "./icqq";
import { onebotv11Platform } from "./onebotv11";
import { qqOfficialPlatform } from "./qq-official";
import type { AgentPlatform } from "./types";

/** 每个平台一个分支文件，新增平台在这里登记即可 */
export const AGENT_PLATFORMS: readonly AgentPlatform[] = [
  onebotv11Platform,
  icqqPlatform,
  qqOfficialPlatform,
];

/**
 * 按适配器前缀路由注册平台分支：
 * `onebotv11:message` / `icqq:message` / `qq-official:message` 各管自己的差异，
 * 未登记的适配器由通用 `message` 分支兜底。
 */
export function registerAgentPlatforms(
  ctx: MiokuContext,
  host: AgentHost,
): () => void {
  const disposers: Array<() => void> = [];

  for (const platform of AGENT_PLATFORMS) {
    disposers.push(
      ctx.handle(platform.route, (event) =>
        handleAgentMessage(host, event as unknown as MessageEvent, platform),
      ),
    );
  }

  const owned = new Set(AGENT_PLATFORMS.map((platform) => platform.adapter));
  disposers.push(
    ctx.handle("message", (event) => {
      const messageEvent = event as unknown as MessageEvent;
      const adapter = String(messageEvent?.bot?.adapter ?? "");
      if (owned.has(adapter)) return;
      return handleAgentMessage(host, messageEvent, genericPlatform);
    }),
  );

  return () => {
    for (const dispose of disposers) dispose();
  };
}
