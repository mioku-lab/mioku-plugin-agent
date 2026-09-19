import type {
  AgentBaseConfig,
  AgentSettingsConfig,
  ChatEmotionConfig,
} from "../types";
import type { FsPolicy } from "../tools/perm";

const LEVEL_LINES: Record<string, string> = {
  "read-only":
    "Permission level: read-only. File writes are impossible; every bash command requires the user's explicit approval in the chat.",
  "workspace-write":
    "Permission level: workspace-write. File tools may only write inside the workspace; every bash command requires the user's explicit approval in the chat.",
  auto: "Permission level: auto. File tools and bash run without asking first, but every bash command is reviewed by the working model and genuinely destructive ones still require the user's approval in the chat.",
  full: "Permission level: full access. File tools and bash commands run without approval and are NOT sandboxed — be careful with destructive operations.",
  yolo: "Permission level: yolo. Everything runs unsandboxed and without approval, and the user is NOT shown any intermediate notices — only your final reply reaches them. Be extra careful with destructive operations.",
};

function currentTimeLine(): string {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  const days = [
    "Sunday",
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
  ];
  return `${now.getFullYear()}/${pad(now.getMonth() + 1)}/${pad(now.getDate())} ${pad(now.getHours())}:00 (${days[now.getDay()]}, hour precision)`;
}

function buildEmotionSection(
  emotion: ChatEmotionConfig | null,
  currentEmotion: string,
): string {
  if (!emotion) return "";
  const available = Array.from(
    new Set([
      "default",
      ...Object.keys(emotion.emotions ?? {}).map((name) =>
        name.trim().toLowerCase(),
      ),
    ]),
  ).filter(Boolean);
  const defaultEmotion = emotion.defaultEmotion || "default";
  const current = available.includes(currentEmotion)
    ? currentEmotion
    : defaultEmotion;
  const currentExamples = emotion.emotions?.[current]?.examples ?? [];
  const fallbackExamples = emotion.emotions?.[defaultEmotion]?.examples ?? [];
  const examples = (
    currentExamples.length > 0 ? currentExamples : fallbackExamples
  ).slice(0, 6);
  const lines = [
    "## Emotion State",
    `Current emotion: ${current || "default"}`,
    available.length > 0 ? `Available emotions: ${available.join(", ")}` : "",
    "You may switch your emotion state by writing [emotion:name] on its own line; the marker is removed before the message is sent. Use it sparingly, when the emotion genuinely shifts. Nothing else changes it, so it stays until you switch it.",
  ];
  if (examples.length > 0) {
    lines.push(
      "For examples of responses to the current emotion, refer to their tone and speech characteristics.",
      "Imitate their tone and speaking style, including sentence length, pauses inside sentences, and punctuation use:",
      ...examples.map((example) => `- ${example}`),
    );
  }
  return lines.filter(Boolean).join("\n");
}

export interface SystemPromptOptions {
  persona: string;
  replyStyle: string;
  base: AgentBaseConfig;
  settings: AgentSettingsConfig;
  policy: FsPolicy;
  currentEmotion: string;
  emotion: ChatEmotionConfig | null;
  toolNames: string[];
  goal?: string;
  plan?: Array<{ content: string; status: string }>;
}

