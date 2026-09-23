import * as fs from "node:fs";
import type {
  Bot,
  MessageEvent,
  MultimodalContentItem,
  SessionToolDefinition,
} from "mioku";
import { UnsupportedCapabilityError } from "mioku";
import type { AgentHost } from "../types";
import { buildTurnTools } from "../tools";
import { TurnSender } from "./send";
import { buildSystemPrompt } from "./prompt";
import { maybeCompact } from "./compaction";
import { cleanEmotionMarkers, stripThinkBlocks } from "./units";
import { identityOf, type AgentIdentity } from "./identity";
import type { AgentPlatform } from "../platforms/types";
import { describeImageUrls, extractMedia, formatMediaNote } from "./media";
import { downloadMediaItems, readImageDataUrl } from "./download";
import { TurnActivity } from "./activity";
import {
  normalizePermissionLevel,
  batchesActivity,
  isQuietMode,
  type FsPolicy,
} from "../tools/perm";
import type { BashReporter } from "../tools/bash";

interface AgentChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | MultimodalContentItem[];
  tool_call_id?: string;
}

interface PreparedInput {
  messageId: string;
  text: string;
  content: string | MultimodalContentItem[];
  attachments: number;
}

interface UserQueue {
  running: boolean;
  inbox: PreparedInput[];
  controller: AbortController | null;
}

const queues = new Map<string, UserQueue>();

function getQueue(userId: string): UserQueue {
  let queue = queues.get(userId);
  if (!queue) {
    queue = { running: false, inbox: [], controller: null };
    queues.set(userId, queue);
  }
  return queue;
}

export function stopAgentTurn(
  host: AgentHost,
  userId: string,
): { running: boolean; dropped: number; approvals: number } {
  const queue = queues.get(userId);
  const dropped = queue?.inbox.length ?? 0;
  if (queue) queue.inbox.length = 0;
  const approvals = host.approvals.cancelByUser(userId);
  const running = Boolean(queue?.running && queue.controller);
  queue?.controller?.abort();
  host.logger.info(
    `[agent] stop requested | user=${userId} running=${running} dropped=${dropped} approvals=${approvals}`,
  );
  return { running, dropped, approvals };
}

function kickQueue(
  host: AgentHost,
  event: MessageEvent,
  userId: string,
  queue: UserQueue,
): void {
  if (queue.running) return;
  const next = queue.inbox.shift();
  if (!next) return;
  queue.running = true;
  void drainTurns(host, event, identityOf(event), queue, next);
}

export function runAgentTurn(
  host: AgentHost,
  event: MessageEvent,
  platform: AgentPlatform,
): Promise<void> {
  const identity = identityOf(event);
  if (!identity.userId) return Promise.resolve();
  const userId = identity.scope;
  const queue = getQueue(userId);

  // 先占住轮次再准备输入，保证消息按到达顺序处理
  const ownsTurn = !queue.running;
  if (ownsTurn) queue.running = true;

  return prepareInput(host, event, identity, platform)
    .then((input) => {
      if (!input) {
        if (ownsTurn) {
          queue.running = false;
          kickQueue(host, event, userId, queue);
        }
        return;
      }
      if (!ownsTurn) {
        queue.inbox.push(input);
        host.logger.info(
          `[agent] steer queued | user=${userId} text=${truncate(input.text, 120)}`,
        );
        // prepareInput 期间上一轮可能刚好结束，这里补一次启动，避免消息被丢
        kickQueue(host, event, userId, queue);
        return;
      }
      return drainTurns(host, event, identity, queue, input);
    })
    .catch((err) => {
      if (ownsTurn) {
        queue.running = false;
        kickQueue(host, event, userId, queue);
      }
      host.logger.error(`[agent] turn dispatch failed: ${err}`);
    });
}

async function drainTurns(
  host: AgentHost,
  event: MessageEvent,
  identity: AgentIdentity,
  queue: UserQueue,
  first: PreparedInput,
): Promise<void> {
  const controller = new AbortController();
  queue.controller = controller;
  try {
    let next: PreparedInput | undefined = first;
    while (next) {
      await executeTurn(host, event, identity, next, queue, controller.signal);
      next = queue.inbox.shift();
    }
  } finally {
    queue.controller = null;
    queue.running = false;
    kickQueue(host, event, identity.scope, queue);
  }
}

