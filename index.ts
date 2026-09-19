import { definePlugin, getService, Services } from "mioku";
import type { AIInstance, AIModelRole, MiokuContext } from "mioku";
import { initDatabase } from "./db";
import { SessionManager } from "./core/session";
import { EmotionManager } from "./core/emotion";
import { ApprovalManager } from "./tools/approval";
import { readChatSharedConfig } from "./core/chat-config";
import { createMessageHandler } from "./handlers/message";
import { registerCommands } from "./commands";
import { mergeAgentConfig } from "./utils/config";
import { workspaceRootFor } from "./tools/perm";
import { BASE_CONFIG } from "./configs/base";
import { SETTINGS_CONFIG } from "./configs/settings";
import type {
  AgentBaseConfig,
  AgentHost,
  AgentSettingsConfig,
  ResolvedModel,
} from "./types";

function normalizeIdList(input: unknown): number[] {
  if (!Array.isArray(input)) return [];
  return Array.from(
    new Set(
      input
        .map((item) => Math.floor(Number(item)))
        .filter((id) => Number.isFinite(id) && id > 0),
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

    const refreshBase = async () => {
      cachedBase = mergeAgentConfig(
        BASE_CONFIG,
        (await configService?.getConfig("agent", "base")) ?? {},
      );
      if (!Array.isArray(cachedBase.access.users)) cachedBase.access.users = [];
    };
    const refreshSettings = async () => {
      cachedSettings = mergeAgentConfig(
        SETTINGS_CONFIG,
        (await configService?.getConfig("agent", "settings")) ?? {},
      );
    };
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

    const resolveModel = (): ResolvedModel | null => {
      const getByRole = (role: AIModelRole) =>
        aiService.getInstanceByRole?.(role) ?? aiService.get?.(role);
      const main = getByRole("main") ?? aiService.getDefault?.();
      if (!main) return null;
      const working = getByRole("working") ?? main;
      const vision = getByRole("vision") ?? working;
      const bindings = aiService.getRoleBindings?.() ?? {
        main: undefined,
        working: undefined,
        vision: undefined,
      };
      const models = aiService.listModels?.() ?? [];
      const instanceName = (instance: AIInstance): string | undefined => {
        const name = (instance as { name?: unknown }).name;
        return typeof name === "string" ? name : undefined;
      };
      const pickModel = (full: string | undefined, instance: AIInstance) => {
        if (full && full.includes("/")) {
          return full.split("/").slice(1).join("/");
        }
        const name = instanceName(instance);
        const info = aiService
          .listInstances?.()
          ?.find((item) => item.role === name || item.name === name);
        return info?.modelId ?? "";
      };

      const overrideFullId = String(cachedBase.model ?? "").trim();
      const overrideDesc = overrideFullId
        ? models.find((item) => item.id === overrideFullId)
        : undefined;
      let instance = main;
      let model = pickModel(bindings.main, main) || "";
      if (overrideDesc) {
        model = overrideDesc.modelId;
        const info = aiService
          .listInstances?.()
          ?.find((item) => item.providerId === overrideDesc.providerId);
        const candidate = info ? aiService.get?.(info.name) : undefined;
        if (candidate) instance = candidate;
      } else if (overrideFullId) {
        model = overrideFullId.includes("/")
          ? overrideFullId.split("/").slice(1).join("/")
          : overrideFullId;
      }

      const workingModel = pickModel(bindings.working, working) || model;
      const visionModel = pickModel(bindings.vision, vision) || workingModel;
      const visionDesc =
        models.find((item) => item.id === bindings.vision) ||
        models.find((item) => item.modelId === visionModel);
      const isMultimodal =
        visionDesc?.capabilities?.includes("vision") ?? Boolean(visionModel);
      const mainDesc =
        overrideDesc ||
        models.find((item) => item.id === bindings.main) ||
        models.find((item) => item.modelId === model);
      return {
        instance,
        model,
        working,
        workingModel,
        vision,
        visionModel,
        isMultimodal,
        contextWindow: mainDesc?.contextWindow ?? 0,
      };
    };

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
      workspaceRoot: (userId: number) =>
        workspaceRootFor(cachedBase.workspaceDir, userId),
      isAllowed: async (userId: number) => {
        const owners = (ctx.config.owners ?? []).map(Number);
        if (owners.includes(userId)) return true;
        if (
          cachedBase.access.allowAdmins &&
          (ctx.config.admins ?? []).map(Number).includes(userId)
        ) {
          return true;
        }
        return normalizeIdList(cachedBase.access.users).includes(userId);
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
    ctx.handle("message", createMessageHandler(host));

    const resolved = resolveModel();
    ctx.logger.info(
      `agent 插件加载成功 (model=${resolved ? resolved.model : "?"}, level=${cachedBase.permissionLevel})`,
    );

    return () => {
      approvals.dispose();
      db.close();
      ctx.logger.info("agent 插件已卸载");
    };
  },
});
