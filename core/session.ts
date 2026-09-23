import type { AgentDatabase, AgentSessionRow } from "../db";

export class SessionManager {
  constructor(private db: AgentDatabase) {}

  generation(userId: string): number {
    return this.db.getUserGeneration(userId);
  }

  sessionId(userId: string): string {
    return `agent:${userId}:g${this.generation(userId)}`;
  }

  get(userId: string): AgentSessionRow {
    return this.db.getOrCreateSession(this.sessionId(userId), userId);
  }

  newSession(userId: string): AgentSessionRow {
    this.db.bumpUserGenerationTo(userId, this.db.maxGeneration(userId) + 1);
    return this.get(userId);
  }

  resume(userId: string, generation: number): AgentSessionRow | undefined {
    const target = this.db.getSessionByGeneration(userId, generation);
    if (!target) return undefined;
    this.db.bumpUserGenerationTo(userId, generation);
    return this.db.getOrCreateSession(target.sessionId, userId);
  }

  resumableSessions(userId: string, excludeSessionId: string): AgentSessionRow[] {
    return this.db
      .listSessions(userId, { archived: false })
      .filter((session) => session.sessionId !== excludeSessionId);
  }

  archive(userId: string, generation: number): AgentSessionRow | undefined {
    const target = this.db.getSessionByGeneration(userId, generation);
    if (!target) return undefined;
    this.db.setSessionMeta(target.sessionId, { archived: true });
    return this.db.getSessionByGeneration(userId, generation);
  }

  reset(userId: string): void {
    this.db.resetSession(this.sessionId(userId));
  }

  history(session: AgentSessionRow) {
    return this.db.getMessagesAfter(session.sessionId, session.summaryUpTo);
  }

  append(userId: string, role: "user" | "assistant", content: string): number {
    return this.db.appendMessage(this.sessionId(userId), role, content);
  }

  setEmotion(userId: string, emotion: string): void {
    this.db.setSessionMeta(this.sessionId(userId), { emotion });
  }
}