async function prepareInput(
  host: AgentHost,
  event: MessageEvent,
  identity: AgentIdentity,
  platform: AgentPlatform,
): Promise<PreparedInput | null> {
  const resolved = host.resolveModel();
  const bot = event.bot ?? host.ctx.pickBot(event.self_id);
  const media = extractMedia(event);
  const downloads = await downloadMediaItems(
    media,
    host.workspaceRoot(identity.scope),
    {
      bot,
      platform,
    },
  ).catch((err) => {
    host.logger.warn(`[agent] attachment download failed: ${err}`);
    return { dir: "", files: [], errors: [String(err)] };
  });

  const imageFiles = downloads.files.filter((item) => item.kind === "image");
  const attachSources: string[] = [];
  const describeSources: string[] = [];
  for (const item of imageFiles) {
    if (item.remoteUrl) attachSources.push(item.remoteUrl);
    try {
      const dataUrl = await readImageDataUrl(item.path);
      describeSources.push(dataUrl);
      if (!item.remoteUrl) attachSources.push(dataUrl);
    } catch (err) {
      host.logger.warn(`[agent] failed to read downloaded image: ${err}`);
      if (item.remoteUrl) describeSources.push(item.remoteUrl);
    }
  }

  let text = host.ctx.text(event) || "";
  if (resolved && !resolved.isMultimodal && describeSources.length > 0) {
    const description = await describeImageUrls(host, describeSources);
    if (description) {
      text = `[The user sent ${describeSources.length} image(s). Image description: ${description}]\n\n${text}`;
    }
  }
  const note = formatMediaNote(downloads.files, downloads.errors);
  if (!text.trim()) text = note ? "(sent file)" : "";
  if (!text.trim()) return null;
  if (note) text = `${text}\n\n${note}`;

  const messageId = String(event.message_id ?? "");
  const header = `[User message]${messageId ? ` message_id=${messageId}` : ""}`;
  const content: string | MultimodalContentItem[] =
    resolved?.isMultimodal && attachSources.length > 0
      ? [
          { type: "text", text: `${header}\n${text}` },
          ...attachSources.map(
            (url): MultimodalContentItem => ({
              type: "image_url",
              image_url: { url, detail: "auto" },
            }),
          ),
        ]
      : `${header}\n${text}`;

  return {
    messageId,
    text,
    content,
    attachments: downloads.files.length,
  };
}

function steeringMessages(
  host: AgentHost,
  userId: string,
  queue: UserQueue,
): AgentChatMessage[] {
  if (queue.inbox.length === 0) return [];
  const pending = queue.inbox.splice(0, queue.inbox.length);
  for (const item of pending) {
    host.sessions.append(userId, "user", item.text);
  }
  host.logger.info(
    `[agent] steer merged into running turn | user=${userId} count=${pending.length}`,
  );
  return pending.map((item) => ({
    role: "user" as const,
    content: steeringContent(item),
  }));
}

function steeringContent(
  item: PreparedInput,
): string | MultimodalContentItem[] {
  const notice =
    "[User message sent while you were still working — read it and address it before finishing]";
  if (typeof item.content === "string") {
    return `${notice}\n${item.content}`;
  }
  const [first, ...rest] = item.content;
  const firstText = first && first.type === "text" ? (first.text ?? "") : "";
  return [{ type: "text", text: `${notice}\n${firstText}` }, ...rest];
}

