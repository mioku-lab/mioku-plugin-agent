import * as fs from "node:fs";
import * as path from "node:path";
import type { AITool, Bot, MiokuContext } from "mioku";
import type { FsPolicy } from "./perm";
import { resolveWorkspacePath } from "./perm";
import { sendImageSource, sendLocalFile } from "../core/attachment";

interface DeliverToolDeps {
  ctx: MiokuContext;
  bot: Bot | undefined;
  userId: number;
  policy: FsPolicy;
}

export function createSendFileTool(deps: DeliverToolDeps): AITool {
  return {
    name: "send_file",
    description:
      "Send a local file to the user in the current private chat (documents, archives, generated artifacts).",
    parameters: {
      type: "object",
      properties: {
        file_path: { type: "string", description: "Local file path to send" },
        name: { type: "string", description: "Optional display file name" },
      },
      required: ["file_path"],
    },
    handler: async (args) => {
      const filePath = resolveWorkspacePath(deps.policy, String(args?.file_path ?? ""));
      if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
        return { error: `File not found: ${filePath}` };
      }
      if (!deps.bot) return { error: "bot is not connected" };
      const name = args?.name ? String(args.name) : path.basename(filePath);
      await sendLocalFile(
        deps.ctx,
        deps.bot,
        { type: "private", user_id: deps.userId },
        filePath,
        name,
      );
      return { success: true, file: filePath, name };
    },
  };
}

export function createSendImageTool(deps: DeliverToolDeps): AITool {
  return {
    name: "send_image",
    description:
      "Send a local image file to the user in the current private chat as a picture message.",
    parameters: {
      type: "object",
      properties: {
        file_path: { type: "string", description: "Local image path (png/jpg/webp/gif)" },
      },
      required: ["file_path"],
    },
    handler: async (args) => {
      const filePath = resolveWorkspacePath(deps.policy, String(args?.file_path ?? ""));
      if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
        return { error: `File not found: ${filePath}` };
      }
      if (!deps.bot) return { error: "bot is not connected" };
      const sent = await sendImageSource(
        deps.ctx,
        deps.bot,
        { type: "private", user_id: deps.userId },
        filePath,
      );
      if (!sent) return { error: `Failed to send image: ${filePath}` };
      return { success: true, file: filePath };
    },
  };
}
