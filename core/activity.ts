import type {
  ForwardSendNode,
  ForwardSendOptions,
  MessageSegment,
  MiokuContext,
} from "mioku";
import type { AgentPermissionLevel } from "../types";

export type ActivityKind = "bash" | "write" | "edit";

export interface ActivityEntry {
  kind: ActivityKind;
  title: string;
  purpose?: string;
  note?: string;
  output?: string;
  ok: boolean;
  durationMs: number;
}

export interface ActivityRecord {
  kind: ActivityKind;
  title: string;
  purpose?: string;
  note?: string;
  output?: string;
  ok?: boolean;
  durationMs?: number;
}

export interface BashActivityResult {
  exitCode: number | null;
  timedOut: boolean;
  error?: string;
  stdout?: string;
  stderr?: string;
}

const KIND_LABELS: Record<ActivityKind, string> = {
  bash: "命令",
  write: "写入",
  edit: "编辑",
};

const OUTPUT_EXCERPT = 240;

function truncate(text: string, max: number): string {
  const value = String(text ?? "").replace(/\s+/g, " ").trim();
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m${Math.round(seconds % 60)}s`;
}

function formatClock(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export class TurnActivity {
  private entries: ActivityEntry[] = [];
  private startedAt = Date.now();
  private subject = "";

  constructor(private enabled: boolean) {}

  setSubject(text: string): void {
    this.subject = truncate(text, 24);
  }

  record(input: ActivityRecord): void {
    if (!this.enabled) return;
    this.entries.push({
      kind: input.kind,
      title: truncate(input.title, 200) || "(未命名)",
      purpose: input.purpose ? truncate(input.purpose, 200) : undefined,
      note: input.note ? truncate(input.note, 200) : undefined,
      output: input.output,
      ok: input.ok ?? true,
      durationMs: input.durationMs ?? 0,
    });
  }

  recordTool(
    toolName: string,
    args: Record<string, unknown>,
    result: unknown,
    durationMs: number,
  ): void {
    if (!this.enabled) return;
    if (toolName !== "write" && toolName !== "edit") return;
    const record = (result ?? {}) as Record<string, unknown>;
    const detail = record.error
      ? `错误：${truncate(String(record.error), 160)}`
      : toolName === "write" && typeof record.bytes === "number"
        ? `${record.bytes} 字节`
        : toolName === "edit" && typeof record.replacements === "number"
          ? `${record.replacements} 处替换`
          : undefined;
    this.record({
      kind: toolName,
      title: String(args?.file_path ?? ""),
      note: detail,
      ok: !record.error && record.success !== false,
      durationMs,
    });
  }

  recordBash(
    notice: {
      command: string;
      level: AgentPermissionLevel;
      purpose: string;
      reason?: string;
    },
    result: BashActivityResult,
    startedAt: number,
  ): void {
    this.record({
      kind: "bash",
      title: notice.command,
      purpose: notice.purpose,
      note: notice.reason,
      output: bashOutput(result),
      ok: result.exitCode === 0 && !result.timedOut && !result.error,
      durationMs: Date.now() - startedAt,
    });
  }

  get total(): number {
    return this.entries.length;
  }

  get failureCount(): number {
    return this.entries.filter((entry) => !entry.ok).length;
  }

  private stats(): string {
    const counts = new Map<ActivityKind, number>();
    for (const entry of this.entries) {
      counts.set(entry.kind, (counts.get(entry.kind) ?? 0) + 1);
    }
    return [...counts.entries()]
      .map(([kind, count]) => `${KIND_LABELS[kind]} ${count}`)
      .join(" · ");
  }

  buildDisplay(): ForwardSendOptions {
    const failures = this.failureCount;
    return {
      source: "Agent 执行记录",
      news: [
        { text: `${this.total} 项操作` },
        ...(this.subject ? [{ text: this.subject }] : []),
      ],
      summary: [this.stats(), failures > 0 ? `失败 ${failures}` : "全部成功"]
        .filter(Boolean)
        .join(" · "),
    };
  }

  buildNodes(
    ctx: MiokuContext,
    userId: string,
    nickname: string,
  ): ForwardSendNode[] {
    const nodes: ForwardSendNode[] = [
      {
        user_id: userId,
        nickname,
        content: [ctx.segment.text(this.buildInfoText())],
      },
    ];
    for (const [index, entry] of this.entries.entries()) {
      nodes.push({
        user_id: userId,
        nickname,
        content: [ctx.segment.text(buildEntryText(entry, index + 1))],
      });
    }
    return nodes;
  }

  buildInfoText(): string {
    const failures = this.failureCount;
    return [
      "【Agent 执行记录】",
      `时间：${formatClock(new Date(this.startedAt))}`,
      `操作：${this.total} 项（${this.stats()}）`,
      `结果：${failures > 0 ? `失败 ${failures} 项` : "全部成功"}`,
      `耗时：${formatDuration(Date.now() - this.startedAt)}`,
      `简介：${this.subject ? `针对「${this.subject}」` : "本次任务"}按时间顺序执行了以下操作。`,
    ].join("\n");
  }

  buildFallbackSegments(ctx: MiokuContext): MessageSegment[] {
    const display = this.buildDisplay();
    const header = [
      display.source,
      display.news?.map((item) => item.text).join(" / "),
      display.summary,
    ]
      .filter(Boolean)
      .join("\n");
    const segments: MessageSegment[] = [ctx.segment.text(header)];
    for (const [index, entry] of this.entries.entries()) {
      segments.push(ctx.segment.text(buildEntryText(entry, index + 1)));
    }
    return segments;
  }
}

function buildEntryText(entry: ActivityEntry, index: number): string {
  const lines = [
    `[${index}] ${KIND_LABELS[entry.kind]} · ${entry.ok ? "成功" : "失败"} · ${formatDuration(entry.durationMs)}`,
    entry.title,
  ];
  if (entry.purpose) lines.push(`用途：${entry.purpose}`);
  if (entry.note) lines.push(`备注：${entry.note}`);
  if (entry.output) lines.push(entry.output);
  return lines.join("\n");
}

function bashOutput(result: BashActivityResult): string | undefined {
  if (result.error) return `错误：${truncate(result.error, OUTPUT_EXCERPT)}`;
  if (result.timedOut) return "超时：命令被强制结束";
  if (result.exitCode === 0) return undefined;
  const detail = `${result.stderr || ""}`.trim() || `${result.stdout || ""}`.trim();
  if (!detail) return `退出码：${result.exitCode}`;
  return `输出：${truncate(detail, OUTPUT_EXCERPT)}`;
}
