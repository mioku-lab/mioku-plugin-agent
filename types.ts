import type {
  AIInstance,
  AIService,
  ConfigService,
  MiokuContext,
  ScreenshotService,
} from "mioku";
import type { AgentDatabase } from "./db";
import type { SessionManager } from "./core/session";
import type { EmotionManager } from "./core/emotion";
import type { ApprovalManager } from "./tools/approval";

export type AgentPermissionLevel =
  | "read-only"
  | "workspace-write"
  | "auto"
  | "full"
  | "yolo";

export interface AgentAccessConfig {
  allowAdmins: boolean;
  users: number[];
}

export interface AgentBaseConfig {
  access: AgentAccessConfig;
  workspaceDir: string;
  permissionLevel: AgentPermissionLevel;
  model: string;
}

export interface CompactionConfig {
  enabled: boolean;
  keepRecentMessages: number;
}

export interface WebSearchConfig {
  enabled: boolean;
  baseUrl: string;
  timeoutMs: number;
  defaultLimit: number;
  maxLimit: number;
  maxSearchCount: number;
}

export interface WebFetchConfig {
  enabled: boolean;
  timeoutMs: number;
  maxChars: number;
}

export interface BashConfig {
  enabled: boolean;
  timeoutMs: number;
  approvalTimeoutMs: number;
}

export interface AgentSettingsConfig {
  maxIterations: number;
  temperature: number;
  maxContextTokens: number;
  stream: boolean;
  enableMarkdownScreenshot: boolean;
  compaction: CompactionConfig;
  webSearch: WebSearchConfig;
  webFetch: WebFetchConfig;
  bash: BashConfig;
  dataCollection: { enabled: boolean };
  debug: boolean;
}

export interface ChatEmotionConfig {
  defaultEmotion: string;
  emotions: Record<string, { examples: string[] }>;
}

export interface ChatSharedConfig {
  persona: string;
  replyStyle: string;
  emotion: ChatEmotionConfig | null;
}

export interface ResolvedModel {
  instance: AIInstance;
  model: string;
  working: AIInstance;
  workingModel: string;
  vision: AIInstance | undefined;
  visionModel: string;
  isMultimodal: boolean;
  contextWindow: number;
}

export interface AgentHost {
  ctx: MiokuContext;
  aiService: AIService;
  configService: ConfigService | undefined;
  screenshot: ScreenshotService | undefined;
  db: AgentDatabase;
  approvals: ApprovalManager;
  sessions: SessionManager;
  emotions: EmotionManager;
  getBase(): AgentBaseConfig;
  getSettings(): AgentSettingsConfig;
  getChatShared(): Promise<ChatSharedConfig>;
  resolveModel(): ResolvedModel | null;
  workspaceRoot(userId: number): string;
  isAllowed(userId: number): Promise<boolean>;
  updateBase(patch: Partial<AgentBaseConfig>): Promise<void>;
  logger: MiokuContext["logger"];
}
