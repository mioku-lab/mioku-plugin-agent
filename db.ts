import { Database } from "bun:sqlite";
import { ensureDataDir } from "mioku";
import * as path from "node:path";

type SqlRow = Record<string, unknown>;

function rowNumber(
  row: SqlRow | null | undefined,
  key: string,
  fallback: number,
): number {
  const value = Number(row?.[key]);
  return Number.isFinite(value) ? value : fallback;
}

function rowString(row: SqlRow, key: string, fallback = ""): string {
  const value = row[key];
  return typeof value === "string" ? value : fallback;
}

/** id 列可能是 TEXT(openid)也可能是 INTEGER 亲和存下的数字,统一转字符串 */
function rowId(row: SqlRow | null | undefined, key: string, fallback = ""): string {
  const value = row?.[key];
  if (value == null) return fallback;
  const text = String(value);
  return text.length > 0 ? text : fallback;
}

export type SessionPlanStatus = "pending" | "in_progress" | "completed";

export interface SessionPlanItem {
  content: string;
  status: SessionPlanStatus;
}

export interface AgentSessionRow {
  sessionId: string;
  userId: string;
  generation: number;
  emotion: string;
  summary: string;
  summaryUpTo: number;
  title: string;
  archived: boolean;
  goal: string;
  plan: SessionPlanItem[];
  createdAt: number;
  updatedAt: number;
}

export interface AgentMessageRow {
  id: number;
  sessionId: string;
  role: "user" | "assistant";
  content: string;
  createdAt: number;
}

export interface AgentRunRow {
  id: number;
  sessionId: string;
  userId: string;
  model: string;
  status: "ok" | "error";
  iterations: number;
  toolCallCount: number;
  durationMs: number;
  error: string;
  startedAt: number;
}

export interface AgentToolCallRow {
  id: number;
  runId: number;
  name: string;
  args: string;
  resultChars: number;
  durationMs: number;
  ok: number;
  error: string;
  createdAt: number;
}

export interface ClearSessionsResult {
  sessions: number;
  messages: number;
  runs: number;
  toolCalls: number;
}

