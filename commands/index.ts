import type { AIUsageRecordSummary, MessageEvent } from "mioku";
import type { AgentHost } from "../types";
import type { SessionPlanItem } from "../db";
import { maybeCompact } from "../core/compaction";
import { generateSessionTitle } from "../core/title";
import { stopAgentTurn } from "../core/loop";
import { PERMISSION_LEVELS } from "../tools/perm";

const CLEAR_CONFIRM_TTL_MS = 60_000;

const resumeListCache = new Map<
  number,
  { generations: number[]; at: number }
>();
const pendingClear = new Map<number, number>();

async function reply(event: MessageEvent, text: string): Promise<void> {
  await event.reply(text, true);
}

async function requireUser(
  host: AgentHost,
  event: MessageEvent,
): Promise<number> {
  const userId = Number(event.user_id || event.sender?.user_id || 0);
  if (!userId) {
    await reply(event, "agent 命令需要在 QQ 私聊中使用");
  }
  return userId;
}

function formatTime(ts: number): string {
  const date = new Date(ts);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function sessionLabel(session: {
  title: string;
  sessionId: string;
  updatedAt: number;
  messageCount?: number;
}): string {
  const title = session.title || "(未命名)";
  const count =
    session.messageCount !== undefined ? `，${session.messageCount} 条` : "";
  return `${title}（${formatTime(session.updatedAt)}${count}）`;
}

async function backgroundTitle(
  host: AgentHost,
  sessionId: string,
): Promise<void> {
  const title = await generateSessionTitle(host, sessionId);
  host.db.setSessionMeta(sessionId, { title });
  host.logger.info(`[agent] session ${sessionId} titled: ${title}`);
}

function cachedResumable(host: AgentHost, userId: number): number[] {
  const cached = resumeListCache.get(userId);
  if (cached && Date.now() - cached.at < 5 * 60_000) return cached.generations;
  const current = host.sessions.sessionId(userId);
  const generations = host.sessions
    .resumableSessions(userId, current)
    .map((session) => session.generation);
  resumeListCache.set(userId, { generations, at: Date.now() });
  return generations;
}

function invalidateResumeCache(userId: number): void {
  resumeListCache.delete(userId);
}

function parsePlanItems(text: string): SessionPlanItem[] {
  return text
    .split("\n")
    .map((line) => line.replace(/^\s*(?:\d+[.、)]|[-*])\s*/, "").trim())
    .filter(Boolean)
    .map((content) => ({ content, status: "pending" as const }));
}

function renderPlan(items: SessionPlanItem[]): string {
  const marker: Record<string, string> = {
    pending: "[ ]",
    in_progress: "[~]",
    completed: "[x]",
  };
  return items
    .map(
      (item, index) =>
        `${index + 1}. ${marker[item.status] ?? "[ ]"} ${item.content}`,
    )
    .join("\n");
}

function buildUsageLines(host: AgentHost, sessionId: string): string[] {
  const records: AIUsageRecordSummary[] =
    host.aiService.getUsageRecords?.({ sessionId, limit: 200 }) ?? [];
  if (records.length === 0) {
    return ["- Token：本会话暂无请求记录"];
  }
  const okRecords = records.filter((record) => record.success);
  if (okRecords.length === 0) {
    return ["- Token：本会话暂无成功请求"];
  }
  const totalInput = okRecords.reduce(
    (sum, record) => sum + record.inputTokens,
    0,
  );
  const totalOutput = okRecords.reduce(
    (sum, record) => sum + record.outputTokens,
    0,
  );
  const totalDuration = okRecords.reduce(
    (sum, record) => sum + record.durationMs,
    0,
  );
  const last = okRecords[0];
  const lastSpeed =
    last.durationMs > 0 ? (last.outputTokens / last.durationMs) * 1000 : 0;
  const avgSpeed = totalDuration > 0 ? (totalOutput / totalDuration) * 1000 : 0;

  const lines = [
    `- Token 速度：上次 ~${lastSpeed.toFixed(1)} tok/s / 平均 ~${avgSpeed.toFixed(1)} tok/s（${okRecords.length} 次请求）`,
    `- 会话 Token：累计 ~${(totalInput + totalOutput).toLocaleString()}（输入 ~${totalInput.toLocaleString()} / 输出 ~${totalOutput.toLocaleString()}）`,
  ];

  const resolved = host.resolveModel();
  if (resolved && resolved.contextWindow > 0) {
    const contextTokens = last.inputTokens + last.outputTokens;
    const percent = ((contextTokens / resolved.contextWindow) * 100).toFixed(1);
    lines.push(
      `- 上下文占用：~${contextTokens.toLocaleString()} / ${resolved.contextWindow.toLocaleString()} tokens（${percent}%，按最近一次请求）`,
    );
  }
  return lines;
}

