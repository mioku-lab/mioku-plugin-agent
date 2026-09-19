import * as path from "node:path";
import type { AgentPermissionLevel } from "../types";

export const PERMISSION_LEVELS: readonly AgentPermissionLevel[] = [
  "read-only",
  "workspace-write",
  "auto",
  "full",
  "yolo",
];

export function normalizePermissionLevel(value: unknown): AgentPermissionLevel {
  const raw = String(value ?? "")
    .trim()
    .toLowerCase();
  if ((PERMISSION_LEVELS as readonly string[]).includes(raw)) {
    return raw as AgentPermissionLevel;
  }
  return "workspace-write";
}

export interface FsPolicy {
  level: AgentPermissionLevel;
  workspaceRoot: string;
}

export function workspaceRootFor(baseDir: string, userId: number): string {
  const raw = String(baseDir ?? "").trim();
  const base =
    raw && path.isAbsolute(raw)
      ? raw
      : path.resolve(
          process.cwd(),
          raw || path.join("data", "agent", "workspace"),
        );
  return path.resolve(base, String(userId));
}

export function resolveWorkspacePath(policy: FsPolicy, target: string): string {
  const rawPath = String(target ?? "").trim();
  if (!rawPath) throw new Error("path must be a non-empty string");
  if (path.isAbsolute(rawPath)) return path.resolve(rawPath);
  return path.resolve(policy.workspaceRoot, rawPath);
}

export function isInside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

export function canWrite(policy: FsPolicy, target: string): boolean {
  if (policy.level === "read-only") return false;
  if (policy.level === "workspace-write") {
    return isInside(policy.workspaceRoot, target);
  }
  return true;
}

export function bashRequiresApproval(level: AgentPermissionLevel): boolean {
  return level === "read-only" || level === "workspace-write";
}

export function isAutoReviewMode(level: AgentPermissionLevel): boolean {
  return level === "auto";
}

export function isQuietMode(level: AgentPermissionLevel): boolean {
  return level === "yolo";
}

export function permissionDenied(
  policy: FsPolicy,
  operation: string,
  target: string,
): Error {
  const scope =
    policy.level === "read-only"
      ? "the session is read-only"
      : `writes are restricted to the workspace (${policy.workspaceRoot})`;
  return new Error(
    `[permission denied] Cannot ${operation} ${target}: ${scope}.`,
  );
}