export class AgentDatabase {
  private db: Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.run("PRAGMA journal_mode = WAL;");
    this.migrate();
  }

  private migrate(): void {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS sessions (
        session_id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        generation INTEGER NOT NULL DEFAULT 0,
        emotion TEXT NOT NULL DEFAULT '',
        summary TEXT NOT NULL DEFAULT '',
        summary_up_to INTEGER NOT NULL DEFAULT 0,
        title TEXT NOT NULL DEFAULT '',
        archived INTEGER NOT NULL DEFAULT 0,
        goal TEXT NOT NULL DEFAULT '',
        plan TEXT NOT NULL DEFAULT '[]',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS user_state (
        user_id TEXT PRIMARY KEY,
        generation INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, id);
      CREATE TABLE IF NOT EXISTS runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        model TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'ok',
        iterations INTEGER NOT NULL DEFAULT 0,
        tool_call_count INTEGER NOT NULL DEFAULT 0,
        duration_ms INTEGER NOT NULL DEFAULT 0,
        error TEXT NOT NULL DEFAULT '',
        started_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS tool_calls (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id INTEGER NOT NULL,
        name TEXT NOT NULL,
        args TEXT NOT NULL DEFAULT '',
        result_chars INTEGER NOT NULL DEFAULT 0,
        duration_ms INTEGER NOT NULL DEFAULT 0,
        ok INTEGER NOT NULL DEFAULT 1,
        error TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL
      );
    `);
    this.#widenLegacyIdColumns();
  }

  /**
   * 旧库的 user_state.user_id 是 INTEGER PRIMARY KEY(rowid 别名),
   * 写入 openid 会直接抛 SQLiteError: datatype mismatch,这里重建成 TEXT。
   */
  #widenLegacyIdColumns(): void {
    const info = this.db
      .query("PRAGMA table_info(user_state)")
      .all() as Array<{ name?: string; type?: string }>;
    const column = info.find((item) => item.name === "user_id");
    if (!column || String(column.type ?? "").toUpperCase() === "TEXT") return;

    this.db.run("BEGIN");
    try {
      this.db.run("ALTER TABLE user_state RENAME TO user_state_legacy");
      this.db.run(`
        CREATE TABLE user_state (
          user_id TEXT PRIMARY KEY,
          generation INTEGER NOT NULL DEFAULT 0,
          updated_at INTEGER NOT NULL
        );
        INSERT INTO user_state (user_id, generation, updated_at)
          SELECT CAST(user_id AS TEXT), generation, updated_at FROM user_state_legacy;
        DROP TABLE user_state_legacy;
      `);
      this.db.run("COMMIT");
    } catch (err) {
      this.db.run("ROLLBACK");
      throw err;
    }
  }

  getUserGeneration(userId: string): number {
    const row = this.db
      .query("SELECT generation FROM user_state WHERE user_id = ?")
      .get(userId) as SqlRow | null;
    return rowNumber(row, "generation", 0);
  }

  maxGeneration(userId: string): number {
    const row = this.db
      .query("SELECT MAX(generation) AS max FROM sessions WHERE user_id = ?")
      .get(userId) as SqlRow | null;
    return rowNumber(row, "max", -1);
  }

  bumpUserGenerationTo(userId: string, generation: number): void {
    this.db.run(
      `INSERT INTO user_state (user_id, generation, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET generation = ?, updated_at = ?`,
      [userId, generation, Date.now(), generation, Date.now()],
    );
  }

  getOrCreateSession(sessionId: string, userId: string): AgentSessionRow {
    const now = Date.now();
    this.db.run(
      `INSERT INTO sessions (session_id, user_id, generation, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET updated_at = ?`,
      [sessionId, userId, parseGeneration(sessionId), now, now, now],
    );
    const row = this.db
      .query("SELECT * FROM sessions WHERE session_id = ?")
      .get(sessionId) as SqlRow | null;
    return toSessionRow(row ?? {});
  }

  getSessionByGeneration(
    userId: string,
    generation: number,
  ): AgentSessionRow | undefined {
    const row = this.db
      .query("SELECT * FROM sessions WHERE user_id = ? AND generation = ?")
      .get(userId, generation) as SqlRow | null;
    return row ? toSessionRow(row) : undefined;
  }

  listSessions(
    userId: string,
    options: { archived?: boolean } = {},
  ): AgentSessionRow[] {
    const rows = options.archived === undefined
      ? (this.db
          .query("SELECT * FROM sessions WHERE user_id = ? ORDER BY updated_at DESC")
          .all(userId) as SqlRow[])
      : (this.db
          .query(
            "SELECT * FROM sessions WHERE user_id = ? AND archived = ? ORDER BY updated_at DESC",
          )
          .all(userId, options.archived ? 1 : 0) as SqlRow[]);
    return rows.map(toSessionRow);
  }

  setSessionMeta(
    sessionId: string,
    patch: {
      title?: string;
      archived?: boolean;
      goal?: string;
      plan?: SessionPlanItem[];
      emotion?: string;
      summary?: string;
      summaryUpTo?: number;
    },
  ): void {
    const sets: string[] = [];
    const values: Array<string | number | null> = [];
    if (patch.title !== undefined) {
      sets.push("title = ?");
      values.push(patch.title);
    }
    if (patch.archived !== undefined) {
      sets.push("archived = ?");
      values.push(patch.archived ? 1 : 0);
    }
    if (patch.goal !== undefined) {
      sets.push("goal = ?");
      values.push(patch.goal);
    }
    if (patch.plan !== undefined) {
      sets.push("plan = ?");
      values.push(JSON.stringify(patch.plan));
    }
    if (patch.emotion !== undefined) {
      sets.push("emotion = ?");
      values.push(patch.emotion);
    }
    if (patch.summary !== undefined || patch.summaryUpTo !== undefined) {
      sets.push("summary = COALESCE(?, summary)");
      sets.push("summary_up_to = COALESCE(?, summary_up_to)");
      values.push(patch.summary ?? null, patch.summaryUpTo ?? null);
    }
    if (sets.length === 0) return;
    sets.push("updated_at = ?");
    values.push(Date.now(), sessionId);
    this.db.run(`UPDATE sessions SET ${sets.join(", ")} WHERE session_id = ?`, values);
  }

  touchSession(sessionId: string): void {
    this.db.run("UPDATE sessions SET updated_at = ? WHERE session_id = ?", [
      Date.now(),
      sessionId,
    ]);
  }

  setEmotion(sessionId: string, emotion: string): void {
    this.db.run("UPDATE sessions SET emotion = ? WHERE session_id = ?", [
      emotion,
      sessionId,
    ]);
  }

  setSummary(sessionId: string, summary: string, upTo: number): void {
    this.db.run(
      "UPDATE sessions SET summary = ?, summary_up_to = ? WHERE session_id = ?",
      [summary, upTo, sessionId],
    );
  }

  appendMessage(sessionId: string, role: "user" | "assistant", content: string): number {
    const now = Date.now();
    const result = this.db
      .query(
        "INSERT INTO messages (session_id, role, content, created_at) VALUES (?, ?, ?, ?)",
      )
      .run(sessionId, role, content, now);
    this.touchSession(sessionId);
    return Number(result.lastInsertRowid);
  }

  getMessagesAfter(sessionId: string, afterId: number): AgentMessageRow[] {
    const rows = this.db
      .query(
        "SELECT * FROM messages WHERE session_id = ? AND id > ? ORDER BY id ASC",
      )
      .all(sessionId, afterId) as SqlRow[];
    return rows.map((row) => ({
      id: rowNumber(row, "id", 0),
      sessionId: rowString(row, "session_id"),
      role: rowString(row, "role") === "assistant" ? "assistant" : "user",
      content: rowString(row, "content"),
      createdAt: rowNumber(row, "created_at", 0),
    }));
  }

  countMessages(sessionId: string): number {
    const row = this.db
      .query("SELECT COUNT(*) AS count FROM messages WHERE session_id = ?")
      .get(sessionId) as SqlRow | null;
    return rowNumber(row, "count", 0);
  }

  resetSession(sessionId: string): void {
    this.db.run("DELETE FROM messages WHERE session_id = ?", [sessionId]);
    this.db.run(
      "UPDATE sessions SET summary = '', summary_up_to = 0, emotion = '', updated_at = ? WHERE session_id = ?",
      [Date.now(), sessionId],
    );
  }

  /** 删除该用户的全部会话（含归档）及其消息、运行记录与工具调用明细。 */
  clearUserSessions(userId: string): ClearSessionsResult {
    const ids = this.listSessions(userId).map((session) => session.sessionId);
    const result: ClearSessionsResult = {
      sessions: ids.length,
      messages: 0,
      runs: 0,
      toolCalls: 0,
    };

    if (ids.length > 0) {
      const marks = ids.map(() => "?").join(", ");
      result.messages = this.countRows(
        "messages",
        `session_id IN (${marks})`,
        ids,
      );
      result.runs = this.countRows("runs", "user_id = ?", [userId]);
      result.toolCalls = this.countRows(
        "tool_calls",
        "run_id IN (SELECT id FROM runs WHERE user_id = ?)",
        [userId],
      );

      this.db.run(
        "DELETE FROM tool_calls WHERE run_id IN (SELECT id FROM runs WHERE user_id = ?)",
        [userId],
      );
      this.db.run("DELETE FROM runs WHERE user_id = ?", [userId]);
      this.db.run(`DELETE FROM messages WHERE session_id IN (${marks})`, ids);
      this.db.run("DELETE FROM sessions WHERE user_id = ?", [userId]);
    }
    this.db.run("DELETE FROM user_state WHERE user_id = ?", [userId]);
    return result;
  }

  private countRows(
    table: "messages" | "runs" | "tool_calls",
    where: string,
    params: Array<string | number>,
  ): number {
    const row = this.db
      .query(`SELECT COUNT(*) AS count FROM ${table} WHERE ${where}`)
      .get(...params) as SqlRow | null;
    return rowNumber(row, "count", 0);
  }

  startRun(sessionId: string, userId: string, model: string): number {
    const result = this.db
      .query(
        "INSERT INTO runs (session_id, user_id, model, started_at) VALUES (?, ?, ?, ?)",
      )
      .run(sessionId, userId, model, Date.now());
    return Number(result.lastInsertRowid);
  }

  finishRun(
    runId: number,
    status: "ok" | "error",
    iterations: number,
    toolCallCount: number,
    durationMs: number,
    error = "",
  ): void {
    this.db.run(
      "UPDATE runs SET status = ?, iterations = ?, tool_call_count = ?, duration_ms = ?, error = ? WHERE id = ?",
      [status, iterations, toolCallCount, durationMs, error, runId],
    );
  }

  recordToolCall(
    runId: number,
    name: string,
    args: unknown,
    resultChars: number,
    durationMs: number,
    ok: boolean,
    error = "",
  ): void {
    this.db
      .query(
        "INSERT INTO tool_calls (run_id, name, args, result_chars, duration_ms, ok, error, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        runId,
        name,
        JSON.stringify(args ?? {}).slice(0, 4000),
        resultChars,
        durationMs,
        ok ? 1 : 0,
        error.slice(0, 2000),
        Date.now(),
      );
  }

  getRunStats(userId: string): { runs: number; toolCalls: number } {
    const runRow = this.db
      .query("SELECT COUNT(*) AS count FROM runs WHERE user_id = ?")
      .get(userId) as SqlRow | null;
    const toolRow = this.db
      .query(
        "SELECT COUNT(*) AS count FROM tool_calls tc JOIN runs r ON tc.run_id = r.id WHERE r.user_id = ?",
      )
      .get(userId) as SqlRow | null;
    return {
      runs: rowNumber(runRow, "count", 0),
      toolCalls: rowNumber(toolRow, "count", 0),
    };
  }

  close(): void {
    this.db.close();
  }
}

export async function initDatabase(): Promise<AgentDatabase> {
  const dir = ensureDataDir("agent");
  return new AgentDatabase(path.join(dir, "agent.db"));
}

function parseGeneration(sessionId: string): number {
  const match = /:g(\d+)$/.exec(sessionId);
  return match ? Number(match[1]) : 0;
}

function toSessionRow(row: SqlRow): AgentSessionRow {
  let plan: SessionPlanItem[] = [];
  try {
    const parsed = JSON.parse(rowString(row, "plan", "[]"));
    if (Array.isArray(parsed)) plan = parsed;
  } catch {
    plan = [];
  }
  const sessionId = rowString(row, "session_id");
  return {
    sessionId,
    userId: rowId(row, "user_id"),
    generation: rowNumber(row, "generation", parseGeneration(sessionId)),
    emotion: rowString(row, "emotion"),
    summary: rowString(row, "summary"),
    summaryUpTo: rowNumber(row, "summary_up_to", 0),
    title: rowString(row, "title"),
    archived: Boolean(rowNumber(row, "archived", 0)),
    goal: rowString(row, "goal"),
    plan,
    createdAt: rowNumber(row, "created_at", 0),
    updatedAt: rowNumber(row, "updated_at", 0),
  };
}
