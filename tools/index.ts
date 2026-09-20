import type { AITool, Bot, SessionToolDefinition } from "mioku";
import type { AgentHost } from "../types";
import type { BashReporter } from "./bash";
import type { FsToolDeps } from "./fs";
import {
  createEditTool,
  createGlobTool,
  createGrepTool,
  createReadTool,
  createWriteTool,
} from "./fs";
import { createBashTool } from "./bash";
import { createSendFileTool, createSendImageTool } from "./deliver";
import { createViewImageTool } from "./view-image";
import { createWebFetchTool, createWebSearchTool } from "./web";
import { createTodoTool } from "./todo";
import {
  isAutoReviewMode,
  isQuietMode,
  normalizePermissionLevel,
  type FsPolicy,
} from "./perm";
import { describeImageFile } from "../core/media";
import { assessCommandRisk } from "../core/risk";
import type { TurnActivity } from "../core/activity";

export interface TurnToolOptions {
  userId: number;
  bot: Bot | undefined;
  runId: number;
  reporter: BashReporter;
  activity: TurnActivity;
}

function isToolError(result: unknown): boolean {
  if (!result || typeof result !== "object") return false;
  const record = result as Record<string, unknown>;
  return Boolean(record.error) || record.success === false;
}

function wrapTool(
  tool: AITool,
  host: AgentHost,
  runId: number,
  activity: TurnActivity,
): AITool {
  const recording = host.getSettings().dataCollection.enabled && runId > 0;
  const tracking = tool.name !== "bash";
  if (!recording && !tracking) return tool;
  return {
    ...tool,
    handler: async (args) => {
      const startedAt = Date.now();
      try {
        const result = await tool.handler(args);
        if (recording) {
          host.db.recordToolCall(
            runId,
            tool.name,
            args,
            JSON.stringify(result ?? {}).length,
            Date.now() - startedAt,
            !isToolError(result),
          );
        }
        if (tracking) {
          activity.recordTool(
            tool.name,
            args ?? {},
            result,
            Date.now() - startedAt,
          );
        }
        return result;
      } catch (err) {
        if (recording) {
          host.db.recordToolCall(
            runId,
            tool.name,
            args,
            0,
            Date.now() - startedAt,
            false,
            String(err),
          );
        }
        if (tracking) {
          activity.recordTool(
            tool.name,
            args ?? {},
            { error: String(err) },
            Date.now() - startedAt,
          );
        }
        throw err;
      }
    },
  };
}

export function buildTurnTools(
  host: AgentHost,
  options: TurnToolOptions,
): { tools: SessionToolDefinition[]; webSearchState: { count: number } } {
  const base = host.getBase();
  const settings = host.getSettings();
  const policy: FsPolicy = {
    level: normalizePermissionLevel(base.permissionLevel),
    workspaceRoot: host.workspaceRoot(options.userId),
  };
  const webSearchState = { count: 0 };
  const resolved = host.resolveModel();

  const fsDeps: FsToolDeps = { policy };

  const tools: AITool[] = [
    createReadTool(fsDeps),
    createGlobTool(fsDeps),
    createGrepTool(fsDeps),
    createSendFileTool({
      ctx: host.ctx,
      bot: options.bot,
      userId: options.userId,
      policy,
    }),
    createSendImageTool({
      ctx: host.ctx,
      bot: options.bot,
      userId: options.userId,
      policy,
    }),
  ];

  if (policy.level !== "read-only") {
    tools.push(createWriteTool(fsDeps), createEditTool(fsDeps));
  }
  if (resolved?.isMultimodal || resolved?.vision) {
    tools.push(
      createViewImageTool({
        policy,
        describeImage:
          !resolved.isMultimodal && resolved.vision
            ? (file: string) => describeImageFile(host, file)
            : undefined,
      }),
    );
  }
  if (settings.bash.enabled) {
    tools.push(
      createBashTool({
        userId: options.userId,
        policy,
        config: settings.bash,
        approvals: host.approvals,
        reporter: options.reporter,
        assessRisk: isAutoReviewMode(policy.level)
          ? (command, purpose) => assessCommandRisk(host, command, purpose)
          : undefined,
      }),
    );
  }
  if (settings.webSearch.enabled) {
    const searchTool = createWebSearchTool({
      settings,
      onSearch: () => {
        webSearchState.count += 1;
      },
    });
    tools.push(searchTool);
  }
  if (settings.webFetch.enabled) {
    tools.push(createWebFetchTool({ settings }));
  }
  tools.push(
    createTodoTool({
      host,
      userId: options.userId,
      bot: options.bot,
      quiet: isQuietMode(policy.level),
    }),
  );

  // TODO(skills): load chat-style external skills via aiService.registerSkill.
  // TODO(mcp): Model Context Protocol client for external tool servers.
  // TODO(memory): hybrid retrieval (vector + BM25 + rerank) via the shared knowledge-base service.

  return {
    tools: tools.map((tool) => ({
      name: tool.name,
      tool: wrapTool(tool, host, options.runId, options.activity),
    })),
    webSearchState,
  };
}
