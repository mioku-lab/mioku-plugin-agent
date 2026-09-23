import * as fs from "node:fs";
import type { AITool } from "mioku";
import type { AgentPermissionLevel, BashConfig } from "../types";
import type { ApprovalManager } from "./approval";
import type { FsPolicy } from "./perm";
import { bashRequiresApproval } from "./perm";

const OUTPUT_MAX_CHARS = 20_000;
const MIN_TIMEOUT_MS = 1_000;

export interface BashApprovalNotice {
  id: string;
  command: string;
  cwd: string;
  level: AgentPermissionLevel;
  purpose: string;
  reason?: string;
}

export interface BashRunNotice {
  command: string;
  cwd: string;
  level: AgentPermissionLevel;
  purpose: string;
  reason?: string;
}

export interface BashRunResult {
  exitCode: number | null;
  timedOut: boolean;
  error?: string;
  stdout?: string;
  stderr?: string;
}

export interface BashReporter {
  /** 需要用户审批时立即通知，任何模式都不延迟。 */
  approval(notice: BashApprovalNotice): Promise<void>;
  /** 即将自动执行：full 模式攒进操作流水，其余模式立即通知。 */
  announce(notice: BashRunNotice): Promise<void>;
  /** 执行结束：full 模式下写入本回合的操作流水，在最终回复前合并转发。 */
  record(
    notice: BashRunNotice,
    result: BashRunResult,
    startedAt: number,
  ): void;
}

interface BashToolDeps {
  userId: string;
  policy: FsPolicy;
  config: BashConfig;
  approvals: ApprovalManager;
  reporter: BashReporter;
  assessRisk?: (
    command: string,
    purpose: string,
  ) => Promise<{
    dangerous: boolean;
    reason: string;
  }>;
}

interface ExecResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

const UNIX_SHELL_CANDIDATES = [
  "/bin/bash",
  "/usr/bin/bash",
  "/usr/local/bin/bash",
  "/bin/sh",
];

let unixShell: string | null = null;

function resolveUnixShell(): string {
  if (unixShell) return unixShell;
  const candidates = [process.env.SHELL, ...UNIX_SHELL_CANDIDATES];
  unixShell =
    candidates.find(
      (candidate): candidate is string =>
        typeof candidate === "string" &&
        candidate.length > 0 &&
        fs.existsSync(candidate),
    ) ?? "sh";
  return unixShell;
}

function shellInvocation(command: string): string[] {
  if (process.platform === "win32") {
    const comspec = process.env.ComSpec || process.env.COMSPEC || "cmd.exe";
    return [comspec, "/d", "/s", "/c", command];
  }
  return [resolveUnixShell(), "-c", command];
}

function shellName(): string {
  if (process.platform === "win32") return "cmd.exe";
  return resolveUnixShell();
}

function shellHint(): string {
  if (process.platform === "win32") {
    return "Windows cmd.exe syntax (e.g. dir, type, copy). Do not use bash-only syntax.";
  }
  return "POSIX shell syntax (bash/sh).";
}

async function execShell(
  command: string,
  cwd: string,
  timeoutMs: number,
): Promise<ExecResult> {
  fs.mkdirSync(cwd, { recursive: true });
  const proc = Bun.spawn(shellInvocation(command), {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });
  let timedOut = false;
  const timer = setTimeout(
    () => {
      timedOut = true;
      proc.kill();
    },
    Math.max(MIN_TIMEOUT_MS, timeoutMs),
  );
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  clearTimeout(timer);
  return {
    exitCode,
    stdout: stdout.slice(0, OUTPUT_MAX_CHARS),
    stderr: stderr.slice(0, OUTPUT_MAX_CHARS),
    timedOut,
  };
}

export function createBashTool(deps: BashToolDeps): AITool {
  const { userId, policy, config, approvals, reporter } = deps;
  return {
    name: "bash",
    description:
      `Execute a shell command with ${shellName()} (${shellHint()}). ` +
      "Always pass `purpose`: a short human-readable reason for running this command, shown to the user. " +
      (bashRequiresApproval(policy.level)
        ? `Runs in ${policy.level} mode: each command requires explicit user approval in the chat before execution. Working directory is the workspace (${policy.workspaceRoot}).`
        : policy.level === "auto"
          ? `Runs in auto mode: commands execute without asking first, but every command is reviewed by the working model and destructive ones still require the user's approval. Working directory is the workspace (${policy.workspaceRoot}).`
          : policy.level === "yolo"
            ? `Runs in yolo mode without approval and without notifying the user. Working directory defaults to the workspace (${policy.workspaceRoot}).`
            : `Runs in full mode without approval; every command and its purpose is collected and reported to the user as one merged record after the turn. Working directory defaults to the workspace (${policy.workspaceRoot}).`),
    parameters: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: `The shell command to execute (${shellName()}, ${shellHint()})`,
        },
        purpose: {
          type: "string",
          description:
            "Short reason for this command (what it does and why), shown to the user for approval/notification",
        },
        timeout_ms: {
          type: "number",
          description: "Timeout in milliseconds (default from config)",
        },
      },
      required: ["command", "purpose"],
    },
    handler: async (args: Record<string, unknown>) => {
      const command = String(args?.command ?? "").trim();
      if (!command) return { error: "command must be a non-empty string" };
      const purpose = String(args?.purpose ?? "").trim();
      if (!purpose) {
        return {
          error:
            "purpose must be a non-empty string: describe what this command does and why it is needed",
        };
      }
      if (!config.enabled) {
        return { error: "bash execution is disabled in agent settings" };
      }

      const verdict = bashRequiresApproval(policy.level)
        ? {
            dangerous: true,
            reason: `${policy.level} 模式下每条命令都需要审批`,
          }
        : deps.assessRisk
          ? await deps.assessRisk(command, purpose)
          : { dangerous: false, reason: "" };

      const notice: BashRunNotice = {
        command,
        cwd: policy.workspaceRoot,
        level: policy.level,
        purpose,
        reason: verdict.reason,
      };

      if (verdict.dangerous) {
        const { approval, promise } = approvals.create(
          {
            userId,
            command,
            cwd: policy.workspaceRoot,
            level: policy.level,
            purpose,
            reason: verdict.reason,
          },
          config.approvalTimeoutMs,
        );
        await reporter
          .approval({
            id: approval.id,
            command: approval.command,
            cwd: approval.cwd,
            level: approval.level,
            purpose: approval.purpose,
            reason: approval.reason,
          })
          .catch(() => {});
        const approved = await promise;
        if (!approved) {
          return {
            success: false,
            error:
              "The user denied the command (or the approval request timed out). Do not retry the same command; adjust the plan or ask the user.",
          };
        }
      } else {
        await reporter.announce(notice).catch(() => {});
      }

      const timeoutMs = Math.max(
        MIN_TIMEOUT_MS,
        Math.floor(Number(args?.timeout_ms) || config.timeoutMs),
      );
      const startedAt = Date.now();
      try {
        const result = await execShell(
          command,
          policy.workspaceRoot,
          timeoutMs,
        );
        reporter.record(notice, result, startedAt);
        if (result.timedOut) {
          return {
            success: false,
            error: `Command timed out after ${timeoutMs}ms and was killed.`,
            stdout: result.stdout,
            stderr: result.stderr,
          };
        }
        return {
          exitCode: result.exitCode,
          stdout: result.stdout,
          stderr: result.stderr,
        };
      } catch (err) {
        reporter.record(
          notice,
          { exitCode: null, timedOut: false, error: String(err) },
          startedAt,
        );
        return { error: `Failed to execute command: ${err}` };
      }
    },
  };
}
