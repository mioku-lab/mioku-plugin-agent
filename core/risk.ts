import type { AgentHost } from "../types";
import { extractJsonObject } from "../utils/json";

export interface RiskVerdict {
  dangerous: boolean;
  reason: string;
}

const REVIEWER_PROMPT = `You are a safety reviewer for shell commands that an AI agent wants to run on the user's own machine.

Decide whether the command must be approved by the user before running. Be strict about irreversible or destructive actions, relaxed about ordinary development work.

Require user approval (dangerous = true) for things like:
- deleting, moving or overwriting files/directories the user may still need (rm, rmdir, mv, shred, truncate, mass globs, redirecting onto existing files)
- dropping or truncating databases, wiping data/cache directories, bulk file operations
- git push / force push / reset --hard / clean -fd / history rewrite / publishing releases
- killing processes, restarting services, changing system or network configuration
- installing or removing system packages, sudo or other privileged operations
- anything that is irreversible, destructive, or clearly reaches outside the workspace

Do NOT require approval (dangerous = false) for:
- read-only inspection: ls, cat, head, grep, find, ps, top, df, git status/diff/log
- reading files, creating new files, writing inside the workspace
- running tests, builds, linters, formatters
- starting local dev servers or background jobs inside the workspace

Answer with JSON only:
{"dangerous": true|false, "reason": "one short sentence"}`;

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
