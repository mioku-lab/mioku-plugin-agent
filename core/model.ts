import type { AIInstance, AIModelRole, AIService } from "mioku";
import type { ResolvedModel } from "../types";

const OVERRIDE_INSTANCE_PREFIX = "__agent_override_";

export interface ModelOverride {
  /** 覆盖模型的全 id（providerId/modelId） */
  key: string;
  instanceName: string;
}

export function splitModelFullId(
  fullId: string,
): { providerId: string; modelId: string } | null {
  const raw = String(fullId ?? "").trim();
  const index = raw.indexOf("/");
  if (index <= 0 || index >= raw.length - 1) return null;
  return { providerId: raw.slice(0, index), modelId: raw.slice(index + 1) };
}

function instanceName(instance: AIInstance | undefined): string | undefined {
  const name = (instance as { name?: unknown } | undefined)?.name;
  return typeof name === "string" && name ? name : undefined;
}

/** 在现有实例里找跑在指定提供商上的实例，同模型优先。 */
export function findInstanceByProvider(
  aiService: AIService,
  providerId: string,
  modelId?: string,
): { name: string; instance: AIInstance } | undefined {
  if (!providerId) return undefined;
  const infos = aiService.listInstances?.() ?? [];
  const info =
    (modelId
      ? infos.find(
          (item) => item.providerId === providerId && item.modelId === modelId,
        )
      : undefined) ?? infos.find((item) => item.providerId === providerId);
  if (!info) return undefined;
  const instance = aiService.get?.(info.name);
  return instance ? { name: info.name, instance } : undefined;
}

function overrideInstanceName(providerId: string, modelId: string): string {
  const slug = `${providerId}_${modelId}`.replace(/[^A-Za-z0-9_.-]+/g, "_");
  return `${OVERRIDE_INSTANCE_PREFIX}${slug}`;
}

/**
 * 覆盖模型必须跑在它自己的提供商上：实例固定绑定 provider，只改 model 会把别的
 * 提供商的模型名发给主提供商的 client。优先复用现成实例，否则建一个隐藏实例。
 */
export async function prepareModelOverride(
  aiService: AIService,
  fullId: string,
  warn: (message: string) => void,
): Promise<ModelOverride | undefined> {
  const parsed = splitModelFullId(fullId);
  if (!parsed) return undefined;
  const reused = findInstanceByProvider(
    aiService,
    parsed.providerId,
    parsed.modelId,
  );
  if (reused) return { key: fullId, instanceName: reused.name };
  const name = overrideInstanceName(parsed.providerId, parsed.modelId);
  if (aiService.get?.(name)) return { key: fullId, instanceName: name };
  if (!aiService.createInstance) {
    warn(`覆盖模型 ${fullId} 无法切换提供商：AI 服务不支持 createInstance`);
    return undefined;
  }
  try {
    await aiService.createInstance({
      name,
      providerId: parsed.providerId,
      modelId: parsed.modelId,
    });
    return { key: fullId, instanceName: name };
  } catch (err) {
    warn(`覆盖模型 ${fullId} 实例创建失败：${err}`);
    return undefined;
  }
}

export function resolveAgentModel(options: {
  aiService: AIService;
  overrideFullId: string;
  override?: ModelOverride;
}): ResolvedModel | null {
  const { aiService, overrideFullId, override } = options;
  const getByRole = (role: AIModelRole) =>
    aiService.getInstanceByRole?.(role) ?? aiService.get?.(role);
  const main = getByRole("main") ?? aiService.getDefault?.();
  if (!main) return null;

  const bindings = aiService.getRoleBindings?.() ?? {
    main: undefined,
    working: undefined,
    vision: undefined,
  };
  const instances = aiService.listInstances?.() ?? [];
  const models = aiService.listModels?.() ?? [];

  const modelIdOf = (
    full: string | undefined,
    instance: AIInstance,
  ): string => {
    if (full && full.includes("/")) return full.split("/").slice(1).join("/");
    const name = instanceName(instance);
    const info = instances.find(
      (item) => item.role === name || item.name === name,
    );
    return info?.modelId ?? "";
  };

  const overrideDesc = overrideFullId
    ? models.find((item) => item.id === overrideFullId)
    : undefined;
  const overrideParsed = splitModelFullId(overrideFullId);

  let instance = main;
  let model = modelIdOf(bindings.main, main);
  if (overrideFullId && overrideParsed) {
    const target =
      (override && override.key === overrideFullId
        ? aiService.get?.(override.instanceName)
        : undefined) ??
      findInstanceByProvider(
        aiService,
        overrideParsed.providerId,
        overrideParsed.modelId,
      )?.instance;
    if (target) {
      // 覆盖模型的提供商可达：用它的实例 + 它的模型
      instance = target;
      model = overrideDesc?.modelId ?? overrideParsed.modelId;
    }
    // 提供商不可达时退回主模型，绝不把别家的模型名发给主提供商的 client
  }

  let working = getByRole("working") ?? main;
  let workingModel = modelIdOf(bindings.working, working);
  if (!workingModel) {
    // 没有独立绑定的干活模型：跟随主模型，实例也要跟着换，否则模型与提供商错配
    working = instance;
    workingModel = model;
  }

  let vision = getByRole("vision") ?? working;
  let visionModel = modelIdOf(bindings.vision, vision);
  if (!visionModel) {
    vision = working;
    visionModel = workingModel;
  }

  const visionDesc =
    models.find((item) => item.id === bindings.vision) ||
    models.find((item) => item.modelId === visionModel);
  // 有覆盖时，直接吃图片的是覆盖模型，能力要以它为准
  const isMultimodal = overrideDesc
    ? (overrideDesc.capabilities?.includes("vision") ?? false)
    : (visionDesc?.capabilities?.includes("vision") ?? Boolean(visionModel));
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
}
