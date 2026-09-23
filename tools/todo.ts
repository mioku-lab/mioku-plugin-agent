import type { AITool, Bot } from "mioku";
import type { AgentHost } from "../types";
import type { SessionPlanItem, SessionPlanStatus } from "../db";

const STATUSES: readonly SessionPlanStatus[] = [
  "pending",
  "in_progress",
  "completed",
];

const MAX_ITEMS = 50;

const MARKER: Record<SessionPlanStatus, string> = {
  pending: "[ ]",
  in_progress: "[~]",
  completed: "[x]",
};

const DESCRIPTION =
  "Record and update a structured task list for the current work. Send the ENTIRE list every call — it REPLACES the previous list (there are no partial updates, no per-item edits). " +
  "Use it to plan multi-step work and show progress: add one todo per concrete step before you start. " +
  "Keep AT MOST ONE todo `in_progress` at a time; while work remains, exactly one active task should be `in_progress`. " +
  "Mark a todo `completed` the moment it is done (do not batch completions), and allow no `in_progress` item only once all work is complete. " +
  "Skip the list for trivial single-step tasks. Statuses: `pending` (not started), `in_progress` (being worked on now), `completed` (finished). " +
  "Every update is pushed to the user in the chat, so keep items short and imperative.";

export function formatPlanText(items: SessionPlanItem[]): string {
  const count = (status: SessionPlanStatus) =>
    items.filter((item) => item.status === status).length;
  const summary = `${count("in_progress")} 进行中 · ${count("pending")} 待办 · ${count("completed")} 已完成`;
  return [
    `📋 任务清单已更新（${summary}）`,
    ...items.map(
      (item, index) => `${MARKER[item.status]} ${index + 1}. ${item.content}`,
    ),
  ].join("\n");
}

export function createTodoTool(options: {
  host: AgentHost;
  /** 会话隔离键 */
  userId: string;
  /** 平台原始用户 id,用于推送 */
  sendUserId: string;
  bot: Bot | undefined;
  /** yolo 模式：不推送清单，用户只看最终回复 */
  quiet?: boolean;
}): AITool {
  const { host, userId, sendUserId, bot, quiet } = options;
  return {
    name: "todo_write",
    description: DESCRIPTION,
    parameters: {
      type: "object",
      properties: {
        todos: {
          type: "array",
          description: "The COMPLETE task list, replacing any previous list",
          items: {
            type: "object",
            properties: {
              content: {
                type: "string",
                description: "What the task is — a short imperative line",
              },
              status: {
                type: "string",
                description: "pending (not started) | in_progress (now) | completed (done)",
              },
            },
            required: ["content", "status"],
          },
        },
      },
      required: ["todos"],
    },
    handler: async (args: Record<string, unknown>) => {
      const raw = args?.todos;
      if (!Array.isArray(raw)) return { error: "todos must be an array" };

      const items: SessionPlanItem[] = [];
      const seen = new Set<string>();
      for (const entry of raw) {
        if (!entry || typeof entry !== "object") {
          return { error: "each todo must be an object with content and status" };
        }
        const record = entry as Record<string, unknown>;
        const content = String(record.content ?? "").trim();
        if (!content) return { error: "todo content must be a non-empty string" };
        if (seen.has(content)) {
          return { error: `duplicate todo content: ${content}` };
        }
        seen.add(content);
        const status = String(record.status ?? "").trim() as SessionPlanStatus;
        if (!STATUSES.includes(status)) {
          return {
            error: `invalid status "${record.status}": use pending | in_progress | completed`,
          };
        }
        items.push({ content, status });
      }

      if (items.length > MAX_ITEMS) {
        return { error: `too many items (max ${MAX_ITEMS})` };
      }
      const inProgress = items.filter((item) => item.status === "in_progress");
      if (inProgress.length > 1) {
        return {
          error:
            "at most one todo may be in_progress; mark finished work completed before starting the next",
        };
      }

      const session = host.sessions.get(userId);
      host.db.setSessionMeta(session.sessionId, { plan: items });

      if (bot && !quiet) {
        await bot
          .sendMessage(
            { type: "private", user_id: sendUserId },
            [host.ctx.segment.text(formatPlanText(items))],
          )
          .catch((err) =>
            host.logger.warn(`[agent] failed to push todo update: ${err}`),
          );
      }

      return {
        success: true,
        todos: items,
        counts: {
          pending: items.filter((item) => item.status === "pending").length,
          inProgress: inProgress.length,
          completed: items.filter((item) => item.status === "completed").length,
        },
      };
    },
  };
}