async function executeTurn(
  host: AgentHost,
  event: MessageEvent,
  identity: AgentIdentity,
  input: PreparedInput,
  queue: UserQueue,
  abortSignal: AbortSignal,
): Promise<void> {
  const userId = identity.scope;
  const sendUserId = identity.userId;
  const base = host.getBase();
  const settings = host.getSettings();
  const resolved = host.resolveModel();
  const bot: Bot | undefined = event.bot ?? host.ctx.pickBot(event.self_id);
  const level = normalizePermissionLevel(base.permissionLevel);
  const digestMode = batchesActivity(level);
  const activity = new TurnActivity(digestMode);

  if (!resolved) {
    await replyError(host, bot, sendUserId, "AI 服务不可用，请先在 WebUI 配置模型");
    return;
  }

  const session = host.sessions.get(userId);
  const shared = await host.getChatShared();
  const persona = shared.persona;
  const currentEmotion = host.emotions.getCurrent(
    session.emotion,
    shared.emotion,
  );
  const runId = settings.dataCollection.enabled
    ? host.db.startRun(session.sessionId, userId, resolved.model)
    : 0;
  const startedAt = Date.now();
  let iterations = 0;
  let toolCallCount = 0;
  let status: "ok" | "error" = "ok";
  let errorText = "";
  activity.setSubject(input.text);

  const sendToUser = async (text: string): Promise<void> => {
    if (!bot) return;
    await bot.sendMessage({ type: "private", user_id: sendUserId }, [
      host.ctx.segment.text(text),
    ]);
  };

  const reporter: BashReporter = {
    approval: async (notice) => {
      if (!bot || isQuietMode(level)) return;
      await sendToUser(
        [
          `Agent 请求执行命令（${notice.level}）：`,
          notice.command,
          `用途：${notice.purpose}`,
          `风险：${notice.reason || "需要审批"}`,
          "回复 .agent approve 批准，.agent deny 拒绝",
        ].join("\n"),
      );
    },
    announce: async (notice) => {
      if (!bot || isQuietMode(level) || digestMode) return;
      const detail = notice.reason ? `（${notice.reason}）` : "";
      await sendToUser(
        [
          `Agent 执行命令（${notice.level}）${detail}：`,
          notice.command,
          `用途：${notice.purpose}`,
        ].join("\n"),
      );
    },
    record: (notice, result, execStartedAt) => {
      activity.recordBash(notice, result, execStartedAt);
    },
  };

  try {
    host.logger.info(
      `[agent] turn start | user=${userId} session=${session.sessionId} model=${resolved.model} level=${level} files=${input.attachments} text=${truncate(input.text, 120)}`,
    );

    fs.mkdirSync(host.workspaceRoot(userId), { recursive: true });
    await maybeCompact(host, userId);
    const sessionRow = host.sessions.get(userId);
    const priorHistory = host.sessions.history(sessionRow);

    const { tools, webSearchState } = buildTurnTools(host, {
      userId,
      sendUserId,
      bot,
      runId,
      reporter,
      activity,
    });
    const guardedTools = guardWebSearch(
      tools,
      webSearchState,
      settings.webSearch.maxSearchCount,
    );

    const policy: FsPolicy = {
      level,
      workspaceRoot: host.workspaceRoot(userId),
    };
    const systemPrompt = buildSystemPrompt({
      persona,
      replyStyle: shared.replyStyle,
      base,
      settings,
      policy,
      currentEmotion,
      emotion: shared.emotion,
      toolNames: guardedTools.map((item) => item.name),
      goal: sessionRow.goal,
      plan: sessionRow.plan,
    });

    const messages: AgentChatMessage[] = [
      { role: "system", content: systemPrompt },
    ];
    if (sessionRow.summary) {
      messages.push({
        role: "system",
        content: `## Conversation Summary (older context)\n${sessionRow.summary}`,
      });
    }
    for (const message of priorHistory) {
      messages.push({ role: message.role, content: message.content });
    }
    messages.push({ role: "user", content: input.content });
    host.sessions.append(userId, "user", input.text);

    if (settings.debug) {
      host.logger.info("[agent] === System Prompt ===");
      host.logger.info(systemPrompt);
      host.logger.info("[agent] === Request Messages ===");
      for (const message of messages) {
        host.logger.info(
          `[agent] [${message.role}] ${describeMessageContent(message.content)}`,
        );
      }
      host.logger.info("[agent] === End Request Messages ===");
    }

    const sender = new TurnSender(
      host,
      bot,
      sendUserId,
      settings.enableMarkdownScreenshot && Boolean(host.screenshot),
    );
    const usageId = `agent:${sessionRow.sessionId}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
    const usageContext = {
      usageId,
      source: "agent",
      botId: identity.botId || undefined,
      userId: sendUserId,
      sessionId: sessionRow.sessionId,
    };

    const runComplete = () =>
      resolved.instance.complete({
        model: resolved.model,
        messages,
        temperature: settings.temperature,
        maxIterations: settings.maxIterations,
        stream: settings.stream,
        executableToolsProvider: () => guardedTools,
        steeringProvider: () => steeringMessages(host, userId, queue),
        abortSignal,
        onTextDelta:
          settings.stream && !digestMode
            ? (delta) => sender.onDelta(delta)
            : undefined,
        usageContext,
      });
    const response = resolved.instance.withUsageContext
      ? await resolved.instance.withUsageContext(usageContext, runComplete)
      : await runComplete();

    iterations = Number(response.iterations ?? 0);
    toolCallCount = response.allToolCalls?.length ?? 0;

    if (response.stopped) {
      host.logger.info(
        `[agent] turn stopped by user | user=${userId} iterations=${iterations}`,
      );
      return;
    }

    if (settings.debug) {
      host.logger.info("[agent] === Raw AI Reply ===");
      host.logger.info(response.content || "(empty)");
      if (response.reasoning) {
        host.logger.info(`[agent] reasoning: ${response.reasoning}`);
      }
      for (const call of response.allToolCalls ?? []) {
        host.logger.info(
          `[agent] tool call: ${call.name}(${JSON.stringify(call.arguments ?? {}).slice(0, 300)})`,
        );
        host.logger.info(
          `[agent] tool result: ${call.name} -> ${JSON.stringify(call.result ?? null).slice(0, 500)}`,
        );
      }
      host.logger.info("[agent] === End Raw AI Reply ===");
    }

    let finalText = stripThinkBlocks(response.content || "");
    const { text: cleanedText, emotion } = cleanEmotionMarkers(finalText);
    finalText = cleanedText;
    if (emotion) {
      const nextEmotion = host.emotions.setEmotion(
        userId,
        emotion,
        shared.emotion,
      );
      if (settings.debug) {
        host.logger.info(`[agent] emotion -> ${nextEmotion}`);
      }
    }

    // 批量模式：把本回合的全部操作合并成一条转发记录，放在最终回复之前
    await flushActivity(host, activity, bot, sendUserId, event);

    if (settings.stream && !digestMode) {
      await sender.finishStream(finalText);
      if (!finalText.trim()) finalText = sender.streamedText;
    } else if (finalText.trim()) {
      await sender.sendText(finalText);
    }
    if (finalText.trim()) {
      host.sessions.append(userId, "assistant", finalText);
    }

    host.logger.info(
      `[agent] turn done | user=${userId} iterations=${iterations || "?"} tools=${toolCallCount} ops=${activity.total} reply=${finalText.length}chars duration=${Date.now() - startedAt}ms`,
    );
  } catch (err) {
    status = "error";
    errorText = String(err);
    host.logger.error(`[agent] turn failed: ${err}`);
    await flushActivity(host, activity, bot, sendUserId, event);
    await replyError(
      host,
      bot,
      sendUserId,
      `Agent 处理出错：${errorText.slice(0, 300)}`,
    );
  } finally {
    if (runId > 0) {
      host.db.finishRun(
        runId,
        status,
        iterations,
        toolCallCount,
        Date.now() - startedAt,
        errorText,
      );
    }
  }
}

function truncate(text: string, max: number): string {
  const value = String(text ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function describeMessageContent(
  content: string | MultimodalContentItem[],
): string {
  if (typeof content === "string") return content;
  return content
    .map((part) =>
      part.type === "text" ? String(part.text ?? "") : `[${String(part.type)}]`,
    )
    .join(" ");
}

function guardWebSearch(
  tools: SessionToolDefinition[],
  state: { count: number },
  maxSearchCount: number,
): SessionToolDefinition[] {
  if (maxSearchCount <= 0) return tools;
  return tools.map((definition) => {
    if (definition.name !== "web_search") return definition;
    return {
      name: definition.name,
      tool: {
        ...definition.tool,
        handler: async (args: Record<string, unknown>) => {
          if (state.count >= maxSearchCount) {
            return {
              success: false,
              error: `web_search limit (${maxSearchCount}) reached for this conversation. Answer from what you already found instead of searching again.`,
            };
          }
          return definition.tool.handler(args);
        },
      },
    };
  });
}

async function flushActivity(
  host: AgentHost,
  activity: TurnActivity,
  bot: Bot | undefined,
  userId: string,
  event: MessageEvent,
): Promise<void> {
  if (!bot || activity.total === 0) return;
  const target = { type: "private" as const, user_id: userId };
  const selfId = String(event.self_id || bot.bot_id || userId);
  const nickname = bot.nickname ?? "Agent";
  const nodes = activity.buildNodes(host.ctx, selfId, nickname);
  try {
    await bot.sendForward(target, nodes, activity.buildDisplay());
    host.logger.info(
      `[agent] activity digest sent | user=${userId} nodes=${nodes.length}`,
    );
    return;
  } catch (err) {
    if (!(err instanceof UnsupportedCapabilityError)) {
      host.logger.warn(`[agent] forward digest failed, falling back: ${err}`);
    }
  }
  try {
    await bot.sendMessage(target, activity.buildFallbackSegments(host.ctx));
  } catch (err) {
    host.logger.warn(`[agent] activity digest fallback failed: ${err}`);
  }
}

async function replyError(
  host: AgentHost,
  bot: Bot | undefined,
  userId: string,
  text: string,
): Promise<void> {
  if (!bot) return;
  try {
    await bot.sendMessage({ type: "private", user_id: userId }, [
      host.ctx.segment.text(text),
    ]);
  } catch {
    host.logger.warn(`[agent] failed to deliver error message to ${userId}`);
  }
}
