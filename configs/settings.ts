import type { AgentSettingsConfig } from "../types";
import {
  DEFAULT_CONTEXT_WINDOW,
  compactionThresholdTokens,
} from "./context-window";

export const SETTINGS_CONFIG: AgentSettingsConfig = {
  maxIterations: 500,
  temperature: 1,
  maxContextTokens: DEFAULT_CONTEXT_WINDOW,
  stream: true,
  enableMarkdownScreenshot: true,
  compaction: {
    enabled: true,
    keepRecentMessages: 20,
  },
  webSearch: {
    enabled: true,
    baseUrl: "https://search.crystelf.top/",
    timeoutMs: 8000,
    defaultLimit: 5,
    maxLimit: 8,
    maxSearchCount: 50,
  },
  webFetch: {
    enabled: true,
    timeoutMs: 15_000,
    maxChars: 12_000,
  },
  bash: {
    enabled: true,
    timeoutMs: 120_000,
    approvalTimeoutMs: 5 * 60_000,
  },
  dataCollection: {
    enabled: true,
  },
  debug: false,
};
