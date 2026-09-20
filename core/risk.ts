import type { AgentHost } from "../types";
import { extractJsonObject } from "../utils/json";

export interface RiskVerdict {
  dangerous: boolean;
  reason: string;
}

const REVIEWER_PROMPT = `You are a safety reviewer for shell commands an AI agent wants to run on the user's machine.

dangerous=true (the user must approve first) for anything irreversible, destructive or outside the workspace: deleting/moving/overwriting files or directories (rm, rmdir, mv, shred, truncate, mass globs), dropping or truncating databases, wiping data/cache, git push/force push/reset --hard/clean -fd, killing processes, restarting services, changing system or network config, installing/removing system packages, sudo.

dangerous=false for ordinary development work: read-only inspection (ls, cat, head, grep, find, ps, df, git status/diff/log), reading or creating files, writing inside the workspace, running tests/builds/linters, starting local dev servers.

Answer with JSON only: {"dangerous": true|false, "reason": "one short sentence"}`;

export async function assessCommandRisk(
  host: AgentHost,
  command: string,
  purpose: string,
): Promise<RiskVerdict> {
  const resolved = host.resolveModel();
  const reviewer = resolved?.working ?? resolved?.instance;
  const model = resolved?.workingModel || resolved?.model || "";
  if (!reviewer) {
    return { dangerous: true, reason: "no reviewer model available" };
  }

  try {
    const response = await reviewer.complete({
      model,
      messages: [
        { role: "system", content: REVIEWER_PROMPT },
        {
          role: "user",
          content: `Command:\n${command}\n\nStated purpose: ${purpose || "(none)"}`,
        },
      ],
      temperature: 0,
      max_tokens: 200,
    });
    const parsed = extractJsonObject<{ dangerous?: unknown; reason?: unknown }>(
      response.content || "",
    );
    if (!parsed || typeof parsed.dangerous !== "boolean") {
      return {
        dangerous: true,
        reason: "reviewer returned an unusable verdict",
      };
    }
    return {
      dangerous: parsed.dangerous,
      reason:
        String(parsed.reason ?? "").trim() ||
        (parsed.dangerous ? "flagged by the reviewer model" : ""),
    };
  } catch (err) {
    host.logger.warn(`[agent] command risk review failed: ${err}`);
    return { dangerous: true, reason: `review failed: ${err}` };
  }
}
