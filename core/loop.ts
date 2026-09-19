import * as fs from "node:fs";
import type {
  Bot,
  MessageEvent,
  MultimodalContentItem,
  SessionToolDefinition,
} from "mioku";
import type { AgentHost } from "../types";
import { buildTurnTools } from "../tools";
import { TurnSender } from "./send";
import { buildSystemPrompt } from "./prompt";
import { maybeCompact } from "./compaction";
import { cleanEmotionMarkers, stripThinkBlocks } from "./units";
import { describeImageUrls, extractMedia, formatMediaNote } from "./media";
import { downloadMediaItems, readImageDataUrl } from "./download";
import {
  normalizePermissionLevel,
  isQuietMode,
  type FsPolicy,
} from "../tools/perm";
import type { BashNotice } from "../tools/bash";

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

const queues = new Map<number, UserQueue>();

function getQueue(userId: number): UserQueue {
  let queue = queues.get(userId);
  if (!queue) {
    queue = { running: false, inbox: [], controller: null };
    queues.set(userId, queue);
  }
  return queue;
}

export function stopAgentTurn(
  host: AgentHost,
  userId: number,
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
  userId: number,
  queue: UserQueue,
): void {
  if (queue.running) return;
  const next = queue.inbox.shift();
  if (!next) return;
  queue.running = true;
  void drainTurns(host, event, userId, queue, next);
}

export function runAgentTurn(
  host: AgentHost,
  event: MessageEvent,
): Promise<void> {
  const userId = Number(event.user_id || event.sender?.user_id || 0);
  if (!userId) return Promise.resolve();
  const queue = getQueue(userId);

  // 先占住轮次再准备输入，保证消息按到达顺序处理
  const ownsTurn = !queue.running;
  if (ownsTurn) queue.running = true;

  return prepareInput(host, event, userId)
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
      return drainTurns(host, event, userId, queue, input);
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
  userId: number,
  queue: UserQueue,
  first: PreparedInput,
): Promise<void> {
  const controller = new AbortController();
  queue.controller = controller;
  try {
    let next: PreparedInput | undefined = first;
    while (next) {
      await executeTurn(host, event, userId, next, queue, controller.signal);
      next = queue.inbox.shift();
    }
  } finally {
    queue.controller = null;
    queue.running = false;
    kickQueue(host, event, userId, queue);
  }
}

async function prepareInput(
  host: AgentHost,
  event: MessageEvent,
  userId: number,
): Promise<PreparedInput | null> {
  const resolved = host.resolveModel();
  const bot = event.bot ?? host.ctx.pickBot(event.self_id);
  const media = extractMedia(event);
  const downloads = await downloadMediaItems(
    media,
    host.workspaceRoot(userId),
    {
      bot,
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
  userId: number,
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
  userId: number,
  input: PreparedInput,
  queue: UserQueue,
  abortSignal: AbortSignal,
): Promise<void> {
  const base = host.getBase();
  const settings = host.getSettings();
  const resolved = host.resolveModel();
  const bot: Bot | undefined = event.bot ?? host.ctx.pickBot(event.self_id);

  if (!resolved) {
    await replyError(host, bot, userId, "AI 服务不可用，请先在 WebUI 配置模型");
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

  const notifyBash = async (notice: BashNotice): Promise<void> => {
    if (!bot || isQuietMode(base.permissionLevel)) return;
    const detail = notice.reason ? `（${notice.reason}）` : "";
    const lines =
      notice.kind === "approval"
        ? [
            `Agent 请求执行命令（${notice.level}）：`,
            notice.command,
            `用途：${notice.purpose}`,
            `风险：${notice.reason || "需要审批"}`,
            "回复 .agent approve 批准，.agent deny 拒绝",
          ]
        : [
            `Agent 执行命令（${notice.level}）${detail}：`,
            notice.command,
            `用途：${notice.purpose}`,
          ];
    await bot.sendMessage({ type: "private", user_id: userId }, [
      host.ctx.segment.text(lines.join("\n")),
    ]);
  };

  try {
    host.logger.info(
      `[agent] turn start | user=${userId} session=${session.sessionId} model=${resolved.model} level=${base.permissionLevel} files=${input.attachments} text=${truncate(input.text, 120)}`,
    );

    fs.mkdirSync(host.workspaceRoot(userId), { recursive: true });
    await maybeCompact(host, userId);
    const sessionRow = host.sessions.get(userId);
    const priorHistory = host.sessions.history(sessionRow);

    const { tools, webSearchState } = buildTurnTools(host, {
      userId,
      bot,
      runId,
      notifyBash,
    });
    const guardedTools = guardWebSearch(
      tools,
      webSearchState,
      settings.webSearch.maxSearchCount,
    );

    const policy: FsPolicy = {
      level: normalizePermissionLevel(base.permissionLevel),
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
      userId,
      settings.enableMarkdownScreenshot && Boolean(host.screenshot),
    );
    const usageId = `agent:${sessionRow.sessionId}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
    const usageContext = {
      usageId,
      source: "agent",
      botId: Number(event?.self_id) || undefined,
      userId,
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
        onTextDelta: settings.stream
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

    if (settings.stream) {
      await sender.finishStream(finalText);
      if (!finalText.trim()) finalText = sender.streamedText;
    } else if (finalText.trim()) {
      await sender.sendText(finalText);
    }
    if (finalText.trim()) {
      host.sessions.append(userId, "assistant", finalText);
    }

    host.logger.info(
      `[agent] turn done | user=${userId} iterations=${iterations || "?"} tools=${toolCallCount} reply=${finalText.length}chars duration=${Date.now() - startedAt}ms`,
    );
  } catch (err) {
    status = "error";
    errorText = String(err);
    host.logger.error(`[agent] turn failed: ${err}`);
    await replyError(
      host,
      bot,
      userId,
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

async function replyError(
  host: AgentHost,
  bot: Bot | undefined,
  userId: number,
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
