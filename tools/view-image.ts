import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import type { AITool } from "mioku";
import { TOOL_RESULT_FOLLOWUP_KEY } from "mioku";
import { readImageDataUrl } from "../core/download";
import type { FsPolicy } from "./perm";
import { resolveWorkspacePath } from "./perm";

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const IMAGE_EXTENSIONS = [".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"];

export interface ViewImageDeps {
  policy: FsPolicy;
  describeImage?: (filePath: string) => Promise<string>;
}

export function createViewImageTool(deps: ViewImageDeps): AITool {
  return {
    name: "view_image",
    description:
      "View a local image file (png/jpeg/webp/gif/bmp) such as a screenshot or a downloaded photo. " +
      (deps.describeImage
        ? "The image is sent to the vision model and its description is returned."
        : "The image is attached to the conversation so you can inspect it directly."),
    parameters: {
      type: "object",
      properties: {
        file_path: {
          type: "string",
          description: "Image path (absolute, or relative to the workspace)",
        },
      },
      required: ["file_path"],
    },
    handler: async (args: Record<string, unknown>) => {
      const filePath = resolveWorkspacePath(
        deps.policy,
        String(args?.file_path ?? ""),
      );
      const ext = path.extname(filePath).toLowerCase();
      if (ext && !IMAGE_EXTENSIONS.includes(ext)) {
        return {
          error: `unsupported image type "${ext}": use ${IMAGE_EXTENSIONS.join(", ")}`,
        };
      }

      let stat: fs.Stats;
      try {
        stat = await fsp.stat(filePath);
      } catch {
        return { error: `File not found: ${filePath}` };
      }
      if (!stat.isFile()) return { error: `Not a regular file: ${filePath}` };
      if (stat.size > MAX_IMAGE_BYTES) {
        return {
          error: `Image too large (${stat.size} bytes, max ${MAX_IMAGE_BYTES})`,
        };
      }

      if (deps.describeImage) {
        const description = await deps
          .describeImage(filePath)
          .catch((err) => `describe failed: ${err}`);
        return { file: filePath, size: stat.size, description };
      }

      let dataUrl: string;
      try {
        dataUrl = await readImageDataUrl(filePath);
      } catch (err) {
        return { error: `Failed to read image: ${err}` };
      }
      return {
        file: filePath,
        size: stat.size,
        seen: true,
        [TOOL_RESULT_FOLLOWUP_KEY]: {
          text: `Image attached from ${filePath}.`,
          images: [{ url: dataUrl }],
        },
      };
    },
  };
}