export function registerCommands(host: AgentHost): void {
  const { ctx } = host;

  ctx.command({
    name: "agent-approve",
    match: /^\.?agent\s+(approve|deny)(?:\s+([A-Za-z0-9_]+))?$/i,
    prefixes: false,
    permission: "master",
    description: "批准或拒绝 agent 的命令执行审批",
    usage: ".agent approve / .agent deny",
    handler: async ({ event, match }) => {
      const userId = await requireUser(host, event);
      if (!userId) return;
      const action = String(match?.[1] ?? "").toLowerCase();
      const id = String(match?.[2] ?? "").trim();
      const approved = action === "approve";

      if (!id) {
        const approval = host.approvals.resolveLatest(userId, approved);
        await reply(
          event,
          approval
            ? `${approved ? "已批准" : "已拒绝"}`
            : "当前没有待审批的请求。",
        );
        return;
      }

      const resolved = host.approvals.resolve(id, approved);
      await reply(
        event,
        resolved ? (approved ? "已批准" : "已拒绝") : "没有找到对应的审批请求",
      );
    },
  });

  ctx.command({
    name: "agent-new",
    match: /^\.?agent\s+new$/i,
    prefixes: false,
    permission: "master",
    description: "已开启新会话",
    handler: async ({ event }) => {
      const userId = await requireUser(host, event);
      if (!userId) return;
      const oldSession = host.sessions.get(userId);
      const session = host.sessions.newSession(userId);
      invalidateResumeCache(userId);
      void backgroundTitle(host, oldSession.sessionId);
      await reply(event, `已开启新会话 ${session.sessionId}`);
    },
  });

  ctx.command({
    name: "agent-resume",
    match: /^\.?agent\s+resume(?:\s+(\d+))?$/i,
    prefixes: false,
    permission: "master",
    description: "列出/恢复后台会",
    usage: ".agent resume / .agent resume 1",
    handler: async ({ event, match }) => {
      const userId = await requireUser(host, event);
      if (!userId) return;
      const index = match?.[1] ? Number(match[1]) : undefined;

      if (index === undefined) {
        const current = host.sessions.get(userId);
        const sessions = host.sessions.resumableSessions(
          userId,
          current.sessionId,
        );
        if (sessions.length === 0) {
          await reply(
            event,
            "没有可恢复的后台会话，用 .agent new 开启新会话吧",
          );
          return;
        }
        resumeListCache.set(userId, {
          generations: sessions.map((session) => session.generation),
          at: Date.now(),
        });
        const lines = sessions.map((session, position) => {
          const marker = session.generation === current.generation ? " *" : "";
          return `${position + 1}. ${marker}${sessionLabel({
            title: session.title,
            sessionId: session.sessionId,
            updatedAt: session.updatedAt,
            messageCount: host.db.countMessages(session.sessionId),
          })}`;
        });
        await reply(
          event,
          ["后台会话：", ...lines, "", "用 .agent resume <序号> 恢复"].join(
            "\n",
          ),
        );
        return;
      }

      const generations = cachedResumable(host, userId);
      const generation = generations[index - 1];
      if (generation === undefined) {
        await reply(event, "序号不存在，先运行 .agent resume 查看列表");
        return;
      }
      const target = host.sessions.resume(userId, generation);
      if (!target) {
        invalidateResumeCache(userId);
        await reply(event, "该会话不存在，可能已被归档或删除");
        return;
      }
      await reply(
        event,
        `已切换到会话 ${target.sessionId}\n标题：${target.title || "(未命名)"}\n上下文与目标已随会话恢复`,
      );
    },
  });

  ctx.command({
    name: "agent-archive",
    match: /^\.?agent\s+archive(?:\s+(list|\d+))?$/i,
    prefixes: false,
    permission: "master",
    description: "归档会话",
    usage: ".agent archive / .agent archive list / .agent archive 1",
    handler: async ({ event, match }) => {
      const userId = await requireUser(host, event);
      if (!userId) return;
      const arg = match?.[1]?.toLowerCase();

      if (arg === "list") {
        const archived = host.db.listSessions(userId, { archived: true });
        if (archived.length === 0) {
          await reply(event, "还没有归档的会话。");
          return;
        }
        const lines = archived.map(
          (session, position) =>
            `${position + 1}. g${session.generation} ${sessionLabel({
              title: session.title,
              sessionId: session.sessionId,
              updatedAt: session.updatedAt,
              messageCount: host.db.countMessages(session.sessionId),
            })}`,
        );
        await reply(event, ["归档会话：", ...lines].join("\n"));
        return;
      }

      if (arg && /^\d+$/.test(arg)) {
        const current = host.sessions.get(userId);
        const sessions = host.sessions.resumableSessions(
          userId,
          current.sessionId,
        );
        const target = sessions[Number(arg) - 1];
        if (!target) {
          await reply(event, "序号不存在，先运行 .agent resume 查看列表");
          return;
        }
        host.db.setSessionMeta(target.sessionId, { archived: true });
        void backgroundTitle(host, target.sessionId);
        invalidateResumeCache(userId);
        await reply(event, `已归档：${target.title || target.sessionId}`);
        return;
      }

      const current = host.sessions.get(userId);
      host.db.setSessionMeta(current.sessionId, { archived: true });
      void backgroundTitle(host, current.sessionId);
      const session = host.sessions.newSession(userId);
      invalidateResumeCache(userId);
      await reply(event, `当前会话已归档,新会话：${session.sessionId}`);
    },
  });

  ctx.command({
    name: "agent-permission",
    match: /^\.?agent\s+permission(?:\s+(\S+))?$/i,
    prefixes: false,
    permission: "master",
    description: "查看或修改 agent 权限级别",
    usage: ".agent permission [级别]",
    handler: async ({ event, match }) => {
      await requireUser(host, event);
      const level = match?.[1]?.toLowerCase();
      if (!level) {
        const base = host.getBase();
        const writeScope =
          base.permissionLevel === "read-only"
            ? "禁止"
            : base.permissionLevel === "workspace-write"
              ? "仅工作区内"
              : "任意路径";
        const bashPolicy =
          base.permissionLevel === "read-only" ||
          base.permissionLevel === "workspace-write"
            ? "每条都要用户审批（.agent approve）"
            : base.permissionLevel === "auto"
              ? "自动执行，危险命令由工作模型判定后转用户审批"
              : base.permissionLevel === "yolo"
                ? "自动执行，不通知用户"
                : "自动执行，命令与用途会通知用户";
        await reply(
          event,
          [
            `当前权限级别：${base.permissionLevel}`,
            `- 文件写入：${writeScope}`,
            `- bash：${bashPolicy}`,
            "",
            `修改：.agent permission <${PERMISSION_LEVELS.join("|")}>`,
          ].join("\n"),
        );
        return;
      }
      if (!(PERMISSION_LEVELS as readonly string[]).includes(level)) {
        await reply(
          event,
          `未知级别 "${level}"，可选：${PERMISSION_LEVELS.join(" / ")}`,
        );
        return;
      }
      await host.updateBase({
        permissionLevel: level as (typeof PERMISSION_LEVELS)[number],
      });
      await reply(event, `权限级别已切换为 ${level}`);
    },
  });

  ctx.command({
    name: "agent-goal",
    match: /^\.?agent\s+goal(?:\s+([\s\S]+))?$/i,
    prefixes: false,
    permission: "master",
    description: "查看/设置/清除当前会话目标",
    usage: ".agent goal / .agent goal <目标> / .agent goal clear",
    handler: async ({ event, match }) => {
      const userId = await requireUser(host, event);
      if (!userId) return;
      const session = host.sessions.get(userId);
      const text = match?.[1]?.trim();
      if (!text) {
        await reply(
          event,
          session.goal
            ? `当前会话目标：\n${session.goal}`
            : "当前会话没有目标，用 .agent goal <目标> 设置。",
        );
        return;
      }
      if (text.toLowerCase() === "clear") {
        host.db.setSessionMeta(session.sessionId, { goal: "" });
        await reply(event, "会话目标已清除。");
        return;
      }
      host.db.setSessionMeta(session.sessionId, { goal: text });
      await reply(event, `会话目标已设置：\n${text}`);
    },
  });

  ctx.command({
    name: "agent-plan",
    match: /^\.?agent\s+plan(?:\s+([\s\S]+))?$/i,
    prefixes: false,
    permission: "master",
    description: "查看/设置/清除会话计划",
    usage: ".agent plan / .agent plan <每行一项> / .agent plan clear",
    handler: async ({ event, match }) => {
      const userId = await requireUser(host, event);
      if (!userId) return;
      const session = host.sessions.get(userId);
      const text = match?.[1]?.trim();
      if (!text) {
        if (session.plan.length === 0) {
          await reply(
            event,
            "当前会话没有计划，用 .agent plan <每行一项> 设置。",
          );
          return;
        }
        await reply(event, ["会话计划：", renderPlan(session.plan)].join("\n"));
        return;
      }
      if (text.toLowerCase() === "clear") {
        host.db.setSessionMeta(session.sessionId, { plan: [] });
        await reply(event, "会话计划已清除。");
        return;
      }
      const items = parsePlanItems(text);
      host.db.setSessionMeta(session.sessionId, { plan: items });
      await reply(event, ["会话计划已设置：", renderPlan(items)].join("\n"));
    },
  });

  ctx.command({
    name: "agent-reset",
    match: /^\.?agent\s+reset$/i,
    prefixes: false,
    permission: "master",
    description: "清空当前 agent 会话的上下文",
    handler: async ({ event }) => {
      const userId = await requireUser(host, event);
      if (!userId) return;
      const sessionId = host.sessions.sessionId(userId);
      host.sessions.reset(userId);
      await reply(event, `当前会话 ${sessionId} 的上下文已清空`);
    },
  });

  ctx.command({
    name: "agent-clear",
    match: /^\.?agent\s+clear(?:\s+(confirm|yes|确认))?$/i,
    prefixes: false,
    permission: "master",
    description: "清除该用户的全部保存会话",
    usage: ".agent clear / .agent clear confirm",
    handler: async ({ event, match }) => {
      const userId = await requireUser(host, event);
      if (!userId) return;
      const confirmed = String(match?.[1] ?? "").toLowerCase();

      if (!confirmed) {
        const sessions = host.db.listSessions(userId);
        if (sessions.length === 0) {
          await reply(event, "你还没有任何保存的 agent 会话。");
          return;
        }
        const messages = sessions.reduce(
          (total, session) => total + host.db.countMessages(session.sessionId),
          0,
        );
        pendingClear.set(userId, Date.now() + CLEAR_CONFIRM_TTL_MS);
        await reply(
          event,
          [
            `将删除你的全部 ${sessions.length} 个会话（含归档）、${messages} 条消息，以及运行记录与工具调用明细。`,
            "工作区文件不会被删除。",
            `确认请回复 .agent clear confirm（${CLEAR_CONFIRM_TTL_MS / 1000} 秒内有效）。`,
          ].join("\n"),
        );
        return;
      }

      const expiresAt = pendingClear.get(userId);
      pendingClear.delete(userId);
      if (!expiresAt || Date.now() > expiresAt) {
        await reply(
          event,
          "没有待确认的清除操作，或已超时。请先发送 .agent clear",
        );
        return;
      }

      invalidateResumeCache(userId);
      const removed = host.db.clearUserSessions(userId);
      await reply(
        event,
        [
          "已清除：",
          `- 会话 ${removed.sessions} 个`,
          `- 消息 ${removed.messages} 条`,
          `- 运行记录 ${removed.runs} 条 / 工具调用 ${removed.toolCalls} 条`,
        ].join("\n"),
      );
    },
  });

  ctx.command({
    name: "agent-stop",
    match: /^\.?agent\s+stop$/i,
    prefixes: false,
    permission: "master",
    description: "停止当前正在运行的会话",
    usage: ".agent stop",
    handler: async ({ event }) => {
      const userId = await requireUser(host, event);
      if (!userId) return;
      const result = stopAgentTurn(host, userId);
      const lines = [
        result.running ? "已请求停止当前会话。" : "当前没有正在运行的会话。",
      ];
      if (result.approvals > 0)
        lines.push(`已拒绝 ${result.approvals} 条待审批命令。`);
      if (result.dropped > 0)
        lines.push(`已丢弃 ${result.dropped} 条排队中的消息。`);
      await reply(event, lines.join("\n"));
    },
  });

  ctx.command({
    name: "agent-compact",
    match: /^\.?agent\s+compact$/i,
    prefixes: false,
    permission: "master",
    description: "立即压缩当前会话的较早上下文为摘要",
    handler: async ({ event }) => {
      const userId = await requireUser(host, event);
      if (!userId) return;
      await reply(event, "正在压缩会话上下文…");
      const result = await maybeCompact(host, userId, { force: true });
      await reply(
        event,
        result.compacted
          ? `压缩完成：${result.reason}，释放约 ${result.freedTokens} tokens。`
          : `未压缩：${result.reason}`,
      );
    },
  });

  ctx.command({
    name: "agent-status",
    match: /^\.?agent\s+status$/i,
    prefixes: false,
    permission: "master",
    description: "查看 agent 会话、权限、token 用量与运行状态",
    handler: async ({ event }) => {
      const userId = await requireUser(host, event);
      if (!userId) return;
      const base = host.getBase();
      const resolved = host.resolveModel();
      const session = host.sessions.get(userId);
      const shared = await host.getChatShared();
      const stats = host.db.getRunStats(userId);
      const pending = host.approvals.listByUser(userId);
      const history = host.sessions.history(session);
      const messageCount = host.db.countMessages(session.sessionId);
      const emotion = shared.emotion
        ? host.emotions.getCurrent(session.emotion, shared.emotion)
        : null;

      const lines = [
        `会话：${session.sessionId}${session.title ? `「${session.title}」` : ""}`,
        `- 消息：${messageCount} 条（摘要后 ${history.length} 条在上下文${session.summary ? "，含摘要" : ""}）`,
        `- 权限级别：${base.permissionLevel}`,
        `- 工作区：${host.workspaceRoot(userId)}`,
        `- 模型：${resolved ? resolved.model : "(未配置)"}${
          resolved?.isMultimodal ? "（多模态）" : ""
        }`,
        `- 情绪：${emotion ?? "无"}`,
      ];
      lines.push(...buildUsageLines(host, session.sessionId));
      lines.push(
        `- 历史运行：${stats.runs} 次 / 工具调用 ${stats.toolCalls} 次`,
        `- 目标：${session.goal ? session.goal.slice(0, 80) : "无"}`,
        `- 计划：${
          session.plan.length > 0
            ? `${session.plan.filter((item) => item.status === "completed").length}/${session.plan.length} 完成`
            : "无"
        }`,
        `- 待审批：${
          pending.length > 0
            ? pending
                .map(
                  (item) =>
                    `${item.command.slice(0, 40)}（用途：${item.purpose.slice(0, 40)}）`,
                )
                .join("; ")
            : "无"
        }`,
      );
      await reply(event, lines.join("\n"));
    },
  });
}
