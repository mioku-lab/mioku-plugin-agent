import type { AgentDatabase, AgentSessionRow } from "../db";

export class SessionManager {
  constructor(private db: AgentDatabase) {}

  generation(userId: number): number {
    return this.db.getUserGeneration(userId);
  }

  sessionId(userId: number): string {
    return `agent:${userId}:g${this.generation(userId)}`;
  }

  get(userId: number): AgentSessionRow {
    return this.db.getOrCreateSession(this.sessionId(userId), userId);
  }

  newSession(userId: number): AgentSessionRow {
    this.db.bumpUserGenerationTo(userId, this.db.maxGeneration(userId) + 1);
    return this.get(userId);
  }

  resume(userId: number, generation: number): AgentSessionRow | undefined {
    const target = this.db.getSessionByGeneration(userId, generation);
    if (!target) return undefined;
    this.db.bumpUserGenerationTo(userId, generation);
    return this.db.getOrCreateSession(target.sessionId, userId);
  }

  resumableSessions(userId: number, excludeSessionId: string): AgentSessionRow[] {
    return this.db
      .listSessions(userId, { archived: false })
      .filter((session) => session.sessionId !== excludeSessionId);
  }

  archive(userId: number, generation: number): AgentSessionRow | undefined {
    const target = this.db.getSessionByGeneration(userId, generation);
    if (!target) return undefined;
    this.db.setSessionMeta(target.sessionId, { archived: true });
    return this.db.getSessionByGeneration(userId, generation);
  }

  reset(userId: number): void {
    this.db.resetSession(this.sessionId(userId));
  }

  history(session: AgentSessionRow) {
    return this.db.getMessagesAfter(session.sessionId, session.summaryUpTo);
  }

  append(userId: number, role: "user" | "assistant", content: string): number {
    return this.db.appendMessage(this.sessionId(userId), role, content);
  }

  setEmotion(userId: number, emotion: string): void {
    this.db.setSessionMeta(this.sessionId(userId), { emotion });
  }
}
