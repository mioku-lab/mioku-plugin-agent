import { definePlugin, getService, Services } from "mioku";
import type { MiokuContext } from "mioku";
import { initDatabase } from "./db";
import { SessionManager } from "./core/session";
import { EmotionManager } from "./core/emotion";
import { ApprovalManager } from "./tools/approval";
import { readChatSharedConfig } from "./core/chat-config";
import { registerAgentPlatforms } from "./platforms";
import { registerCommands } from "./commands";
import { mergeAgentConfig } from "./utils/config";
import { workspaceRootFor } from "./tools/perm";
import {
  prepareModelOverride,
  resolveAgentModel,
  type ModelOverride,
} from "./core/model";
import { BASE_CONFIG } from "./configs/base";
import { SETTINGS_CONFIG } from "./configs/settings";
import type {
  AgentBaseConfig,
  AgentHost,
  AgentSettingsConfig,
  ResolvedModel,
} from "./types";

function normalizeIdList(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  return Array.from(
    new Set(
      input
        .map((item) => String(item ?? "").trim())
        .filter((id) => id.length > 0),
    ),
  );
}

export default definePlugin({
  name: "agent",
  async setup(ctx: MiokuContext) {
    const aiService = getService(ctx, Services.AI);
    const configService = getService(ctx, Services.Config);
    const screenshot = getService(ctx, Services.Screenshot);

    if (!aiService) {
      ctx.logger.error("AI 服务不可用");
      return;
    }

    if (configService) {
      await configService.registerConfig("agent", "base", BASE_CONFIG);
      await configService.registerConfig("agent", "settings", SETTINGS_CONFIG);
    }

    let cachedBase: AgentBaseConfig = mergeAgentConfig(
      BASE_CONFIG,
      (await configService?.getConfig("agent", "base")) ?? {},
    );
    let cachedSettings: AgentSettingsConfig = mergeAgentConfig(
      SETTINGS_CONFIG,
      (await configService?.getConfig("agent", "settings")) ?? {},
    );
    if (!Array.isArray(cachedBase.access.users)) cachedBase.access.users = [];

    let modelOverride: ModelOverride | undefined;

    const refreshOverride = async (): Promise<void> => {
      const full = String(cachedBase.model ?? "").trim();
      if (!full) {
        modelOverride = undefined;
        return;
      }
      const alive = modelOverride
        ? Boolean(aiService.get?.(modelOverride.instanceName))
        : false;
      if (modelOverride?.key === full && alive) return;
      modelOverride = await prepareModelOverride(aiService, full, (message) =>
        ctx.logger.warn(`[agent] ${message}`),
      );
      ctx.logger.info(
        `[agent] 覆盖模型 ${full} -> ${modelOverride ? `实例 ${modelOverride.instanceName}` : "未绑定，退回主模型"}`,
      );
    };

    const refreshBase = async () => {
      cachedBase = mergeAgentConfig(
        BASE_CONFIG,
        (await configService?.getConfig("agent", "base")) ?? {},
      );
      if (!Array.isArray(cachedBase.access.users)) cachedBase.access.users = [];
      await refreshOverride();
    };
    const refreshSettings = async () => {
      cachedSettings = mergeAgentConfig(
        SETTINGS_CONFIG,
        (await configService?.getConfig("agent", "settings")) ?? {},
      );
    };
    await refreshOverride();
    if (configService) {
      configService.onConfigChange("agent", "base", () =>
        refreshBase().catch((err) =>
          ctx.logger.error(`刷新 agent/base 缓存失败: ${err}`),
        ),
      );
      configService.onConfigChange("agent", "settings", () =>
        refreshSettings().catch((err) =>
          ctx.logger.error(`刷新 agent/settings 缓存失败: ${err}`),
        ),
      );
    }

    const db = await initDatabase();
    const sessions = new SessionManager(db);
    const approvals = new ApprovalManager();
    const emotions = new EmotionManager((userId, emotion) =>
      sessions.setEmotion(userId, emotion),
    );

    const resolveModel = (): ResolvedModel | null =>
      resolveAgentModel({
        aiService,
        overrideFullId: String(cachedBase.model ?? "").trim(),
        override: modelOverride,
      });

    const host: AgentHost = {
      ctx,
      aiService,
      configService,
      screenshot,
      db,
      approvals,
      sessions,
      emotions,
      getBase: () => cachedBase,
      getSettings: () => cachedSettings,
      getChatShared: () => readChatSharedConfig(configService),
      resolveModel,
      workspaceRoot: (userId: string) =>
        workspaceRootFor(cachedBase.workspaceDir, userId),
      isAllowed: async (userId: string) => {
        const target = String(userId ?? "").trim();
        if (!target) return false;
        const matches = (list: readonly unknown[] | undefined): boolean =>
          (list ?? []).some((item) => String(item ?? "").trim() === target);
        if (matches(ctx.config.owners)) return true;
        if (cachedBase.access.allowAdmins && matches(ctx.config.admins)) {
          return true;
        }
        return normalizeIdList(cachedBase.access.users).includes(target);
      },
      updateBase: async (patch) => {
        if (configService) {
          await configService.updateConfig("agent", "base", patch);
          return;
        }
        cachedBase = { ...cachedBase, ...patch };
      },
      logger: ctx.logger,
    };

    registerCommands(host);
    const disposePlatforms = registerAgentPlatforms(ctx, host);

    const resolved = resolveModel();
    ctx.logger.info(
      `agent 插件加载成功 (model=${resolved ? resolved.model : "?"}, level=${cachedBase.permissionLevel})`,
    );

    return () => {
      disposePlatforms();
      approvals.dispose();
      db.close();
      ctx.logger.info("agent 插件已卸载");
    };
  },
});
