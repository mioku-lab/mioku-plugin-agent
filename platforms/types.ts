import type { Bot } from "mioku";

/** 需要按平台换取下载地址的附件引用 */
export interface PlatformFileRef {
  fileId: string;
  groupId?: string;
  userId?: string;
}

export interface PlatformFileLookup {
  sources: string[];
  names: string[];
}

export const EMPTY_FILE_LOOKUP: PlatformFileLookup = { sources: [], names: [] };

/** 把平台返回的原始结果合并成下载来源(各平台实现共用) */
export const mergeFileLookup = (
  target: PlatformFileLookup,
  result: unknown,
): void => {
  if (!result || typeof result !== "object") return;
  const record = result as Record<string, unknown>;
  for (const key of ["url", "file", "path"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      target.sources.push(value.trim());
    }
  }
  const base64 = record.base64 ?? record.data;
  if (typeof base64 === "string" && base64.trim()) {
    target.sources.push(`base64://${base64.trim()}`);
  }
  for (const key of ["file_name", "name"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      target.names.push(value.trim());
    }
  }
};

/**
 * 一个平台分支：自己订阅 `adapter:message` 路由，自己处理平台专有差异。
 * 新增平台只要加一个文件并登记到 `platforms/index.ts`。
 */
export interface AgentPlatform {
  /** 适配器名，与 `bot.adapter` 对应 */
  readonly adapter: string;
  /** 该分支订阅的事件路由，如 `onebotv11:message` */
  readonly route: string;
  /** 平台专有的 file_id → 下载来源；没有该能力时返回空 */
  resolveFile(bot: Bot, ref: PlatformFileRef): Promise<PlatformFileLookup>;
}