export function buildSystemPrompt(options: SystemPromptOptions): string {
  const {
    persona,
    replyStyle,
    base,
    settings,
    policy,
    currentEmotion,
    emotion,
    toolNames,
    goal,
    plan,
  } = options;
  const sections: string[] = [];

  // Persona comes from the chat plugin's personalization config. When chat is
  // absent there is no persona section at all, only the agent framing.
  const personaText = persona.trim();
  sections.push(
    [
      "## Identity",
      ...(personaText ? [personaText, ""] : []),
      "You are running as a personal agent: the bot owner talks to you in a private QQ chat and you complete tasks end-to-end with tools, like a coding/OS agent but conversational.",
    ].join("\n"),
  );

  const styleText = replyStyle.trim();
  if (styleText) {
    sections.push(
      [
        "## Speaking Style",
        "Long-term stable tone, read from the chat plugin's personalization settings. Keep it across every reply:",
        styleText,
      ].join("\n"),
    );
  }

  sections.push(
    [
      "## Output Rules",
      "- Your final text reply is delivered to the user as QQ message(s). Output only the reply itself; never output your thinking process or narrate tool calls.",
      "- Plain text output must NOT contain Markdown syntax: no **bold**, no # headings, no bullet lists, no tables, no code fences. Write natural plain text.",
      "- When the reply genuinely needs rich structure (code, tables, tutorials, long technical explanations), wrap that part in exactly <MARKDOWN> ... </MARKDOWN>. The block is rendered into an image; inside it there is no length limit and Markdown syntax is expected.",
      "- Put a <MARKDOWN> block on its own paragraph, with nothing else on the same line as the opening or closing tag.",
      "- Prefer plain text for short answers; use <MARKDOWN> blocks only when plain text would genuinely lose clarity.",
      "- [emotion:name] on its own line switches your emotion state (see Emotion State). No other markers exist; do not invent any.",
      "- To quote a chat message, put [reply:message_id] alone on the first line of your reply. The marker is removed and the message that follows quotes that message; use it when the user should see which message you are answering.",
    ].join("\n"),
  );

  const toolLines: string[] = [
    "## Tools",
    "- Use tools proactively to complete tasks and verify facts instead of guessing. Chain multiple tool calls when needed.",
    `Available tools: ${toolNames.join(", ")}.`,
    "- File paths may be absolute or relative to the workspace. Relative paths are preferred.",
  ];
  if (settings.bash.enabled) {
    toolLines.push(
      policy.level === "full"
        ? "- bash runs unsandboxed with full access; avoid destructive commands unless the user explicitly asked for them."
        : "- bash requires in-chat user approval per command; batch related work into a single well-formed command instead of many tiny ones, and continue the task once approval is granted.",
      "- Always pass `purpose` to bash: one short line saying what the command does and why. It is shown to the user with the command for approval, and reported even in full access.",
    );
  }
  if (settings.webSearch.enabled) {
    toolLines.push(
      `- web_search is limited to about ${settings.webSearch.maxSearchCount} searches per conversation; stop searching and answer from what you have after 2-3 failed attempts.`,
    );
  }
  if (settings.webFetch.enabled && settings.webSearch.enabled) {
    toolLines.push(
      "- web_fetch reads a known URL directly; use web_search first when you need to discover sources.",
    );
  }
  toolLines.push(
    "- send_file/send_image deliver local files to the user; mention what you sent in one short line.",
  );
  toolLines.push(
    "- view_image opens a local image file (screenshot, downloaded photo) so you can see it; use it whenever the answer depends on what an image actually shows.",
  );
  toolLines.push(
    "- User attachments are downloaded automatically before you run: every file is listed with its message_id and a [file://...] local path you can read, edit or send back, and images are additionally attached to the message.",
  );
  toolLines.push(
    "- The user may send more messages while you are still working; they are appended to this same turn, so read them before finishing and adjust your answer or plan accordingly.",
  );
  if (base.permissionLevel === "yolo") {
    toolLines.push(
      "- This mode hides every command/tool notice from the user: only your final reply is delivered, so make it complete, self-contained and free of tool narration.",
    );
  }
  sections.push(toolLines.join("\n"));

  sections.push(
    [
      "## Conversation Handling",
      "- Keep context across turns: files you wrote, commands you ran, and decisions made earlier stay valid until the user resets the session.",
      "- If a task is ambiguous, make a reasonable assumption, state it in one line, and proceed instead of asking multiple clarifying questions.",
      "- Reply in the user's language (default to Chinese when the user writes Chinese).",
    ].join("\n"),
  );

  sections.push(
    [
      "## Environment",
      `Current time: ${currentTimeLine()}`,
      "Chat type: QQ private chat with the bot owner.",
      `Workspace: ${policy.workspaceRoot}`,
      LEVEL_LINES[base.permissionLevel] ?? LEVEL_LINES["workspace-write"],
    ].join("\n"),
  );

  const emotionSection = buildEmotionSection(emotion, currentEmotion);
  if (emotionSection) sections.push(emotionSection);

  if (goal?.trim()) {
    sections.push(
      [
        "## Session Goal",
        goal.trim(),
        "This goal was set by the user for the current session. Work toward it across turns; it stays until the user clears or replaces it.",
      ].join("\n"),
    );
  }
  if (plan && plan.length > 0) {
    const marker: Record<string, string> = {
      pending: "[ ]",
      in_progress: "[~]",
      completed: "[x]",
    };
    sections.push(
      [
        "## Current Plan",
        ...plan.map(
          (item, index) =>
            `${index + 1}. ${marker[item.status] ?? "[ ]"} ${item.content}`,
        ),
        "Keep this plan up to date with the todo_write tool as you make progress: mark items in_progress before starting and completed when done.",
      ].join("\n"),
    );
  }

  return sections.join("\n\n");
}
