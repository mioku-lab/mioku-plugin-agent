import type { AgentPermissionLevel } from "../types";

export interface PendingApproval {
  id: string;
  userId: number;
  command: string;
  cwd: string;
  level: AgentPermissionLevel;
  purpose: string;
  reason: string;
  createdAt: number;
}

interface PendingEntry extends PendingApproval {
  timer: ReturnType<typeof setTimeout>;
  resolve: (approved: boolean) => void;
}

export class ApprovalManager {
  private pending = new Map<string, PendingEntry>();
  private latestByUser = new Map<number, string>();
  private seq = 0;

  create(
    info: Omit<PendingApproval, "id" | "createdAt">,
    timeoutMs: number,
  ): { approval: PendingApproval; promise: Promise<boolean> } {
    const id = `bash_${Date.now().toString(36)}_${(this.seq++).toString(36)}`;
    const entry: PendingEntry = {
      ...info,
      id,
      createdAt: Date.now(),
      timer: setTimeout(() => this.resolve(id, false), Math.max(1, timeoutMs)),
      resolve: () => {},
    };
    const promise = new Promise<boolean>((resolvePromise) => {
      entry.resolve = resolvePromise;
    });
    this.pending.set(id, entry);
    this.latestByUser.set(info.userId, id);
    return { approval: entry, promise };
  }

  resolve(id: string, approved: boolean): boolean {
    const entry = this.pending.get(id);
    if (!entry) return false;
    clearTimeout(entry.timer);
    this.pending.delete(id);
    if (this.latestByUser.get(entry.userId) === id) {
      const next = this.latestFor(entry.userId);
      if (next) this.latestByUser.set(entry.userId, next);
      else this.latestByUser.delete(entry.userId);
    }
    entry.resolve(approved);
    return true;
  }

  resolveLatest(userId: number, approved: boolean): PendingApproval | null {
    const id = this.latestByUser.get(userId) ?? this.latestFor(userId);
    if (!id) return null;
    const entry = this.pending.get(id);
    if (!entry) return null;
    const approval = this.toPending(entry);
    this.resolve(id, approved);
    return approval;
  }

  latestByUserId(userId: number): PendingApproval | null {
    const id = this.latestByUser.get(userId) ?? this.latestFor(userId);
    const entry = id ? this.pending.get(id) : undefined;
    return entry ? this.toPending(entry) : null;
  }

  cancelByUser(userId: number): number {
    const ids = [...this.pending.values()]
      .filter((entry) => entry.userId === userId)
      .map((entry) => entry.id);
    for (const id of ids) this.resolve(id, false);
    return ids.length;
  }

  listByUser(userId: number): PendingApproval[] {
    return [...this.pending.values()]
      .filter((entry) => entry.userId === userId)
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((entry) => this.toPending(entry));
  }

  dispose(): void {
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.resolve(false);
      this.pending.delete(id);
    }
    this.latestByUser.clear();
  }

  private latestFor(userId: number): string | undefined {
    let latest: PendingEntry | undefined;
    for (const entry of this.pending.values()) {
      if (entry.userId !== userId) continue;
      if (!latest || entry.createdAt >= latest.createdAt) latest = entry;
    }
    return latest?.id;
  }

  private toPending(entry: PendingEntry): PendingApproval {
    return {
      id: entry.id,
      userId: entry.userId,
      command: entry.command,
      cwd: entry.cwd,
      level: entry.level,
      purpose: entry.purpose,
      reason: entry.reason,
      createdAt: entry.createdAt,
    };
  }
}
